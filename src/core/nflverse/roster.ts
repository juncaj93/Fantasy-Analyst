/**
 * The seasonal roster file, which is really the identity bridge.
 *
 *     https://github.com/nflverse/nflverse-data/releases/download/rosters/
 *       roster_2026.csv
 *
 * A public GitHub release asset like the injury report and the weekly stats: no
 * key, no account, no quota. Measured against the live 2026 file on 2026-08-23 —
 * 905KiB, 2,929 data rows, 36 columns, 915 of them at the four positions this
 * app carries.
 *
 * ## Why this file first, ahead of anything it can say about football
 *
 * It carries `gsis_id`, `sleeper_id`, `pfr_id`, `espn_id`, `yahoo_id` and
 * `rotowire_id` **on the same row**. That makes it the deterministic crosswalk
 * the projection work needs, and it settles two things that were open:
 *
 *  1. **Sleeper's own `gsis_id` is not the whole story.** The player dictionary
 *     publishes one for most established players and blank for plenty of others
 *     — rookies especially, which is exactly the population whose role is
 *     changing. Where Sleeper is blank, `sleeper_id → gsis_id` through this file
 *     fills the gap on an *identifier* join, never a name.
 *  2. **`pfr_id` unlocks the snap counts.** `core/usage/nflverse.ts` records why
 *     `snap_counts_2025.csv` was rejected: "its only identifier is
 *     `pfr_player_id`, an id space this app has never seen", and a second fuzzy
 *     matcher for a second id space is what every brief here has ruled out.
 *     That objection was correct and it is now spent — this file maps
 *     `pfr_id → gsis_id` deterministically for 2,196 players, which joins
 *     **99.7%** of the 2025 season's 7,318 snap rows at the carried positions
 *     (QB, RB, WR, TE and the fullbacks that sit with them), all game types. Offensive
 *     snap share is the best single role signal in the free data, and it is
 *     reachable now without one fuzzy match.
 *
 * ## What it does not do
 *
 * It is a *bridge*, not a source of truth about who is on a roster. Sleeper
 * owns that, as it owns league, roster, draft and scoring facts everywhere else
 * in this app. `status` here is read only as a weak, slow-moving role signal
 * (see `core/projection/roleEvidence.ts`), never as availability: nflverse
 * current injuries are explicitly not a live dependency and the roster's `ACT`
 * is a weekly artefact, not this morning's news.
 *
 * ## Cost
 *
 * One row per player per season — not per week — so it is a small file that a
 * conditional GET leaves alone on most days. The whole-file parse of the 2026
 * roster measured 6.1ms in Node against a 10ms Workers allowance, which is too
 * close to spend daily on a file that changes weekly, so the ingest is gated on
 * the conditional 304 and the position filter runs in the same pass as the id
 * columns.
 */

import { extractFields, headerIndex, int, text } from '../source/csv.ts';

/** Where the file lives. Stable across seasons; only the year changes. */
export function rosterUrl(season: string): string {
  return `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;
}

/** The four positions this app carries. Kickers and defences stay out. */
export const SKILL_POSITIONS: ReadonlySet<string> = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * The columns read, by name, in the order the header happens to hold them.
 *
 * `position` is deliberately early (index 2 in the live file) so the filter that
 * discards two thirds of the rows runs before the identifier columns are
 * materialised — the same trick that took the weekly-stats parse from 10.0ms to
 * 4.0ms.
 */
const COLUMNS = [
  'season',
  'team',
  'position',
  'depth_chart_position',
  'status',
  'full_name',
  'gsis_id',
  'espn_id',
  'pfr_id',
  'sleeper_id',
  'yahoo_id',
  'years_exp',
  'week',
  'game_type',
] as const;

/** One player's row in the seasonal roster. */
export interface RosterRow {
  season: string;
  /** The club, as nflverse spells it. */
  team: string | null;
  position: string;
  /** nflverse's own depth-chart position label, e.g. `RB`, `WR`, `FB`. */
  depthChartPosition: string | null;
  /**
   * `ACT`, `RES`, `CUT`, `RET`, `DEV`, `E14`, ... A roster state, not a health
   * state. Read as a slow role signal only; see the note at the top of the file.
   */
  status: string | null;
  fullName: string;
  /** The canonical nflverse key. Present on every row of the live file. */
  gsisId: string | null;
  espnId: string | null;
  /** The Pro-Football-Reference key, which is what the snap counts are keyed by. */
  pfrId: string | null;
  /** Sleeper's own player id — the join back to this app's `players.id`. */
  sleeperId: string | null;
  yahooId: string | null;
  yearsExp: number | null;
  /** The week the row describes. The file publishes one row per player per season. */
  week: number | null;
  gameType: string | null;
}

export interface ParsedRoster {
  rows: RosterRow[];
  season: string;
  /** Data lines seen, before the position filter. */
  rowsInFile: number;
  /** Rows at a carried position that had no `gsis_id` and were dropped. */
  skipped: number;
}

const EMPTY: ParsedRoster = { rows: [], season: '', rowsInFile: 0, skipped: 0 };

/**
 * Parse the seasonal roster.
 *
 * Bounded to the positions this app carries, and to rows that actually carry the
 * canonical key. A row with no `gsis_id` cannot join to anything here and is
 * counted rather than guessed at — `skipped` is the number a health panel
 * reports, because a file that silently stops publishing identifiers looks
 * exactly like a quiet week until somebody counts.
 */
export function parseRoster(
  text_: string,
  opts: { positions?: ReadonlySet<string> } = {},
): ParsedRoster {
  const positions = opts.positions ?? SKILL_POSITIONS;
  const lines = text_.split('\n');
  if (lines.length < 2) return EMPTY;
  const at = headerIndex(lines[0] ?? '');
  const wanted = COLUMNS.map((c) => at.get(c) ?? -1);
  const positionColumn = at.get('position') ?? -1;
  const gsisColumn = at.get('gsis_id') ?? -1;
  if (positionColumn === -1 || gsisColumn === -1) return EMPTY;

  const rows: RosterRow[] = [];
  let rowsInFile = 0;
  let skipped = 0;
  let season = '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    rowsInFile++;

    // The filter first, on its own, so the expensive extraction never runs for
    // the linemen and defensive backs that are two thirds of the file.
    const position = (extractFields(line, [positionColumn])[0] ?? '').trim().toUpperCase();
    if (!positions.has(position)) continue;

    const cells = extractFields(line, wanted);
    const gsisId = text(cells[6]);
    if (!gsisId) {
      skipped++;
      continue;
    }
    const rowSeason = text(cells[0]) ?? '';
    if (!season) season = rowSeason;
    rows.push({
      season: rowSeason,
      team: text(cells[1]),
      position,
      depthChartPosition: text(cells[3]),
      status: text(cells[4]),
      fullName: text(cells[5]) ?? '',
      gsisId,
      espnId: text(cells[7]),
      pfrId: text(cells[8]),
      sleeperId: text(cells[9]),
      yahooId: text(cells[10]),
      yearsExp: int(cells[11]),
      week: int(cells[12]),
      gameType: text(cells[13]),
    });
  }

  return { rows, season, rowsInFile, skipped };
}

/**
 * One row of the stored crosswalk: an identifier tuple with its provenance.
 *
 * Provenance travels with it because a mapping is only as trustworthy as the
 * file it came from and the day it was published, and a bridge whose age nobody
 * can see is a bridge nobody can retire.
 */
export interface IdentityLink {
  gsisId: string;
  sleeperId: string | null;
  pfrId: string | null;
  espnId: string | null;
  yahooId: string | null;
  team: string | null;
  position: string;
  season: string;
  source: string;
  /** When the file this came from was published, not when we read it. */
  asOf: string | null;
}

/** Turn parsed rows into the crosswalk rows the store holds. */
export function toIdentityLinks(parsed: ParsedRoster, source: string, asOf: string | null): IdentityLink[] {
  const out = new Map<string, IdentityLink>();
  for (const row of parsed.rows) {
    /*
     * Last row wins on a duplicated `gsis_id`.
     *
     * A player traded mid-season appears once per club. The rows are in file
     * order and the file is written in roster order, so this is not a
     * defensible "latest" — which is precisely why `team` off this crosswalk is
     * never read as where a player plays. Sleeper owns that. What is being
     * de-duplicated here is the *identifier tuple*, which does not vary between
     * his two rows.
     */
    out.set(row.gsisId!, {
      gsisId: row.gsisId!,
      sleeperId: row.sleeperId,
      pfrId: row.pfrId,
      espnId: row.espnId,
      yahooId: row.yahooId,
      team: row.team,
      position: row.position,
      season: row.season,
      source,
      asOf,
    });
  }
  return [...out.values()];
}

/**
 * How a player's `gsis_id` was arrived at.
 *
 * Kept as a state rather than a boolean because the three are not equally
 * trustworthy and the difference has to survive into the projection's
 * confidence: Sleeper publishing the id itself is the strongest evidence there
 * is, the roster bridge is one deterministic hop from it, and unresolved is a
 * real answer that must never be filled in by a name.
 */
export type IdentityResolution =
  /** Sleeper's own dictionary carried the `gsis_id`. */
  | 'sleeper_direct'
  /** Sleeper had none; the roster's `sleeper_id → gsis_id` supplied it. */
  | 'roster_bridge'
  /** Neither did. Explicitly unresolved — never guessed from a name. */
  | 'unresolved';

export interface ResolvedIdentity {
  /** This app's player id, which is the Sleeper player id. */
  playerId: string;
  gsisId: string | null;
  pfrId: string | null;
  resolution: IdentityResolution;
}

/**
 * Resolve a set of this app's players onto nflverse identifiers.
 *
 * The ladder is the one the handoff specifies and it never widens:
 *
 *   1. the player's own stored `gsis` external id, which came from Sleeper;
 *   2. the roster crosswalk, keyed on `sleeper_id`;
 *   3. unresolved.
 *
 * There is deliberately no name step. `core/identity` has a careful matching
 * ladder for the places a name is all there is, and every one of those callers
 * sends ambiguity to review rather than committing it. A projection is not a
 * review queue: a player projected through the wrong body is not a smaller
 * error than a player with no projection, it is a much larger one, and it is
 * invisible. So the answer here is a projection or nothing.
 *
 * `pfrId` rides along because the snap-count join needs it and it exists only
 * on this path — Sleeper does not publish one.
 */
export function resolveIdentities(
  players: { id: string; externalIds?: Record<string, string> | null }[],
  crosswalk: Iterable<IdentityLink>,
): Map<string, ResolvedIdentity> {
  const bySleeper = new Map<string, IdentityLink>();
  const byGsis = new Map<string, IdentityLink>();
  for (const link of crosswalk) {
    if (link.sleeperId) bySleeper.set(link.sleeperId, link);
    byGsis.set(link.gsisId, link);
  }

  const out = new Map<string, ResolvedIdentity>();
  for (const player of players) {
    const direct = (player.externalIds?.['gsis'] ?? '').trim();
    if (direct) {
      out.set(player.id, {
        playerId: player.id,
        gsisId: direct,
        // The crosswalk still supplies `pfr_id`, which Sleeper never has. A
        // direct GSIS id that the roster has never heard of is fine and common
        // in March; it costs the snap join for that player and nothing else.
        pfrId: byGsis.get(direct)?.pfrId ?? null,
        resolution: 'sleeper_direct',
      });
      continue;
    }
    const bridged = bySleeper.get(player.id);
    if (bridged) {
      out.set(player.id, {
        playerId: player.id,
        gsisId: bridged.gsisId,
        pfrId: bridged.pfrId,
        resolution: 'roster_bridge',
      });
      continue;
    }
    out.set(player.id, { playerId: player.id, gsisId: null, pfrId: null, resolution: 'unresolved' });
  }
  return out;
}

/** What the resolution ladder achieved, for the health panel and the closeout. */
export interface IdentityCoverage {
  players: number;
  sleeperDirect: number;
  rosterBridge: number;
  unresolved: number;
  /** Players whose `pfr_id` is known, which is what gates the snap-count join. */
  withPfr: number;
}

export function identityCoverage(resolved: Iterable<ResolvedIdentity>): IdentityCoverage {
  const out: IdentityCoverage = { players: 0, sleeperDirect: 0, rosterBridge: 0, unresolved: 0, withPfr: 0 };
  for (const r of resolved) {
    out.players++;
    if (r.resolution === 'sleeper_direct') out.sleeperDirect++;
    else if (r.resolution === 'roster_bridge') out.rosterBridge++;
    else out.unresolved++;
    if (r.pfrId) out.withPfr++;
  }
  return out;
}
