/**
 * Timestamped depth charts, read as a bounded role signal and nothing more.
 *
 *     https://github.com/nflverse/nflverse-data/releases/download/depth_charts/
 *       depth_charts_2026.csv
 *
 * ## Two schemas, and the seam is 2025
 *
 * nflverse changed this dataset's shape and its semantics with the 2025 season,
 * which the handoff flags and which this module versions explicitly rather than
 * papering over.
 *
 * **Weekly (≤2024)** — `season, club_code, week, game_type, depth_team,
 * last_name, first_name, football_name, formation, gsis_id, jersey_number,
 * position, elias_id, depth_position, full_name`. One block per *week*; there is
 * no timestamp at all, so the file's `Last-Modified` is the only freshness it
 * has. `depth_team` is the rank within (club, week, formation, position).
 *
 * **Timestamped (2025+)** — `dt, team, player_name, espn_id, gsis_id,
 * pos_grp_id, pos_grp, pos_id, pos_name, pos_abb, pos_slot, pos_rank`. One block
 * per *capture*, stamped to the second, roughly daily. There is no week column:
 * a snapshot is a moment, not a fixture. `pos_grp` is a personnel grouping
 * (`3WR 1TE`, `Base 4-3 D`, `Special Teams`), `pos_slot` is which spot in that
 * grouping, and `pos_rank` is the depth ordering **across the whole position on
 * that club** — verified against Arizona's live 2026 chart, where the three
 * wide-receiver slots 1, 2 and 8 carry ranks 1..11 continuously rather than
 * restarting per slot.
 *
 * Reading `pos_rank` as if it were the old `depth_team` would be wrong in the
 * one direction that matters: it would report the third receiver as a third-
 * stringer. Reading `depth_team` as if it were `pos_rank` would be wrong the
 * other way. So the schema is detected from the header, carried on every entry,
 * and compared only against itself.
 *
 * ## Why it is read from the front of the file
 *
 * The live 2026 file is **42MiB** and the 2025 one is 50MiB, which no Workers
 * invocation can download, let alone parse. It is written **newest first** —
 * strictly descending by `dt`, verified by probing the head, the midpoint and
 * the 90% mark of the live file — and one capture is about 3,300 rows and
 * 303KiB. So the newest chart is the first 303KiB of a 42MiB file, and a ranged
 * `GET` for the first few hundred kilobytes is the whole ingest.
 *
 * The release asset answers explicit `bytes=0-N` ranges with `206 Partial
 * Content` and a `Content-Range` (it rejects suffix ranges — `bytes=-N` — with
 * `501`, which is why nothing here asks for one). That is a 100× reduction and
 * it is what makes this source affordable at all.
 *
 * **The guard that makes it safe.** A prefix read cannot tell a complete
 * snapshot from a truncated one by looking at the rows, and a truncated one is
 * poison: half a depth chart reads as half a club's receivers having been cut.
 * So {@link parseDepthChart} only reports a snapshot complete when it has seen
 * the *next, older* `dt` begin — proof the block ended inside the bytes read —
 * and it refuses outright if it ever finds a newer `dt` below an older one,
 * which is the ordering assumption failing. Incomplete is returned as
 * incomplete; the caller stores nothing and lowers confidence.
 */

import { extractFields, headerIndex, int, text } from '../source/csv.ts';

export function depthChartUrl(season: string): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${season}.csv`;
}

/**
 * How many bytes of the file to ask for.
 *
 * One live capture measured 303KiB across 3,281 rows. 768KiB is a little over
 * two of them, which is what {@link parseDepthChart} needs to *prove* the first
 * one is complete — it must see the second block start — with room for a club
 * expanding its chart. Larger costs bandwidth on every check for no more
 * information; smaller risks a legitimate snapshot being reported incomplete.
 */
export const DEPTH_PREFIX_BYTES = 768 * 1024;

/** Which shape the file is in. Carried on every entry so nothing compares across it. */
export type DepthSchema = 'timestamped' | 'weekly';

/** One player's place on one depth chart. */
export interface DepthEntry {
  /** The club, as nflverse spells it. */
  team: string;
  gsisId: string | null;
  playerName: string;
  /** `pos_abb` on the current schema, `depth_position` on the legacy one. */
  position: string;
  /**
   * `pos_grp` (a personnel grouping like `3WR 1TE`) or, on the legacy schema,
   * `formation` (`Offense` / `Defense` / `Special Teams`). Comparisons are only
   * ever made within one of these, which is what the handoff's "compare within
   * same team/pos group/slot" asks for.
   */
  group: string | null;
  /** Which spot in the grouping. Current schema only; null on the legacy one. */
  slot: number | null;
  /**
   * Depth ordering. On the current schema this runs across the whole position
   * on that club; on the legacy one it restarts per position. Never compared
   * across schemas.
   */
  rank: number;
  /** Legacy schema only — the week the chart belonged to. */
  week: number | null;
}

export interface DepthSnapshot {
  schema: DepthSchema;
  /**
   * When the chart was captured. The `dt` on the current schema; null on the
   * legacy one, where the file's `Last-Modified` is the only freshness there is
   * and the caller supplies it.
   */
  capturedAt: string | null;
  entries: DepthEntry[];
  /**
   * True only when the block was proven to end inside the bytes read.
   *
   * A prefix read that stops mid-snapshot returns `false`, and a caller must
   * treat that as "no chart" rather than as a chart with people missing.
   */
  complete: boolean;
  /** Data lines examined. */
  rowsRead: number;
  /** Why it is not complete, or why nothing was parsed. Never an exception. */
  note: string | null;
}

const EMPTY: DepthSnapshot = {
  schema: 'timestamped',
  capturedAt: null,
  entries: [],
  complete: false,
  rowsRead: 0,
  note: 'no depth-chart rows',
};

/**
 * Parse the newest depth chart out of the front of the file.
 *
 * `text_` may be the whole file or a prefix of it. Only the newest block is
 * returned; everything below it is read for exactly one field — the timestamp
 * that proves the block ended — and then abandoned.
 */
export function parseDepthChart(
  text_: string,
  opts: { positions?: ReadonlySet<string> | null } = {},
): DepthSnapshot {
  const lines = text_.split('\n');
  if (lines.length < 2) return EMPTY;
  const at = headerIndex(lines[0] ?? '');
  return at.has('dt') ? parseTimestamped(lines, at, opts) : parseWeekly(lines, at, opts);
}

/** The 2025+ shape: newest first, one block per capture. */
function parseTimestamped(
  lines: string[],
  at: Map<string, number>,
  opts: { positions?: ReadonlySet<string> | null },
): DepthSnapshot {
  const dtColumn = at.get('dt') ?? -1;
  const posColumn = at.get('pos_abb') ?? -1;
  if (dtColumn === -1 || posColumn === -1) {
    return { ...EMPTY, note: 'depth chart is missing dt or pos_abb' };
  }
  const wanted = [
    at.get('team') ?? -1,
    at.get('player_name') ?? -1,
    at.get('gsis_id') ?? -1,
    at.get('pos_grp') ?? -1,
    posColumn,
    at.get('pos_slot') ?? -1,
    at.get('pos_rank') ?? -1,
  ];
  const positions = opts.positions;

  let capturedAt: string | null = null;
  let complete = false;
  let rowsRead = 0;
  const entries: DepthEntry[] = [];

  /*
   * The final line of a ranged read is very likely cut mid-field, so it is
   * never parsed. A half-written `pos_rank` would read as a plausible number
   * and put somebody at the wrong depth.
   *
   * Dropping it unconditionally costs nothing, and the reason is worth stating:
   * a snapshot is only *usable* once the loop below has seen the next, older
   * timestamp begin, which means the newest block ended strictly before the end
   * of the read. So a discarded last line can never have belonged to the block
   * that gets returned.
   */
  const lastLine = lines.length - 1;

  for (let i = 1; i < lastLine; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    rowsRead++;

    const stamp = text(extractFields(line, [dtColumn])[0]);
    if (stamp == null) continue;
    if (capturedAt == null) capturedAt = stamp;
    if (stamp !== capturedAt) {
      /*
       * The ordering assumption, checked rather than trusted.
       *
       * The file is written newest first. A row below the first block with a
       * *newer* timestamp means it no longer is, and every conclusion this
       * module draws from "the first block is the current chart" is void. That
       * is a refusal, not a smaller snapshot.
       */
      if (stamp > capturedAt) {
        return {
          schema: 'timestamped',
          capturedAt: null,
          entries: [],
          complete: false,
          rowsRead,
          note: `depth chart is not newest-first: ${stamp} appears below ${capturedAt}`,
        };
      }
      complete = true;
      break;
    }

    const position = (extractFields(line, [posColumn])[0] ?? '').trim().toUpperCase();
    if (positions && !positions.has(position)) continue;

    const cells = extractFields(line, wanted);
    const rank = int(cells[6]);
    const team = text(cells[0]);
    if (rank == null || team == null) continue;
    entries.push({
      team,
      playerName: text(cells[1]) ?? '',
      gsisId: text(cells[2]),
      group: text(cells[3]),
      position,
      slot: int(cells[5]),
      rank,
      week: null,
    });
  }

  if (capturedAt == null) return { ...EMPTY, rowsRead, note: 'no dated depth-chart rows' };
  return {
    schema: 'timestamped',
    capturedAt,
    entries,
    complete,
    rowsRead,
    note: complete
      ? null
      : 'the newest chart did not end inside the bytes read, so it may be partial and is not usable',
  };
}

/**
 * The ≤2024 shape: one block per week, no timestamp.
 *
 * Kept because it is what any backtest before 2025 reads, and because a season
 * whose file has not switched over must not be parsed by the current reader and
 * silently produce ranks that mean something else. The newest week is taken,
 * which for a finished season is the last one played.
 */
function parseWeekly(
  lines: string[],
  at: Map<string, number>,
  opts: { positions?: ReadonlySet<string> | null },
): DepthSnapshot {
  const weekColumn = at.get('week') ?? -1;
  const rankColumn = at.get('depth_team') ?? -1;
  if (weekColumn === -1 || rankColumn === -1) {
    return { ...EMPTY, schema: 'weekly', note: 'depth chart is missing week or depth_team' };
  }
  const posColumn = at.get('depth_position') ?? at.get('position') ?? -1;
  const wanted = [
    at.get('club_code') ?? at.get('team') ?? -1,
    at.get('full_name') ?? -1,
    at.get('gsis_id') ?? -1,
    at.get('formation') ?? -1,
    posColumn,
    rankColumn,
    weekColumn,
    at.get('game_type') ?? -1,
  ];
  const positions = opts.positions;

  /*
   * A whole-file pass, deliberately, and it is affordable for a different
   * reason than the current schema's prefix read: the legacy files are ~2MiB
   * because they carry no timestamps and no duplicate daily captures. This path
   * is only ever reached by a backtest over a finished season, never by the
   * Worker's cron, so it is bounded by the season rather than by CPU.
   */
  let latest = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.length === 0) continue;
    const week = int(extractFields(lines[i]!, [weekColumn])[0]);
    const type = at.has('game_type')
      ? text(extractFields(lines[i]!, [at.get('game_type')!])[0])
      : 'REG';
    // Regular season only, for the same reason `core/usage/role.ts` uses it:
    // a January chart is not the population any lineup question is asked about.
    if (week != null && (type ?? 'REG').toUpperCase() === 'REG' && week > latest) latest = week;
  }
  if (!Number.isFinite(latest)) return { ...EMPTY, schema: 'weekly', note: 'no weekly depth-chart rows' };

  const entries: DepthEntry[] = [];
  let rowsRead = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    rowsRead++;
    const cells = extractFields(line, wanted);
    if (int(cells[6]) !== latest) continue;
    if ((text(cells[7]) ?? 'REG').toUpperCase() !== 'REG') continue;
    const position = (cells[4] ?? '').trim().toUpperCase();
    if (positions && !positions.has(position)) continue;
    const rank = int(cells[5]);
    const team = text(cells[0]);
    if (rank == null || team == null) continue;
    entries.push({
      team,
      playerName: text(cells[1]) ?? '',
      gsisId: text(cells[2]),
      group: text(cells[3]),
      position,
      slot: null,
      rank,
      week: latest,
    });
  }

  return {
    schema: 'weekly',
    capturedAt: null,
    entries,
    // A whole-file read has no truncation to worry about; the block is complete
    // by construction.
    complete: true,
    rowsRead,
    note: null,
  };
}

/**
 * A player's role on a chart, in the only terms that survive the schema change.
 *
 * `rank` alone is not comparable across the two schemas and is not comparable
 * across positions within one of them either — a `pos_rank` of 3 is a starting
 * receiver and a third-string back. So what is derived here is the pair a
 * projection can actually use: how deep he is, and how many of his position
 * that club actually fields.
 */
export interface DepthRole {
  team: string;
  position: string;
  group: string | null;
  rank: number;
  slot: number | null;
  /** Spots this club fields at his position in this grouping. */
  starterSlots: number;
  /** `rank <= starterSlots`. Not a fantasy ranking; see the caveat below. */
  isStarter: boolean;
}

/**
 * Index a snapshot by `gsis_id`.
 *
 * **`isStarter` is not a fantasy claim.** A club's third receiver and its
 * second tight end are both "starters" here and neither fact says a word about
 * whether to start him in a lineup; the handoff is explicit that RB1/WR1 is not
 * a universal fantasy ranking and this module makes no attempt to turn it into
 * one. What it is good for is *change*: a player who was outside the fielded
 * spots and is now inside them has had something happen to him, and that is a
 * question worth asking of a better source.
 *
 * `starterSlots` is counted from the chart itself — the distinct `pos_slot`
 * values a club lists for that position in that grouping — rather than from a
 * table of assumed formations, because the grouping is already named in the
 * data (`3WR 1TE`) and a club that lists two tight-end spots should not be read
 * against somebody's idea of what an offence looks like. On the legacy schema
 * there are no slots, so it falls back to counting the players the club lists
 * at rank 1, which is what `depth_team = 1` meant there.
 */
export function depthRoles(snapshot: DepthSnapshot): Map<string, DepthRole> {
  const slotsByGroup = new Map<string, Set<number>>();
  const firstsByGroup = new Map<string, number>();
  for (const e of snapshot.entries) {
    const key = groupKey(e);
    if (e.slot != null) {
      let set = slotsByGroup.get(key);
      if (!set) slotsByGroup.set(key, (set = new Set()));
      set.add(e.slot);
    }
    if (e.rank === 1) firstsByGroup.set(key, (firstsByGroup.get(key) ?? 0) + 1);
  }

  const out = new Map<string, DepthRole>();
  for (const e of snapshot.entries) {
    if (!e.gsisId) continue;
    const key = groupKey(e);
    const starterSlots = slotsByGroup.get(key)?.size ?? firstsByGroup.get(key) ?? 1;
    const role: DepthRole = {
      team: e.team,
      position: e.position,
      group: e.group,
      rank: e.rank,
      slot: e.slot,
      starterSlots,
      isStarter: e.rank <= starterSlots,
    };
    /*
     * Best (lowest) rank wins where a player is listed twice.
     *
     * The current schema lists a player once per grouping, so a back who is
     * also the third receiver in an empty set appears in both. Taking the
     * deeper of the two would report his role as the more marginal one, which
     * is exactly backwards.
     */
    const existing = out.get(e.gsisId);
    if (!existing || role.rank < existing.rank) out.set(e.gsisId, role);
  }
  return out;
}

function groupKey(e: DepthEntry): string {
  return `${e.team}|${e.group ?? ''}|${e.position}`;
}
