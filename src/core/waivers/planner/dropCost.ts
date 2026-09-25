/**
 * Who to drop — asked once per incoming player, not once per roster.
 *
 * The mistake this module exists to prevent is a single "worst player on my
 * roster" list. That list is real, it is what `roster/bench.ts` produces, and it
 * is the wrong answer to the question a waiver claim asks. The question is not
 * *who is my least valuable player*; it is *what does this roster lose by
 * cutting him, given that this specific player is arriving in his place*.
 *
 * Those come apart constantly:
 *
 *   - adding a running back makes a spare running back expendable and does
 *     nothing to the cut order at receiver;
 *   - adding a strong tight end makes the second tight end the obvious drop,
 *     where a moment earlier he was the only cover at the position;
 *   - adding a bench stash makes nobody more expendable, because it replaces
 *     nothing;
 *   - in a superflex league, adding a quarterback changes the cut order at
 *     running back, and in a one-quarterback league it does not.
 *
 * Every one of those falls out of {@link RosterSimulation.utility} without a
 * rule being written for it — see the note in `rosterState.ts` about why the
 * add-specificity is an accident of subtraction rather than a feature.
 *
 * ## The protection boundary
 *
 * A waiver claim is a small decision and it must not be able to make a large
 * one. The rule is deliberately not a hand-maintained list of untouchable
 * players: it is *cost*, plus four categorical cases where a cost is either
 * meaningless or dangerous — a man in the recommended lineup, a man on an
 * injured-reserve slot, a man the engine cannot score, and a man whose removal
 * would visibly hurt the lineup.
 *
 * The first of those is evaluated **after the add**, which matters more than it
 * looks. A starter displaced by the incoming player is no longer in the lineup
 * and is no longer protected by this rule — which is exactly right, and is how
 * a genuine upgrade claim finds its drop without anybody special-casing it.
 */

import type { RosterSimulation } from './rosterState.ts';
import { plannerExcluded } from './rosterState.ts';
import type { DropCost, ProtectionReason, WaiverReason } from './types.ts';

/**
 * Lineup points whose loss is too large for a waiver claim to cause.
 *
 * Two points a week, which is roughly the gap between a startable player and a
 * replaceable one across a season. Above it the drop is not a bench decision at
 * all — it is a decision about the shape of the roster, and a claim on a
 * mid-week waiver run is not where that gets made.
 *
 * Note what this is measured on: **the lineup after the add**. A player the
 * incoming target replaces costs the lineup nothing, so the bar never blocks
 * the upgrade it was written to allow.
 */
export const PROTECTED_LINEUP_COST = 2;

/**
 * How early a player had to be drafted before a September waiver run may not cut him.
 *
 * The top eight rounds of a ten-team league — the players a room spent real
 * draft capital on. Below that the pick is not evidence of much; above it, a
 * manager who is about to cut one is nearly always reacting to one bad
 * afternoon, which is the thing this exists to stop.
 */
export const EARLY_PICK_RANK = 80;

/**
 * The week the draft stops being the best thing known about a player.
 *
 * Six, the same count {@link DURABLE_FULL_WEIGHT_GAMES} uses for the same
 * reason: by then a sixth of a season of real production says more than an
 * August ranking does, and a player who is genuinely finished should be
 * cuttable. Before then the draft is the steadier evidence and this holds.
 */
export const EARLY_PICK_WEEKS = 6;

/**
 * Rank every rostered player by what cutting him would cost, given one add.
 *
 * Cheapest first — the drop the plan should prefer is `[0]`. Protected players
 * are returned too, with their reason and their cost where one exists, because
 * a **See Why** sheet that cannot say *why not him* is a sheet that gets
 * argued with.
 */
export function rankDropsFor(opts: {
  simulation: RosterSimulation;
  /** The player arriving. Must not already be on the roster. */
  addPlayerId: string;
  /** Roster to rank against. Defaults to the roster as it stands. */
  rosterIds?: readonly string[];
}): DropCost[] {
  const { simulation, addPlayerId } = opts;
  const rosterIds = opts.rosterIds ?? simulation.baseline.playerIds;

  const withAdd = rosterIds.includes(addPlayerId) ? [...rosterIds] : [...rosterIds, addPlayerId];
  const afterAdd = simulation.stateOf(withAdd);
  const addPosition = simulation.positionOf.get(addPlayerId) ?? null;

  const costs: DropCost[] = [];

  for (const dropId of rosterIds) {
    if (dropId === addPlayerId) continue;
    const name = simulation.nameOf.get(dropId) ?? dropId;
    const position = simulation.positionOf.get(dropId) ?? '';
    const reasons: WaiverReason[] = [];

    /*
     * A player nobody can score is not a cheap drop, he is an unknown one.
     *
     * The temptation is to treat "no data" as "no value", which produces a
     * confidently wrong cut of exactly the player the app understands least —
     * a rookie with no market, a returning starter with no props. §20 of the
     * brief is explicit that unknown is allowed, and this is the load-bearing
     * case for it.
     */
    if (simulation.unscored.has(dropId)) {
      reasons.push({ code: 'protected_unscorable', playerId: dropId, value: null });
      costs.push({
        playerId: dropId,
        name,
        position,
        cost: null,
        lineupCost: 0,
        optionValue: 0,
        standingValue: 0,
        coveredByAdd: false,
        protection: 'unscorable',
        reasons,
      });
      continue;
    }

    const afterDrop = simulation.stateOf(withAdd.filter((id) => id !== dropId));
    /*
     * Never below zero, and the clamp is an admission rather than a tidy-up.
     *
     * Removing a player cannot make a roster better. The option term can
     * occasionally say otherwise — a departing bench player stops covering
     * somebody behind him, and that man's option value rises by more than the
     * departure cost — which is an artefact of approximating a bench as a set
     * of independent options rather than a fact about football. The asymmetric
     * cover rule in `rosterState.ts` removes nearly all of it; this is the
     * floor that guarantees the remainder never reaches a recommendation.
     */
    const cost = Math.max(0, round2(afterAdd.utility - afterDrop.utility));
    const lineupCost = round2(Math.max(0, afterAdd.lineupPoints - afterDrop.lineupPoints));
    const optionValue = afterAdd.optionValueOf.get(dropId) ?? 0;

    /*
     * Whether the arrival is doing this player's job.
     *
     * Read off the option value rather than off the positions: the number
     * already contains "what would replace him", and the incoming player is on
     * the roster when it is computed. A tight end whose option value is a
     * fraction of his standing worth has been replaced by somebody, and in this
     * state that somebody is usually the add.
     */
    const standing = simulation.slotValueOf.get(dropId) ?? simulation.valueOf.get(dropId) ?? 0;
    const coveredByAdd =
      addPosition != null &&
      !afterAdd.starterIds.has(dropId) &&
      standing > 0 &&
      optionValue <= standing * COVERED_SHARE;

    const protection = protectionFor({
      simulation,
      dropId,
      inLineupAfterAdd: afterAdd.starterIds.has(dropId),
      lineupCost,
    });

    if (protection === 'in_lineup') {
      reasons.push({ code: 'protected_in_lineup', playerId: dropId, value: lineupCost });
    } else if (protection === 'market_hold') {
      const hold = simulation.marketHold.get(dropId);
      reasons.push({
        code: hold?.condition === 'trending' ? 'protected_room_is_adding' : 'protected_early_pick',
        playerId: dropId,
        value: hold?.rank ?? null,
      });
    } else if (protection === 'reserve_slot') {
      reasons.push({ code: 'protected_reserve_slot', playerId: dropId, value: null });
    } else if (protection === 'core_value') {
      reasons.push({ code: 'protected_core_value', playerId: dropId, value: lineupCost });
    } else {
      reasons.push({ code: 'drop_outside_lineup', playerId: dropId, value: null });
      if (coveredByAdd) {
        reasons.push({ code: 'drop_covered_by_add', playerId: addPlayerId, value: round2(standing - optionValue) });
      }
      if (optionValue <= 0) {
        reasons.push({ code: 'drop_at_or_below_replacement', playerId: dropId, position, value: 0 });
      }
    }

    if (lineupCost > 0 && protection == null) {
      reasons.push({ code: 'drop_costs_lineup_points', playerId: dropId, value: lineupCost });
    }

    /*
     * The cover charge, named rather than left inside the total.
     *
     * A drop that leaves a position bare shows up in `cost` automatically —
     * `BARE_POSITION_COST` is a term in the utility both sides of the
     * subtraction — but a reader looking at "$0 of lineup points and it still
     * costs 1.5" deserves to be told which position they are about to be one
     * injury short at.
     */
    for (const bare of afterDrop.barePositions) {
      if (afterAdd.barePositions.includes(bare)) continue;
      reasons.push({ code: 'drop_leaves_position_bare', playerId: dropId, position: bare, value: null });
    }

    costs.push({
      playerId: dropId,
      name,
      position,
      cost,
      lineupCost,
      optionValue: round2(optionValue),
      standingValue: round2(standing),
      coveredByAdd,
      protection,
      reasons,
    });
  }

  const ranked = costs.sort(compareDrops);

  /*
   * A protection that can cover the whole roster is not a protection.
   *
   * `market_hold` is the only one of the five that could plausibly apply to
   * every rostered player at once — a room that drafted well has a board full
   * of early picks — and when it does, the waiver lane goes silent with no
   * cause a reader can see. That is a worse failure than the one it prevents:
   * the point was never "never cut a good player", it was "do not cut a good
   * player *ahead of a worse one*".
   *
   * So it yields when it is the only thing left standing, and the cheapest of
   * them comes back onto the board. Nothing else yields: a man in the lineup,
   * one on an injured-reserve slot and one nobody can score are all facts about
   * the roster rather than judgements about a player, and none of them is
   * negotiable because the alternative is inconvenient.
   */
  const anyEligible = ranked.some((c) => c.protection == null && c.cost != null);
  if (!anyEligible) {
    const released = ranked.find((c) => c.protection === 'market_hold' && c.cost != null);
    if (released) {
      released.protection = null;
      released.reasons = released.reasons.filter(
        (r) => r.code !== 'protected_early_pick' && r.code !== 'protected_room_is_adding',
      );
      released.reasons.push({ code: 'drop_outside_lineup', playerId: released.playerId, value: null });
      return ranked.sort(compareDrops);
    }
  }

  return ranked;
}

/**
 * How much of a bench player's standing worth has to be gone before the
 * arrival is credited with replacing him.
 *
 * Half. Below that the two are cover for each other rather than one for the
 * other, and saying "the new man does his job" would be a stronger claim than
 * the arithmetic supports.
 */
const COVERED_SHARE = 0.5;

/**
 * Reasons a player is not an ordinary waiver cut.
 *
 * Ordered by how categorical they are: being in the lineup and being on an
 * injured-reserve slot are facts about the roster, and the value bar is a
 * judgement. All three are stated as a reason rather than folded into an
 * enormous cost, so the plan can say *why not him* instead of just ranking him
 * last.
 */
function protectionFor(args: {
  simulation: RosterSimulation;
  dropId: string;
  inLineupAfterAdd: boolean;
  lineupCost: number;
}): ProtectionReason | null {
  const { simulation, dropId, inLineupAfterAdd, lineupCost } = args;
  if (simulation.unscored.has(dropId)) return 'unscorable';
  if (simulation.reserveIds.has(dropId)) return 'reserve_slot';
  /*
   * A defence is not a generic drop.
   *
   * Streaming one in and out is the DST planner's decision and it turns on
   * things this module has never heard of. Reported as core value rather than
   * as a new reason code, because from a generic waiver claim's point of view
   * the two mean the same thing: not yours to cut.
   */
  if (plannerExcluded(simulation.positionOf.get(dropId))) return 'core_value';
  if (inLineupAfterAdd) return 'in_lineup';
  /*
   * A player the room drafted early is not cut in September.
   *
   * The durable-value pass already exists to stop exactly this, and on 16
   * September it did not fire for the two players reported — because this
   * league's preseason capture has 154 rows and neither of them is in it:
   *
   *     Mark Andrews          draftRank 122.2   preseason NONE
   *     Rhamondre Stevenson   draftRank  76.4   preseason NONE
   *
   * So `durableValue` fell through to in-season production, one game had been
   * played, and a bench player's standing worth was one bad afternoon again.
   * The capture is the better evidence where it exists and it is not going to
   * cover everybody; the draft ranking covers the whole board and is the other
   * half of what "preseason ADP or projection should carry real weight early"
   * asks for.
   *
   * Categorical rather than a number, because converting a draft slot into
   * points needs a curve nobody here has fitted — and "not yours to cut" is
   * what the reader actually needs said. It expires; see
   * {@link EARLY_PICK_WEEKS}.
   */
  /*
   * The market says hold him, on either of two conditions.
   *
   * One protection, not two systems. The draft condition is the one above:
   * the market spent a starter's pick on him and the season is young. The
   * trending condition is that the whole of Sleeper is adding him this week,
   * so a rival claims him the moment he is cut. Attention is not quality, and
   * neither condition says what he is worth — they say that cutting him now
   * is the kind of mistake that cannot be taken back. See `MarketHoldCondition`.
   */
  if (simulation.marketHold.has(dropId)) return 'market_hold';
  if (lineupCost >= PROTECTED_LINEUP_COST) return 'core_value';
  return null;
}

/**
 * Cheapest first, protected last, and stable.
 *
 * Protection sorts below every priced drop regardless of number, because a
 * protected player is not a cheap drop that happens to score badly — he is not
 * on offer. Ties break on the name so two runs of the same plan produce the
 * same list.
 */
function compareDrops(a: DropCost, b: DropCost): number {
  const aProtected = a.protection != null;
  const bProtected = b.protection != null;
  if (aProtected !== bProtected) return aProtected ? 1 : -1;
  const aCost = a.cost ?? Number.POSITIVE_INFINITY;
  const bCost = b.cost ?? Number.POSITIVE_INFINITY;
  if (aCost !== bCost) return aCost - bCost;
  /*
   * Ties are common and they are not noise.
   *
   * Once the floor above has flattened a handful of genuinely free drops to
   * zero, "which of these costs least" has no answer left — but "which of
   * these is worth least" still does, and it is the question the reader was
   * asking anyway. Standing worth breaks the tie before the name does, so a
   * roster filler is offered ahead of a useful backup whose cover happens to
   * make him equally free this week.
   */
  if (a.standingValue !== b.standingValue) return a.standingValue - b.standingValue;
  return a.name.localeCompare(b.name);
}

/** The drops a claim may actually use, cheapest first. */
export function eligibleDrops(costs: readonly DropCost[]): DropCost[] {
  return costs.filter((c) => c.protection == null && c.cost != null);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
