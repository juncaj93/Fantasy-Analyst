/**
 * How active a trader a manager is, one function for every trade screen.
 *
 * Read by the trade ideas (through `managerFit.ts`) and by Build a trade
 * (review T11, November 2026), so "trades often" means the same thing on both.
 * Imports nothing, so a screen can rank with it without loading an engine.
 */

/** Fully observed seasons with no trade at all before inactivity is a finding. */
export const INACTIVITY_SEASONS = 2;

/**
 * How active a manager is, as five distinct claims.
 *
 * `unknown` is a statement about the evidence and every other value is a
 * statement about the manager. Keeping them in one enum is what makes it
 * impossible to write a consumer that accidentally treats an unmeasured manager
 * as a measured non-trader — the case §10 names as the standing principle.
 */
export type ActivityClass =
  | 'active'
  | 'selective'
  | 'low_activity'
  | 'effectively_inactive'
  | 'unknown';

/**
 * Which of the five classes describes this manager.
 *
 * The order of the tests is the argument. Completeness is checked before
 * anything else, so a manager whose history is still being read can never fall
 * through into a claim about his behaviour — which is the failure §10 exists to
 * prevent and the one that would be invisible in production, because an
 * incomplete backfill and a quiet manager produce the same empty profile.
 */
export function activityClassFor(args: {
  sample: number;
  seasonsObserved: number;
  historyComplete: boolean;
  ratePerSeason: number | null;
}): ActivityClass {
  const { sample, seasonsObserved, historyComplete } = args;

  // Anything at all on the record is a measurement, however thin.
  if (sample > 0) {
    const rate = args.ratePerSeason ?? sample / Math.max(1, seasonsObserved);
    if (sample >= 6 && rate >= 1.5) return 'active';
    if (sample >= 3) return 'selective';
    /*
     * One or two trades. Whether that is "rarely" or "we have barely looked"
     * depends entirely on how long he has been observed for.
     */
    return seasonsObserved >= INACTIVITY_SEASONS && historyComplete ? 'low_activity' : 'unknown';
  }

  // No trades. The only question left is whether anybody has actually looked.
  if (historyComplete && seasonsObserved >= INACTIVITY_SEASONS) return 'effectively_inactive';
  return 'unknown';
}

/** A measured manager who almost never trades. The ideas and Build a trade's sweep go to neither (Alex, November 2026). */
export function isRareTrader(activity: ActivityClass): boolean {
  return activity === 'low_activity' || activity === 'effectively_inactive';
}

/** Partners in the order Alex wants them: frequent traders first. */
export const ACTIVITY_RANK: Record<ActivityClass, number> = {
  active: 0,
  selective: 1,
  unknown: 2,
  low_activity: 3,
  effectively_inactive: 4,
};
