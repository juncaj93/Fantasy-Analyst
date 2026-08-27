/**
 * Data Health, for a scenario, through the production presentation.
 *
 * §15 asks Demo Mode to demonstrate the same presentation contract with no
 * network and **no alternate fake health engine**, and the shape of this file
 * is that requirement:
 *
 *   - the rows are built by `sourceHealth`, the same assembler the deployment's
 *     `DataHealthService` ends every row with;
 *   - the labels, severities, cadences and impact sentences come from
 *     `SOURCE_POLICIES`, the same table the deployment reads;
 *   - the overall word, the count of what needs attention and the Setup row's
 *     sentence come from `overallState`, `needsAttention` and `headline` —
 *     the same three functions, in the same order.
 *
 * The one thing that is different is where the state comes from, and that
 * difference is what a scenario *is*. A deployment measures a source's state
 * from what its pipeline recorded; a scenario declares the world, so it states
 * the state. Everything downstream of that is one code path, which is why a
 * degraded scenario cannot look healthy on this screen while looking degraded
 * on Setup — both are derived from `scenario.freshness`.
 *
 * ## Why the three states the brief names are all reachable
 *
 * A healthy scenario is every row `current`. A draft scenario has legitimately
 * unpublished weekly data — no NFL week has been played, so the published
 * projections and the per-game usage are `waiting`, which is the state that
 * must never read as a fault. The degraded bundle carries a stale market and an
 * unreachable Sleeper, and every scenario without a transaction history shows
 * the manager backfill `deferred` with the budget sentence beside it.
 */

import {
  describeRun,
  headline,
  minutesSince,
  needsAttention,
  overallState,
  runOutcome,
  type DataHealthView,
  type RunHealth,
  type RunStep,
  type SourceHealth,
  type SourceState,
} from '../../health/model.ts';
import { policyFor, sourceHealth, type SourceId } from '../../health/policy.ts';
import { hoursBefore } from '../clock.ts';
import type { DemoSourceState } from '../types.ts';
import type { ScenarioData } from '../fixtures/index.ts';

/**
 * A scenario's freshness word, in the health model's vocabulary.
 *
 * `aging` and `stale` both land on `stale`, which loses a distinction the draft
 * board keeps — see the note on `DemoSourceState` — and that is right here: the
 * board's difference is between a file it will still use and one it will
 * withhold, which is a decision about a market rather than a statement about
 * health. From this screen's point of view both are "past its window, and here
 * is how far past".
 *
 * `unavailable` becomes `missing` rather than `waiting`, because a scenario
 * that says a source is unavailable means it is unreachable. A source that has
 * legitimately published nothing is stated as `waiting` at the row below, where
 * the scenario knows which of the two it means.
 */
function toState(state: DemoSourceState): SourceState {
  switch (state) {
    case 'fresh':
      return 'current';
    case 'aging':
    case 'stale':
      return 'stale';
    case 'unavailable':
      return 'missing';
    default:
      return 'unknown';
  }
}

/** One row, from a state and an age measured against the scenario's own clock. */
function row(
  data: ScenarioData,
  id: SourceId,
  state: SourceState,
  hoursAgo: number | null,
  note?: string | null,
): SourceHealth {
  const policy = policyFor(id);
  const at = hoursAgo == null ? null : hoursBefore(data.clock, hoursAgo);
  const now = data.clock.now();
  return sourceHealth(policy, state, {
    lastSuccessAt: state === 'missing' || state === 'waiting' || state === 'unknown' ? null : at,
    lastAttemptAt: at,
    ageMinutes: minutesSince(at, now),
    /*
     * The window is not restated here.
     *
     * A demo row prints its state and its age; the number it was measured
     * against belongs to the deployment's policy table and would be a second
     * copy of it if it were written down again in a fixture. Null reads as "no
     * window applies", which is honest for a declared state.
     */
    freshWithinMinutes: null,
    note: note ?? null,
  });
}

export function buildDemoDataHealth(data: ScenarioData): DataHealthView {
  const { freshness, scenario } = data;
  const now = data.clock.now();

  /*
   * Before a week has been played, the weekly feeds have nothing to publish.
   *
   * This is the `waiting` demonstration, and it is derived rather than
   * declared: a scenario with no week is a scenario in which the NFL has
   * published no weekly usage and Rotowire has published no weekly projection,
   * and reporting either as stale or missing would be exactly the flattening
   * §3 refuses.
   */
  const weekly = scenario.week == null;

  const sources: SourceHealth[] = [
    row(
      data,
      'injuries',
      toState(freshness.injuries),
      freshness.injuries === 'unavailable' ? null : freshness.injuries === 'stale' ? 96 : 6,
      freshness.injuries === 'unavailable' ? 'The injury report could not be read in this scenario.' : null,
    ),
    row(
      data,
      'vegas',
      freshness.vegas === 'unavailable' ? 'missing' : toState(freshness.vegas),
      data.vegas.fetchedAt == null ? null : Math.max(0, Math.round(minutesSince(data.vegas.fetchedAt, now) ?? 0) / 60),
      freshness.vegas === 'unavailable' ? 'The odds provider is unreachable in this scenario.' : null,
    ),
    row(data, 'nfl-state', data.nflState == null ? 'unknown' : 'current', data.nflState == null ? null : 3),
    row(
      data,
      'published-projections',
      weekly ? 'waiting' : 'current',
      weekly ? null : 10,
      weekly ? 'No week has been played, so nothing is published yet.' : null,
    ),
    row(
      data,
      'usage',
      weekly ? 'waiting' : toState(freshness.usage),
      weekly ? null : freshness.usage === 'stale' ? 120 : 14,
      weekly ? 'No week has been played, so no per-game usage exists yet.' : null,
    ),
    row(
      data,
      'season-markets',
      data.seasonMarkets.size === 0 ? 'waiting' : toState(freshness.vegas),
      data.seasonMarkets.size === 0 ? null : 20,
      data.seasonMarkets.size === 0 ? 'No season-long lines stored in this scenario.' : null,
    ),
    row(
      data,
      'players',
      toState(freshness.sleeper),
      freshness.sleeper === 'unavailable' ? null : 3,
      freshness.sleeper === 'unavailable' ? 'Sleeper is unreachable, so the last state received is what is shown.' : null,
    ),
    row(data, 'schedule', 'current', 26),
    row(data, 'nflverse', 'current', 8),
    row(
      data,
      'trending',
      data.strategy?.trendingCapturedAt == null ? 'waiting' : 'current',
      data.strategy?.trendingCapturedAt == null ? null : 11,
      data.strategy?.trendingCapturedAt == null ? 'No trending capture in this scenario.' : null,
    ),
    row(data, 'newsletter', toState(freshness.newsletter), freshness.newsletter === 'stale' ? 200 : 20),
    /*
     * The deferred demonstration, and it is the honest state for these leagues.
     *
     * A scenario with no transaction history is a league whose backfill has not
     * reached it — which in the live app is what happens when the feeds above
     * it spend the invocation's subrequest budget, day after day, while the
     * ledger fills over a week. The row says so in the product's own words
     * rather than reporting a fault.
     */
    row(
      data,
      'manager-intel',
      data.transactions.length === 0 ? 'deferred' : 'current',
      data.transactions.length === 0 ? null : 30,
      data.transactions.length === 0 ? 'Refresh budget reserved for higher-priority data.' : null,
    ),
  ];

  const lastRun = demoRun(data, sources);
  const state = overallState(sources, lastRun);
  const attention = sources.filter(needsAttention).length;
  const refreshedAt = sources
    .map((s) => s.lastSuccessAt)
    .filter((v): v is string => v != null)
    .sort()
    .at(-1) ?? null;

  return {
    generatedAt: data.clock.iso(),
    overall: {
      state,
      headline: headline(state, attention, refreshedAt, now),
      refreshedAt,
      needsAttention: attention,
    },
    sources,
    lastRun,
    /*
     * `demo` rather than a revision, exactly as a demo support snapshot reports
     * it. A rehearsal must never be mistakable for production.
     */
    release: { gitSha: 'demo' },
  };
}

/**
 * The scenario's last scheduled run, derived from the same declared freshness.
 *
 * Not a second source of truth: every step's outcome is read off the rows
 * above, so a scenario cannot show a healthy run over a degraded source list.
 * The outcome word and the summary sentence come from `runOutcome` and
 * `describeRun`, which are the deployment's own.
 *
 * The budget numbers are the one thing here that is a fixture rather than a
 * measurement, and they are marked as such by the run label: nothing in Demo
 * Mode makes a subrequest, so there is no counter to read. They exist so the
 * Technical details panel has something to render at the widths §16 asks for.
 */
function demoRun(data: ScenarioData, sources: readonly SourceHealth[]): RunHealth {
  /*
   * The step's name comes from the policy, not from a literal here.
   *
   * A label written out in a fixture is the beginning of a second table, and
   * the first time somebody renamed a source the demo would keep saying the old
   * word. `tests/dataHealth.demo.test.ts` asserts that no policy label appears
   * as a literal anywhere in this file.
   */
  const stepFor = (id: SourceId): RunStep => {
    const label = policyFor(id).label;
    const source = sources.find((s) => s.id === id);
    const outcome =
      source?.state === 'deferred'
        ? ('deferred' as const)
        : source?.state === 'missing'
          ? ('failed' as const)
          : source?.state === 'waiting'
            ? ('not_published' as const)
            : ('succeeded' as const);
    return { id, label, outcome, items: null, note: source?.note ?? null };
  };

  /*
   * The daily tick's steps, in the order `scheduled()` runs them.
   *
   * The newsletter is not among them because it is not on a clock — it arrives
   * when it is delivered — and the Vegas refresh is not because it belongs to
   * the two weekend clocks rather than to this one.
   */
  const steps: RunStep[] = (
    [
      'players',
      'nfl-state',
      'injuries',
      'usage',
      'season-markets',
      'schedule',
      'trending',
      'published-projections',
      'nflverse',
      'manager-intel',
    ] as const
  ).map(stepFor);

  const outcome = runOutcome(steps);
  const startedAt = hoursBefore(data.clock, 5);
  const base = {
    cron: '0 9 * * *',
    label: 'Daily refresh',
    trigger: 'schedule' as const,
    startedAt,
    finishedAt: startedAt,
    outcome,
    budget: { limit: 48, used: 41, remaining: 7 },
    steps,
    releaseSha: 'demo',
  };
  return { ...base, summary: describeRun(base) };
}
