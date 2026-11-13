/**
 * The in-season Players tab (Round 24): the value it sorts by, the two new
 * filters (trade targets with the owner's willingness, injured and
 * returning), the card's data (this week, the next four with byes, the last
 * five games), the switch, and the routes. Draft mode is covered by the
 * existing Players tests, which this round leaves untouched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppEnv } from '../src/server/app.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper, seed, LEAGUE } from './helpers/tradeLeague.ts';
import {
  PLAYERS_INSEASON,
  injuryRead,
  overFreeAgent,
  lastGames,
  nextWeeks,
  seasonValue,
  tradeTargets,
  willingnessOf,
  type BoardRoster,
} from '../src/core/players/inseason.ts';
import { previewSeasonBoard, previewSeasonCard } from '../src/core/players/seasonPreview.ts';
import { byWillingness } from '../src/core/players/seasonOrder.ts';
import { seasonValueOver } from '../src/core/tradeValue/evaluate.ts';
import type { SeasonBoard, SeasonCard } from '../src/core/players/seasonWire.ts';
import { PREVIEW_NAMES, previewLeague } from '../src/core/trades/previewLeague.ts';
import { perWeekValue, productionGames, seasonWeights } from '../src/core/value/restOfSeason.ts';
import { weeklyAvailability } from '../src/core/tradeValue/availability.ts';
import type { PlayerRate } from '../src/core/tradeValue/rate.ts';
import { forgetSeasonBoards } from '../src/server/services/playersSeasonService.ts';

const L = previewLeague('normal');
const rate = (id: string) => L.rates.get(id)!;
const hurt = (r: PlayerRate, designation: PlayerRate['designation'], onReserve = false): PlayerRate => {
  const a = weeklyAvailability({ designation, onReserve, weeks: L.horizon.weeks, byeWeek: r.byeWeek, rate: r.rate });
  return { ...r, designation, onReserve, weekly: a.weekly, games: a.games };
};
const boardRosters = (): BoardRoster[] =>
  L.rosters.map((r) => ({ rosterId: r.rosterId, isMine: r.isMine, playerIds: r.playerIds, activity: r.activity!.class, tradedWithYou: r.activity!.withYou }));

/** A database that refuses every statement: the preview must never reach one. */
const NO_DB = new Proxy({} as AppEnv['db'], {
  get: () => () => {
    throw new Error('the Players preview must not read the database');
  },
});

describe('rest-of-season value: the default sort', () => {
  it('is the shared per-week value: his rate times the weighted weeks he plays', () => {
    const r = rate('p03');
    expect(seasonValue(r, L.horizon)).toBe(perWeekValue(r.rate!, r.weekly, seasonWeights(L.horizon)));
  });

  it('counts a bye and an injury as weeks missed, never as a lower rate', () => {
    const r = rate('p02');
    const out = hurt(r, 'ir');
    expect(seasonValue(out, L.horizon)!).toBeLessThan(seasonValue(r, L.horizon)!);
    expect(out.rate).toBe(r.rate);
  });

  it('is null with no rate, so the player sorts last instead of at zero', () => {
    expect(seasonValue({ ...rate('p02'), rate: null }, L.horizon)).toBeNull();
    expect(seasonValue(undefined, L.horizon)).toBeNull();
  });

  it('the board is sorted by value over a free agent at his position (Trades’ number), highest first', () => {
    const values = previewSeasonBoard().rows.map((r) => r.overFreeAgent ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it('value over a free agent is Trades’ own seasonValueOver, with the same week weights', () => {
    const r = rate('p01');
    expect(overFreeAgent(r, L.replacement, L.horizon)).toBe(seasonValueOver(r, L.replacement, seasonWeights(L.horizon)));
  });

  it('so quarterbacks no longer fill the top: a QB far above the free-agent QB still ranks under a back far above his', () => {
    /* Raw points a week: Trey Halloran 21.4 (free-agent QB 15.1) tops Marcus Vance 17.8 (free-agent RB 7.1). */
    const rows = previewSeasonBoard().rows;
    const qb = rows.findIndex((r) => r.name === 'Trey Halloran');
    const rb = rows.findIndex((r) => r.name === 'Marcus Vance');
    expect(rows[qb]!.value!).toBeGreaterThan(rows[rb]!.value!);
    expect(rb).toBeLessThan(qb);
    const topTen = rows.slice(0, 10).filter((r) => r.position === 'QB').length;
    expect(topTen).toBeLessThanOrEqual(2);
  });

  it('free agents sit at zero over themselves and below every rostered starter', () => {
    const fa = previewSeasonBoard().rows.find((r) => r.name === 'Colt Ambrose')!;
    expect(fa.overFreeAgent).toBe(0);
  });
});

describe('Injured / returning', () => {
  it('Doubtful counts as Out and is back the week after', () => {
    const read = injuryRead(hurt(rate('p02'), 'doubtful'), L.horizon);
    expect(read).toEqual({ out: true, backWeek: L.horizon.weeks[1] });
  });

  it('IR is out four weeks, then back', () => {
    expect(injuryRead(hurt(rate('p02'), 'ir'), L.horizon)?.backWeek).toBe(L.horizon.currentWeek + 4);
  });

  it('Out returns after his bye when the bye falls in between', () => {
    const r = { ...rate('p07'), byeWeek: L.horizon.currentWeek + 1 };
    expect(injuryRead(hurt(r, 'doubtful'), L.horizon)?.backWeek).toBe(L.horizon.currentWeek + 2);
  });

  it('an IR slot is out whatever the designation says', () => {
    expect(injuryRead(hurt(rate('p02'), 'healthy', true), L.horizon)?.out).toBe(true);
  });

  it('healthy and Questionable players are not on it (Questionable is full value)', () => {
    expect(injuryRead(rate('p02'), L.horizon)).toBeNull();
    expect(injuryRead(hurt(rate('p02'), 'questionable'), L.horizon)).toBeNull();
  });

  it('the preview has injured players on several teams', () => {
    const out = previewSeasonBoard().rows.filter((r) => r.injury);
    expect(out.map((r) => r.name).sort()).toEqual(['Hollis Marchetti', 'Teo Ferreira', 'Tobin Achebe']);
  });
});

describe('Trade targets and how likely the owner is to deal', () => {
  it('Likely needs both: trades often and needs one of yours', () => {
    expect(willingnessOf({ activity: 'active', tradedWithYou: 0, needsYours: true })).toBe('Likely');
    expect(willingnessOf({ activity: 'unknown', tradedWithYou: 1, needsYours: true })).toBe('Likely');
    expect(willingnessOf({ activity: 'active', tradedWithYou: 0, needsYours: false })).toBe('Maybe');
    expect(willingnessOf({ activity: 'unknown', tradedWithYou: 0, needsYours: true })).toBe('Maybe');
    expect(willingnessOf({ activity: 'unknown', tradedWithYou: 0, needsYours: false })).toBe('Unlikely');
  });

  it('a manager on record as almost never trading is Unlikely whatever he needs', () => {
    expect(willingnessOf({ activity: 'effectively_inactive', tradedWithYou: 0, needsYours: true })).toBe('Unlikely');
    expect(willingnessOf({ activity: 'low_activity', tradedWithYou: 3, needsYours: true })).toBe('Unlikely');
  });

  it('only players on other teams who would start for you, each with a gain of at least a point a week', () => {
    const targets = tradeTargets({ horizon: L.horizon, shape: L.shape, rates: L.rates, rosters: boardRosters() });
    const mine = new Set(L.rosters.find((r) => r.isMine)!.playerIds);
    expect(targets.size).toBeGreaterThan(0);
    for (const [id, t] of targets) {
      expect(mine.has(id)).toBe(false);
      expect(t.gain).toBeGreaterThanOrEqual(PLAYERS_INSEASON.targetGain);
      expect(t.reason).toBe(t.over ? `Starts at ${t.slot}, ${t.over} to the bench, +${t.gain.toFixed(1)} a week` : `Starts at ${t.slot} for you, +${t.gain.toFixed(1)} a week`);
    }
  });

  it('fills the weak spot: the preview roster is weak at tight end, so both good tight ends are targets', () => {
    const targets = tradeTargets({ horizon: L.horizon, shape: L.shape, rates: L.rates, rosters: boardRosters() });
    expect(targets.get('p28')?.slot).toBe('TE');
    expect(targets.get('p29')?.slot).toBe('TE');
    /* The direct comparison: the tight end he replaces, Teo Ferreira. */
    expect(targets.get('p28')?.over).toBe('Teo Ferreira');
    expect(targets.get('p28')?.reason).toMatch(/^Starts at TE, Teo Ferreira to the bench, \+\d+\.\d a week$/);
    expect(targets.get('p28')?.overValue).toBeLessThan(targets.get('p28')!.gain + targets.get('p28')!.overValue!);
  });

  it("Dermot trades often and needs your backs: Likely. Sam has no record: never Likely", () => {
    const targets = tradeTargets({ horizon: L.horizon, shape: L.shape, rates: L.rates, rosters: boardRosters() });
    expect(targets.get('p28')?.willingness).toBe('Likely');
    const sam = L.rosters.find((r) => r.label === 'Sam')!.playerIds;
    for (const id of sam) if (targets.has(id)) expect(targets.get(id)!.willingness).not.toBe('Likely');
  });

  it('a player who would sit on your bench is not a target', () => {
    const targets = tradeTargets({ horizon: L.horizon, shape: L.shape, rates: L.rates, rosters: boardRosters() });
    /* Hollis Marchetti, 8.6 a game: below every back you start. */
    expect(targets.has('p23')).toBe(false);
  });

  it('no targets when you have no roster', () => {
    const rosters = boardRosters().map((r) => ({ ...r, isMine: false }));
    expect(tradeTargets({ horizon: L.horizon, shape: L.shape, rates: L.rates, rosters }).size).toBe(0);
  });
});

describe("the card's data", () => {
  it('next four: this week first with its number, byes marked, later weeks marked as Sleeper', () => {
    const cells = nextWeeks({
      weeks: [10, 11, 12, 13, 14],
      byeWeek: 12,
      thisWeek: { points: 14.2, sleeper: false, out: false },
      ahead: new Map([
        [11, 13.04],
        [13, 12.0],
      ]),
    });
    expect(cells).toEqual([
      { week: 10, bye: false, points: 14.2, sleeper: false, out: false },
      { week: 11, bye: false, points: 13, sleeper: true, out: false },
      { week: 12, bye: true, points: null, sleeper: false, out: false },
      { week: 13, bye: false, points: 12, sleeper: true, out: false },
    ]);
  });

  it('a bye this week shows as the bye, not as a number', () => {
    const cells = nextWeeks({ weeks: [10, 11], byeWeek: 10, thisWeek: { points: 9, sleeper: false, out: false }, ahead: new Map() });
    expect(cells[0]).toMatchObject({ week: 10, bye: true, points: null });
  });

  it('last five: the same games the season average counts, with their weeks', () => {
    const points = [12, 0, 7.44, 0, 21, 3, 0, 18.25, 9];
    const played = new Set([1, 2, 3, 5, 6, 8, 9]);
    const games = lastGames({ leaguePoints: points, through: 9, playedWeeks: played });
    expect(games.map((g) => g.week)).toEqual([3, 5, 6, 8, 9]);
    const average = productionGames({ leaguePoints: points, through: 9, playedWeeks: played }).slice(-5);
    expect(games.map((g) => g.points)).toEqual(average.map((v) => Math.round(v * 10) / 10));
  });

  it('a week he did not play (a bye, hurt) is not a zero in his last five', () => {
    const games = lastGames({ leaguePoints: [10, 0, 0, 12], through: 4, playedWeeks: new Set([1, 4]) });
    expect(games).toEqual([
      { week: 1, points: 10 },
      { week: 4, points: 12 },
    ]);
  });

  it('the preview card has this week, four weeks with a bye, and five games', () => {
    const card = previewSeasonCard('p03')!; // Silas Mbeki, bye week 12
    expect(card.next.map((c) => c.week)).toEqual([10, 11, 12, 13]);
    expect(card.next.find((c) => c.week === 12)?.bye).toBe(true);
    expect(card.thisWeek.points).not.toBeNull();
    expect(card.last).toHaveLength(5);
  });

  it('an injured preview player reads Out this week', () => {
    expect(previewSeasonCard('p10')!.thisWeek).toMatchObject({ points: null, out: true });
  });
});

describe('the preview', () => {
  it('uses only the made-up names the earlier previews used', () => {
    const names = new Set(PREVIEW_NAMES);
    for (const row of previewSeasonBoard().rows) expect(names.has(row.name)).toBe(true);
  });

  it('Trade targets list Likely first, then Maybe, then Unlikely', () => {
    const rows = [
      { name: 'a', trade: { willingness: 'Unlikely' as const } },
      { name: 'b', trade: { willingness: 'Likely' as const } },
      { name: 'c', trade: { willingness: 'Maybe' as const } },
      { name: 'd', trade: null },
    ];
    expect([...rows].sort(byWillingness).map((r) => r.name)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('has trade targets with all three willingness words available to show', () => {
    const words = new Set(previewSeasonBoard().rows.flatMap((r) => (r.trade ? [r.trade.willingness] : [])));
    expect(words.has('Likely')).toBe(true);
  });
});

describe('the routes', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = (await createTestDb()) as NodeSqliteDatabase;
    forgetSeasonBoards(db);
  });

  it('on the preview upload, the board and the card read no database at all', async () => {
    const app = createApp();
    const env = { ...envFor(NO_DB, forbiddenSleeper().client), preview: 'players' as const };
    const board = (await (await app(new Request('http://x/api/players/season'), env)).json()) as SeasonBoard;
    expect(board.rows.length).toBeGreaterThan(20);
    const card = (await (await app(new Request('http://x/api/players/p03/season'), env)).json()) as SeasonCard;
    expect(card.next).toHaveLength(4);
  });

  it('live: values, trade targets on other teams, and nothing asked of Sleeper', async () => {
    await seed(db);
    const sleeper = forbiddenSleeper();
    const app = createApp();
    const res = await app(new Request(`http://x/api/players/season?leagueId=${LEAGUE}&cost=1`), envFor(db, sleeper.client));
    expect(res.status).toBe(200);
    const board = (await res.json()) as SeasonBoard & { cost: { rowsReturned: number } };
    expect(board.league?.id).toBe(LEAGUE);
    expect(board.rows.length).toBeGreaterThan(10);
    const mine = board.teams.find((t) => t.isMine)!.rosterId;
    for (const row of board.rows) if (row.trade) expect(row.ownerRosterId).not.toBe(mine);
    expect(board.rows.some((r) => r.value != null)).toBe(true);
    expect(sleeper.calls).toEqual([]);
    expect(board.cost.rowsReturned).toBeGreaterThan(0);
  });

  it('live: a second open with the same rosters is remembered, and reads only the league and rosters', async () => {
    await seed(db);
    const app = createApp();
    const env = envFor(db, forbiddenSleeper().client);
    await app(new Request(`http://x/api/players/season?leagueId=${LEAGUE}`), env);
    const again = (await (await app(new Request(`http://x/api/players/season?leagueId=${LEAGUE}&cost=1`), env)).json()) as { cost: { statements: number; rowsReturned: number } };
    expect(again.cost.statements).toBeLessThanOrEqual(2);
  });

  it('live: the card has this week, the next weeks and the last games', async () => {
    await seed(db);
    const app = createApp();
    const board = (await (await app(new Request(`http://x/api/players/season?leagueId=${LEAGUE}`), envFor(db, forbiddenSleeper().client))).json()) as SeasonBoard;
    const id = board.rows.find((r) => r.value != null)!.id;
    const res = await app(new Request(`http://x/api/players/${id}/season?leagueId=${LEAGUE}`), envFor(db, forbiddenSleeper().client));
    expect(res.status).toBe(200);
    const card = (await res.json()) as SeasonCard;
    expect(card.playerId).toBe(id);
    expect(card.next.length).toBeGreaterThan(0);
    expect(card.next.length).toBeLessThanOrEqual(4);
  });

  it('an unknown player is a 404', async () => {
    await seed(db);
    const res = await createApp()(new Request('http://x/api/players/nobody/season'), envFor(db, forbiddenSleeper().client));
    expect(res.status).toBe(404);
  });
});

describe('the switch', () => {
  it('is off unless the site says on, so today’s tab is drawn', async () => {
    const app = createApp();
    const off = (await (await app(new Request('http://x/api/auth/status'), envFor(NO_DB, forbiddenSleeper().client))).json()) as { features: { playersInSeason?: boolean } };
    expect(off.features.playersInSeason).toBeUndefined();
    const on = (await (await app(new Request('http://x/api/auth/status'), { ...envFor(NO_DB, forbiddenSleeper().client), playersInSeason: true })).json()) as { features: { playersInSeason: boolean } };
    expect(on.features.playersInSeason).toBe(true);
  });

});

describe('the switch on the live site and on the preview', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

  it('is on on the live site since Alex said go, one line to set back to off', () => {
    expect(read('wrangler.toml')).toMatch(/^PLAYERS_INSEASON = "on"$/m);
    expect(read('wrangler.toml')).not.toMatch(/^PREVIEW = /m);
  });

  it('the preview turns it on, on the made-up league, and leaves every other switch as the live site has it', () => {
    const workflow = read('.github/workflows/preview.yml');
    expect(workflow).toContain("if: ${{ inputs.mode == 'players' }}");
    expect(workflow).toContain('PLAYERS_INSEASON = \\"on\\"\\nPREVIEW = \\"players\\"');
    /* Only the Players line is rewritten in players mode; TRADES_SCREENS stays "new" from wrangler.toml. */
    expect(read('wrangler.toml')).toMatch(/^TRADES_SCREENS = "new"$/m);
  });
});
