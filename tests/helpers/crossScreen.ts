/**
 * One seeded league, read through every screen's own endpoint.
 *
 * The "numbers agree" round (23 October 2026) rests on one claim: the same
 * player carries the same number on Team, Matchup (card and decision),
 * Waivers, Trades and Compare. This builds the league once (the trade league
 * helper's copy of Tony's Pizza Fantasy, plus a Questionable starter, a
 * Doubtful bench player and a Sleeper-only receiver) and reads each screen the
 * way the app does, so a test can put the five numbers side by side.
 */

import { createApp } from '../../src/server/app.ts';
import { SleeperClient } from '../../src/core/sleeper/client.ts';
import { PlayerRepo } from '../../src/server/repos/players.ts';
import { LeagueRepo } from '../../src/server/repos/league.ts';
import { PropsRepo } from '../../src/server/repos/props.ts';
import { SleeperProjectionsRepo } from '../../src/server/repos/sleeperProjections.ts';
import { rowFigure } from '../../src/web/rowFigure.ts';
import { weekPointsBeforeStatus, weekPointsOf } from '../../src/core/startsit/weekPoints.ts';
import type { StartSitEvaluation } from '../../src/core/startsit/engine.ts';
import { createTestDb } from './db.ts';
import { player } from './players.ts';
import { FETCHED_AT, LEAGUE, MINE, THEIRS, envFor, seed } from './tradeLeague.ts';

/** Questionable starter, Doubtful bench player, Sleeper-only receiver (one posted line, 16 on Sleeper's week). */
export const QUESTIONABLE = 'm_wr3';
export const DOUBTFUL = 'm_bn1';
export const SLEEPER_ONLY = 'm_sl';
export const HEALTHY = 'm_wr1';
/** A priced receiver with good recent news, so his number carries a nudge on top of the market. */
export const NUDGED = 'm_wr2';

export interface ScreenNumbers {
  team: number | null;
  matchup: number | null;
  waivers: number | null;
  trades: number | null;
  compare: number | null;
}

type Json = Record<string, any>;

export interface CrossScreen {
  numbers(playerId: string): ScreenNumbers;
  lineup: Json;
  matchup: Json;
  waivers: Json;
  trade: Json;
  compare: Json;
  /** A Compare of exactly these players, the sheet's own request. */
  compareOf(playerIds: string[]): Promise<Json>;
}

export async function readEveryScreen(): Promise<CrossScreen> {
  const db = await createTestDb();
  await seed(db);
  await new PlayerRepo(db).upsertMany([
    player({ id: QUESTIONABLE, fullName: 'M_WR3', position: 'WR', team: 'DAL', status: 'Questionable' }),
    player({ id: DOUBTFUL, fullName: 'M_BN1', position: 'WR', team: 'DAL', status: 'Doubtful' }),
    player({ id: SLEEPER_ONLY, fullName: 'M_SL', position: 'WR', team: 'KC' }),
  ]);
  const ids = [...MINE.map((p) => p[0]), SLEEPER_ONLY];
  const mineStarters = MINE.slice(0, 9).map((p) => p[0]);
  const theirStarters = THEIRS.slice(0, 9).map((p) => p[0]);
  await new LeagueRepo(db).replaceRosters(LEAGUE, [
    { leagueId: LEAGUE, rosterId: 1, ownerId: 'me', ownerName: 'Alex', playerIds: ids, starterIds: mineStarters, reserveIds: [], isMine: true, settings: null },
    { leagueId: LEAGUE, rosterId: 2, ownerId: 'dermot', ownerName: 'Dermot', playerIds: THEIRS.map((p) => p[0]), starterIds: theirStarters, reserveIds: [], isMine: false, settings: null },
  ]);
  /* One touchdown line posted, so his market is a fragment and Sleeper's week is his number. */
  const props = new PropsRepo(db);
  const gameStart = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await props.put({
    provider: 'test',
    eventId: 'evt-2',
    gameStart,
    fetchedAt: FETCHED_AT,
    raw: { provider: 'test', eventId: 'evt-2', gameStart, fetchedAt: FETCHED_AT, quotes: [], raw: null },
  });
  const snapshot = await props.snapshotId('test', 'evt-2', FETCHED_AT);
  await props.saveConsensus(snapshot!, [
    { playerId: SLEEPER_ONLY, sourcePlayerName: 'M_SL', market: 'anytime_td', line: null, overPrice: -110, underPrice: -110, bookCount: 3, consensusMethod: 'median', books: ['a', 'b', 'c'], impliedProbability: 0.3 },
  ]);
  await new SleeperProjectionsRepo(db).save(
    '2026',
    5,
    [{ playerId: SLEEPER_ONLY, publisher: 'rotowire', points: { pts_std: 15, pts_half_ppr: 16, pts_ppr: 17 }, defense: null }],
    FETCHED_AT,
  );

  /* Good recent news for NUDGED: the "Recent news" nudge Team prints and Matchup used to drop. */
  for (let i = 0; i < 3; i++) {
    await db
      .prepare(
        `INSERT INTO evidence_items (dedupe_key, player_id, source_type, source_name, source_date, excerpt, category, polarity,
           magnitude, confidence, confidence_score, review_status, created_at, updated_at)
         VALUES (?, ?, 'newsletter', 'test', ?, 'Earning more targets.', 'usage', 'positive', 1, 'high', 0.9, 'auto_applied', ?, ?)`,
      )
      .bind(`nudge-${i}`, NUDGED, FETCHED_AT, FETCHED_AT, FETCHED_AT)
      .run();
  }
  await db
    .prepare(`INSERT INTO player_signal_cache (player_id, raw_positive, raw_net, raw_items, updated_at) VALUES (?, 3, 3, 3, ?)`)
    .bind(NUDGED, FETCHED_AT)
    .run();

  const pairing = [
    { roster_id: 1, matchup_id: 1, points: 0, starters: mineStarters, players: ids, players_points: {} },
    { roster_id: 2, matchup_id: 1, points: 0, starters: theirStarters, players: THEIRS.map((p) => p[0]), players_points: {} },
  ];
  const sleeper = new SleeperClient({
    fetch: async (url: string) =>
      /\/matchups\/\d+$/.test(new URL(url).pathname) ? new Response(JSON.stringify(pairing)) : new Response('null'),
  });
  const app = createApp();
  const env = envFor(db, sleeper);
  const get = async (path: string): Promise<Json> => (await app(new Request(`https://app.test${path}`), env)).json();

  const lineup = await get(`/api/leagues/${LEAGUE}/lineup`);
  const matchup = await get(`/api/leagues/${LEAGUE}/matchup`);
  const waivers = await get(`/api/leagues/${LEAGUE}/waivers`);
  const asked = [QUESTIONABLE, DOUBTFUL, SLEEPER_ONLY, HEALTHY];
  const trade = await get(`/api/leagues/${LEAGUE}/trades/check?a=1&b=2&give=${asked.join(',')}&get=t_rb1`);
  const tradeNudged = await get(`/api/leagues/${LEAGUE}/trades/check?a=1&b=2&give=${NUDGED}&get=t_rb1`);
  const compareOf = async (playerIds: string[]): Promise<Json> =>
    (await (
      await app(
        new Request('https://app.test/api/startsit/compare', {
          method: 'POST',
          body: JSON.stringify({ leagueId: LEAGUE, playerIds }),
          headers: { 'content-type': 'application/json' },
        }),
        env,
      )
    ).json()) as Json;
  const compare = await compareOf(asked);
  const compareNudged = await compareOf([NUDGED, HEALTHY]);

  const teamEvaluations: StartSitEvaluation[] = [...lineup.starters, ...lineup.bench, ...lineup.undecidable];
  const matchupPlayers: Json[] = [
    ...matchup.forecast.slots.flatMap((s: Json) => [s.mine, s.theirs]).filter(Boolean),
    ...matchup.forecast.bench.mine,
    ...matchup.forecast.bench.theirs,
  ];

  return {
    lineup,
    matchup,
    waivers,
    trade,
    compare,
    compareOf,
    numbers(playerId) {
      /* Team: the row's figure, exactly as the row draws it (`rowFigure`). */
      const e = teamEvaluations.find((x) => x.playerId === playerId);
      const figure = e ? rowFigure(weekPointsBeforeStatus(e), e) : { kind: 'none' as const };
      const team = figure.kind === 'plain' || figure.kind === 'risk' ? figure.points : figure.kind === 'out' ? 0 : null;
      /* Matchup: the card's projected figure, which before kickoff is the mean the decision is simulated on. */
      const card = matchupPlayers.find((p) => p.playerId === playerId);
      /* Waivers: this week's figure on the sheet, `Out` as zero. */
      const week = waivers.tiers?.weekFigures?.[playerId]?.weeks?.[0];
      const waiverNumber = week == null ? null : week.out ? 0 : week.points;
      /* Trades: this week's rate times this week's share. */
      const rate = [...(trade.evaluation?.a?.outgoing ?? []), ...(tradeNudged.evaluation?.a?.outgoing ?? [])].find((p: Json) => p.playerId === playerId);
      const tradeNumber = rate?.rate == null ? null : Math.round(rate.rate * (rate.weekly?.[0] ?? 1) * 100) / 100;
      /* Compare: the card's number (`weekPointsOf`). */
      const c = [...(compare.evaluations ?? []), ...(compareNudged.evaluations ?? [])].find((x: Json) => x.playerId === playerId);
      return {
        team,
        matchup: card?.projectedFinal ?? null,
        waivers: waiverNumber,
        trades: tradeNumber,
        compare: c ? weekPointsOf(c).points : null,
      };
    },
  };
}
