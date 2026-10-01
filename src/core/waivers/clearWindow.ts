/**
 * Whether a free agent is still on waivers, or free to add right now.
 *
 * ## Why this exists
 *
 * Until 1 October 2026 every add on the Waivers screen carried a bid range,
 * as if every free agent were a contested FAAB claim. Most are not. In a
 * Sleeper league a free agent outside the waiver window is an instant add:
 * nobody bids, the first manager to tap him gets him. Only a player still
 * inside the window is contested, and that is the one place a price means
 * anything.
 *
 * ## What Sleeper exposes, checked on 1 October 2026
 *
 * The public API has no per-player "on waivers" flag. Neither the player
 * dictionary nor the league endpoints carry one. So it is computed from three
 * things Sleeper does publish:
 *
 *  - the league's settings: `waiver_type` (2 is FAAB), `waiver_clear_days`
 *    (2 in this league), `waiver_day_of_week` (2, Wednesday) and
 *    `daily_waivers` (0, off);
 *  - the league's transactions: every completed drop, with `status_updated`;
 *  - the player's kickoff this week, which this app already stores.
 *
 * The rules, read off this league's own transaction log rather than assumed:
 *
 *  1. **A dropped player** is on waivers for `waiver_clear_days` days. Minnesota
 *     DEF was dropped Wed 23 Sep 23:36 UTC and the claim for it ran Fri 25 Sep
 *     22:41 UTC, roughly two days later.
 *  2. **A player whose game has kicked off** is on waivers until the weekly run.
 *     Braelon Allen and Ollie Gordon were never dropped by anyone in this
 *     league, yet four managers bid on each of them on Monday and Tuesday and
 *     the claims all ran at the Wednesday run (30 Sep 07:10 UTC). The same run
 *     picked up Woody Marks, dropped on Sunday after his game had started.
 *  3. **The weekly run** is the start of `waiver_day_of_week` in Pacific time,
 *     counting Monday as 0. Observed: Wednesday 30 Sep 07:10 UTC, which is ten
 *     minutes past midnight in Los Angeles.
 *
 * Everyone else is a free agent: add any time, no bid.
 *
 * ## What it gets wrong, on purpose
 *
 * Sleeper's NFL week moves on before the Wednesday run, after which the
 * kickoff this app holds is next week's. In that gap (up to two days before
 * the run) a player whose stored kickoff is after the run is treated as on
 * waivers, because nearly every team played on Sunday or Monday. A player
 * whose team had a bye that week is then shown a bid he does not need. That
 * error costs a claim that clears at the same run; the other error would cost
 * a missed claim on a contested player.
 *
 * A league with no settings this can read gets no state at all, and the
 * screen keeps showing every price exactly as it did before.
 */

export interface WaiverRules {
  /** Days a dropped player stays on waivers. */
  clearDays: number;
  /** Day of the weekly run, Monday = 0. */
  runDay: number;
  /** Whether claims are bid for (FAAB) rather than run by priority. */
  usesFaab: boolean;
}

export type PickupKind = 'waivers' | 'free';

export interface PickupState {
  /** `waivers`: a claim, contested, priced. `free`: an instant add, no bid. */
  state: PickupKind;
  /** Why he is on waivers. Null for a free agent. */
  reason: 'dropped' | 'game_started' | null;
  /** When he clears, ISO. Null for a free agent. */
  until: string | null;
}

/** Sleeper's default when a league carries no value. */
const DEFAULT_CLEAR_DAYS = 2;
/** Wednesday, Monday = 0. */
const DEFAULT_RUN_DAY = 2;
/**
 * How long before the run the stored week may already be next week's. Two
 * days reaches back past Monday night's game, the earliest Sleeper moves on.
 */
const EVE_MS = 48 * 3_600_000;

/**
 * The league's waiver rules, or null when the settings say nothing usable.
 *
 * `daily_waivers` leagues run claims every day, which this does not model;
 * they get null, and so keep every price.
 */
export function waiverRulesOf(settings: Record<string, unknown> | null | undefined): WaiverRules | null {
  if (!settings) return null;
  if (Number(settings['daily_waivers'] ?? 0) !== 0) return null;
  const type = settings['waiver_type'];
  if (type == null) return null;
  const clear = Number(settings['waiver_clear_days'] ?? DEFAULT_CLEAR_DAYS);
  const day = Number(settings['waiver_day_of_week'] ?? DEFAULT_RUN_DAY);
  return {
    clearDays: Number.isFinite(clear) && clear >= 0 ? clear : DEFAULT_CLEAR_DAYS,
    runDay: Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_RUN_DAY,
    usesFaab: Number(type) === 2,
  };
}

/** Hours Los Angeles is behind UTC at this instant: 7 in summer, 8 in winter. */
function pacificOffsetHours(at: Date): number {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(at),
  );
  const diff = (at.getUTCHours() - hour + 24) % 24;
  return diff === 7 || diff === 8 ? diff : 7;
}

/** Midnight Pacific at the start of `runDay`, the next one strictly after `now`. */
export function nextWaiverRun(now: Date, rules: Pick<WaiverRules, 'runDay'>): Date {
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead));
    /* getUTCDay: Sunday = 0. Sleeper: Monday = 0. */
    if ((day.getUTCDay() + 6) % 7 !== rules.runDay) continue;
    const run = new Date(day.getTime() + pacificOffsetHours(day) * 3_600_000);
    if (run.getTime() > now.getTime()) return run;
  }
  /* Unreachable: one of the next eight days is the run day. */
  return new Date(now.getTime() + 7 * 86_400_000);
}

/**
 * One free agent's state at `now`.
 *
 * `droppedAt` is the latest completed drop of him by anyone in this league;
 * `kickoff` is his game this week. Either may be null.
 */
export function pickupStateFor(opts: {
  droppedAt: string | null;
  kickoff: string | null;
  hasTeam: boolean;
  now: Date;
  rules: WaiverRules;
}): PickupState {
  const { now, rules } = opts;
  const nowMs = now.getTime();
  const run = nextWaiverRun(now, rules);

  let until: number | null = null;
  let reason: PickupState['reason'] = null;

  if (opts.droppedAt) {
    const clears = Date.parse(opts.droppedAt) + rules.clearDays * 86_400_000;
    if (Number.isFinite(clears) && clears > nowMs) {
      until = clears;
      reason = 'dropped';
    }
  }

  if (opts.hasTeam) {
    const kickoff = opts.kickoff == null ? NaN : Date.parse(opts.kickoff);
    const kicked = Number.isFinite(kickoff) && kickoff <= nowMs;
    /*
     * The gap between the week moving on and the run: see the module comment.
     * A kickoff after the coming run can only be next week's game, which is
     * what the stored week holds once Sleeper has moved on.
     */
    const eve = run.getTime() - nowMs <= EVE_MS && Number.isFinite(kickoff) && kickoff > run.getTime();
    if (kicked || eve) {
      if (until == null || run.getTime() > until) {
        until = run.getTime();
        reason = 'game_started';
      }
    }
  }

  return until == null
    ? { state: 'free', reason: null, until: null }
    : { state: 'waivers', reason, until: new Date(until).toISOString() };
}
