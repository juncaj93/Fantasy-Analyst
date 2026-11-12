/**
 * The in-season Players tab (Round 24, behind `PLAYERS_INSEASON`): each
 * player's rest-of-season value, whether he is a trade target and how likely
 * his owner is to deal, whether he is out and when he is back, and the card's
 * next four weeks and last five games.
 *
 * Nothing here is a new model. The value is `restOfSeason.ts` (the trade and
 * waiver number), the lineup is the trade tools' solver, "trades often" is
 * `activity.ts`, and "out this week" is `weekAvailability.ts`. This file only
 * puts them side by side for one list.
 *
 * Pure.
 */

import { isOutThisWeek } from '../injury/weekAvailability.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import type { PlayerRate } from '../tradeValue/rate.ts';
import type { TradeHorizon } from '../tradeValue/weeks.ts';
import { isRareTrader, type ActivityClass } from '../trades/activity.ts';
import { perWeekValue, seasonWeights } from '../value/restOfSeason.ts';
import type { SeasonInjuryRead, SeasonTradeRead, SeasonWeekCell, Willingness } from './seasonWire.ts';

export const PLAYERS_INSEASON = {
  /** Another team's player is a trade target when Alex's best lineup gains at least this many points a week with him. */
  targetGain: 1,
  /** An owner needs one of Alex's spare players when it lifts his best lineup at least this much a week. */
  needGain: 1,
  /** Weeks on the card, this one first. */
  nextWeeks: 4,
  /** Games on the card. */
  lastGames: 5,
} as const;

/** Positions nobody trades for. */
const NOT_TRADED = new Set(['DEF', 'K']);

export interface BoardRoster {
  rosterId: number;
  isMine: boolean;
  playerIds: readonly string[];
  /** The trade finder's own read of how often he trades. */
  activity: ActivityClass;
  /** Trades with Alex this season. */
  tradedWithYou: number;
}

/** Rest-of-season value: his rate times the share of the weighted weeks he plays (`perWeekValue`). */
export function seasonValue(rate: PlayerRate | undefined, horizon: Pick<TradeHorizon, 'weeks' | 'playoffWeeks'>): number | null {
  if (!rate || rate.rate == null || horizon.weeks.length === 0) return null;
  return perWeekValue(rate.rate, rate.weekly, seasonWeights(horizon));
}

/**
 * Out this week, by Team's rule (Doubtful counts as Out), or held in an IR
 * slot; and the first later week he is expected to play. Null when he plays.
 */
export function injuryRead(rate: PlayerRate | undefined, horizon: Pick<TradeHorizon, 'weeks'>): SeasonInjuryRead | null {
  if (!rate) return null;
  if (!isOutThisWeek(rate.designation) && !rate.onReserve) return null;
  let backWeek: number | null = null;
  for (let k = 1; k < horizon.weeks.length; k++) {
    if ((rate.weekly[k] ?? 0) > 0) {
      backWeek = horizon.weeks[k]!;
      break;
    }
  }
  return { out: true, backWeek };
}

/**
 * How likely the owner is to deal: Alex's best partners trade often and need
 * his players (his rule). A manager on record as almost never trading is
 * Unlikely whatever he needs.
 */
export function willingnessOf(args: { activity: ActivityClass; tradedWithYou: number; needsYours: boolean }): Willingness {
  if (isRareTrader(args.activity)) return 'Unlikely';
  const tradesOften = args.activity === 'active' || args.activity === 'selective' || args.tradedWithYou > 0;
  if (tradesOften && args.needsYours) return 'Likely';
  if (tradesOften || args.needsYours) return 'Maybe';
  return 'Unlikely';
}

interface Lineup {
  total: number;
  /** Ids in the lineup, with the slot each holds. */
  slotOf: Map<string, string>;
}

function lineupOf(slots: readonly LineupSlotSpec[], candidates: readonly LineupCandidate[]): Lineup {
  const best = bestLineup(slots, candidates);
  const slotOf = new Map<string, string>();
  best.picks.forEach((pick, i) => {
    if (pick) slotOf.set(pick.id, slots[i]!.key);
  });
  return { total: best.total, slotOf };
}

/**
 * Trade targets and how likely each owner is to deal, for every player on
 * another team. A target is a player who would start for Alex: his best
 * lineup (rest-of-season values, byes and injuries counted) gains at least
 * {@link PLAYERS_INSEASON.targetGain} points a week with him added. That is
 * "helps his starters" and "fills a weak spot" in one measure: a weak spot is
 * exactly where a new player gains the most.
 */
export function tradeTargets(args: {
  horizon: Pick<TradeHorizon, 'weeks' | 'playoffWeeks'>;
  shape: RosterShape;
  rates: ReadonlyMap<string, PlayerRate>;
  rosters: readonly BoardRoster[];
}): Map<string, SeasonTradeRead> {
  const out = new Map<string, SeasonTradeRead>();
  const mine = args.rosters.find((r) => r.isMine);
  if (!mine || args.horizon.weeks.length === 0) return out;
  const slots = slotsOf(args.shape);
  const candidate = (id: string): LineupCandidate | null => {
    const rate = args.rates.get(id);
    const value = seasonValue(rate, args.horizon);
    return rate && value != null ? { id, position: rate.position, value } : null;
  };
  const candidatesOf = (ids: readonly string[]) => ids.map(candidate).filter((c): c is LineupCandidate => c != null);

  const myCandidates = candidatesOf(mine.playerIds);
  const myLineup = lineupOf(slots, myCandidates);
  /* Alex's spare players: on his roster, not in his best lineup. What an owner could want from him. */
  const spare = myCandidates.filter((c) => !myLineup.slotOf.has(c.id) && !NOT_TRADED.has(c.position));

  for (const roster of args.rosters) {
    if (roster.isMine) continue;
    const theirs = candidatesOf(roster.playerIds);
    const theirLineup = lineupOf(slots, theirs);
    const needsYours = spare.some((c) => lineupOf(slots, [...theirs, c]).total - theirLineup.total >= PLAYERS_INSEASON.needGain);
    const willingness = willingnessOf({ activity: roster.activity, tradedWithYou: roster.tradedWithYou, needsYours });
    for (const player of theirs) {
      if (NOT_TRADED.has(player.position)) continue;
      const withHim = lineupOf(slots, [...myCandidates, player]);
      const gain = round1(withHim.total - myLineup.total);
      if (gain < PLAYERS_INSEASON.targetGain) continue;
      const slot = withHim.slotOf.get(player.id) ?? player.position;
      /* The starter he pushes out of Alex's lineup: the direct comparison on the card. */
      const bumped = myCandidates.find((c) => myLineup.slotOf.has(c.id) && !withHim.slotOf.has(c.id)) ?? null;
      const over = bumped ? (args.rates.get(bumped.id)?.name ?? null) : null;
      out.set(player.id, {
        gain,
        slot,
        willingness,
        overId: bumped?.id ?? null,
        over,
        overValue: bumped ? round1(bumped.value) : null,
        reason: over ? `Starts at ${slot} over ${over}, +${gain.toFixed(1)} a week` : `Starts at ${slot} for you, +${gain.toFixed(1)} a week`,
      });
    }
  }
  return out;
}

/**
 * The card's next weeks, this one first, byes marked. This week is the
 * number Team and Compare show; later weeks are Sleeper's stored projections
 * in this league's scoring, so they carry the Sleeper mark.
 */
export function nextWeeks(args: {
  weeks: readonly number[];
  byeWeek: number | null;
  thisWeek: { points: number | null; sleeper: boolean; out: boolean };
  ahead: ReadonlyMap<number, number>;
  count?: number;
}): SeasonWeekCell[] {
  return args.weeks.slice(0, args.count ?? PLAYERS_INSEASON.nextWeeks).map((week, i) => {
    if (week === args.byeWeek) return { week, bye: true, points: null, sleeper: false, out: false };
    if (i === 0) return { week, bye: false, ...args.thisWeek };
    const points = args.ahead.get(week);
    return { week, bye: false, points: points == null ? null : round1(points), sleeper: points != null, out: false };
  });
}

/**
 * His last games played, oldest first, with their weeks. The same rule as the
 * season average (`productionGames` in `restOfSeason.ts`): a week counts when
 * the usage store has him on the field or the league scored him.
 */
export function lastGames(args: {
  leaguePoints: readonly number[] | null | undefined;
  through: number;
  playedWeeks: ReadonlySet<number>;
  count?: number;
}): { week: number; points: number }[] {
  const points = args.leaguePoints;
  if (!points || args.through < 1) return [];
  const out: { week: number; points: number }[] = [];
  for (let week = 1; week <= args.through; week++) {
    const value = points[week - 1];
    const scored = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (scored !== 0 || args.playedWeeks.has(week)) out.push({ week, points: round1(scored) });
  }
  return out.slice(-(args.count ?? PLAYERS_INSEASON.lastGames));
}

function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}
