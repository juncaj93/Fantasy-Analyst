/**
 * When the odds job looks, derived from the stored NFL schedule.
 *
 * The weekly refresh used to run on two fixed clocks, Saturday 23:00 and Sunday
 * 15:00 UTC. That is the right shape for a Sunday slate and has nothing for a
 * Thursday night, a Monday night, a Saturday or Wednesday holiday game, or a
 * game the league flexes into another slot. Alex noticed it as lines updating
 * on Sunday and not on Monday.
 *
 * Nothing in this file knows what day of the week it is. A game's checkpoints
 * are counted back from its own stored kickoff, so every one of those cases is
 * the same case: a kickoff, and the hours before it.
 *
 * ## Two different things, kept apart
 *
 * **Checkpoints** are the instants the job is allowed to look at a game at all.
 * **Staleness** (`manualRefreshThresholdMinutes`, the table #326 gave a person's
 * tap) is how old a game's lines must be before looking turns into buying. A
 * pass that arrives with nothing stale costs nothing.
 *
 * Applying the staleness table on its own, continuously, would be wrong. It
 * says a line two hours from kickoff is worth re-buying every fifteen minutes;
 * run on a five-minute tick that is about fifty purchases per game per week, a
 * little over 2,300 entities a month for a roster of nine, against an
 * allowance of 2,500 that a person's own taps also draw on. Checkpoints are
 * what turn "may be re-bought" into "is looked at six times", which is about
 * 55 entities a week.
 *
 * ## Catching up, not firing
 *
 * A game is due when a checkpoint has passed since its lines were last bought.
 * There is no per-checkpoint "did it run" flag to lose, so a tick the platform
 * skipped, a deploy mid-pass or a flex that moved the kickoff all heal on the
 * next pass: the question is always "is the newest checkpoint newer than my
 * newest line", answered from the two timestamps.
 *
 * Pure: no clock, no database, no provider. The service in
 * `server/services/vegasKickoffClock.ts` supplies the facts.
 */

import { manualRefreshThresholdMinutes } from './staleness.ts';

/**
 * Hours before kickoff at which a game is looked at.
 *
 * Chosen against what a lineup decision needs, then checked against the
 * staleness table so each one lands in a different row of it:
 *
 *   48   the week's board is up and the first look is worth having  (6 h row)
 *   24   the day before                                            (1 h row)
 *    6   the morning of a one o'clock game                         (1 h row)
 *    3   after the early-week injury noise settles                 (1 h row)
 *   1.5  when inactives are announced                             (15 min row)
 *    0.5 the last look before the lineup locks                    (15 min row)
 *
 * Six looks, so six entities per game per week at most. A night checkpoint is
 * not removed for being at night: lines move little then and the entity is
 * still only spent if the game's lines are stale.
 */
export const KICKOFF_CHECKPOINT_HOURS: readonly number[] = [48, 24, 6, 3, 1.5, 0.5];

/** The platform tick the job rides, which sets how late a checkpoint can fire. */
export const CLOCK_TICK_MINUTES = 5;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TICK_MS = CLOCK_TICK_MINUTES * MINUTE_MS;

/** The most the gate sleeps for, so a wrong guess about the schedule heals. */
export const CLOCK_MAX_SLEEP_MINUTES = 6 * 60;

const toMs = (value: string | number | null | undefined): number => {
  if (value == null) return NaN;
  return typeof value === 'number' ? value : Date.parse(value);
};

/** A game's checkpoints as instants, earliest first. Empty for an unknown kickoff. */
export function checkpointsFor(kickoff: string | number | null | undefined): number[] {
  const at = toMs(kickoff);
  if (!Number.isFinite(at)) return [];
  return KICKOFF_CHECKPOINT_HOURS.map((hours) => at - hours * HOUR_MS).sort((a, b) => a - b);
}

/** The newest checkpoint that is not in the future, or null if none has come yet. */
export function latestCheckpoint(kickoff: string | number | null | undefined, now: number): number | null {
  let best: number | null = null;
  for (const at of checkpointsFor(kickoff)) {
    if (at <= now && (best == null || at > best)) best = at;
  }
  return best;
}

export type ClockReason =
  | 'never fetched'
  | 'kicked off'
  | 'checkpoint passed since the last fetch'
  | 'checkpoint not reached yet'
  | 'already fetched since the last checkpoint'
  | 'under the staleness wait';

export interface ClockGame {
  /** ISO kickoff. Null when the schedule has not timed this game. */
  kickoff: string | number | null;
  /** When its lines were last bought, or null if they never were. */
  lastFetchedAt: string | number | null;
}

export interface ClockVerdict {
  due: boolean;
  reason: ClockReason;
}

/**
 * Should the job buy this game's lines right now?
 *
 *   - never bought: yes, whatever the checkpoints say (a game with no lines is
 *     the one thing a lineup cannot do without), unless it has already kicked
 *     off, when a line is closed and worth nothing;
 *   - kicked off: no. The lineup is locked and the books have closed;
 *   - a checkpoint has passed since the lines were bought: yes, provided they
 *     are also older than the staleness table's wait for how close the game is;
 *   - otherwise no.
 *
 * An unknown kickoff is treated as far out: it is fetched when never fetched
 * and left alone afterwards, because without a kickoff there is no checkpoint
 * to have passed.
 */
export function gameDueOnClock(game: ClockGame, now: number): ClockVerdict {
  const kickoff = toMs(game.kickoff);
  const known = Number.isFinite(kickoff);
  if (known && kickoff <= now) return { due: false, reason: 'kicked off' };

  const fetchedAt = toMs(game.lastFetchedAt);
  if (!Number.isFinite(fetchedAt)) return { due: true, reason: 'never fetched' };

  const checkpoint = known ? latestCheckpoint(kickoff, now) : null;
  if (checkpoint == null) return { due: false, reason: 'checkpoint not reached yet' };
  if (fetchedAt >= checkpoint) return { due: false, reason: 'already fetched since the last checkpoint' };

  const wait = manualRefreshThresholdMinutes(known ? (kickoff - now) / HOUR_MS : null);
  const ageMinutes = (now - fetchedAt) / MINUTE_MS;
  if (wait != null && ageMinutes < wait) return { due: false, reason: 'under the staleness wait' };
  return { due: true, reason: 'checkpoint passed since the last fetch' };
}

/**
 * The kickoff to trust, when the schedule and the provider disagree.
 *
 * The provider's event row carries the kickoff it had when the game was last
 * bought, and a game the league flexes is moved in the schedule file first. So
 * where a fixture for the same team sits within {@link FLEX_MATCH_DAYS} of the
 * event's kickoff, the schedule's time is the current one. Two cases keep the
 * provider's time:
 *
 *   - the event has already kicked off by its own clock. A game that started is
 *     over for this purpose, and the schedule's next fixture for the team is
 *     next week's game, not this one;
 *   - no stored fixture is that close, which is a team the schedule does not
 *     know or a kickoff it has not timed.
 */
export const FLEX_MATCH_DAYS = 4;

export function reconcileKickoff(
  eventKickoff: string | number | null | undefined,
  fixtureKickoffs: readonly (string | number | null | undefined)[],
  now: number,
): string | null {
  const event = toMs(eventKickoff);
  if (Number.isFinite(event) && event <= now) return new Date(event).toISOString();

  let best: number | null = null;
  for (const raw of fixtureKickoffs) {
    const at = toMs(raw);
    if (!Number.isFinite(at)) continue;
    if (Number.isFinite(event) && Math.abs(at - event) > FLEX_MATCH_DAYS * 24 * HOUR_MS) continue;
    if (!Number.isFinite(event) && at <= now) continue;
    // The nearest to the provider's time when there is one, else the next one.
    const score = Number.isFinite(event) ? Math.abs(at - event) : at;
    const held = best == null ? Infinity : Number.isFinite(event) ? Math.abs(best - event) : best;
    if (score < held) best = at;
  }
  if (best != null) return new Date(best).toISOString();
  return Number.isFinite(event) ? new Date(event).toISOString() : null;
}

/** The tick that first sees an instant: the next five-minute boundary at or after it. */
export function tickFor(at: number): number {
  return Math.ceil(at / TICK_MS) * TICK_MS;
}

/**
 * The first tick after `now` at which some game has a new checkpoint, or null.
 *
 * Only games that have not kicked off are considered. The gate stores this so
 * that the ordinary tick reads one settings row and goes home.
 */
export function nextPassAfter(kickoffs: readonly (string | number | null | undefined)[], now: number): number | null {
  let best: number | null = null;
  for (const raw of kickoffs) {
    const kickoff = toMs(raw);
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;
    for (const at of checkpointsFor(kickoff)) {
      const tick = tickFor(at);
      if (tick > now && (best == null || tick < best)) best = tick;
    }
  }
  return best;
}

/**
 * Has any not-yet-kicked-off game passed a checkpoint since `processedThrough`?
 *
 * `processedThrough` null means "unknown": a first run, or a schedule that just
 * changed, and the answer is yes for any game still to be played. The per-game
 * rule decides what that pass actually buys.
 */
export function checkpointPending(
  kickoffs: readonly (string | number | null | undefined)[],
  processedThrough: string | number | null,
  now: number,
): boolean {
  const since = toMs(processedThrough);
  for (const raw of kickoffs) {
    const kickoff = toMs(raw);
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;
    if (!Number.isFinite(since)) return true;
    for (const at of checkpointsFor(kickoff)) {
      if (at > since && at <= now) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ planning

export interface PlannedPass {
  /** The tick the job fires on, ISO. */
  at: string;
  /** Games with a checkpoint in this tick, by kickoff, with how far out it was. */
  games: { kickoff: string; hoursBefore: number }[];
}

/**
 * The passes the schedule implies between two instants.
 *
 * What the live check prints: given the stored kickoffs, which ticks would do
 * anything. Passes that share a tick are one pass, which is how a one o'clock
 * slate of nine games is a single run rather than nine.
 *
 * It lists every game the league plays, not only the roster's. The roster
 * decides what a pass buys; the schedule decides when a pass happens.
 */
export function plannedPasses(
  kickoffs: readonly (string | number | null | undefined)[],
  from: number,
  to: number,
): PlannedPass[] {
  const byTick = new Map<number, PlannedPass['games']>();
  for (const raw of kickoffs) {
    const kickoff = toMs(raw);
    if (!Number.isFinite(kickoff)) continue;
    for (const hours of KICKOFF_CHECKPOINT_HOURS) {
      const tick = tickFor(kickoff - hours * HOUR_MS);
      if (tick < from || tick > to || tick >= kickoff) continue;
      const list = byTick.get(tick) ?? [];
      list.push({ kickoff: new Date(kickoff).toISOString(), hoursBefore: hours });
      byTick.set(tick, list);
    }
  }
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, games]) => ({ at: new Date(tick).toISOString(), games }));
}

/**
 * The most a week of kickoffs can cost, for the budget arithmetic.
 *
 * One entity per game per checkpoint at the very most, which is only reached if
 * every one of them is stale. `rosterGames` is the games the roster (own,
 * opponent and the waiver tier) spans, because only those are bought.
 */
export function worstCaseWeeklyEntities(rosterGames: number): number {
  return rosterGames * KICKOFF_CHECKPOINT_HOURS.length;
}
