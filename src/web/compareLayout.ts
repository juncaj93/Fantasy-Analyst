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

/* ======================================== the flat sheet (30 September 2026) */
/*
 * What the rebuilt Compare sheet draws, worked out away from React so each
 * rule has a test. The sheet was redrawn to the owner's approved mockup
 * (`reference-mockup-v2.html`): identity, a plain recommendation card, the
 * sportsbook's own prop lines, then this app's signals, then one note. Every
 * value below is read off the comparison the server sent; nothing here scores
 * anybody.
 */

/** A betting market as the sheet names it, in the order a reader expects them. */
const PROP_ORDER: { market: string; label: string }[] = [
  { market: 'pass_yards', label: 'Pass yards' },
  { market: 'pass_tds', label: 'Pass TDs' },
  { market: 'rush_yards', label: 'Rush yards' },
  { market: 'receiving_yards', label: 'Rec yards' },
  { market: 'receptions', label: 'Receptions' },
  { market: 'anytime_td', label: 'Anytime TD' },
];

/** Which markets a position is priced on. Mirrors `EXPECTED_MARKETS` in core. */
const PROP_MARKETS: Record<string, readonly string[]> = {
  QB: ['pass_yards', 'pass_tds', 'rush_yards'],
  RB: ['rush_yards', 'receiving_yards', 'receptions', 'anytime_td'],
  WR: ['receiving_yards', 'receptions', 'anytime_td'],
  TE: ['receiving_yards', 'receptions', 'anytime_td'],
};

export interface PropEvaluation {
  playerId: string;
  position: string;
  expectation: {
    contributions: readonly { market: string; line: number | null; probability?: number }[];
    missingMarkets: readonly string[];
  };
}

/**
 * One prop cell: a posted line, a market this position is not priced on, or a
 * market it is priced on that no book has posted. The last two are different
 * facts and are never drawn the same way; neither is ever a number.
 */
export type PropCell = { kind: 'line'; text: string } | { kind: 'na' } | { kind: 'missing' };

export interface PropRow {
  market: string;
  label: string;
  cells: PropCell[];
}

export function propRows(columns: readonly PropEvaluation[]): PropRow[] {
  const wanted = new Set(columns.flatMap((e) => PROP_MARKETS[e.position.toUpperCase()] ?? []));
  return PROP_ORDER.filter((p) => wanted.has(p.market)).map(({ market, label }) => ({
    market,
    label,
    cells: columns.map((e): PropCell => {
      if (!(PROP_MARKETS[e.position.toUpperCase()] ?? []).includes(market)) return { kind: 'na' };
      const posted = e.expectation.contributions.find((c) => c.market === market);
      if (!posted) return { kind: 'missing' };
      if (market === 'anytime_td') {
        return posted.probability != null
          ? { kind: 'line', text: `${Math.round(posted.probability * 100)}%` }
          : { kind: 'missing' };
      }
      return posted.line != null ? { kind: 'line', text: posted.line.toFixed(1) } : { kind: 'missing' };
    }),
  }));
}

/** `Questionable · practised fully` → `Questionable`, and the rest. */
export function splitStatus(statusFlag: string | null | undefined): { word: string; detail: string | null } | null {
  if (!statusFlag) return null;
  const [word = '', ...rest] = statusFlag.split('·').map((s) => s.trim());
  return { word, detail: rest.length > 0 ? rest.join(' · ') : null };
}

export type MatchupTone = 'good' | 'bad' | 'neutral' | 'unknown';

/** `Favorable · SF`, `Tough · TEN`: the same rating the Team row's chip prints. */
export function matchupCell(
  fixture: { opponent: string; rating: string } | null | undefined,
): { text: string; tone: MatchupTone } | null {
  if (!fixture) return null;
  if (fixture.rating === 'soft') return { text: `Favorable · ${fixture.opponent}`, tone: 'good' };
  if (fixture.rating === 'tough') return { text: `Tough · ${fixture.opponent}`, tone: 'bad' };
  if (fixture.rating === 'neutral') return { text: `Neutral · ${fixture.opponent}`, tone: 'neutral' };
  return { text: fixture.opponent, tone: 'unknown' };
}

/** A signed number the way the sheet prints one: `+1.7`, `−0.4`, `0.0`. */
export function signed(value: number): string {
  const v = Math.round(value * 10) / 10;
  if (v === 0) return '0.0';
  return v > 0 ? `+${v.toFixed(1)}` : `−${Math.abs(v).toFixed(1)}`;
}

/** A plain number with a real minus sign. */
export function plain(value: number): string {
  const v = Math.round(value * 10) / 10;
  return v < 0 ? `−${Math.abs(v).toFixed(1)}` : v.toFixed(1);
}

export interface DecisionLike {
  points: number;
  basis: 'market' | 'published' | 'partial' | 'unpriced';
  base: number;
  adjustments: number;
}

/**
 * The one sentence under the bars: why the leader leads, in plain words.
 *
 * When either side is ranked on a published week, the honest decomposition is
 * the two starting weeks and the two sets of adjustments, which is exactly how
 * `decisionPoints` built the numbers. Otherwise the engine's own largest
 * component gaps, as the sheet has said since 25 September.
 */
export function gapSentence(input: {
  leader: { name: string; decision?: DecisionLike | null };
  runnerUp: { name: string; decision?: DecisionLike | null };
  margin: number;
  drivers: readonly { label: string; delta: number }[];
  projectionShortfall: number | null;
}): string {
  const lead = shortName(input.leader.name);
  if (input.margin === 0) return `${lead} and ${shortName(input.runnerUp.name)} are level; the notes below break the tie.`;
  const head = `${lead} leads by ${plain(input.margin)}`;
  const a = input.leader.decision;
  const b = input.runnerUp.decision;
  if (a && b && (a.basis === 'published' || b.basis === 'published')) {
    return (
      `${head}: a ${plain(a.base)} week against ${plain(b.base)} before adjustments, ` +
      `${signed(a.adjustments)} against ${signed(b.adjustments)} for status, usage and matchup.`
    );
  }
  const despite = input.projectionShortfall != null ? ' despite a lower raw projection' : '';
  if (input.drivers.length === 0) return `${head}${despite}.`;
  const why = input.drivers.map((d) => `${d.label.toLowerCase()} ${signed(d.delta)}`).join(', ');
  return `${head}${despite}. Most of the gap: ${why}.`;
}

/**
 * The one quiet note at the bottom, chosen, not listed.
 *
 * In order of what changes Sunday: a game already started, a kickoff-timing
 * problem, both players carrying an injury designation, the engine's own
 * market-coverage note, one player's designation. Null when none applies; the
 * sheet then draws nothing rather than a filler line.
 */
export function standoutNote(input: {
  players: readonly { name: string; statusWord: string | null; locked: boolean }[];
  lateSwap: { verdict: string; detail: string } | null;
  coverageNote: string | null;
}): string | null {
  const locked = input.players.filter((p) => p.locked);
  if (locked.length > 0) {
    return `${locked.map((p) => p.name).join(' and ')} ${locked.length === 1 ? 'has' : 'have'} already kicked off, so that spot is fixed.`;
  }
  if (input.lateSwap?.verdict === 'consider_early_option') return input.lateSwap.detail;
  const flagged = input.players.filter((p) => p.statusWord);
  if (flagged.length >= 2 && flagged.length === input.players.length) {
    const words = new Set(flagged.map((p) => p.statusWord!.toLowerCase()));
    const shared = words.size === 1 ? [...words][0] : 'on the injury report';
    const phrase = input.players.length === 2 ? 'Both players are' : 'Every player here is';
    return `${phrase} ${words.size === 1 ? shared!.replace(/^./, (c) => c.toUpperCase()) : shared} this week. Check the injury report before your lineup locks.`;
  }
  if (input.coverageNote) return input.coverageNote;
  if (flagged.length === 1) {
    const p = flagged[0]!;
    return `${p.name} is ${p.statusWord!.toLowerCase()} this week. Check the injury report before your lineup locks.`;
  }
  return null;
}
