/**
 * The whole Waivers decision, in one call.
 *
 * Eight steps, in an order that matters, and until now they were written out
 * twice: once in `server/app.ts` and once in `core/demo/runtime/handlers.ts`,
 * where the comment beside the second copy said it mirrored the first "line for
 * line". It did, which is the problem — a pipeline that is correct because two
 * files agree is a pipeline that is one careless edit from two different waiver
 * boards in one app.
 *
 * There are now three callers and the third could not have been written any
 * other way: a support snapshot is replayed through *this* function, so the
 * claim plan an agent reproduces from a file is the claim plan the phone drew.
 *
 * ## The order, and why each step is where it is
 *
 *   1. **the lineup**, because everything downstream is measured against what
 *      the roster is already worth. Computed once and passed on rather than
 *      recomputed by each consumer;
 *   2. **the wire scan** — who would actually improve it;
 *   3. **multi-week value**, scoped to the players who made the board, because
 *      a valuation for the other forty is work nobody will read. It reorders
 *      nothing;
 *   4. **league intelligence** — who else needs him and can pay. The
 *      competition count is computed here because step 5 reads it;
 *   5. **pricing** — what to bid, given that competition;
 *   6. **the defence**, which owns the DEF row outright;
 *   7. **the board**, with competition folded on and the DEF row removed
 *      wherever the planner has an opinion, so `Stream NYJ over BUF` and
 *      `Hold BUF` can never be on screen together;
 *   8. **the claims** — who to add, what to bid, who to drop, in what order to
 *      enter them.
 *
 * ## What it does not do
 *
 * It reads nothing except through {@link WaiverAssemblyRequest.dstSources},
 * which is the same three-method interface `assembleDstPlan` already took and
 * which a live caller satisfies from stored rows and a demo from a fixture.
 * Everything else arrives as a value. No provider is touched, no player is
 * rescored, no price is recomputed and nothing is written — the whole of this
 * file is arithmetic over what the caller already holds.
 *
 * The response envelope — the league name, the freshness block, the FAAB
 * summary, the demo's own scenario notes — belongs to each caller. The decision
 * is what is here.
 */

import { DEFENCE_POSITION } from '../startsit/engine.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import { recommendWaiverUpgrades, type WaiverAdvice, type WaiverUpgrade } from '../startsit/waivers.ts';
import { recommendLineup, type LineupRecommendation } from '../startsit/lineup.ts';
import { waiverMultiWeekFor } from '../contracts/integration.ts';
import { waiverLeagueIntel, withCompetition, type WaiverIntelRoster } from './intel.ts';
import { priceWaiverUpgrades, type PricedBid, type WaiverPricingContext } from './pricing.ts';
import { buildWaiverClaimPlan, type WaiverClaimPlan } from './claimPlan.ts';
import { assembleDstPlan, type DstPlanSources } from '../dst/assemble.ts';
import type { DstPlan } from '../dst/planner.ts';
import type { LeagueBudgetState } from '../faab/budget.ts';
import type { BidObservation, PriceSummary } from '../faab/bids.ts';
import type { ManagerTransactionProfile, LeagueTransactionBaseline } from '../managers/transactionProfile.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/** What the ledger knows about the rivals, in the shape the intel pass reads. */
export interface WaiverHistoryContext {
  profiles: ReadonlyMap<number, ManagerTransactionProfile>;
  baseline: LeagueTransactionBaseline | null;
  week: number;
  finalWeek: number;
}

export interface WaiverAssemblyRequest {
  shape: RosterShape;
  profile: ScoringProfile;
  /** The user's own players, assembled for the weekly engine. */
  rosterInputs: StartSitInput[];
  /** The bounded free-agent scan, likewise. */
  candidateInputs: StartSitInput[];
  /**
   * Every player on every roster in the league. The hard exclusion.
   *
   * Passed rather than derived from `rosters` so the caller's own set is the one
   * the engine checks — it is the single mistake this feature must never make,
   * and a second construction of it here would be a second chance to get it
   * wrong.
   */
  rosteredIds: Set<string>;
  currentStarterIds: string[];
  reserveIds: string[];
  /** Every roster, for the competition read. */
  rosters: WaiverIntelRoster[];
  /** The whole player table, for resolving rivals' rosters to positions. */
  players: CanonicalPlayer[];
  week: number;
  season: string;
  /** Null in a league that does not bid, which removes pricing entirely. */
  strategy: WaiverPricingContext | null;
  budgets: LeagueBudgetState | null;
  prices: PriceSummary | null;
  observations: BidObservation[];
  history?: WaiverHistoryContext | undefined;
  /**
   * The defence planner's three reads, or `null` to not plan a defence at all.
   *
   * Null is not the same as an empty plan. A league that starts no defence
   * should not have its schedule read to be told so, and `dst: null` is what
   * the DEF-row filter below reads as "the planner has no opinion" — which is
   * the state in which the generic scan is still allowed to offer a defence for
   * an empty slot.
   */
  dstSources: DstPlanSources | null;
  bestBall: boolean;
  draftComplete: boolean;
  playoff: { weeks: number[]; emphasis: number };
  now: Date;
  generatedAt?: string;
}

export interface WaiverAssembly extends WaiverAdvice {
  /** The board as drawn: competition folded on, the DEF row left to the planner. */
  upgrades: WaiverUpgrade[];
  dst: DstPlan | null;
  /** What each recommended add should cost. Empty in a league that does not bid. */
  bids: PricedBid[];
  /** The claims to enter, in order. Advisory — nothing here transacts. */
  claimPlan: WaiverClaimPlan | null;
  /**
   * The lineup the whole board was measured against.
   *
   * Returned rather than thrown away because a snapshot has to be able to show
   * what "an upgrade" was an upgrade *over*, and because the DST planner and the
   * claim planner both read it — a caller that recomputed it could be measuring
   * against a different one.
   */
  lineup: LineupRecommendation;
}

/**
 * The lineup everything downstream is measured against.
 *
 * Exported because the defence planner's bench cost is measured against it and
 * the support capture has to hand the DST adapter the *same* one — a lineup
 * rebuilt at the call site from the same inputs is the same lineup right up
 * until somebody changes one of the two.
 */
export function waiverLineup(
  request: Pick<WaiverAssemblyRequest, 'rosterInputs' | 'shape' | 'profile' | 'currentStarterIds' | 'now'>,
): LineupRecommendation {
  return recommendLineup(request.rosterInputs, request.shape, request.profile, {
    currentStarterIds: request.currentStarterIds,
    now: request.now,
  });
}

export async function assembleWaiverPlan(request: WaiverAssemblyRequest): Promise<WaiverAssembly> {
  const { shape, profile, rosterInputs, candidateInputs, rosteredIds } = request;

  const lineup = waiverLineup(request);

  const advice = recommendWaiverUpgrades({
    roster: rosterInputs,
    candidates: candidateInputs,
    shape,
    profile,
    rosteredPlayerIds: rosteredIds,
    currentStarterIds: request.currentStarterIds,
    lineup,
  });

  /*
   * What each recommended add is worth past this Sunday.
   *
   * Scoped to the players who actually made the board. It changes no ordering:
   * `compareRows` sorts on strength and gain, and a level attached here is a
   * sentence on a row that had already earned its place.
   */
  const boardIds = advice.upgrades.flatMap((upgrade) => upgrade.candidates.map((c) => c.playerId));
  const multiWeek = waiverMultiWeekFor({
    playerIds: boardIds,
    inputs: candidateInputs,
    scores: new Map(advice.upgrades.flatMap((u) => u.candidates.map((c) => [c.playerId, c.score] as const))),
    profile,
    currentWeek: request.week,
  });
  const upgradesWithValue = advice.upgrades.map((upgrade) => ({
    ...upgrade,
    candidates: upgrade.candidates.map((candidate) => {
      const value = multiWeek.get(candidate.playerId);
      return value ? { ...candidate, multiWeek: value } : candidate;
    }),
  }));

  const intel = waiverLeagueIntel({
    advice,
    rosters: request.rosters,
    players: request.players,
    shape,
    budgets: request.budgets,
    prices: request.prices,
    observations: request.observations,
    ...(request.history ? { history: request.history } : {}),
  });

  const bids = request.strategy
    ? priceWaiverUpgrades({ advice, strategy: request.strategy, rosteredIds, competition: intel.competition })
    : [];

  /*
   * The defence, decided in one place and drawn in two.
   *
   * Team and Waivers both read this response, so it is computed once here
   * rather than on each screen — which is the only way `Stream NYJ over BUF`
   * and `Hold BUF` can never be on screen at the same time in the same app.
   *
   * A failure is swallowed to null. Every other column is a complete answer to
   * a different question, and a schedule read that fell over is not a reason to
   * take the waiver board down.
   */
  const dst =
    request.dstSources == null
      ? null
      : await assembleDstPlan(request.dstSources, {
          season: request.season,
          week: request.week,
          shape,
          profile,
          bestBall: request.bestBall,
          draftComplete: request.draftComplete,
          rosterInputs,
          candidateInputs,
          lineup,
          reserveIds: request.reserveIds,
          playoff: request.playoff,
          now: request.now,
        }).catch(() => null);

  /*
   * One owner for the DEF row, and it is the planner.
   *
   * The generic scan already refuses a DEF-over-DEF swap. What it does still
   * offer is a defence for an *empty* DEF slot, and the planner can say
   * `Wait — your DEF slot is empty` about the same slot: two answers to one
   * question on one screen. The planner wins wherever it has an opinion; the
   * generic row survives only when the plan could not be computed at all.
   */
  const upgrades = withCompetition(upgradesWithValue, intel.competition, intel.bidders, intel.pressure).filter(
    (upgrade) => dst == null || !upgrade.accepts.every((p) => p === DEFENCE_POSITION),
  );

  /*
   * And the claims themselves, from what this function is already holding.
   *
   * A failure is swallowed to an unsurfaced plan, on the same principle as the
   * defence above.
   */
  const claimPlan = (() => {
    try {
      return buildWaiverClaimPlan({
        roster: rosterInputs,
        candidates: candidateInputs,
        advice: { ...advice, upgrades, dst, faab: { bids } },
        shape,
        profile,
        reserveIds: request.reserveIds,
        budget: request.budgets,
        now: request.now,
        ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
      });
    } catch {
      return null;
    }
  })();

  return { ...advice, upgrades, dst, bids, claimPlan, lineup };
}
