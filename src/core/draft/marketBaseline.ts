/**
 * Two markets, one baseline.
 *
 * The board has always had one market opinion — Sleeper's ADP — and used it as
 * the price a player is going at. There are two now, and they are not the same
 * market: Underdog's ADP comes from best-ball drafts, where the shape of a
 * roster and the value of a fourth receiver are genuinely different, and it
 * moves faster because those drafts run all year. Underdog is the sharper of
 * the two, so it leads; Sleeper is the market the user is actually drafting in,
 * so it never goes away.
 *
 * ## What these weights are, and what they are emphatically not
 *
 * They blend **the market-baseline component**, which is one input among a
 * dozen — news, tiers, scarcity, roster need, My Guy, Vegas, opportunity cost,
 * concentration, separation, survival. `DOG 60%` means sixty per cent of the
 * price this board thinks a player is going at. It does not mean sixty per cent
 * of his Score, and the difference is most of the model.
 *
 * The one number that shows how small the distinction makes it: at the default
 * weights, the market-value component carries a weight of 1.0 out of roughly
 * 3.4 of total weight across every component. So a 60% share of the market
 * baseline is about 18% of the influences on a Score, and the remaining
 * components can and regularly do outvote it.
 *
 * ## Why renormalising rather than penalising
 *
 * A player Underdog has priced and Sleeper has not is not a worse player. The
 * old failure mode — treat the missing source as a zero, or as a very deep ADP —
 * would push exactly the players the app knows least about to the bottom of the
 * board, which is the opposite of useful. So a missing source redistributes its
 * weight to the one that answered, and the baseline is marked single-source so
 * everything downstream can see that it was.
 */

/** The market-baseline blend, per league format. */
export const MARKET_BLEND = {
  /**
   * Ordinary redraft. Underdog leads because it is the sharper and faster of
   * the two markets; Sleeper keeps a real share because it is the room the
   * user's picks actually happen in.
   */
  standard: { dog: 0.6, sleeper: 0.4 },
  /**
   * Best ball. Underdog *is* the best-ball market, so its lead widens — but
   * Sleeper still holds a quarter, because the league being drafted is a
   * Sleeper league whatever its format.
   */
  bestBall: { dog: 0.75, sleeper: 0.25 },
} as const;

export type MarketFormat = 'standard' | 'best_ball';

/**
 * When a disagreement stops being an opinion and starts being a data error.
 *
 * Two markets disagreeing by twenty picks is information and the blend is built
 * to carry it. Two markets disagreeing by a hundred and eighty is not a
 * disagreement — nobody thinks the 188th player off the board is the first —
 * and blending it produces a confident, catastrophic number: at 60/40 a DOG of
 * 1.0 against a Sleeper of 188 prices him at 75.8, which is wrong by seventy
 * picks in a way that looks entirely plausible on a card.
 *
 * Measured on the deeper of the two prices, because ADP dispersion grows with
 * depth: the eighth and the twelfth pick are close, and the 180th and the 200th
 * are the same player as far as any market is concerned. A fixed threshold
 * would either fire on ordinary late-round noise or never fire at all.
 *
 * Both conditions have to hold. The floor stops a fifteen-pick disagreement at
 * the top of the board from ever tripping it — that is exactly the signal DOG
 * was added for — and the share stops a forty-pick gap deep in the board, which
 * is ordinary, from being treated as an error.
 */
export const OUTLIER_GUARD = {
  /** Below this many picks of disagreement, nothing is ever suspect. */
  floorPicks: 40,
  /** And it must also exceed this share of the deeper of the two prices. */
  shareOfDeeper: 0.6,
} as const;

/**
 * Is this pair of prices too far apart to be two opinions about one player?
 *
 * Pure, and exported so the threshold can be reasoned about rather than
 * discovered by watching a board misbehave.
 */
export function isImplausibleDisagreement(dogAdp: number, sleeperAdp: number): boolean {
  const gap = Math.abs(dogAdp - sleeperAdp);
  const deeper = Math.max(dogAdp, sleeperAdp);
  return gap > OUTLIER_GUARD.floorPicks && gap > deeper * OUTLIER_GUARD.shareOfDeeper;
}

export interface MarketBaselineInput {
  /** Raw Underdog ADP. Null when unpriced, unusable or stale. */
  dogAdp: number | null;
  /** Sleeper ADP, from the frozen snapshot. */
  sleeperAdp: number | null;
  format: MarketFormat;
}

export interface MarketBaselineBlend {
  /**
   * The blended draft position the market-value component prices against, or
   * null when neither market has an opinion.
   */
  adp: number | null;
  /** The weights actually applied, after renormalising for missing sources. */
  weights: { dog: number; sleeper: number };
  /** The weights the format asks for, before any renormalisation. */
  nominal: { dog: number; sleeper: number };
  /** Which markets contributed. */
  sources: ('dog' | 'sleeper')[];
  /** True when only one market answered and it carried the whole baseline. */
  singleSource: boolean;
  /** True when neither did. */
  unknown: boolean;
  /**
   * True when the two prices were too far apart to be two opinions about one
   * player, so the Underdog number was set aside as suspect.
   *
   * Distinct from `singleSource`, which means the other market simply had no
   * price. This means it had one and it was not believable — a different fact,
   * and one the board should be able to say out loud.
   */
  suspectDog: boolean;
  /** Said plainly, for the breakdown and the diagnostics. */
  note: string;
}

/** The nominal blend for a format, with no renormalisation applied. */
export function blendWeights(format: MarketFormat): { dog: number; sleeper: number } {
  return format === 'best_ball' ? { ...MARKET_BLEND.bestBall } : { ...MARKET_BLEND.standard };
}

/**
 * The market baseline: one draft position, from whichever markets answered.
 *
 * Pure arithmetic over two numbers and a format. It never invents the absent
 * source, never substitutes one for the other, and never moves a player for
 * having been priced by one market rather than two — a single-source baseline
 * is exactly that source's own number, which is the only honest answer
 * available.
 */
export function blendMarketBaseline(input: MarketBaselineInput): MarketBaselineBlend {
  const nominal = blendWeights(input.format);
  const dog = usable(input.dogAdp);
  const sleeper = usable(input.sleeperAdp);

  if (dog == null && sleeper == null) {
    return {
      adp: null,
      weights: { dog: 0, sleeper: 0 },
      nominal,
      sources: [],
      singleSource: false,
      unknown: true,
      suspectDog: false,
      note: 'neither Underdog nor Sleeper has priced him',
    };
  }

  if (dog != null && sleeper == null) {
    return {
      adp: round2(dog),
      weights: { dog: 1, sleeper: 0 },
      nominal,
      sources: ['dog'],
      singleSource: true,
      unknown: false,
      suspectDog: false,
      note: 'Underdog only — no Sleeper ADP, so DOG carries the whole market baseline',
    };
  }

  if (dog == null && sleeper != null) {
    return {
      adp: round2(sleeper),
      weights: { dog: 0, sleeper: 1 },
      nominal,
      sources: ['sleeper'],
      singleSource: true,
      unknown: false,
      suspectDog: false,
      note: 'Sleeper only — no usable Underdog ADP, so Sleeper carries the whole market baseline',
    };
  }

  /*
   * The source-quality safeguard, before the two are ever mixed.
   *
   * A DOG value that cannot be a view of the same player is not blended at a
   * reduced weight — it is set aside, and Sleeper carries the baseline alone.
   * Blending it would be the worst of both: a number wrong by seventy picks,
   * carrying the authority of two markets agreeing to it.
   *
   * Sleeper is the survivor rather than DOG because Sleeper is the market the
   * user is drafting in, so an error there would be visible on the board they
   * are looking at, while an error in a fetched third-party file is exactly the
   * failure that arrives silently.
   */
  if (isImplausibleDisagreement(dog!, sleeper!)) {
    return {
      adp: round2(sleeper!),
      weights: { dog: 0, sleeper: 1 },
      nominal,
      sources: ['sleeper'],
      singleSource: true,
      unknown: false,
      suspectDog: true,
      note: `Underdog has him at ${round1(dog!)} against Sleeper's ${round1(
        sleeper!,
      )} — too far apart to be the same player, so DOG was set aside`,
    };
  }

  /*
   * Both present: the format's own weights, unmodified.
   *
   * They already sum to one, so there is nothing to renormalise here — the
   * division below is written out anyway so that changing the constants to a
   * pair that does not sum to one cannot silently change what the blend means.
   */
  const total = nominal.dog + nominal.sleeper;
  const weights = { dog: nominal.dog / total, sleeper: nominal.sleeper / total };
  return {
    adp: round2(weights.dog * dog! + weights.sleeper * sleeper!),
    weights,
    nominal,
    sources: ['dog', 'sleeper'],
    singleSource: false,
    unknown: false,
    suspectDog: false,
    note: `${Math.round(weights.dog * 100)}% Underdog / ${Math.round(weights.sleeper * 100)}% Sleeper`,
  };
}

/**
 * How far apart the two markets are, kept as context and never paid twice.
 *
 * Sleeper at 70 and Underdog at 52 is a real fact about a player and worth
 * saying on a card. It is deliberately *not* a bonus: the blend has already
 * priced him at 59.2, which is the whole of what the disagreement is worth to
 * the ranking. Adding a second term for "and the markets disagree in his
 * favour" would count the same eighteen picks twice.
 */
export function marketDisagreement(dogAdp: number | null, sleeperAdp: number | null): {
  picks: number | null;
  leader: 'dog' | 'sleeper' | null;
  note: string | null;
} {
  const dog = usable(dogAdp);
  const sleeper = usable(sleeperAdp);
  if (dog == null || sleeper == null) return { picks: null, leader: null, note: null };
  const picks = round1(Math.abs(dog - sleeper));
  if (picks < 1) return { picks, leader: null, note: null };
  // The lower ADP is the more bullish market: he goes earlier there.
  const leader = dog < sleeper ? 'dog' : 'sleeper';
  return {
    picks,
    leader,
    note:
      leader === 'dog'
        ? `Underdog takes him ${picks} picks earlier than Sleeper`
        : `Sleeper takes him ${picks} picks earlier than Underdog`,
  };
}

/**
 * "Has this market priced him at all" — and deliberately nothing stricter.
 *
 * Finite, not positive. Rejecting non-positive values here would be this
 * module quietly re-deciding what counts as a valid ADP, which is not its job
 * and is a change in behaviour for every board that existed before it: the
 * market-value component has always accepted whatever number the snapshot
 * carried and priced him against it.
 *
 * Garbage is filtered where garbage arrives. The Underdog parsers keep only
 * rows with a positive, finite ADP and `validateRawAdp` rejects payloads whose
 * shape says "ranking", so a nonsense DOG number never reaches this function.
 */
function usable(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
