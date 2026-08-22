/**
 * Reading one season baseline out of more than one snapshot, honestly.
 *
 * Two things a person will actually do: take a second capture a week later, and
 * take a second capture from a different book because the first one did not
 * price the tight ends. Those need opposite handling, and getting them the same
 * way round is how a board ends up quoting a number nobody published.
 *
 * The rules, in order:
 *
 *   1. **The primary source wins wherever it has an opinion.** Not the newest
 *      snapshot globally — per player and per market. "Latest wins" sounds
 *      right and quietly deletes coverage: a Thursday capture of forty players
 *      would replace a Monday capture of two hundred, and a hundred and sixty
 *      players would lose their line to a snapshot that never mentioned them.
 *   2. **A secondary source fills only the gaps** — a player+market pair the
 *      primary does not carry at all.
 *   3. **Nothing is ever averaged.** Two books disagreeing about a receiving
 *      total is two opinions, and their midpoint is a third number that neither
 *      book would stand behind. One line is chosen and its source is recorded.
 *   4. **Provenance travels with the line, not the snapshot.** Once a baseline
 *      mixes two sources, "where did this come from" only has an answer per
 *      line, and a card that cannot answer it should not show it.
 *
 * Within one source, a later capture does replace an earlier one for the pairs
 * it covers — that is line movement, and the newer number is the better one.
 */

import type { SeasonMarketKey } from '../vegas/types.ts';

/** One stored line, with enough provenance to explain itself. */
export interface SnapshotLine {
  playerId: string;
  market: SeasonMarketKey;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  /** The snapshot this came from. */
  source: string;
  capturedAt: string;
  snapshotId: number;
}

/** A line chosen for the board, and why this one. */
export interface ResolvedLine extends SnapshotLine {
  /** True when the primary source had nothing here and a secondary filled it. */
  filledFromSecondary: boolean;
}

export interface GapFillOptions {
  /**
   * The source whose opinion is preferred wherever it has one.
   *
   * Optional: with no primary named, the most recently captured snapshot leads
   * and the rest fill gaps behind it, which is the sensible default for a
   * single-source season.
   */
  primarySource?: string | null;
}

/** Newest capture first; ties broken by snapshot id so the order is total. */
function byRecency(a: SnapshotLine, b: SnapshotLine): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return b.snapshotId - a.snapshotId;
}

/**
 * One line per player+market, from any number of snapshots.
 *
 * Deterministic: the same inputs in any order produce the same output, because
 * the ordering is computed from the rows' own capture dates rather than from
 * the order they arrived in.
 */
export function resolveSeasonLines(lines: SnapshotLine[], opts: GapFillOptions = {}): ResolvedLine[] {
  const primary = (opts.primarySource ?? '').trim().toLowerCase();

  const byPair = new Map<string, SnapshotLine[]>();
  for (const line of lines) {
    const key = `${line.playerId}|${line.market}`;
    const list = byPair.get(key);
    if (list) list.push(line);
    else byPair.set(key, [line]);
  }

  const out: ResolvedLine[] = [];
  for (const group of byPair.values()) {
    const sorted = [...group].sort(byRecency);

    // The primary's own newest word on this exact pair, if it has one.
    const fromPrimary = primary
      ? sorted.find((l) => l.source.trim().toLowerCase() === primary)
      : undefined;

    const chosen = fromPrimary ?? sorted[0];
    if (!chosen) continue;
    out.push({ ...chosen, filledFromSecondary: primary !== '' && !fromPrimary });
  }

  // Stable, readable order: by player, then by market.
  out.sort((a, b) => (a.playerId === b.playerId ? a.market.localeCompare(b.market) : a.playerId.localeCompare(b.playerId)));
  return out;
}

/** What a baseline was actually built from, for the card and for diagnostics. */
export interface LineageSummary {
  /** Distinct sources that contributed at least one line. */
  sources: { source: string; capturedAt: string; lines: number }[];
  filledFromSecondary: number;
  players: number;
  markets: number;
}

export function summariseLineage(lines: ResolvedLine[]): LineageSummary {
  const bySource = new Map<string, { source: string; capturedAt: string; lines: number }>();
  for (const l of lines) {
    const key = `${l.source}|${l.capturedAt}`;
    const entry = bySource.get(key);
    if (entry) entry.lines++;
    else bySource.set(key, { source: l.source, capturedAt: l.capturedAt, lines: 1 });
  }
  return {
    sources: [...bySource.values()].sort((a, b) => b.lines - a.lines),
    filledFromSecondary: lines.filter((l) => l.filledFromSecondary).length,
    players: new Set(lines.map((l) => l.playerId)).size,
    markets: new Set(lines.map((l) => l.market)).size,
  };
}
