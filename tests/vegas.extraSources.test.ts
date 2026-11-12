/**
 * Round 23 steps 3 and 4: TheRundown and The Odds API feed the per-book average,
 * through the same Vegas refresh, and only when their keys are set.
 */

import { describe, expect, it } from 'vitest';
import {
  OddsApiExtraSource,
  TheRundownSource,
  canonicalBook,
  oddsApiQuotes,
  rundownGame,
} from '../src/core/vegas/extraSources.ts';
import {
  EXTRA_SOURCES_KEY,
  ExtraOddsSources,
  easternDate,
  extraSourcesOf,
  matchGame,
  type ExtraState,
} from '../src/server/services/extraOddsSources.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import { createTestDb } from './helpers/db.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-11-14T17:00:00.000Z'); // Saturday noon ET
const KICKOFF = '2026-11-15T18:00:00.000Z'; // Sunday 1pm ET, 25h out
const FRIDAY_10AM = Date.parse('2026-11-13T15:00:00.000Z');

/** A fetch that answers from a function and counts every call. */
function fakeFetch(answer: (url: string) => unknown, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fn, calls };
}

const RUNDOWN_EVENT = {
  event_id: 'rd-1',
  event_date: KICKOFF,
  teams_normalized: [
    { abbreviation: 'LAC', name: 'Los Angeles', mascot: 'Chargers', is_home: true, is_away: false },
    { abbreviation: 'BAL', name: 'Baltimore', mascot: 'Ravens', is_home: false, is_away: true },
  ],
  lines: {
    '19': { affiliate: { affiliate_name: 'DraftKings' }, spread: { point_spread_home: -4.5 }, total: { total_over: 39.5 } },
    '22': { affiliate: { affiliate_name: 'BetMGM' }, spread: { point_spread_home: -4 }, total: { total_over: 39 } },
    '23': { affiliate: { affiliate_name: 'FanDuel' }, spread: { point_spread_home: 0.0001 }, total: { total_over: 0.0001 } },
  },
};

const ODDS_API_SLATE = [
  {
    id: 'oa-1',
    commence_time: KICKOFF,
    home_team: 'Los Angeles Chargers',
    away_team: 'Baltimore Ravens',
    bookmakers: [
      {
        key: 'williamhill_us',
        markets: [
          { key: 'totals', outcomes: [{ name: 'Over', point: 40, price: -110 }, { name: 'Under', point: 40, price: -110 }] },
          { key: 'spreads', outcomes: [{ name: 'Los Angeles Chargers', point: -4.5, price: -110 }, { name: 'Baltimore Ravens', point: 4.5, price: -110 }] },
        ],
      },
    ],
  },
];

async function world() {
  const db = await createTestDb();
  await new VegasEventsRepo(db).upsertMany([
    { eventId: 'sgo-1', provider: 'sportsgameodds', kickoff: KICKOFF, homeTeam: 'LAC', awayTeam: null, total: 38.5, spread: -4.5, spreadTeam: 'LAC' },
  ]);
  return db;
}

describe('no key, no calls', () => {
  it('a source without a key is not configured and the provider carries no extras', () => {
    const provider = Object.assign(new MockVegasProvider([]), {
      extraSources: { rundown: new TheRundownSource({ apiKey: '' }), oddsApi: new OddsApiExtraSource({ apiKey: undefined }) },
    });
    expect(extraSourcesOf(provider)).toBeNull();
    expect(extraSourcesOf(new MockVegasProvider([]))).toBeNull();
  });

  it('asks nothing and writes nothing when neither key is set', async () => {
    const db = await world();
    const { fn, calls } = fakeFetch(() => ({}));
    const run = await new ExtraOddsSources(db, {
      rundown: new TheRundownSource({ apiKey: null, fetch: fn }),
      oddsApi: new OddsApiExtraSource({ apiKey: null, fetch: fn }),
    }).runIfDue(NOW);
    expect(calls).toEqual([]);
    expect(run).toEqual({ ran: [], notes: [], nextDue: null });
    expect(await new SettingsRepo(db).get(EXTRA_SOURCES_KEY, null)).toBeNull();
  });

  it('a failing source is noted, not thrown', async () => {
    const db = await world();
    const run = await new ExtraOddsSources(db, {
      rundown: new TheRundownSource({ apiKey: 'k', fetch: async () => new Response('nope', { status: 401 }) }),
    }).runIfDue(NOW);
    expect(run.ran).toEqual([]);
    expect(run.notes[0]).toContain('HTTP 401');
    expect(run.notes.join(' ')).not.toContain('k&');
  });
});

describe('reading TheRundown', () => {
  it('names both sides, reads each book, and treats 0.0001 as no line', () => {
    const game = rundownGame(RUNDOWN_EVENT, '2026-11-14T17:00:00.000Z')!;
    expect(game.teams).toEqual(['LAC', 'BAL']);
    expect(game.books.map((b) => `${b.book}:${b.total}:${b.spread}:${b.spreadTeam}`)).toEqual(['draftkings:39.5:-4.5:LAC', 'betmgm:39:-4:LAC']);
  });

  it('finds the away side when only is_home is sent, and the Raiders by name when the code is LAS', () => {
    // As TheRundown answered on Nov 12: no is_away field, and "LAS" for Las Vegas.
    const game = rundownGame(
      {
        ...RUNDOWN_EVENT,
        teams_normalized: [
          { abbreviation: 'SEA', name: 'Seattle', mascot: 'Seahawks', is_home: false },
          { abbreviation: 'LAS', name: 'Las Vegas', mascot: 'Raiders', is_home: true },
        ],
      },
      '2026-11-14T17:00:00.000Z',
    )!;
    expect(game.teams).toEqual(['LV', 'SEA']);
    expect(game.books[0]!.spreadTeam).toBe('LV');
  });

  it('sends the key in a header, one request per date', async () => {
    const { fn, calls } = fakeFetch(() => ({ events: [RUNDOWN_EVENT] }));
    let header: string | null = null;
    const source = new TheRundownSource({
      apiKey: 'secret',
      fetch: async (url, init) => {
        header = new Headers(init?.headers).get('X-TheRundown-Key');
        return fn(url);
      },
    });
    const answer = await source.gameLines([{ date: '2026-11-15', offsetMinutes: 300 }]);
    expect(answer.value).toHaveLength(1);
    expect(calls[0]).toContain('/sports/2/events/2026-11-15?offset=300');
    expect(calls[0]).not.toContain('secret');
    expect(header).toBe('secret');
  });
});

describe('reading The Odds API', () => {
  it('reads totals, the home side\'s spread, and folds William Hill into Caesars', async () => {
    const { fn } = fakeFetch(() => ODDS_API_SLATE, { 'x-requests-last': '2', 'x-requests-remaining': '480' });
    const answer = await new OddsApiExtraSource({ apiKey: 'k', fetch: fn }).gameLines();
    expect(answer).toMatchObject({ cost: 2, remaining: 480 });
    expect(answer.value[0]).toMatchObject({ teams: ['LAC', 'BAL'], sourceId: 'oa-1' });
    expect(answer.value[0]!.books[0]).toMatchObject({ book: 'caesars', total: 40, spread: -4.5, spreadTeam: 'LAC' });
  });

  it('reads player props: the over side, and anytime touchdown as Yes', () => {
    const quotes = oddsApiQuotes({
      bookmakers: [
        {
          key: 'draftkings',
          markets: [
            { key: 'player_reception_yds', outcomes: [{ name: 'Over', description: 'Ladd McConkey', point: 55.5, price: -115 }, { name: 'Under', description: 'Ladd McConkey', point: 55.5, price: -105 }] },
            { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Ladd McConkey', price: 240 }] },
          ],
        },
      ],
    });
    expect(quotes).toEqual([
      { playerName: 'Ladd McConkey', market: 'receiving_yards', line: 55.5, overPrice: -115, underPrice: null, book: 'draftkings' },
      { playerName: 'Ladd McConkey', market: 'anytime_td', line: 0.5, overPrice: 240, underPrice: null, book: 'draftkings' },
    ]);
    expect(canonicalBook('William Hill US')).toBe('caesars');
  });
});

describe('feeding the average', () => {
  it('matches a game by side and kickoff, and moves the game line to the combined number', async () => {
    const db = await world();
    const { fn } = fakeFetch(() => ({ events: [RUNDOWN_EVENT] }));
    const run = await new ExtraOddsSources(db, { rundown: new TheRundownSource({ apiKey: 'k', fetch: fn }) }).runIfDue(NOW);
    expect(run.ran).toEqual(['therundown']);
    const row = (await new VegasEventsRepo(db).forEvents(['sgo-1'])).get('sgo-1')!;
    // DraftKings 39.5 and BetMGM 39: two books inside the band, averaged.
    expect(row.total).toBe(39.3);
    expect(row.spreadTeam).toBe('LAC');
    expect(row.spread).toBe(-4.3);
  });

  it('does not create a game nobody tracks', async () => {
    const db = await createTestDb();
    const { fn } = fakeFetch(() => ({ events: [RUNDOWN_EVENT] }));
    await new ExtraOddsSources(db, { rundown: new TheRundownSource({ apiKey: 'k', fetch: fn }) }).runIfDue(NOW);
    expect((await new VegasEventsRepo(db).between('2026-11-01', '2026-12-01')).length).toBe(0);
  });

  it('is skipped inside its interval: hourly with a game inside 48 hours, every 3 hours otherwise', async () => {
    const db = await world();
    const { fn, calls } = fakeFetch(() => ({ events: [RUNDOWN_EVENT] }));
    const extras = new ExtraOddsSources(db, { rundown: new TheRundownSource({ apiKey: 'k', fetch: fn }) });
    const first = await extras.runIfDue(NOW);
    expect(first.nextDue).toBe(NOW + H);
    await extras.runIfDue(NOW + 30 * 60_000);
    expect(calls).toHaveLength(1);
    await extras.runIfDue(NOW + H);
    expect(calls).toHaveLength(2);
  });

  it('matches only within six hours of kickoff and on a shared side', () => {
    const row = { eventId: 'e', provider: 'p', kickoff: KICKOFF, homeTeam: 'BAL', awayTeam: null, seenAt: '' };
    const game = { teams: ['LAC', 'BAL'] as [string, string], kickoff: KICKOFF, books: [] };
    expect(matchGame(game, [row])?.eventId).toBe('e');
    expect(matchGame({ ...game, kickoff: new Date(Date.parse(KICKOFF) + 7 * H).toISOString() }, [row])).toBeNull();
    expect(matchGame({ ...game, teams: ['KC', 'DEN'] }, [row])).toBeNull();
  });
});

describe('The Odds API\'s Friday props fill', () => {
  it('runs once on Friday from 9 AM ET, stores lines through the average, and does not count as SportsGameOdds buying the game', async () => {
    const db = await world();
    const { fn, calls } = fakeFetch(
      (url) =>
        url.includes('/events/oa-1/odds')
          ? {
              id: 'oa-1',
              bookmakers: [
                { key: 'draftkings', markets: [{ key: 'player_reception_yds', outcomes: [{ name: 'Over', description: 'Ladd McConkey', point: 55.5, price: -115 }] }] },
                { key: 'fanduel', markets: [{ key: 'player_reception_yds', outcomes: [{ name: 'Over', description: 'Ladd McConkey', point: 54.5, price: -110 }] }] },
              ],
            }
          : ODDS_API_SLATE,
      { 'x-requests-last': '2', 'x-requests-remaining': '400' },
    );
    const extras = new ExtraOddsSources(db, { oddsApi: new OddsApiExtraSource({ apiKey: 'k', fetch: fn }) });
    expect(easternDate(FRIDAY_10AM)).toMatchObject({ weekday: 'Fri', hour: 10, offsetMinutes: 300 });

    const run = await extras.runIfDue(FRIDAY_10AM);
    expect(run.ran).toEqual(['the-odds-api']);
    expect(calls.filter((u) => u.includes('/events/oa-1/odds'))).toHaveLength(1);

    const lines = await new PropsRepo(db).currentForEvent('sgo-1');
    expect(lines.find((l) => l.market === 'receiving_yards')).toMatchObject({ line: 55, bookCount: 2 });
    // The clock and the refresh button still see the game as never bought by SportsGameOdds.
    expect((await new PropsRepo(db).newestFetchByEvent(['sgo-1'])).size).toBe(0);
    expect(await new PropsRepo(db).get('sgo-1')).toBeNull();

    // Not again the same Friday, even after the 8-hour line interval.
    await extras.runIfDue(FRIDAY_10AM + 9 * H);
    expect(calls.filter((u) => u.includes('/events/oa-1/odds'))).toHaveLength(1);
    const state = await new SettingsRepo(db).get<ExtraState>(EXTRA_SOURCES_KEY, {});
    expect(state.oddsApi?.propsWeek).toBe('2026-11-13');
  });

  it('keeps a reserve of credits back', async () => {
    const db = await world();
    await new SettingsRepo(db).set(EXTRA_SOURCES_KEY, { oddsApi: { remaining: 50 } });
    const { fn, calls } = fakeFetch(() => ODDS_API_SLATE);
    await new ExtraOddsSources(db, { oddsApi: new OddsApiExtraSource({ apiKey: 'k', fetch: fn }) }).runIfDue(FRIDAY_10AM);
    expect(calls).toEqual([]);
  });
});
