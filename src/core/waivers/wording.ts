/**
 * The two phrases the Waivers screen draws, in a leaf with no imports.
 *
 * `board.ts` runs in the browser and needs these words and nothing else from
 * `yardstick.ts` or `signals.ts`. Importing either of those would carry the
 * whole comparison engine into the bundle every page load fetches, which is
 * the bug `core/dst/weeks.ts` was split out to fix. Both modules re-export
 * from here, so there is one wording.
 */

export type YardstickBasisWord = 'market' | 'sleeper';

export function basisLabel(basis: YardstickBasisWord): string {
  return basis === 'market' ? 'Vegas lines for both' : 'Sleeper projection for both';
}

/**
 * `#11 most-added on Sleeper today`.
 *
 * A rank and never a count. Sleeper's counts are not leagues: on 30 September
 * 2026 Ollie Gordon showed 3,950,079 adds in 24 hours, more than there are
 * Sleeper leagues, and Sleeper does not document what the number counts.
 */
export function mostAddedLine(rank: number): string {
  return `#${rank} most-added on Sleeper today`;
}
