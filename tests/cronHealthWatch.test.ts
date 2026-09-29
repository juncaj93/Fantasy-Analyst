import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs workflow script, deliberately not part of the app build
import { CRONS, FIVE_MINUTE_RULES, judgeAll, judgeCron, fetchInvocations } from '../scripts/cron-health-watch.mjs';
// @ts-expect-error -- likewise
import { ISSUE_LABEL, ISSUE_TITLE, parseState } from '../scripts/lib/scheduledJobAlert.mjs';
// @ts-expect-error -- likewise
import { recordOutcome } from '../scripts/scheduled-job-alert.mjs';

/*
 * The watch on how the Worker's own scheduled runs end.
 *
 * From 27 September 2026 09:15 UTC to 28 September 05:40 UTC Cloudflare killed
 * the five-minute tick on 246 consecutive runs and nothing told anybody: every
 * alarm here read something the app writes about itself, and a killed run
 * writes nothing after the point it died. These pin a watch that reads
 * Cloudflare's own record instead, and replay that outage through it and on
 * into the issue that is the alarm.
 */

type Run = { cron: string; datetime: string; status: string };
const FIVE = '*/5 * * * *';
const spec = (cron: string) => CRONS.find((c: { cron: string }) => c.cron === cron);

/** Five-minute runs from `from` to `to`, each ended by `status(at)`. */
function ticks(from: string, to: string, status: (at: Date) => string): Run[] {
  const out: Run[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 5 * 60_000) {
    const at = new Date(t + 27_000);
    out.push({ cron: FIVE, datetime: at.toISOString(), status: status(at) });
  }
  return out;
}

const FIRST_KILL = Date.parse('2026-09-27T09:15:00Z');
const RECOVERED = Date.parse('2026-09-28T05:45:00Z');
/** The outage as Cloudflare recorded it: a lone kill at 09:00, then 09:15 to 05:40. */
const outage = (at: Date) => {
  const t = at.getTime();
  if (t >= Date.parse('2026-09-27T09:00:00Z') && t < Date.parse('2026-09-27T09:05:00Z')) return 'exceededResources';
  return t >= FIRST_KILL && t < RECOVERED ? 'exceededResources' : 'success';
};

describe('the five-minute tick', () => {
  it('fails within the hour on the morning of 27 September', () => {
    // The watch runs hourly at :20. The 10:20 run sees thirteen kills.
    const now = new Date('2026-09-27T10:20:00Z');
    const v = judgeCron(spec(FIVE), ticks('2026-09-27T06:00:00Z', '2026-09-27T10:15:00Z', outage), now);
    expect(v.result).toBe('failure');
    expect(v.message).toContain('exceededResources');
  });

  it('is quiet on the lone kill at 09:00 that the next run shrugged off', () => {
    const now = new Date('2026-09-27T09:12:00Z');
    const v = judgeCron(spec(FIVE), ticks('2026-09-27T07:00:00Z', '2026-09-27T09:10:00Z', outage), now);
    expect(v.result).toBe('success');
  });

  it('still fails when the odd run squeezes through', () => {
    // The outage's last hour: three of twelve got past, the rest were killed.
    const passed = new Set(['2026-09-28T04:10', '2026-09-28T04:30', '2026-09-28T04:50']);
    const runs = ticks('2026-09-28T03:00:00Z', '2026-09-28T05:05:00Z', (at) =>
      passed.has(at.toISOString().slice(0, 16)) ? 'success' : 'exceededResources',
    );
    // End on a success, so the consecutive rule cannot be what catches it.
    runs.push({ cron: FIVE, datetime: '2026-09-28T05:10:27.000Z', status: 'success' });
    const v = judgeCron(spec(FIVE), runs, new Date('2026-09-28T05:15:00Z'));
    expect(v.result).toBe('failure');
    expect(v.message).toContain(`limit ${FIVE_MINUTE_RULES.maxInWindow - 1}`);
  });

  it('clears once the tick has been running cleanly again', () => {
    const now = new Date('2026-09-28T08:20:00Z');
    const v = judgeCron(spec(FIVE), ticks('2026-09-28T04:00:00Z', '2026-09-28T08:15:00Z', outage), now);
    expect(v.result).toBe('success');
  });

  it('fails when the tick stops firing at all', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const v = judgeCron(spec(FIVE), ticks('2026-09-29T09:00:00Z', '2026-09-29T11:00:00Z', () => 'success'), now);
    expect(v.result).toBe('failure');
    expect(v.message).toContain('stopped scheduling');
  });
});

describe('the other crons', () => {
  it('fails a weekly refresh whose last run was killed', () => {
    // What Cloudflare recorded for the Saturday Vegas refresh on 26 September.
    const v = judgeCron(
      spec('0 23 * * SAT'),
      [{ cron: '0 23 * * SAT', datetime: '2026-09-26T23:00:14Z', status: 'exceededResources' }],
      new Date('2026-09-29T12:00:00Z'),
    );
    expect(v.result).toBe('failure');
  });

  it('is quiet about a weekly refresh between runs', () => {
    const v = judgeCron(
      spec('0 23 * * SAT'),
      [{ cron: '0 23 * * SAT', datetime: '2026-09-26T23:00:14Z', status: 'success' }],
      new Date('2026-10-02T12:00:00Z'),
    );
    expect(v.result).toBe('success');
  });

  it('judges every cron the Worker has, one verdict each', () => {
    const verdicts = judgeAll([], new Date('2026-09-29T12:00:00Z'));
    expect(verdicts.map((v: { cron: string }) => v.cron)).toEqual(['*/5 * * * *', '0 9 * * *', '0 23 * * SAT', '0 15 * * SUN']);
  });
});

describe('the list of crons', () => {
  it('matches what wrangler.toml schedules, so a new cron cannot go unwatched', async () => {
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const line = toml.split('\n').find((l) => l.trim().startsWith('crons ='))!;
    const scheduled = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(CRONS.map((c: { cron: string }) => c.cron).sort()).toEqual(scheduled.sort());
  });
});

describe('reading Cloudflare', () => {
  it('asks for scheduled invocations of this Worker only, and reads them back', async () => {
    const sent: { url: string; body: string }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      return new Response(
        JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsScheduled: [{ cron: FIVE, status: 'success', datetime: '2026-09-29T12:00:27Z' }] }] } } }),
      );
    };
    const rows = await fetchInvocations({
      token: 't',
      account: 'acct',
      from: new Date('2026-09-21T12:00:00Z'),
      to: new Date('2026-09-29T12:00:00Z'),
      fetchImpl,
    });
    expect(rows).toHaveLength(1);
    expect(sent[0]!.body).toContain('workersInvocationsScheduled');
    expect(JSON.parse(sent[0]!.body).variables.s).toBe('fantasy-analyst');
  });

  it('throws rather than reporting an empty list as healthy silence', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] }), { status: 403 });
    await expect(
      fetchInvocations({ token: 't', account: 'a', from: new Date(), to: new Date(), fetchImpl }),
    ).rejects.toThrow(/not authorized/);
  });
});

/*
 * The simulated failure, end to end: the outage's verdict handed to the same
 * alert every scheduled workflow uses, against an issue that is already open
 * for something else -- the state #204 was in on 27 September.
 */
describe('the alarm, when the tick is killed', () => {
  function fakeGitHub(open: { body: string } | null) {
    const state = {
      issues: open ? [{ number: 204, state: 'open', title: ISSUE_TITLE, labels: [ISSUE_LABEL], body: open.body }] : [],
      comments: [] as { number: number; body: string }[],
    };
    return {
      state,
      api: {
        async ensureLabel() {},
        async findIssue() {
          return state.issues[0] ?? null;
        },
        async createIssue({ body }: { body: string }) {
          const issue = { number: 1, state: 'open', title: ISSUE_TITLE, labels: [ISSUE_LABEL], body };
          state.issues.push(issue);
          return issue;
        },
        async updateIssue(number: number, patch: { body: string; state: string }) {
          Object.assign(state.issues.find((i) => i.number === number)!, patch);
        },
        async comment(number: number, body: string) {
          state.comments.push({ number, body });
        },
      },
    };
  }

  const verdictAt = (iso: string) =>
    judgeAll(ticks('2026-09-27T06:00:00Z', iso, outage), new Date(Date.parse(iso) + 5 * 60_000)).find(
      (v: { cron: string }) => v.cron === FIVE,
    );

  it('adds the tick to the open issue and says so in a comment, which is what notifies', async () => {
    const github = fakeGitHub(null);
    // Something else already failing, as the daily sweep was.
    await recordOutcome({ api: github.api, event: { workflow: 'Daily production sweep', result: 'failure', at: '2026-09-27T08:00:00Z', runUrl: 'u', runNumber: '1' } });
    const before = github.state.comments.length;

    const v = verdictAt('2026-09-27T10:15:00Z');
    expect(v.result).toBe('failure');
    await recordOutcome({ api: github.api, event: { workflow: v.name, result: v.result, at: '2026-09-27T10:20:00Z', runUrl: 'u', runNumber: '2' } });

    const failing = parseState(github.state.issues[0]!.body).failing;
    expect(Object.keys(failing)).toContain('Worker: five-minute injury check');
    expect(github.state.issues[0]!.state).toBe('open');
    expect(github.state.comments.length, 'a new failing row must post a comment, not just edit the body').toBe(before + 1);
    expect(github.state.comments.at(-1)!.body).toContain('Worker: five-minute injury check');
  });

  it('takes the row away again once the tick recovers', async () => {
    const github = fakeGitHub(null);
    const bad = verdictAt('2026-09-27T10:15:00Z');
    await recordOutcome({ api: github.api, event: { workflow: bad.name, result: bad.result, at: '2026-09-27T10:20:00Z', runUrl: 'u', runNumber: '1' } });
    const good = verdictAt('2026-09-28T08:15:00Z');
    expect(good.result).toBe('success');
    await recordOutcome({ api: github.api, event: { workflow: good.name, result: good.result, at: '2026-09-28T08:20:00Z', runUrl: 'u', runNumber: '2' } });

    expect(parseState(github.state.issues[0]!.body).failing).toEqual({});
    expect(github.state.issues[0]!.state).toBe('closed');
  });
});
