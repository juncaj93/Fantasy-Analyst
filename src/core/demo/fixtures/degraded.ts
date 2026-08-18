/**
 * The ways it goes wrong.
 *
 * These are not separate worlds. Each one is an ordinary scenario with a source
 * taken away, because that is what an outage is — and because the value of a
 * degraded scenario is showing that the *same* screen still works, says what it
 * lost, and lowers its confidence rather than showing a spinner or a lie.
 *
 * The removal happens at the source, never at the screen. `sleeper-adp-unavailable`
 * has no ADP snapshot; `partial-provider-outage` has no weekly market and a
 * usage file four days old. Nothing tells a card to hide anything.
 */

import { fixedClock, hoursBefore } from '../clock.ts';
import type { DemoScenario } from '../types.ts';
import { buildDraftScenario } from './draft.ts';
import { buildSeasonScenario } from './season.ts';
import type { ScenarioData } from './build.ts';

export function buildDegradedScenario(scenario: DemoScenario): ScenarioData {
  switch (scenario.id) {
    case 'offline-draft':
      return offlineDraft(scenario);
    case 'sleeper-adp-unavailable':
      // The board with no draft order at all: the fixture simply has no
      // snapshot, and the engine's own warning explains the consequence.
      return buildDraftScenario(scenario);
    case 'injury-source-stale':
      return staleInjuries(scenario);
    case 'partial-provider-outage':
      return partialOutage(scenario);
    default:
      return buildDraftScenario(scenario);
  }
}

/**
 * Offline, mid-draft.
 *
 * The board request *fails*, exactly as it does in a dead zone, and the screen
 * falls back to the board it cached before the signal went. That is the real
 * production path — `offlineCache.ts` and the refresh controller — being
 * exercised, rather than a picture of it. See `runtime/index.ts` for how the
 * failure is produced and how the cache is seeded.
 */
function offlineDraft(scenario: DemoScenario): ScenarioData {
  const data = buildDraftScenario(scenario);
  return {
    ...data,
    notes: [
      'The phone has no network. The board on screen was captured before the signal went, and says so.',
    ],
  };
}

/** Four days without a published report. Sleeper's own word is all that is left. */
function staleInjuries(scenario: DemoScenario): ScenarioData {
  const data = buildSeasonScenario({ ...scenario, id: 'sunday-pregame', week: 6 });
  const clock = fixedClock(scenario.asOf);
  return {
    ...data,
    scenario,
    injuries: new Map(
      [...data.injuries].map(([id, state]) => [
        id,
        {
          ...state,
          // Aged past the point at which the resolver still calls it fresh, and
          // stripped of the practice detail a stale file cannot have.
          observedAt: hoursBefore(clock, 96),
          freshness: 'stale' as const,
          practice: { trend: 'unknown' as const, days: [], latest: 'unknown' as const, label: null },
          practiceSource: null,
        },
      ]),
    ),
    notes: [
      'The published injury report has not moved in four days. Designations still stand; the practice detail behind them does not.',
    ],
  };
}

/**
 * The market is gone and the usage file is stale, at the same time.
 *
 * Two of the four numbers behind every recommendation are unknown. The
 * recommendation is still made — from role, availability and the news tally —
 * with its confidence lowered, which is the behaviour worth demonstrating.
 */
function partialOutage(scenario: DemoScenario): ScenarioData {
  const data = buildSeasonScenario({ ...scenario, id: 'sunday-pregame', week: 6 });
  return {
    ...data,
    scenario,
    specs: data.specs.map((spec) =>
      spec.week ? { ...spec, week: { ...spec.week, points: null, previousPoints: null } } : spec,
    ),
    seasonMarkets: new Map(),
    vegas: { fetchedAt: null, events: 0 },
    notes: [
      'The odds provider is unreachable and the usage file has not published since Wednesday. Every recommendation below is made from what is left.',
    ],
  };
}
