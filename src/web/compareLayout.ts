/**
 * How the compare sheet lays out numbers it is given. Arithmetic on the
 * comparison the server already made, and nothing else: no score, projection
 * or component value is computed here, only arranged, grouped and measured
 * against each other for drawing.
 *
 * Kept out of `TeamScreen.tsx` so the rules that decide what a reader sees
 * (which rows collapse, which factors explain a gap) can be tested without a
 * browser.
 */

/** The part of a start/sit component this module reads. */
export interface LayoutComponent {
  key: string;
  label: string;
  value: number;
  unknown: boolean;
}

/** The part of an evaluation this module reads. */
export interface LayoutEvaluation {
  playerId: string;
  name: string;
  score: number | null;
  projection?: number | null;
  components: LayoutComponent[];
}

export interface FactorRow {
  key: string;
  label: string;
}

export interface FactorGroup {
  id: 'market' | 'risk' | 'context';
  title: string;
  factors: FactorRow[];
}

/**
 * Which card each engine factor is drawn in.
 *
 * Grouped by what the factor is *about*, which is how `evaluatePlayer` builds
 * them: the market's expectation, then what can take a player off the field or
 * make his number shaky, then the role and the game around him. The defence
 * model reuses `vegas`, `status` and `uncertainty`, so a defence lands in the
 * same three cards.
 *
 * A key missing from both lists goes to the last card rather than vanishing,
 * because the engine owns which factors exist and a new one must still be seen.
 */
const MARKET_KEYS = new Set(['vegas']);
const RISK_KEYS = new Set(['news_recent', 'news_raw', 'status', 'uncertainty']);

const GROUP_TITLES: Record<FactorGroup['id'], string> = {
  market: 'Market & coverage',
  risk: 'Risk & availability',
  context: 'Opportunity & context',
};

function groupOf(key: string): FactorGroup['id'] {
  if (MARKET_KEYS.has(key)) return 'market';
  if (RISK_KEYS.has(key)) return 'risk';
  return 'context';
}

/** A component that carries a real reading, as opposed to a dash. */
function readable(component: LayoutComponent | undefined): component is LayoutComponent {
  return component != null && !component.unknown;
}

/**
 * The factor rows, grouped, with the rows nobody has a value for pulled out.
 *
 * Rows are the union of every player's components, in the order the engine
 * wrote them. A factor where *every* player is a dash (not part of how he is
 * scored, or unknown) says nothing about this decision, so it leaves the grid
 * and joins `untracked`, which the sheet prints once as a sentence. A factor
 * with at least one real value keeps its row, dashes and all.
 */
export function layoutFactors(columns: readonly LayoutEvaluation[]): {
  groups: FactorGroup[];
  untracked: FactorRow[];
} {
  const factors: FactorRow[] = [];
  for (const evaluation of columns) {
    for (const component of evaluation.components) {
      if (!factors.some((f) => f.key === component.key)) factors.push({ key: component.key, label: component.label });
    }
  }

  const groups: FactorGroup[] = (['market', 'risk', 'context'] as const).map((id) => ({
    id,
    title: GROUP_TITLES[id],
    factors: [],
  }));
  const untracked: FactorRow[] = [];

  for (const factor of factors) {
    const tracked = columns.some((e) => readable(e.components.find((c) => c.key === factor.key)));
    if (!tracked) {
      untracked.push(factor);
      continue;
    }
    groups.find((g) => g.id === groupOf(factor.key))!.factors.push(factor);
  }
  return { groups, untracked };
}

/**
 * A surname, for the places a full name will not fit: bar labels and column
 * heads. A generational suffix is skipped, so `Marvin Harrison Jr.` is
 * `Harrison` rather than `Jr.`. A one-word name is returned whole.
 */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const suffix = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;
  const last = parts[parts.length - 1]!;
  return suffix.test(last) && parts.length > 2 ? parts[parts.length - 2]! : last;
}

/**
 * Bar lengths, in percent, on one shared scale.
 *
 * The longest bar is the largest positive value. A value at or below zero, and
 * any positive value too small to see, gets a sliver so the bar still reads as
 * "measured and small" rather than "missing". A null gets nothing: there was no
 * number to draw.
 */
export const BAR_FLOOR = 3;

export function barWidths(values: readonly (number | null | undefined)[]): (number | null)[] {
  const top = Math.max(0, ...values.map((v) => (v == null ? 0 : v)));
  return values.map((v) => {
    if (v == null) return null;
    if (top <= 0 || v <= 0) return BAR_FLOOR;
    return Math.max(BAR_FLOOR, Math.round((v / top) * 1000) / 10);
  });
}

export interface GapDriver {
  label: string;
  /** The leader's value minus the runner-up's, in points. */
  delta: number;
}

export interface GapExplanation {
  /**
   * How much lower the leader's raw projection is than the runner-up's, when it
   * is lower. Null when it is not, or when either projection is missing. This
   * is the case the reader cannot work out alone: the score points one way and
   * the projection the other.
   */
  projectionShortfall: number | null;
  /** The factors that account for most of the score gap, largest first. */
  drivers: GapDriver[];
}

/**
 * Why the leader leads, in the engine's own terms.
 *
 * The start/sit score is the sum of the known components (an unknown one
 * contributes nothing), so the gap between two scores *is* the sum of the gaps
 * between their components. This reads those gaps and names the biggest, which
 * makes the explanation a decomposition of the number on screen, never a guess
 * at it. A component a player does not have, or has as unknown, counts as zero
 * for him, exactly as it does in his score.
 *
 * Only gaps that point toward the leader are named. The line under the score
 * explains why he is ahead; a factor that favours the other player is visible
 * in the rows below.
 */
export function explainGap(leader: LayoutEvaluation, runnerUp: LayoutEvaluation, limit = 2): GapExplanation {
  const keys: FactorRow[] = [];
  for (const c of [...leader.components, ...runnerUp.components]) {
    if (!keys.some((k) => k.key === c.key)) keys.push({ key: c.key, label: c.label });
  }
  const valueOf = (e: LayoutEvaluation, key: string) => {
    const c = e.components.find((x) => x.key === key);
    return readable(c) ? c.value : 0;
  };
  const drivers = keys
    .map((k) => ({ label: k.label, delta: Math.round((valueOf(leader, k.key) - valueOf(runnerUp, k.key)) * 100) / 100 }))
    .filter((d) => d.delta >= 0.05)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, limit);

  const lp = leader.projection;
  const rp = runnerUp.projection;
  const projectionShortfall = lp != null && rp != null && lp < rp ? Math.round((rp - lp) * 10) / 10 : null;
  return { projectionShortfall, drivers };
}
