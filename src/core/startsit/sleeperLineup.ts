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
 * Pair each of Sleeper's slots with the app's recommendation for that slot.
 *
 * ## Why this is not "the Nth WR against the Nth WR"
 *
 * It was, and that was a bug on the screen for a fortnight. The two lineups are
 * two different assignments of *mostly the same players*, and the app's order
 * is its own: it fills slots by what it decided, not by what Sleeper displays.
 * Consuming each label's bucket in order therefore pairs row N with whoever the
 * app happened to put N'th under that label, which is very often somebody else.
 *
 * Measured on this league on 16 September 2026:
 *
 *     Sleeper   FLEX #1 Jayden Reed      FLEX #2 Kenneth Walker
 *     app       FLEX #1 Kenneth Walker   FLEX #2 RJ Harvey
 *     the swap the optimiser made:  out Jayden Reed, in RJ Harvey, +1.37
 *
 * Positionally, Reed's row paired with Walker (no swap, reads `keep`) and
 * Walker's row paired with Harvey — so the screen printed `→ Start RJ Harvey
 * instead · 7.2` on **Kenneth Walker's** row, advising a reader to bench a 16.4
 * for a 7.2 while the change the app actually wanted went unmentioned. The same
 * crossing ran quietly through the two RB rows, where both verdicts were `keep`
 * and each row carried the *other* man's projection: Rhamondre Stevenson's row
 * showed Bijan Robinson's 18.98.
 *
 * ## What it pairs on instead
 *
 * Identity, then the optimiser's own swap list, then — only for what neither
 * can speak to — the label.
 *
 *  1. **A player both lineups start keeps his own row.** His numbers are his,
 *     wherever either lineup happens to file him, so a `keep` row can no longer
 *     quote somebody else's projection.
 *  2. **A row the app would change is paired by the swap the app made.** The
 *     optimiser already decided who comes out and who goes in; this reads that
 *     decision rather than re-deriving it from two orderings. `→ Start X
 *     instead` therefore lands on the row holding the man X replaces, which is
 *     the only row where that sentence is true.
 *  3. **Everything left falls back to the label, in order** — an empty Sleeper
 *     slot, a caller that passed no swap list. This is the old rule, kept for
 *     the rows where there is nothing better to go on.
 *
 * A label with no partner left is still drawn, carrying whichever half of the
 * pair exists, because dropping it would silently shorten the lineup.
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
   * The changes the optimiser was actually prepared to suggest, in full.
   *
   * Load-bearing twice over, and the first reason is written out in
   * `lineup.ts`'s own docblock: the recommended lineup and the swap list are
   * computed under *different* rules, and a screen that reads only the first
   * will show a reordering the app deliberately refused to explain. That is the
   * defect of 8 September in a new costume.
   *
   * `recommendLineup` withholds a swap whose gain is under
   * {@link MIN_SWAP_GAIN}, and its assignment separately protects an incumbent
   * from an unpriced challenger. Where it withheld one, the honest row is
   * `keep`: the reader's own lineup stands, which is exactly what the guard is
   * for. Absent means "no swap list was passed", and every difference is then
   * reported — the older behaviour, kept only so a caller without one is not
   * silently given a lineup with no advice in it.
   *
   * The second reason is the pairing above: this used to be a set of incoming
   * ids, which answers "may this change be suggested?" but not "*instead of
   * whom?*" — and without the second answer the sentence lands on whichever row
   * the label ordering put it next to. The pairs are what make `→ Start X
   * instead` a statement about the row it is printed on.
   */
  suggestedSwaps?: readonly { outPlayerId: string; inPlayerId: string }[] | undefined;
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

  /*
   * What each label accepts, read from the label and never from the occupant.
   *
   * A row headed `RB` says what an RB slot takes even when the man bound to it
   * is filed under FLEX by the optimiser — which pass 1 below makes routine.
   * Taking `accepts` off the bound slot would have a Sleeper RB row announce
   * that it accepts receivers.
   */
  const acceptsOf = new Map<string, string[]>();
  for (const slot of input.slots) {
    const key = slot.slot.toUpperCase();
    if (!acceptsOf.has(key)) acceptsOf.set(key, slot.accepts);
  }

  /* Where the app put each player it starts, so a kept man carries his own numbers. */
  const appSlotOf = new Map<string, RecommendedSlot>();
  for (const slot of input.slots) if (slot.playerId) appSlotOf.set(slot.playerId, slot);

  const pairedWith: (RecommendedSlot | null)[] = slotLabels.map(() => null);
  const claimed = new Set<RecommendedSlot>();
  const bind = (index: number, slot: RecommendedSlot | null | undefined): void => {
    if (!slot || claimed.has(slot)) return;
    pairedWith[index] = slot;
    claimed.add(slot);
  };

  /* 1. A man both lineups start keeps his own row, wherever either files him. */
  slotLabels.forEach((_, index) => {
    const playerId = current[index];
    if (playerId) bind(index, appSlotOf.get(playerId));
  });

  /* 2. A row the app would change is paired by the swap the app actually made. */
  const swapInFor = new Map<string, string>();
  for (const swap of input.suggestedSwaps ?? []) swapInFor.set(swap.outPlayerId, swap.inPlayerId);
  slotLabels.forEach((_, index) => {
    if (pairedWith[index]) return;
    const playerId = current[index];
    if (!playerId) return;
    const incoming = swapInFor.get(playerId);
    if (incoming) bind(index, appSlotOf.get(incoming));
  });

  /*
   * 3. Whatever is left, by label and in order — the old rule, for the rows
   * neither pass can speak to: an empty Sleeper slot, a slot the app declined
   * to fill, a caller that passed no swap list at all.
   */
  const remaining = new Map<string, RecommendedSlot[]>();
  for (const slot of input.slots) {
    if (claimed.has(slot)) continue;
    const key = slot.slot.toUpperCase();
    const bucket = remaining.get(key);
    if (bucket) bucket.push(slot);
    else remaining.set(key, [slot]);
  }
  slotLabels.forEach((label, index) => {
    if (pairedWith[index]) return;
    bind(index, remaining.get(label)?.shift());
  });

  const suggestedIns = input.suggestedSwaps
    ? new Set(input.suggestedSwaps.map((swap) => swap.inPlayerId))
    : undefined;

  return slotLabels.map((label, index) => {
    const recommended = pairedWith[index];
    const currentPlayerId = current[index] ?? null;
    return {
      slot: label,
      accepts: acceptsOf.get(label) ?? recommended?.accepts ?? [label],
      currentPlayerId,
      recommendedPlayerId: recommended?.playerId ?? null,
      recommendedName: recommended?.name ?? null,
      projection: recommended?.projection ?? null,
      projectionSource: recommended?.projectionSource ?? null,
      verdict: verdictFor(currentPlayerId, recommended?.playerId ?? null, suggestedIns),
      locked: recommended?.locked ?? false,
      vacancy: recommended?.vacancy ?? [],
      drivers: recommended?.drivers ?? [],
      conflicts: recommended?.conflicts ?? [],
    };
  });
}

/**
 * Whose row this is — the one name on it, and the only card its tap may open.
 *
 * The incumbent on every verdict but `fill`, where there is no incumbent and
 * the recommendation is the only person in the story. That is the same rule the
 * row's headline is drawn with, and it lives here rather than in the screen
 * because the screen had two copies of it that disagreed:
 *
 *   displayed = current ?? recommended        // the name the reader taps
 *   opened    = recommended ?? current        // the card that came up
 *
 * Those two agree on almost every row, which is why the defect hid. They part
 * company on a row whose verdict is `keep` while the two ids differ, and the
 * lineup produces exactly that shape whenever the league has two interchangeable
 * FLEX slots: Sleeper's order and the optimiser's order put the same two players
 * in the opposite flexes, neither is a swap (both are already starting, so
 * `buildSwaps` never proposes one), so both rows read `keep` carrying each
 * other's man. Tapping Ladd McConkey opened Kenneth Walker, and tapping Walker
 * opened McConkey — reported from a live Week 1 lineup, reproduced in
 * `lineup.verdicts.test.ts`.
 *
 * One exported function, used by the headline and by the tap, so the two cannot
 * drift apart again.
 */
export function verdictSubjectId(row: {
  verdict: SlotVerdict;
  currentPlayerId: string | null;
  recommendedPlayerId: string | null;
}): string | null {
  if (row.verdict === 'fill') return row.recommendedPlayerId ?? row.currentPlayerId;
  return row.currentPlayerId ?? row.recommendedPlayerId;
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
