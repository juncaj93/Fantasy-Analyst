/**
 * Asking Cloudflare how much of today's D1 allowance is gone.
 *
 * ## What is actually obtainable, and what is not
 *
 * A Worker cannot read its own quota. There is no binding, no `env.DB.usage()`,
 * nothing on the D1 REST resource but size and table counts. What exists is the
 * GraphQL Analytics API — the same source the Cloudflare dashboard's own D1
 * charts are drawn from — and a Worker can call it like any other HTTPS
 * endpoint, with a token, over one subrequest and zero database rows.
 *
 * So the answer to "can the app show this itself?" is yes, with one condition
 * that cannot be engineered away: it needs an API token, and a token is a
 * secret somebody has to create. Without one this row says it is not connected
 * and what to do about it. It does not estimate, and it does not count its own
 * reads and present the total as the account's — the allowance is account-wide
 * and includes the crons, the Actions workflows and anything else touching the
 * database, so a self-count would be an undercount presented with the authority
 * of a measurement.
 *
 * ## The one lesson from #244 this is built around
 *
 * `d1-insights.yml` printed a column of zeroes on its first run, because it
 * guessed at `rowsRead`/`sumRowsRead`/`rows_read` and the payload used none of
 * them. A quota row that says `0%` because a field was renamed is worse than no
 * quota row: it is the reassuring answer, arrived at by accident, on the screen
 * somebody checks when they are worried. So the metric is *found* here too —
 * the response must contain a recognisable rows-read field or this reports that
 * it could not be read, by name.
 *
 * ## Cost
 *
 * One subrequest per {@link QUOTA_TTL_MS}, and none at all when no token is
 * configured. No D1 rows: this is the only panel on Data Health that costs the
 * allowance nothing to display.
 */

import {
  describeQuota,
  type D1QuotaReading,
  type D1QuotaView,
  type QuotaAvailability,
} from '../../core/health/quota.ts';

export interface QuotaCredentials {
  accountId: string | null | undefined;
  apiToken: string | null | undefined;
}

export interface QuotaDeps {
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * How long a reading stands.
 *
 * Five minutes. Cloudflare's own analytics lag by a couple of minutes, so a
 * fresher number would be a fresher copy of the same slightly-old number, and
 * the thing this is watching moves over hours. It also bounds what a reload
 * button can cost: holding Data Health open and tapping refresh cannot turn
 * into a request per tap.
 */
export const QUOTA_TTL_MS = 5 * 60 * 1_000;

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * Today and yesterday, per database, in one round trip.
 *
 * Not filtered to a database id, deliberately. The allowance is charged to the
 * *account*, so a per-database figure would be the wrong number whenever a
 * second database exists — and it would be wrong in the flattering direction.
 * The rows come back per database per day and are summed here.
 */
const QUERY = `query FantasyAnalystD1Quota($account: String!, $from: Date!, $to: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_leq: $to }) {
        dimensions { date }
        sum { rowsRead rowsWritten readQueries writeQueries }
      }
    }
  }
}`;

/** `YYYY-MM-DD` in UTC, which is the day the allowance is counted in. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return utcDay(at);
}

/**
 * The number carrying rows read, found rather than assumed.
 *
 * Matches on shape — a key that reads as "rows read", however it is cased or
 * separated — so a rename is visible as a changed key rather than silent as a
 * zero. Returns null when nothing matches, which is what makes the caller say
 * "could not be read" instead of "0%".
 */
export function pickMetric(sum: Record<string, unknown>, pattern: RegExp): number | null {
  for (const [key, value] of Object.entries(sum)) {
    if (!pattern.test(key)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const ROWS_READ = /^rows?_?read/i;
const ROWS_WRITTEN = /^rows?_?written/i;
const READ_QUERIES = /^read_?quer/i;
const WRITE_QUERIES = /^write_?quer/i;

interface Group {
  dimensions?: { date?: string } | null;
  sum?: Record<string, unknown> | null;
}

export class D1QuotaService {
  constructor(
    private readonly credentials: QuotaCredentials,
    private readonly deps: QuotaDeps = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The row for the screen.
   *
   * Never throws and never rejects: this is one panel on a diagnostics screen,
   * and a diagnostics screen that fails to render because a diagnostic failed
   * is the worst possible version of itself.
   */
  async view(): Promise<D1QuotaView> {
    const account = (this.credentials.accountId ?? '').trim();
    const token = (this.credentials.apiToken ?? '').trim();
    if (!account || !token) return describeQuota({ availability: 'unconfigured' }, this.now());

    const cached = CACHE.get(account);
    const at = this.now().getTime();
    if (cached && at - cached.at < QUOTA_TTL_MS) return describeQuota(cached.result, this.now());

    const result = await this.read(account, token);
    CACHE.set(account, { at, result });
    return describeQuota(result, this.now());
  }

  private async read(
    account: string,
    token: string,
  ): Promise<{ availability: QuotaAvailability; reading?: D1QuotaReading | null; reason?: string | null }> {
    const now = this.now();
    const today = utcDay(now);
    const yesterday = dayBefore(today);
    const doFetch = this.deps.fetch ?? fetch;

    let payload: unknown;
    try {
      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: QUERY, variables: { account, from: yesterday, to: today } }),
      });
      if (!response.ok) {
        /*
         * The status, and not the body. A 403 here is a token missing the
         * Account Analytics permission and is worth naming; the body of a
         * Cloudflare error is not something to put on a screen unread.
         */
        return {
          availability: 'unavailable',
          reason:
            response.status === 403 || response.status === 401
              ? 'Cloudflare refused the analytics token. It needs the Account Analytics: Read permission on this account.'
              : `Cloudflare answered ${response.status} when asked for today's usage.`,
        };
      }
      payload = await response.json();
    } catch (err) {
      return {
        availability: 'unavailable',
        reason: `Could not reach Cloudflare's analytics API (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    const body = payload as {
      errors?: { message?: string }[] | null;
      data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: Group[] | null }[] | null } | null } | null;
    };

    if (body?.errors?.length) {
      const first = body.errors[0]?.message ?? 'no message';
      return { availability: 'unavailable', reason: `Cloudflare's analytics API returned an error: ${first}` };
    }

    const groups = body?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
    if (!Array.isArray(groups)) {
      return {
        availability: 'unavailable',
        reason: 'Cloudflare answered without a d1AnalyticsAdaptiveGroups block — the account may have no D1 database, or the field has been renamed.',
      };
    }

    /*
     * Nothing at all for today is not the same as zero rows today.
     *
     * Analytics lag a few minutes, so a query made just after midnight UTC
     * legitimately has no group yet — and a reading of "0 rows read" from an
     * empty list is exactly the reassuring-by-accident answer this module
     * exists to avoid. An empty day is reported as zero only when the account
     * returned *some* day; a completely empty response is unavailable.
     */
    if (groups.length === 0) {
      return {
        availability: 'unavailable',
        reason: 'Cloudflare has no usage recorded for today yet. Its analytics lag the database by a few minutes.',
      };
    }

    let rowsRead: number | null = null;
    let rowsWritten = 0;
    let readQueries = 0;
    let writeQueries = 0;
    let previous: number | null = null;
    let sawToday = false;

    for (const group of groups) {
      const sum = group?.sum;
      if (!sum || typeof sum !== 'object') continue;
      const read = pickMetric(sum, ROWS_READ);
      const date = group?.dimensions?.date;
      if (date === yesterday) {
        if (read != null) previous = (previous ?? 0) + read;
        continue;
      }
      if (date !== today) continue;
      sawToday = true;
      if (read != null) rowsRead = (rowsRead ?? 0) + read;
      rowsWritten += pickMetric(sum, ROWS_WRITTEN) ?? 0;
      readQueries += pickMetric(sum, READ_QUERIES) ?? 0;
      writeQueries += pickMetric(sum, WRITE_QUERIES) ?? 0;
    }

    if (!sawToday) {
      return {
        availability: 'unavailable',
        reason: 'Cloudflare has no usage recorded for today yet. Its analytics lag the database by a few minutes.',
      };
    }
    if (rowsRead == null) {
      /*
       * The #244 failure, caught rather than displayed as 0%. The keys are
       * named so the rename is a one-line fix rather than another two days.
       */
      const keys = Object.keys(groups.find((g) => g?.sum)?.sum ?? {}).join(', ') || 'none';
      return {
        availability: 'unavailable',
        reason: `Cloudflare answered without a rows-read field. Fields returned: ${keys}.`,
      };
    }

    return {
      availability: 'reading',
      reading: {
        day: today,
        rowsRead,
        rowsWritten,
        readQueries,
        writeQueries,
        previousDayRowsRead: previous,
        readAt: now.toISOString(),
      },
    };
  }
}

/**
 * The last reading, per account.
 *
 * Module state keyed by the account tag rather than a global object, for the
 * same reason every other memo in here is keyed by something: two deployments
 * sharing a process must not serve each other's numbers. A Worker isolate lives
 * long enough to absorb a screen being reloaded and short enough that this
 * never becomes a store.
 */
const CACHE = new Map<
  string,
  { at: number; result: { availability: QuotaAvailability; reading?: D1QuotaReading | null; reason?: string | null } }
>();

/** Drop every held reading. Exported for tests. */
export function forgetQuotaReadings(): void {
  CACHE.clear();
}
