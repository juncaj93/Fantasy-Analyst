/**
 * Draft night, at four moments and in two degraded ones.
 *
 * Each scenario is the same room at a different pick. Nothing about the board
 * is written down: the picks are, and the ranking, tiers, survival percentages,
 * roster need, warnings and tier-cliff lines all come out of the production
 * engine reading them.
 */

import { fixedClock } from '../clock.ts';
import type { DemoScenario } from '../types.ts';
import {
  CLEAN_REPAIR,
  MESSY_REPAIR,
  collectPlayerState,
  makeAdp,
  makeDog,
  makeDraft,
  makeLeague,
  makeNflState,
  makePicks,
  makeRosters,
  myPicks,
  overrideSpecs,
  rostersFromPicks,
  type ScenarioData,
} from './build.ts';
import { WORLD_PLAYERS } from './world.ts';

/**
 * What the Underdog file looks like in this scenario.
 *
 * `freshness.dogAdp` is the scenario's declaration; this turns it into the
 * provenance a real import would have carried. `stale` is nine days, which is
 * past the 168-hour window the board stops trusting at — chosen so the number
 * on screen is unambiguous rather than a borderline case nobody can read.
 */
function dogOptionsFor(scenario: DemoScenario): Parameters<typeof makeDog>[2] {
  switch (scenario.freshness.dogAdp) {
    case 'unavailable':
      return { available: false };
    case 'aging':
      // Past the 36-hour window and inside the 168-hour one: used, and said.
      return { available: true, ageHours: 74 };
    case 'stale':
      return { available: true, ageHours: 216 };
    case 'not_applicable':
      return { available: false };
    default:
      return { available: true, ageHours: 6 };
  }
}

/** How many picks are in the book at each moment. */
const PICKS_MADE: Record<string, number> = {
  'draft-early': 8,
  'draft-mid': 63,
  'draft-late': 152,
  'draft-complete': 168,
  'offline-draft': 39,
  'sleeper-adp-unavailable': 63,
  'dog-unavailable': 63,
};

/**
 * The user's own marks.
 *
 * Hearts move the ranking; stars deliberately do not, and the board is meant to
 * demonstrate exactly that difference. So the marks are spread across the
 * draft: two on players who go early, so a first-round board shows them, and
 * three on players who are still there in the sixth and later — because a queue
 * filter that comes back empty at the moment somebody taps it demonstrates
 * nothing at all.
 */
const MY_MARKS = {
  // Early: the ledger's favourite, thirty picks above where the market has him.
  p009: { myGuy: 3 as const, queued: true },
  p022: { queued: true },
  // Late: still on the board deep into the draft, which is when a queue is used.
  p096: { myGuy: 2 as const, queued: true },
  p109: { queued: true },
  // And one nobody has ranked at all, which is the case a heart is really for.
  p141: { myGuy: 1 as const, queued: true },
};

export function buildDraftScenario(scenario: DemoScenario): ScenarioData {
  const clock = fixedClock(scenario.asOf);
  const picksMade = PICKS_MADE[scenario.id] ?? 63;
  const adpAvailable = scenario.freshness.adp !== 'unavailable';
  const injuriesAvailable = scenario.freshness.injuries !== 'unavailable';

  const specs = overrideSpecs(WORLD_PLAYERS, MY_MARKS);
  const picks = makePicks(picksMade);
  const byRosterId = rostersFromPicks(picks);

  const complete = picksMade >= 168;
  const draft = makeDraft({
    status: complete ? 'complete' : 'drafting',
    season: scenario.season,
  });

  const { players, signals, flags, seasonMarkets, injuries } = collectPlayerState(specs, clock, {
    injuriesAvailable,
  });

  /*
   * Underdog, from what the scenario declared about it.
   *
   * The four ways DOG can be absent are all expressed as provenance rather
   * than as a switch: no snapshot at all, a snapshot that is not raw ADP, one
   * too old to trust, and one that matched nobody. `resolveDog` in the board
   * decides what each of those is worth — this only writes down what the
   * importer would have written.
   */
  const dog = makeDog(specs, clock, dogOptionsFor(scenario));

  const adp = makeAdp(specs, {
    available: adpAvailable,
    /*
     * The label says which board this is, because the same players go in a
     * different order in full PPR and a very different one in superflex.
     */
    label: 'Sleeper half-PPR redraft, 1QB',
    capturedAt: '2026-08-24T06:00:00.000Z',
  });

  return {
    scenario,
    clock,
    specs,
    players,
    league: makeLeague({
      season: scenario.season,
      status: complete ? 'in_season' : 'drafting',
      name: scenario.format.name,
      bestBall: scenario.format.bestBall,
    }),
    rosters: makeRosters({ byRosterId }),
    draft,
    picks,
    adpSnapshot: adp.snapshot,
    adpValues: adp.values,
    dogSnapshot: dog.snapshot,
    dogValues: dog.values,
    signals,
    flags,
    seasonMarkets,
    injuries,
    /*
     * A late-round board is exactly when unresolved names start to cost
     * something, so that is where the readiness warning appears. Earlier it
     * would be noise; the board is usable either way and says so.
     */
    repair: picksMade >= 120 ? MESSY_REPAIR : CLEAN_REPAIR,
    nflState: makeNflState({ season: scenario.season, seasonType: 'pre', week: 0, clock }),
    freshness: scenario.freshness,
    vegas: {
      fetchedAt: scenario.freshness.vegas === 'unavailable' ? null : '2026-08-30T18:00:00.000Z',
      events: scenario.freshness.vegas === 'unavailable' ? 0 : 16,
    },
    // Nobody bids during a draft, and there is no wire yet to bid on.
    /* A draft is not a week, so this league has no schedule to read. */
    matchups: null,
    strategy: null,
    notes: [],
  };
}

/** `myPicks` re-exported so the season fixtures can start from a real draft. */
export { myPicks };
