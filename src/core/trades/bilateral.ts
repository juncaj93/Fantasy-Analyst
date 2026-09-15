/**
 * Smart Bilateral Trades: offers that help you, that they could defend, and
 * that this particular manager has shown behaviour consistent with.
 *
 * The existing trade board answers "whose news is moving", which is discovery.
 * The ladder answers "what should I pay for him", which is negotiation. Neither
 * answers the question a manager actually opens the app with — *given my roster,
 * their roster, and who they are, what should I offer whom* — and that is the
 * whole of this module.
 *
 * ## Three questions, kept apart on purpose
 *
 * Every surfaced offer passes three conceptual gates, and the reason they are
 * three rather than one composite is that collapsing them is exactly what makes
 * trade tools useless. A reader cannot tell a deal that helps them a lot and
 * helps the partner slightly from one that is even and pointless if both arrive
 * as "grade: B+".
 *
 *   1. **Does this help me?** {@link OfferEvaluation.user}, in starting-lineup
 *      points from the app's own optimiser.
 *   2. **Is this defensible for them?** {@link OfferEvaluation.counterparty} —
 *      and *defensible* is a stronger claim than *even*. §13: a mathematically
 *      even deal with no roster logic behind it should not rank highly.
 *   3. **Is there evidence this manager may entertain this shape of deal?**
 *      {@link OfferEvaluation.managerFit}, bounded by `MANAGER_FIT_CAP` and
 *      applied last.
 *
 * ## What behaviour may and may not do
 *
 * History ranks and tiebreaks. It never rewrites objective value and it can
 * never rescue a trade the objective gates rejected — the rejections happen in
 * {@link screen}, before a manager profile is read at all, so the property holds
 * by construction rather than by the size of a constant.
 *
 * ## Bounded by construction
 *
 * §7 and §26 both insist on this, and it is enforced in two stages:
 * {@link generateCandidates} enumerates a documented, capped number of shapes
 * against cheap objective value only, and the optimiser — the expensive part —
 * runs on the survivors of that pruning and nothing else. There is no branch in
 * this file whose cost grows with the fourth power of a roster.
 *
 * Pure. It suggests and explains; it never sends, negotiates, or contacts
 * anybody.
 */

import { MANAGER_FIT_CAP, managerFitFor, type ActivityClass, type ManagerFit, type ManagerFitInput } from './managerFit.ts';
import type { ArbitrageRead } from './arbitrage.ts';
import type { OfferCategory } from './category.ts';
import { tradeExcluded, type RosterDelta, type RosterView } from './rosterUtility.ts';

// ------------------------------------------------------------- the bounds --

/**
 * The search bounds, in one object so a test can pin them and a probe can print
 * them.
 *
 * These are the numbers that make the difference between an assistant and a
 * combinatorial explosion. A twelve-team league with sixteen-man rosters offers
 * roughly 11 × 16 × 16 one-for-ones before packages are considered; enumerating
 * every subset for every subset runs to millions, and the deals a human actually
 * sends are small ones.
 */
export const TRADE_BOUNDS = {
  /** Their players considered as targets, per partner, best fit first. */
  targetsPerPartner: 6,
  /** My players considered as the main piece, best fit for them first. */
  givePerPartner: 6,
  /** Candidates that survive cheap pruning and reach the optimiser, per partner. */
  scoredPerPartner: 12,
  /** Offers kept per partner after full scoring. */
  offersPerPartner: 2,
  /** Offers surfaced in total. A few sharp ideas, per §33. */
  offersTotal: 5,
  /** Players on one side of a package. Two is a package; three is a spreadsheet. */
  maxPackageSize: 2,
} as const;

/** The bounds, loosened so a caller may override one without restating them. */
export type TradeBounds = Record<keyof typeof TRADE_BOUNDS, number>;

// -------------------------------------------------------------- the gates --

/**
 * Objective value gap, as a share of the larger side, at which each band begins.
 *
 * Bands rather than a number, per §8 — "classify useful ranges without false
 * precision". The app has no market price for a rostered player, and printing
 * "this trade is 4.2% in your favour" would be a precision nothing under it
 * supports.
 *
 * `outside` is the hard objective sanity boundary of §8 and §12. Nothing —
 * manager history least of all — may carry an offer across it.
 */
export const FAIRNESS_BANDS = { even: 0.1, edge: 0.25 } as const;

/**
 * Starting-lineup points the user must gain before an offer is worth showing.
 *
 * Matched to `MIN_SWAP_GAIN` in the lineup module, which is the app's existing
 * answer to "how much is worth changing something for". A trade that moves the
 * weekly lineup less than a bench swap does is not a trade idea.
 */
export const MIN_USER_GAIN = 1;

/**
 * The same bar, for a trade that is not trying to fix this week's lineup.
 *
 * {@link MIN_USER_GAIN} asks "does this improve the lineup enough to be worth
 * changing something", and for an upgrade that is the whole question. For a
 * buy-low it is the wrong question asked confidently: acquiring a player who is
 * running four points a game under his draft price is a bet on the rest of the
 * season, and it very often moves this Sunday's starting lineup by nothing at
 * all. Suppressing it for that is the gate doing the opposite of its job.
 *
 * So arbitrage offers are held to this instead: the lineup may not get
 * materially *worse*. Zero would be too strict — a buy-low is frequently a
 * small, deliberate short-term cost — and anything much below this would let
 * the board recommend giving up a real starting slot for a theory. Half a point
 * is under the bench-swap threshold the upgrade bar is matched to, which is the
 * honest way to say "this week is allowed to be a wash".
 *
 * **Every other gate is untouched.** The value range, the legality of both
 * lineups, the material-harm bar and the counterparty's own roster logic all
 * apply exactly as they do to an upgrade — see `evaluate`, where this is the
 * only branch arbitrage takes.
 */
export const MIN_ARBITRAGE_USER_GAIN = -0.5;

/*
 * The category and its label live in `./category.ts`, which imports nothing.
 *
 * Re-exported here so this module stays the one place a caller needs, and
 * defined there because the Trades screen needs the label and nothing else —
 * and an import of this file from the render path drags the whole engine into
 * the chunk every page load fetches. See that file's header for the 25KB.
 */
export { CATEGORY_LABELS, type OfferCategory } from './category.ts';

/**
 * Extra offers per partner, by how often that manager actually trades.
 *
 * Alex, 15 September 2026: *managers who trade often should receive a higher
 * volume of suggested trades, and those trades should lean toward what benefits
 * me even if only mildly fair to the other side — a frequent trader is more
 * likely to engage with an imperfect-but-plausible offer than a rare trader is
 * with a perfect one.*
 *
 * The first half of that is this table, and it is the half the previous round
 * did not do: {@link MANAGER_FIT_CAP} was raised to 0.18 so activity could move
 * the *ordering*, but the per-partner cap stayed at two for everybody, so an
 * active manager could not actually receive more ideas — only better-placed
 * ones. A board of five that reaches five people is not the board Alex asked
 * for.
 *
 * Bounded at four, and `unknown` gets exactly what it got before. §10's rule
 * holds: an unmeasured manager is not a measured non-trader, and he must not be
 * penalised for a backfill nobody has run.
 */
export const OFFERS_BY_ACTIVITY: Record<ActivityClass, number> = {
  active: 4,
  selective: 3,
  unknown: 2,
  low_activity: 1,
  effectively_inactive: 1,
};


/**
 * Slots on the board an arbitrage read may claim before the ranking runs.
 *
 * Two of five. Enough that a genuine buy-low and a genuine sell-high can both
 * be seen on a week when the lineup also has holes to fix, and few enough that
 * the board does not become a theory page: three of five arbitrage offers would
 * be a board that had stopped answering "what should I do about my lineup".
 *
 * Unused unless there is something to put in them. A week with no arbitrage
 * read spends none of them and the board is exactly what it was.
 */
export const ARBITRAGE_RESERVED_SLOTS = 2;

/**
 * What a full-strength arbitrage read is worth in the pruning order, in points.
 *
 * `generateCandidates` ranks by expected lineup upgrade and keeps
 * `scoredPerPartner` of them, so a candidate whose whole case is that a player
 * is mispriced ranks near zero and is dropped before it is ever scored. Five
 * points is roughly what a genuinely useful upgrade is worth on that scale,
 * which puts a strong arbitrage package among the ordinary candidates rather
 * than above them — it is competing for the shortlist, not skipping it.
 *
 * Note this is a *pruning* number and nothing else. It never reaches the
 * composite, the fairness band or any gate; the worst it can do is spend one of
 * twelve optimiser runs on a package that is then rejected like any other.
 */
export const ARBITRAGE_PRIORITY_POINTS = 5;

/**
 * Where a full-strength arbitrage read sits on the user-benefit scale.
 *
 * The benefit term is `starterGain / REFERENCE_GAIN`, so an upgrade worth three
 * points of weekly lineup scores 0.6. Reading a full-strength arbitrage at 1
 * would put every buy-low above every real upgrade on the board — which is not
 * what Alex asked for and is not defensible either: a bet on the rest of the
 * season is a genuinely less certain claim than three points this Sunday, and
 * the composite should say so.
 *
 * At 0.4 a maximal read ranks like a two-point upgrade — comfortably worth
 * seeing, routinely beaten by a real one. Visibility is not what this number is
 * for: {@link ARBITRAGE_RESERVED_SLOTS} guarantees that separately, which is
 * exactly why this one is free to be honest about relative confidence instead
 * of being tuned to get the category onto the screen.
 *
 * It was 0.6 for an afternoon, and the case that moved it is worth recording:
 * a read placed on a player who was *already* a good upgrade target produced
 * two packages for the same man, one worth 2.9 points of lineup and one worth
 * nothing this week, and the board surfaced the second. Two offers for one
 * player are deduplicated by score, so the scale is what decides which survives
 * — and when the same player is reachable both ways, the way that also wins
 * the week has to be the one that shows.
 */
export const ARBITRAGE_BENEFIT_SCALE = 0.4;

/**
 * Optimiser runs held back for arbitrage candidates, per partner.
 *
 * Three of `scoredPerPartner`'s twelve. The expensive stage of this search is
 * the lineup optimiser and it runs twice per scored candidate, so this is the
 * one arbitrage constant that costs measurable work — six extra lineup passes
 * per partner, and only in a league that has arbitrage reads at all.
 *
 * Three rather than one because the package shapes that suit a buy-low are the
 * ones the priority ordering likes least, so a single reserved slot would often
 * hold the least sensible of them. Nine ordinary candidates is still more than
 * the search has ever needed to find its two offers per partner.
 */
export const ARBITRAGE_SCORED_SLOTS = 3;

/**
 * Points of lineup loss to the partner past which the offer harms them.
 *
 * A deal a manager would look at and decline is not an idea, it is a way of
 * spending the one conversation you get with him. Below this the deal is
 * lineup-neutral for them and has to earn its place on roster logic instead.
 */
export const MATERIAL_HARM = 0.75;

/** User gain at which the benefit term is considered maxed out, for scoring. */
export const REFERENCE_GAIN = 5;

/**
 * Ranking weights, per §15's order. They sum to one before manager fit.
 *
 * **Evidence confidence is not a term here, and that is deliberate.** §15 lists
 * it as a ranking criterion and it is one — but it is applied where it belongs,
 * scaling the strength of every behavioural claim inside `managerFitFor`, and
 * counting it a second time as its own weight was a real defect rather than a
 * design choice.
 *
 * Two things were wrong with it. It double-counted: a well-evidenced manager's
 * fit terms were already multiplied by his confidence, and then his confidence
 * was added again. And it punished the wrong party — an unmeasured manager
 * scores zero confidence, so a league nobody has backfilled had every offer
 * ranked *below* an identical one in a league that had been, by up to 0.10.
 * That is larger than {@link MANAGER_FIT_CAP} and it is the opposite of §10's
 * requirement that unknown stay neutral.
 *
 * With it gone, the total influence of manager history on the ordering is
 * exactly the cap, in one channel, and an unknown manager costs nothing at all.
 */
export const RANK_WEIGHTS = {
  user: 0.45,
  fairness: 0.2,
  counterparty: 0.3,
  simplicity: 0.05,
} as const;

// --------------------------------------------------------------- the types --

export type FairnessBand = 'even' | 'edge_user' | 'edge_opponent' | 'outside_range';

export const FAIRNESS_LABELS: Record<FairnessBand, string> = {
  even: 'Roughly even',
  edge_user: 'Slight value edge to you',
  edge_opponent: 'Slight value edge to them',
  outside_range: 'Outside recommendation range',
};

export interface OfferPlayer {
  playerId: string;
  name: string;
  position: string;
  /** Objective value: the comparable start/sit score. */
  value: number;
}

export interface Fairness {
  band: FairnessBand;
  label: string;
  /** Objective value the user receives. */
  incoming: number;
  /** Objective value the user sends. */
  outgoing: number;
  /** Signed share of the larger side. Positive favours the user. */
  gap: number;
}

/** What a swap does to one side, in that side's own terms. */
export interface SideOutcome {
  /** Starting-lineup points gained. The leading term for the user. */
  starterGain: number;
  depthChange: number;
  entersLineup: OfferPlayer[];
  displaced: string[];
  opensSlot: boolean;
  /** Roster-shaped reasons this side would do the deal. */
  rationales: RosterRationale[];
}

/** Why a roster, specifically, has a reason to say yes. §13's list. */
export type RosterRationale =
  | 'fills_hole'
  | 'upgrades_starter'
  | 'surplus_for_need'
  | 'consolidates_depth'
  | 'spreads_depth'
  | 'no_worse_hole';

export const RATIONALE_TEXT: Record<RosterRationale, string> = {
  fills_hole: 'fills a starting slot they cannot currently cover',
  upgrades_starter: 'upgrades a starting slot',
  surplus_for_need: 'turns positional surplus into a need',
  consolidates_depth: 'consolidates depth into one better starter',
  spreads_depth: 'turns one player into two actual starters',
  no_worse_hole: 'moves surplus without opening a worse hole',
};

export interface OfferEvaluation {
  /** Stable within one run: partner, give, get. Used for dedup and for keys. */
  id: string;
  /**
   * Which reasoning produced this offer, so a reader can judge it as that kind.
   *
   * `upgrade` unless an arbitrage read is what let it through the user-benefit
   * gate — see {@link MIN_ARBITRAGE_USER_GAIN}. An offer that clears the
   * ordinary bar on its own stays an upgrade even when it happens to involve a
   * buy-low target, because then the arbitrage is not what is carrying it and
   * labelling it as such would be claiming reasoning the board did not use.
   */
  category: OfferCategory;
  /**
   * The arbitrage reads behind a `buy_low` or `sell_high` offer, in strength
   * order. Empty on an upgrade.
   */
  arbitrage: ArbitrageRead[];
  partner: TradePartnerView;
  /** What the user sends. */
  give: OfferPlayer[];
  /** What the user receives. */
  get: OfferPlayer[];
  fairness: Fairness;
  user: SideOutcome;
  counterparty: SideOutcome;
  managerFit: ManagerFit;
  /**
   * The internal composite the ordering rests on.
   *
   * **No screen may print this.** §15 is explicit: an internal deterministic
   * composite is fine and the UI must not expose an unexplained magic score. It
   * is carried so a probe can explain an ordering and a test can pin one.
   */
  score: number;
  /** Every term behind `score`, for the probe and for an auditing human. */
  breakdown: {
    user: number;
    fairness: number;
    counterparty: number;
    simplicity: number;
    managerFit: number;
    total: number;
  };
  /** Compact explanation atoms, strongest first. §16. */
  reasons: string[];
  /** What is weak about it, in the same neutral vocabulary. */
  caveats: string[];
  /** One line for a collapsed row: the net benefit. */
  headline: string;
}

export interface TradePartnerView {
  /** The roster view key — the roster id, as a string. */
  key: string;
  rosterId: number;
  displayName: string;
  userId: string | null;
}

/** A candidate before any optimiser has run on it. */
export interface TradeCandidatePackage {
  partnerKey: string;
  give: string[];
  get: string[];
  /** Cheap objective-value-only ordering key, for the pruning stage. */
  priority: number;
  /**
   * True when this package acquires a buy-low or sheds a sell-high.
   *
   * Carried rather than recomputed at the cut below, because the cut is the
   * third and last place the need-shaped pipeline has to be told about a trade
   * that is not about need — and the one where getting it wrong is invisible:
   * the candidate is enumerated, ranked, and then silently dropped before any
   * gate has an opinion about it.
   */
  arbitrage: boolean;
}

/** Why a candidate never became an offer. Every rejection is nameable. */
export type RejectionReason =
  | 'value_gap_outside_range'
  | 'user_benefit_negligible'
  | 'harms_counterparty'
  | 'no_counterparty_logic'
  | 'opens_hole_for_user'
  | 'opens_hole_for_counterparty'
  | 'duplicate_package'
  | 'unscorable_player'
  | 'no_plausible_use'
  | 'pruned_by_bound';

export interface Rejection {
  partnerKey: string;
  give: string[];
  get: string[];
  reason: RejectionReason;
  detail: string;
}

export interface BilateralReport {
  offers: OfferEvaluation[];
  /** Candidates enumerated before the optimiser ran. */
  generated: number;
  /** Candidates that survived cheap pruning and were fully scored. */
  scored: number;
  /** Offers that passed every gate, before the surfacing cap. */
  viable: number;
  rejections: Rejection[];
  /** Partners evaluated at all. */
  partners: number;
  notes: string[];
}

export interface BilateralInput {
  /** The user's own roster. */
  me: RosterView;
  partners: { view: RosterView; partner: TradePartnerView; fit: Omit<ManagerFitInput, 'offer'> }[];
  bounds?: Partial<TradeBounds>;
  /**
   * Buy-low and sell-high reads, by player id, for every roster in the league.
   *
   * Absent or empty and this module behaves exactly as it did before: every
   * offer is an `upgrade`, every offer clears {@link MIN_USER_GAIN} on its own,
   * and no category label appears anywhere. That is the property that makes
   * this safe to add to a shipped board — the arbitrage lane is additive, and a
   * deployment with no preseason projection imported never opens it.
   *
   * See `core/trades/arbitrage.ts` for what a read is and is not.
   */
  arbitrage?: ReadonlyMap<string, ArbitrageRead>;
}

// ---------------------------------------------------------------- the work --

/**
 * Find the few offers worth putting in front of a person.
 *
 * The pipeline is deliberately linear and each stage is separately testable:
 * generate under a cap, screen on the objective gates, score what survives,
 * read the manager last, rank, then surface a handful.
 */
export function findBilateralTrades(input: BilateralInput): BilateralReport {
  const bounds = { ...TRADE_BOUNDS, ...input.bounds };
  const arbitrage = input.arbitrage ?? new Map<string, ArbitrageRead>();
  const rejections: Rejection[] = [];
  const notes: string[] = [];
  const offers: OfferEvaluation[] = [];

  let generated = 0;
  let scored = 0;

  for (const { view, partner, fit } of input.partners) {
    const candidates = generateCandidates({
      me: input.me,
      them: view,
      partnerKey: partner.key,
      bounds,
      rejections,
      arbitrage,
    });
    generated += candidates.length;

    /*
     * The cut that makes this affordable.
     *
     * Everything above ran on objective values alone — a sum and a subtraction
     * per candidate. Everything below runs the lineup optimiser twice, and it
     * only ever runs on this many. The dropped candidates are counted rather
     * than silently discarded, because "we bounded coverage here" is a fact the
     * probe has to be able to report.
     */
    /*
     * …and the cut reserves room for arbitrage the same way everything else
     * downstream does.
     *
     * The boost above puts an arbitrage package among the ordinary candidates
     * and that turned out not to be enough, for a reason worth writing down:
     * `priority` is `target.upgrade + give.useful`, and `give.useful` is *how
     * much the partner is helped*. The package the pruner therefore likes best
     * for any target is the one that overpays for him — which is precisely the
     * wrong package for a buy-low, where the whole idea is to acquire him
     * cheaply. Measured on this module's fixture: the sensible bench-for-bench
     * buy-low ranked seventeenth of fifty, and four packages that gave up a
     * starter for the same player ranked above it and were all rejected.
     *
     * Retuning the priority to punish overpaying would be tuning a heuristic to
     * hit one fixture. Reserving a few of the twelve is the same bounded,
     * stated move this file already makes at the partner cap and the board cap,
     * and the cost is explicit: at most {@link ARBITRAGE_SCORED_SLOTS} extra
     * optimiser runs, only in a league that has arbitrage reads at all.
     */
    const survivors = withArbitrage({
      ranked: candidates,
      extra: candidates.filter((c) => c.arbitrage),
      cap: bounds.scoredPerPartner,
      reserve: ARBITRAGE_SCORED_SLOTS,
    });
    if (candidates.length > survivors.length) {
      rejections.push({
        partnerKey: partner.key,
        give: [],
        get: [],
        reason: 'pruned_by_bound',
        detail: `${candidates.length - survivors.length} lower-priority candidate(s) dropped before scoring`,
      });
    }
    scored += survivors.length;

    const evaluated: OfferEvaluation[] = [];
    for (const candidate of survivors) {
      const offer = evaluate({ candidate, me: input.me, them: view, partner, fit, rejections, arbitrage });
      if (offer) evaluated.push(offer);
    }

    /*
     * Two per partner, and never two built on the same target player.
     *
     * §24 names repeated near-duplicates as a real-league failure, and this is
     * where they come from: the same good target with a different filler is one
     * idea wearing two hats. Deduplicating on the target rather than on the
     * whole package is what actually removes them.
     */
    /*
     * How many ideas this particular manager is worth sending.
     *
     * Two for everybody was the rule, and it is the rule that made the previous
     * round's frequency weighting only half a change: an active trader's offers
     * were ranked higher and there were still exactly two of them. See
     * {@link OFFERS_BY_ACTIVITY}.
     *
     * Read from the same `managerFitFor` the ordering reads, on the manager
     * rather than on any one offer — `evaluated[0]` carries it because every
     * offer against one partner shares one partner. A partner with no surviving
     * offer needs no cap at all.
     */
    const perPartner = Math.max(
      1,
      Math.min(
        bounds.offersPerPartner === TRADE_BOUNDS.offersPerPartner
          ? (OFFERS_BY_ACTIVITY[evaluated[0]?.managerFit.activity ?? 'unknown'] ?? bounds.offersPerPartner)
          : bounds.offersPerPartner,
        bounds.offersTotal,
      ),
    );

    const kept: OfferEvaluation[] = [];
    const usedTargets = new Set<string>();
    const keep = (offer: OfferEvaluation, limit: number): void => {
      if (kept.length >= limit) return;
      const targets = offer.get.map((p) => p.playerId);
      if (targets.some((id) => usedTargets.has(id))) {
        rejections.push({
          partnerKey: partner.key,
          give: offer.give.map((p) => p.playerId),
          get: targets,
          reason: 'duplicate_package',
          detail: 'a stronger offer for the same player is already listed',
        });
        return;
      }
      for (const id of targets) usedTargets.add(id);
      kept.push(offer);
    };

    /*
     * The same tail reservation the board makes, made per partner as well.
     *
     * Reserving room on the board achieves nothing if the offer never reaches
     * it, and this cap is where it would not: two per partner, both taken by
     * upgrades, and a buy-low against the one manager who holds the
     * underperforming player is dropped before the board has an opinion. In a
     * twelve-team league there is usually room elsewhere; against the partner
     * who happens to hold both, there is not, and that is the partner it
     * matters for.
     *
     * Upgrades still go first and still keep their order. The last slot is the
     * only one held back, and only when there is an arbitrage offer to put in
     * it.
     */
    const ranked = evaluated.sort(compareOffers);
    const arbitrageHere = ranked.filter((offer) => offer.category !== 'upgrade');
    const upgradeRoom = arbitrageHere.length > 0 ? Math.max(1, perPartner - 1) : perPartner;

    for (const offer of ranked) keep(offer, upgradeRoom);
    for (const offer of arbitrageHere) if (!kept.includes(offer)) keep(offer, perPartner);
    for (const offer of ranked) if (!kept.includes(offer)) keep(offer, perPartner);
    offers.push(...kept);
  }

  const ranked = offers.sort(compareOffers);

  /*
   * Five *different* ideas, not one idea offered to five people.
   *
   * The per-partner dedup above cannot see this: "give Amon-Ra to Dermot" and
   * "give Amon-Ra to Kim" are distinct packages against distinct rosters, and
   * both are legitimately generated. But a reader has one Amon-Ra, so the second
   * is not a second idea — it is the same decision with a different name on it,
   * and a board of five that is really two is exactly the repeated-near-duplicate
   * failure §24 names.
   *
   * So a surfaced offer may not share *any* player with a better one. The best
   * home for each player survives and the alternatives drop, which is the same
   * rule the per-partner pass applies, widened to the board.
   */
  const surfaced: OfferEvaluation[] = [];
  const spoken = new Set<string>();
  const take = (offer: OfferEvaluation): boolean => {
    if (surfaced.length >= bounds.offersTotal) return false;
    const involved = [...offer.give, ...offer.get].map((p) => p.playerId);
    if (involved.some((id) => spoken.has(id))) {
      rejections.push({
        partnerKey: offer.partner.key,
        give: offer.give.map((p) => p.playerId),
        get: offer.get.map((p) => p.playerId),
        reason: 'duplicate_package',
        detail: 'a better offer for one of these players is already listed',
      });
      return false;
    }
    for (const id of involved) spoken.add(id);
    surfaced.push(offer);
    return true;
  };

  /*
   * Arbitrage is given room at the tail of the board, not the head of it.
   *
   * Without some reservation the category is real and unreachable: an arbitrage
   * offer's composite is built from a read's strength rather than from weekly
   * lineup points, so on a roster that *does* have holes the upgrades out-score
   * it, and a board of five would be five upgrades on exactly the weeks a
   * buy-low is most interesting — the suppression Alex asked to have removed,
   * arriving by a different door.
   *
   * But reserving the *front* of the board was worse than the problem. Measured
   * on this module's own fixture: a sell-high on a player who also appeared in
   * a 4.9-point upgrade took the first slot, and the board-wide one-idea-per-
   * player rule then dropped the upgrade — trading a real five points for a
   * theory about the same man.
   *
   * So the ordinary ranking fills the board first and is only held back from
   * the last {@link ARBITRAGE_RESERVED_SLOTS}, which arbitrage may then claim.
   * Upgrades keep their order and their precedence; arbitrage gets a floor
   * rather than a ceiling on somebody else. A week with no arbitrage read
   * reserves nothing and produces byte-identical output.
   */
  const arbitrageOffers = ranked.filter((offer) => offer.category !== 'upgrade');
  const reserved = Math.min(ARBITRAGE_RESERVED_SLOTS, arbitrageOffers.length, bounds.offersTotal - 1);
  const upgradeRoom = Math.max(0, bounds.offersTotal - Math.max(0, reserved));

  for (const offer of ranked) {
    if (surfaced.length >= upgradeRoom) break;
    take(offer);
  }
  for (const offer of arbitrageOffers) {
    if (surfaced.length >= bounds.offersTotal) break;
    if (surfaced.includes(offer)) continue;
    take(offer);
  }
  for (const offer of ranked) {
    if (surfaced.length >= bounds.offersTotal) break;
    if (surfaced.includes(offer)) continue;
    take(offer);
  }

  if (input.partners.length === 0) {
    notes.push('No other rosters were available to trade with.');
  } else if (surfaced.length === 0) {
    /*
     * §18: say so, and do not manufacture filler.
     *
     * The distinction between the two sentences is worth keeping: a roster with
     * nothing to fix is a different situation from one whose league has nothing
     * to offer, and a reader can act on the second.
     */
    notes.push(
      hasNeed(input.me)
        ? 'No bilateral trade in this league currently helps both sides enough to be worth proposing.'
        : 'Your lineup has no meaningful hole to trade for right now.',
    );
  }

  return {
    offers: surfaced,
    generated,
    scored,
    viable: ranked.length,
    rejections,
    partners: input.partners.length,
    notes,
  };
}

/**
 * Merge an arbitrage shortlist into a need-ranked one, without displacing it.
 *
 * The two lists answer different questions and the cap has to serve both. A
 * straight concatenation would let a strong arbitrage read push every upgrade
 * out of a six-long shortlist; leaving the arbitrage entries to compete on the
 * upgrade ordering would drop all of them, because their upgrade is zero or
 * negative and that is the point.
 *
 * So a bounded slice of the cap is reserved: at most a third of it, and never
 * more than there are entries to put in it. The need-ranked list keeps
 * everything else, so on a roster with holes to fix the shortlist is almost
 * entirely what it was.
 */
function withArbitrage<T>(args: { ranked: T[]; extra: T[]; cap: number; reserve?: number }): T[] {
  const { ranked, extra, cap } = args;
  if (extra.length === 0) return ranked.slice(0, cap);
  const want = args.reserve ?? Math.max(1, Math.floor(cap / 3));
  const reserved = Math.min(extra.length, want, Math.max(0, cap - 1));

  /*
   * `ranked` may legitimately contain the arbitrage entries too, and must.
   *
   * At the scoring cut the two lists overlap by design: a package that acquires
   * a buy-low target can also be an outright upgrade, and the first version of
   * this partitioned rather than overlapped — which quietly removed such a
   * package from the ordinary ranking and then failed to reserve a slot for it,
   * because three better-priced packages for the same player took them.
   * Measured: a read placed on a player who was already a good target turned a
   * 2.9-point upgrade into a lineup wash.
   *
   * So the head is taken from the full ordering, the reserved tail admits
   * arbitrage entries that missed it, and anything still short is filled from
   * the ordering again. Deduplicated by identity, which is exact here — every
   * element is an object from one array.
   */
  const chosen = ranked.slice(0, Math.max(0, cap - reserved));
  for (const item of extra) {
    if (chosen.length >= cap) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  for (const item of ranked) {
    if (chosen.length >= cap) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen;
}

/** Does this roster have anything a trade could fix? §18's fourth empty state. */
function hasNeed(me: RosterView): boolean {
  for (const need of me.needs.values()) if (need.level === 'hole' || need.level === 'weak') return true;
  return false;
}

/**
 * Enumerate plausible packages against one partner, cheaply and under a cap.
 *
 * Objective values only. No lineup is computed here, which is what lets this
 * stage be generous about shapes and strict about count: the ordering it
 * produces decides which candidates are worth the expensive stage, and a
 * candidate that never makes the cut costs one subtraction.
 *
 * Three shapes, and the asymmetry is deliberate. 2-for-2 is excluded because
 * pruning it safely was not demonstrated — §7 permits it "only if pruning proves
 * safe", and an unpruned 2-for-2 is the combinatorial explosion this bound
 * exists to prevent. Draft picks are excluded because the app has no pick
 * valuation, and §7 permits packages with picks "only if pick valuation is
 * already defensible".
 */
export function generateCandidates(args: {
  me: RosterView;
  them: RosterView;
  partnerKey: string;
  bounds: TradeBounds;
  rejections: Rejection[];
  /** Buy-low and sell-high reads, for the enumeration below. Empty is the norm. */
  arbitrage?: ReadonlyMap<string, ArbitrageRead>;
}): TradeCandidatePackage[] {
  const { me, them, partnerKey, bounds } = args;
  const arbitrage = args.arbitrage ?? new Map<string, ArbitrageRead>();

  /*
   * Their players worth wanting: the ones who would actually improve a slot.
   *
   * Ranked by how far each sits above what the user currently starts at that
   * position, which is a cheap proxy for the optimiser's answer and gets the
   * ordering close enough that the cap keeps the right twelve. A player no
   * better than what the user already has is not a target however good he is in
   * the abstract — that is the "receiving side has no plausible use" prune, run
   * from the user's side.
   *
   * …and it is the *deeper* half of the gate Alex asked to have reconciled.
   * Relaxing `MIN_USER_GAIN` downstream achieves nothing on its own, because a
   * buy-low target who improves no slot today never reaches a gate at all —
   * he is not enumerated. So a player carrying a buy-low read is admitted here
   * even at `upgrade <= 0`, which is the state a buy-low is *defined* by: he is
   * cheap precisely because he is not currently better than what you have.
   *
   * Everything after this point treats him like any other target. He is priced
   * against the same fairness bands, the same lineup legality and the same
   * counterparty logic; the only thing that changed is that he was allowed into
   * the room.
   */
  const upgrades = tradeableFrom(them).map((id) => ({ id, upgrade: upgradeOver(me, them, id) }));
  const targets = withArbitrage({
    ranked: upgrades.filter((t) => t.upgrade > 0).sort((a, b) => b.upgrade - a.upgrade || a.id.localeCompare(b.id)),
    extra: upgrades
      .filter((t) => t.upgrade <= 0 && arbitrage.get(t.id)?.kind === 'buy_low')
      .sort((a, b) => (arbitrage.get(b.id)!.strength - arbitrage.get(a.id)!.strength) || a.id.localeCompare(b.id)),
    cap: bounds.targetsPerPartner,
  });

  /*
   * My players worth sending: surplus first, and only where the partner has a
   * plausible use. "Sending side cannot absorb the loss" is enforced here as a
   * filter on position level, and again exactly by the optimiser downstream.
   *
   * `spare` is relaxed for a sell-high for the mirror-image reason: the player
   * you want to sell at his peak is, almost by definition, one you are
   * currently starting, so a surplus-only shortlist can never contain him. It
   * is safe to relax *here* because it is not the thing protecting the lineup —
   * the optimiser downstream is, and it still refuses any package that opens a
   * slot or takes the week materially backwards. `useful` stays, because a
   * player the partner has no use for is not a sale, he is a message nobody
   * answers.
   */
  const mine = tradeableFrom(me).map((id) => ({
    id,
    useful: upgradeOver(them, me, id),
    spare: spareness(me, id),
  }));
  const giveable = withArbitrage({
    ranked: mine
      .filter((g) => g.useful > 0 && g.spare > 0)
    /*
     * Multiplied rather than added, and that is the difference between a useful
     * shortlist and a wasted one.
     *
     * A sum lets the player they want most sit at the top however central he is
     * to my own lineup — so the cap fills with my own starters, every one of
     * them is rejected downstream for costing me more than it gains, and the
     * genuinely spare players never get scored at all. The product asks the
     * question that actually matters: what do I have that helps them *and* that
     * I can afford to lose.
     */
      .sort((a, b) => b.useful * b.spare - a.useful * a.spare || a.id.localeCompare(b.id)),
    extra: mine
      .filter((g) => g.useful > 0 && g.spare <= 0 && arbitrage.get(g.id)?.kind === 'sell_high')
      .sort((a, b) => (arbitrage.get(b.id)!.strength - arbitrage.get(a.id)!.strength) || a.id.localeCompare(b.id)),
    cap: bounds.givePerPartner,
  });

  if (targets.length === 0 || giveable.length === 0) {
    args.rejections.push({
      partnerKey,
      give: [],
      get: [],
      reason: 'no_plausible_use',
      detail:
        targets.length === 0
          ? 'nothing on their roster would improve a slot of yours'
          : 'nothing of yours they could plausibly use is spare',
    });
    return [];
  }

  const out: TradeCandidatePackage[] = [];
  const seen = new Set<string>();

  /**
   * What an arbitrage read is worth in the pruning order, in upgrade points.
   *
   * The third place the need-shaped pipeline has to be told about a trade that
   * is not about need, and the easiest one to miss. `priority` here is
   * denominated in *points of lineup upgrade*, so a buy-low package scores near
   * zero on it by construction — and `scoredPerPartner` then drops it before
   * the optimiser ever looks, which is the suppression arriving a third time
   * wearing a bound rather than a gate.
   *
   * Scaled to the same units rather than added as a flag: at full strength a
   * read is worth about what a genuinely useful upgrade is worth, so an
   * arbitrage package sits among the ordinary candidates instead of on top of
   * them. Only the sides that mean something are read — a buy-low is what Alex
   * receives, a sell-high what he sends — which is the same asymmetry the gate
   * below keeps.
   */
  const arbitrageBoost = (give: string[], get: string[]): { carries: boolean; delta: number } => {
    if (arbitrage.size === 0) return { carries: false, delta: 0 };
    /*
     * The arbitrage player has to be the deal, not part of one.
     *
     * A buy-low bundled with a second incoming player is not a clean buy-low —
     * it is a package whose value is dominated by somebody this module has no
     * opinion about, and its fairness gap is driven by that player rather than
     * by the mispriced one. Left out of the reserved slots for that reason and
     * for a practical one: those bundles receive more value than they send, so
     * they collect the full boost and are then rejected on the value range,
     * which is three reserved optimiser runs spent on nothing.
     */
    const reads = [
      ...(get.length === 1 ? get.map((id) => arbitrage.get(id)).filter((r) => r?.kind === 'buy_low') : []),
      ...(give.length === 1 ? give.map((id) => arbitrage.get(id)).filter((r) => r?.kind === 'sell_high') : []),
    ].filter((r): r is ArbitrageRead => r != null);
    if (reads.length === 0) return { carries: false, delta: 0 };

    /*
     * …minus whatever this shape overpays, which is the half that matters.
     *
     * `priority` above is `target.upgrade + give.useful`, and `give.useful` is
     * how much the *partner* is helped — so for any given target the pruner
     * likes the package that sends him the most, which is exactly the wrong
     * package for a buy-low. The whole idea is to acquire a mispriced player
     * cheaply, and the shortlist was filling with the four ways of overpaying
     * for him.
     *
     * Subtracting the overpay reorders the arbitrage candidates among
     * themselves toward value parity without touching how they rank against
     * ordinary upgrades, which is what the reserved slots already handle.
     * Objective values, so this is a subtraction and not a model.
     */
    const out = give.reduce((sum, id) => sum + (me.valueOf.get(id) ?? 0), 0);
    const incoming = get.reduce((sum, id) => sum + (them.valueOf.get(id) ?? 0), 0);
    const overpay = Math.max(0, out - incoming);
    return {
      carries: true,
      delta: ARBITRAGE_PRIORITY_POINTS * Math.max(...reads.map((r) => r.strength)) - overpay,
    };
  };

  const add = (give: string[], get: string[], priority: number) => {
    const key = packageKey(give, get);
    if (seen.has(key)) return;
    seen.add(key);

    const boost = arbitrageBoost(give, get);
    out.push({ partnerKey, give, get, priority: round3(priority + boost.delta), arbitrage: boost.carries });
  };

  for (const target of targets) {
    const targetValue = them.valueOf.get(target.id) ?? 0;

    for (const give of giveable) {
      const giveValue = me.valueOf.get(give.id) ?? 0;

      // 1-for-1.
      add([give.id], [target.id], target.upgrade + give.useful);

      /*
       * 2-for-1: my main piece plus one smaller one, for their target.
       *
       * One filler per pairing, and it is the *best* filler the partner could
       * use rather than every filler — more than one and the list becomes
       * permutations of a single idea, which is the near-duplicate failure
       * again. The filler must be worth less than the main piece, or this is
       * not a consolidation, it is two main pieces.
       */
      if (bounds.maxPackageSize >= 2 && giveValue < targetValue) {
        const filler = giveable.find(
          (g) => g.id !== give.id && (me.valueOf.get(g.id) ?? 0) <= giveValue && g.useful > 0,
        );
        if (filler) add([give.id, filler.id].sort(), [target.id], target.upgrade + give.useful * 0.5);
      }

      /*
       * 1-for-2: my one better player for two of theirs.
       *
       * The depth-spreading shape, and the mirror of the case above: worth
       * enumerating only when the piece I send is worth more than the target on
       * its own, because otherwise I am asking for two players and offering
       * less than one of them.
       */
      if (bounds.maxPackageSize >= 2 && giveValue > targetValue) {
        const second = targets.find(
          (t) => t.id !== target.id && (them.valueOf.get(t.id) ?? 0) <= targetValue && t.upgrade > 0,
        );
        if (second) add([give.id], [target.id, second.id].sort(), target.upgrade * 0.5 + second.upgrade * 0.5 + give.useful);
      }
    }
  }

  return out.sort((a, b) => b.priority - a.priority || packageKey(a.give, a.get).localeCompare(packageKey(b.give, b.get)));
}

/**
 * Players a roster could realistically move.
 *
 * Anyone the engine could score. A player it could not is excluded rather than
 * valued at zero — an unscorable player in a package is a package whose fairness
 * is a guess, and §7 names "a player is not realistically tradeable" as a
 * pruning rule.
 */
function tradeableFrom(view: RosterView): string[] {
  return view.playerIds
    .filter((id) => !view.unscored.has(id) && view.valueOf.has(id))
    /*
     * And never a defence, whatever the engine now thinks one is worth.
     *
     * The second of the two gates described in `rosterUtility.ts`, and the one
     * that has to be explicit rather than inherited. Until this lane a DST was
     * excluded here for free, because it was unscorable and the line above
     * drops anything the engine could not score — an accident, not a rule. Now
     * that a DST has a real number, that filter passes it, and without this it
     * would be ranked, packaged and offered like a wide receiver.
     *
     * Written as its own step so a future change to how defences are scored
     * cannot quietly re-open the door: this does not depend on a defence being
     * unpriced, thin, cheap or unwanted. It depends on it being a defence.
     */
    .filter((id) => !tradeExcluded(view.positionOf.get(id)))
    .sort();
}

/**
 * How much better this player is than what the receiving roster starts at his
 * position, in objective points.
 *
 * The cheap stand-in for "does he enter the lineup", used for ordering only —
 * the optimiser answers it properly downstream. Compared against the receiver's
 * weakest *required* starter at the position rather than his best, because that
 * is the man who would actually be displaced.
 */
function upgradeOver(receiver: RosterView, holder: RosterView, playerId: string): number {
  const value = holder.valueOf.get(playerId);
  const position = holder.positionOf.get(playerId);
  if (value == null || !position) return 0;

  const need = receiver.needs.get(position);
  const slots = Math.max(1, Math.round(need?.slots ?? 1));
  const owned = (need?.values ?? []).slice(0, slots);
  const weakest = owned.length >= slots ? (owned[owned.length - 1] ?? 0) : 0;
  const raw = value - weakest;

  /*
   * A position the receiver is thin at is worth more than the same points
   * elsewhere. Bounded to a fifty per cent uplift so need shades the ordering
   * rather than deciding it — the optimiser has the final word on both.
   */
  const multiplier = need?.level === 'hole' ? 1.5 : need?.level === 'weak' ? 1.25 : need?.level === 'surplus' ? 0.75 : 1;
  return round3(raw * multiplier);
}

/**
 * How comfortably a roster can lose this player.
 *
 * Positive means he is genuinely spare. Anyone required to fill a slot the
 * roster would otherwise leave empty scores zero and is never offered, which is
 * the "sending side cannot absorb the loss" prune.
 */
function spareness(view: RosterView, playerId: string): number {
  const position = view.positionOf.get(playerId);
  const value = view.valueOf.get(playerId);
  if (!position || value == null) return 0;

  const need = view.needs.get(position);
  if (!need) return 1;
  if (need.level === 'hole') return 0;
  if (need.level === 'surplus') return 2;
  if (need.level === 'weak') return view.starterIds.has(playerId) ? 0 : 0.5;
  return view.starterIds.has(playerId) ? 0.5 : 1;
}

/**
 * Score one candidate against every gate, in the order the gates are cheap.
 *
 * Returns null and records a nameable rejection whenever the offer fails.
 * Nothing about the manager is read until every objective gate has passed,
 * which is the mechanism that makes "history cannot rescue an objectively bad
 * trade" a property of the control flow rather than of a constant.
 */
function evaluate(args: {
  candidate: TradeCandidatePackage;
  me: RosterView;
  them: RosterView;
  partner: TradePartnerView;
  fit: Omit<ManagerFitInput, 'offer'>;
  rejections: Rejection[];
  arbitrage: ReadonlyMap<string, ArbitrageRead>;
}): OfferEvaluation | null {
  const { candidate, me, them, partner } = args;
  const reject = (reason: RejectionReason, detail: string) => {
    args.rejections.push({ partnerKey: partner.key, give: candidate.give, get: candidate.get, reason, detail });
    return null;
  };

  const give = candidate.give.map((id) => playerOf(me, id));
  const get = candidate.get.map((id) => playerOf(them, id));
  if (give.some((p) => p == null) || get.some((p) => p == null)) {
    return reject('unscorable_player', 'a player in this package could not be scored');
  }
  const giving = give as OfferPlayer[];
  const getting = get as OfferPlayer[];

  // --------------------------------------------------------- gate 1: value --
  const fairness = fairnessOf(giving, getting);
  if (fairness.band === 'outside_range') {
    return reject(
      'value_gap_outside_range',
      `objective values are ${Math.round(Math.abs(fairness.gap) * 100)}% apart, past the recommendation range`,
    );
  }

  /*
   * Which question this package is answering, decided before the bar is set.
   *
   * A package that acquires a buy-low target, or sheds a sell-high candidate,
   * is value arbitrage — and the bar for arbitrage is a different bar, because
   * the gain it is claiming is not a gain in this week's lineup. See
   * {@link MIN_ARBITRAGE_USER_GAIN}.
   *
   * Read off the players on each side rather than off the package as a whole:
   * a buy-low is something Alex *receives* and a sell-high is something he
   * *sends*, and a read pointing the wrong way is not a reason to do anything.
   */
  const reads = [
    ...candidate.get.map((id) => args.arbitrage.get(id)).filter((r) => r?.kind === 'buy_low'),
    ...candidate.give.map((id) => args.arbitrage.get(id)).filter((r) => r?.kind === 'sell_high'),
  ].filter((r): r is ArbitrageRead => r != null);
  const strongest = [...reads].sort((a, b) => b.strength - a.strength);

  // ------------------------------------------------ gate 2: does it help me --
  const userDelta = me.delta(candidate.give, candidate.get);
  if (!userDelta.legal) return reject('opens_hole_for_user', 'it would leave a starting slot of yours empty');
  /*
   * The gate Alex asked to be reconciled, reconciled in one line.
   *
   * §18's "no meaningful hole to trade for" is this bar: with the lineup
   * already fine, nothing clears a one-point weekly gain and the board
   * correctly says there is nothing to do. That is right for an *upgrade* and
   * wrong for arbitrage, which is a bet on the rest of the season and is
   * frequently a wash this Sunday. A great buy-low target must surface when the
   * lineup is otherwise fine, which is the state it is most likely to arrive
   * in.
   *
   * Only the bar moves. Every other gate — value range above, both lineups
   * legal, no material harm, the counterparty's own roster logic — is the same
   * code running on the same package.
   */
  const bar = strongest.length > 0 ? MIN_ARBITRAGE_USER_GAIN : MIN_USER_GAIN;
  if (userDelta.starterGain < bar) {
    return reject(
      'user_benefit_negligible',
      strongest.length > 0
        ? `your lineup would lose ${Math.abs(userDelta.starterGain).toFixed(1)} pts, past the ${Math.abs(bar)} pt this arbitrage may cost`
        : `your lineup would gain ${userDelta.starterGain.toFixed(1)} pts, below the ${MIN_USER_GAIN} pt bar`,
    );
  }

  // ------------------------------------ gate 3: could they defend accepting --
  const partnerDelta = them.delta(candidate.get, candidate.give);
  if (!partnerDelta.legal) {
    return reject('opens_hole_for_counterparty', 'it would leave a starting slot of theirs empty');
  }
  if (partnerDelta.starterGain < -MATERIAL_HARM) {
    return reject(
      'harms_counterparty',
      `their lineup would lose ${Math.abs(partnerDelta.starterGain).toFixed(1)} pts, which they would decline`,
    );
  }

  const userSide = outcomeOf({ view: me, delta: userDelta, incoming: getting, outgoing: giving });
  const partnerSide = outcomeOf({ view: them, delta: partnerDelta, incoming: giving, outgoing: getting });

  /*
   * §13, and the central product upgrade in one condition.
   *
   * A deal that is even on value and neutral on their lineup needs a roster
   * reason to exist. Without one it is arithmetic nobody would act on, and
   * surfacing it is how a trade assistant becomes a calculator.
   */
  if (partnerSide.starterGain <= 0 && partnerSide.rationales.length === 0) {
    return reject('no_counterparty_logic', 'they gain no lineup points and the deal has no roster logic for them');
  }

  // --------------------------------------------- and only now, the manager --
  const managerFit = managerFitFor({
    ...args.fit,
    offer: {
      giving: giving.length,
      getting: getting.length,
      partnerReceives: giving.map((p) => p.position),
      partnerSends: getting.map((p) => p.position),
      /*
       * Whether this one is edged your way, for the frequency lean.
       *
       * The band and not the gap, so the term cannot vary with a decimal
       * nothing under it supports — and `edge_user` only, because the wider
       * band was rejected at gate 1 above. See `EDGE_TO_ACTIVE_TRADER`.
       */
      edgeToUser: fairness.band === 'edge_user',
    },
  });

  /*
   * The category, and the one condition that makes the label honest.
   *
   * An arbitrage read only *labels* an offer when it is what let the offer
   * through. A package that clears {@link MIN_USER_GAIN} on its own is an
   * upgrade that happens to involve a buy-low target, and calling it a buy-low
   * would be claiming reasoning the board did not need — the same rule
   * `applyLineupPreferences` keeps about naming correlation only when
   * correlation moved something.
   */
  const carriedByArbitrage = strongest.length > 0 && userDelta.starterGain < MIN_USER_GAIN;
  const category: OfferCategory = carriedByArbitrage ? strongest[0]!.kind : 'upgrade';

  const breakdown = scoreOf({
    user: userSide,
    fairness,
    counterparty: partnerSide,
    managerFit,
    size: giving.length + getting.length,
    /*
     * What an arbitrage offer is scored on instead of this week's points.
     *
     * The `user` term is `starterGain / REFERENCE_GAIN`, which for a buy-low is
     * approximately zero by construction — it is the number the gate above just
     * declined to judge it on. Scoring it that way anyway would let it through
     * the gate and then rank it last, which is a more confusing answer than
     * suppressing it was. The read's own strength is the benefit being claimed,
     * so it is the benefit that is ranked.
     */
    ...(carriedByArbitrage ? { arbitrageStrength: strongest[0]!.strength } : {}),
  });

  return {
    id: `${partner.key}:${packageKey(candidate.give, candidate.get)}`,
    category,
    arbitrage: carriedByArbitrage ? strongest : [],
    partner,
    give: giving,
    get: getting,
    fairness,
    user: userSide,
    counterparty: partnerSide,
    managerFit,
    score: breakdown.total,
    breakdown,
    reasons: reasonsFor({ me, them, partner, giving, getting, user: userSide, counterparty: partnerSide, fairness, managerFit }),
    caveats: caveatsFor({ me, giving, user: userSide, counterparty: partnerSide, fairness, managerFit }),
    headline: headlineFor({ user: userSide, counterparty: partnerSide }),
  };
}

function playerOf(view: RosterView, id: string): OfferPlayer | null {
  const value = view.valueOf.get(id);
  const position = view.positionOf.get(id);
  if (value == null || !position) return null;
  return { playerId: id, name: view.nameOf.get(id) ?? id, position, value: round2(value) };
}

/**
 * Which band the objective values fall in.
 *
 * Measured as a share of the larger side rather than in absolute points, so the
 * same band means the same thing for a swap of benches and a swap of stars.
 * This is the app's existing value machinery summed and compared — deliberately
 * not a new trade-value currency, which would be a second thing to keep
 * calibrated against fantasy points when the first one already is.
 */
export function fairnessOf(give: readonly OfferPlayer[], get: readonly OfferPlayer[]): Fairness {
  const outgoing = round2(give.reduce((sum, p) => sum + p.value, 0));
  const incoming = round2(get.reduce((sum, p) => sum + p.value, 0));
  const larger = Math.max(outgoing, incoming);
  const gap = larger <= 0 ? 0 : round3((incoming - outgoing) / larger);

  let band: FairnessBand;
  if (Math.abs(gap) <= FAIRNESS_BANDS.even) band = 'even';
  else if (Math.abs(gap) <= FAIRNESS_BANDS.edge) band = gap > 0 ? 'edge_user' : 'edge_opponent';
  else band = 'outside_range';

  return { band, label: FAIRNESS_LABELS[band], incoming, outgoing, gap };
}

/** Turn a raw lineup delta into the side's own account of the deal. */
function outcomeOf(args: {
  view: RosterView;
  delta: RosterDelta;
  incoming: readonly OfferPlayer[];
  outgoing: readonly OfferPlayer[];
}): SideOutcome {
  const { view, delta } = args;
  const rationales: RosterRationale[] = [];

  /*
   * Filling a hole means starting, not merely arriving.
   *
   * Need is measured against what the rest of the league starts at that slot, so
   * a position can read as a hole and still be one the incoming player does not
   * improve — he is below the benchmark too. Requiring him to enter the lineup
   * is what stops "fills their WR hole" appearing beside a lineup that did not
   * change, which is a card arguing with itself.
   */
  const entering = new Set(delta.entersLineup);
  const fillsHole = args.incoming.some(
    (p) => entering.has(p.playerId) && view.needs.get(p.position)?.level === 'hole',
  );
  if (fillsHole) rationales.push('fills_hole');

  /*
   * And an upgrade has to be worth points.
   *
   * A player entering the lineup and displacing an equal is a swap, not an
   * upgrade, and the honest reading of a zero net is that nothing improved.
   */
  if (delta.starterGain > 0 && delta.entersLineup.length > 0 && delta.displaced.length > 0) {
    rationales.push('upgrades_starter');
  }

  const fromSurplus = args.outgoing.some((p) => view.needs.get(p.position)?.level === 'surplus');
  const toNeed = args.incoming.some((p) => {
    const level = view.needs.get(p.position)?.level;
    return level === 'hole' || level === 'weak';
  });
  if (fromSurplus && toNeed) rationales.push('surplus_for_need');

  /*
   * Consolidation and depth-spreading, each requiring the roster state that
   * makes it sensible rather than just the shape of the package.
   *
   * A deep roster turning two into one is consolidating; a thin roster doing the
   * same thing is thinning itself further, and the two must not produce the same
   * rationale. That is the whole content of the depth conditions below.
   */
  const depth = [...view.benchDepth.values()].reduce((a, b) => a + b, 0);
  if (args.incoming.length === 1 && args.outgoing.length >= 2 && depth >= 2) rationales.push('consolidates_depth');
  if (args.incoming.length >= 2 && args.outgoing.length === 1 && delta.entersLineup.length >= 2) {
    rationales.push('spreads_depth');
  }
  if (fromSurplus && !delta.opensSlot && delta.starterGain >= 0) rationales.push('no_worse_hole');

  return {
    starterGain: delta.starterGain,
    depthChange: delta.depthChange,
    entersLineup: args.incoming.filter((p) => delta.entersLineup.includes(p.playerId)),
    displaced: delta.displaced,
    opensSlot: delta.opensSlot,
    rationales: [...new Set(rationales)],
  };
}

/**
 * The internal composite, in §15's order of importance.
 *
 * Manager fit is added last and is bounded by `MANAGER_FIT_CAP`, so it can shade
 * the ordering of offers that are already close and cannot lift one past an
 * offer that is better on the objective terms.
 */
export function scoreOf(args: {
  user: SideOutcome;
  fairness: Fairness;
  counterparty: SideOutcome;
  managerFit: ManagerFit;
  size: number;
  /**
   * The arbitrage read's own strength, when that is what the offer is claiming.
   *
   * Replaces the weekly-lineup term rather than adding to it, because they are
   * two answers to the same question — "how much is this worth to me" — and
   * adding them would pay an arbitrage offer twice for a gain it makes once.
   */
  arbitrageStrength?: number;
}): OfferEvaluation['breakdown'] {
  const user =
    args.arbitrageStrength != null
      ? clamp01(args.arbitrageStrength) * ARBITRAGE_BENEFIT_SCALE
      : clamp01(args.user.starterGain / REFERENCE_GAIN);

  /*
   * An edge to the user is *better* than an even deal, and paying over the odds
   * is worse than either.
   *
   * The previous reading scored `even` and `edge_user` identically at 1 — an
   * edge was permitted but never preferred, so between a dead-even package and
   * one that captured real surplus the composite was indifferent and the
   * ordering fell through to the alphabetical tiebreak. §8 permits seeking an
   * edge; this is the smallest change that actually seeks one.
   *
   * The gap between the two bands is deliberately narrow. At a weight of
   * {@link RANK_WEIGHTS.fairness} it is worth 0.024 of the composite — less
   * than {@link MANAGER_FIT_CAP}, and far less than a point of lineup gain — so
   * it settles offers that are otherwise level and cannot promote a worse deal
   * past a better one. Seeking an edge is a tiebreak, not an objective.
   *
   * Nothing here can surface a lopsided trade: `outside_range` is rejected at
   * gate 1 before any of this runs, and gate 3 still requires the partner keep
   * a legal lineup, lose no material points, and have roster logic of their
   * own. The band this now prefers is bounded by {@link FAIRNESS_BANDS.edge} on
   * one side and by those gates on the other, which is what makes "favour the
   * user where it is still fair" a safe thing to ask for.
   */
  const fairness =
    args.fairness.band === 'edge_user' ? 1 : args.fairness.band === 'even' ? 0.88 : 0.55;

  /*
   * Their side: lineup points, then roster logic, each worth half.
   *
   * The rationale half is what makes an even-but-pointless deal rank below a
   * smaller one that solves something for them, which is §13's requirement
   * stated as arithmetic.
   */
  const counterparty = clamp01(
    clamp01(args.counterparty.starterGain / REFERENCE_GAIN) * 0.5 +
      Math.min(1, args.counterparty.rationales.length / 2) * 0.5,
  );

  const simplicity = args.size <= 2 ? 1 : args.size === 3 ? 0.7 : 0.5;

  const weighted =
    RANK_WEIGHTS.user * user +
    RANK_WEIGHTS.fairness * fairness +
    RANK_WEIGHTS.counterparty * counterparty +
    RANK_WEIGHTS.simplicity * simplicity;

  /*
   * The one behavioural channel, clamped again at the point of use.
   *
   * `managerFitFor` already clamps; this is the backstop that makes the property
   * hold even if a future caller hands in a contribution from somewhere else.
   */
  const managerFit = Math.max(-MANAGER_FIT_CAP, Math.min(MANAGER_FIT_CAP, args.managerFit.contribution));

  return {
    user: round3(RANK_WEIGHTS.user * user),
    fairness: round3(RANK_WEIGHTS.fairness * fairness),
    counterparty: round3(RANK_WEIGHTS.counterparty * counterparty),
    simplicity: round3(RANK_WEIGHTS.simplicity * simplicity),
    managerFit: round3(managerFit),
    total: round3(weighted + managerFit),
  };
}

/**
 * Deterministic ordering, with every tie broken by something stable.
 *
 * The final `id` comparison is not decoration: without it two offers with
 * identical arithmetic would order by whatever the enumeration happened to do,
 * and the board would reshuffle between two identical requests.
 */
export function compareOffers(a: OfferEvaluation, b: OfferEvaluation): number {
  return (
    b.score - a.score ||
    b.user.starterGain - a.user.starterGain ||
    /*
     * Then the surplus, before their gain rather than after it.
     *
     * Two offers that move the user's lineup by the same amount are the case
     * where "fair but favours you where it can" is decided, and the value gap
     * is the only thing separating them. Ordering their gain first would spend
     * that tie making the *partner* better off, which is generous rather than
     * fair — their side is already protected by gate 3, and the band this can
     * reach is already bounded by `FAIRNESS_BANDS.edge`.
     *
     * Their gain still breaks the tie after it, so between two packages that
     * are equally good for the user and equally priced, the one they are more
     * likely to take is the one that surfaces.
     */
    b.fairness.gap - a.fairness.gap ||
    b.counterparty.starterGain - a.counterparty.starterGain ||
    a.give.length + a.get.length - (b.give.length + b.get.length) ||
    a.id.localeCompare(b.id)
  );
}

// ------------------------------------------------------------ explanations --

/**
 * The compact atoms a card prints, strongest first. §16.
 *
 * Every sentence is derived from a computed fact — there is no branch here that
 * produces prose the model did not earn. The manager's own sentence comes last
 * and is always the probabilistic vocabulary, never "will accept".
 */
function reasonsFor(args: {
  me: RosterView;
  them: RosterView;
  partner: TradePartnerView;
  giving: OfferPlayer[];
  getting: OfferPlayer[];
  user: SideOutcome;
  counterparty: SideOutcome;
  fairness: Fairness;
  managerFit: ManagerFit;
}): string[] {
  const out: string[] = [];
  const them = args.partner.displayName;

  for (const player of args.user.entersLineup) {
    const need = args.me.needs.get(player.position);
    out.push(
      need?.level === 'hole'
        ? `Fills your ${player.position} hole.`
        : `Upgrades your ${player.position}.`,
    );
  }
  if (args.user.entersLineup.length === 0 && args.user.starterGain > 0) {
    out.push(`Adds ${args.user.starterGain.toFixed(1)} pts to your weekly lineup.`);
  }

  const spare = args.giving.filter((p) => args.me.needs.get(p.position)?.level === 'surplus');
  if (spare.length > 0) {
    out.push(`You can afford to move ${unique(spare.map((p) => p.position)).join(' and ')} depth.`);
  }

  for (const rationale of args.counterparty.rationales) {
    if (rationale === 'fills_hole') {
      const filled = args.giving.find((p) => args.them.needs.get(p.position)?.level === 'hole');
      out.push(filled ? `Gives ${them} a starting ${filled.position}.` : `Fills a hole for ${them}.`);
    } else if (rationale === 'upgrades_starter') {
      out.push(`${them} upgrades a starting slot.`);
    } else if (rationale === 'consolidates_depth') {
      out.push(`${them} turns spare depth into one better starter.`);
    } else if (rationale === 'spreads_depth') {
      out.push(`${them} turns one player into two starters.`);
    } else if (rationale === 'surplus_for_need') {
      out.push(`${them} converts surplus into a need.`);
    }
  }

  if (args.user.starterGain > 0 && args.counterparty.starterGain > 0) {
    out.push('Both teams improve a starting slot.');
  }
  if (args.fairness.band !== 'even') out.push(`${args.fairness.label}.`);

  for (const note of args.managerFit.notes) out.push(note);

  return unique(out).slice(0, 6);
}

/** What is weak about it. Same neutral vocabulary, no hedging away the point. */
function caveatsFor(args: {
  me: RosterView;
  giving: OfferPlayer[];
  user: SideOutcome;
  counterparty: SideOutcome;
  fairness: Fairness;
  managerFit: ManagerFit;
}): string[] {
  const out: string[] = [];

  if (args.user.depthChange < 0) {
    out.push(`Costs you ${Math.abs(args.user.depthChange)} startable bench player(s).`);
  }
  const starters = args.giving.filter((p) => args.me.starterIds.has(p.playerId));
  if (starters.length > 0) {
    out.push(`You are sending ${starters.map((p) => p.name).join(' and ')}, currently in your lineup.`);
  }
  if (args.fairness.band === 'edge_opponent') {
    out.push('You are paying slightly over the odds on objective value.');
  }
  if (args.counterparty.starterGain <= 0) {
    out.push('Their lineup does not improve; the case for them is roster shape rather than points.');
  }
  if (args.managerFit.activity === 'effectively_inactive') {
    out.push('Strong roster fit, but this manager rarely trades.');
  } else if (args.managerFit.uncertain) {
    out.push('Limited manager history; manager fit is uncertain.');
  }
  return unique(out);
}

/** The one line a collapsed row shows. Net benefit, in the app's own units. */
function headlineFor(args: { user: SideOutcome; counterparty: SideOutcome }): string {
  const mine = `+${args.user.starterGain.toFixed(1)} to your lineup`;
  if (args.counterparty.starterGain > 0) {
    return `${mine}, +${args.counterparty.starterGain.toFixed(1)} to theirs`;
  }
  return `${mine}; fits their roster shape`;
}

// ----------------------------------------------------------------- helpers --

/** A package's identity. Two orderings of one package are one package. */
export function packageKey(give: readonly string[], get: readonly string[]): string {
  return `${[...give].sort().join('+')}>${[...get].sort().join('+')}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
