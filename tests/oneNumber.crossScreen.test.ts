/**
 * One number per player, the same everywhere (Round 31).
 *
 * The Round 29 audit (finding 7) found the core number matched to the cent on
 * Team, Compare, the Players card and the Waivers check, and every other place
 * printed its own: the card behind a row (up to 1.1 points off), Matchup's card
 * following Sleeper's lineup ("Start at QB" for the QB Team benches), the
 * Players card rounding the other way, and one trade reading "Close: small gain
 * for them" on its offer card and "Good for you" in Check.
 *
 * This reads twenty players through every screen's own endpoint and the same
 * client helpers the screens draw with, and fails if any two screens print a
 * different number, or a different pick or verdict, for the same player and week.
 * It runs in CI with every other unit test (`npm test`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { rowFigure } from '../src/web/rowFigure.ts';
import { weekPointsBeforeStatus, weekPointsOf } from '../src/core/startsit/weekPoints.ts';
import { weeklyContextFor } from '../src/core/startsit/sleeperLineup.ts';
import { teamCardFor, teamVerdicts, teamWeeklyCard } from '../src/web/teamCard.ts';
import type { ScreensOffers, ScreensVerdict } from '../src/core/trades/screensWire.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper, seed, LEAGUE, MINE } from './helpers/tradeLeague.ts';
import {
  BACKUP_QB,
  DOUBTFUL,
  DOUBTFUL_STAR,
  IR_PLAYER,
  NUDGED,
  SLEEPER_ONLY,
  SOURCES_SPLIT,
  readEveryScreen,
  type CrossScreen,
} from './helpers/crossScreen.ts';

type Json = Record<string, any>;

/** Alex's fifteen, and five free agents Compare, Waivers and Players all show. */
const MINE_IDS = [...MINE.map((p) => p[0]), SLEEPER_ONLY, DOUBTFUL_STAR, BACKUP_QB, IR_PLAYER];
const FREE_IDS = ['f_qb0', 'f_wr0', 'f_wr1', 'f_rb0', 'f_te0'];
const TWENTY = [...MINE_IDS, ...FREE_IDS];

/** What a screen prints for the week: the tenth Alex reads, or Out, or a dash. */
type Printed = string;
const tenth = (points: number | null | undefined): Printed => (points == null ? '-' : points.toFixed(1));

let s: CrossScreen;
let poolMine: Json;
let poolWaivers: Json;
let compareAll: Json[];
let playersCards: Map<string, Json>;

beforeAll(async () => {
  s = await readEveryScreen({ wide: true });
  poolMine = await s.get(`/api/leagues/${LEAGUE}/compare-pool?tab=mine&position=ALL&q=`);
  poolWaivers = await s.get(`/api/leagues/${LEAGUE}/compare-pool?tab=waivers&position=ALL&q=`);
  /* Compare takes at most a few players at a time, as the sheet sends them. */
  compareAll = [];
  for (let i = 0; i < TWENTY.length; i += 4) compareAll.push(await s.compareOf(TWENTY.slice(i, i + 4)));
  playersCards = new Map();
  for (const id of TWENTY) playersCards.set(id, await s.get(`/api/players/${id}/season?leagueId=${LEAGUE}`));
}, 120_000);

const teamEvaluation = (id: string): Json | undefined =>
  [...s.lineup.starters, ...s.lineup.bench, ...s.lineup.undecidable].find((e: Json) => e.playerId === id);

/** Every place the week's number for this player is printed, by screen. */
function printed(id: string): Record<string, Printed> {
  const out: Record<string, Printed> = {};
  /* Team row (`rowFigure`), and the card it opens. */
  const e = teamEvaluation(id);
  if (e) {
    const f = rowFigure(weekPointsBeforeStatus(e as never), e as never);
    out['Team row'] = f.kind === 'out' ? 'Out' : f.kind === 'none' ? '-' : tenth(f.points);
    const card = teamWeeklyCard(e as never, weeklyContextFor(teamVerdicts(s.roster as never, s.lineup as never), id))!;
    out['Team card'] = card.headline.verdict === 'not_playable' ? 'Out' : tenth(card.score);
  }
  /* Matchup row, and the card Matchup opens (Team's card for Alex's players, its own otherwise). */
  const m = [...s.matchup.forecast.slots.flatMap((r: Json) => [r.mine, r.theirs]), ...s.matchup.forecast.bench.mine]
    .filter(Boolean)
    .find((p: Json) => p.playerId === id);
  if (m) {
    out['Matchup row'] = m.statusFlag === 'OUT' ? 'Out' : tenth(m.projectedFinal);
    const card = teamCardFor(s.roster as never, s.lineup as never, id) ?? s.matchup.cards[id];
    if (card) out['Matchup card'] = card.headline.verdict === 'not_playable' ? 'Out' : tenth(card.score);
  }
  /* Compare: the picker row and the comparison card. */
  const row = [...(poolMine.rows ?? []), ...(poolWaivers.rows ?? [])].find((r: Json) => r.id === id);
  if (row) out['Compare list'] = row.week.out ? 'Out' : tenth(row.week.points);
  const c = compareAll.flatMap((x) => x.evaluations ?? []).find((x: Json) => x.playerId === id);
  if (c) {
    const w = weekPointsOf(c);
    out['Compare card'] = w.out ? 'Out' : tenth(w.points);
  }
  /* Waivers, this week's cell. */
  const week = s.waivers.tiers?.weekFigures?.[id]?.weeks?.[0];
  if (week && !week.bye) out['Waivers'] = week.out ? 'Out' : tenth(week.points);
  /* Players card. */
  const p = playersCards.get(id)?.thisWeek;
  if (p) out['Players card'] = p.out ? 'Out' : tenth(p.points);
  return out;
}

describe('twenty players, one number each, on every screen that prints one', () => {
  it('covers twenty players, each on at least three screens', () => {
    expect(TWENTY).toHaveLength(20);
    for (const id of TWENTY) expect(Object.keys(printed(id)).length, id).toBeGreaterThanOrEqual(3);
  });

  for (const id of TWENTY) {
    it(`${id} reads the same everywhere`, () => {
      const seen = printed(id);
      const values = new Set(Object.values(seen));
      expect(values.size, `${id}: ${JSON.stringify(seen)}`).toBe(1);
    });
  }

  it('the card behind a row prints the row\'s number, nudges included (audit A1)', () => {
    const seen = printed(NUDGED);
    expect(Number(seen['Team row'])).toBeGreaterThan(15);
    expect(seen['Team card']).toBe(seen['Team row']);
    expect(seen['Matchup card']).toBe(seen['Team row']);
  });

  it('a Questionable player in the IR slot reads Out on every screen', () => {
    const seen = printed(IR_PLAYER);
    expect(Object.keys(seen)).toEqual(expect.arrayContaining(['Team row', 'Matchup row', 'Compare list', 'Compare card', 'Players card']));
    for (const [screen, value] of Object.entries(seen)) expect(value, screen).toBe('Out');
  });

  it('Doubtful and an injury-report Out read Out everywhere', () => {
    for (const id of [DOUBTFUL, DOUBTFUL_STAR, SOURCES_SPLIT]) {
      for (const [screen, value] of Object.entries(printed(id))) expect(value, `${id} ${screen}`).toBe('Out');
    }
  });

  it('the Players card keeps the cent, so its tenth is Team\'s (audit A5)', () => {
    for (const id of TWENTY) {
      const p = playersCards.get(id)?.thisWeek?.points;
      if (p == null) continue;
      expect(Math.round(p * 100) / 100, id).toBe(p);
      const c = compareAll.flatMap((x) => x.evaluations ?? []).find((x: Json) => x.playerId === id);
      if (c && !weekPointsOf(c).out) expect(p, id).toBe(weekPointsOf(c).points);
    }
  });
});

describe('one pick per player: Team rows, Team card and Matchup card agree', () => {
  /**
   * What Team says to do with him: start, bench, or ruled out. The optimiser's
   * lineup, except a toss-up, where Team keeps the man Sleeper already starts
   * (and only leans).
   */
  const appPick = (id: string): string => {
    const e = teamEvaluation(id);
    if (e?.ruledOut) return 'not_playable';
    const tossUps: Json[] = s.lineup.tossUps ?? [];
    if (tossUps.some((t) => t.outPlayerId === id)) return 'start';
    if (tossUps.some((t) => t.inPlayerId === id)) return 'bench';
    return (s.lineup.slots ?? []).some((slot: Json) => slot.playerId === id) ? 'start' : 'bench';
  };

  for (const id of MINE_IDS) {
    it(`${id}: the card says what Team's lineup says`, () => {
      const team = teamWeeklyCard(teamEvaluation(id) as never, weeklyContextFor(teamVerdicts(s.roster as never, s.lineup as never), id));
      const matchup = teamCardFor(s.roster as never, s.lineup as never, id);
      if (!team) return;
      expect(team.headline.verdict, id).toBe(appPick(id));
      expect(matchup?.headline.verdict, id).toBe(team.headline.verdict);
      expect(matchup?.headline.label, id).toBe(team.headline.label);
    });
  }

  it('the QB Sleeper starts and Team benches no longer reads "Start at QB" on Matchup (audit A1)', () => {
    /* Sleeper's lineup, which Matchup's rows show: the backup is in the QB slot. */
    const qbRow = s.matchup.forecast.slots.find((r: Json) => r.slot === 'QB');
    expect(qbRow.mine.playerId).toBe(BACKUP_QB);
    /* The app starts m_qb: the backup's card says bench, the starter's says start, not yet set in Sleeper. */
    expect(appPick(BACKUP_QB)).toBe('bench');
    const backup = teamCardFor(s.roster as never, s.lineup as never, BACKUP_QB)!;
    expect(backup.headline.verdict).toBe('bench');
    const starter = teamCardFor(s.roster as never, s.lineup as never, 'm_qb')!;
    expect(starter.headline.label).toBe('Start at QB');
    expect(starter.headline.detail).toBe('Not in your Sleeper lineup yet.');
  });
});

describe('one verdict and one gain per trade: offer card and Check (audit A4)', () => {
  const check = async (app: ReturnType<typeof createApp>, env: AppEnv, offer: ScreensOffers['offers'][number], query = '') =>
    (await (
      await app(
        new Request(
          `http://x/api/trades/screens/verdict?b=${offer.partner.rosterId}&give=${offer.give.map((p) => p.playerId).join(',')}` +
            `&get=${offer.get.map((p) => p.playerId).join(',')}${query}`,
        ),
        env,
      )
    ).json()) as ScreensVerdict;

  const expectSame = (offer: ScreensOffers['offers'][number], verdict: ScreensVerdict) => {
    const summary = verdict.found ? verdict.summary : null;
    expect(summary, offer.id).not.toBeNull();
    expect(offer.label, offer.id).toBe(summary!.word);
    expect(offer.you.thisWeek, offer.id).toBe(summary!.you.thisWeek);
    expect(offer.you.restOfSeason, offer.id).toBe(summary!.you.restOfSeason);
    expect(offer.them.restOfSeason, offer.id).toBe(summary!.them.restOfSeason);
  };

  it('every offer in a normal and a quiet week reads what Check reads for the same deal', async () => {
    const app = createApp();
    const env: AppEnv = { ...envFor(await createTestDb(), forbiddenSleeper().client), preview: 'trades', tradesScreens: 'new' };
    let seen = 0;
    for (const query of ['', '&week=quiet']) {
      const offers = (await (await app(new Request(`http://x/api/trades/screens/offers?${query.slice(1)}`), env)).json()) as ScreensOffers;
      for (const offer of offers.offers) {
        expectSame(offer, await check(app, env, offer, query));
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('in a seeded league, the offer, Check and the Players board agree on the deal and on each player\'s value', async () => {
    const db = await createTestDb();
    await seed(db, { fairDeal: true });
    const app = createApp();
    const env = envFor(db, forbiddenSleeper().client);
    const offers = (await (await app(new Request('http://x/api/trades/screens/offers'), env)).json()) as ScreensOffers;
    expect(offers.offers.length).toBeGreaterThan(0);
    const board = (await (await app(new Request(`http://x/api/players/season?leagueId=${LEAGUE}`), env)).json()) as { rows: Json[] };
    for (const offer of offers.offers) {
      const verdict = await check(app, env, offer);
      expectSame(offer, verdict);
      for (const p of [...offer.give, ...offer.get]) {
        const row = board.rows.find((r) => r.id === p.playerId);
        expect(row?.overFreeAgent, p.playerId).toBe(p.value);
      }
    }
  });
});
