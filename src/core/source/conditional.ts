/**
 * One conditional GET, shared by every published-file source this app reads.
 *
 * Extracted from the injury fetcher rather than copied into the usage one. The
 * mechanism is the same in both places and it was measured once, against the
 * live endpoint (`scripts/probe-nflverse-conditional.mjs`):
 *
 *   - the release asset answers with both `ETag` and `Last-Modified`, and both
 *     are **stable across calls** even though the asset 302s to a signed CDN URL
 *     whose query string — expiry, signature, JWT — differs every time.
 *     Fingerprinting the redirect target would have reported a change on every
 *     single tick;
 *   - `If-None-Match` returns **304 with no body**;
 *   - a deliberately stale validator returns **200 with the whole file**.
 *
 * That last pair is why this is one request rather than HEAD-then-GET: the
 * ordinary tick costs a round trip and no bytes, and the tick where something
 * actually changed already has the file in hand.
 *
 * A 404 is not a failure. Both files this reads are published per season, and
 * neither exists in August — the difference between "the source is down" and
 * "the season has not started" is the difference between an alarm and a fact,
 * and an alarm that cries wolf every preseason is one nobody reads in November.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The validators that decide whether anything needs downloading. */
export interface SourceFingerprint {
  /** The strong validator. Preferred, and it survives the CDN redirect. */
  etag: string | null;
  /** The raw `Last-Modified` header, as sent, for the conditional request. */
  lastModified: string | null;
}

export type FetchOutcome =
  /** The source changed (or we had no fingerprint): the body is populated. */
  | 'ok'
  /** 304. Nothing to do, and nothing was downloaded. The common answer. */
  | 'not_modified'
  /** 404 — a season that has not started. A fact about the calendar. */
  | 'not_published'
  /** Anything else. Last-good data stays exactly where it is. */
  | 'failed';

export interface ConditionalResponse {
  outcome: FetchOutcome;
  /** The body, only ever on `ok`. Nothing else downloads anything. */
  text: string | null;
  /**
   * The validators to store for the next check.
   *
   * On a 304 these come back unchanged from what was sent, which is what makes
   * the check idempotent: storing them again is a no-op. On a failure the old
   * ones are kept deliberately — a 503 is not evidence that the file changed,
   * and forgetting what we knew would force a needless download next tick.
   */
  fingerprint: SourceFingerprint;
  /**
   * When the file was last published, from `Last-Modified`, as an ISO string.
   * Neither of these files carries a per-row timestamp, so this is the only
   * freshness they have and it belongs to the whole file rather than a row.
   */
  publishedAt: string | null;
  /** Why there is nothing, when there is nothing. Never an exception. */
  note: string | null;
}

export async function conditionalGet(
  url: string,
  opts: {
    fetch?: FetchLike;
    fingerprint?: SourceFingerprint | null;
    accept?: string;
    /** Names the file in a note, e.g. "2026 injury reports". */
    describe?: string;
    /**
     * Ask for only the first N bytes, as `Range: bytes=0-(N-1)`.
     *
     * For the one source that is too large to download whole. The depth-chart
     * file is 42MiB and is written newest-first, so the current chart is its
     * first ~303KiB; see `core/nflverse/depthChart.ts`. Measured against the
     * live asset, all three properties this needs hold: an explicit `bytes=0-N`
     * range is answered `206` with a `Content-Range`, the `ETag` is byte-for-
     * byte the same one a `HEAD` returns, and `If-None-Match` sent *with* the
     * range still answers `304`. So a ranged check is as cheap as any other on
     * the ordinary tick and costs a fraction of a file on the tick that isn't.
     *
     * Suffix ranges (`bytes=-N`) are not usable — the asset answers them `501
     * Unsupported client range` — which is why nothing here asks for the end of
     * a file and why the newest-first ordering is what makes this work at all.
     *
     * A partial body is returned as `ok` like any other. It is the *parser's*
     * job to decide whether what arrived is a complete unit of meaning, because
     * only the parser knows what one is.
     */
    rangeBytes?: number;
  } = {},
): Promise<ConditionalResponse> {
  const doFetch = opts.fetch ?? ((target, init) => fetch(target, init));
  const known = opts.fingerprint;
  const what = opts.describe ?? url;

  const headers: Record<string, string> = { accept: opts.accept ?? 'text/csv' };
  if (opts.rangeBytes != null && opts.rangeBytes > 0) {
    headers['range'] = `bytes=0-${Math.floor(opts.rangeBytes) - 1}`;
  }
  /*
   * Only one conditional header, and ETag wins where both exist.
   *
   * Sending both lets a server that honours only the weaker one answer 200 to a
   * request the stronger one would have settled, which quietly turns every
   * check back into a download.
   */
  if (known?.etag) headers['if-none-match'] = known.etag;
  else if (known?.lastModified) headers['if-modified-since'] = known.lastModified;

  let res: Response;
  try {
    res = await doFetch(url, { headers });
  } catch (err) {
    return {
      outcome: 'failed',
      text: null,
      fingerprint: keep(known),
      publishedAt: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }

  // 304: the body was never sent. Keep the fingerprint we asked with — the
  // response is not obliged to repeat it.
  if (res.status === 304) {
    return {
      outcome: 'not_modified',
      text: null,
      fingerprint: {
        etag: res.headers.get('etag') ?? known?.etag ?? null,
        lastModified: res.headers.get('last-modified') ?? known?.lastModified ?? null,
      },
      publishedAt: toIso(known?.lastModified ?? null),
      note: null,
    };
  }

  if (res.status === 404) {
    /*
     * No validator is stored for a file that does not exist.
     *
     * Storing one would let the next check 304 against nothing and leave the
     * app permanently convinced it was up to date with a file that was never
     * published.
     */
    return {
      outcome: 'not_published',
      text: null,
      fingerprint: { etag: null, lastModified: null },
      publishedAt: null,
      note: `nflverse has not published ${what} yet`,
    };
  }

  if (!res.ok) {
    return {
      outcome: 'failed',
      text: null,
      fingerprint: keep(known),
      publishedAt: null,
      note: `${what}: HTTP ${res.status}`,
    };
  }

  const fingerprint: SourceFingerprint = {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      outcome: 'failed',
      text: null,
      fingerprint: keep(known),
      publishedAt: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }

  return { outcome: 'ok', text, fingerprint, publishedAt: toIso(fingerprint.lastModified), note: null };
}

function keep(known: SourceFingerprint | null | undefined): SourceFingerprint {
  return { etag: known?.etag ?? null, lastModified: known?.lastModified ?? null };
}

export function toIso(httpDate: string | null): string | null {
  if (!httpDate) return null;
  const at = Date.parse(httpDate);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
