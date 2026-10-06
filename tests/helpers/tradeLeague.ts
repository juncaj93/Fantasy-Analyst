/**
 * A league shaped like Tony's Pizza Fantasy, written through the real
 * repositories, for the tests that need two rosters with a real trade between
 * them: a roster deep at receiver, its mirror image deep at back, a free-agent
 * shortlist a clear step below, a fixture list with a bye, and priced markets
 * under every player.
 */

import { SleeperClient } from '../../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../../src/core/vegas/mockProvider.ts';
import type { AppEnv } from '../../src/server/app.ts';
import { MOCK_GAMES } from '../../src/devserver/seed.ts';
import { LeagueRepo } from '../../src/server/repos/league.ts';
import { NflScheduleRepo } from '../../src/server/repos/nflSchedule.ts';
import { PlayerRepo } from '../../src/server/repos/players.ts';
import { PropsRepo } from '../../src/server/repos/props.ts';
import { SettingsRepo, SETTING_KEYS } from '../../src/server/repos/settings.ts';
import { EXPECTED_MARKETS } from '../../src/core/startsit/expectation.ts';
import type { PlayerProp } from '../../src/core/vegas/types.ts';
import { player } from './players.ts';

/** Tony's Pizza Fantasy, as Sleeper publishes it. */
export const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
export const LEAGUE = 'tony';

export const FETCHED_AT = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
const GAME_START = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

export function forbiddenSleeper() {
  const calls: string[] = [];
  const client = new SleeperClient({
    fetch: async (url: string) => {
      calls.push(url);
      throw new Error(`The trade check must not call Sleeper, but asked for ${url}`);
    },
  });
  return { client, calls };
}

export function envFor(db: AppEnv['db'], sleeper: SleeperClient): AppEnv {
  return { db, sleeper, vegas: new MockVegasProvider(MOCK_GAMES), disableAuth: true };
}

export type Spec = [id: string, position: string, points: number, team?: string];

/** Alex: deep at receiver, one real back, a weak third starter at flex. */
export const MINE: Spec[] = [
  ['m_qb', 'QB', 20, 'KC'],
  ['m_rb1', 'RB', 15, 'KC'],
  ['m_rb2', 'RB', 7, 'DAL'],
  ['m_wr1', 'WR', 17, 'KC'],
  ['m_wr2', 'WR', 15, 'DAL'],
  ['m_wr3', 'WR', 14, 'DAL'],
  ['m_wr4', 'WR', 13, 'KC'],
  ['m_wr5', 'WR', 12.5, 'DAL'],
  ['m_te', 'TE', 9, 'KC'],
  ['m_bn1', 'WR', 5, 'DAL'],
  ['m_bn2', 'RB', 4, 'NE'],
];

/** Dermot: the mirror image, deep at back and short at receiver. */
export const THEIRS: Spec[] = [
  ['t_qb', 'QB', 19, 'NE'],
  ['t_rb1', 'RB', 16, 'NE'],
  ['t_rb2', 'RB', 15, 'NE'],
  ['t_rb3', 'RB', 14, 'NE'],
  ['t_rb4', 'RB', 13, 'DAL'],
  ['t_wr1', 'WR', 9, 'NE'],
  ['t_wr2', 'WR', 8, 'NE'],
  ['t_wr3', 'WR', 7, 'NE'],
  ['t_te', 'TE', 8, 'NE'],
  ['t_bn1', 'RB', 5, 'KC'],
];

/** Free agents, a clear step below anybody who matters. */
const FREE: Spec[] = [
  ...[8, 7.5, 7].map((v, i) => [`f_rb${i}`, 'RB', v, 'NE'] as Spec),
  ...[8.5, 8, 7.5].map((v, i) => [`f_wr${i}`, 'WR', v, 'NE'] as Spec),
  ...[6, 5.5, 5].map((v, i) => [`f_te${i}`, 'TE', v, 'NE'] as Spec),
  ...[14, 13, 12].map((v, i) => [`f_qb${i}`, 'QB', v, 'NE'] as Spec),
];

/** A priced player's whole board, so the market is complete and not a fragment. */
function boardFor(id: string, position: string, points: number): PlayerProp[] {
  const make = (market: PlayerProp['market'], line: number | null, p: number | null = null): PlayerProp => ({
    playerId: id,
    sourcePlayerName: id.toUpperCase(),
    market,
    line,
    overPrice: -110,
    underPrice: -110,
    bookCount: 3,
    consensusMethod: 'median',
    books: ['a', 'b', 'c'],
    impliedProbability: p,
  });
  const main = position === 'QB' ? 'pass_yards' : position === 'RB' ? 'rush_yards' : 'receiving_yards';
  const lineFor = position === 'QB' ? points / 0.04 : points * 10;
  const props: PlayerProp[] = [make(main, lineFor)];
  for (const other of EXPECTED_MARKETS[position] ?? []) {
    if (other === main) continue;
    props.push(other === 'anytime_td' ? make(other, null, 0) : make(other, 0));
  }
  return props;
}

export async function seed(db: AppEnv['db'], opts: { deadline?: number } = {}): Promise<void> {
  const all: Spec[] = [...MINE, ...THEIRS, ...FREE];
  await new PlayerRepo(db).upsertMany(
    all.map(([id, position, , team]) => player({ id, fullName: id.toUpperCase(), position, team: team ?? 'NE' })),
  );

  const propsRepo = new PropsRepo(db);
  await propsRepo.put({
    provider: 'test',
    eventId: 'evt-1',
    gameStart: GAME_START,
    fetchedAt: FETCHED_AT,
    raw: { provider: 'test', eventId: 'evt-1', gameStart: GAME_START, fetchedAt: FETCHED_AT, quotes: [], raw: null },
  });
  const snapshotId = await propsRepo.snapshotId('test', 'evt-1', FETCHED_AT);
  if (snapshotId != null) {
    await propsRepo.saveConsensus(snapshotId, all.flatMap(([id, position, points]) => boardFor(id, position, points)));
  }

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: LEAGUE,
    sleeperLeagueId: LEAGUE,
    name: 'Tony’s Pizza Fantasy',
    season: '2026',
    totalRosters: 3,
    scoringSettings: { rec: 0.5, rec_yd: 0.1, pass_yd: 0.04, rush_yd: 0.1, pass_td: 4, rush_td: 6, rec_td: 6 },
    rosterPositions: POSITIONS,
    leagueSettings: {
      playoff_week_start: 15,
      playoff_teams: 6,
      playoff_round_type: 0,
      trade_deadline: opts.deadline ?? 11,
      pick_trading: 0,
    },
    draftId: null,
    lastSyncedAt: FETCHED_AT,
  });
  await leagues.selectLeague(LEAGUE);
  await leagues.replaceRosters(LEAGUE, [
    { leagueId: LEAGUE, rosterId: 1, ownerId: 'me', ownerName: 'Alex', playerIds: MINE.map((p) => p[0]), starterIds: MINE.slice(0, 9).map((p) => p[0]), reserveIds: [], isMine: true, settings: null },
    { leagueId: LEAGUE, rosterId: 2, ownerId: 'dermot', ownerName: 'Dermot', playerIds: THEIRS.map((p) => p[0]), starterIds: THEIRS.slice(0, 9).map((p) => p[0]), reserveIds: [], isMine: false, settings: null },
    { leagueId: LEAGUE, rosterId: 3, ownerId: 'kim', ownerName: null, playerIds: [], starterIds: [], reserveIds: [], isMine: false, settings: null },
  ]);

  await new SettingsRepo(db).set(SETTING_KEYS.nflState, { season: '2026', seasonType: 'regular', week: 5, fetchedAt: FETCHED_AT });

  // The fixture list for three clubs, weeks 5 to 17, with Dallas off in week 9.
  const rows = ['KC', 'DAL', 'NE'].flatMap((team) =>
    Array.from({ length: 13 }, (_, i) => i + 5)
      .filter((week) => !(team === 'DAL' && week === 9))
      .map((week) => ({ season: '2026', week, team, opponent: 'XXX', home: week % 2 === 0, kickoff: null, roof: null })),
  );
  await new NflScheduleRepo(db).save(rows, FETCHED_AT);
}

