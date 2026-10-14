/**
 * Waivers round 2's inputs, in one settings read.
 *
 * - `sleeper.seasonPoints.<season>`: every player's points week by week, for
 *   the drop score and the elite-back read;
 * - `sleeper.playerNotes`: Sleeper's depth order and injury notes, for
 *   handcuffs and season-ending injuries;
 * - `waivers.rivalHistory.<league>.<season>.<user>` for the two seasons
 *   before this one: each rival's record, written by the Wednesday manager
 *   derive.
 *
 * This season's record is not read from a row: it is rebuilt here from the
 * claims the strategy context already loaded, so it is as fresh as the last
 * league read and costs nothing. Weeks held come from the same transactions.
 * About twenty rows a Waivers load; never a fetch.
 */

import type { WaiverRound2Inputs } from '../../core/waivers/assemble.ts';
import { buildRivalSeasonAggregates, rivalHistoryKey, type HistoryClaim, type RivalSeasonAggregate } from '../../core/waivers/rivalHistory.ts';
import { PLAYER_NOTES_KEY, readPlayerNotes, type StoredPlayerNotes } from '../../core/sleeper/playerNotes.ts';
import { seasonPointsKey, type StoredSeasonPoints } from '../../core/sleeper/weekPoints.ts';
import type { RosterRecord } from '../../core/sleeper/types.ts';
import type { Database } from '../db.ts';
import { SettingsRepo } from '../repos/settings.ts';
import { LeagueRepo } from '../repos/league.ts';
import type { StrategyContext } from './leagueStrategyService.ts';

/** Seasons before this one whose rival rows are read. */
export const PRIOR_SEASONS = 2;

export async function readWaiverRound2(
  db: Database,
  opts: {
    leagueId: string;
    season: string;
    rosters: readonly RosterRecord[];
    mine: RosterRecord;
    strategy: StrategyContext | null;
    positionOf: (playerId: string) => string | null;
    /** The league's `reserve_allow_*` settings, read by the caller. */
    reserveAllows: { out: boolean; doubtful: boolean; sus: boolean };
  },
): Promise<WaiverRound2Inputs> {
  const priorSeasons = Array.from({ length: PRIOR_SEASONS }, (_, i) => String(Number(opts.season) - 1 - i));
  const rivals = opts.rosters.filter((r) => !r.isMine && r.ownerId);
  const rivalKeys = rivals.flatMap((r) => priorSeasons.map((s) => rivalHistoryKey(opts.leagueId, s, r.ownerId!)));
  const rows = await new SettingsRepo(db)
    .getMany<unknown>([seasonPointsKey(opts.season), PLAYER_NOTES_KEY, draftRoundsKey(opts.leagueId), ...rivalKeys])
    .catch(() => new Map<string, unknown>());
  /* This league's own draft, cached once (`ensureDraftRounds`); until then, read from the stored picks. */
  const draftRounds =
    (rows.get(draftRoundsKey(opts.leagueId)) as Record<string, number> | undefined) ??
    (await draftRoundsOf(db, opts.leagueId).catch(() => ({}) as Record<string, number>));

  const season = (rows.get(seasonPointsKey(opts.season)) as StoredSeasonPoints | undefined) ?? null;
  const notes = readPlayerNotes((rows.get(PLAYER_NOTES_KEY) as StoredPlayerNotes | undefined) ?? null);

  /* Earlier seasons, re-keyed from the Sleeper user to his roster today. */
  const managerSeasons: Record<string, RivalSeasonAggregate[]> = {};
  for (const r of rivals) {
    const list: RivalSeasonAggregate[] = [];
    for (const s of priorSeasons) {
      const row = rows.get(rivalHistoryKey(opts.leagueId, s, r.ownerId!)) as RivalSeasonAggregate | undefined;
      if (row && row.v === 1) list.push({ ...row, userId: String(r.rosterId) });
    }
    managerSeasons[String(r.rosterId)] = list;
  }

  /* This season, from the claims already in hand. */
  const moves = opts.strategy?.seasonMoves;
  if (moves) {
    const claims: HistoryClaim[] = moves.claims.map((c) => ({
      season: opts.season,
      week: c.week,
      userId: String(c.rosterId),
      playerId: c.playerId,
      position: opts.positionOf(c.playerId) ?? (/^[A-Z]{2,3}$/.test(c.playerId) ? 'DEF' : null),
      amount: c.amount,
      won: c.won,
      voided: c.voided,
      at: c.at,
    }));
    const pointsOf = (week: number): Map<string, number> | null => {
      if (!season || week < 1 || week > season.through) return null;
      const out = new Map<string, number>();
      for (const [id, weeks] of Object.entries(season.points)) if (weeks[week - 1]) out.set(id, weeks[week - 1]!);
      return out;
    };
    const current = buildRivalSeasonAggregates({
      claims,
      adds: moves.adds.map((a) => ({ season: opts.season, userId: String(a.rosterId), kind: a.kind })),
      seasonsByUser: new Map(opts.rosters.map((r) => [String(r.rosterId), [opts.season]] as const)),
      points: (s, week) => (s === opts.season ? pointsOf(week) : null),
      budgetTotal: opts.strategy?.budget.rule.total ?? null,
    });
    for (const row of current) {
      if (row.userId === String(opts.mine.rosterId)) continue;
      (managerSeasons[row.userId] ??= []).push(row);
    }
  }

  const heldSince: Record<string, { week: number; how: string }> = {};
  for (const [id, h] of moves?.heldSince ?? new Map()) if (opts.mine.playerIds.includes(id)) heldSince[id] = h;

  return {
    managerSeasons,
    seasonPoints: season?.points ?? {},
    seasonPointsThrough: season?.through ?? 0,
    heldSince,
    /* Anyone on the roster no transaction brought in came from the draft. */
    drafted: moves ? opts.mine.playerIds.filter((id) => heldSince[id] == null) : [],
    injuryNotes: notes.injury,
    depthOrder: notes.depth,
    reserveAllows: opts.reserveAllows,
    draftRounds,
  };
}

/** The settings key holding the round each player went in this league's draft. */
export function draftRoundsKey(leagueId: string): string {
  return `waivers.draftRounds.${leagueId}`;
}

/** Player id to round, from this league's stored draft picks (Sleeper's draft picks endpoint, synced). */
async function draftRoundsOf(db: Database, leagueId: string): Promise<Record<string, number>> {
  const picks = await new LeagueRepo(db).listLeagueDraftPicks(leagueId);
  const out: Record<string, number> = {};
  for (const p of picks) if (p.teams > 0) out[p.playerId] = Math.ceil(p.pickNo / p.teams);
  return out;
}

/**
 * Cache this league's draft rounds as one settings row, once: a finished draft
 * never changes. Run from the three-hourly league read; one row read when the
 * cache is there, one picks read and one write when it is not.
 */
export async function ensureDraftRounds(db: Database, leagueId: string): Promise<number> {
  const settings = new SettingsRepo(db);
  if (await settings.get<Record<string, number> | null>(draftRoundsKey(leagueId), null)) return 0;
  const rounds = await draftRoundsOf(db, leagueId);
  if (Object.keys(rounds).length === 0) return 0;
  await settings.set(draftRoundsKey(leagueId), rounds);
  return Object.keys(rounds).length;
}
