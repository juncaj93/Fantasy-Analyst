/**
 * Whether a rival with a hole at the position will actually bid on it.
 *
 * `competition.ts` answers *can he* — he is short at the position and he has
 * money. That is a fact about his roster and his wallet, and until now it was
 * the whole answer: every rival who cleared both tests counted once, and the
 * count is what prices the claim. So a manager who has placed one bid in three
 * seasons and is sitting on the full $100 he started with contributed exactly
 * as much expected competition as the manager who bids every Wednesday.
 *
 * That is the gap this file closes. It answers the third question — *does he,
 * ever?* — and returns a number in [{@link BID_LIKELIHOOD.floor}, 1] that
 * scales one rival's contribution to the field.
 *
 * ## Absence of evidence is not evidence of dormancy
 *
 * The distinction this whole module turns on, and the one that decides where
 * every threshold below sits: a manager nobody has watched is *unknown*, and a
 * manager watched for two seasons who has bid once is *known to be quiet*.
 * Those must not produce the same number, and the naive version of this feature
 * produces the same number for both — it sees "no bids on record" and discounts,
 * which silently discounts every manager in a league that has not been
 * backfilled and every manager who joined this year.
 *
 * So the discount is driven by the *observation window*, never by the bid count
 * alone. Below {@link BID_LIKELIHOOD.minActiveWeeks} of history nothing is
 * claimed at all and the rival counts whole, exactly as he did before this
 * existed. The confidence term then grows with weeks watched, so a manager with
 * one bid in nine weeks is discounted a little and one with one bid in forty is
 * discounted a lot. That is the same shape `transactionProfile.ts` uses for
 * every rate it reports, for the same reason.
 *
 * ## Why budget usage cannot act on its own
 *
 * A manager holding his whole budget is two opposite things depending on who he
 * is. `managerPressure.ts` already reads one of them — `fundedLateRivals`, the
 * manager who historically saves and is a live threat in week 11 — and a naive
 * "he has spent $0, so he is not a bidder" reading would contradict it directly
 * and price the same manager as harmless and dangerous on the same card.
 *
 * The two are told apart by history, not by the balance. So unspent budget here
 * is a **corroborator and never a cause**: it is multiplied by the dormancy the
 * frequency reading already established, so it can sharpen "he never bids" into
 * "he never bids and has not started" and can do nothing whatsoever to a
 * manager whose record says he bids. A full wallet on an active manager comes
 * out at 1.0 from this file and is left to the module that reads it correctly.
 *
 * ## What this is not allowed to do
 *
 * It does not price a player and it never reaches `recommended` or
 * `doNotExceed` except through the one path `competition.ts` already owned — a
 * count of rivals, normalised against the funded field, feeding the 0–1 demand
 * input in `core/faab/strategy.ts`. The double-counting rule in the header of
 * `core/league/bidders.ts` is unchanged and still holds: this makes the count
 * more honest, it does not add a second channel.
 *
 * And it never removes anybody. A discounted rival is still named, still shown,
 * still carries his wallet — {@link BID_LIKELIHOOD.floor} is deliberately well
 * above zero, because a quiet manager who wakes up for one player is a thing
 * that happens, and a card that had stopped listing him would be wrong in the
 * one way a waiver tool must not be wrong.
 */

import type { RosterBudget } from '../faab/budget.ts';
import type {
  LeagueTransactionBaseline,
  ManagerTransactionProfile,
} from '../managers/transactionProfile.ts';

export const BID_LIKELIHOOD = {
  /**
   * The least a rival may ever count for, however dormant his record.
   *
   * A fifth of a bidder. He has a hole at the position and money to fix it, and
   * the evidence says he probably will not — "probably will not" is not "cannot",
   * and the difference is a player lost to a manager who bid for the first time
   * all year. Set this to zero and the app starts recommending $1 on players it
   * should be paying for.
   */
  floor: 0.2,
  /**
   * Active weeks of history below which no dormancy is claimed at all.
   *
   * Eight, half a fantasy season. Below it the rival counts whole. This is the
   * threshold that keeps a first-season league, a league mid-backfill and a
   * manager who joined in August from being quietly written off — all three
   * look identical to a bid count and are told apart only by the window.
   */
  minActiveWeeks: 8,
  /**
   * Shrinkage on the observation window: `w / (w + k)` weights the claim.
   *
   * At 8 a manager watched for half a season carries half of his own reading
   * and two full seasons carry a little over three quarters of it. Deliberately
   * slower than the `weeks: 6` in `transactionProfile.ts` — that one shrinks a
   * *rate* toward the room, which is a mild statement, and this one is about to
   * discount a rival most of the way out of the market, which is not.
   *
   * It is not much slower, though, and the reason is that the evidence here is
   * unusually strong for its size. A room claiming at half a bid per manager
   * per week gives a manager watched for two seasons around fourteen chances;
   * taking one of them is not a small sample producing a noisy rate, it is a
   * large sample producing a clear one. Shrinking that as hard as a two-draft
   * timing profile would be treating a well-measured fact as a rumour.
   */
  weeksShrink: 8,
  /**
   * The most the frequency reading alone may discount a rival.
   *
   * A manager with a long, clean record of never claiming lands at 1 - 0.65 =
   * 0.35 of a bidder on this reading. That is the "bid only once in the
   * league's history" case, and it is a deliberate stopping point rather than
   * the floor: frequency is one reading, and one reading does not get the whole
   * allowance.
   */
  maxFrequencyEffect: 0.65,
  /**
   * The most unspent budget may add, on top of, and scaled by, dormancy.
   *
   * Takes the fully dormant manager from 0.35 toward the floor and moves an
   * active manager by nothing at all. This is the "$0 of his $100" half of the
   * ask, and it is second rather than first on purpose — see the header.
   *
   * The two allowances sum to 0.85 rather than to 0.8, so the floor is a clamp
   * that a real manager can actually reach rather than a number no arithmetic
   * ever produces. Reaching it still takes a manager watched for years who has
   * never once claimed and has not touched his budget.
   */
  maxBudgetEffect: 0.2,
  /**
   * Share of the season below which a balance says nothing.
   *
   * Everybody is holding their whole budget in week 2, so reading it there
   * would mark the entire league dormant in September and quietly cheapen every
   * bid the app suggests in the weeks its advice matters most. A third of the
   * way in, an untouched budget has started to mean something. The same reason
   * `managerPressure.ts` refuses its late-season reading before halfway.
   */
  budgetReadableFrom: 1 / 3,
} as const;

export interface RivalBidLikelihood {
  rosterId: number;
  /** In [floor, 1]. What one rival is worth to the expected field. */
  participation: number;
  /** Bids on record for him, across every backfilled season. */
  bidSample: number;
  /** Weeks of history that could have described him. The denominator. */
  activeWeeks: number;
  /** His bids per active week over the room's claims per manager per week. */
  relativeFrequency: number | null;
  /** Share of his season budget he has spent. Null when the budget is unknown. */
  budgetUsed: number | null;
  /** How much of the discount is his own record rather than the default. */
  confidence: number;
  /** Developer-facing. Never user copy. */
  note: string | null;
}

/** A rival nothing is known about counts whole. The safe, and correct, default. */
export function neutralBidLikelihood(rosterId: number): RivalBidLikelihood {
  return {
    rosterId,
    participation: 1,
    bidSample: 0,
    activeWeeks: 0,
    relativeFrequency: null,
    budgetUsed: null,
    confidence: 0,
    note: null,
  };
}

export interface BidLikelihoodInput {
  profile: ManagerTransactionProfile | undefined;
  budget: RosterBudget | undefined;
  baseline: LeagueTransactionBaseline | null;
  /** The league's season budget, for turning dollars spent into a share. */
  budgetTotal: number | null;
  week: number;
  finalWeek: number;
}

/**
 * How much of a bidder one rival is.
 *
 * Pure and deterministic. Returns 1 — a whole bidder, no claim made — whenever
 * the history is too thin to say anything, which is the correct answer far more
 * often than it is the interesting one.
 */
export function bidParticipation(rosterId: number, input: BidLikelihoodInput): RivalBidLikelihood {
  const { profile, baseline } = input;

  if (!profile || !profile.usable || !baseline) return neutralBidLikelihood(rosterId);

  const activeWeeks = profile.activeWeeks;
  if (activeWeeks < BID_LIKELIHOOD.minActiveWeeks) {
    return {
      ...neutralBidLikelihood(rosterId),
      bidSample: profile.bidSample,
      activeWeeks,
      note: `${activeWeeks} active week(s) watched — below the ${BID_LIKELIHOOD.minActiveWeeks} needed to call anybody quiet`,
    };
  }

  /*
   * How often he bids, against how often this room bids.
   *
   * His own bids per active week over the baseline's claims per manager per
   * week — the two are already on the same scale, which is why the baseline
   * divides by manager-weeks rather than by league-weeks.
   *
   * A room that barely bids at all cannot make anybody look dormant: if the
   * baseline rate is zero there is no ratio to take, and everyone counts whole.
   */
  const roomRate = baseline.claimsPerWeek;
  const myRate = profile.bidSample / activeWeeks;
  const relativeFrequency = roomRate > 0 ? round3(myRate / roomRate) : null;

  if (relativeFrequency == null) {
    return {
      ...neutralBidLikelihood(rosterId),
      bidSample: profile.bidSample,
      activeWeeks,
      note: 'this room has no claim rate to compare against',
    };
  }

  /*
   * Dormancy: 0 for a manager who bids at or above the room's rate, rising to 1
   * for one who never bids. Clamped at both ends — a manager who bids at three
   * times the room's rate is not *more* than a whole bidder, because this file
   * is only allowed to discount. Raising the count on a busy manager would be a
   * second path from tendency to price, which is exactly what the double-
   * counting rule forbids; `managerPressure.ts` owns the upward reading and
   * expresses it as cost context, not as a rival count.
   */
  const dormancy = clamp01(1 - relativeFrequency);
  const confidence = activeWeeks / (activeWeeks + BID_LIKELIHOOD.weeksShrink);

  const frequencyDiscount = dormancy * confidence * BID_LIKELIHOOD.maxFrequencyEffect;

  /*
   * And the wallet, which only ever confirms what the record already said.
   *
   * Multiplied by `dormancy` so an active manager's full budget moves nothing,
   * and gated on the season being far enough along that a balance is evidence
   * rather than a calendar artefact.
   */
  const seasonProgress = input.finalWeek > 0 ? (input.week - 1) / input.finalWeek : 0;
  const budgetUsed =
    input.budgetTotal && input.budgetTotal > 0 && input.budget?.spent != null
      ? clamp01(input.budget.spent / input.budgetTotal)
      : null;

  const budgetDiscount =
    budgetUsed != null && seasonProgress >= BID_LIKELIHOOD.budgetReadableFrom
      ? (1 - budgetUsed) * dormancy * confidence * BID_LIKELIHOOD.maxBudgetEffect
      : 0;

  const participation = round3(
    Math.max(BID_LIKELIHOOD.floor, 1 - frequencyDiscount - budgetDiscount),
  );

  return {
    rosterId,
    participation,
    bidSample: profile.bidSample,
    activeWeeks,
    relativeFrequency,
    budgetUsed,
    confidence: round3(confidence),
    note: noteFor({ participation, profile, activeWeeks, budgetUsed, budgetDiscount }),
  };
}

function noteFor(args: {
  participation: number;
  profile: ManagerTransactionProfile;
  activeWeeks: number;
  budgetUsed: number | null;
  budgetDiscount: number;
}): string | null {
  if (args.participation >= 0.95) return null;
  const parts = [
    `${args.profile.bidSample} bid(s) in ${args.activeWeeks} active week(s)`,
  ];
  if (args.budgetDiscount > 0 && args.budgetUsed != null) {
    parts.push(`${Math.round(args.budgetUsed * 100)}% of budget spent`);
  }
  return `counts as ${args.participation} of a bidder — ${parts.join(', ')}`;
}

/**
 * Every rival's participation, in one pass.
 *
 * Computed once per board rather than per candidate: the same managers produce
 * the same numbers whatever position is being priced, so doing it inside the
 * candidate loop would be the same arithmetic repeated forty times — the
 * reasoning `intel.ts` already applies to the tendency translation beside it.
 */
export function bidLikelihoodByRoster(opts: {
  rosterIds: readonly number[];
  profiles: ReadonlyMap<number, ManagerTransactionProfile>;
  budgets: ReadonlyMap<number, RosterBudget>;
  baseline: LeagueTransactionBaseline | null;
  budgetTotal: number | null;
  week: number;
  finalWeek: number;
}): Map<number, RivalBidLikelihood> {
  const out = new Map<number, RivalBidLikelihood>();
  for (const rosterId of opts.rosterIds) {
    out.set(
      rosterId,
      bidParticipation(rosterId, {
        profile: opts.profiles.get(rosterId),
        budget: opts.budgets.get(rosterId),
        baseline: opts.baseline,
        budgetTotal: opts.budgetTotal,
        week: opts.week,
        finalWeek: opts.finalWeek,
      }),
    );
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}
