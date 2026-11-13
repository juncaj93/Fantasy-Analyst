/**
 * Two facts from Sleeper's player file that the player table does not keep,
 * stored as one settings row (`sleeper.playerNotes`) by the daily player sync.
 *
 * - **Depth-chart order** for quarterbacks, backs, receivers and tight ends,
 *   first three only: whether a bench back is the direct backup to one of
 *   your starters (`waivers/dropScore.ts`).
 * - **Injury body part and note** (`Knee - ACL`, `Surgery`), for anyone with
 *   an injury status: whether an injured free agent is out for the season
 *   (`waivers/stash.ts`).
 *
 * - **Club moves** (Round 26): each depth-charted player's club, and who
 *   changed clubs since the last sync, kept {@link MOVED_DAYS} days. A
 *   starter traded away leaves a role open on his old club
 *   (`waivers/opportunity.ts`).
 *
 * Read from the same `/players/nfl` answer the sync already fetched, so it
 * costs no request. No schema change: one row, one read on the Waivers screen
 * (and, since Round 26, one read of the same row by the daily sync).
 */

import type { InjuryNote } from '../waivers/stash.ts';

export const PLAYER_NOTES_KEY = 'sleeper.playerNotes';

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

export interface StoredPlayerNotes {
  fetchedAt: string;
  /** Player id to depth-chart order (1 to 3). */
  depth: Record<string, number>;
  /** Player id to [status, body part, note]. */
  injury: Record<string, [string | null, string | null, string | null]>;
  /** Round 26: each depth-charted player's club, to see a move at the next sync. Absent on older rows. */
  teams?: Record<string, string>;
  /** Round 26: player id to [club left, club joined, when]. Absent on older rows. */
  moved?: Record<string, [string, string, string]>;
}

/** How long a club move stays on record: about six weeks, after which it is in his numbers. */
export const MOVED_DAYS = 42;
const DAY_MS = 86_400_000;

export function playerNotesOf(
  raw: Readonly<Record<string, { position?: string | null; team?: string | null; depth_chart_order?: number | null; injury_status?: string | null; injury_body_part?: string | null; injury_notes?: string | null }>>,
  now: Date,
  /** The row as the last sync left it, for club moves. Null: none recorded yet. */
  previous: StoredPlayerNotes | null = null,
): StoredPlayerNotes {
  const depth: Record<string, number> = {};
  const injury: StoredPlayerNotes['injury'] = {};
  const teams: Record<string, string> = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || !p.team || !SKILL.has(String(p.position ?? '').toUpperCase())) continue;
    const order = typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null;
    if (order != null && order >= 1 && order <= 3) {
      depth[id] = order;
      teams[id] = String(p.team).toUpperCase();
    }
    if (p.injury_status) injury[id] = [p.injury_status, p.injury_body_part ?? null, p.injury_notes ?? null];
  }
  /* Moves already on record and still recent, then any club change since the last sync. */
  const moved: Record<string, [string, string, string]> = {};
  for (const [id, entry] of Object.entries(previous?.moved ?? {})) {
    const at = Date.parse(entry[2]);
    if (Number.isFinite(at) && now.getTime() - at <= MOVED_DAYS * DAY_MS) moved[id] = entry;
  }
  for (const [id, before] of Object.entries(previous?.teams ?? {})) {
    const club = raw[id]?.team ? String(raw[id]!.team).toUpperCase() : null;
    if (club && before && club !== before) moved[id] = [before, club, now.toISOString()];
  }
  return { fetchedAt: now.toISOString(), depth, injury, teams, moved };
}

export function readPlayerNotes(stored: StoredPlayerNotes | null): {
  depth: Record<string, number>;
  injury: Record<string, InjuryNote>;
  /** Round 26: recent club moves, the club left and the club joined. */
  moved: Record<string, { from: string; to: string }>;
} {
  const injury: Record<string, InjuryNote> = {};
  for (const [id, [status, bodyPart, notes]] of Object.entries(stored?.injury ?? {})) injury[id] = { status, bodyPart, notes };
  const moved: Record<string, { from: string; to: string }> = {};
  for (const [id, [from, to]] of Object.entries(stored?.moved ?? {})) moved[id] = { from, to };
  return { depth: { ...(stored?.depth ?? {}) }, injury, moved };
}
