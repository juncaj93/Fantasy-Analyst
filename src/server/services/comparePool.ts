/**
 * The Compare picker's three lists: My roster, Waivers, All players.
 *
 * Every row carries this week's number from `weekPoints`, the same function
 * the Compare score, the Team screen's Best move card and the waiver tiers
 * read, so a player cannot show one number in the list and another a tap
 * later. It is computed exactly the way `/api/startsit/compare` computes it:
 * the same inputs (`startSitInputsFor`), the same engine, the same published
 * week, the same mode.
 *
 * ## Bounded
 *
 * My roster is evaluated whole. Waivers and All players are thousands of
 * names, so they are cut to {@link POOL_SIZE} before anything is evaluated: by
 * Rotowire's published week (the figure a free agent is most likely to have),
 * and by the imported draft ranking where nobody has one yet. A search narrows
 * the pool first, so any player can still be reached by name.
 *
 * Reads only. Nothing here writes or acts.
 */

import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { resolveWeek } from '../../core/matchup/build.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { positionMatchesFilter } from '../../core/sleeper/eligibility.ts';
import type { LeagueRecord } from '../../core/sleeper/types.ts';
import { buildScoringProfile } from '../../core/sleeper/scoring.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/rosterShape.ts';
import { settleOnPublishedWeek } from '../../core/startsit/decisionPoints.ts';
import { evaluatePlayer } from '../../core/startsit/engine.ts';
import type { StartSitMode } from '../../core/startsit/mode.ts';
import type { PillReading } from '../../core/startsit/pills.ts';
import { byWeekPoints, weekPoints, type WeekPoints } from '../../core/startsit/weekPoints.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import type { Database } from '../db.ts';
import { draftRanks } from './decisionInputs.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import { startSitInputsFor } from './startSitInputs.ts';

export type PoolTab = 'mine' | 'waivers' | 'all';

/** How many players a Waivers or All players list evaluates. */
export const POOL_SIZE = 30;

export interface PoolRow {
  id: string;
  name: string;
  position: string;
  team: string;
  /** Sleeper's injury word, when there is one. */
  status: string | null;
  owner: 'mine' | 'rostered' | 'available';
  /** The other manager's team name, on a rostered player. */
  ownerName: string | null;
  /** On My roster: whether Sleeper has him in the lineup. Null elsewhere. */
  starter: boolean | null;
  ruledOut: boolean;
  week: WeekPoints;
  pill: PillReading | null;
}

export interface PoolResponse {
  tab: PoolTab;
  week: number | null;
  /** How many matched before the list was cut to {@link POOL_SIZE}. */
  matched: number;
  rows: PoolRow[];
}

export async function comparePool(
  db: Database,
  sleeper: SleeperClient,
  opts: {
    league: LeagueRecord;
    tab: PoolTab;
    /** `ALL`, a position, or `FLX`. */
    position: string | null;
    query: string;
    mode: StartSitMode;
  },
): Promise<PoolResponse> {
  const { league, tab } = opts;
  const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
  const startable = startablePositions(buildRosterShape(league.rosterPositions));
  const playerRepo = new PlayerRepo(db);
  const [rosters, nflState] = await Promise.all([
    new LeagueRepo(db).listRosters(league.id),
    new SettingsRepo(db).get<NflState | null>(SETTING_KEYS.nflState, null),
  ]);
  const mine = rosters.find((r) => r.isMine) ?? null;
  const ownerOf = new Map<string, { owner: 'mine' | 'rostered'; name: string | null }>();
  for (const roster of rosters) {
    for (const id of roster.playerIds) {
      ownerOf.set(id, roster.isMine ? { owner: 'mine', name: null } : { owner: 'rostered', name: roster.ownerName });
    }
  }

  const wanted = (p: CanonicalPlayer) =>
    (startable.size === 0 || startable.has(p.position)) &&
    (!opts.position || opts.position === 'ALL' || positionMatchesFilter(p.position, opts.position));

  let pool: CanonicalPlayer[];
  if (tab === 'mine') {
    const found = await playerRepo.listByIds(mine?.playerIds ?? []);
    pool = [...found.values()];
  } else {
    const base = opts.query.trim() ? await playerRepo.search(opts.query, 400) : await playerRepo.listAll();
    pool = base.filter((p) => p.active && (tab === 'all' || !ownerOf.has(p.id)));
  }
  if (tab === 'mine' && opts.query.trim()) {
    const q = opts.query.trim().toLowerCase();
    pool = pool.filter((p) => p.fullName.toLowerCase().includes(q));
  }
  pool = pool.filter(wanted);
  const matched = pool.length;

  /* The published week, the same figure the compare route ranks a fallback on. */
  const week = resolveWeek(null, nflState?.week ?? null, nflState?.seasonType ?? null);
  const positions = new Map(pool.map((p) => [p.id, p.position] as const));
  const published = await new SleeperProjectionService(db, sleeper)
    .publishedFor({
      season: league.season,
      week,
      playerIds: pool.map((p) => p.id),
      profile,
      positionOf: (id) => positions.get(id) ?? null,
    })
    .catch((): Map<string, number> => new Map());

  if (tab !== 'mine' && pool.length > POOL_SIZE) {
    const ranks = published.size > 0 ? null : await draftRanks(db).catch(() => new Map());
    pool = [...pool]
      .sort((a, b) =>
        ranks
          ? (ranks.get(a.id)?.adp ?? Infinity) - (ranks.get(b.id)?.adp ?? Infinity) ||
            (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity)
          : (published.get(b.id) ?? -Infinity) - (published.get(a.id) ?? -Infinity),
      )
      .slice(0, POOL_SIZE);
  }

  const inputs = await startSitInputsFor(
    db,
    pool.map((p) => p.id),
    { mode: opts.mode, ...(tab === 'mine' && mine ? { reserveIds: mine.reserveIds } : {}) },
  );
  const starters = new Set(mine?.starterIds ?? []);
  const rows: (PoolRow & { name: string })[] = inputs.map((input) => {
    const evaluation = evaluatePlayer({ ...input, mode: input.mode ?? opts.mode }, profile);
    settleOnPublishedWeek(evaluation, published);
    const held = ownerOf.get(input.player.id);
    return {
      id: input.player.id,
      name: input.player.fullName,
      position: input.player.position,
      team: input.player.team,
      status: input.player.status ?? null,
      owner: held?.owner ?? 'available',
      ownerName: held?.name ?? null,
      starter: tab === 'mine' ? starters.has(input.player.id) : null,
      ruledOut: evaluation.ruledOut,
      week: weekPoints(evaluation, published),
      pill: evaluation.pill ?? null,
    };
  });

  return {
    tab,
    week: nflState?.seasonType === 'regular' ? (nflState.week ?? null) : null,
    matched,
    rows: rows.sort(byWeekPoints),
  };
}

export function parsePoolTab(value: string | null): PoolTab {
  return value === 'waivers' || value === 'all' ? value : 'mine';
}
