/**
 * "Why did his rank move?" — answered from stored arithmetic, not narrated.
 *
 *     #8 -> #4
 *     +3 role
 *     +2 Vegas
 *     -1 matchup
 *
 * Two requirements make this hard, and both are enforced here rather than left
 * to whoever draws the card:
 *
 * - **The parts must reconcile to the actual change.** If the component deltas
 *   do not sum to the change in the total score, the explanation is wrong, and
 *   the honest response is to say so. `reconciles` is false and a residual line
 *   is added naming the unexplained amount. What is never done is quietly
 *   scaling the parts so they add up, which produces a card that always looks
 *   right and is sometimes a lie.
 *
 * - **A refresh that changed no input must produce no movement.** Recomputing
 *   the same board from the same data yields the same `inputHash`, and a
 *   snapshot with an unchanged hash is not stored — so there is no second
 *   observation for the first to be compared against, and the card correctly
 *   says nothing happened. Without this, opening the app twice would manufacture
 *   a movement story out of floating-point noise or, worse, out of nothing at
 *   all.
 */

export interface DecompositionComponent {
  key: string;
  label: string;
  value: number;
}

export interface Decomposition {
  context: string;
  scope: string;
  playerId: string;
  capturedAt: string;
  rank: number | null;
  total: number;
  components: DecompositionComponent[];
  inputHash: string;
}

export interface ComponentDelta {
  key: string;
  label: string;
  delta: number;
  /** `+3 role`, ready to print. */
  display: string;
}

export interface RankMovement {
  playerId: string;
  rankFrom: number | null;
  rankTo: number | null;
  /** `#8 -> #4`, or null when either rank is unknown. */
  rankDisplay: string | null;
  totalFrom: number;
  totalTo: number;
  totalDelta: number;
  parts: ComponentDelta[];
  /** True when the parts sum to `totalDelta` inside `RECONCILE_EPSILON`. */
  reconciles: boolean;
  /** Empty when nothing moved at all, which is the ordinary case. */
  moved: boolean;
  since: string;
}

/** Floating-point slack allowed before the decomposition is called broken. */
export const RECONCILE_EPSILON = 0.005;

/** Component movement below this is not printed. It is not a reason. */
export const MIN_PART = 0.05;

/**
 * A stable hash of whatever produced a score.
 *
 * FNV-1a over a canonical JSON rendering: dependency-free, synchronous (Workers
 * only offer `crypto.subtle` asynchronously, and this is called in a loop over
 * a board), and deterministic across runtimes. It is a change detector, not a
 * security primitive, and collisions here cost one missed movement story.
 *
 * Keys are sorted before hashing so two objects that differ only in insertion
 * order hash the same — otherwise the "no fake movement" guarantee would hold
 * only while nobody reordered a literal.
 */
export function hashInputs(value: unknown): string {
  const canonical = canonicalize(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Compare two decompositions of the same player on the same board.
 *
 * Components present on one side only are treated as having been zero on the
 * other, which is correct: a component that did not exist contributed nothing.
 */
export function diffDecomposition(previous: Decomposition, current: Decomposition): RankMovement {
  const before = new Map(previous.components.map((c) => [c.key, c]));
  const after = new Map(current.components.map((c) => [c.key, c]));
  const keys = [...new Set([...before.keys(), ...after.keys()])];

  const parts: ComponentDelta[] = [];
  let explained = 0;
  for (const key of keys) {
    const from = before.get(key)?.value ?? 0;
    const to = after.get(key)?.value ?? 0;
    const delta = round3(to - from);
    explained += delta;
    if (Math.abs(delta) < MIN_PART) continue;
    const label = after.get(key)?.label ?? before.get(key)?.label ?? key;
    parts.push({ key, label, delta, display: `${signed(delta)} ${label.toLowerCase()}` });
  }

  const totalDelta = round3(current.total - previous.total);
  const residual = round3(totalDelta - explained);
  const reconciles = Math.abs(residual) <= RECONCILE_EPSILON;

  if (!reconciles) {
    /*
     * The decomposition does not add up, and the card says so.
     *
     * This happens when a scoring layer applies something outside its own
     * component list — a cap, a multiplier, a filter — and the fix is in that
     * layer, not here. Naming the gap is the only response that does not
     * involve inventing a reason.
     */
    parts.push({
      key: 'unexplained',
      label: 'not accounted for by the stored components',
      delta: residual,
      display: `${signed(residual)} unexplained`,
    });
  }

  parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const moved =
    Math.abs(totalDelta) > RECONCILE_EPSILON || (previous.rank != null && current.rank != null && previous.rank !== current.rank);

  return {
    playerId: current.playerId,
    rankFrom: previous.rank,
    rankTo: current.rank,
    rankDisplay: previous.rank != null && current.rank != null ? `#${previous.rank} -> #${current.rank}` : null,
    totalFrom: round3(previous.total),
    totalTo: round3(current.total),
    totalDelta,
    parts,
    reconciles,
    moved,
    since: previous.capturedAt,
  };
}

/**
 * Should this snapshot be stored at all?
 *
 * Only when the inputs differ from the last one kept. This is the guarantee
 * that a same-input refresh produces no movement, and it lives here — in one
 * function, next to the diff it protects — rather than in each caller.
 */
export function shouldCapture(latest: Decomposition | null, candidate: { inputHash: string }): boolean {
  return latest == null || latest.inputHash !== candidate.inputHash;
}

function signed(v: number): string {
  const rounded = Math.abs(v) >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
