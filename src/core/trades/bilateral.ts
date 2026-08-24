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

import { MANAGER_FIT_CAP, managerFitFor, type ManagerFit, type ManagerFitInput } from './managerFit.ts';
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
  const rejections: Rejection[] = [];
  const notes: string[] = [];
  const offers: OfferEvaluation[] = [];

  let generated = 0;
  let scored = 0;

  for (const { view, partner, fit } of input.partners) {
    const candidates = generateCandidates({ me: input.me, them: view, partnerKey: partner.key, bounds, rejections });
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
    const survivors = candidates.slice(0, bounds.scoredPerPartner);
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
      const offer = evaluate({ candidate, me: input.me, them: view, partner, fit, rejections });
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
    const kept: OfferEvaluation[] = [];
    const usedTargets = new Set<string>();
    for (const offer of evaluated.sort(compareOffers)) {
      if (kept.length >= bounds.offersPerPartner) break;
      const targets = offer.get.map((p) => p.playerId);
      if (targets.some((id) => usedTargets.has(id))) {
        rejections.push({
          partnerKey: partner.key,
          give: offer.give.map((p) => p.playerId),
          get: targets,
          reason: 'duplicate_package',
          detail: 'a stronger offer for the same player is already listed',
        });
        continue;
      }
      for (const id of targets) usedTargets.add(id);
      kept.push(offer);
    }
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
  for (const offer of ranked) {
    if (surfaced.length >= bounds.offersTotal) break;
    const involved = [...offer.give, ...offer.get].map((p) => p.playerId);
    if (involved.some((id) => spoken.has(id))) {
      rejections.push({
        partnerKey: offer.partner.key,
        give: offer.give.map((p) => p.playerId),
        get: offer.get.map((p) => p.playerId),
        reason: 'duplicate_package',
        detail: 'a better offer for one of these players is already listed',
      });
      continue;
    }
    for (const id of involved) spoken.add(id);
    surfaced.push(offer);
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
}): TradeCandidatePackage[] {
  const { me, them, partnerKey, bounds } = args;

  /*
   * Their players worth wanting: the ones who would actually improve a slot.
   *
   * Ranked by how far each sits above what the user currently starts at that
   * position, which is a cheap proxy for the optimiser's answer and gets the
   * ordering close enough that the cap keeps the right twelve. A player no
   * better than what the user already has is not a target however good he is in
   * the abstract — that is the "receiving side has no plausible use" prune, run
   * from the user's side.
   */
  const targets = tradeableFrom(them)
    .map((id) => ({ id, upgrade: upgradeOver(me, them, id) }))
    .filter((t) => t.upgrade > 0)
    .sort((a, b) => b.upgrade - a.upgrade || a.id.localeCompare(b.id))
    .slice(0, bounds.targetsPerPartner);

  /*
   * My players worth sending: surplus first, and only where the partner has a
   * plausible use. "Sending side cannot absorb the loss" is enforced here as a
   * filter on position level, and again exactly by the optimiser downstream.
   */
  const giveable = tradeableFrom(me)
    .map((id) => ({ id, useful: upgradeOver(them, me, id), spare: spareness(me, id) }))
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
    .sort((a, b) => b.useful * b.spare - a.useful * a.spare || a.id.localeCompare(b.id))
    .slice(0, bounds.givePerPartner);

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
  const add = (give: string[], get: string[], priority: number) => {
    const key = packageKey(give, get);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ partnerKey, give, get, priority: round3(priority) });
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

  // ------------------------------------------------ gate 2: does it help me --
  const userDelta = me.delta(candidate.give, candidate.get);
  if (!userDelta.legal) return reject('opens_hole_for_user', 'it would leave a starting slot of yours empty');
  if (userDelta.starterGain < MIN_USER_GAIN) {
    return reject(
      'user_benefit_negligible',
      `your lineup would gain ${userDelta.starterGain.toFixed(1)} pts, below the ${MIN_USER_GAIN} pt bar`,
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
    },
  });

  const breakdown = scoreOf({ user: userSide, fairness, counterparty: partnerSide, managerFit, size: giving.length + getting.length });

  return {
    id: `${partner.key}:${packageKey(candidate.give, candidate.get)}`,
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
}): OfferEvaluation['breakdown'] {
  const user = clamp01(args.user.starterGain / REFERENCE_GAIN);

  /*
   * An edge to the user is not worse than an even deal — §8 permits seeking one
   * — but paying over the odds is worse than not, so the discount is one-sided.
   */
  const fairness = args.fairness.band === 'edge_opponent' ? 0.55 : 1;

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
