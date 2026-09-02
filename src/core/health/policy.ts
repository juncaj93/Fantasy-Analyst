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
  | 'roster'
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
 * The two UTC clocks the Vegas refresh actually runs on.
 *
 * Saturday 23:00 and Sunday 15:00, which is what `wrangler.toml` registers and
 * what `docs/VEGAS.md` §"The budget" commits to. The cadence is deliberately
 * weekend-only: a weekday refresh would buy entities against a 2,500-a-month
 * allowance to price games nobody's lineup is locked into yet.
 *
 * Named here rather than derived from the cron strings because a cron parser is
 * a great deal of machinery for two instants that have not moved in a year, and
 * because the numbers are checked against `CRON_LABELS` by the freshness suite.
 */
export const VEGAS_REFRESH_CLOCKS: readonly { readonly day: number; readonly hour: number }[] = [
  { day: 6, hour: 23 },
  { day: 0, hour: 15 },
] as const;

/**
 * How long after a scheduled clock its run has to actually land.
 *
 * A run fires at 15:00 and stores at 15:02, and for those two minutes the
 * newest thing in the database is last night's. Without a grace period the row
 * would flick to `stale` at the top of every clock and back again a moment
 * later, which is a screen crying wolf twice a week at the exact hours somebody
 * is looking at it. Ninety minutes is the same figure `core/vegas/budget.ts`
 * uses for a near-kickoff TTL, and it is long enough to cover a run that had to
 * retry.
 */
export const VEGAS_REFRESH_GRACE_MINUTES = 90;

/**
 * Minutes since the most recent scheduled Vegas refresh should have fired.
 *
 * Walks back at most a week from `now`, which is more than enough: both clocks
 * appear in any seven-day window, so the search always finds one.
 */
export function minutesSinceLastVegasClock(now: Date): number {
  let best = -Infinity;
  for (const clock of VEGAS_REFRESH_CLOCKS) {
    for (let back = 0; back <= 7; back++) {
      const at = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - back,
        clock.hour,
        0,
        0,
      );
      if (new Date(at).getUTCDay() !== clock.day) continue;
      if (at <= now.getTime() && at > best) best = at;
    }
  }
  return Math.floor((now.getTime() - best) / 60_000);
}

/**
 * How old the stored lines may be before the *schedule* is the story.
 *
 * The window this replaced was a flat 36 hours, and it was measuring the wrong
 * thing. Nothing refreshes the market between Sunday afternoon and the
 * following Saturday night — that is the design, and it is what protects the
 * monthly allowance — so a flat day-and-a-half window reported the market as
 * stale from about Tuesday morning until Saturday night, roughly four and a
 * half days of every week, in season and out. Vegas is `critical`, so it took
 * the headline with it: a screen that says two inputs need attention every
 * Wednesday is a screen that has taught its reader to close it.
 *
 * The honest question for a feed on a weekend cadence is not *how old are these
 * lines* but *did the last scheduled refresh land*. So the window stretches to
 * cover the gap the cadence itself creates, and no further: lines newer than
 * the most recent clock are current, and lines older than it are stale, because
 * a refresh was due and they are not the result of it.
 *
 * `floorMinutes` keeps the caller's own flat rule as a lower bound, so this can
 * only ever be *more* patient than the rule Setup prints and never less — the
 * two screens can never be made to disagree about a market Setup calls stale.
 */
export function vegasFreshWithinMinutes(now: Date, floorMinutes: number): number {
  return Math.max(floorMinutes, minutesSinceLastVegasClock(now)) + VEGAS_REFRESH_GRACE_MINUTES;
}

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
  /*
   * First, because it is the subject every other row is about.
   *
   * It was absent from this list entirely until a defence claimed off waivers
   * failed to appear on the Team page for two days. Nothing was broken in the
   * roster path; nothing had *read* it. `syncLeague` was reachable from
   * selecting a league, from a pull down the Team or Waivers screen, and from
   * the one-shot post-draft adoption — and from no clock at all, so a roster
   * that changed in Sleeper stayed wrong in this app until somebody happened to
   * pull. Meanwhile this screen reported eleven feeds as Current and said
   * nothing about the one fact all eleven are describing, which is how a stale
   * roster came to look like healthy data.
   *
   * `attempt` rather than `data`: Sleeper always answers, so what is worth
   * measuring is when this app last asked. A roster that came back identical is
   * a successful read and not a stale one.
   */
  {
    id: 'roster',
    label: 'Your roster',
    severity: 'critical',
    measure: 'attempt',
    cadence: 'Synced daily, and on every pull to refresh',
    impact:
      'Adds, drops and waiver claims made in Sleeper are missing, so every screen is reasoning about a squad you no longer have.',
  },
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
