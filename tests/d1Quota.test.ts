/**
 * The quota panel: what it says, and the four things it must never say.
 *
 * This is a number about the platform on a screen somebody opens when they are
 * already worried, which makes every failure mode here a reassuring one. The
 * four refusals it is built on:
 *
 *   1. **a missing token is not zero rows.** No credential means "not
 *      connected", in words, with what to do about it.
 *   2. **a renamed field is not zero rows.** #244 printed a column of zeroes
 *      because it guessed `rowsRead`/`sumRowsRead`/`rows_read` and the payload
 *      used none of them; a quota panel that does that says the reassuring
 *      thing by accident.
 *   3. **an empty response is not a quiet day.** Cloudflare's analytics lag by
 *      a few minutes, so "no rows for today yet" and "no reads today" are
 *      different facts and only one of them is knowable.
 *   4. **a projection needs a day to project from.** One cron tick at 00:04
 *      UTC extrapolates to several times the allowance, and an alarm that
 *      fires every morning is an alarm nobody reads by October.
 */

import { describe, expect, it } from 'vitest';
import {
  CRITICAL_AT_PERCENT,
  D1_DAILY_ROWS_READ,
  describeQuota,
  fractionOfUtcDay,
  type D1QuotaReading,
} from '../src/core/health/quota.ts';
import { D1QuotaService, forgetQuotaReadings, pickMetric } from '../src/server/services/d1QuotaService.ts';

const NOON = new Date('2026-09-08T12:00:00.000Z');

function reading(over: Partial<D1QuotaReading> = {}): D1QuotaReading {
  return {
    day: '2026-09-08',
    rowsRead: 1_000_000,
    rowsWritten: 4_000,
    readQueries: 12_000,
    writeQueries: 900,
    previousDayRowsRead: null,
    readAt: NOON.toISOString(),
    ...over,
  };
}

/** A GraphQL answer in the shape Cloudflare's analytics API returns. */
function payload(groups: { date: string; sum: Record<string, unknown> }[]): string {
  return JSON.stringify({
    data: {
      viewer: {
        accounts: [
          { d1AnalyticsAdaptiveGroups: groups.map((g) => ({ dimensions: { date: g.date }, sum: g.sum })) },
        ],
      },
    },
  });
}

const SUM = { rowsRead: 2_000_000, rowsWritten: 5_000, readQueries: 30_000, writeQueries: 700 };

function service(
  respond: (input: unknown, init?: RequestInit) => Promise<Response>,
  now: Date = NOON,
): D1QuotaService {
  forgetQuotaReadings();
  return new D1QuotaService(
    { accountId: 'acct-1', apiToken: 'token-1' },
    { fetch: respond as unknown as typeof fetch, now: () => now },
  );
}

describe("the day's arithmetic", () => {
  it('is a fraction of the UTC day, because the allowance resets on UTC midnight', () => {
    expect(fractionOfUtcDay(new Date('2026-09-08T00:00:00.000Z'))).toBe(0);
    expect(fractionOfUtcDay(new Date('2026-09-08T12:00:00.000Z'))).toBe(0.5);
    expect(fractionOfUtcDay(new Date('2026-09-08T23:59:59.999Z'))).toBeCloseTo(1, 3);
  });

  it('reports the share used and where the day lands at this rate', () => {
    const view = describeQuota({ availability: 'reading', reading: reading({ rowsRead: 1_000_000 }) }, NOON);
    expect(view.percentUsed).toBe(20);
    expect(view.projectedPercent, 'a fifth by noon is two fifths by midnight').toBe(40);
    expect(view.state).toBe('ok');
    expect(view.headline).toBe("20% of today's rows");
  });

  it('refuses to project from the first minutes of a day', () => {
    const early = new Date('2026-09-08T00:30:00.000Z');
    const view = describeQuota({ availability: 'reading', reading: reading({ rowsRead: 200_000 }) }, early);
    expect(view.projectedPercent).toBeNull();
    expect(view.detail).toContain('Too early');
    expect(view.state, 'and does not raise an alarm on a projection it refused to make').toBe('ok');
  });

  it('warns on the pace long before the number itself is alarming', () => {
    const view = describeQuota({ availability: 'reading', reading: reading({ rowsRead: 2_600_000 }) }, NOON);
    expect(view.percentUsed, 'barely half, and nothing is wrong yet').toBe(52);
    expect(view.projectedPercent).toBe(104);
    expect(view.state, 'except that this day ends in an outage').toBe('critical');
    expect(view.detail).toContain('runs out before midnight');
  });

  it('is critical on the number alone once the day is nearly spent', () => {
    const late = new Date('2026-09-08T23:00:00.000Z');
    const rowsRead = Math.round((CRITICAL_AT_PERCENT / 100) * D1_DAILY_ROWS_READ) + 1;
    expect(describeQuota({ availability: 'reading', reading: reading({ rowsRead }) }, late).state).toBe('critical');
  });

  it('says what yesterday finished on, so today has something to be normal against', () => {
    const view = describeQuota(
      { availability: 'reading', reading: reading({ previousDayRowsRead: 2_460_000 }) },
      NOON,
    );
    expect(view.detail).toContain('Yesterday finished on 49.2%');
  });
});

describe('when there is no reading', () => {
  it('says it is not connected rather than reporting nothing used', async () => {
    const unconfigured = new D1QuotaService({ accountId: null, apiToken: null });
    const view = await unconfigured.view();
    expect(view.availability).toBe('unconfigured');
    expect(view.percentUsed, 'never a number nobody measured').toBeNull();
    expect(view.state).toBe('unknown');
    expect(view.headline).toBe('Not connected');
  });

  it('makes no request at all without a token', async () => {
    let called = 0;
    const svc = new D1QuotaService(
      { accountId: 'acct-1', apiToken: '   ' },
      {
        fetch: (async () => {
          called += 1;
          return new Response('{}');
        }) as unknown as typeof fetch,
      },
    );
    await svc.view();
    expect(called).toBe(0);
  });

  it('names a refused token as a permissions problem', async () => {
    const view = await service(async () => new Response('nope', { status: 403 })).view();
    expect(view.availability).toBe('unavailable');
    expect(view.detail).toContain('Account Analytics');
  });

  it('reports a GraphQL error rather than an empty total', async () => {
    const view = await service(
      async () => new Response(JSON.stringify({ errors: [{ message: 'unauthorized' }] }), { status: 200 }),
    ).view();
    expect(view.availability).toBe('unavailable');
    expect(view.percentUsed).toBeNull();
    expect(view.detail).toContain('unauthorized');
  });

  it('names the fields it did get when the rows-read field is not among them', async () => {
    const view = await service(
      async () => new Response(payload([{ date: '2026-09-08', sum: { queryBatchTimeMs: 12, writeQueries: 3 } }])),
    ).view();
    expect(view.availability, 'the #244 defect, caught instead of displayed as 0%').toBe('unavailable');
    expect(view.detail).toContain('queryBatchTimeMs');
  });

  it('does not read an empty answer as a quiet day', async () => {
    const view = await service(async () => new Response(payload([]))).view();
    expect(view.availability).toBe('unavailable');
    expect(view.detail).toContain('lag');
  });

  it('survives an unreachable Cloudflare without throwing', async () => {
    const view = await service(async () => {
      throw new Error('connection reset');
    }).view();
    expect(view.availability).toBe('unavailable');
    expect(view.detail).toContain('connection reset');
  });
});

describe('a real answer', () => {
  it("sums the account rather than one database, because the allowance is the account's", async () => {
    const view = await service(
      async () =>
        new Response(
          payload([
            { date: '2026-09-08', sum: { ...SUM, rowsRead: 1_500_000 } },
            { date: '2026-09-08', sum: { ...SUM, rowsRead: 500_000 } },
            { date: '2026-09-07', sum: { ...SUM, rowsRead: 2_460_000 } },
          ]),
        ),
    ).view();

    expect(view.availability).toBe('reading');
    expect(view.reading?.rowsRead, 'two databases, one allowance').toBe(2_000_000);
    expect(view.percentUsed).toBe(40);
    expect(view.reading?.previousDayRowsRead).toBe(2_460_000);
  });

  it('asks Cloudflare once per window, however often the screen is opened', async () => {
    let calls = 0;
    const svc = service(async () => {
      calls += 1;
      return new Response(payload([{ date: '2026-09-08', sum: SUM }]));
    });
    await svc.view();
    await svc.view();
    await svc.view();
    expect(calls, 'a panel that refetched on every reload would be its own load').toBe(1);
  });

  it('sends the account tag and both days it needs', async () => {
    const sent: { variables?: Record<string, unknown> }[] = [];
    await service(async (_url, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)) as { variables?: Record<string, unknown> });
      return new Response(payload([{ date: '2026-09-08', sum: SUM }]));
    }).view();
    expect(sent[0]?.variables).toMatchObject({ account: 'acct-1', from: '2026-09-07', to: '2026-09-08' });
  });
});

describe('finding the metric', () => {
  it('matches the field however it is spelled', () => {
    expect(pickMetric({ rowsRead: 5 }, /^rows?_?read/i)).toBe(5);
    expect(pickMetric({ rows_read: 5 }, /^rows?_?read/i)).toBe(5);
    expect(pickMetric({ rowRead: 5 }, /^rows?_?read/i)).toBe(5);
  });

  it('answers null rather than zero when nothing matches', () => {
    expect(pickMetric({ readQueries: 5 }, /^rows?_?read/i)).toBeNull();
    expect(pickMetric({}, /^rows?_?read/i)).toBeNull();
  });
});
