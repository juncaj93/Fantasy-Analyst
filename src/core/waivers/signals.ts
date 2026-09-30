/**
 * The signals that colour a waiver call without making it.
 *
 * Every one of these moves the order by a bounded amount or adds a line to a
 * card, and none can put a player on the plan by itself: the yardstick in
 * `yardstick.ts` decides who clears the bar. Three of them:
 *
 *  - **Vegas props, market by market.** A free agent's lines against the lines
 *    of your bench players at his position, on markets both actually have.
 *  - **Sleeper's trending lists.** Adds as a rank, never as a count. Drops as a
 *    warning, and the top ten are kept out of the plan.
 *  - **Your own recent cuts.** Said on the card, never used to hide him.
 */

import type { MarketKey, PlayerProp } from '../vegas/types.ts';
import { ANY_TD_LINE } from './yardstick.ts';

// ------------------------------------------------------------------ props --

/** The most the props comparison can move the order, in points. It never admits anybody. */
export const PROPS_NUDGE = 0.5;
/** "Notably higher" on a yardage market: both of these at once. */
export const PROPS_YARDS_EDGE = 15;
export const PROPS_YARDS_RATIO = 1.25;
/** …or a whole reception more. */
export const PROPS_RECEPTIONS_EDGE = 1;

const YARDAGE: ReadonlySet<MarketKey> = new Set(['pass_yards', 'rush_yards', 'receiving_yards']);
const MARKET_WORDS: Partial<Record<MarketKey, string>> = {
  pass_yards: 'pass yds',
  rush_yards: 'rush yds',
  receiving_yards: 'rec yds',
  receptions: 'rec',
  pass_tds: 'pass TDs',
};

export interface PropsPlayer {
  playerId: string;
  name: string;
  position: string;
  props: readonly PlayerProp[];
}

export interface PropsEdge {
  verdict: 'ahead' | 'behind';
  over: { playerId: string; name: string };
  /** `Vegas has him ahead of Kalif Raymond: 48.5 vs 36.5 rec yds` */
  line: string;
  /** +{@link PROPS_NUDGE} when ahead, 0 when behind: a behind verdict is said, not charged. */
  nudge: number;
}

/**
 * The free agent's props against your bench at his position.
 *
 * The discipline, from the 30 September 2026 research round:
 *
 *  1. **Same position only.** A receiver is compared with your receivers.
 *  2. **Only markets both players have.** A market either side lacks makes no
 *     claim at all.
 *  3. **Touchdowns only at the same line.** Any-TD against any-TD. A 2+ TD line
 *     (1.5) is never set against an any-TD one, whichever side has it, which
 *     keeps the odds-ingestion misread out of this comparison.
 *  4. **"Notably higher"** is +15 yards and +25% on a shared yardage market, or
 *     +1 reception, on at least one market, with no shared market pointing the
 *     other way.
 *
 * `bench` is in the order to try: the plan's own cut first. The first bench
 * player the free agent is notably ahead of wins. Failing that, the first one
 * he trails on every shared line is reported as `behind`, so the card can say
 * so. Null when neither.
 */
export function propsEdge(add: PropsPlayer, bench: readonly PropsPlayer[]): PropsEdge | null {
  let behind: PropsEdge | null = null;
  for (const mine of bench) {
    if (mine.position !== add.position || mine.playerId === add.playerId) continue;
    const shared = sharedMarkets(add.props, mine.props);
    if (shared.length === 0) continue;

    let ahead: { market: MarketKey; theirs: number; ours: number } | null = null;
    let against = 0;
    for (const m of shared) {
      /* `theirs` is the free agent's line, `ours` the bench player's. */
      if (m.ours > m.theirs) against += 1;
      if (m.market === 'anytime_td' || m.market === 'pass_tds') continue;
      const edge = m.theirs - m.ours;
      const notable = YARDAGE.has(m.market)
        ? edge >= PROPS_YARDS_EDGE && m.theirs >= m.ours * PROPS_YARDS_RATIO
        : m.market === 'receptions' && edge >= PROPS_RECEPTIONS_EDGE;
      if (notable && (ahead == null || edge > ahead.theirs - ahead.ours)) ahead = { market: m.market, theirs: m.theirs, ours: m.ours };
    }

    if (ahead && against === 0) {
      return {
        verdict: 'ahead',
        over: { playerId: mine.playerId, name: mine.name },
        line: `Vegas has him ahead of ${mine.name}: ${fmt(ahead.theirs)} vs ${fmt(ahead.ours)} ${MARKET_WORDS[ahead.market] ?? ''}`.trim(),
        nudge: PROPS_NUDGE,
      };
    }
    if (behind == null && against === shared.length) {
      behind = {
        verdict: 'behind',
        over: { playerId: mine.playerId, name: mine.name },
        line: `Vegas has him behind ${mine.name} on every shared line`,
        nudge: 0,
      };
    }
  }
  return behind;
}

/**
 * The markets both players carry, as numbers that can be set side by side.
 *
 * Yardage, receptions and passing TDs by line. The touchdown market by
 * implied probability, and only when both lines are known and equal and at
 * the any-TD line.
 */
function sharedMarkets(
  theirs: readonly PlayerProp[],
  ours: readonly PlayerProp[],
): { market: MarketKey; theirs: number; ours: number }[] {
  const a = latestByMarket(theirs);
  const b = latestByMarket(ours);
  const out: { market: MarketKey; theirs: number; ours: number }[] = [];
  for (const [market, prop] of a) {
    const other = b.get(market);
    if (!other) continue;
    if (market === 'anytime_td') {
      if (prop.line == null || other.line == null || prop.line !== other.line || prop.line > ANY_TD_LINE) continue;
      if (prop.impliedProbability == null || other.impliedProbability == null) continue;
      out.push({ market, theirs: prop.impliedProbability, ours: other.impliedProbability });
      continue;
    }
    if (prop.line == null || other.line == null) continue;
    out.push({ market, theirs: prop.line, ours: other.line });
  }
  return out;
}

function latestByMarket(props: readonly PlayerProp[]): Map<MarketKey, PlayerProp> {
  const out = new Map<MarketKey, PlayerProp>();
  for (const p of props) {
    if (p.line == null && p.impliedProbability == null) continue;
    out.set(p.market, p);
  }
  return out;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// -------------------------------------------------------------- trending --

/** Top of Sleeper's drops list: kept out of the plan, warned about on the card. */
export const MOST_DROPPED_RANK = 10;
/** The most a place lower on the drops list can cost in the order. */
export const DROP_NUDGE = 0.5;

import { mostAddedLine } from './wording.ts';
export { mostAddedLine };

export function mostDroppedLine(rank: number): string {
  return `#${rank} most-dropped on Sleeper today`;
}

/** The card's warning for a free agent near the top of the drops list. */
export function mostDroppedWarning(rank: number): string {
  return `${mostDroppedLine(rank)}. Check the news before claiming.`;
}

/**
 * What a place on the drops list does to a free agent.
 *
 * Top ten: out of the plan, whatever his projection, with the warning on his
 * card. The rest of the list: a small cost in the order, scaled by how high he
 * sits, and the rank said on the card.
 */
export function dropSignal(entry: { rank: number | null; heat: number } | undefined): {
  planExcluded: string | null;
  nudge: number;
  note: string | null;
} {
  if (!entry || entry.rank == null) return { planExcluded: null, nudge: 0, note: null };
  if (entry.rank <= MOST_DROPPED_RANK) {
    return { planExcluded: mostDroppedWarning(entry.rank), nudge: 0, note: mostDroppedWarning(entry.rank) };
  }
  const heat = Math.max(0, Math.min(1, entry.heat));
  return { planExcluded: null, nudge: -round2(DROP_NUDGE * heat), note: mostDroppedLine(entry.rank) };
}

// ----------------------------------------------------------- recent cuts --

/**
 * How far back "you dropped him recently" reaches. Two weeks: long enough to
 * cover the last two waiver runs, short enough that a player you cut in August
 * is a new decision.
 */
export const RECENT_DROP_DAYS = 14;

/** `Dropped by you 3 days ago`, or null outside the window. */
export function recentDropNote(droppedAt: string | undefined, now: Date): string | null {
  if (!droppedAt) return null;
  const at = Date.parse(droppedAt);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((now.getTime() - at) / 86_400_000);
  if (days < 0 || days > RECENT_DROP_DAYS) return null;
  if (days === 0) return 'Dropped by you today';
  if (days === 1) return 'Dropped by you yesterday';
  return `Dropped by you ${days} days ago`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
