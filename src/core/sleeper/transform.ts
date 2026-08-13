/**
 * Pure transforms from raw Sleeper payloads to canonical internal records.
 * Every function here is deterministic and side-effect free so it can be tested
 * directly against fixtures.
 */

import { normalizeName, normalizePosition, normalizeTeam } from '../identity/normalize.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type {
  DraftPickRecord,
  DraftRecord,
  LeagueRecord,
  RosterRecord,
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperPlayer,
  SleeperRoster,
  SleeperUser,
} from './types.ts';

/** Positions we keep from the Sleeper player dump. Everything else is dropped. */
export const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

/**
 * Convert the Sleeper player dump into canonical players.
 *
 * Sleeper is the source of truth for identity, so `sleeperPlayerId` becomes the
 * canonical `id`. Only fantasy-relevant positions are retained (the raw dump
 * contains every NFL player including practice squad linemen).
 */
/**
 * Sleeper ranks most fantasy-relevant players and parks everyone else at a
 * sentinel far outside any draft. Treat that sentinel as "not ranked" rather
 * than letting a rank of 9999999 look like a real, very late pick.
 */
function draftRank(p: SleeperPlayer): number | null {
  const raw = p.search_rank;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw > 0 && raw < 100_000 ? raw : null;
}

export function toCanonicalPlayers(
  raw: Record<string, SleeperPlayer>,
  opts: { keepInactive?: boolean } = {},
): CanonicalPlayer[] {
  const out: CanonicalPlayer[] = [];
  for (const [key, p] of Object.entries(raw ?? {})) {
    if (!p || typeof p !== 'object') continue;
    const position = pickPosition(p);
    if (!FANTASY_POSITIONS.has(position)) continue;

    const sleeperId = String(p.player_id ?? key);
    const firstName = (p.first_name ?? '').trim();
    const lastName = (p.last_name ?? '').trim();
    const fullName = (p.full_name ?? `${firstName} ${lastName}`).trim();
    if (!fullName) continue;

    const active = p.active === true;
    if (!active && !opts.keepInactive) continue;

    const externalIds: Record<string, string> = {};
    if (p.gsis_id) externalIds['gsis'] = String(p.gsis_id);
    if (p.espn_id) externalIds['espn'] = String(p.espn_id);
    if (p.yahoo_id) externalIds['yahoo'] = String(p.yahoo_id);

    out.push({
      id: sleeperId,
      sleeperPlayerId: sleeperId,
      fullName,
      firstName,
      lastName,
      team: normalizeTeam(p.team),
      position,
      status: p.injury_status ?? p.status ?? null,
      active,
      normalizedName: normalizeName(fullName),
      aliases: defaultAliases(fullName, firstName, lastName),
      externalIds,
      draftRank: draftRank(p),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function pickPosition(p: SleeperPlayer): string {
  const primary = normalizePosition(p.position);
  if (FANTASY_POSITIONS.has(primary)) return primary;
  for (const fp of p.fantasy_positions ?? []) {
    const n = normalizePosition(fp);
    if (FANTASY_POSITIONS.has(n)) return n;
  }
  return primary;
}

/**
 * Deterministic aliases generated at sync time: "F. Last", "F Last", and the
 * bare surname. User- and source-supplied aliases are stored separately in
 * `player_aliases` and are never overwritten by this function.
 */
export function defaultAliases(fullName: string, firstName: string, lastName: string): string[] {
  const aliases = new Set<string>();
  const first = firstName || fullName.split(' ')[0] || '';
  const last = lastName || fullName.split(' ').slice(1).join(' ') || '';
  if (first && last) {
    aliases.add(`${first[0]}. ${last}`);
    aliases.add(`${first[0]} ${last}`);
  }
  aliases.delete(fullName);
  return [...aliases];
}

export function toLeagueRecord(league: SleeperLeague, now: string): LeagueRecord {
  return {
    id: league.league_id,
    sleeperLeagueId: league.league_id,
    name: league.name ?? 'Unnamed league',
    season: String(league.season ?? ''),
    totalRosters: Number(league.total_rosters ?? 0),
    scoringSettings: league.scoring_settings ?? {},
    rosterPositions: league.roster_positions ?? [],
    leagueSettings: league.settings ?? {},
    draftId: league.draft_id ?? null,
    lastSyncedAt: now,
  };
}

export function toRosterRecords(
  leagueId: string,
  rosters: SleeperRoster[],
  users: SleeperUser[],
  myUserId: string | null,
): RosterRecord[] {
  const userById = new Map(users.map((u) => [u.user_id, u]));
  return rosters.map((r) => {
    const owner = r.owner_id ? userById.get(r.owner_id) : undefined;
    return {
      leagueId,
      rosterId: Number(r.roster_id),
      ownerId: r.owner_id ?? null,
      ownerName: owner?.display_name ?? owner?.username ?? null,
      playerIds: (r.players ?? []).filter(Boolean),
      starterIds: (r.starters ?? []).filter((p) => !!p && p !== '0'),
      reserveIds: (r.reserve ?? []).filter(Boolean),
      isMine: !!myUserId && r.owner_id === myUserId,
    };
  });
}

export function toDraftRecord(draft: SleeperDraft, now: string): DraftRecord {
  const settings = (draft.settings ?? {}) as Record<string, unknown>;
  return {
    id: draft.draft_id,
    sleeperDraftId: draft.draft_id,
    leagueId: draft.league_id,
    status: draft.status ?? 'unknown',
    type: draft.type ?? 'unknown',
    season: String(draft.season ?? ''),
    rounds: Number(settings['rounds'] ?? 0),
    teams: Number(settings['teams'] ?? 0),
    slotToRosterId: normalizeSlotMap(draft.slot_to_roster_id),
    settings,
    lastSyncedAt: now,
  };
}

function normalizeSlotMap(map: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slot, rosterId] of Object.entries(map ?? {})) {
    out[String(slot)] = Number(rosterId);
  }
  return out;
}

export function toDraftPickRecords(
  draftId: string,
  picks: SleeperDraftPick[],
  teams: number,
): DraftPickRecord[] {
  return picks
    .filter((p) => Number.isFinite(Number(p.pick_no)))
    .map((p) => {
      const pickNo = Number(p.pick_no);
      const round = Number(p.round ?? (teams > 0 ? Math.ceil(pickNo / teams) : 0));
      const pickInRound = teams > 0 ? pickNo - (round - 1) * teams : Number(p.draft_slot ?? 0);
      return {
        draftId,
        pickNo,
        round,
        pickInRound,
        draftSlot: Number(p.draft_slot ?? 0),
        sleeperPlayerId: p.player_id ? String(p.player_id) : null,
        playerId: p.player_id ? String(p.player_id) : null,
        rosterId: p.roster_id == null ? null : Number(p.roster_id),
        pickedBy: p.picked_by ?? null,
        raw: JSON.stringify(p),
      };
    })
    .sort((a, b) => a.pickNo - b.pickNo);
}

/**
 * Snake-draft pick numbers for a given draft slot.
 * Linear drafts advance in fixed slot order; snake drafts reverse every round.
 */
export function pickNumbersForSlot(
  slot: number,
  teams: number,
  rounds: number,
  type: string,
): number[] {
  if (slot < 1 || teams < 1 || rounds < 1) return [];
  const isSnake = type !== 'linear';
  const out: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    const positionInRound = isSnake && round % 2 === 0 ? teams - slot + 1 : slot;
    out.push((round - 1) * teams + positionInRound);
  }
  return out;
}

/**
 * The user's next pick strictly after `currentPickNo`, plus how many picks away
 * it is. Returns `null` when the user has no remaining picks.
 */
export function nextPickForSlot(
  slot: number,
  teams: number,
  rounds: number,
  type: string,
  currentPickNo: number,
): { pickNo: number; picksUntil: number } | null {
  const picks = pickNumbersForSlot(slot, teams, rounds, type);
  for (const p of picks) {
    if (p >= currentPickNo) return { pickNo: p, picksUntil: p - currentPickNo };
  }
  return null;
}

/** Find the draft slot owned by a roster id. */
export function slotForRoster(
  slotToRosterId: Record<string, number>,
  rosterId: number | null,
): number | null {
  if (rosterId == null) return null;
  for (const [slot, rid] of Object.entries(slotToRosterId)) {
    if (Number(rid) === rosterId) return Number(slot);
  }
  return null;
}
