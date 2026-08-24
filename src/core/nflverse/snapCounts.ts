/**
 * Pro-Football-Reference snap counts — the role signal this app turned down once.
 *
 *     https://github.com/nflverse/nflverse-data/releases/download/snap_counts/
 *       snap_counts_2025.csv
 *
 * ## Why it was rejected, and why that has changed
 *
 * `core/usage/nflverse.ts` records the decision: snap counts carry
 * `offense_snaps` and `offense_pct`, "which are better role signals than targets
 * in the abstract", and were passed over anyway because "its only identifier is
 * `pfr_player_id`, an id space this app has never seen", and "a second fuzzy
 * matcher for a second id space is precisely what every brief in this project
 * has ruled out".
 *
 * That was right, and the roster file has since spent it. `roster_YYYY.csv`
 * publishes `pfr_id` and `gsis_id` on the same row, so the join is
 * `pfr_player_id → gsis_id → canonical player`: two identifier hops and no
 * name anywhere. Measured against the full 2025 season — 7,318 snap rows at the
 * four positions this app carries — the roster crosswalk resolves **7,293 of
 * them, 99.7%**, with seven players unmatched in total. That is better than the
 * injury feed's 98.9% on a path with no fuzzy step in it at all.
 *
 * ## Why the signal is worth the join
 *
 * Targets and carries measure what a player *did*; snaps measure what his club
 * *chose*, and the two come apart exactly where a projection is hardest. A back
 * on 70% of snaps who saw four carries in a game-script blowout has not lost his
 * job, and a receiver on 30% of snaps with eight targets has not won one.
 * Nothing else in the free data separates those, and both of them are otherwise
 * read as a role change by a series built on volume.
 *
 * It is also the least market-redundant thing here. The market prices what it
 * expects a player to produce; snap share is the closest free proxy for the
 * denominator underneath that, which is why it earns a B-class uncertainty role
 * (see `core/projection/classification.ts`) rather than a bonus on the mean.
 *
 * ## Cost
 *
 * 2.4MiB, 26,612 rows for a full 2025 season, ordered **oldest first** — weeks
 * verified monotonically non-decreasing across every row — so the newest week is
 * at the end and is found by walking backwards, exactly as the weekly-stats
 * parser does. A regular-season week is about 1,410 rows of which 363 are at a
 * carried position, and the position filter is read in the same pass as the week
 * so the full extraction runs only over those.
 *
 * One difference from the weekly-stats file, and it is a trap: `game_type` here
 * spells the postseason `WC` / `DIV` / `CON` / `SB` rather than `POST`. Testing
 * for `!== 'POST'` — which is what the stats file taught — would admit every
 * playoff game into a regular-season baseline.
 */

import { extractFields, headerIndex, int, num, text } from '../source/csv.ts';

export function snapCountsUrl(season: string): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;
}

/** The four positions this app carries, plus the fullback rows that sit with them. */
export const SNAP_POSITIONS: ReadonlySet<string> = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

/**
 * Regular season, spelled the way *this* file spells it.
 *
 * `REG` is the only regular-season value; everything else here is a playoff
 * round. Named rather than inlined because the sibling file uses `POST` for all
 * four of these and the two must not be confused.
 */
export const REGULAR_SEASON = 'REG';

const COLUMNS = [
  'season',
  'game_type',
  'week',
  'player',
  'pfr_player_id',
  'position',
  'team',
  'opponent',
  'offense_snaps',
  'offense_pct',
] as const;

/** One player's snaps in one game. */
export interface SnapRow {
  season: string;
  /** `REG`, or one of `WC` / `DIV` / `CON` / `SB`. Never `POST`. */
  gameType: string;
  week: number;
  playerName: string;
  /** The Pro-Football-Reference key. Bridged to `gsis_id` through the roster. */
  pfrId: string;
  position: string;
  team: string | null;
  opponent: string | null;
  offenseSnaps: number | null;
  /** Share of his club's offensive snaps, 0–1 as the source writes it. */
  offenseShare: number | null;
}

export interface ParsedSnaps {
  rows: SnapRow[];
  season: string;
  /** The latest week in the file. */
  latestWeek: number;
  /** The week actually parsed — the latest unless one was asked for. */
  week: number;
  /** Lines belonging to that week, before the position filter. */
  rowsInWeek: number;
  /** Rows in that week dropped for having no identifier. */
  skipped: number;
}

const EMPTY: ParsedSnaps = { rows: [], season: '', latestWeek: 0, week: 0, rowsInWeek: 0, skipped: 0 };

/**
 * Parse one week of snap counts.
 *
 * By default the latest week in the file, found by walking backwards from the
 * end. Passing `week` asks for an older one, which is what a backfill or a
 * backtest needs; that path walks the file once rather than binary-searching,
 * because this file is a twentieth the size of the weekly-stats one and the
 * seek machinery there exists to dodge a 25ms scan that simply does not arise
 * at 2.4MiB.
 */
export function parseSnapCounts(
  text_: string,
  opts: { week?: number; positions?: ReadonlySet<string> } = {},
): ParsedSnaps {
  const positions = opts.positions ?? SNAP_POSITIONS;
  const lines = text_.split('\n');
  if (lines.length < 2) return EMPTY;
  const at = headerIndex(lines[0] ?? '');
  const weekColumn = at.get('week') ?? -1;
  const positionColumn = at.get('position') ?? -1;
  const idColumn = at.get('pfr_player_id') ?? -1;
  if (weekColumn === -1 || positionColumn === -1 || idColumn === -1) return EMPTY;
  const wanted = COLUMNS.map((c) => at.get(c) ?? -1);

  let last = lines.length - 1;
  while (last > 0 && lines[last]!.length === 0) last--;
  if (last < 1) return EMPTY;

  const latestWeek = int(extractFields(lines[last]!, [weekColumn])[0]);
  if (latestWeek == null) return EMPTY;
  const target = opts.week ?? latestWeek;

  const rows: SnapRow[] = [];
  let rowsInWeek = 0;
  let skipped = 0;
  let season = '';

  /*
   * Backwards from the end for the latest week — it is a contiguous block at
   * the tail and the walk stops the moment the week changes — and forwards for
   * an explicit older one, where there is nothing to be gained by guessing
   * where the block starts.
   */
  const scan = (index: number): boolean => {
    const line = lines[index]!;
    if (line.length === 0) return true;
    const [rawWeek = '', rawPosition = ''] = extractFields(line, [weekColumn, positionColumn]);
    const week = int(rawWeek);
    if (week !== target) return false;
    rowsInWeek++;
    if (!positions.has(rawPosition.trim().toUpperCase())) return true;

    const cells = extractFields(line, wanted);
    const pfrId = text(cells[4]);
    if (!pfrId) {
      skipped++;
      return true;
    }
    if (!season) season = text(cells[0]) ?? '';
    rows.push({
      season: text(cells[0]) ?? '',
      gameType: (text(cells[1]) ?? REGULAR_SEASON).toUpperCase(),
      week: target,
      playerName: text(cells[3]) ?? '',
      pfrId,
      position: rawPosition.trim().toUpperCase(),
      team: text(cells[6]),
      opponent: text(cells[7]),
      offenseSnaps: int(cells[8]),
      offenseShare: num(cells[9]),
    });
    return true;
  };

  if (opts.week == null) {
    for (let i = last; i >= 1; i--) if (!scan(i)) break;
    rows.reverse();
  } else {
    let seen = false;
    for (let i = 1; i <= last; i++) {
      const before = rowsInWeek;
      const inBlock = scan(i);
      if (inBlock && rowsInWeek > before) seen = true;
      // The block is contiguous, so the first row after it ends the walk.
      else if (seen && !inBlock) break;
    }
  }

  return { rows, season, latestWeek, week: target, rowsInWeek, skipped };
}
