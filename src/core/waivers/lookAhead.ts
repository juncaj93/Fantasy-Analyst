/**
 * The look-ahead (Round 26, upgrades B and C, behind `WAIVERS_LOOKAHEAD`).
 *
 * One hole rule for two rosters:
 *
 *  - **Alex's, over the next three weeks** ({@link rosterHoles}): a week where
 *    a usual starter cannot play (his bye, an injury the availability table
 *    says is not over, Doubtful or Out) and the bench cannot fill his slot
 *    within the toss-up bar, or a slot nobody on the roster can fill. Each
 *    hole gets the free agent who fills it best ({@link coverPickups}), with
 *    the week in the reason: `covers your Week 12 bye at TE`.
 *  - **This week's opponent** (`block.ts`): the same rule on his week, which
 *    words the block line (`Matty has no TE this week`).
 *
 * A pickup that only helps a slot the roster already fills is never offered:
 * the slot's loss and the free agent's gain both have to clear the toss-up
 * bar. A hole in a later week is covered now only when few free agents could
 * cover it (the tiers' deep-wire rule, review W12): otherwise the claim waits
 * for that week's run, when the same free agents will still be there.
 *
 * "Usual starter" is the best lineup with everybody able to play. Every number
 * is the one the tiers already hold for that week (`aheadWeeks.ts`), times
 * the same availability, so a hole here is a hole there.
 *
 * Pure. Nothing here transacts.
 */

import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import { TOSSUP_POINTS } from '../startsit/tossup.ts';
import { smartBid } from '../faab/smartBid.ts';
import { TIER_RULES } from './tiers.ts';

export const LOOK_AHEAD = {
  /** How many weeks ahead Alex's roster is read. */
  weeks: 3,
  /** A hole costs the lineup at least this, and a cover gains at least this: the toss-up bar. */
  margin: TOSSUP_POINTS,
  /** A later week's hole waits for its own run when this many free agents would cover it about as well. */
  deepWire: TIER_RULES.deepWire,
  /** Cover lines at most. */
  maxCovers: 2,
} as const;

/** One player for one roster, the way the tiers read him. */
export interface AheadPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Healthy points a game. Null: unvalued. */
  rate: number | null;
  /** Availability for each week read, 0 to 1. */
  weekly: readonly number[];
  /** That week's own number, when there is one. */
  weekValues?: readonly (number | null)[];
  byeWeek: number | null;
  designation?: string;
  onReserve?: boolean;
}

export interface AheadCandidate extends AheadPlayer {
  /** Excluded from the plan for another reason (a top trending drop). */
  planExcluded?: string | null;
  /** A free agent now, rather than on waivers. */
  free?: boolean;
}

export interface RosterHole {
  week: number;
  /** Which of the weeks read, 0 first. */
  index: number;
  position: string;
  cause: 'bye' | 'injury' | 'empty';
  /** The usual starter who cannot play. Null for a slot nobody can fill. */
  missing: { playerId: string; name: string } | null;
  /** What it costs the lineup that week. */
  loss: number;
}

export interface HoleRequest {
  shape: RosterShape;
  roster: readonly AheadPlayer[];
  /** The weeks read, oldest first. Each player's `weekly` and `weekValues` line up with these. */
  weeks: readonly number[];
  excludedPositions: ReadonlySet<string>;
}

/** The holes in the weeks read, earliest first. */
export function rosterHoles(request: HoleRequest): RosterHole[] {
  const slots = skillSlots(request.shape, request.excludedPositions);
  const players = request.roster.filter((p) => !p.onReserve && !request.excludedPositions.has(p.position));
  const out: RosterHole[] = [];
  request.weeks.forEach((week, k) => {
    const healthy = bestLineup(slots, players.map((p) => candidate(p, k, false)));
    const actual = bestLineup(slots, players.map((p) => candidate(p, k, true)));
    const seen = new Set<string>();
    for (const pick of healthy.picks) {
      if (!pick) continue;
      const p = players.find((x) => x.playerId === pick.id)!;
      if ((p.weekly[k] ?? 1) > 0) continue;
      /* What putting him back would give the lineup that week: the bench's shortfall at his slot. */
      const restored = bestLineup(slots, players.map((x) => candidate(x, k, x.playerId !== p.playerId)));
      const loss = round2(restored.total - actual.total);
      if (loss < LOOK_AHEAD.margin || seen.has(p.position)) continue;
      seen.add(p.position);
      out.push({
        week,
        index: k,
        position: p.position,
        cause: p.byeWeek === week ? 'bye' : 'injury',
        missing: { playerId: p.playerId, name: p.name },
        loss,
      });
    }
    actual.picks.forEach((pick, i) => {
      if (pick) return;
      const position = [...slots[i]!.eligible][0]!;
      if (seen.has(position)) return;
      seen.add(position);
      out.push({ week, index: k, position, cause: 'empty', missing: null, loss: 0 });
    });
  });
  return out;
}

/** One cover pickup, in Alex's words. */
export interface CoverLine {
  playerId: string;
  name: string;
  position: string;
  team: string;
  week: number;
  /** `covers your Week 12 bye at TE`: the line's one reason. */
  reason: string;
  /** Points he adds to the lineup that week. Not drawn. */
  gain: number;
  bid: { kind: 'free' } | { kind: 'none' } | { kind: 'claim'; low: number; high: number };
  room: { kind: 'open' } | { kind: 'drop'; playerId: string; name: string };
}

export interface CoverRequest extends HoleRequest {
  candidates: readonly AheadCandidate[];
  /** How many leading weeks a claim made now still reaches: 2 while this week's games are ahead, else 1. */
  leadWeeks: number;
  /** Free agents already on another line: never also a cover. */
  taken: ReadonlySet<string>;
  /** Holes a move already on screen fills (`<week>:<position>`): no second pickup for them. */
  covered: ReadonlySet<string>;
  /** The spots Alex can use, best first. Each is used once. */
  room: readonly CoverLine['room'][];
  /** What a bid may spend now: FAAB left less the playoff reserve and the bids above. Null: unknown. */
  spendable: number | null;
  usesFaab: boolean;
}

/** The cover pickups worth making now, earliest hole first, at most {@link LOOK_AHEAD.maxCovers}. */
export function coverPickups(request: CoverRequest): CoverLine[] {
  const slots = skillSlots(request.shape, request.excludedPositions);
  const players = request.roster.filter((p) => !p.onReserve && !request.excludedPositions.has(p.position));
  const taken = new Set(request.taken);
  const room = [...request.room];
  let spendable = request.spendable;
  const out: CoverLine[] = [];
  for (const hole of rosterHoles(request)) {
    if (out.length >= LOOK_AHEAD.maxCovers || room.length === 0) break;
    if (request.covered.has(`${hole.week}:${hole.position}`)) continue;
    const k = hole.index;
    const base = players.map((p) => candidate(p, k, true));
    const before = bestLineup(slots, base).total;
    const gains = request.candidates
      .filter((c) => c.position === hole.position && !c.planExcluded && !taken.has(c.playerId) && !request.excludedPositions.has(c.position))
      .map((c) => {
        const after = bestLineup(slots, [...base, candidate(c, k, true)]);
        return { c, gain: after.picks.some((x) => x?.id === c.playerId) ? round2(after.total - before) : 0 };
      })
      .filter((g) => g.gain >= LOOK_AHEAD.margin)
      .sort((a, b) => b.gain - a.gain || a.c.name.localeCompare(b.c.name));
    const best = gains[0];
    if (!best) continue;
    /* A later week waits for its own run unless the wire is thin (review W12). */
    if (k >= request.leadWeeks) {
      const alike = gains.filter((g) => g.gain >= best.gain - LOOK_AHEAD.margin).length;
      if (alike >= LOOK_AHEAD.deepWire) continue;
    }
    const bid = coverBid(best.c, best.gain, request.usesFaab, spendable);
    if (!bid) continue;
    if (bid.kind === 'claim' && spendable != null) spendable -= bid.high;
    taken.add(best.c.playerId);
    out.push({
      playerId: best.c.playerId,
      name: best.c.name,
      position: best.c.position,
      team: best.c.team,
      week: hole.week,
      reason: coverReason(hole),
      gain: best.gain,
      bid,
      room: room.shift()!,
    });
  }
  return out;
}

/** `covers your Week 12 bye at TE`, `covers Week 11 at RB, Hall out`, `covers Week 11 at TE`. */
export function coverReason(hole: Pick<RosterHole, 'week' | 'position' | 'cause' | 'missing'>): string {
  if (hole.cause === 'bye') return `covers your Week ${hole.week} bye at ${hole.position}`;
  if (hole.cause === 'injury' && hole.missing) return `covers Week ${hole.week} at ${hole.position}, ${surname(hole.missing.name)} out`;
  return `covers Week ${hole.week} at ${hole.position}`;
}

/** The shared bid rule (Round 20), as a Worth considering claim worth one week; never into the reserve. */
function coverBid(c: AheadCandidate, gain: number, usesFaab: boolean, spendable: number | null): CoverLine['bid'] | null {
  if (c.free) return { kind: 'free' };
  if (!usesFaab) return { kind: 'none' };
  if (spendable == null) return null;
  const { bid } = smartBid({ kind: 'consider', position: c.position, gain, expectedRivals: null, spendable });
  return { kind: 'claim', low: bid, high: bid };
}

/** His number for week `k`, before or after availability. */
function candidate(p: AheadPlayer, k: number, available: boolean): LineupCandidate {
  const raw = p.weekValues?.[k] ?? p.rate ?? 0;
  const share = available ? (p.weekly[k] ?? 1) : 1;
  return { id: p.playerId, position: p.position, value: Math.max(0, raw) * share };
}

/** The lineup slots another planner does not own (the defence is its own). */
function skillSlots(shape: RosterShape, excluded: ReadonlySet<string>): LineupSlotSpec[] {
  return slotsOf(shape).filter((s) => [...s.eligible].some((p) => !excluded.has(p)));
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const last = parts[parts.length - 1]!;
  return /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(last) && parts.length > 2 ? parts[parts.length - 2]! : last;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
