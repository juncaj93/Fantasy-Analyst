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
import { POSITION_ORDER, TRAILING_FILTER_POSITIONS } from '../sleeper/eligibility.ts';

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

/**
 * The draft statuses that mean Sleeper's roster is not the answer yet.
 *
 * `pre_draft` belongs here and its absence was a real defect. Sleeper's roster
 * endpoint becomes authoritative at the final pick and not before, so a league
 * that has not drafted has an *empty* roster there, not a wrong one — and
 * reading it as authoritative made the Team screen draw a lineup: a
 * `Recommended starters` heading over eight `Nobody eligible yet` rows and a
 * `Bench (0)`, which is what a reader sees the morning of their draft and reads
 * as "the app has lost my team".
 *
 * It is also the status an in-person draft never leaves. A league that meets in
 * a room and enters its picks by hand is `pre_draft` from the day it is created
 * to the day somebody marks it done, so without this the whole of draft day
 * would be drawn as a season that had already started.
 *
 * The reader loses nothing by it: a squad held before a draft — a dynasty
 * roster, a keeper list — is still drawn in full, as players *held*, which is
 * the only honest description of them. What goes is the lineup furniture, and
 * nobody sets a lineup before a draft.
 */
const IN_PROGRESS = new Set(['pre_draft', 'predraft', 'drafting', 'paused']);

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

  return orderProgress(rows);
}

/** One slot of a roster, with the players actually in it. */
export interface FilledSlot extends SlotProgress {
  players: { playerId: string; position: string }[];
}

/**
 * Who is in which slot, given rows `rosterProgress` already worked out.
 *
 * ## Why this is not the Team screen's layout
 *
 * Team draws the lineup Sleeper *stores* — starters and bench as the manager
 * set them — and a draft has no such thing: nobody sets a lineup while they are
 * drafting, and inventing one would be committing a decision the reader has not
 * made. So there was nothing there to reuse. What there was to reuse is the
 * allocation this file already does for the draft header's `0/1 QB · 1/2 RB`
 * strip, and that is what this walks.
 *
 * ## Why it walks the rows rather than the shape
 *
 * `rosterProgress` decides the allocation — fixed slots first, then the flex,
 * then the bench — and it decides it once. Walking its output in the order it
 * produced means this cannot allocate differently from the counts already on
 * screen beside it. Handing it the shape again and re-deriving would be a
 * second implementation of the same rule, and the two would disagree the first
 * time either changed.
 *
 * Order within a slot is the order the players are given, which for a draft is
 * pick order: the receiver you took in the second round is above the one you
 * took in the ninth.
 *
 * ## The one place it may read differently from the strip
 *
 * `rosterProgress` caps its bench *count* at the configured bench, so the
 * header never reads `9/6 BN` and blame the app for a Sleeper-side fact. This
 * draws every player regardless, because a pick the reader made disappearing
 * off their own team sheet is the worse of the two. Every starting slot matches
 * the strip exactly; only the bench can hold more names than spaces.
 */
export function fillSlotRows(
  rows: readonly SlotProgress[],
  players: readonly { playerId: string; position: string }[],
): FilledSlot[] {
  const left = [...players];
  const take = (accepts: readonly string[], upTo: number): { playerId: string; position: string }[] => {
    const got: { playerId: string; position: string }[] = [];
    while (got.length < upTo) {
      const at = left.findIndex((p) => accepts.includes(p.position));
      if (at < 0) break;
      got.push(left.splice(at, 1)[0]!);
    }
    return got;
  };

  const filled: FilledSlot[] = [];
  for (const row of rows) {
    // The bench is everyone the starting slots did not want, so it is filled
    // last whatever order the rows arrived in.
    if (row.bench) continue;
    filled.push({ ...row, players: take(row.accepts, row.required) });
  }

  /*
   * Everyone the starting slots did not want, and nobody is dropped.
   *
   * A league with no bench row still gets one here when there is somebody to
   * put in it — a roster over its own configured depth, or holding a position
   * the league neither starts nor benches. That is a Sleeper-side fact, and a
   * pick the reader made vanishing off their own team sheet would report it as
   * an app that had lost track.
   */
  const bench = rows.find((r) => r.bench);
  if (bench || left.length > 0) {
    filled.push({
      ...(bench ?? { slot: 'BN', filled: left.length, required: 0, accepts: [], bench: true }),
      players: left.splice(0, left.length),
    });
  }
  return orderFilled(filled, rows);
}

function orderFilled(filled: FilledSlot[], rows: readonly SlotProgress[]): FilledSlot[] {
  const at = new Map(rows.map((row, i) => [row.slot, i]));
  return [...filled].sort((a, b) => (at.get(a.slot) ?? 0) - (at.get(b.slot) ?? 0));
}

/**
 * The order the strip reads in: `QB · RB · WR · TE · FLX · DEF · BN`.
 *
 * Sleeper's own `roster_positions` order is what this used to be, and it puts
 * the defence among the positions — `… TE · DEF · FLX · BN` in most leagues,
 * because that is the sequence the slots are listed in. Read on a phone that is
 * wrong twice: the defence interrupts the four positions a drafter is actually
 * choosing between, and the flex that spans three of them ends up after it.
 *
 * So the same rule the filter chips use, and from the same constant — the
 * positions in reading order, then the flex views over them, then the defence,
 * then the bench. `TRAILING_FILTER_POSITIONS` is shared with
 * `orderFilterChips`, so the strip and the chip row under it cannot disagree
 * about where a defence goes.
 *
 * Bench is last on its own terms rather than by that rule: it is not a lineup
 * slot at all, it is how much room is left, and it is the end of the sentence.
 *
 * **Ordering only.** Every row, every count and every requirement is exactly
 * what the allocation above produced; nothing here adds, drops or recomputes
 * one. A slot this function has never heard of keeps its place among the
 * starters rather than being sorted to an end.
 */
function orderProgress(rows: SlotProgress[]): SlotProgress[] {
  const rank = (row: SlotProgress): number => {
    if (row.bench) return 4;
    if (TRAILING_FILTER_POSITIONS.includes(row.slot)) return 3;
    // A flex slot is a view over positions rather than one of them, so it
    // follows its parts — the same reason `FLX` is last among the chips.
    if (row.accepts.length > 1) return 2;
    return POSITION_ORDER.includes(row.slot) ? 0 : 1;
  };
  const within = (row: SlotProgress): number => {
    const at = POSITION_ORDER.indexOf(row.slot);
    return at === -1 ? POSITION_ORDER.length : at;
  };
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || within(a.row) - within(b.row) || a.index - b.index)
    .map((entry) => entry.row);
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
