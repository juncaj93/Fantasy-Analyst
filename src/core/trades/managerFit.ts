/**
 * Whether *this* manager has shown behaviour consistent with *this* offer.
 *
 * The third of the three questions Smart Bilateral Trades asks, and the one
 * easiest to get wrong. §5 of the brief states the rule this module is built
 * around: behaviour may rank and tiebreak plausible offers, and it may never
 * cause the app to call an objectively lopsided trade fair. Both truths are
 * preserved rather than blended — "objective value: slight edge to you" and
 * "manager fit: above normal" are two sentences, not one score.
 *
 * Four properties are enforced here rather than left to the caller:
 *
 *   - **the contribution is capped.** {@link MANAGER_FIT_CAP} is a hard bound on
 *     what history may add to or take from a composite, and it is small enough
 *     that no combination of agreeing signals can promote an offer past one that
 *     is better on the objective gates. §12.
 *   - **unknown is not inactivity.** A manager with three fully observed seasons
 *     and no trades has been measured. A manager in his first season, or one
 *     whose history is still being ingested, has not — and they must not print
 *     the same word or carry the same modifier. §10.
 *   - **small samples cannot move much.** Every rate is shrunk toward the
 *     league's own neutral prior by sample size, so one trade cannot create a
 *     preference and one recent trade cannot erase three seasons. §11.
 *   - **nothing here is a probability.** Sleeper publishes completed trades and
 *     not declined offers, so "68% likely to accept" has no denominator. The
 *     output is a bounded weight, a class, and sentences built from counts.
 *
 * Reads the stored trade tendencies the shipped history subsystem already
 * derives. It fetches nothing and knows nothing about databases.
 */

import type { ManagerTradeTendencies, OfferShape } from '../managers/tradeTendencies.ts';

/**
 * The most a manager's history may move a composite score, in either direction.
 *
 * Eight hundredths against a composite that runs 0–1, chosen so that history is
 * worth roughly one band of any single objective gate and never two. An offer
 * that is behind on user benefit *and* on counterparty logic cannot be pulled
 * level by a manager who trades a lot; an offer level on both can be settled by
 * one. That is the whole permitted role.
 *
 * Symmetric by construction: the same bound applies to the penalty, so a
 * measured non-trader lowers rank by exactly as much as an active trader raises
 * it, and the feature cannot only ever promote.
 */
export const MANAGER_FIT_CAP = 0.08;

/**
 * The sample at which a rate is trusted half way from the prior to the observed.
 *
 * Standard shrinkage: `prior + (observed − prior) × n / (n + k)`. At k = 4 a
 * manager with four trades is read at half strength and one with twelve at
 * three quarters, which is the "one historical trade must not create an extreme
 * preference" rule expressed as arithmetic rather than as a threshold.
 *
 * Deliberately not the draft module's constant. A draft is sixteen observations
 * a season and trades are often zero, so a prior tuned for one is wrong for the
 * other — §11 says so explicitly.
 */
export const TRADE_SHRINKAGE_K = 4;

/** Fully observed seasons with no trade at all before inactivity is a finding. */
export const INACTIVITY_SEASONS = 2;

/**
 * How active a manager is, as five distinct claims.
 *
 * `unknown` is a statement about the evidence and every other value is a
 * statement about the manager. Keeping them in one enum is what makes it
 * impossible to write a consumer that accidentally treats an unmeasured manager
 * as a measured non-trader — the case §10 names as the standing principle.
 */
export type ActivityClass =
  | 'active'
  | 'selective'
  | 'low_activity'
  | 'effectively_inactive'
  | 'unknown';

/** Neutral product language. No manager is ever described as bad at this. */
export const ACTIVITY_LABELS: Record<ActivityClass, string> = {
  active: 'Trades often',
  selective: 'Trades selectively',
  low_activity: 'Rarely trades',
  effectively_inactive: 'No trades on record',
  unknown: 'Limited history',
};

/** What the history is being asked about: the offer's own shape. */
export interface OfferShapeSummary {
  /** Players the user would send. */
  giving: number;
  /** Players the user would receive. */
  getting: number;
  /** Positions the partner would receive. */
  partnerReceives: string[];
  /** Positions the partner would send. */
  partnerSends: string[];
}

export interface ManagerFitEvidence {
  /** Completed trades behind every claim. */
  sample: number;
  /** Seasons whose transaction history is known to be complete. */
  seasonsObserved: number;
  /** True when the ingestion for those seasons has finished. */
  historyComplete: boolean;
  /** Recency-weighted trades per season, shrunk toward the league's own rate. */
  ratePerSeason: number | null;
  /** The room's rate, which the shrinkage pulls toward. */
  leagueRate: number | null;
  /** In [0,1]. What share of a full claim this evidence supports. */
  confidence: number;
}

export interface ManagerFit {
  userId: string | null;
  displayName: string | null;
  activity: ActivityClass;
  /** The word a screen may print. */
  label: string;
  /**
   * The bounded contribution to a composite, in [-{@link MANAGER_FIT_CAP}, +cap].
   *
   * To be **added** to an already-computed score. A caller that multiplies by
   * it, or that lets it decide whether an offer is shown at all, is using it
   * wrongly — and could not rescue a rejected offer if it tried, because
   * rejection happens on the objective gates before this is ever read.
   */
  contribution: number;
  /** Which observations produced the contribution, each with its own weight. */
  terms: { key: string; detail: string; value: number }[];
  evidence: ManagerFitEvidence;
  /**
   * One or two neutral sentences, or empty when nothing is supportable.
   *
   * Probabilistic vocabulary only: historically, tends to, available sample,
   * limited history. Never "will accept", "always", or "easy to fleece".
   */
  notes: string[];
  /** True when the fit is uncertain enough that a screen should say so. */
  uncertain: boolean;
}

export interface ManagerFitInput {
  /** The stored profile, or null when this manager has none. */
  tendencies: ManagerTradeTendencies | null;
  /** Fallbacks for a manager with no profile row at all. */
  userId?: string | null;
  displayName?: string | null;
  /**
   * Seasons of this manager's history that are known to be **complete**.
   *
   * The load-bearing input for §10, and the reason it is passed in rather than
   * read off the profile: a profile records the seasons a manager *traded* in,
   * which for a non-trader is the empty list — indistinguishable from a manager
   * nobody has ingested. Completeness is a fact about the ingestion, and only
   * the caller has it.
   */
  seasonsObserved?: number;
  /** False when ingestion for this league is still running or has failed. */
  historyComplete?: boolean;
  /** The asking manager, for the repeat-partner reading. */
  askingUserId?: string | null;
  /** The room's own trades per manager per season, for the shrinkage prior. */
  leagueRate?: number | null;
  /** The offer being asked about. Absent asks about the manager alone. */
  offer?: OfferShapeSummary;
}

/**
 * Read one manager's history against one offer.
 *
 * Every branch below either produces a term with an explicit weight or produces
 * nothing. There is no fallthrough that quietly assumes a default, because an
 * assumed default is how a manager nobody has measured acquires a tendency.
 */
export function managerFitFor(input: ManagerFitInput): ManagerFit {
  const t = input.tendencies;
  const sample = t?.sample ?? 0;
  const seasonsObserved = Math.max(0, input.seasonsObserved ?? 0);
  const historyComplete = input.historyComplete ?? false;

  const activity = activityClassFor({ sample, seasonsObserved, historyComplete, ratePerSeason: t?.tradesPerSeason ?? null });

  const rate = shrunkRate({ observed: t?.tradesPerSeason ?? null, sample, leagueRate: input.leagueRate ?? null });
  const evidence: ManagerFitEvidence = {
    sample,
    seasonsObserved,
    historyComplete,
    ratePerSeason: rate,
    leagueRate: input.leagueRate ?? null,
    confidence: confidenceFor({ sample, seasonsObserved, historyComplete }),
  };

  const base: ManagerFit = {
    userId: t?.userId ?? input.userId ?? null,
    displayName: t?.displayName ?? input.displayName ?? null,
    activity,
    label: ACTIVITY_LABELS[activity],
    contribution: 0,
    terms: [],
    evidence,
    notes: [],
    uncertain: activity === 'unknown',
  };

  /*
   * Unknown contributes nothing. Not a small penalty, not a small bonus.
   *
   * This is the single most important line in the module. A new manager, a
   * failed ingestion and an identity the ledger could not resolve all land here,
   * and every one of them must leave the ordering exactly as the objective gates
   * left it. §18 requires the same of the sentence: neutral, and about the
   * evidence rather than about the person.
   */
  if (activity === 'unknown') {
    base.notes.push('Limited trade history; manager fit is uncertain.');
    return base;
  }

  const terms: ManagerFit['terms'] = [];
  const cap = MANAGER_FIT_CAP;

  /*
   * How much this manager trades at all, relative to his own league.
   *
   * Measured against the room rather than an absolute, because a league where
   * nobody trades and a league where everybody does should not produce the same
   * reading of the same two trades. Worth up to half the cap in either
   * direction, which makes activity the largest single term and still leaves it
   * unable to carry an offer on its own.
   */
  if (activity === 'active') {
    terms.push({ key: 'activity', detail: 'trades more often than this league does', value: cap * 0.5 });
  } else if (activity === 'selective') {
    terms.push({ key: 'activity', detail: 'trades from time to time', value: cap * 0.2 });
  } else if (activity === 'low_activity') {
    terms.push({ key: 'activity', detail: 'has rarely traded across the seasons on record', value: -cap * 0.35 });
  } else if (activity === 'effectively_inactive') {
    /*
     * A measured non-trader, and the penalty is deliberately not larger.
     *
     * §10: an inactive manager can lower practical recommendation rank but
     * should not necessarily hide the best roster fit. At half the cap the best
     * bilateral opportunity in the league survives to be shown with a caveat,
     * which is the outcome the brief names.
     */
    terms.push({ key: 'activity', detail: 'no completed trade across fully observed seasons', value: -cap * 0.5 });
  }

  /*
   * Whether the offer looks like the deals he actually makes.
   *
   * Shape only — a count of players on each side against the shape his history
   * shows. It is a genuinely weak signal and is weighted like one.
   */
  const offer = input.offer;
  if (offer && t) {
    const shape = shapeOf(offer);
    const shapeTerm = shapeAgreement(shape, t);
    if (shapeTerm) terms.push({ ...shapeTerm, value: shapeTerm.value * cap });
  }

  /*
   * Whether he has historically moved the positions this offer moves.
   *
   * Both directions are read and they are different claims: a manager who has
   * been acquiring running backs is one who will hear an offer of a running
   * back, and a manager who has been sending them is one who may part with the
   * one you want. Each is worth a fifth of the cap and both require the profile
   * to have cleared its own position threshold, which `acquires`/`sends` already
   * enforce by returning empty below it.
   */
  if (offer && t) {
    const wanted = offer.partnerReceives.filter((p) => t.acquires.includes(p));
    if (wanted.length > 0) {
      terms.push({
        key: 'acquires_position',
        detail: `has historically traded for ${unique(wanted).join(' and ')} help`,
        value: cap * 0.2,
      });
    }
    const parted = offer.partnerSends.filter((p) => t.sends.includes(p));
    if (parted.length > 0) {
      terms.push({
        key: 'sends_position',
        detail: `has historically sent ${unique(parted).join(' and ')}`,
        value: cap * 0.2,
      });
    }
  }

  if (t && input.askingUserId && t.repeatPartners.some((p) => p.userId === input.askingUserId)) {
    terms.push({ key: 'repeat_partner', detail: 'has dealt with you before', value: cap * 0.2 });
  }

  /*
   * Every term scaled by how much evidence stands behind it, then clamped.
   *
   * The scaling is what makes §12's "small samples cannot cause extreme
   * movement" true by construction rather than by threshold: a manager with one
   * trade has low confidence, so even three agreeing terms reach a fraction of
   * the cap. The clamp is the backstop for the case where they do all agree.
   */
  const scaled = terms.map((term) => ({ ...term, value: round3(term.value * evidence.confidence) }));
  const total = scaled.reduce((sum, term) => sum + term.value, 0);

  base.terms = scaled;
  base.contribution = round3(Math.max(-cap, Math.min(cap, total)));
  base.notes = notesFor({ activity, tendencies: t, evidence, terms: scaled });
  base.uncertain = evidence.confidence < 0.34 || !historyComplete;
  return base;
}

/**
 * Which of the five classes describes this manager.
 *
 * The order of the tests is the argument. Completeness is checked before
 * anything else, so a manager whose history is still being read can never fall
 * through into a claim about his behaviour — which is the failure §10 exists to
 * prevent and the one that would be invisible in production, because an
 * incomplete backfill and a quiet manager produce the same empty profile.
 */
export function activityClassFor(args: {
  sample: number;
  seasonsObserved: number;
  historyComplete: boolean;
  ratePerSeason: number | null;
}): ActivityClass {
  const { sample, seasonsObserved, historyComplete } = args;

  // Anything at all on the record is a measurement, however thin.
  if (sample > 0) {
    const rate = args.ratePerSeason ?? sample / Math.max(1, seasonsObserved);
    if (sample >= 6 && rate >= 1.5) return 'active';
    if (sample >= 3) return 'selective';
    /*
     * One or two trades. Whether that is "rarely" or "we have barely looked"
     * depends entirely on how long he has been observed for.
     */
    return seasonsObserved >= INACTIVITY_SEASONS && historyComplete ? 'low_activity' : 'unknown';
  }

  // No trades. The only question left is whether anybody has actually looked.
  if (historyComplete && seasonsObserved >= INACTIVITY_SEASONS) return 'effectively_inactive';
  return 'unknown';
}

/**
 * A manager's trade rate, pulled toward his league's own rate by sample size.
 *
 * The prior is the room rather than a constant, which is what stops a
 * low-trading league reading as twelve inactive managers. With no room rate
 * available the observed value is returned unshrunk and the confidence term
 * downstream is what keeps it from mattering.
 */
export function shrunkRate(args: {
  observed: number | null;
  sample: number;
  leagueRate: number | null;
  k?: number;
}): number | null {
  if (args.observed == null) return null;
  if (args.leagueRate == null) return round2(args.observed);
  const k = args.k ?? TRADE_SHRINKAGE_K;
  const weight = args.sample / (args.sample + k);
  return round2(args.leagueRate + (args.observed - args.leagueRate) * weight);
}

/**
 * How much of a full claim this evidence supports, in [0,1].
 *
 * Sample leads, seasons confirm, and incomplete history is charged for
 * regardless of how much of it there is: forty trades read out of a history that
 * is still being ingested is forty trades and an unknown remainder.
 */
export function confidenceFor(args: {
  sample: number;
  seasonsObserved: number;
  historyComplete: boolean;
}): number {
  const bySample = args.sample / (args.sample + TRADE_SHRINKAGE_K);
  const bySeason = Math.min(1, args.seasonsObserved / 3);
  /*
   * A fully observed manager with zero trades is well evidenced, not badly.
   *
   * Without this the strongest finding the module can make — "three complete
   * seasons, no trades" — would carry the lowest confidence and be scaled almost
   * to nothing, which is precisely backwards. The evidence is the seasons, not
   * the trades.
   */
  const observed = args.sample === 0 ? bySeason : Math.max(bySample, bySample * 0.5 + bySeason * 0.5);
  return round2(args.historyComplete ? observed : observed * 0.5);
}

/** The offer's own shape, in the vocabulary the stored profile speaks. */
export function shapeOf(offer: OfferShapeSummary): OfferShape {
  /*
   * Read from the partner's side of the table throughout.
   *
   * `giving` and `getting` are the *user's* counts, so the partner receives what
   * the user gives. A partner who receives two and sends one is being asked to
   * do the depth-for-starter deal, whatever it looks like from the other chair.
   */
  const partnerGets = offer.giving;
  const partnerSends = offer.getting;
  if (partnerSends >= 2 && partnerGets === 1) return 'depth_for_starter';
  if (partnerGets >= 2 || partnerSends >= 2) return 'package';
  return 'one_for_one';
}

function shapeAgreement(
  shape: OfferShape,
  t: ManagerTradeTendencies,
): { key: string; detail: string; value: number } | null {
  if (t.typicalShape === 'unknown') return null;
  if (shape === t.typicalShape) {
    return { key: 'shape_match', detail: `deals of this shape match his record`, value: 0.2 };
  }
  /*
   * Consolidation is the one shape worth a signed term in both directions.
   *
   * A manager who has never sent two for one is being asked to do something his
   * record does not show, which is a real if weak reason to rank the offer
   * below an equivalent one-for-one with the same partner. Every other
   * mismatch is silence — the shapes are not exclusive enough for a mismatch to
   * mean anything.
   */
  if (shape === 'depth_for_starter' && (t.consolidationRate ?? 0) === 0 && t.sample >= 3) {
    return { key: 'shape_mismatch', detail: 'has not sent two players for one on the record', value: -0.15 };
  }
  return null;
}

/**
 * The sentences a card may print, and only the supported ones.
 *
 * Assembled here rather than in a screen so the vocabulary rule has one place to
 * live, exactly as `tradeTendencies.ts` does for the existing board.
 */
function notesFor(args: {
  activity: ActivityClass;
  tendencies: ManagerTradeTendencies | null;
  evidence: ManagerFitEvidence;
  terms: ManagerFit['terms'];
}): string[] {
  const { activity, tendencies: t, evidence } = args;
  const notes: string[] = [];

  if (activity === 'effectively_inactive') {
    notes.push(
      `No completed trade across ${evidence.seasonsObserved} fully observed season(s) — this manager rarely trades.`,
    );
  } else if (activity === 'low_activity') {
    notes.push(`${evidence.sample} completed trade(s) across ${evidence.seasonsObserved} season(s) on record.`);
  } else if (t && evidence.ratePerSeason != null) {
    notes.push(`Historically trades about ${evidence.ratePerSeason} time(s) a season across ${evidence.sample} deal(s).`);
  }

  const supporting = args.terms.filter((term) => term.key !== 'activity' && term.value > 0);
  if (supporting.length > 0) {
    notes.push(`${capitalise(supporting.map((term) => term.detail).join('; '))}.`);
  }

  if (!evidence.historyComplete) {
    notes.push('League history is still being read, so manager fit is provisional.');
  }
  return notes;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
