/**
 * Every bench spot has a price, and it is paid whether or not you notice.
 *
 * A bench is not storage. Holding a player is a standing decision to decline
 * every other player who could occupy that spot for the rest of the season, and
 * the question "who do I drop" is really the question "what is this slot
 * currently earning, against what it could earn".
 *
 * The mistake this module exists to prevent is comparing within a position. A
 * mediocre QB2 looks fine next to other mediocre QB2s and looks absurd next to
 * *the slot he is occupying* — which could hold a running back one snap from a
 * three-down role. So every held player is scored on what the slot is worth with
 * him in it, and the drop list is the players earning least, whatever they play.
 *
 * Six things make a slot worth holding, and they are genuinely different things
 * rather than one thing measured six ways:
 *
 *   1. what he would score if you had to start him (rest-of-season value);
 *   2. what he is worth over the next four weeks, which is not the same thing;
 *   3. whether he insures a starter — a handcuff's value is conditional and real;
 *   4. optionality: a role that could grow is worth more than a settled floor;
 *   5. what replaces him if you are wrong, i.e. how good the free pool is;
 *   6. whether he covers a bye you would otherwise have to stream through.
 *
 * Nothing here drops anybody. It ranks, explains, and stops.
 */

export type SlotRole = 'starter' | 'bench' | 'reserve';

export interface HeldPlayer {
  playerId: string;
  name: string;
  position: string;
  role: SlotRole;
  /** Weekly points if he had to start. Null when he cannot be scored at all. */
  restOfSeasonValue: number | null;
  /** Weekly points over the next four weeks — the near-term half of the case. */
  fourWeekValue: number | null;
  /**
   * Points the roster would lose if the starter he backs up went down. Zero for
   * a player who insures nobody; this is the whole argument for a handcuff.
   */
  insuranceValue: number | null;
  /** Could the role grow? A settled backup has none of this; a rookie may. */
  upside: 'high' | 'moderate' | 'none' | 'unknown';
  /** Whether he fills a week the rest of the roster is on bye. */
  coversBye: boolean;
  /** Weekly points of the best freely available player at his position. */
  streamingReplacement: number | null;
}

export interface BenchSlotValue {
  playerId: string;
  name: string;
  position: string;
  /**
   * What the slot earns with him in it, in weekly points. Comparable *across*
   * positions, which is the entire point.
   */
  slotValue: number;
  /** Slot value minus what a free agent would give you. The real question. */
  surplus: number;
  components: { key: string; label: string; value: number; note: string }[];
  reasons: string[];
  /** Held back from the drop list for a stated reason, e.g. he is a starter. */
  protected: string | null;
}

export interface BenchAdvice {
  /** Worst surplus first — the players a new add should displace. */
  dropCandidates: BenchSlotValue[];
  /** Everybody scored, best first, for the full picture. */
  ranked: BenchSlotValue[];
  notes: string[];
}

/**
 * How much of a handcuff's conditional value counts.
 *
 * An insurance policy pays only if the thing insured fails. Counting the whole
 * conditional payout as if it were guaranteed is how a roster ends up with four
 * backup running backs and no third receiver. A quarter is roughly the chance a
 * given starter misses meaningful time in a season, and it is deliberately a
 * blunt constant rather than a per-player injury probability the app cannot
 * honestly estimate.
 */
export const INSURANCE_DISCOUNT = 0.25;

/** Weekly points added for a role that could still grow. */
const UPSIDE_POINTS = { high: 1.6, moderate: 0.8, none: 0, unknown: 0.3 } as const;

/** Weekly points added for covering a bye the roster cannot otherwise cover. */
const BYE_COVER_POINTS = 0.6;

/**
 * Score one held player as a slot rather than as a player.
 *
 * The near-term and rest-of-season readings are blended rather than picked
 * between: a bench spot is held over a horizon, and using only the four-week
 * number turns every bench into a streaming rotation while using only the
 * rest-of-season number ignores that most drops are made to solve this week.
 */
export function valueOfSlot(held: HeldPlayer): BenchSlotValue {
  const components: BenchSlotValue['components'] = [];
  const reasons: string[] = [];

  const ros = held.restOfSeasonValue ?? 0;
  const four = held.fourWeekValue ?? ros;
  const base = 0.4 * four + 0.6 * ros;
  components.push({
    key: 'value',
    label: 'If you had to start him',
    value: round2(base),
    note:
      held.restOfSeasonValue == null && held.fourWeekValue == null
        ? 'no scorable value'
        : `${four.toFixed(1)} pts over four weeks, ${ros.toFixed(1)} rest of season`,
  });

  const insurance = round2((held.insuranceValue ?? 0) * INSURANCE_DISCOUNT);
  if (insurance > 0) {
    components.push({
      key: 'insurance',
      label: 'Starter insurance',
      value: insurance,
      note: `${(held.insuranceValue ?? 0).toFixed(1)} pts if the man ahead of him goes down, discounted for the chance he does`,
    });
    reasons.push('Insures a starter you cannot replace from the wire.');
  }

  const upside = UPSIDE_POINTS[held.upside];
  if (upside > 0) {
    components.push({ key: 'upside', label: 'Optionality', value: upside, note: `${held.upside} chance the role grows` });
    if (held.upside === 'high') reasons.push('The role could still grow, which a settled bench player cannot do.');
  }

  const bye = held.coversBye ? BYE_COVER_POINTS : 0;
  if (bye > 0) {
    components.push({ key: 'bye', label: 'Bye coverage', value: bye, note: 'covers a week the roster is otherwise short' });
    reasons.push('Covers a bye week you would otherwise have to stream through.');
  }

  const slotValue = round2(base + insurance + upside + bye);

  /*
   * The comparison that decides everything.
   *
   * Not "is he good" but "is he better than what this slot could hold for
   * nothing". A replacement level of zero — nobody available at all — is exactly
   * when a mediocre player is worth keeping, and the subtraction gets that right
   * without a special case.
   */
  const replacement = held.streamingReplacement ?? 0;
  const surplus = round2(slotValue - replacement);
  components.push({
    key: 'replacement',
    label: 'What the wire offers instead',
    value: -round2(replacement),
    note:
      held.streamingReplacement == null
        ? 'no free-agent baseline available, counted as nothing'
        : `best free agent at ${held.position} is worth ${replacement.toFixed(1)} pts`,
  });

  if (surplus <= 0) {
    reasons.push('A free agent at the same position matches or beats him, so the slot is earning nothing.');
  }

  return {
    playerId: held.playerId,
    name: held.name,
    position: held.position,
    slotValue,
    surplus,
    components,
    reasons,
    protected: protectionFor(held),
  };
}

/**
 * Reasons a player is never offered as a drop, however low he scores.
 *
 * A starter is not a drop candidate — if he should not be starting, that is a
 * lineup decision and it happens somewhere else. A player on injured reserve
 * usually occupies a slot that is not a bench slot at all, so dropping him buys
 * nothing and costs a returning asset.
 */
function protectionFor(held: HeldPlayer): string | null {
  if (held.role === 'starter') return 'in your starting lineup';
  if (held.role === 'reserve') return 'on an injured-reserve slot, which is not a bench spot';
  return null;
}

/**
 * Rank a bench, and say who the slot should stop holding.
 *
 * `count` bounds the drop list rather than the ranking: seeing every player
 * scored is useful, being handed a list of eleven names to drop is not.
 */
export function evaluateBench(held: HeldPlayer[], opts: { count?: number } = {}): BenchAdvice {
  const count = opts.count ?? 3;
  const ranked = held.map(valueOfSlot).sort((a, b) => b.surplus - a.surplus || a.name.localeCompare(b.name));

  const droppable = ranked.filter((r) => r.protected == null);
  const notes: string[] = [];
  const protectedCount = ranked.length - droppable.length;
  if (protectedCount > 0) {
    notes.push(`${protectedCount} player(s) were excluded from the drop list as starters or reserve-slot players.`);
  }
  if (droppable.length === 0 && ranked.length > 0) {
    notes.push('Nothing on this roster is a bench slot right now, so there is no drop to recommend.');
  }

  return {
    dropCandidates: [...droppable].reverse().slice(0, count),
    ranked,
    notes,
  };
}

/**
 * The sentence the brief asks for, in the terms it asks for it.
 *
 * Explicitly cross-positional: naming what the slot could become is the half
 * that a within-position comparison can never produce.
 */
export function dropLine(candidate: BenchSlotValue, bestAlternative: { name: string; surplus: number } | null): string {
  if (bestAlternative && bestAlternative.surplus > candidate.surplus) {
    return `${candidate.name} earns ${candidate.surplus.toFixed(1)} pts of slot value; ${bestAlternative.name} would earn ${bestAlternative.surplus.toFixed(1)}.`;
  }
  if (candidate.surplus <= 0) {
    return `${candidate.name} is worth no more than a free agent at his position.`;
  }
  return `${candidate.name} is the least productive use of a bench slot at ${candidate.surplus.toFixed(1)} pts.`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
