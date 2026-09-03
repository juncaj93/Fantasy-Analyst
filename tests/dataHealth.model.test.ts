/**
 * The canonical health model, on its own.
 *
 * These are the claims the whole lane rests on, and they are asserted about
 * pure functions rather than about a screen: a health screen is only worth
 * having if `waiting` never reads as a fault, if a deferred backfill never
 * reads as a failure, and if last-attempt and last-success can disagree without
 * one of them being rounded away.
 *
 * Semantic rather than textual wherever the wording could reasonably change —
 * the state words are the contract and are asserted directly; the sentences are
 * asserted for the distinction they draw rather than verbatim.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERALL_LABELS,
  SOURCE_LABELS,
  boundedNote,
  describeAge,
  describeRun,
  describeSource,
  headline,
  minutesSince,
  needsAttention,
  overallState,
  runOutcome,
  stepOutcomeFrom,
  MAX_NOTE_CHARS,
  type RunHealth,
  type RunStep,
  type SourceHealth,
} from '../src/core/health/model.ts';
import { SOURCE_POLICIES, classifyAge, policyFor, sourceHealth } from '../src/core/health/policy.ts';

const NOW = new Date('2026-09-15T12:00:00.000Z');

function source(over: Partial<SourceHealth> & { id: string }): SourceHealth {
  return {
    label: over.label ?? over.id,
    severity: 'important',
    state: 'current',
    lastSuccessAt: null,
    lastAttemptAt: null,
    ageMinutes: null,
    measure: 'data',
    cadence: 'daily',
    freshWithinMinutes: null,
    note: null,
    technical: { lastOutcome: null, consecutiveFailures: 0, failingSince: null, note: null },
    ...over,
  } as SourceHealth;
}

function step(over: Partial<RunStep> & { id: string }): RunStep {
  return { label: over.id, outcome: 'succeeded', items: null, note: null, ...over };
}

// ------------------------------------------------------- what needs a person

describe('what a reader is being asked to act on', () => {
  it('a source with nothing published is never a task', () => {
    expect(needsAttention(source({ id: 'injuries', state: 'waiting', severity: 'critical' }))).toBe(false);
  });

  it('deliberately deferred background work is never a task', () => {
    expect(needsAttention(source({ id: 'manager-intel', state: 'deferred', severity: 'background' }))).toBe(false);
  });

  it('missing and degraded always are', () => {
    for (const state of ['missing', 'degraded'] as const) {
      expect(needsAttention(source({ id: 'x', state, severity: 'background' })), state).toBe(true);
    }
  });

  /**
   * Staleness is graded by decision impact, which is §6's severity rule.
   *
   * Weekly background learning going quiet for a day and near-kickoff odds
   * going quiet for a day are not the same event, and a screen that put them on
   * the same row is a screen that gets ignored.
   */
  it('stale counts only where staleness can move a recommendation', () => {
    expect(needsAttention(source({ id: 'vegas', state: 'stale', severity: 'critical' }))).toBe(true);
    expect(needsAttention(source({ id: 'usage', state: 'stale', severity: 'important' }))).toBe(true);
    expect(needsAttention(source({ id: 'manager-intel', state: 'stale', severity: 'background' }))).toBe(false);
  });

  it('unknown is not a task, because nothing has been measured', () => {
    expect(needsAttention(source({ id: 'x', state: 'unknown', severity: 'critical' }))).toBe(false);
  });
});

// ------------------------------------------------------------- the one word

describe('the overall state', () => {
  const healthy = [source({ id: 'a' }), source({ id: 'b' })];

  it('is healthy when every input is current', () => {
    expect(overallState(healthy, null)).toBe('healthy');
  });

  it('is waiting when the worst thing true is a source that has not published', () => {
    expect(overallState([...healthy, source({ id: 'c', state: 'waiting' })], null)).toBe('waiting');
  });

  it('is stale when something a decision leans on is past its window', () => {
    expect(overallState([...healthy, source({ id: 'c', state: 'stale', severity: 'important' })], null)).toBe('stale');
  });

  /** A background source going stale must not change the headline word. */
  it('is not stale for background learning alone', () => {
    expect(overallState([...healthy, source({ id: 'c', state: 'stale', severity: 'background' })], null)).toBe(
      'healthy',
    );
  });

  it('is degraded when a non-critical input is degraded or missing', () => {
    expect(overallState([...healthy, source({ id: 'c', state: 'degraded', severity: 'background' })], null)).toBe(
      'degraded',
    );
  });

  it('is a refresh problem when a critical input is missing or degraded', () => {
    expect(overallState([...healthy, source({ id: 'c', state: 'missing', severity: 'critical' })], null)).toBe(
      'problem',
    );
    expect(overallState([...healthy, source({ id: 'c', state: 'degraded', severity: 'critical' })], null)).toBe(
      'problem',
    );
  });

  /**
   * The case a per-source view cannot see.
   *
   * Every source can read current because everything was fetched yesterday, and
   * the pipeline that fetched it has since stopped. Only the run says so.
   */
  it('is a refresh problem when the last scheduled run failed outright, however current the data looks', () => {
    const failed = { outcome: 'failed', steps: [] } as unknown as RunHealth;
    expect(overallState(healthy, failed)).toBe('problem');
  });

  it('is unknown with nothing to go on', () => {
    expect(overallState([], null)).toBe('unknown');
    expect(overallState([source({ id: 'a', state: 'unknown' })], null)).toBe('unknown');
  });

  it('names every state in the words §3 asks for', () => {
    expect(OVERALL_LABELS).toMatchObject({
      healthy: 'Healthy',
      waiting: 'Waiting on source',
      stale: 'Some data stale',
      degraded: 'Degraded',
      problem: 'Refresh problem',
    });
  });
});

// ------------------------------------------------------------ the Setup row

describe('the Setup row sentence', () => {
  it('is the state and an age when there is nothing to do', () => {
    const at = new Date(NOW.getTime() - 18 * 60_000).toISOString();
    expect(headline('healthy', 0, at, NOW)).toBe('Healthy · refreshed 18 min ago');
  });

  it('is the count when there is', () => {
    expect(headline('stale', 2, null, NOW)).toBe('2 inputs need attention');
    expect(headline('stale', 1, null, NOW)).toBe('1 input needs attention');
  });

  it('says the state alone when nothing has ever been refreshed', () => {
    expect(headline('unknown', 0, null, NOW)).toBe('Not known yet');
  });
});

describe('ages a person can read', () => {
  it.each([
    [0, 'just now'],
    [1, '1 min ago'],
    [59, '59 min ago'],
    [60, '1h ago'],
    [23 * 60, '23h ago'],
    [24 * 60, '1 day ago'],
    [72 * 60, '3 days ago'],
  ])('%i minutes reads as %s', (minutes, expected) => {
    expect(describeAge(minutes)).toBe(expected);
  });

  it('is null rather than zero when the age is unknown', () => {
    expect(describeAge(null)).toBeNull();
  });

  it('treats a timestamp in the future as now rather than as negative', () => {
    expect(minutesSince(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(0);
  });

  it('is null for anything that is not an instant', () => {
    expect(minutesSince('not a date', NOW)).toBeNull();
    expect(minutesSince(null, NOW)).toBeNull();
  });
});

describe('the sentence on a source row', () => {
  it('appends an age to a state that has one', () => {
    expect(describeSource(source({ id: 'usage', state: 'current', ageMinutes: 120 }))).toBe('Current · 2h ago');
    expect(describeSource(source({ id: 'vegas', state: 'stale', ageMinutes: 18 }))).toBe('Stale · 18 min ago');
  });

  /** An absence has no age, and printing one would invite reading it as an old value. */
  it('never appends an age to a source that has published nothing', () => {
    expect(describeSource(source({ id: 'injuries', state: 'waiting', ageMinutes: 4000 }))).toBe('Waiting on source');
    expect(describeSource(source({ id: 'x', state: 'unknown', ageMinutes: 10 }))).toBe('Not known');
  });

  it('says background about deferred work rather than an age', () => {
    expect(describeSource(source({ id: 'manager-intel', state: 'deferred', ageMinutes: 900 }))).toBe(
      'Deferred · background',
    );
  });

  it('has a word for every state', () => {
    for (const state of Object.keys(SOURCE_LABELS)) expect(SOURCE_LABELS[state as never]).toBeTruthy();
  });
});

// ------------------------------------------------------------------- a run

describe('how a run is judged', () => {
  it('is a success when every step completed', () => {
    expect(runOutcome([step({ id: 'a' }), step({ id: 'b' })])).toBe('succeeded');
  });

  it('is partial when some steps failed and some did not', () => {
    expect(runOutcome([step({ id: 'a' }), step({ id: 'b', outcome: 'failed' })])).toBe('partial');
  });

  it('is failed only when nothing completed', () => {
    expect(runOutcome([step({ id: 'a', outcome: 'failed' }), step({ id: 'b', outcome: 'failed' })])).toBe('failed');
  });

  /**
   * The distinction the whole lane exists for.
   *
   * A tick that did all its work and then yielded the manager backfill is not a
   * clean success — saying so would hide the reason a `Next%` is thin — and it
   * is emphatically not a failure.
   */
  it('is deferred, not succeeded, when work was deliberately yielded', () => {
    expect(runOutcome([step({ id: 'a' }), step({ id: 'b', outcome: 'deferred' })])).toBe('deferred');
  });

  it('treats a source with nothing published as a completed step', () => {
    expect(runOutcome([step({ id: 'a', outcome: 'not_published' })])).toBe('succeeded');
  });

  it('is unknown with no steps at all', () => {
    expect(runOutcome([])).toBe('unknown');
  });

  it('describes a deferral as a budget decision rather than as a failure', () => {
    const summary = describeRun({
      cron: '0 9 * * *',
      label: 'Daily refresh',
      trigger: 'schedule',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      outcome: 'deferred',
      budget: { limit: 48, used: 48, remaining: 0 },
      steps: [step({ id: 'injuries', label: 'Injuries' }), step({ id: 'manager-intel', label: 'Manager tendencies', outcome: 'deferred' })],
      releaseSha: null,
    });
    expect(summary).toContain('Manager tendencies deferred');
    expect(summary).toContain('higher-priority data');
    expect(summary).not.toMatch(/fail/i);
  });

  it('names what did not complete, and what is waiting on a source', () => {
    const summary = describeRun({
      cron: '0 9 * * *',
      label: 'Daily refresh',
      trigger: 'schedule',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      outcome: 'partial',
      budget: null,
      steps: [
        step({ id: 'injuries', label: 'Injuries', outcome: 'failed' }),
        step({ id: 'usage', label: 'Usage', outcome: 'not_published' }),
        step({ id: 'schedule', label: 'NFL schedule' }),
      ],
      releaseSha: null,
    });
    expect(summary).toContain('Injuries');
    expect(summary).toMatch(/Usage waiting on the source/);
  });
});

describe("the pipelines' own outcome words", () => {
  it('keeps not_published apart from failure', () => {
    expect(stepOutcomeFrom('not_published')).toBe('not_published');
    expect(stepOutcomeFrom('failed')).toBe('failed');
    expect(stepOutcomeFrom('ingest_failed')).toBe('failed');
  });

  it('reads an unchanged source as a success, because it is one', () => {
    expect(stepOutcomeFrom('ok')).toBe('succeeded');
    expect(stepOutcomeFrom('not_modified')).toBe('succeeded');
  });

  it('keeps a skip apart from both', () => {
    expect(stepOutcomeFrom('skipped')).toBe('skipped');
    expect(stepOutcomeFrom('blocked')).toBe('skipped');
  });
});

// --------------------------------------------------------------- the policy

describe('the freshness policy is central and complete', () => {
  it('every source has a label, a cadence and a consequence', () => {
    for (const policy of SOURCE_POLICIES) {
      expect(policy.label, policy.id).toBeTruthy();
      expect(policy.cadence, policy.id).toBeTruthy();
      expect(policy.impact.length, policy.id).toBeGreaterThan(20);
      expect(policyFor(policy.id)).toBe(policy);
    }
  });

  it('names no source twice', () => {
    const ids = SOURCE_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Severity is decision impact, stated once here so a future source cannot be
   * added at `critical` for being noisy rather than for being load-bearing.
   */
  it('reserves critical for the inputs that decide who plays', () => {
    const critical = SOURCE_POLICIES.filter((p) => p.severity === 'critical').map((p) => p.id);
    /*
     * `roster` earns it on the gate's own terms rather than in spite of them.
     *
     * The other three change what the app says about a player. This one changes
     * *which players it is talking about*, so a stale roster does not degrade a
     * recommendation, it aims it at somebody else's squad — which is what a
     * defence claimed off waivers proved when the Waivers screen went on
     * advising an empty DEF slot the owner had already filled.
     */
    expect(critical).toEqual(['roster', 'injuries', 'vegas', 'nfl-state']);
  });

  it('files background learning as background', () => {
    const background = SOURCE_POLICIES.filter((p) => p.severity === 'background').map((p) => p.id);
    expect(background).toContain('manager-intel');
    expect(background).toContain('nflverse');
  });

  /** A finished week's numbers never move, so what matters is that we still ask. */
  it('measures the feeds whose data legitimately stops moving by their attempt', () => {
    for (const id of ['usage', 'schedule', 'nflverse', 'players', 'manager-intel'] as const) {
      expect(policyFor(id).measure, id).toBe('attempt');
    }
  });

  it('measures the feeds whose value is its recency by the data', () => {
    for (const id of ['injuries', 'vegas', 'season-markets'] as const) {
      expect(policyFor(id).measure, id).toBe('data');
    }
  });
});

describe('the age boundary, exactly', () => {
  it('is inclusive: a source exactly on its window is still current', () => {
    expect(classifyAge(60, 60)).toBe('current');
  });

  it('is stale one minute past it', () => {
    expect(classifyAge(61, 60)).toBe('stale');
  });

  it('is current just inside it', () => {
    expect(classifyAge(59, 60)).toBe('current');
  });

  it('is unknown when the age is unknown, never current and never stale', () => {
    expect(classifyAge(null, 60)).toBe('unknown');
  });

  it('is current where a source has no window to age against', () => {
    expect(classifyAge(10_000, null)).toBe('current');
  });
});

describe('the shared row assembler', () => {
  it('says nothing extra about a current source', () => {
    const row = sourceHealth(policyFor('usage'), 'current', {
      lastSuccessAt: NOW.toISOString(),
      lastAttemptAt: NOW.toISOString(),
      ageMinutes: 5,
      freshWithinMinutes: 60,
      note: 'through week 3',
    });
    expect(row.note).toBeNull();
  });

  it('falls back to what staleness costs, when the pipeline had nothing to add', () => {
    const row = sourceHealth(policyFor('vegas'), 'stale', {
      lastSuccessAt: NOW.toISOString(),
      lastAttemptAt: NOW.toISOString(),
      ageMinutes: 5_000,
      freshWithinMinutes: 60,
      note: null,
    });
    expect(row.note).toBe(policyFor('vegas').impact);
  });

  it('carries the label, severity and cadence from the policy rather than the caller', () => {
    const row = sourceHealth(policyFor('manager-intel'), 'deferred', {
      lastSuccessAt: null,
      lastAttemptAt: null,
      ageMinutes: null,
      freshWithinMinutes: null,
    });
    expect(row.label).toBe('Manager tendencies');
    expect(row.severity).toBe('background');
    expect(row.cadence).toContain('budget');
  });
});

describe('notes are bounded before they are stored', () => {
  it('leaves a short sentence alone', () => {
    expect(boundedNote('  two   spaces  ')).toBe('two spaces');
  });

  it('is null rather than empty', () => {
    expect(boundedNote('   ')).toBeNull();
    expect(boundedNote(null)).toBeNull();
  });

  it('truncates anything that could become a log', () => {
    const long = 'x'.repeat(500);
    expect(boundedNote(long)!.length).toBe(MAX_NOTE_CHARS);
    expect(boundedNote(long)!.endsWith('…')).toBe(true);
  });
});
