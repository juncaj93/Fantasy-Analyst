/**
 * The folded bench's few words on Team: `1 strong alternative`, `Toss-up`, or
 * `No better option`.
 *
 * Counted from the optimiser's own answer rather than a second opinion: a
 * swap or a fill is a bench player who would start. Under the toss-up bar
 * (`core/startsit/tossup.ts`, two points) the lineup changes nothing and Best
 * move says "Toss-up", so the bench line says the same (4 November 2026); it
 * used to say "No better option" right next to it. Null when the lineup could
 * not be computed, because any of the three would then be a claim nobody
 * checked.
 */
export function benchSummary(
  lineup: { found?: boolean; swaps: readonly unknown[]; fills?: readonly unknown[] | null; tossUps?: readonly unknown[] | null } | null | undefined,
): string | null {
  if (!lineup?.found) return null;
  const count = lineup.swaps.length + (lineup.fills?.length ?? 0);
  if (count > 0) return `${count} strong alternative${count === 1 ? '' : 's'}`;
  return (lineup.tossUps?.length ?? 0) > 0 ? 'Toss-up' : 'No better option';
}
