/**
 * The roster you actually have right now, mid-draft.
 *
 * Sleeper's roster endpoint does not fill in during a draft — it becomes
 * authoritative only once the draft finishes. But the pick stream already
 * contains everything needed to know what you have taken, so waiting for the
 * roster endpoint means the Team page is empty and roster need is wrong for the
 * entire draft, which is exactly when both matter most.
 *
 * So during a draft the picks are the source of truth, and afterwards Sleeper
 * is. The two are merged by player id rather than concatenated, so the handover
 * cannot produce a player twice.
 *
 * This module decides nothing about who to draft. It reports what is held and
 * which required slots are still open.
 */

import { FLEX_ELIGIBILITY, type RosterShape } from '../sleeper/scoring.ts';

export interface LiveRosterPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** The pick that produced them, when it came from the draft. */
  pickNo: number | null;
}

export interface OpenSlot {
  /** `QB`, `RB`, … or a flex slot name such as `FLEX`. */
  slot: string;
  count: number;
  /** Which positions can fill it. */
  accepts: string[];
}

export interface LiveRoster {
  /** True when this was reconstructed from an in-progress draft. */
  live: boolean;
  players: LiveRosterPlayer[];
  /** Held players grouped by position, each group in pick order. */
  byPosition: Record<string, LiveRosterPlayer[]>;
  counts: Record<string, number>;
  /** Roster spots filled and left, across starters and bench. */
  filled: number;
  remaining: number;
  /** Starting slots with nobody to put in them yet. */
  openStarters: OpenSlot[];
  /** Every starting slot the league has, filled out of required. */
  progress: SlotProgress[];
  picksMade: number;
}

export interface LiveRosterInput {
  /** Every pick in the draft, in pick order. */
  picks: { playerId: string | null; pickNo: number; rosterId: number | null; pickedBy: string | null }[];
  /** The user's roster id and Sleeper user id, either of which may be absent. */
  rosterId: number | null;
  ownerId: string | null;
  /** Player ids Sleeper already lists on the roster. Empty during most drafts. */
  sleeperPlayerIds: string[];
  /** Canonical players, for names and positions. */
  byId: Map<string, { fullName: string; position: string; team: string }>;
  shape: RosterShape;
  /** Sleeper's draft status: `drafting`, `paused`, `complete`, … */
  draftStatus: string;
}

const IN_PROGRESS = new Set(['drafting', 'paused']);

/** Did this pick belong to the user? */
function isMine(
  pick: { rosterId: number | null; pickedBy: string | null },
  rosterId: number | null,
  ownerId: string | null,
): boolean {
  if (rosterId != null && pick.rosterId === rosterId) return true;
  // Some drafts record only who picked, never a roster id.
  return !!ownerId && pick.pickedBy === ownerId;
}

/**
 * Which starting slots are still empty.
 *
 * Fixed slots are filled first, then whatever is left over is offered to the
 * flex slots — the same order a lineup would actually be built in. This is a
 * count of unfilled requirements, not a lineup: mid-draft there is no reason to
 * commit a player to a particular slot, and doing so would invent a decision
 * the user has not made.
 */
export function openStarters(shape: RosterShape, counts: Record<string, number>): OpenSlot[] {
  const spare: Record<string, number> = { ...counts };
  const open: OpenSlot[] = [];

  for (const [position, required] of Object.entries(shape.starters)) {
    const held = spare[position] ?? 0;
    const used = Math.min(held, required);
    spare[position] = held - used;
    if (required - used > 0) open.push({ slot: position, count: required - used, accepts: [position] });
  }

  for (const flex of shape.flex) {
    const source = flex.positions.find((p) => (spare[p] ?? 0) > 0);
    if (source) spare[source] = (spare[source] ?? 0) - 1;
    else open.push({ slot: flex.slot, count: 1, accepts: [...(FLEX_ELIGIBILITY[flex.slot] ?? flex.positions)] });
  }

  // Collapse repeated flex slots into one row: "2 FLEX" reads better than two.
  const merged: OpenSlot[] = [];
  for (const slot of open) {
    const existing = merged.find((m) => m.slot === slot.slot);
    if (existing) existing.count += slot.count;
    else merged.push(slot);
  }
  return merged;
}

export interface SlotProgress {
  /** `QB`, `RB`, …, a flex slot name such as `FLEX` or `SUPER_FLEX`, or `BN`. */
  slot: string;
  filled: number;
  required: number;
  /** Which positions can fill it. */
  accepts: string[];
  /**
   * True for the bench row, which counts depth rather than a lineup slot.
   *
   * The draft line renders it the same way, but the two are not the same
   * question: a starting slot is a hole in your lineup, and a bench spot is
   * room to keep somebody.
   */
  bench?: boolean;
}

/**
 * Every starting slot the league actually has, how many are covered, and how
 * much of the bench has been used.
 *
 * The same allocation as `openStarters` — fixed slots first, then whatever is
 * left over offered to the flex — reported from the other end: filled out of
 * required, in the league's own order, so the draft header can say
 * `0/1 QB · 1/2 RB · 3/3 WR · 0/2 FLEX · 0/6 BN` instead of a paragraph about
 * what to do next.
 *
 * Slots the league does not have simply do not appear, and neither does the
 * bench row in a league configured without one.
 *
 * **Bench is depth, not leftovers of a lineup decision.** It is every player
 * held beyond the ones this same allocation put in a starting slot — so a
 * fourth receiver in a league that starts three counts once, on the bench, and
 * never twice. No player is assigned to a *particular* bench spot, because
 * mid-draft that is a decision the user has not made and the app must not
 * invent one.
 */
export function rosterProgress(shape: RosterShape, counts: Record<string, number>): SlotProgress[] {
  const spare: Record<string, number> = { ...counts };
  const rows: SlotProgress[] = [];

  for (const [position, required] of Object.entries(shape.starters)) {
    const held = spare[position] ?? 0;
    const used = Math.min(held, required);
    spare[position] = held - used;
    rows.push({ slot: position, filled: used, required, accepts: [position] });
  }

  // Repeated flex slots collapse into one row: "1/2 FLEX" reads better than two.
  for (const flex of shape.flex) {
    const source = flex.positions.find((p) => (spare[p] ?? 0) > 0);
    if (source) spare[source] = (spare[source] ?? 0) - 1;
    let row = rows.find((r) => r.slot === flex.slot);
    if (!row) {
      row = { slot: flex.slot, filled: 0, required: 0, accepts: [...(FLEX_ELIGIBILITY[flex.slot] ?? flex.positions)] };
      rows.push(row);
    }
    row.required++;
    if (source) row.filled++;
  }

  if (shape.benchSlots > 0) {
    /*
     * Whatever the starting allocation above did not consume.
     *
     * Counting the leftovers rather than re-deriving from totals is what keeps
     * the two halves of the line consistent: every player is in exactly one of
     * these numbers, including a player at a position this league does not
     * start, who is occupying a bench spot and nothing else.
     *
     * It cannot exceed the configured bench — a roster that somehow holds more
     * players than it has room for is a Sleeper-side fact, and reporting
     * `9/6 BN` would say the app had miscounted rather than that the league had.
     */
    const depth = Object.values(spare).reduce((total, left) => total + Math.max(0, left), 0);
    rows.push({
      slot: 'BN',
      filled: Math.min(depth, shape.benchSlots),
      required: shape.benchSlots,
      accepts: [],
      bench: true,
    });
  }

  return rows;
}

export function buildLiveRoster(input: LiveRosterInput): LiveRoster {
  const { picks, rosterId, ownerId, sleeperPlayerIds, byId, shape, draftStatus } = input;
  const live = IN_PROGRESS.has(String(draftStatus).toLowerCase());

  const seen = new Set<string>();
  const players: LiveRosterPlayer[] = [];

  const add = (playerId: string, pickNo: number | null) => {
    if (!playerId || seen.has(playerId)) return;
    seen.add(playerId);
    const p = byId.get(playerId);
    players.push({
      playerId,
      name: p?.fullName ?? playerId,
      position: p?.position ?? '',
      team: p?.team ?? '',
      pickNo,
    });
  };

  // Drafted players first: during a draft they are the current truth, and they
  // carry the pick number, which Sleeper's roster list does not.
  const myPicks = picks.filter((p) => p.playerId && isMine(p, rosterId, ownerId));
  for (const pick of myPicks) add(pick.playerId!, pick.pickNo);

  // Then anything Sleeper lists that the picks did not cover. After the draft
  // this is the authoritative set; the id check above stops duplicates.
  for (const id of sleeperPlayerIds) add(id, null);

  const byPosition: Record<string, LiveRosterPlayer[]> = {};
  const counts: Record<string, number> = {};
  for (const player of players) {
    const key = player.position || 'UNKNOWN';
    (byPosition[key] ??= []).push(player);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const capacity = shape.totalStarters + shape.benchSlots;
  return {
    live,
    players,
    byPosition,
    counts,
    filled: players.length,
    remaining: Math.max(0, capacity - players.length),
    openStarters: openStarters(shape, counts),
    progress: rosterProgress(shape, counts),
    picksMade: myPicks.length,
  };
}
