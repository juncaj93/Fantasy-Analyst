/**
 * Which inputs are worth reporting on, and what "current" means for each.
 *
 * One table, because the alternative is a stale-threshold in a component. §6 is
 * explicit about that and it is the rule this file exists to keep: **no screen
 * decides how old is too old.** A row renders the state it is handed and the
 * window it was measured against; it never computes one.
 *
 * ## Where the numbers come from
 *
 * Almost none of them are new. Every pipeline in this app already owns a
 * freshness rule — `FRESHNESS_HOURS` for the injury layer, `VEGAS_STALE_HOURS`
 * for the weekly market, `SEASON_TTL_MINUTES` for the season-long lines,
 * `MAX_AGE_HOURS` for the published fallback — and those rules already decide
 * what the *engines* do with the data. Re-deriving them here with slightly
 * different numbers would produce a screen that disagrees with the
 * recommendation it is describing, which is worse than no screen.
 *
 * So the windows are supplied by whichever module already owns them, and this
 * file declares only two genuinely new thresholds — the ones that answer a
 * question no existing rule answers, which is "has the pipeline stopped
 * running?" as opposed to "is the data old?". Both are justified below and both
 * are boundary-tested.
 *
 * ## Data age, or attempt age
 *
 * The distinction {@link FreshnessMeasure} draws is the reason a single number
 * per source would not do. A finished week's snap counts never change again, so
 * ageing them against the clock reports every October Tuesday as five days
 * stale for ever; what matters for that feed is whether it is still being
 * *asked*. A betting line is the exact opposite. Getting this backwards is how
 * a health screen ends up crying wolf about the sources that are fine and
 * silent about the one that is not.
 */

import { boundedNote, type FreshnessMeasure, type Severity, type SourceHealth, type SourceState } from './model.ts';

/**
 * The recommendation-driving inputs, in the order the screen lists them.
 *
 * Ordered by decision impact rather than alphabetically: the two feeds that can
 * change who starts on Sunday are first, and the background learning that
 * nudges a `Next%` is last. A reader scanning this list top-down reads it in
 * the order they would want to be told.
 */
export type SourceId =
  | 'injuries'
  | 'vegas'
  | 'nfl-state'
  | 'published-projections'
  | 'usage'
  | 'season-markets'
  | 'players'
  | 'schedule'
  | 'nflverse'
  | 'trending'
  | 'newsletter'
  | 'manager-intel';

export interface SourcePolicy {
  id: SourceId;
  /** What the user calls it. Never a table name, a provider or a filename. */
  label: string;
  severity: Severity;
  measure: FreshnessMeasure;
  /** How often it is expected to move, in the user's words. */
  cadence: string;
  /**
   * One sentence explaining what a recommendation loses when this is stale.
   *
   * Shown on the row when the state is not `current`, so a reader learns what
   * the consequence actually is rather than being handed a colour.
   */
  impact: string;
}

/**
 * A daily feed that has not been *asked* in this long has a pipeline problem.
 *
 * New here, and one of only two. The daily tick fires at 09:00 UTC, so a gap of
 * one and a half ticks is the smallest window that cannot be tripped by a
 * single slow morning, an invocation that started late, or a reader looking at
 * the screen at 08:59. Below about 30 hours this would flag a healthy
 * deployment once a week; much above 48 and a feed that stopped on Monday would
 * still read as fine on Wednesday, which is a day too late to be worth saying.
 *
 * It is the same 36 hours `VEGAS_STALE_HOURS` uses, for the same reason and
 * arrived at independently: a daily thing, plus half a day of slack.
 */
export const DAILY_ATTEMPT_STALE_MINUTES = 36 * 60;

/**
 * A five-minute feed that has not been asked in this long has a pipeline problem.
 *
 * The second and last new threshold. Six missed ticks: enough that one slow
 * invocation, one Cloudflare hiccup or one 502 from the source cannot produce a
 * warning, and short enough that a cron trigger somebody deleted is visible
 * within half an hour rather than at kickoff. The injury check is the only feed
 * on this cadence and it is the one where thirty minutes of silence genuinely
 * matters — a player is ruled out ninety minutes before a game.
 */
export const FREQUENT_ATTEMPT_STALE_MINUTES = 30;

/**
 * What each of Cloudflare's cron expressions is called on the screen.
 *
 * Keyed by the expression `wrangler.toml` registers, because that is the string
 * `scheduled()` is handed and the only identity a run has. Naming them here
 * rather than in the worker keeps the recorder and the reader agreeing about
 * what a clock is called without either importing the other's module.
 */
export const CRON_LABELS: Record<string, string> = {
  '*/5 * * * *': 'Injury check',
  '0 9 * * *': 'Daily refresh',
  '0 23 * * SAT': 'Saturday evening refresh',
  '0 15 * * SUN': 'Sunday pregame refresh',
};

export const SOURCE_POLICIES: readonly SourcePolicy[] = [
  {
    id: 'injuries',
    label: 'Injuries',
    severity: 'critical',
    measure: 'data',
    cadence: 'Checked every 5 minutes',
    impact: 'Availability may be read from an older report, so a ruled-out player can still look startable.',
  },
  {
    id: 'vegas',
    label: 'Vegas lines',
    severity: 'critical',
    measure: 'data',
    cadence: 'Refreshed Saturday and Sunday',
    impact: 'Projections fall back to older lines, and confidence is lowered rather than guessed at.',
  },
  {
    id: 'nfl-state',
    label: 'NFL week',
    severity: 'critical',
    measure: 'data',
    cadence: 'Refreshed daily',
    impact: 'The app may be reasoning about the wrong week.',
  },
  {
    id: 'published-projections',
    label: 'Published projections',
    severity: 'important',
    measure: 'data',
    cadence: 'Refreshed daily and both weekend clocks',
    impact: 'Players with no market of their own lose their fallback number and show as unknown.',
  },
  {
    id: 'usage',
    label: 'Usage',
    severity: 'important',
    measure: 'attempt',
    cadence: 'Checked daily',
    impact: 'Role and opportunity trends stop at the last week that landed.',
  },
  {
    id: 'season-markets',
    label: 'Season market lines',
    severity: 'important',
    measure: 'data',
    cadence: 'Refreshed daily',
    impact: 'Draft-board market pricing thins out; affected players show no MKT line rather than a guessed one.',
  },
  {
    id: 'players',
    label: 'Player list',
    severity: 'important',
    measure: 'attempt',
    cadence: 'Synced daily',
    impact: 'A player who signed or changed team recently may be unknown to every screen.',
  },
  {
    id: 'schedule',
    label: 'NFL schedule',
    severity: 'important',
    measure: 'attempt',
    cadence: 'Checked daily',
    impact: 'Byes and future opponents come from the last stored fixture list.',
  },
  {
    id: 'nflverse',
    label: 'Snaps and depth charts',
    severity: 'background',
    measure: 'attempt',
    cadence: 'Checked daily',
    impact: 'The evaluation report ages. No live recommendation reads it.',
  },
  {
    id: 'trending',
    label: 'Trending adds',
    severity: 'background',
    measure: 'data',
    cadence: 'Captured daily',
    impact: 'Day-over-day waiver momentum is unavailable; prices are set without it.',
  },
  {
    id: 'newsletter',
    label: 'Newsletter tally',
    severity: 'background',
    measure: 'data',
    cadence: 'On delivery',
    impact: 'Player tallies stop moving; the draft nudge they feed goes quiet.',
  },
  {
    id: 'manager-intel',
    label: 'Manager tendencies',
    severity: 'background',
    measure: 'attempt',
    cadence: 'Daily, on whatever refresh budget is left',
    impact: 'Next% and trade fit lean on a thinner history. Deferring this is deliberate, not a fault.',
  },
] as const;

const BY_ID = new Map(SOURCE_POLICIES.map((p) => [p.id, p]));

export function policyFor(id: SourceId): SourcePolicy {
  const found = BY_ID.get(id);
  /* Unreachable by construction: `SourceId` is the map's own key set. */
  if (!found) throw new Error(`no freshness policy for ${id}`);
  return found;
}

/**
 * Age against a window, and nothing else.
 *
 * Deliberately tiny and deliberately the only place the comparison happens. The
 * three answers it can give are the three the boundary tests pin: inside the
 * window is `current`, exactly on it is `current` — a window of 36 hours means
 * 36 hours is still fine, and an exclusive boundary would make the last minute
 * of every window a lie — and past it is `stale`. No window means the source
 * does not age, and unknown age stays unknown.
 */
export function classifyAge(ageMinutes: number | null, freshWithinMinutes: number | null): SourceState {
  if (ageMinutes == null) return 'unknown';
  if (freshWithinMinutes == null) return 'current';
  return ageMinutes <= freshWithinMinutes ? 'current' : 'stale';
}

/**
 * One finished row, from a policy and a settled state.
 *
 * Shared by the deployment, which *measures* the state from what the pipelines
 * recorded, and by Demo Mode, which *declares* it because a scenario is a
 * declaration of the world. That is the only difference between the two, and
 * having one function build the row is what stops it becoming two: §15 asks for
 * no alternate fake health engine, and this is where that promise is kept.
 *
 * The note rule is here rather than at either call site because it is a
 * presentation decision and there is only one presentation. A `current` source
 * says `Current · 2h ago` and stops — twelve rows each carrying a sentence is a
 * wall of text nobody reads, and the one that matters then looks like all the
 * others. A `stale` source with nothing else to say falls back to the policy's
 * own impact sentence, which is what a reader actually needs: not that it is
 * old, but what being old costs.
 */
export function sourceHealth(
  policy: SourcePolicy,
  state: SourceState,
  reading: {
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    ageMinutes: number | null;
    freshWithinMinutes: number | null;
    note?: string | null;
  },
): SourceHealth {
  return {
    id: policy.id,
    label: policy.label,
    severity: policy.severity,
    state,
    lastSuccessAt: reading.lastSuccessAt,
    lastAttemptAt: reading.lastAttemptAt,
    ageMinutes: reading.ageMinutes,
    measure: policy.measure,
    cadence: policy.cadence,
    freshWithinMinutes: reading.freshWithinMinutes,
    note:
      state === 'current'
        ? null
        : boundedNote(state === 'stale' ? (reading.note ?? policy.impact) : reading.note),
    technical: { lastOutcome: null, consecutiveFailures: 0, failingSince: null, note: null },
  };
}
