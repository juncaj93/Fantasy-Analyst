/**
 * Round 12: the cron watch can see the Worker's scheduled runs again, and the
 * 09:00 tick runs each step once per run.
 *
 * What production showed on 7 November 2026 (Probe, read-only):
 *
 *   - `workersInvocationsScheduled` answered an empty list for this account,
 *     for any script and any window from a day to a week, with the account id
 *     set and correct. The Worker's own logs held every run: one 09:00 run on
 *     5, 6 and 7 November, each `ok`, plus twelve five-minute runs an hour. So
 *     the watch failed "no invocation on record" every hour while every cron
 *     was healthy. It now falls back to the logs.
 *   - Round 11's probe passed the watch's reader a date written as text and
 *     died on `from.toISOString is not a function` before printing the count
 *     of 09:00 runs. Text, numbers and Dates are all read now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- a plain .mjs workflow script, deliberately not part of the app build
import * as watch from '../scripts/cron-health-watch.mjs';
import worker from '../src/worker/index.ts';
import { CronRunRepo } from '../src/server/repos/cronRuns.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';

const { CRONS, judgeAll, fetchInvocations } = watch;
const readInvocations = watch.readInvocations as
  | ((args: Record<string, unknown>) => Promise<{ rows: { cron: string; status: string; datetime: string }[]; source: string; lookbackHours: number }>)
  | undefined;

const NOW = new Date('2026-11-07T10:22:00Z');
const FIVE = '*/5 * * * *';
const DAILY = '0 9 * * *';

type LogEvent = { timestamp: number; $metadata: { requestId: string; service: string; message?: string }; $workers: Record<string, unknown> };

/** One scheduled run as Workers Logs return it: an event with the outcome, and a log line beside it. */
function runEvents(cron: string, atMs: number, outcome: string, id: string): LogEvent[] {
  const workers = { event: { cron, scheduledTime: Math.floor(atMs / 1000) }, outcome, cpuTimeMs: 12, wallTimeMs: 900, requestId: id };
  return [
    { timestamp: atMs + 800, $metadata: { requestId: id, service: 'fantasy-analyst' }, $workers: workers },
    { timestamp: atMs + 400, $metadata: { requestId: id, service: 'fantasy-analyst', message: 'injury-refresh checked=true' }, $workers: { event: { cron } } },
  ];
}

/** The week of 7 November as production had it: every run `ok`. */
function healthyWeek(): LogEvent[] {
  const events: LogEvent[] = [];
  const start = NOW.getTime() - 72 * 3_600_000;
  for (let t = Math.ceil(start / 300_000) * 300_000; t <= NOW.getTime() - 60_000; t += 300_000) {
    events.push(...runEvents(FIVE, t, 'ok', `five-${t}`));
  }
  for (const day of ['2026-11-05', '2026-11-06', '2026-11-07']) {
    const t = Date.parse(`${day}T09:00:00Z`);
    events.push(...runEvents(DAILY, t, 'ok', `daily-${day}`));
  }
  return events;
}

/**
 * Cloudflare as it answered on 7 November: the analytics run table empty, the
 * logs full. Each log query is answered with the events of the cron it filters
 * on, inside its time frame.
 */
function cloudflare(events: LogEvent[], opts: { analytics?: unknown[]; logsStatus?: number } = {}) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ url, body });
    if (url.endsWith('/graphql')) {
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsScheduled: opts.analytics ?? [] }] } } }));
    }
    if (url.includes('/workers/observability/telemetry/query')) {
      if (opts.logsStatus && opts.logsStatus !== 200) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'logs not authorized' }] }), { status: opts.logsStatus });
      }
      const cron = body.parameters.filters.find((f: { key: string }) => f.key === '$workers.event.cron')?.value;
      const { from, to } = body.timeframe;
      const hits = events.filter((e) => (e.$workers.event as { cron: string }).cron === cron && e.timestamp >= from && e.timestamp <= to);
      // Production answers at most 100 events a query, whatever the limit asked.
      return new Response(JSON.stringify({ success: true, result: { events: { events: hits.slice(0, Math.min(body.limit, 100)) } } }));
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, sent };
}

describe('the cron watch sees the runs', () => {
  it('reads the runs from the Worker\'s logs when the analytics run table is empty', async () => {
    expect(typeof readInvocations).toBe('function');
    const { fetchImpl, sent } = cloudflare(healthyWeek());
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 167 * 3_600_000), to: NOW, fetchImpl });
    expect(read.source).toBe('logs');
    expect(read.lookbackHours).toMatchObject({ [FIVE]: 3, [DAILY]: 72 });
    const daily = read.rows.filter((r) => r.cron === DAILY);
    expect(daily.map((r) => r.datetime)).toEqual(['2026-11-05T09:00:00.000Z', '2026-11-06T09:00:00.000Z', '2026-11-07T09:00:00.000Z']);
    expect(daily.every((r) => r.status === 'success')).toBe(true);
    // The five-minute tick over its last three hours, every run, one each however many log lines it wrote.
    const five = read.rows.filter((r) => r.cron === FIVE);
    expect(five).toHaveLength(36);
    expect(five.at(-1)!.datetime).toBe('2026-11-07T10:20:00.000Z');
    expect(new Set(read.rows.map((r) => `${r.cron}${r.datetime}`)).size).toBe(read.rows.length);
    // The account the secret names, and only this Worker's logs.
    const logQuery = sent.find((s) => s.url.includes('observability'))!;
    expect(logQuery.url).toContain('/accounts/acct/');
    expect(JSON.stringify(logQuery.body)).toContain('"value":"fantasy-analyst"');
  });

  it('gives the verdicts production should have had at 5:22 AM ET on 7 November: every cron healthy', async () => {
    const { fetchImpl } = cloudflare(healthyWeek());
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 167 * 3_600_000), to: NOW, fetchImpl });
    const verdicts = judgeAll(read.rows, NOW, CRONS, read.lookbackHours);
    // The run at that hour said "FAIL ... no invocation on record" for both of these.
    expect(verdicts.find((v: { cron: string }) => v.cron === FIVE).result).toBe('success');
    expect(verdicts.find((v: { cron: string }) => v.cron === DAILY).result).toBe('success');
    expect(verdicts.find((v: { cron: string }) => v.cron === DAILY).message).toContain('2026-11-07T09:00:00');
    // The weekly crons are older than three days of logs: nothing to judge, not a failure.
    expect(verdicts.filter((v: { result: string }) => v.result === 'failure')).toEqual([]);
  });

  it('still sees a run Cloudflare killed, and fails the tick on three in a row', async () => {
    const events = healthyWeek().filter((e) => e.timestamp < NOW.getTime() - 16 * 60_000 || (e.$workers.event as { cron: string }).cron !== FIVE);
    for (const minutesAgo of [15, 10, 5]) {
      const t = Math.floor((NOW.getTime() - minutesAgo * 60_000) / 300_000) * 300_000;
      events.push(...runEvents(FIVE, t, 'exceededCpu', `killed-${t}`));
    }
    const { fetchImpl } = cloudflare(events);
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 167 * 3_600_000), to: NOW, fetchImpl });
    const five = judgeAll(read.rows, NOW, CRONS, read.lookbackHours).find((v: { cron: string }) => v.cron === FIVE);
    expect(five.result).toBe('failure');
    expect(five.message).toContain('exceededCpu');
  });

  it('says the daily refresh is missing when the logs have no 09:00 run for over a day', async () => {
    const events = healthyWeek().filter((e) => (e.$workers.event as { cron: string }).cron !== DAILY || e.timestamp < Date.parse('2026-11-06T00:00:00Z'));
    const { fetchImpl } = cloudflare(events);
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 167 * 3_600_000), to: NOW, fetchImpl });
    expect(judgeAll(read.rows, NOW, CRONS, read.lookbackHours).find((v: { cron: string }) => v.cron === DAILY).result).toBe('failure');
  });

  it('does not count a run that is still going', async () => {
    const t = NOW.getTime() - 60_000;
    const stillGoing: LogEvent = { timestamp: t, $metadata: { requestId: 'live', service: 'fantasy-analyst', message: 'usage-refresh' }, $workers: { event: { cron: DAILY, scheduledTime: t / 1000 } } };
    const { fetchImpl } = cloudflare([stillGoing]);
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 3_600_000), to: NOW, fetchImpl });
    expect(read.rows).toEqual([]);
  });

  it('splits a slice of logs that fills a page, so no run is dropped', async () => {
    const events: LogEvent[] = [];
    // Ten log lines a run: the daily cron's three runs plus a busy day of noise
    // would not fit in one page of 100.
    for (const day of ['2026-11-05', '2026-11-06', '2026-11-07']) {
      const t = Date.parse(`${day}T09:00:00Z`);
      const [end, line] = runEvents(DAILY, t, 'ok', `daily-${day}`);
      events.push(end!);
      for (let i = 0; i < 60; i++) events.push({ ...line!, timestamp: line!.timestamp + i * 1000 });
    }
    const { fetchImpl, sent } = cloudflare(events);
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 72 * 3_600_000), to: NOW, fetchImpl });
    expect(read.rows.filter((r) => r.cron === DAILY)).toHaveLength(3);
    expect(sent.filter((s) => s.url.includes('observability')).length).toBeGreaterThan(4);
  });

  it('uses the analytics run table when it does answer', async () => {
    const { fetchImpl, sent } = cloudflare([], { analytics: [{ cron: DAILY, status: 'success', datetime: '2026-11-07T09:00:44Z' }] });
    const read = await readInvocations!({ token: 't', account: 'acct', from: new Date(NOW.getTime() - 24 * 3_600_000), to: NOW, fetchImpl });
    expect(read.source).toBe('analytics');
    expect(read.rows).toHaveLength(1);
    expect(sent.some((s) => s.url.includes('observability'))).toBe(false);
  });

  it('is an error, not a quiet empty week, when neither source can be read', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] }), { status: 403 });
    await expect(readInvocations!({ token: 't', account: 'a', from: new Date(NOW.getTime() - 3_600_000), to: NOW, fetchImpl })).rejects.toThrow(
      /not authorized/,
    );
  });
});

describe("the cron-run count's dates (Round 11's probe)", () => {
  it('reads a window written as text, as Round 11 wrote it', async () => {
    const { fetchImpl, sent } = cloudflare([], { analytics: [{ cron: DAILY, status: 'success', datetime: '2026-11-05T09:01:30Z' }] });
    // Exactly the call that printed "from.toISOString is not a function".
    const rows = await fetchInvocations({ token: 't', account: 'acct', from: '2026-11-05T00:00:00Z', to: NOW.toISOString(), fetchImpl });
    expect(rows).toHaveLength(1);
    const vars = sent[0]!.body.variables as { from: string; to: string };
    expect(vars.from).toBe('2026-11-05T00:00:00.000Z');
    expect(vars.to).toBe(NOW.toISOString());
  });

  it('reads a number and a Date the same way, and refuses nonsense', async () => {
    expect(watch.toDate(Date.parse('2026-11-05T00:00:00Z')).toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(watch.toDate(new Date('2026-11-05T00:00:00Z')).toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(() => watch.toDate('Nov fifth')).toThrow(/not a date/);
  });
});

/* -------------------------------------------------------- the 09:00 tick */

/*
 * The 4 AM job itself was healthy on 5, 6 and 7 November: one run a day, each
 * `ok`, each reaching its last line ("cron 09:00 subrequests 16/48"). The 234
 * "calls" of the position list were one call weighted by Cloudflare's query
 * sampling. These pin what was true and must stay true.
 */
describe('the 09:00 tick, run by run', () => {
  let raw: NodeSqliteDatabase;
  let realFetch: typeof fetch;
  let statsFetches = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    raw = await createTestDb();
    realFetch = globalThis.fetch;
    statsFetches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/stats/nfl/regular/')) {
        statsFetches += 1;
        return new Response(JSON.stringify({ '2001': { gp: 17, pts_half_ppr: 210 } }), { status: 200 });
      }
      return new Response('null', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('runs each step once per run, and a second run the same day skips last season\'s statistics', async () => {
    const at = Date.parse('2026-11-07T09:00:00Z');
    vi.setSystemTime(new Date(at));
    await worker.scheduled({ cron: DAILY, scheduledTime: at }, { DB: raw } as never);
    const first = await new CronRunRepo(raw).latest();
    const ids = first!.steps.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(8);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first!.steps.find((s) => s.id === 'season-stats')!.outcome).toBe('succeeded');
    expect(statsFetches).toBe(1);

    vi.setSystemTime(new Date(at + 7 * 60_000));
    await worker.scheduled({ cron: DAILY, scheduledTime: at }, { DB: raw } as never);
    const second = await new CronRunRepo(raw).latest();
    expect(second!.steps.map((s) => s.id)).toEqual(ids);
    expect(second!.steps.find((s) => s.id === 'season-stats')!.outcome).toBe('skipped');
    expect(statsFetches).toBe(1);
  }, 60_000);
});
