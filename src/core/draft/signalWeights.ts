/**
 * How loudly the owner's own research speaks against the market's price.
 *
 * Every recommendation on the draft board is a market price with adjustments
 * made to it. The market price is `market_value` — how far the draft has gone
 * past a player's blended ADP — with a second, smaller market voice beside it
 * in `market_expectation`, which is what the season-long betting lines expect
 * of him. Everything the owner himself put into this app argues with that
 * price: the newsletter tally he scored, the ♥ he put on a player, the AVOID
 * his accumulated reading produced.
 *
 * Those are the two sides, and the balance between them was fixed. The control
 * in Settings makes it a preference, in five positions, without making it a
 * mystery: the market side never moves, and the owner's side is scaled by one
 * multiplier that the board discloses in the same `score × weight =
 * contribution` line every component already prints.
 *
 * ## Why only the personal side moves
 *
 * Scaling `market_value` would be the other half of a symmetric knob and it is
 * deliberately not done. That weight is 1.0 and the whole composite is
 * calibrated against it — `draftScore` maps a total to a number out of 100
 * using constants measured on a board where the market carried exactly that
 * much (see `score.ts`), and the tier ladders, separation and opportunity all
 * read composites built on it. Moving the anchor moves everything that was
 * measured against it and turns a preference into a recalibration. Moving what
 * argues with the anchor does the job the owner actually wants done: the ratio
 * of market to personal goes from 1 : 0.5 at one end to 1 : 1.5 at the other,
 * which is the same statement made from the safe side.
 *
 * ## What is not on either side
 *
 * `need`, `scarcity`, `tier_cliff` and `league_fit` are facts about his roster,
 * his league's rules and the shape of the board — not an opinion held by the
 * market or by him, so neither pole owns them and they do not move.
 * `survival_urgency` is timing: whether a player lasts until the next pick.
 * `separation`, `opportunity` and `team_concentration` run in a second pass
 * over composites the first pass produced and carry weights of their own; they
 * echo whatever the first pass said, which is exactly what they are for.
 *
 * Defences do not move at all. They are ranked on the draft market and nothing
 * else (`DEFENCE_WEIGHTS`), so there is no personal signal there to trade off —
 * a slider that changed a defence's score without changing its order would be
 * a number moving for no reason the board could explain.
 *
 * ## The default is the past
 *
 * `balanced` returns the weight table it was handed, by identity and not by
 * arithmetic that happens to land on the same numbers. A board built at the
 * default position is the board this app has always built, component for
 * component and byte for byte — asserted in `tests/draft.signalBalance.test.ts`
 * rather than argued here.
 *
 * ## Why this is not in `signalBalance.ts`
 *
 * That module is the list of positions, and the Settings screen imports it to
 * draw the control — which puts it in the entry chunk on every page load. This
 * half is only ever run where a board is built, so it stays out of the browser
 * and out of the shell. Same split, same reason, as `core/dst/weeks.ts` and
 * `core/sleeper/rosterShape.ts`.
 */

/*
 * Type-only, deliberately: a value import of `engine.ts` from a module the
 * Settings screen can reach would put the whole ranking engine — tiers,
 * survival, concentration, opportunity — into the browser bundle. The caller
 * supplies the weight table this scales.
 */
import type { DraftComponentWeights } from './engine.ts';
import type { SignalBalance } from './signalBalance.ts';

/**
 * The components the owner's own work produced, and the only ones this moves.
 *
 * Deliberately a list of keys rather than a predicate over names: a component
 * added later is not swept into "personal" because somebody called it
 * something suggestive, and the compiler names this file the moment a key
 * changes.
 */
export const PERSONAL_COMPONENT_KEYS = [
  'newsLifetime',
  'news30',
  'news7',
  'myGuy',
  'avoid',
] as const satisfies readonly (keyof DraftComponentWeights)[];

/**
 * What each position multiplies the personal side by.
 *
 * Half to one-and-a-half, in quarters. The bound is not arbitrary: at full
 * strength the personal components are worth about 1.47 of composite together
 * (0.67 of news, 0.5 of ♥♥♥, 0.3 of AVOID), and a point of ADP is worth about
 * 0.05 in the reach regime — so the extremes are roughly ±15 picks of ADP on a
 * player carrying every personal signal at once, against a market component
 * that reaches a full 1.0 on a thirty-pick faller by itself. Loud enough to
 * reorder players the market rates alike, never enough to carry a player the
 * market has priced far away.
 */
const PERSONAL_SCALE: Record<SignalBalance, number> = {
  market: 0.5,
  'lean-market': 0.75,
  balanced: 1,
  'lean-personal': 1.25,
  personal: 1.5,
};

/** How much louder or quieter the personal side is at this position. */
export function personalScale(balance: SignalBalance): number {
  return PERSONAL_SCALE[balance] ?? 1;
}

/**
 * The weight table to rank with, at this position of the control.
 *
 * At `balanced` this is the identity function — the table handed in is the
 * table handed back, not a copy with equal numbers in it. That is what makes
 * "the default changes nothing" a property of the call graph rather than a
 * claim about floating-point arithmetic.
 *
 * The base table is supplied rather than defaulted to `DEFAULT_WEIGHTS` so
 * that this module keeps no runtime dependency on the engine; see the import
 * at the top of the file.
 */
export function weightsForSignalBalance(
  balance: SignalBalance,
  base: DraftComponentWeights,
): DraftComponentWeights {
  const scale = personalScale(balance);
  if (scale === 1) return base;
  const scaled: DraftComponentWeights = { ...base };
  for (const key of PERSONAL_COMPONENT_KEYS) scaled[key] = round3(base[key] * scale);
  return scaled;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
