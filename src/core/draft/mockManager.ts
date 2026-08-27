/**
 * What a computer-controlled league mate does on the clock.
 *
 * This is the one genuinely new piece of modelling in Mock Draft, and it is
 * deliberately small. A practice draft is only worth practising against if the
 * room behaves like the room — so the bots are **the owner's real league
 * mates**, drafting from their own histories, rather than generic opponents
 * pulled off a positional curve.
 *
 * ## Three inputs, and no fourth
 *
 *  1. **Sleeper ADP** — the anchor, and the heaviest weight by a distance. It
 *     is the same market the real Draft screen already ranks against, so a
 *     rehearsal and a live board disagree about who is available for reasons
 *     that are about the draft rather than about two different models.
 *  2. **`core/managers/` tendencies** — the bounded, sample-gated profile built
 *     from each manager's real league history, the same one that moves `Next%`.
 *     It nudges; it does not rank.
 *  3. **Bounded randomness** — so two mocks of the same board are two different
 *     drafts rather than one draft played twice.
 *
 * There is no fourth input, and specifically **no second ranking engine**.
 * Nothing here reads `Score`, the tier ladders, projections, injuries or any
 * evidence signal. A bot's opinion of a player is the market's opinion of a
 * player, moved a little by who is picking. That boundary is what stops a
 * rehearsal quietly becoming a claim about who is good: if a mock draft
 * disagrees with the board about a player, it is disagreeing about *when he
 * goes*, which is the only thing it is entitled to have a view on.
 *
 * ## Where the numbers come from
 *
 * `MANAGER_PRIOR` is imported rather than restated. The question this module
 * asks a tendency — "how much more does this manager want a quarterback right
 * now" — is the same question `nextpick/managerPrior.ts` asks it, and a second
 * gain constant tuned by hand here would mean a manager who is a mild
 * quarterback risk on the live board is an eager one in a rehearsal of the same
 * draft. One tuning, one meaning, both surfaces.
 *
 * The same goes for what "he has filled it" means: `buildDemandPlan` decides,
 * including the superflex rule, so a bot in a superflex league keeps wanting
 * quarterbacks for exactly as long as the survival model says he does.
 *
 * ## Sample gating
 *
 * Below the tendency module's own threshold, `usable` is false and this module
 * asks nothing further: that manager drafts on ADP and jitter alone, which is
 * what every other engine in this app does when a signal has nothing to say.
 * It is not a penalty and not a fallback personality — it is the market, which
 * is what the model was anchored on in the first place.
 *
 * Pure, synchronous, and given everything it reads. No I/O, no clock, no
 * `Math.random` — see `nextpick/rng.ts` for why the randomness is drawn rather
 * than generated.
 */

import { buildDemandPlan, type PositionCounts } from './nextpick/demand.ts';
import { MANAGER_PRIOR } from './nextpick/managerPrior.ts';
import { sampleIndex } from './nextpick/rng.ts';
import type { ManagerTendencies } from '../managers/managerTendencies.ts';
import type { RosterShape } from '../sleeper/scoring.ts';

export const MOCK_MANAGER = {
  /**
   * How far down the best-available list a bot will look.
   *
   * Twelve is a round of a normal league, and it is a ceiling on surprise
   * rather than a target: the decay below means the twelfth man is drawn about
   * three times in a hundred. Larger windows do not make a mock more realistic,
   * they make it a lottery — and the complaint about a practice draft that
   * takes Ja'Marr Chase at 40 is that it taught the drafter something false.
   */
  window: 12,
  /**
   * The decay constant on market order, in places.
   *
   * Weight is `exp(-i / spread)` over a candidate's index in the window, so the
   * best available carries 1, three-and-a-half places later about 0.37, seven
   * about 0.14. Chosen so the median bot pick lands within two of best
   * available and a genuine reach past six is rare but not impossible — which
   * is roughly what a real room does, and is the whole of "heaviest weight".
   */
  spread: 3.5,
} as const;

/**
 * One player a bot could take.
 *
 * `marketRank` is the board's own market order — lower is better — and null
 * means neither market has priced him. Unpriced is not rank zero and not the
 * end of the world: he sorts behind everybody who has a price, which is what
 * puts him in reach only once a real draft would also be reaching.
 */
export interface MockCandidate {
  playerId: string;
  position: string;
  marketRank: number | null;
}

export interface MockManagerInput {
  /** Everybody still on the board. Order is irrelevant; this module sorts. */
  candidates: readonly MockCandidate[];
  /**
   * This manager's history. Null, absent or unusable all mean the same thing:
   * ADP and jitter, and nothing claimed.
   */
  tendencies?: ManagerTendencies | null;
  /** What he already holds **in this mock**, by position. */
  held?: PositionCounts;
  /** The league's own roster rules, for reading "has he filled it". */
  shape: RosterShape;
  /** A draw in [0,1). Seeded by the mock's state — see `nextpick/rng.ts`. */
  draw: number;
}

export interface MockManagerPick {
  playerId: string;
  /**
   * Which of the two models actually decided.
   *
   * `market` means the tendency contributed nothing — either there was no
   * usable sample, or everything it had to say was about positions he has
   * already filled. `market+history` means at least one weight moved.
   */
  basis: 'market' | 'market+history';
  /** Where he sat in the market window. 0 is best available. */
  marketIndex: number;
  /** The position multipliers actually applied. Empty under `market`. */
  multipliers: Record<string, number>;
  /** Plain sentences, for the diagnostics and for the tests. Never user copy. */
  notes: string[];
}

/**
 * The per-position nudge this manager's history is worth, right now.
 *
 * Exported because the blend is easier to test in two pieces than one, and
 * because a caller building a diagnostics panel wants the table rather than the
 * pick. Every multiplier is centred on 1 and bounded by `MANAGER_PRIOR.bounds`;
 * a position absent from the map is a position nothing is claimed about.
 *
 * Returns an empty map — meaning "the market, untouched" — whenever the sample
 * is short, which is the honest answer rather than a neutral-looking guess.
 */
export function mockManagerMultipliers(input: {
  tendencies?: ManagerTendencies | null;
  held?: PositionCounts;
  shape: RosterShape;
  positions: readonly string[];
}): Map<string, number> {
  const out = new Map<string, number>();
  const tendencies = input.tendencies;
  if (!tendencies || !tendencies.usable) return out;

  const positions = [...input.positions];
  const plan = buildDemandPlan(input.shape, positions);
  const held = input.held ?? {};

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]!;
    const tendency = tendencies.byPosition.get(position);
    if (!tendency || tendency.lift === 0) continue;

    /*
     * How much of this position he still has to solve, in [0,1].
     *
     * The same term `managerPrior.ts` applies, for the same reason: a manager
     * who has taken his quarterback early for three years is not a quarterback
     * risk once he has one this afternoon. Today outranks history, always.
     */
    const required = plan.required[i] ?? 0;
    const have = held[position] ?? 0;
    const open = required > 0 ? Math.max(0, required - have) / required : have > 0 ? 0 : 1;
    if (open <= MANAGER_PRIOR.suppressAt) continue;

    const multiplier = round3(
      clamp(
        1 + MANAGER_PRIOR.gain * tendency.lift * open,
        MANAGER_PRIOR.bounds.min,
        MANAGER_PRIOR.bounds.max,
      ),
    );
    if (multiplier !== 1) out.set(position, multiplier);
  }

  return out;
}

/**
 * Choose one player for a bot manager on the clock.
 *
 * Deterministic in its inputs: the same board, the same manager and the same
 * draw produce the same pick, every time, in a browser, in a Worker and in a
 * test. Returns null only when there is nobody left to take.
 */
export function pickForMockManager(input: MockManagerInput): MockManagerPick | null {
  const window = bestAvailable(input.candidates, MOCK_MANAGER.window);
  if (window.length === 0) return null;

  const positions = [...new Set(input.candidates.map((c) => c.position))].sort();
  const multipliers = mockManagerMultipliers({
    tendencies: input.tendencies,
    held: input.held,
    shape: input.shape,
    positions,
  });

  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < window.length; i++) {
    const market = Math.exp(-i / MOCK_MANAGER.spread);
    const weight = market * (multipliers.get(window[i]!.position) ?? 1);
    weights.push(weight);
    total += weight;
  }

  const draw = Number.isFinite(input.draw) ? Math.min(0.999999, Math.max(0, input.draw)) : 0;
  const index = Math.max(0, sampleIndex(weights, weights.length, total, draw));
  const chosen = window[index]!;

  const applied: Record<string, number> = {};
  for (const [position, multiplier] of multipliers) applied[position] = multiplier;

  const notes: string[] = [];
  const name = input.tendencies?.displayName;
  if (multipliers.size === 0) {
    notes.push(
      input.tendencies?.usable
        ? 'history had nothing left to say — every position it speaks to is already filled'
        : `no usable draft history${name ? ` for ${name}` : ''}; ADP and jitter alone`,
    );
  } else {
    for (const [position, multiplier] of multipliers) {
      notes.push(
        `${position} weight ×${multiplier} from ${input.tendencies!.draftsObserved} historical draft(s), ` +
          `${input.tendencies!.picksObserved} pick(s)`,
      );
    }
  }
  notes.push(`took the market's #${index + 1} of ${window.length} available`);

  return {
    playerId: chosen.playerId,
    basis: multipliers.size > 0 ? 'market+history' : 'market',
    marketIndex: index,
    multipliers: applied,
    notes,
  };
}

/**
 * The top of the board in market order, unpriced players last.
 *
 * Ties break on player id rather than on input order, because the input order
 * is whatever a repository happened to return and a mock that changed when a
 * query plan changed would not be reproducible from its own state.
 */
export function bestAvailable(candidates: readonly MockCandidate[], limit: number): MockCandidate[] {
  return [...candidates]
    .sort((a, b) => {
      const ar = a.marketRank ?? Number.POSITIVE_INFINITY;
      const br = b.marketRank ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 1;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
