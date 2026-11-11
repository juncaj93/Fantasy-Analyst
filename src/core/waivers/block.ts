/**
 * Block a rival's pickup: claim a free agent your opponent this week needs.
 *
 * Alex's rule for when (review W5 and decision D7, 5 November 2026), all of it:
 *
 *  - **Only this week's opponent.** Nobody else in the league is a rival for
 *    this. The pairing is the stored matchup row's (`matchup_forecasts`), so
 *    no request is made to find it; with no row there is no block.
 *  - **He clearly needs the position, and the free agent would start for
 *    him.** Measured on the opponent's own best lineup this week: adding the
 *    free agent has to raise it by at least the toss-up bar
 *    ({@link TOSSUP_POINTS}, 2 points). That happens in exactly two ways: a
 *    starter of his is Out, Doubtful, on IR or on bye and his bench cannot
 *    cover it, or his starter there is weak and the free agent beats him by a
 *    real margin. Under the bar it is a coin flip for him, and no block.
 *  - **It costs Alex no starter.** The roster spot is an open bench spot or a
 *    drop-ready player nobody else on the screen is using. Never anyone who
 *    plays.
 *  - **A small bid.** $1 to {@link BLOCK_RULES.maxBid}, and never below the
 *    $20 playoff reserve (`playoffReserve`): when the reserve leaves less than
 *    a dollar to spend, no block. A free agent needs no bid at all.
 *
 * Both sides are read on one basis: Sleeper's published number for this week,
 * which the waiver screen already holds for every rostered player and the
 * scanned wire, with the shared availability rule on top (Doubtful and Out are
 * zero, `weekAvailability.ts`). The Sleeper-only discount would take the same points
 * off both sides here, so it changes nothing and is not applied.
 *
 * Pure. Nothing here transacts: the line is advice to act on in Sleeper.
 */

import type { Designation } from '../injury/model.ts';
import { availableWeekPoints, isOutThisWeek } from '../injury/weekAvailability.ts';
import { TOSSUP_POINTS } from '../startsit/tossup.ts';
import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';

export const BLOCK_RULES = {
  /** The most a block may bid (Alex, 5 November 2026). */
  maxBid: 3,
  /** The least a claim can bid and still beat a $0 claim. */
  minBid: 1,
  /** He must start for the opponent by at least the toss-up bar. */
  margin: TOSSUP_POINTS,
} as const;

/** One player as the block reads him: this week only. */
export interface BlockPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Sleeper's published number for this week, healthy. Null: none published. */
  points: number | null;
  /** The shared designation (the worse of Sleeper's and the injury report's where both were read). */
  designation: Designation;
  /** His club has no game this week. */
  onBye: boolean;
  /** In an injured-reserve slot: never in a lineup. */
  onReserve?: boolean;
}

export interface BlockCandidate extends BlockPlayer {
  /** Can be in a lineup before his own game this week: not kicked off, and clears in time. */
  addable: boolean;
  /** A free agent now (first come), rather than on waivers. */
  free: boolean;
}

/** How Alex makes room without cutting anyone who plays. */
export type BlockRoom = { kind: 'open' } | { kind: 'drop'; playerId: string; name: string };

export interface BlockRequest {
  shape: RosterShape;
  /** This week's opponent and his whole roster. Null: no stored pairing, or a bye week. */
  opponent: { rosterId: number; roster: readonly BlockPlayer[] } | null;
  candidates: readonly BlockCandidate[];
  /** Free agents already on another line (a pickup, the stash): never also a block. */
  taken: ReadonlySet<string>;
  /** Positions another planner owns (defence): never a block. */
  excludedPositions: ReadonlySet<string>;
  /** The spots Alex can use, best first. Empty: no block. */
  room: readonly BlockRoom[];
  /** What a bid may spend now: FAAB left less the playoff reserve. Null: unknown. */
  spendable: number | null;
  /** False in a league that does not bid. */
  usesFaab: boolean;
}

export interface BlockLine {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** `opponent needs a WR`: the line's one reason. */
  reason: string;
  /** Why he needs one, for the audit: `his WR Puka Nacua is on bye`. Not drawn. */
  detail: string;
  /** Points the free agent adds to the opponent's best lineup this week. Not drawn. */
  gain: number;
  bid: { kind: 'free' } | { kind: 'none' } | { kind: 'claim'; low: number; high: number };
  room: BlockRoom;
}

/**
 * The one free agent worth blocking this week, or null. The largest gain to
 * the opponent's lineup wins; ties go to the name.
 */
export function blockPickup(request: BlockRequest): BlockLine | null {
  const opponent = request.opponent;
  if (!opponent) return null;
  const room = request.room[0];
  if (!room) return null;
  const bid = blockBid(request);
  if (!bid) return null;

  /* The skill slots only: the defence is its own planner's. */
  const slots = slotsOf(request.shape).filter((s) => [...s.eligible].some((p) => !request.excludedPositions.has(p)));
  const lineupPlayers = opponent.roster.filter((p) => !p.onReserve && !request.excludedPositions.has(p.position));
  const before = bestLineup(slots, lineupPlayers.map(asCandidate));

  let best: { c: BlockCandidate; gain: number } | null = null;
  for (const c of request.candidates) {
    if (request.taken.has(c.playerId) || request.excludedPositions.has(c.position)) continue;
    if (!c.addable || c.onBye || isOutThisWeek(c.designation) || !(weekPoints(c) > 0)) continue;
    const after = bestLineup(slots, [...lineupPlayers.map(asCandidate), asCandidate(c)]);
    if (!after.picks.some((x) => x?.id === c.playerId)) continue;
    const gain = round2(after.total - before.total);
    if (gain < BLOCK_RULES.margin) continue;
    if (!best || gain > best.gain || (gain === best.gain && c.name.localeCompare(best.c.name) < 0)) best = { c, gain };
  }
  if (!best) return null;

  const { c, gain } = best;
  return {
    playerId: c.playerId,
    name: c.name,
    position: c.position,
    team: c.team,
    reason: `opponent needs a ${c.position}`,
    detail: needDetail(c, opponent.roster, slots, lineupPlayers, before.picks),
    gain,
    bid: c.free ? { kind: 'free' } : bid,
    room,
  };
}

/** $1 to $3, never into the playoff reserve. Null when the reserve leaves nothing to bid. */
function blockBid(request: BlockRequest): BlockLine['bid'] | null {
  if (!request.usesFaab) return { kind: 'none' };
  if (request.spendable == null) return null;
  const high = Math.min(BLOCK_RULES.maxBid, Math.floor(request.spendable));
  if (high < BLOCK_RULES.minBid) return null;
  return { kind: 'claim', low: BLOCK_RULES.minBid, high };
}

/** His number this week after the shared availability rule; a bye is no game. */
function weekPoints(p: BlockPlayer): number {
  if (p.onBye || p.points == null) return 0;
  return availableWeekPoints(p.points, p.designation);
}

function asCandidate(p: BlockPlayer): LineupCandidate {
  return { id: p.playerId, position: p.position, value: weekPoints(p) };
}

/**
 * The opponent's reason, in words: the usual starter at the free agent's
 * position who cannot play this week, else the weak one he would replace.
 * Usual starter means his best lineup with everyone healthy and no byes.
 */
function needDetail(
  c: BlockCandidate,
  roster: readonly BlockPlayer[],
  slots: readonly LineupSlotSpec[],
  lineupPlayers: readonly BlockPlayer[],
  picks: readonly (LineupCandidate | null)[],
): string {
  const healthy = bestLineup(
    slots,
    lineupPlayers.map((p) => ({ id: p.playerId, position: p.position, value: Math.max(0, p.points ?? 0) })),
  );
  const usual = healthy.picks.filter((x): x is LineupCandidate => x != null && x.position === c.position).map((x) => x.id);
  const missing = roster.find((p) => usual.includes(p.playerId) && (p.onBye || isOutThisWeek(p.designation)));
  if (missing) {
    const why = missing.onBye ? 'is on bye' : `is ${designationWord(missing.designation)}`;
    return `his ${c.position} ${missing.name} ${why}`;
  }
  const weakest = picks
    .filter((x): x is LineupCandidate => x != null && x.position === c.position)
    .sort((a, b) => a.value - b.value)[0];
  const name = weakest ? roster.find((p) => p.playerId === weakest.id)?.name : null;
  return name ? `his ${c.position} ${name} is weak this week` : `no ${c.position} to start this week`;
}

function designationWord(d: Designation): string {
  switch (d) {
    case 'ir':
      return 'on IR';
    case 'pup':
      return 'on PUP';
    case 'doubtful':
      return 'Doubtful';
    case 'suspended':
      return 'suspended';
    default:
      return 'Out';
  }
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
