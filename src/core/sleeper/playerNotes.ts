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
 * Read from the same `/players/nfl` answer the sync already fetched, so it
 * costs no request. No schema change: one row, one read on the Waivers screen.
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
}

export function playerNotesOf(
  raw: Readonly<Record<string, { position?: string | null; team?: string | null; depth_chart_order?: number | null; injury_status?: string | null; injury_body_part?: string | null; injury_notes?: string | null }>>,
  now: Date,
): StoredPlayerNotes {
  const depth: Record<string, number> = {};
  const injury: StoredPlayerNotes['injury'] = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || !p.team || !SKILL.has(String(p.position ?? '').toUpperCase())) continue;
    const order = typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null;
    if (order != null && order >= 1 && order <= 3) depth[id] = order;
    if (p.injury_status) injury[id] = [p.injury_status, p.injury_body_part ?? null, p.injury_notes ?? null];
  }
  return { fetchedAt: now.toISOString(), depth, injury };
}

export function readPlayerNotes(stored: StoredPlayerNotes | null): {
  depth: Record<string, number>;
  injury: Record<string, InjuryNote>;
} {
  const injury: Record<string, InjuryNote> = {};
  for (const [id, [status, bodyPart, notes]] of Object.entries(stored?.injury ?? {})) injury[id] = { status, bodyPart, notes };
  return { depth: { ...(stored?.depth ?? {}) }, injury };
}
