/**
 * beatadp.com — where Sleeper's ADP is actually readable.
 *
 * Sleeper does not publish ADP: every REST path 404s and the GraphQL schema has
 * no ADP field. beatadp.com collects it (alongside several other
 * platforms) and renders it for a chosen scoring format, draft type and QB
 * count — exactly the three things that decide whether a number applies to this
 * league.
 *
 * The page is a Next.js App Router render, so the table is not fetched from an
 * API: the server streams it into the HTML as RSC "flight" chunks pushed into
 * `self.__next_f`. Decoding those chunks yields the rows verbatim, along with
 * the filters the server actually applied — which is the part that matters,
 * because it lets a caller *verify* it received half-PPR data rather than
 * assume it.
 *
 * Nothing here runs at request time. A workflow fetches the page, converts it
 * with these functions, and imports the result as a frozen ADP snapshot, so the
 * app's draft board never depends on a third-party site being up mid-draft.
 */

/** The three filters that decide whether an ADP number applies to a league. */
export interface BeatAdpFilters {
  /** e.g. `PPR`, `HALF_PPR`, `STANDARD`. */
  scoringFormat: string | null;
  /** e.g. `REDRAFT`, `DYNASTY`. */
  draftType: string | null;
  /** e.g. `1QB`, `SUPERFLEX`. */
  qbType: string | null;
}

export interface BeatAdpRow {
  name: string;
  position: string | null;
  team: string | null;
  /** ADP by platform, keyed as the page keys it (`SLEEPER`, `ESPN`, ...). */
  adps: Record<string, number>;
}

export interface BeatAdpPage {
  filters: BeatAdpFilters | null;
  rows: BeatAdpRow[];
}

/** The platform this app wants. Sleeper is the league host, so it is the one. */
export const SLEEPER_PLATFORM = 'SLEEPER';

/**
 * Rebuild the RSC payload from the chunks the page pushes into `self.__next_f`.
 *
 * Each chunk is a JavaScript string literal, so decoding is just JSON string
 * parsing. A chunk that will not decode is skipped rather than aborting the
 * whole payload: the rows live in one contiguous chunk sequence, and an
 * unrelated malformed chunk should not cost us the table.
 */
export function decodeFlight(html: string): string {
  const chunks = html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g);
  let out = '';
  for (const match of chunks) {
    try {
      out += JSON.parse(match[1]!) as string;
    } catch {
      // Not a decodable string literal; the remaining chunks still are.
    }
  }
  return out;
}

/**
 * Read one complete JSON value starting at `start`, respecting strings and
 * escapes so a brace inside a player name cannot end the value early.
 *
 * Returns null when the value is truncated — the flight payload is streamed, so
 * a partial final chunk is a real possibility rather than a theoretical one.
 */
export function sliceJsonValue(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAt(flight: string, key: string): unknown {
  const marker = `"${key}":`;
  let from = 0;
  for (;;) {
    const at = flight.indexOf(marker, from);
    if (at < 0) return null;
    const valueAt = at + marker.length;
    const slice = sliceJsonValue(flight, valueAt);
    if (slice) {
      try {
        return JSON.parse(slice) as unknown;
      } catch {
        // Keep looking: an earlier occurrence may be a different, unrelated key.
      }
    }
    from = at + marker.length;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Parse a fetched platform-ADP page into filters and rows.
 *
 * The filters are returned as the page reported them, not as they were
 * requested. A caller that wants half PPR must check.
 */
export function parseBeatAdpPage(html: string): BeatAdpPage {
  const flight = decodeFlight(html);

  const rawFilters = parseAt(flight, 'filters') as Record<string, unknown> | null;
  const filters: BeatAdpFilters | null = rawFilters
    ? {
        scoringFormat: str(rawFilters['scoringFormat']),
        draftType: str(rawFilters['draftType']),
        qbType: str(rawFilters['qbType']),
      }
    : null;

  const rawRows = parseAt(flight, 'rows');
  const rows: BeatAdpRow[] = [];
  if (Array.isArray(rawRows)) {
    for (const entry of rawRows) {
      const rec = entry as Record<string, unknown> | null;
      const player = (rec?.['player'] ?? null) as Record<string, unknown> | null;
      const name = str(player?.['fullName']);
      if (!name) continue;

      const adps: Record<string, number> = {};
      const rawAdps = (rec?.['adps'] ?? null) as Record<string, unknown> | null;
      for (const [platform, value] of Object.entries(rawAdps ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          adps[platform.toUpperCase()] = value;
        }
      }

      rows.push({
        name,
        position: str(player?.['position']),
        team: str(player?.['teamId']),
        adps,
      });
    }
  }

  return { filters, rows };
}

/**
 * Convert parsed rows into the JSON the ADP importer already understands.
 *
 * Only players the chosen platform actually ranks are included. A player the
 * platform has no ADP for is not a player with a bad ADP — it is a player with
 * no ADP, and inventing one (by falling back to a different platform, or to the
 * consensus) would silently mix sources inside a single snapshot.
 *
 * `rank` is derived from the ADP ordering rather than taken from the page,
 * because the page's row order follows whichever column the reader sorted by.
 */
export function toAdpImportFile(rows: BeatAdpRow[], platform = SLEEPER_PLATFORM): string {
  const key = platform.toUpperCase();
  const ranked = rows
    .filter((row) => typeof row.adps[key] === 'number')
    .sort((a, b) => a.adps[key]! - b.adps[key]!)
    .map((row, i) => ({
      name: row.name,
      team: row.team ?? '',
      position: row.position ?? '',
      adp: row.adps[key]!,
      rank: i + 1,
    }));
  return JSON.stringify(ranked, null, 2);
}
