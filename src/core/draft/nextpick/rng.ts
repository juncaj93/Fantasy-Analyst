/**
 * Randomness that is not random.
 *
 * A Monte Carlo estimate on a live screen has an obligation an offline one does
 * not: it must not move when nothing has moved. A board polled every three
 * seconds during a draft redraws the same forty rows, and if `Next` wandered by
 * a point each time the reader would learn — correctly — to ignore it. So every
 * draw comes from a generator seeded by the draft state itself. Same board,
 * same numbers, forever; a pick lands, the state changes, and the numbers change
 * because the situation did.
 *
 * `Math.random` is never called anywhere in this feature.
 */

/**
 * FNV-1a over a string, as an unsigned 32-bit integer.
 *
 * Chosen for being short, dependency-free and stable across engines — the same
 * string must hash the same on a phone, in a Worker and in a test, or the
 * "identical state gives identical output" promise only holds within one
 * process.
 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // The FNV prime, 16777619, by shift-and-add: `hash * 16777619` overflows
    // the exact-integer range and stops being FNV.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Mulberry32: 32 bits of state, one multiply-xor round, uniform on [0,1).
 *
 * Small and fast matters here — this is called a few hundred thousand times per
 * board — and its statistical quality is far beyond what sampling a position
 * and a player out of a few dozen weights can detect.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick an index from parallel weight/count arrays, given a draw in [0,1).
 *
 * The weights need not be normalised; `total` is passed in because the caller
 * has always just summed them and summing twice over a hot loop is waste.
 *
 * Returns the last index if floating-point drift leaves the draw past the end,
 * which is the only honest answer when the weights sum to slightly less than
 * they claim, and is never wrong by more than one candidate at the tail.
 */
export function sampleIndex(weights: readonly number[], count: number, total: number, draw: number): number {
  if (count <= 0) return -1;
  if (!(total > 0)) return 0;
  let acc = 0;
  const target = draw * total;
  for (let i = 0; i < count; i++) {
    acc += weights[i]!;
    if (target < acc) return i;
  }
  return count - 1;
}
