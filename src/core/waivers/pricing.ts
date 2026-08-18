/**
 * Put a price on each waiver upgrade the engine found.
 *
 * The translation layer between two vocabularies. The waiver engine speaks in
 * fantasy points gained over a current starter; the bid strategy speaks in
 * shares of a budget, shelf life and contested demand. Everything below is that
 * conversion, and every input it cannot establish is passed through as the
 * module's own "unknown" rather than as a default that looks like knowledge.
 *
 * It lives here rather than beside the API handler that first needed it because
 * two callers now ask the same question and must get the same answer: the live
 * Waivers screen, and Demo Mode's fixture-backed rehearsal of it. A price the
 * demo computed differently from production would be a demonstration of
 * something the product does not do.
 */

import {
  recommendBid,
  simulateOpportunityCost,
  type BidRecommendation,
  type OpportunityCost,
  type RoleStability,
  type ShelfLife,
} from '../faab/strategy.ts';
import type { LeagueBudgetState } from '../faab/budget.ts';
import type { PriceSummary } from '../faab/bids.ts';
import type { TrendingVelocity } from '../market/trending.ts';
import { trendingHeadline } from '../market/trending.ts';
import { detectDisagreement, type Disagreement } from '../market/disagreement.ts';
import type { WaiverAdvice, WaiverCandidate, WaiverUpgrade } from '../startsit/waivers.ts';
import type { CompetitionAssessment } from '../league/competition.ts';

/**
 * What pricing needs to know about the league, and nothing more.
 *
 * A structural subset of the server's `StrategyContext` rather than that type
 * itself, so this module stays free of anything that reaches a database. Any
 * caller holding a full strategy context satisfies it by construction.
 */
export interface WaiverPricingContext {
  week: number;
  finalWeek: number;
  budget: LeagueBudgetState;
  prices: PriceSummary;
  trending: Map<string, TrendingVelocity>;
}

export type PricedBid = BidRecommendation & {
  opportunity: OpportunityCost | null;
  trending: string | null;
  disagreement: Disagreement;
};

export function priceWaiverUpgrades(opts: {
  advice: WaiverAdvice;
  strategy: WaiverPricingContext;
  rosteredIds: Set<string>;
  /**
   * Who actually needs this player and can afford him, per player.
   *
   * Absent falls back to the blunt count below. Present, it is strictly better
   * information — a league where nine rosters are funded but only two are short
   * at the position is not a league where nine people are bidding.
   */
  competition?: Map<string, CompetitionAssessment>;
}): PricedBid[] {
  const { advice, strategy } = opts;
  const season = { week: strategy.week, finalWeek: strategy.finalWeek };

  /*
   * Rosters that could plausibly want him, for the demand reading.
   *
   * A blunt count on purpose: every other funded roster in the league. A finer
   * one would need each rival's lineup scored against each candidate, which is
   * twelve times the work for a number that feeds a 0–1 demand input.
   */
  const fundedRivals = strategy.budget.rosters.filter((r) => !r.isMine && (r.remaining ?? 0) > 0).length;

  /**
   * How many rivals to price against, best available answer first.
   *
   * The assessed bidders when the league-intelligence pass has produced them;
   * the blunt funded-roster count otherwise. Capped at four either way, because
   * the demand input saturates and a league of twelve is not three times as
   * contested as a league of four.
   */
  const rivalsFor = (playerId: string): number | null => {
    const assessed = opts.competition?.get(playerId);
    if (assessed) return assessed.bidders.length > 0 ? Math.min(assessed.bidders.length, 4) : null;
    return fundedRivals > 0 ? Math.min(fundedRivals, 4) : null;
  };

  const out: PricedBid[] = [];

  /*
   * What the budget still has to buy after this claim.
   *
   * The waiver engine has already sorted the upgrades by how badly each slot
   * needs filling, so every *other* slot on that list is a call on the same
   * wallet. Naming the biggest one is what turns "recommended max $19" into
   * "recommended max $19 · preserve budget for RB depth" — the sentence that
   * explains why the recommendation sits below what he is worth.
   *
   * Null when this is the only hole, because there is then nothing to preserve
   * the money for and saying so would be inventing a rival need.
   */
  const otherNeed = (slot: string): string | null => {
    const next = advice.upgrades.find((u) => u.slot !== slot);
    if (!next) return null;
    return `${next.slot} depth`;
  };

  for (const upgrade of advice.upgrades) {
    for (const candidate of upgrade.candidates) {
      const trend = strategy.trending.get(candidate.playerId) ?? null;
      const marketHeat = trend?.heat ?? null;

      /*
       * The role assessment does double duty, for two different purposes.
       *
       * As `roleStability` it prices the bid — a role that has moved around is
       * worth less than the same points from a settled one. As `modelObserved`
       * it decides whether this app has enough of its own read to disagree with
       * the market at all: a player with no usage series behind him cannot be
       * evidence that the crowd is wrong, he is just a player nobody has
       * measured.
       */
      const role = roleStabilityOf(candidate);
      const modelObserved = candidate.score != null && candidate.role.games > 0;

      const rec = recommendBid({
        inputs: {
          playerId: candidate.playerId,
          name: candidate.name,
          position: candidate.position,
          weeklyGain: candidate.gain,
          /*
           * What the *next* candidate for the same slot would give you. The
           * list is already sorted best first, so the second name is the
           * replacement — and when there is no second name, the upgrade is
           * genuinely exclusive rather than unmeasured.
           */
          gainOverReplacement: gainOverNextBest(upgrade, candidate),
          roleStability: role,
          shelfLife: shelfLifeOf(candidate),
          futureOpportunity: 'normal',
          marketHeat,
          rivalsWithNeed: rivalsFor(candidate.playerId),
        },
        budgetState: strategy.budget,
        prices: strategy.prices,
        season,
        reserveFor: otherNeed(upgrade.slot),
      });

      out.push({
        ...rec,
        opportunity: rec.recommended != null ? simulateOpportunityCost(strategy.budget, rec.recommended) : null,
        trending: trend ? trendingHeadline(trend, { availableInLeague: !opts.rosteredIds.has(candidate.playerId) }) : null,
        disagreement: detectDisagreement({
          marketHeat,
          modelStrength: candidate.score != null ? Math.max(0, Math.min(1, candidate.gain / 6)) : null,
          modelObserved,
        }),
      });
    }
  }

  return out;
}

/** The gap between this candidate and the next one for the same slot. */
export function gainOverNextBest(
  upgrade: WaiverUpgrade,
  candidate: { playerId: string; gain: number },
): number | null {
  const others = upgrade.candidates.filter((c) => c.playerId !== candidate.playerId);
  if (others.length === 0) return null;
  const best = Math.max(...others.map((c) => c.gain));
  return Math.round((candidate.gain - best) * 100) / 100;
}

/**
 * How settled the role behind the points is.
 *
 * Read from the role assessment the waiver candidate carries, not from the prose
 * it also carries: the reasons are written for a card, and pricing a bid off a
 * phrase is one rewording away from silently changing a recommendation.
 *
 * `spike` is deliberately volatile rather than rising. One enormous week is the
 * single most common reason a player is on a waiver wire at all, and treating it
 * as a settled role is how a tool pays starter money for a touchdown.
 */
export function roleStabilityOf(candidate: WaiverCandidate): RoleStability {
  const { trend, games } = candidate.role;
  if (games === 0 || trend === 'insufficient_data') return 'unknown';
  if (trend === 'rising_high' || trend === 'rising_moderate') return 'rising';
  if (trend === 'spike' || trend === 'falling_high' || trend === 'falling_moderate') return 'volatile';
  return candidate.statusFlag ? 'volatile' : 'stable';
}

/**
 * How long the reason he is available is likely to last.
 *
 * Deliberately conservative. Only a measured, rising role is treated as a
 * season-long asset; a healthy body filling a slot nobody can start is a
 * multi-week hold; and anything the app cannot read is `unknown`, which the
 * strategy module prices as two weeks rather than as optimism.
 */
export function shelfLifeOf(candidate: WaiverCandidate): ShelfLife {
  if (candidate.role.games > 0 && (candidate.role.trend === 'rising_high' || candidate.role.trend === 'rising_moderate')) {
    return 'season';
  }
  if (candidate.reasons.some((r) => r.includes('fills a slot'))) return 'multi_week';
  return 'unknown';
}
