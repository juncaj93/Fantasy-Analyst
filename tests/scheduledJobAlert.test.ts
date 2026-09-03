/**
 * The alarm for scheduled workflows, asserted at both levels it can fail at.
 *
 * The defect this exists to prevent has already happened twice: `Refresh draft
 * order` failed on every scheduled run from 2026-08-16 to 2026-08-27 and the
 * only reason anybody found out was that somebody went looking. GitHub's own
 * failure email is not something this repository can see or test; an issue it
 * writes itself is.
 *
 *   1. the wiring — every workflow that runs on a `schedule` calls the alert,
 *      always, with its own name and the result of the job that did the work
 *   2. the behaviour — one issue, updated rather than duplicated, closed by the
 *      success that resolves it
 *
 * The second half runs the real script against a fake GitHub, so what is
 * checked is the code the workflow runs rather than a description of it.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkflow, triggers, type YamlValue } from './helpers/workflowYaml.ts';
// prettier-ignore
// @ts-expect-error -- a plain .mjs workflow helper, deliberately not part of the app build
import { ISSUE_LABEL, ISSUE_TITLE, nextState, parseState, renderIssueBody, shouldBeOpen } from '../scripts/lib/scheduledJobAlert.mjs';
// @ts-expect-error -- likewise: the script the workflow runs, with no dependencies of its own
import { recordOutcome } from '../scripts/scheduled-job-alert.mjs';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

const asMap = (value: YamlValue | undefined): Record<string, YamlValue> =>
  (value ?? {}) as Record<string, YamlValue>;
const jobs = (yaml: Record<string, YamlValue>) => asMap(yaml['jobs']);

const ALERT = './.github/workflows/alert-on-failure.yml';

/* --------------------------------------------------------------- the wiring */

describe('every scheduled workflow raises an alarm when it fails', () => {
  /** The files that GitHub will start on a cron, whatever else they also do. */
  const scheduled = readdirSync(WORKFLOWS).filter((name) => {
    const { yaml } = readWorkflow(name);
    return triggers(yaml)['schedule'] !== undefined;
  });

  it('finds the scheduled workflows', () => {
    // The two ADP refreshes, and smoke-daily.yml: the full production sweep
    // moved off every deploy and onto a daily schedule when 150 test
    // executions a deploy were found to be spending the D1 row quota.
    //
    // The sweep is a wrapper around `smoke.yml` rather than a schedule inside
    // it, and this list is why the difference is load-bearing: the alarm needs
    // `issues: write`, `smoke.yml` is called by `deploy.yml`, and a called
    // workflow cannot hold permissions its caller lacks. Putting the schedule
    // in `smoke.yml` failed every Deploy at startup.
    //
    // A new scheduled workflow that forgets the alert fails the assertions
    // below rather than going unnoticed for twelve days, which is the point.
    expect(scheduled).toEqual(['refresh-adp.yml', 'refresh-underdog-adp.yml', 'smoke-daily.yml']);
  });

  it.each(scheduled)('%s calls the alert', (name) => {
    const { yaml } = readWorkflow(name);
    const alert = Object.values(jobs(yaml))
      .map(asMap)
      .find((job) => job['uses'] === ALERT);
    expect(alert, `${name} declares no job that uses ${ALERT}`).toBeDefined();

    // `always()`, not `failure()`: the success that fixes it has to arrive too,
    // or the issue stays open forever after the cause is gone.
    expect(String(alert!['if'])).toContain('always()');

    // The name recorded on the issue is this workflow's own.
    expect(asMap(alert!['with'])['workflow']).toBe(yaml['name']);

    // And the result reported is the result of a job in this file, rather than
    // a literal that would report the same thing every day.
    const result = String(asMap(alert!['with'])['result']);
    const [, source] = result.match(/needs\.([\w-]+)\.result/) ?? [];
    expect(source, `${name} should report a job's own result, not ${result}`).toBeDefined();
    expect(Object.keys(jobs(yaml))).toContain(source!);
    expect(String(alert!['needs'])).toContain(source!);
  });

  it.each(scheduled)('%s grants the alert the permission it needs', (name) => {
    const { yaml } = readWorkflow(name);
    const alert = Object.values(jobs(yaml))
      .map(asMap)
      .find((job) => job['uses'] === ALERT)!;
    // A called workflow cannot hold a permission its caller did not grant, and
    // the failure mode is a 403 inside the job that exists to report failures.
    expect(asMap(alert['permissions'])['issues']).toBe('write');
  });

  it('the alert itself asks for issues, and nothing more than it needs', () => {
    const { yaml } = readWorkflow('alert-on-failure.yml');
    expect(asMap(yaml['permissions'])['issues']).toBe('write');
    expect(asMap(yaml['permissions'])['contents']).toBe('read');
    expect(Object.keys(triggers(yaml)).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  });

  /*
   * A concurrency group was tried here — one issue, read-modify-written, is
   * exactly what a group is for — and taken out again. `cancel-in-progress:
   * false` protects the run that is *in flight*; a run already waiting in the
   * group is cancelled, silently, when a newer one queues behind it. A lost
   * update costs one row the next run puts back; a cancelled alert costs the
   * alarm.
   */
  it('the alert is never queued behind, or cancelled by, another alert', () => {
    const { yaml } = readWorkflow('alert-on-failure.yml');
    expect(yaml['concurrency']).toBeUndefined();
    expect(Object.keys(asMap(jobs(yaml)['alert']))).not.toContain('concurrency');
  });

  /*
   * The alarm must work on a morning when the install is the thing that broke.
   */
  it('the alert depends on nothing it has to install', () => {
    const { text } = readWorkflow('alert-on-failure.yml');
    // Read the lines that run, not the comment that explains why they do not.
    const executable = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(executable).not.toContain('npm ci');
    expect(executable).not.toContain('npm install');
  });
});

/* ------------------------------------------------------------ the state */

/** The shape the .mjs helper works in, named here so the tests can index it. */
type State = { failing: Record<string, Record<string, unknown>> };
const empty = (): State => ({ failing: {} });

const event = (over: Partial<Record<string, string>> = {}) => ({
  workflow: 'Refresh draft order',
  result: 'failure',
  at: '2026-08-16T11:45:00Z',
  runUrl: 'https://github.com/o/r/actions/runs/1',
  runNumber: '5',
  ...over,
});

describe('what the issue remembers', () => {
  it('survives a round trip through the issue body', () => {
    const { state } = nextState(empty(), event());
    expect(parseState(renderIssueBody(state))).toEqual(state);
  });

  it('reads an issue somebody edited by hand as empty rather than throwing', () => {
    expect(parseState('just some words')).toEqual({ failing: {} });
    expect(parseState('<!-- scheduled-job-alert:state {not json -->')).toEqual({ failing: {} });
    expect(parseState(undefined)).toEqual({ failing: {} });
  });

  /*
   * The hidden marker is the store, and the table is what a person reads — but
   * an issue somebody has edited, or a client that strips HTML comments, would
   * leave the marker gone. Losing it silently would reset every count to one
   * and leave the issue open after the fix, so the table is read as a fallback.
   */
  it('reads the table back when the hidden marker is gone', () => {
    let state: State = empty();
    ({ state } = nextState(state, event()));
    ({ state } = nextState(state, event({ at: '2026-08-27T11:45:00Z', runNumber: '16' })));

    const body = renderIssueBody(state);
    const withoutMarker = body.slice(0, body.indexOf('<!-- scheduled-job-alert:state'));
    expect(withoutMarker).not.toContain('scheduled-job-alert:state');

    const recovered = parseState(withoutMarker).failing['Refresh draft order'];
    expect(recovered['count']).toBe(2);
    expect(recovered['since']).toBe('2026-08-16T11:45:00Z');
    expect(recovered['at']).toBe('2026-08-27T11:45:00Z');
    expect(recovered['runNumber']).toBe('16');
    expect(recovered['runUrl']).toBe('https://github.com/o/r/actions/runs/1');

    // And a job counted from the table still recovers, rather than being stuck.
    const { state: after } = nextState(parseState(withoutMarker), event({ result: 'success' }));
    expect(shouldBeOpen(after)).toBe(false);
  });

  it('counts repeated failures against one entry, keeping the day it started', () => {
    let state: State = empty();
    for (let day = 16; day <= 27; day++) {
      const at = `2026-08-${day}T11:45:00Z`;
      ({ state } = nextState(state, event({ at, runNumber: String(day) })));
    }
    expect(Object.keys(state.failing)).toEqual(['Refresh draft order']);
    const entry = state.failing['Refresh draft order'] as Record<string, unknown>;
    expect(entry['count']).toBe(12);
    expect(entry['since']).toBe('2026-08-16T11:45:00Z');
    expect(entry['at']).toBe('2026-08-27T11:45:00Z');
  });

  it('says how long it has been broken, in the table a human reads', () => {
    let state: State = empty();
    ({ state } = nextState(state, event()));
    ({ state } = nextState(state, event({ at: '2026-08-27T11:45:00Z' })));
    const body = renderIssueBody(state);
    expect(body).toContain('Refresh draft order');
    expect(body).toContain('2026-08-16 11:45 UTC (11 days)');
    expect(body).toContain('| 2 |');
  });

  it('keeps two broken jobs apart', () => {
    let state: State = empty();
    ({ state } = nextState(state, event()));
    ({ state } = nextState(state, event({ workflow: 'Refresh Underdog ADP' })));
    expect(Object.keys(state.failing).sort()).toEqual(['Refresh Underdog ADP', 'Refresh draft order']);

    // One recovers; the other is still broken, so the issue stays open.
    ({ state } = nextState(state, event({ result: 'success', at: '2026-08-28T11:45:00Z' })));
    expect(Object.keys(state.failing)).toEqual(['Refresh Underdog ADP']);
    expect(shouldBeOpen(state)).toBe(true);
  });

  /*
   * A cancelled run is somebody pressing stop. Reading it as a recovery would
   * clear a row for a job that is still just as broken as it was.
   */
  it.each(['cancelled', 'skipped'])('treats a %s run as no news at all', (result) => {
    const { state: broken } = nextState(empty(), event());
    const { state, change } = nextState(broken, event({ result }));
    expect(change).toBe('ignored');
    expect(state).toEqual(broken);
  });
});

/* ------------------------------------------------- the script, end to end */

/** A GitHub with one issue list, enough to run the real script against. */
function fakeGitHub() {
  const state: {
    issues: { number: number; state: string; body: string; title: string; labels: string[] }[];
    comments: { number: number; body: string }[];
    labelCreated: boolean;
  } = { issues: [], comments: [], labelCreated: false };

  return {
    state,
    api: {
      async ensureLabel() {
        state.labelCreated = true;
      },
      async findIssue() {
        const labelled = state.issues.filter((issue) => issue.labels.includes(ISSUE_LABEL));
        return labelled.find((issue) => issue.state === 'open') ?? labelled[0] ?? null;
      },
      async createIssue({ body }: { body: string }) {
        const issue = {
          number: state.issues.length + 1,
          state: 'open',
          body,
          title: ISSUE_TITLE,
          labels: [ISSUE_LABEL],
        };
        state.issues.push(issue);
        return issue;
      },
      async updateIssue(number: number, fields: { body?: string; state?: string }) {
        const issue = state.issues.find((one) => one.number === number)!;
        Object.assign(issue, fields);
        return issue;
      },
      async comment(number: number, body: string) {
        state.comments.push({ number, body });
      },
    },
  };
}

describe('one issue, kept in step with reality', () => {
  it('opens exactly one issue, however many mornings the job fails', async () => {
    const github = fakeGitHub();
    for (let day = 16; day <= 27; day++) {
      await recordOutcome({ api: github.api, event: event({ at: `2026-08-${day}T11:45:00Z` }) });
    }

    expect(github.state.issues).toHaveLength(1);
    expect(github.state.issues[0]!.title).toBe(ISSUE_TITLE);
    expect(github.state.issues[0]!.state).toBe('open');
    // Nothing is said twelve times. The issue appearing is the notification for
    // the first failure; the eleven after it move a number in the table, because
    // twelve notifications about one broken thing is how notifications get muted.
    expect(github.state.comments).toHaveLength(0);
    expect(github.state.issues[0]!.body).toContain('Refresh draft order');

    const entry = parseState(github.state.issues[0]!.body).failing['Refresh draft order'] as Record<
      string,
      unknown
    >;
    expect(entry['count']).toBe(12);
  });

  it('closes the issue when the fix lands', async () => {
    const github = fakeGitHub();
    await recordOutcome({ api: github.api, event: event() });
    const result = await recordOutcome({
      api: github.api,
      event: event({ result: 'success', at: '2026-08-28T11:45:00Z' }),
    });

    expect(result.action).toBe('closed');
    expect(github.state.issues[0]!.state).toBe('closed');
    expect(github.state.issues[0]!.body).toContain('Nothing is failing');
    expect(github.state.comments.at(-1)!.body).toContain('succeeded again');
  });

  it('reopens the one it had rather than starting a new history', async () => {
    const github = fakeGitHub();
    await recordOutcome({ api: github.api, event: event() });
    await recordOutcome({ api: github.api, event: event({ result: 'success' }) });
    const again = await recordOutcome({ api: github.api, event: event({ at: '2026-09-01T11:45:00Z' }) });

    expect(again.action).toBe('reopened');
    expect(github.state.issues).toHaveLength(1);
    expect(github.state.issues[0]!.state).toBe('open');
    // A fresh spell of failure, counted from the day it started again.
    const entry = parseState(github.state.issues[0]!.body).failing['Refresh draft order'] as Record<
      string,
      unknown
    >;
    expect(entry['count']).toBe(1);
    expect(entry['since']).toBe('2026-09-01T11:45:00Z');
  });

  /*
   * The ordinary case, which happens every day for every healthy job: nothing
   * is wrong, and nothing should be created to say so.
   */
  it('creates nothing when a job that was fine succeeds again', async () => {
    const github = fakeGitHub();
    const result = await recordOutcome({ api: github.api, event: event({ result: 'success' }) });
    expect(result.action).toBe('nothing');
    expect(github.state.issues).toHaveLength(0);
    expect(github.state.comments).toHaveLength(0);
  });

  it('leaves the other job listed when only one of two recovers', async () => {
    const github = fakeGitHub();
    await recordOutcome({ api: github.api, event: event() });
    await recordOutcome({ api: github.api, event: event({ workflow: 'Refresh Underdog ADP' }) });
    await recordOutcome({ api: github.api, event: event({ result: 'success' }) });

    expect(github.state.issues[0]!.state).toBe('open');
    expect(github.state.issues[0]!.body).toContain('Refresh Underdog ADP');
    expect(github.state.issues[0]!.body).not.toContain('| Refresh draft order |');
  });

  it('records nothing at all for a cancelled run', async () => {
    const github = fakeGitHub();
    const result = await recordOutcome({ api: github.api, event: event({ result: 'cancelled' }) });
    expect(result.action).toBe('ignored');
    expect(github.state.issues).toHaveLength(0);
  });
});
