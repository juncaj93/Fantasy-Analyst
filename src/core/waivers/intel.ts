/**
 * Who else in the league wants each waiver candidate, and can pay for him.
 *
 * `WaiverLeagueIntel` declares three columns. `core/faab` fills the price and
 * `core/value/multiWeek.ts` fills the multi-week column, so what is left is
 * competition: how many rivals have a hole at the position and can afford to
 * bid on it.
 *
 * It answers from rosters already loaded — no extra query, no lineup scoring —
 * and hands the same count to the price model, which asks for exactly this
 * number and had been estimating it league-wide.
 *
 * It sits in `core` rather than beside the API handler that first needed it for
 * the same reason `pricing.ts` does: two callers now ask this question — the
 * live Waivers screen and Demo Mode's fixture-backed rehearsal of it — and a
 * demo that assessed competition differently from production would be a
 * demonstration of something the product does not do.
 */

import { isRuledOut, normalizeDesignation } from '../injury/model.ts';
import {
  COMPETITION_UNKNOWN,
  assessCompetition,
  teamNeedsFor,
  type CompetitionAssessment,
} from '../league/competition.ts';
import type { LeagueBudgetState, RosterBudget } from '../faab/budget.ts';
import type { BidObservation, PriceSummary } from '../faab/bids.ts';
import { namedBidders, type BidderIntel } from '../league/bidders.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { RosterShape } from '../sleeper/scoring.ts';
import type { WaiverAdvice } from '../startsit/waivers.ts';

/**
 * What the assessment needs to know about a roster, and nothing more.
 *
 * A structural subset of the server's roster record rather than that type
 * itself, so this module stays free of anything that reaches a database. Any
 * caller holding a full record satisfies it by construction.
 */
export interface WaiverIntelRoster {
  rosterId: number;
  ownerName?: string | null;
  isMine: boolean;
  playerIds: string[];
}

export function waiverLeagueIntel(opts: {
  advice: WaiverAdvice;
  rosters: WaiverIntelRoster[];
  players: CanonicalPlayer[];
  shape: RosterShape;
  budgets: LeagueBudgetState | null;
  prices: PriceSummary | null;
  /**
   * Every bid this league has published, for the named-rival pass.
   *
   * Optional: without it the competition count is unchanged and the names are
   * simply withheld, which is the same degradation as a league with no history.
   */
  observations?: BidObservation[];
}): { competition: Map<string, CompetitionAssessment>; bidders: Map<string, BidderIntel> } {
  const competition = new Map<string, CompetitionAssessment>();
  const bidders = new Map<string, BidderIntel>();

  const teams = opts.rosters.map((r) => ({
    rosterId: r.rosterId,
    displayName: r.ownerName ?? `Roster ${r.rosterId}`,
    isMine: r.isMine,
    playerIds: r.playerIds,
  }));

  /*
   * Availability, through the same reading the rest of the app uses.
   *
   * A rival's own players are not evaluated here — that would be the twelve
   * lineup optimisations this deliberately avoids — so the designation on the
   * player record is normalized by `core/injury/model.ts` rather than compared
   * against a private list of status strings. One definition of "ruled out",
   * everywhere.
   */
  const meta = new Map<string, { position: string | null; unavailable?: boolean }>();
  for (const p of opts.players) {
    meta.set(p.id, {
      position: p.position || null,
      unavailable: isRuledOut(normalizeDesignation(p.status).designation),
    });
  }

  const budgetByRoster = new Map<number, RosterBudget>(
    (opts.budgets?.rosters ?? []).map((r) => [r.rosterId, r] as const),
  );
  const bidding = opts.budgets?.rule.usesFaab === true;
  const needsByPosition = new Map<string, ReturnType<typeof teamNeedsFor>>();

  for (const upgrade of opts.advice.upgrades) {
    for (const candidate of upgrade.candidates) {
      if (!needsByPosition.has(candidate.position)) {
        needsByPosition.set(candidate.position, teamNeedsFor(candidate.position, teams, meta, opts.shape));
      }
      const needs = needsByPosition.get(candidate.position)!;

      const assessed =
        needs.length === 0
          ? COMPETITION_UNKNOWN
          : assessCompetition({
              needs,
              budgets: budgetByRoster,
              // The 25th percentile of winning bids: what it has taken to win at
              // the cheap end of this league, and so the floor a rival has to
              // clear to be in on him at all. Null in an unpriced league, where
              // nobody is excluded for affordability.
              expectedLow: opts.prices?.low ?? null,
              bidding,
              position: candidate.position,
            });
      competition.set(candidate.playerId, assessed);

      /*
       * And which of those rivals, by name.
       *
       * Built from the same bidder list the label was built from, so the two can
       * never disagree about how many there are. The amounts decompose the
       * league price rather than adding to it — see the header of
       * `core/league/bidders.ts` for why that direction is the whole design.
       */
      if (needs.length > 0) {
        bidders.set(
          candidate.playerId,
          namedBidders({
            competition: assessed,
            needs,
            observations: opts.observations ?? [],
            prices: opts.prices,
            rule: opts.budgets?.rule ?? { total: null, usesFaab: bidding, provenance: 'not read' },
            position: candidate.position,
          }),
        );
      }
    }
  }

  return { competition, bidders };
}

/**
 * Attach competition to the rows the board reads, leaving everything else alone.
 *
 * Deliberately a fold over rows another pass already built, rather than a
 * rebuild: multi-week value arrives the same way from its own supplier, and two
 * passes that each reconstructed the candidate list would eventually disagree
 * about who is on it.
 */
export function withCompetition<T extends { candidates: { playerId: string }[] }>(
  upgrades: T[],
  competition: Map<string, CompetitionAssessment>,
  bidders?: Map<string, BidderIntel>,
): T[] {
  return upgrades.map((upgrade) => ({
    ...upgrade,
    candidates: upgrade.candidates.map((candidate) => {
      const assessed = competition.get(candidate.playerId);
      const named = bidders?.get(candidate.playerId) ?? null;
      return {
        ...candidate,
        competition: assessed
          ? {
              level: assessed.level,
              label: assessed.label,
              /*
               * The named summary replaces the count when there is one.
               *
               * `3 likely bidders · Joe, Ryan +1` says everything the count did
               * and one thing more, in the same space — the row does not grow.
               * When names are withheld the original detail stands.
               */
              detail: named?.namesShown ? (named.summary ?? assessed.detail) : assessed.detail,
            }
          : null,
        /** The expanded view. Null when the evidence does not support naming anybody. */
        bidders: named?.namesShown ? named.named : null,
        biddersWithheld: named && !named.namesShown ? named.notes : null,
      };
    }),
  }));
}
