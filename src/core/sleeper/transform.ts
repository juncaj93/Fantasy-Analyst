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

/**
 * Positions we keep from the Sleeper player dump. Everything else is dropped.
 *
 * Kickers are deliberately absent. They are not modelled anywhere in this app —
 * no news rules read them, no Vegas market covers them, and no published ADP
 * this project uses ranks them — so keeping three hundred of them in the
 * dictionary only ever produced empty screens and a filter chip that returned
 * nothing. A league that starts one still starts one; the app simply does not
 * pretend to have an opinion about who it should be.
 */
export const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'DEF']);

/**
 * Positions the app refuses to carry, whatever a league or a feed says.
 *
 * Applied at read time as well as at sync time, so kickers already stored by an
 * earlier sync disappear immediately rather than lingering until the next one.
 */
export const EXCLUDED_POSITIONS = new Set(['K']);

export function isExcludedPosition(position: string | null | undefined): boolean {
  return EXCLUDED_POSITIONS.has(String(position ?? '').toUpperCase());
}

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
function searchRank(p: SleeperPlayer): number | null {
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
      searchRank: searchRank(p),
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
 * The user's next pick, counting the one on the clock. `null` when they have no
 * picks left.
 *
 * This answers "when is my turn", which is what the header says — on the clock
 * it is this pick, zero picks away, and the screen reads `YOUR PICK`.
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

/**
 * The pick a player would have to survive to if you pass on him now.
 *
 * A different question from `nextPickForSlot`, and the difference only shows on
 * the clock — which is the one moment it matters.
 *
 * Off the clock the two agree: your next turn is in the future either way. On
 * the clock they diverge, because "when is my turn" is *now* and "when could I
 * next take him" is your following selection. Measuring survival against the
 * pick you are currently making asks whether a player available now will still
 * be available now, which is true of everybody — so the whole board read 100%
 * exactly when the number was being used to make a decision.
 *
 * Returns `null` on your final selection of the draft. There is no later pick,
 * so "will he last" has no answer, and the honest report is that it is unknown
 * rather than certain.
 */
export function waitHorizonForSlot(
  slot: number,
  teams: number,
  rounds: number,
  type: string,
  currentPickNo: number,
): { pickNo: number; picksUntil: number } | null {
  const picks = pickNumbersForSlot(slot, teams, rounds, type);
  for (const p of picks) {
    if (p > currentPickNo) return { pickNo: p, picksUntil: p - currentPickNo };
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

/**
 * Work out a draft slot from the picks already made.
 *
 * Sleeper does not always publish `slot_to_roster_id` — best-ball and mock
 * drafts often leave it empty — and without a slot there is no "your next
 * pick", which is what survival and scarcity are measured against. Every pick
 * carries the slot that made it, so once you have picked once, your slot is a
 * fact rather than a lookup.
 *
 * Matches on roster id, falling back to the Sleeper user id for drafts that
 * record only who picked.
 */
export function slotFromPicks(
  picks: { draftSlot: number; rosterId: number | null; pickedBy: string | null }[],
  rosterId: number | null,
  ownerId: string | null = null,
): number | null {
  for (const pick of picks) {
    if (!pick.draftSlot) continue;
    if (rosterId != null && pick.rosterId === rosterId) return pick.draftSlot;
    if (ownerId && pick.pickedBy === ownerId) return pick.draftSlot;
  }
  return null;
}
