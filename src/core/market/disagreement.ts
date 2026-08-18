/**
 * When the crowd and the model do not agree, say so.
 *
 * Two populations of players are worth finding, and neither is found by any
 * ranking this app already produces:
 *
 *   - **the market is surging and the usage is not.** Somebody scored three
 *     touchdowns on four touches, or a name is in every headline for a reason
 *     that will not repeat. The room is about to spend real money. The correct
 *     output is *not* a higher projection — it is a warning that the price will
 *     exceed the evidence;
 *   - **the model likes him and nobody has noticed.** The role has grown for
 *     three weeks in a way that box scores hide. This is the only cheap edge a
 *     waiver wire ever offers, and it is invisible on both lists individually —
 *     it is precisely a *disagreement*.
 *
 * The output is a label, a sentence and a bounded confidence adjustment. It is
 * deliberately not a score multiplier: a player does not become better because
 * the crowd is wrong about him, and the moment disagreement is allowed to move a
 * projection, the projection stops being independent of the crowd and the
 * disagreement can never be detected again.
 */

export type DisagreementKind = 'market_ahead' | 'model_ahead' | 'agreed' | 'quiet' | 'unknown';

export interface DisagreementInput {
  /** 0–1 attention from the trending list. Null when he is not on it at all. */
  marketHeat: number | null;
  /**
   * The app's own conviction, 0–1: role trend, usage, evidence — whatever the
   * caller judges by, normalised before it gets here.
   */
  modelStrength: number | null;
  /** Whether the model figure rests on enough observation to disagree with. */
  modelObserved: boolean;
}

export interface Disagreement {
  kind: DisagreementKind;
  label: string;
  line: string | null;
  /**
   * A bounded nudge to *confidence*, never to value. Negative means "the number
   * is less trustworthy than it looks", positive means "worth investigating".
   */
  confidenceDelta: number;
  /** What this is allowed to change downstream, spelled out for the reader. */
  affects: 'bid_price_and_confidence_only';
}

/** Above this, the crowd is genuinely chasing him. */
const HOT = 0.6;
/** Below this, nobody is looking. */
const COLD = 0.25;
/** Above this, the app's own read is a real position rather than a shrug. */
const STRONG = 0.6;
const WEAK = 0.35;

export function detectDisagreement(input: DisagreementInput): Disagreement {
  const heat = input.marketHeat;
  const model = input.modelStrength;

  /*
   * A model with nothing behind it cannot disagree with anybody.
   *
   * This guard is the difference between "the market is wrong" and "we have six
   * targets of data". Without it every rookie with one good game becomes a
   * market-ahead warning, which is noise wearing the costume of insight.
   */
  if (model == null || !input.modelObserved) {
    return {
      kind: 'unknown',
      label: 'Not enough of our own data to disagree',
      line: heat != null && heat >= HOT ? 'Heavily added across Sleeper; we have no usage read to check it against.' : null,
      confidenceDelta: 0,
      affects: 'bid_price_and_confidence_only',
    };
  }

  if (heat == null || heat < COLD) {
    if (model >= STRONG) {
      return {
        kind: 'model_ahead',
        label: 'Ours, not the market’s',
        line: 'Our usage read is strong while the wider market is quiet — the cheap version of this add.',
        confidenceDelta: 0.05,
        affects: 'bid_price_and_confidence_only',
      };
    }
    return {
      kind: 'quiet',
      label: 'Quiet on both sides',
      line: null,
      confidenceDelta: 0,
      affects: 'bid_price_and_confidence_only',
    };
  }

  if (heat >= HOT && model <= WEAK) {
    return {
      kind: 'market_ahead',
      label: 'Market ahead of the usage',
      line: 'Being added everywhere, but the usage behind it is thin. Expect to pay for the story, not the role.',
      /*
       * Negative, and small. The player is not worse than the model says; the
       * *price* is worse, and the confidence in a low projection surviving
       * contact with a hyped week is genuinely lower.
       */
      confidenceDelta: -0.1,
      affects: 'bid_price_and_confidence_only',
    };
  }

  if (heat >= HOT && model >= STRONG) {
    return {
      kind: 'agreed',
      label: 'Market and usage agree',
      line: 'Both the room and our own read like him, which is the expensive version of being right.',
      confidenceDelta: 0.05,
      affects: 'bid_price_and_confidence_only',
    };
  }

  return {
    kind: 'agreed',
    label: 'No meaningful disagreement',
    line: null,
    confidenceDelta: 0,
    affects: 'bid_price_and_confidence_only',
  };
}

/**
 * The one place trending is permitted to touch a number.
 *
 * Demand feeds the *expected market price* in `core/faab/strategy.ts`, because
 * what the room will pay is literally a fact about the room. Returns a 0–1
 * demand reading and nothing that any projection can consume.
 */
export function demandFromDisagreement(input: DisagreementInput): number | null {
  if (input.marketHeat == null) return null;
  return Math.min(1, Math.max(0, input.marketHeat));
}
