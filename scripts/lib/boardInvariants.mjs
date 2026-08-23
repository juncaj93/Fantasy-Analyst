/**
 * What must be true of a draft board, as pure predicates.
 *
 * Extracted from `probe-live-smoke.mjs` so the probe's own claims can be
 * tested. A smoke probe is a gate, and a gate nobody has ever seen fail is a
 * gate nobody knows the shape of — these had been quietly asserting a contract
 * the product moved off, and passing, because production was the only thing
 * they had ever been pointed at and nobody had pointed a violation at them.
 *
 * Nothing here fetches anything. The probe supplies the recommendations and
 * prints the results; this decides only what "correct" means.
 */

/**
 * Priced means *any* market priced him, which is what the board sorts on.
 *
 * Not `r.adp`, which is Sleeper's number alone. The distinction is the whole
 * reason this file exists: a player Underdog has priced and Sleeper has not is
 * correctly ranked among the priced, and reading `r.adp` reports him as an
 * unpriced row sitting illegally at the top of the board.
 */
export const isPriced = (rec) => rec?.marketBlend?.adp != null;

/**
 * Ordering: totals descend among the priced, and the unpriced are a tail.
 *
 * The tail is policy rather than arithmetic — an unknown market contributes
 * zero while a genuine reach contributes a negative, so sorting on the total
 * alone floats anonymous players above ranked ones.
 */
export function orderInvariants(recs) {
  const priced = recs.filter(isPriced);
  const pricedTotals = priced.map((r) => r.total);
  const firstUnpriced = recs.findIndex((r) => !isPriced(r));
  const lastPriced = recs.map(isPriced).lastIndexOf(true);

  return [
    {
      label: 'the board is still ordered by score, not by health',
      ok: pricedTotals.every((t, i) => i === 0 || pricedTotals[i - 1] >= t),
      detail: `${priced.length} priced players in order`,
    },
    {
      label: 'and players no market can price are ranked after the ones it can',
      ok: firstUnpriced === -1 || firstUnpriced > lastPriced,
      detail:
        firstUnpriced === -1
          ? 'every player on the board carries a market price'
          : `first unpriced at ${firstUnpriced + 1}, last priced at ${lastPriced + 1}, of ${recs.length}`,
    },
  ];
}

/**
 * The visible Score.
 *
 * `score` is `number | null` and the null is the contract, not a hole in it: a
 * player no market prices is missing the component that dominates the scale, so
 * a total near zero would map to 83 on a curve calibrated for boards whose
 * middle is negative. He shows a dash, exactly as he already does for ADP, Val
 * and Next.
 *
 * That is two assertions rather than one loosened one. Priced players must
 * carry a real whole number; unpriced players must carry null and never a
 * number — the direction that actually matters, because an invented 83 beside
 * a dash for everything else is the failure this contract exists to prevent.
 */
export function scoreInvariants(recs) {
  const priced = recs.filter(isPriced);
  const pricedScores = priced.map((r) => r.score);
  const unpricedScores = recs.filter((r) => !isPriced(r)).map((r) => r.score);
  const top = pricedScores.slice(0, 20);

  return [
    {
      label: 'every priced player carries a whole-number Score in range',
      ok: pricedScores.length > 0 && pricedScores.every((s) => Number.isInteger(s) && s >= 0 && s <= 100),
      detail: `${pricedScores.length} priced, ${pricedScores[0]} … ${pricedScores[pricedScores.length - 1]}`,
    },
    {
      label: 'and an unpriced player carries no Score at all, rather than an invented one',
      ok: unpricedScores.every((s) => s === null),
      detail:
        unpricedScores.length === 0
          ? 'every player is priced'
          : `${unpricedScores.filter((s) => s === null).length} of ${unpricedScores.length} correctly blank`,
    },
    {
      label: 'Score never contradicts board order',
      ok: pricedScores.every((s, i) => i === 0 || pricedScores[i - 1] >= s),
      detail: `across ${pricedScores.length} priced players`,
    },
    {
      /*
       * Flatness, asked of the rows a Score is actually calibrated for.
       *
       * The old form read the top 20 of the whole board, which now includes
       * unpriced rows carrying null — and `Math.min` over a list containing
       * null returns 0, so it reported a 0–91 spread and failed for a reason
       * that had nothing to do with calibration.
       */
      label: 'it separates the players actually being chosen between',
      ok: top.length > 3 && Math.max(...top) - Math.min(...top) >= 3,
      detail:
        top.length === 0
          ? 'no priced players on the board'
          : `top 20 priced span ${Math.min(...top)}–${Math.max(...top)}, all priced ${Math.min(
              ...pricedScores,
            )}–${Math.max(...pricedScores)}`,
    },
  ];
}
