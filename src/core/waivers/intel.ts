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
import { namedBidders, type BidderIntel, type BidderTendency } from '../league/bidders.ts';
import {
  NEUTRAL_PRESSURE,
  bidderTendencyFrom,
  waiverManagerPressure,
  type WaiverManagerPressure,
} from './managerPressure.ts';
import { bidLikelihoodByRoster, type RivalBidLikelihood } from './bidLikelihood.ts';
import type { LeagueTransactionBaseline, ManagerTransactionProfile } from '../managers/transactionProfile.ts';
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
  /*
   * The slot-shaped half of the advice, and only that.
   *
   * Declared as the field it reads rather than as the whole `WaiverAdvice`,
   * because the competition read has no opinion about bench value adds or about
   * players nothing could be scored on: asking for the whole record would
   * make every future field of it a breaking change here.
   */
  advice: Pick<WaiverAdvice, 'upgrades'>;
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
  /**
   * What the manager-history ledger knows about each rival, by roster id.
   *
   * Optional in every sense: absent, the competition count and the named
   * bidders are exactly what they were before this existed, and the pressure
   * column reports "not known". Present, it adds the one thing rosters and
   * wallets cannot show — whether the people with a hole at this position are
   * the sort who actually claim, and what they usually pay.
   *
   * Keyed by *current* roster id, resolved by the caller from Sleeper user id
   * against the current roster table. That direction matters: a profile keyed
   * the other way would follow a roster slot to its next occupant.
   */
  history?: {
    profiles: ReadonlyMap<number, ManagerTransactionProfile>;
    baseline: LeagueTransactionBaseline | null;
    week: number;
    finalWeek: number;
  };
}): {
  competition: Map<string, CompetitionAssessment>;
  bidders: Map<string, BidderIntel>;
  pressure: Map<string, WaiverManagerPressure>;
  /** How much of a bidder each rival is, by roster id. Empty without history. */
  likelihood: Map<number, RivalBidLikelihood>;
} {
  const competition = new Map<string, CompetitionAssessment>();
  const bidders = new Map<string, BidderIntel>();
  const pressure = new Map<string, WaiverManagerPressure>();

  /*
   * The ledger's spending reading, translated once for the whole board rather
   * than per candidate. Same managers, same numbers, whatever position is being
   * priced — so computing it inside the loop would be the same arithmetic
   * repeated forty times.
   */
  const tendencies = new Map<number, BidderTendency>();
  for (const [rosterId, profile] of opts.history?.profiles ?? []) {
    tendencies.set(rosterId, bidderTendencyFrom(rosterId, profile));
  }

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

  /*
   * How much of a bidder each rival actually is, once for the whole board.
   *
   * Same managers and same numbers whatever position is being priced, so this
   * belongs beside the tendency translation above rather than inside the
   * candidate loop. Empty without a backfilled history, and an empty map means
   * every rival counts whole — which is what `assessCompetition` does when no
   * participation is supplied, so the two agree by construction rather than by
   * a default repeated in two places.
   */
  const likelihood = opts.history
    ? bidLikelihoodByRoster({
        rosterIds: opts.rosters.filter((r) => !r.isMine).map((r) => r.rosterId),
        profiles: opts.history.profiles,
        budgets: budgetByRoster,
        baseline: opts.history.baseline,
        budgetTotal: opts.budgets?.rule.total ?? null,
        week: opts.history.week,
        finalWeek: opts.history.finalWeek,
      })
    : new Map<number, RivalBidLikelihood>();

  const participationOf = (rosterId: number): number =>
    likelihood.get(rosterId)?.participation ?? 1;

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
              participationOf,
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
            tendencies,
          }),
        );
      }

      /*
       * And what the years say about the people who need him.
       *
       * Built from the same `assessed` the label was built from, so the count
       * of rivals in the pressure reading can never disagree with the count on
       * the pill beside it. Neutral without a backfilled history, which is the
       * correct answer for a first-season league and for one mid-backfill.
       */
      pressure.set(
        candidate.playerId,
        opts.history
          ? waiverManagerPressure({
              competition: assessed,
              profilesByRoster: opts.history.profiles,
              baseline: opts.history.baseline,
              prices: opts.prices,
              position: candidate.position,
              week: opts.history.week,
              finalWeek: opts.history.finalWeek,
            })
          : NEUTRAL_PRESSURE,
      );
    }
  }

  return { competition, bidders, pressure, likelihood };
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
  pressure?: Map<string, WaiverManagerPressure>,
): T[] {
  return upgrades.map((upgrade) => ({
    ...upgrade,
    candidates: upgrade.candidates.map((candidate) => {
      const assessed = competition.get(candidate.playerId);
      const named = bidders?.get(candidate.playerId) ?? null;
      const history = pressure?.get(candidate.playerId) ?? null;
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
        /**
         * What the rivals' own history says, as its own field.
         *
         * Deliberately beside the price rather than inside it. `competition`
         * and the bid recommendation are answers about this player and this
         * roster; this is an answer about the people in the room, it can
         * honestly differ from them, and folding it in would let a busy league
         * quietly inflate every number this app suggests. Null when no history
         * has been backfilled, which reads as "not known" and never as "quiet".
         */
        managerPressure:
          history && history.contested !== 'unknown'
            ? {
                level: history.contested,
                label: history.label,
                detail: history.detail,
                costContext: history.costContext,
                confidence: history.confidence,
                rivalsWithHistory: history.rivalsWithHistory,
              }
            : null,
      };
    }),
  }));
}
