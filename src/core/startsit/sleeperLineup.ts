/**
 * The lineup Sleeper actually holds, beside the one this app would set.
 *
 * The Team screen used to draw two lists — `Recommended starters` and `Bench` —
 * and leave the reader to reconcile them against a third screen in Sleeper. The
 * reader's question is not "what would you start"; it is **"what should I
 * change?"**, and that question is asked of a lineup that already exists. Two
 * lists cannot answer it: a player who is in one list and not the other is a
 * change, and spotting that is work this app was making a person do.
 *
 * So the unit here is a **slot**, the baseline is **Sleeper's own lineup**, and
 * every slot carries a verdict about what to do with it. Nine rows for a
 * nine-slot league, in the league's own order, whether or not anything is wrong
 * with them — because "nothing to change at RB" is an answer, and a screen that
 * only shows problems makes the reader wonder what it did not look at.
 *
 * ## Where Sleeper's assignment comes from, and what happens without it
 *
 * Sleeper sends `starters` positionally aligned with the league's
 * `roster_positions`, using `"0"` for an empty slot, which is exactly the
 * per-slot assignment this module wants. That array is stored as
 * {@link RosterRecord.starterSlotIds} — see migration 0039, which added it
 * beside the older set because the set had the gaps filtered out of it.
 *
 * A roster synced before that column existed has no slot order, and the answer
 * is not to refuse the screen. {@link assignByEligibility} places the same
 * starters into the same slots by what each slot accepts, which agrees with
 * Sleeper everywhere it matters and can only differ in which of two
 * interchangeable flex slots a player is shown in — a distinction with no
 * consequence for the reader, since both spellings say he is starting. The
 * stored order is preferred whenever it is there; this is the fallback, not a
 * second opinion.
 *
 * ## What a verdict is, and what it is not
 *
 * It is a statement about a **slot**, derived from two facts already computed
 * elsewhere: who Sleeper has in it, and who `recommendLineup` would put there.
 * Nothing here re-ranks anybody, nothing here scores anybody, and nothing here
 * decides a lineup — this module would produce identical output if the
 * optimiser changed its mind, because it only reads what the optimiser said.
 *
 * And nothing here acts. Every verdict is a sentence; the change is made by
 * hand in Sleeper, which is true of every recommendation in this app.
 */

import type { SlotVacancy } from './lineup.ts';
import type { ProjectionSource } from './projection.ts';

/**
 * A recommended slot, as loosely as this module actually needs one.
 *
 * Structural rather than `LineupSlot` itself because the client's copy of
 * that type marks several fields optional on purpose — they are absent when an
 * older server sends them, and the screen is written to survive that. Requiring
 * the stricter core shape here would force a cast at the one call site whose
 * whole job is tolerating the looser one, and a cast is how "absent" quietly
 * becomes "null" and then becomes a claim. Both shapes satisfy this.
 */
export interface RecommendedSlot {
  slot: string;
  accepts: string[];
  playerId: string | null;
  name?: string | null;
  projection?: number | null;
  projectionSource?: ProjectionSource | null;
  locked?: boolean;
  drivers?: string[];
  conflicts?: string[];
  vacancy?: SlotVacancy[];
}

/**
 * What this app thinks should happen to one slot.
 *
 * Deliberately a small closed set. Each one is a different sentence and a
 * different action, and collapsing any two of them would put the reader back to
 * comparing lists:
 *
 *  - `keep` — Sleeper has the right player here. Most slots, most weeks, and
 *    the reason the screen shows them at all: silence about a slot is
 *    indistinguishable from having not looked at it.
 *  - `swap` — Sleeper has one player here and this app would start another,
 *    *and* the optimiser was prepared to suggest the change. The only verdict
 *    that names two people, and the one worth points. A difference it withheld
 *    — too small to be worth the churn — reads `keep`, because leaving your own
 *    player alone is what the app is recommending.
 *  - `fill` — Sleeper has left the slot empty and there is somebody for it.
 *  - `no_pick` — Sleeper has a player here and this app will not name anybody
 *    for the slot, so it is declining to have an opinion rather than benching
 *    him. Two shapes reach it and the row says which: a player it cannot put a
 *    number on (Jacksonville — a real defence, a real roster spot, no quoted
 *    game), and one who is out with nobody eligible to take the spot. Both mean
 *    "no recommendation here", which is why they are one verdict; they read
 *    differently on the row because the reason travels with them.
 *  - `empty` — nobody in it and nobody for it.
 */
export type SlotVerdict = 'keep' | 'swap' | 'fill' | 'no_pick' | 'empty';

export interface LineupVerdictRow {
  /** The league's own label for the slot: `QB`, `WR`, `FLEX`, `DEF`. */
  slot: string;
  /** What the slot accepts, for the flexes that cannot say it themselves. */
  accepts: string[];
  /** Who Sleeper has here, or null where Sleeper has left it empty. */
  currentPlayerId: string | null;
  /** Who this app would start here, or null where it will not fill the slot. */
  recommendedPlayerId: string | null;
  recommendedName: string | null;
  /** The recommended player's projection, carried from the slot unchanged. */
  projection: number | null;
  projectionSource: ProjectionSource | null;
  verdict: SlotVerdict;
  /**
   * True when this slot's game has kicked off and the verdict is now history.
   *
   * Carried rather than folded into {@link verdict} because it does not replace
   * the verdict, it disqualifies it: a `swap` the reader can no longer make is
   * still a swap, and telling them what it *was* while making clear they cannot
   * act is honest where silently showing `keep` would not be.
   */
  locked: boolean;
  /** Why an unfilled slot could not be filled. Empty unless it is. */
  vacancy: SlotVacancy[];
  /** The two to four things behind the recommendation, for the row that opens. */
  drivers: string[];
  conflicts: string[];
}

/**
 * The starting slots a league defines, in the order Sleeper lists them.
 *
 * Bench, injured reserve and taxi are not lineup slots and are dropped: they
 * are where a player sits when he is *not* in the lineup, and a row for one
 * would be a row about nothing. The order is the league's own, because that is
 * the order the reader sees in Sleeper and a screen that reorders it is a
 * screen they have to translate.
 */
const NON_STARTING = new Set(['BN', 'IR', 'TAXI']);

export function startingSlotLabels(rosterPositions: readonly string[]): string[] {
  return rosterPositions.map((p) => String(p ?? '').toUpperCase()).filter((p) => p && !NON_STARTING.has(p));
}

/**
 * Pair each of Sleeper's slots with the app's recommendation for the same slot.
 *
 * Matched by label and consumed in order, which is what makes three WR slots
 * line up with three WR slots rather than all three finding the first one. The
 * two lists come from the same `roster_positions`, so the labels match as
 * multisets; a label with no partner left is still drawn, carrying whichever
 * half of the pair exists, because dropping it would silently shorten the
 * lineup.
 */
export function buildLineupVerdicts(input: {
  /** The league's roster positions, in Sleeper's order. */
  rosterPositions: readonly string[];
  /** Sleeper's own lineup, positionally aligned. Absent means "order unknown". */
  starterSlotIds?: readonly (string | null)[] | undefined;
  /** Sleeper's lineup as a set, which is always known. */
  starterIds: readonly string[];
  /** What `recommendLineup` decided, in its own order. */
  slots: readonly RecommendedSlot[];
  /**
   * The changes the optimiser was actually prepared to suggest, by incoming id.
   *
   * Load-bearing, and the reason is written out in `lineup.ts`'s own docblock:
   * the recommended lineup and the swap list are computed under *different*
   * rules, and a screen that reads only the first will show a reordering the
   * app deliberately refused to explain. That is the defect of 8 September in a
   * new costume.
   *
   * `recommendLineup` withholds a swap whose gain is under
   * {@link MIN_SWAP_GAIN}, and its assignment separately protects an incumbent
   * from an unpriced challenger. Where it withheld one, the honest row is
   * `keep`: the reader's own lineup stands, which is exactly what the guard is
   * for. Absent means "no swap list was passed", and every difference is then
   * reported — the older behaviour, kept only so a caller without one is not
   * silently given a lineup with no advice in it.
   */
  suggestedSwapIns?: ReadonlySet<string> | undefined;
  /** A player's position, for the eligibility fallback. */
  positionOf: (playerId: string) => string | null;
}): LineupVerdictRow[] {
  const labels = startingSlotLabels(input.rosterPositions);
  /*
   * A league whose positions this app never read still gets its lineup drawn,
   * from the shape the optimiser was built with. The two agree in every case
   * that matters; this is only here so a missing league record degrades to a
   * screen rather than to nothing.
   */
  const slotLabels = labels.length > 0 ? labels : input.slots.map((s) => s.slot);

  const current = currentBySlot({
    slotLabels,
    starterSlotIds: input.starterSlotIds,
    starterIds: input.starterIds,
    slots: input.slots,
    positionOf: input.positionOf,
  });

  /* The app's slots, consumed by label so repeats pair up in order. */
  const remaining = new Map<string, RecommendedSlot[]>();
  for (const slot of input.slots) {
    const key = slot.slot.toUpperCase();
    const bucket = remaining.get(key);
    if (bucket) bucket.push(slot);
    else remaining.set(key, [slot]);
  }

  return slotLabels.map((label, index) => {
    const recommended = remaining.get(label)?.shift() ?? null;
    const currentPlayerId = current[index] ?? null;
    return {
      slot: label,
      accepts: recommended?.accepts ?? [label],
      currentPlayerId,
      recommendedPlayerId: recommended?.playerId ?? null,
      recommendedName: recommended?.name ?? null,
      projection: recommended?.projection ?? null,
      projectionSource: recommended?.projectionSource ?? null,
      verdict: verdictFor(currentPlayerId, recommended?.playerId ?? null, input.suggestedSwapIns),
      locked: recommended?.locked ?? false,
      vacancy: recommended?.vacancy ?? [],
      drivers: recommended?.drivers ?? [],
      conflicts: recommended?.conflicts ?? [],
    };
  });
}

function verdictFor(
  currentPlayerId: string | null,
  recommendedPlayerId: string | null,
  suggested: ReadonlySet<string> | undefined,
): SlotVerdict {
  if (currentPlayerId == null && recommendedPlayerId == null) return 'empty';
  if (currentPlayerId == null) return 'fill';
  /*
   * Sleeper has somebody here and this app will not name anybody.
   *
   * That is not a recommendation to bench him — the optimiser refuses to rank
   * a player it cannot score, and refusing is the whole point. The row says so
   * and carries the reason; see `LineupSlot.vacancy`.
   */
  if (recommendedPlayerId == null) return 'no_pick';
  if (currentPlayerId === recommendedPlayerId) return 'keep';
  /*
   * A difference the optimiser would not suggest is not a change to make.
   *
   * It reads `keep` because that is what the app is actually saying: leave your
   * own player where he is. Saying `swap` here would put a `→ Start X instead`
   * on the row while the card above it says hold — one screen, two rules, which
   * is the thing `lineup.ts` was rewritten to stop.
   */
  if (suggested && !suggested.has(recommendedPlayerId)) return 'keep';
  return 'swap';
}

/** Sleeper's player for each slot, from the stored order or from eligibility. */
function currentBySlot(input: {
  slotLabels: string[];
  starterSlotIds?: readonly (string | null)[] | undefined;
  starterIds: readonly string[];
  slots: readonly RecommendedSlot[];
  positionOf: (playerId: string) => string | null;
}): (string | null)[] {
  const stored = input.starterSlotIds ?? [];
  /*
   * The stored order is used when it covers the lineup, and not otherwise.
   *
   * "Covers" rather than "exists": a roster synced before migration 0039 has an
   * empty array, and one synced by a Sleeper payload shorter than the league's
   * own slot list would silently leave the tail unassigned. Both fall through
   * to the eligibility pass, which always produces a full-length answer.
   */
  if (stored.length >= input.slotLabels.length) {
    return input.slotLabels.map((_, i) => stored[i] ?? null);
  }
  return assignByEligibility(input.slotLabels, input.starterIds, input.slots, input.positionOf);
}

/**
 * Place a set of starters into slots by what each slot accepts.
 *
 * The fallback for a roster whose slot order was never stored, and a faithful
 * one: the players are Sleeper's, the slots are the league's, and the only
 * freedom is which of two interchangeable flexes a player lands in. It can
 * therefore disagree with Sleeper's own display about a label and never about
 * who is starting, which is the fact the screen is actually reporting.
 *
 * Augmenting paths rather than a greedy pass, for the same reason
 * `lineup.ts` uses them: filling slots naively strands a player who only fits
 * a slot already taken by somebody who had alternatives, and a lineup that
 * drops a real starter would be a screen inventing a hole.
 */
export function assignByEligibility(
  slotLabels: readonly string[],
  starterIds: readonly string[],
  slots: readonly RecommendedSlot[],
  positionOf: (playerId: string) => string | null,
): (string | null)[] {
  /* What each slot label accepts, learned from the optimiser's own slots. */
  const accepts = new Map<string, string[]>();
  for (const slot of slots) {
    const key = slot.slot.toUpperCase();
    if (!accepts.has(key)) accepts.set(key, slot.accepts.map((a) => a.toUpperCase()));
  }

  const bySlot = new Map<number, string>();
  const fits = (index: number, position: string): boolean => {
    const label = slotLabels[index]!;
    const list = accepts.get(label);
    return list ? list.includes(position) : label === position;
  };

  const place = (playerId: string, position: string, visited: Set<number>): boolean => {
    for (let i = 0; i < slotLabels.length; i++) {
      if (visited.has(i) || bySlot.has(i) || !fits(i, position)) continue;
      visited.add(i);
      bySlot.set(i, playerId);
      return true;
    }
    for (let i = 0; i < slotLabels.length; i++) {
      if (visited.has(i) || !fits(i, position)) continue;
      visited.add(i);
      const occupant = bySlot.get(i);
      const occupantPosition = occupant ? (positionOf(occupant) ?? '').toUpperCase() : '';
      if (!occupant || place(occupant, occupantPosition, visited)) {
        bySlot.set(i, playerId);
        return true;
      }
    }
    return false;
  };

  for (const playerId of starterIds) {
    place(playerId, (positionOf(playerId) ?? '').toUpperCase(), new Set<number>());
  }
  return slotLabels.map((_, i) => bySlot.get(i) ?? null);
}
