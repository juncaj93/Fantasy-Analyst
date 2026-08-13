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
    picksMade: myPicks.length,
  };
}
