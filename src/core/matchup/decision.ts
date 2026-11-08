/**
 * Who takes a starting slot that is a real hole, for the one Matchup line that
 * says so (5 November 2026).
 *
 * Until this date this module searched every one-for-one change for the one
 * that most raised the win chance, with its own 2% win-chance bar and its own
 * favorite and underdog reasoning ("you are behind, and X has the wider
 * range"). No screen drew it: the Matchup screen recommends nothing since
 * October 2026, and Team's Best move is the one place the app says who to
 * start. It was a second start/sit rule with a second bar and a second
 * Floor/Ceiling, so it is gone (Alex's decision, review S3: one mode, one
 * toss-up bar, one decision function). Floor and Ceiling now pick a toss-up's
 * lean on Team and Compare (`core/startsit/tossup.ts`), and nowhere else.
 *
 * What is left is the fact the Live insights sheet needs when a starter is
 * Out, Doubtful, on IR or on a bye and still in the lineup: who takes the
 * slot, chosen by the shared ranking rule Team uses (`rankingNumber`, a
 * Sleeper-only number two points lower), and what that is worth to the win
 * chance. A real hole is never a toss-up, so no bar applies. Advisory only:
 * nothing here sets a lineup.
 */

import { winProbabilityWithSwap, type SimulationResult } from './simulate.ts';
import type { PlayerDistribution } from './distribution.ts';
import type { MatchupPlayerInput } from './types.ts';
import { rankingNumber } from '../startsit/decisionPoints.ts';

/** A real hole in the lineup, and the bench player Team's rule puts in it. */
export interface HoleFill {
  slot: string;
  /** The starter who is out, on IR, Doubtful or on a bye. */
  outPlayerId: string;
  outName: string;
  inPlayerId: string;
  inName: string;
  /** Win probability with the hole left in. */
  winNow: number;
  /** Win probability with the slot filled. */
  winAfter: number;
  /** The difference. */
  gain: number;
}

export interface LineupDecision {
  /** One fill per hole that a bench player can legally take, biggest win-chance gain first. */
  fills: HoleFill[];
  /** How many bench players were legal candidates at all. */
  considered: number;
  /** Why nothing is filled, when nothing is. */
  note: string | null;
}

export interface SlotSpec {
  /**
   * Which of this league's starting slots this is, uniquely.
   *
   * A league with two running-back slots has two rows labelled `RB`, and a
   * player belongs to one of them rather than to both — so the identity is the
   * key and the label is only what gets printed. See `slotKey` in `model.ts`.
   */
  key: string;
  /** The label: `RB`, `FLEX`, `SUPER_FLEX`. */
  slot: string;
  accepts: string[];
}

/** Whether a starter is a real hole: nothing to score this week. */
function isHole(player: MatchupPlayerInput): boolean {
  return player.ruledOut || player.onBye === true;
}

/**
 * The bench player for each hole in Alex's lineup whose game has not started.
 *
 * Movability is read off the game clock, not off `locked`: a ruled-out player's
 * distribution is "locked" because nothing about him can change, and he is
 * exactly the starter this exists to replace.
 */
export function assessLineupDecision(opts: {
  result: SimulationResult;
  players: MatchupPlayerInput[];
  distributions: PlayerDistribution[];
  slots: SlotSpec[];
}): LineupDecision {
  const distributionById = new Map(opts.distributions.map((d) => [d.playerId, d]));
  const winNow = opts.result.winProbability;
  const notKickedOff = (playerId: string) => distributionById.get(playerId)?.phase === 'not_started';

  const mine = opts.players.filter((p) => p.side === 'mine');
  const holes = mine.filter((p) => p.starting && isHole(p) && notKickedOff(p.playerId));
  const bench = mine.filter(
    (p) => !p.starting && notKickedOff(p.playerId) && !isHole(p) && p.projection != null,
  );

  const used = new Set<string>();
  const fills: HoleFill[] = [];
  /*
   * The lineup as the fills so far leave it. A bench player can take a hole
   * directly or with the other starters moving between slots that take them
   * (round 13): an Out back in RB is filled by a bench receiver when the FLEX
   * back slides to RB, which is the move Team names. A starter whose game has
   * kicked off keeps his slot.
   */
  const lineup = mine.filter((p) => p.starting);
  for (const starter of holes) {
    const slot = opts.slots.find((s) => s.key === starter.slot);
    if (!slot) continue;
    const best = bench
      .filter((c) => !used.has(c.playerId) && canTakeHole(lineup, starter, c, opts.slots, notKickedOff))
      .sort((a, b) => rankedPoints(b) - rankedPoints(a) || a.name.localeCompare(b.name))[0];
    if (!best) continue;
    used.add(best.playerId);
    lineup.splice(lineup.indexOf(starter), 1, best);
    const winAfter = winProbabilityWithSwap(opts.result, starter.playerId, best.playerId);
    fills.push({
      slot: slot.slot,
      outPlayerId: starter.playerId,
      outName: starter.name,
      inPlayerId: best.playerId,
      inName: best.name,
      winNow: round4(winNow),
      winAfter: round4(winAfter),
      gain: round4(winAfter - winNow),
    });
  }
  fills.sort((a, b) => b.gain - a.gain || a.inName.localeCompare(b.inName));

  return {
    fills,
    considered: bench.length,
    note:
      fills.length > 0
        ? null
        : holes.length === 0
          ? 'Every starter still to play has a game this week.'
          : 'Nobody on your bench could legally take the slot.',
  };
}

/**
 * Whether `candidate` can replace `hole` with every other starter still
 * seated: kicked-off starters in their own slots, the rest anywhere their
 * position is accepted (augmenting paths, as `lineup.ts` seats a lineup).
 */
function canTakeHole(
  lineup: readonly MatchupPlayerInput[],
  hole: MatchupPlayerInput,
  candidate: MatchupPlayerInput,
  slots: readonly SlotSpec[],
  notKickedOff: (playerId: string) => boolean,
): boolean {
  const after = [...lineup.filter((p) => p.playerId !== hole.playerId), candidate];
  const fixed = new Set<string>();
  const movable: MatchupPlayerInput[] = [];
  for (const p of after) {
    if (p !== candidate && p.slot != null && !notKickedOff(p.playerId) && slots.some((s) => s.key === p.slot)) fixed.add(p.slot);
    else movable.push(p);
  }
  const open = slots.filter((s) => !fixed.has(s.key));
  const bySlot = new Map<number, MatchupPlayerInput>();
  const place = (p: MatchupPlayerInput, seen: Set<number>): boolean => {
    for (let i = 0; i < open.length; i++) {
      if (seen.has(i) || !open[i]!.accepts.includes(p.position)) continue;
      seen.add(i);
      const holder = bySlot.get(i);
      if (!holder || place(holder, seen)) {
        bySlot.set(i, p);
        return true;
      }
    }
    return false;
  };
  return movable.every((p) => place(p, new Set<number>()));
}

/** The shared ranking rule (`rankingNumber`), the one `lineup.ts` ranks with. */
function rankedPoints(player: MatchupPlayerInput): number {
  return rankingNumber(player.projection ?? 0, player.projectionBorrowed === true);
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
