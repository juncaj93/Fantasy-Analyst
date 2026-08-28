/**
 * The five positions of the draft board's weighting control, and nothing else.
 *
 * A leaf on purpose. The Settings screen needs the list of positions at
 * runtime to draw the slider, and Rollup places any module the entry can reach
 * in the entry chunk — so whatever lives here ships on every page load,
 * including to a reader who never opens Settings. What that costs has to stay
 * five strings and a parser.
 *
 * The arithmetic those positions stand for is next door in `signalWeights.ts`,
 * which the board builder imports and the browser does not. That split is the
 * same one `core/dst/weeks.ts` and `core/sleeper/rosterShape.ts` are, made for
 * the same reason and enforced by the same check — see `chunkOwnership` in
 * `perf-budgets.json`.
 *
 * What the control means, and why only one side of it moves, is written where
 * the weights are.
 */

/**
 * From "the market decides" to "my own reading decides".
 *
 * Named rather than numbered in storage and on the wire: a stored `0.75` is a
 * number somebody has to look up, and a stored `lean-market` says what the
 * owner chose. The numbers live in `signalWeights.ts` and nowhere else.
 */
export type SignalBalance = 'market' | 'lean-market' | 'balanced' | 'lean-personal' | 'personal';

/** Left to right, as the control presents them. */
export const SIGNAL_BALANCE_ORDER: readonly SignalBalance[] = [
  'market',
  'lean-market',
  'balanced',
  'lean-personal',
  'personal',
];

/** Today's behaviour, and what every unset or unreadable value falls back to. */
export const SIGNAL_BALANCE_DEFAULT: SignalBalance = 'balanced';

/**
 * A stored or posted value, read as a position. Anything else is the default.
 *
 * Unreadable input is not an error here. The setting arrives from a key/value
 * table that predates it and from a request body, and the honest answer to
 * "this app was upgraded and the row says something I do not recognise" is the
 * behaviour the board has always had, not a 500 in front of the draft board on
 * draft day.
 */
export function readSignalBalance(value: unknown): SignalBalance {
  return typeof value === 'string' && (SIGNAL_BALANCE_ORDER as readonly string[]).includes(value)
    ? (value as SignalBalance)
    : SIGNAL_BALANCE_DEFAULT;
}
