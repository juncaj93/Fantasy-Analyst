/**
 * Round 23 step 2: average by sportsbook, write only what changed.
 *
 * The averaging rules come from the Round 21 research (docs/vegas/ROUND21_SOURCES.md,
 * section 6) and Alex's decision ("more data the better, just average it"). Every
 * case the brief lists is here: stale, outlier, one, two and three books, no book.
 * Then the write-on-change half: a look that changes nothing writes no line, and a
 * reader still sees every line, spread over the looks that wrote them.
 */

import { describe, expect, it } from 'vitest';
import {
  combineBookValues,
  combineGameLines,
  freshWindowMinutes,
  outlierBand,
  type BookValue,
} from '../src/core/vegas/combine.ts';
import { combineLook, type StoredLine } from '../src/core/vegas/combineProps.ts';
import { PlayerIndex } from '../src/core/identity/index.ts';
import { SportsGameOddsProvider } from '../src/core/vegas/sportsGameOddsProvider.ts';
import type { RawPropQuote } from '../src/core/vegas/types.ts';
import { PropsRepo, eligibleSnapshots } from '../src/server/repos/props.ts';
import { gameLinesDiffer, mergeGameBooks } from '../src/server/repos/gameBooks.ts';
import { createTestDb } from './helpers/db.ts';

const H = 3_600_000;
const M = 60_000;
const NOW = Date.parse('2026-11-14T18:00:00.000Z'); // Saturday 1pm ET
const SUNDAY = '2026-11-15T18:00:00.000Z'; // kickoff 24h out
const iso = (ms: number) => new Date(ms).toISOString();
const book = (name: string, value: number, agoMinutes = 0): BookValue => ({ book: name, value, at: iso(NOW - agoMinutes * M) });
const opts = { now: NOW, kickoff: SUNDAY };

describe('averaging by book', () => {
  it('no book: no number (the minus-1 rule takes over downstream, unchanged)', () => {
    const c = combineBookValues([], 'yards', opts);
    expect(c.value).toBeNull();
    expect(c.method).toBe('none');
  });

  it('one fresh book is used as is', () => {
    const c = combineBookValues([book('draftkings', 64.5)], 'yards', opts);
    expect(c).toMatchObject({ value: 64.5, method: 'single' });
  });

  it('two books inside the band are averaged', () => {
    const c = combineBookValues([book('draftkings', 64.5), book('fanduel', 61.5)], 'yards', opts);
    expect(c).toMatchObject({ value: 63, method: 'average' });
  });

  it('two books far apart: the newest is used', () => {
    const c = combineBookValues([book('draftkings', 64.5, 30), book('fanduel', 40.5, 5)], 'yards', opts);
    expect(c).toMatchObject({ value: 40.5, method: 'newest' });
  });

  it('three books: one too far from the median is dropped, the rest averaged', () => {
    const c = combineBookValues([book('draftkings', 47.5), book('fanduel', 47.5), book('caesars', 52.5)], 'total', opts);
    expect(c.value).toBe(47.5);
    expect(c.kept.map((b) => b.book).sort()).toEqual(['draftkings', 'fanduel']);
  });

  it('three books close together are all averaged (one decimal)', () => {
    const c = combineBookValues([book('a', 4.5), book('b', 5.5), book('c', 4.5)], 'receptions', opts);
    expect(c).toMatchObject({ value: 4.8, method: 'average' });
    expect(c.kept).toHaveLength(3);
  });

  it('a stale book is ignored: 12 hours when the game is over 24 hours out', () => {
    const far = { now: NOW, kickoff: iso(NOW + 48 * H) };
    expect(combineBookValues([book('dk', 60, 11 * 60)], 'yards', far).value).toBe(60);
    expect(combineBookValues([book('dk', 60, 13 * 60)], 'yards', far).value).toBeNull();
  });

  it('3 hours when 2 to 24 hours out, 45 minutes under 2 hours', () => {
    expect(freshWindowMinutes(30)).toBe(720);
    expect(freshWindowMinutes(10)).toBe(180);
    expect(freshWindowMinutes(1)).toBe(45);
    const close = { now: NOW, kickoff: iso(NOW + 1 * H) };
    expect(combineBookValues([book('dk', 60, 40)], 'yards', close).value).toBe(60);
    expect(combineBookValues([book('dk', 60, 50)], 'yards', close).value).toBeNull();
  });

  it('a stale book does not outvote fresh ones', () => {
    const c = combineBookValues([book('dk', 70, 4 * 60), book('fd', 60), book('cz', 61)], 'yards', opts);
    expect(c.value).toBe(60.5);
  });

  it('the same book twice is one vote, the newest', () => {
    const c = combineBookValues([book('DraftKings', 50, 60), book('draftkings', 55, 1)], 'yards', opts);
    expect(c).toMatchObject({ value: 55, method: 'single' });
  });

  it('uses the Round 21 bands', () => {
    expect(outlierBand('total', 45)).toBe(3);
    expect(outlierBand('spread', -3)).toBe(2.5);
    expect(outlierBand('yards', 40)).toBe(10);
    expect(outlierBand('yards', 280)).toBe(42);
    expect(outlierBand('receptions', 5)).toBe(1);
    expect(outlierBand('td_line', 1.5)).toBe(0.5);
    expect(outlierBand('anytime_td', 0.4)).toBe(0.15);
  });
});

describe('game lines', () => {
  it('turns every spread to one side before averaging, and team points come from the combined pair', () => {
    const at = iso(NOW);
    const c = combineGameLines(
      [
        { book: 'draftkings', total: 38.5, spread: -4.5, spreadTeam: 'LAC', at },
        { book: 'betmgm', total: 38.5, spread: 4, spreadTeam: 'BAL', at },
        { book: 'fanduel', total: 39.5, spread: -4.5, spreadTeam: 'LAC', at },
      ],
      ['LAC', 'BAL'],
      { ...opts, prefer: 'LAC' },
    );
    expect(c).toMatchObject({ total: 38.8, spread: -4.3, spreadTeam: 'LAC', totalBooks: 3, spreadBooks: 3 });
  });

  it('drops a spread whose team is neither side rather than guessing its sign', () => {
    const at = iso(NOW);
    const c = combineGameLines([{ book: 'x', total: null, spread: -3, spreadTeam: 'KC', at }], ['LAC', 'BAL'], opts);
    expect(c.spread).toBeNull();
  });

  it('is unchanged when only the side it is read from differs', () => {
    expect(gameLinesDiffer({ total: 38.5, spread: 4.5, spreadTeam: 'BAL' } as never, { total: 38.5, spread: -4.5, spreadTeam: 'LAC', totalBooks: 3, spreadBooks: 3 })).toBe(false);
    expect(gameLinesDiffer({ total: 38.5, spread: 4.5, spreadTeam: 'BAL' } as never, { total: 39, spread: -4.5, spreadTeam: 'LAC', totalBooks: 3, spreadBooks: 3 })).toBe(true);
  });

  it('keeps a book\'s newer quote and the other books\' older ones', () => {
    const entry = mergeGameBooks(
      { kickoff: SUNDAY, teams: ['LAC', 'BAL'], books: [{ book: 'draftkings', total: 38.5, spread: -4.5, spreadTeam: 'LAC', at: iso(NOW - H) }] },
      [{ book: 'DraftKings', total: 39.5, spread: -4.5, spreadTeam: 'LAC', at: iso(NOW) }, { book: 'betmgm', total: 39, spread: null, spreadTeam: null, at: iso(NOW) }],
    );
    expect(entry.books).toHaveLength(2);
    expect(entry.books.find((b) => b.book.toLowerCase() === 'draftkings')?.total).toBe(39.5);
  });
});

// ------------------------------------------------------------ one look

const EMPTY = new PlayerIndex([]);
const q = (playerName: string, market: RawPropQuote['market'], line: number | null, price: number | null, bookName: string): RawPropQuote => ({
  playerName,
  market,
  line,
  overPrice: price,
  underPrice: null,
  book: bookName,
});
const asStored = (lines: ReturnType<typeof combineLook>['current']): StoredLine[] => lines.map((l) => ({ ...l, gone: false }));

describe('one look, written only where it changed', () => {
  const first = [
    q('Ladd McConkey', 'receiving_yards', 54.5, -115, 'draftkings'),
    q('Ladd McConkey', 'receiving_yards', 55.5, -110, 'fanduel'),
    q('Ladd McConkey', 'receiving_yards', 54.5, -110, 'caesars'),
    q('Ladd McConkey', 'receptions', 4.5, -120, 'draftkings'),
    q('Ladd McConkey', 'receptions', 4.5, -110, 'fanduel'),
  ];

  it('writes every line the first time', () => {
    const look = combineLook(first, [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sportsgameodds' });
    expect(look.changed).toHaveLength(2);
    expect(look.current.find((l) => l.market === 'receiving_yards')).toMatchObject({ line: 54.8, bookCount: 3, consensusMethod: 'average' });
  });

  it('writes nothing when the same numbers come back an hour later (only prices moved)', () => {
    const one = combineLook(first, [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sportsgameodds' });
    const again = first.map((x) => ({ ...x, overPrice: (x.overPrice ?? 0) - 5 }));
    const two = combineLook(again, asStored(one.current), EMPTY, { now: NOW + H, kickoff: SUNDAY, source: 'sportsgameodds' });
    expect(two.changed).toEqual([]);
    expect(two.current).toHaveLength(2);
  });

  it('writes only the line that moved', () => {
    const one = combineLook(first, [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sportsgameodds' });
    const moved = first.map((x) => (x.market === 'receptions' && x.book === 'fanduel' ? { ...x, line: 5.5 } : x));
    const two = combineLook(moved, asStored(one.current), EMPTY, { now: NOW + H, kickoff: SUNDAY, source: 'sportsgameodds' });
    expect(two.changed.map((c) => c.market)).toEqual(['receptions']);
    expect(two.changed[0]!.line).toBe(5);
  });

  it('keeps a book that skipped one look until it is too old, then marks a line gone everywhere', () => {
    const one = combineLook(first, [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sportsgameodds' });
    // The next look has no McConkey lines at all, inside the 3-hour window: nothing changes.
    const soon = combineLook([], asStored(one.current), EMPTY, { now: NOW + 2 * H, kickoff: SUNDAY, source: 'sportsgameodds' });
    expect(soon.changed).toEqual([]);
    // Past it: the lines are gone and a marker is written for each.
    const later = combineLook([], asStored(one.current), EMPTY, { now: NOW + 4 * H, kickoff: SUNDAY, source: 'sportsgameodds' });
    expect(later.changed.map((c) => c.consensusMethod)).toEqual(['none', 'none']);
    expect(later.current).toEqual([]);
  });

  it('writes a touchdown chance only when it moves half a point or more', () => {
    const td = (price: number) => [q('Ladd McConkey', 'anytime_td', 0.5, price, 'draftkings'), q('Ladd McConkey', 'anytime_td', 0.5, price, 'fanduel')];
    const one = combineLook(td(200), [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sgo' });
    expect(combineLook(td(202), asStored(one.current), EMPTY, { now: NOW + H, kickoff: SUNDAY, source: 'sgo' }).changed).toEqual([]);
    expect(combineLook(td(170), asStored(one.current), EMPTY, { now: NOW + H, kickoff: SUNDAY, source: 'sgo' }).changed).toHaveLength(1);
  });

  it('writes when the line goes from one book to several (the single-book penalty reads that)', () => {
    const one = combineLook([q('A B', 'rush_yards', 50.5, -110, 'draftkings')], [], EMPTY, { now: NOW, kickoff: SUNDAY, source: 'sgo' });
    const two = combineLook(
      [q('A B', 'rush_yards', 50.5, -110, 'draftkings'), q('A B', 'rush_yards', 50.5, -110, 'fanduel')],
      asStored(one.current),
      EMPTY,
      { now: NOW + H, kickoff: SUNDAY, source: 'sgo' },
    );
    expect(two.changed).toHaveLength(1);
    expect(two.changed[0]!.bookCount).toBe(2);
  });
});

describe('the McConkey case (live numbers, Nov 12 probe run 43224973540)', () => {
  /*
   * Chargers at Ravens, Monday 8:15 PM ET, read Thursday 8:11 AM. McConkey had
   * a touchdown price at five books and no yards or catches line at any book:
   * the books had not posted them yet. A receiver is priced only with yards,
   * catches and a touchdown price, so he is unpriced before and after.
   */
  const probe = [
    q('Ladd McConkey', 'anytime_td', 1.5, 5500, 'fanduel'),
    q('Ladd McConkey', 'anytime_td', 1.5, 4000, 'caesars'),
    q('Ladd McConkey', 'anytime_td', 1.5, 5000, 'draftkings'),
    q('Ladd McConkey', 'anytime_td', 1.5, 2200, 'betmgm'),
    q('Ladd McConkey', 'anytime_td', 1.5, 4000, 'espnbet'),
  ];
  const now = Date.parse('2026-11-12T13:11:00.000Z');
  const kickoff = '2026-11-17T01:15:00.000Z';

  it('averages his touchdown price over five books instead of the provider\'s single +3500', () => {
    const look = combineLook(probe, [], EMPTY, { now, kickoff, source: 'sportsgameodds' });
    const td = look.current.find((l) => l.market === 'anytime_td')!;
    expect(td.bookCount).toBe(5);
    expect(td.line).toBe(1.5);
    expect(td.impliedProbability).toBeCloseTo(0.026, 3);
  });

  it('still has no yards or catches line, so he stays unpriced until the books post them', () => {
    const look = combineLook(probe, [], EMPTY, { now, kickoff, source: 'sportsgameodds' });
    expect(look.current.map((l) => l.market)).toEqual(['anytime_td']);
  });
});

// ------------------------------------------------------------ adapter

describe('the SportsGameOdds adapter reads each book', () => {
  const event = {
    eventID: 'evt-books',
    type: 'match',
    status: { startsAt: SUNDAY },
    teams: { home: { teamID: 'LOS_ANGELES_CHARGERS_NFL' }, away: { teamID: 'BALTIMORE_RAVENS_NFL' } },
    players: { LADD_MCCONKEY_1_NFL: { name: 'Ladd McConkey' } },
    odds: {
      'receiving_yards-LADD_MCCONKEY_1_NFL-game-ou-over': {
        statID: 'receiving_yards', statEntityID: 'LADD_MCCONKEY_1_NFL', playerID: 'LADD_MCCONKEY_1_NFL',
        periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOverUnder: '54.5', bookOdds: '-112',
        byBookmaker: {
          draftkings: { odds: '-115', overUnder: '54.5', available: true },
          fanduel: { odds: '-110', overUnder: '55.5', available: true },
          bovada: { odds: '-110', overUnder: '70.5', available: false },
        },
      },
      'points-all-game-ou-over': {
        statID: 'points', statEntityID: 'all', periodID: 'game', betTypeID: 'ou', sideID: 'over', bookOverUnder: '38.5',
        byBookmaker: { draftkings: { overUnder: '38.5' }, betmgm: { overUnder: '39' } },
      },
      'points-home-game-sp-home': {
        statID: 'points', statEntityID: 'home', periodID: 'game', betTypeID: 'sp', sideID: 'home', bookSpread: '-4.5',
        byBookmaker: { draftkings: { spread: '-4.5' }, betmgm: { spread: '-4' } },
      },
    },
  };
  const provider = new SportsGameOddsProvider({
    apiKey: 'test-key',
    pacer: null,
    fetch: async () => new Response(JSON.stringify({ data: [event] }), { status: 200 }),
  });

  it('sends one quote per live book, leaving out a book that is not taking bets', async () => {
    const set = await provider.getPlayerProps('evt-books');
    expect(set.quotes.map((x) => `${x.book}:${x.line}`).sort()).toEqual(['draftkings:54.5', 'fanduel:55.5']);
  });

  it('sends each book\'s total and spread with the game\'s two sides', async () => {
    const set = await provider.getPlayerProps('evt-books');
    expect(set.gameLines?.teams?.sort()).toEqual(['BAL', 'LAC']);
    expect(set.gameLines?.books?.map((b) => `${b.book}:${b.total}:${b.spread}:${b.spreadTeam}`).sort()).toEqual([
      'betmgm:39:-4:LAC',
      'draftkings:38.5:-4.5:LAC',
    ]);
  });
});

// ------------------------------------------------------------ storage

describe('stored looks are read back as one set of lines', () => {
  async function world() {
    const db = await createTestDb();
    const ids = ['p-a', 'p-b'];
    for (const id of ids) {
      await db
        .prepare(`INSERT INTO players (id, full_name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, '2026-11-01', '2026-11-01')`)
        .bind(id, id, id)
        .run();
    }
    const repo = new PropsRepo(db);
    const look = async (fetchedAt: string, delta: boolean, lines: { player: string; market: string; line: number | null; method?: string }[]) => {
      await repo.put({
        provider: 'sgo',
        eventId: 'g1',
        gameStart: SUNDAY,
        fetchedAt,
        raw: { provider: 'sgo', eventId: 'g1', gameStart: SUNDAY, fetchedAt, quotes: [], raw: null, ...(delta ? { delta: true } : {}) },
      });
      const id = (await repo.snapshotId('sgo', 'g1', fetchedAt))!;
      const rows = lines.map((l) => ({
        playerId: l.player,
        sourcePlayerName: l.player,
        market: l.market as never,
        line: l.line,
        overPrice: null,
        underPrice: null,
        bookCount: l.method === 'none' ? 0 : 3,
        consensusMethod: (l.method ?? 'average') as never,
        books: [],
        impliedProbability: null,
      }));
      if (delta) await repo.saveChanges(id, rows);
      else await repo.saveConsensus(id, rows);
    };
    return { repo, ids, look };
  }

  it('a change-only look shows the old lines plus the one it changed', async () => {
    const { repo, ids, look } = await world();
    const [a, b] = ids as [string, string];
    await look('2026-11-12T10:00:00.000Z', false, [
      { player: a, market: 'rush_yards', line: 50 },
      { player: b, market: 'receiving_yards', line: 40 },
    ]);
    await look('2026-11-13T10:00:00.000Z', true, [{ player: a, market: 'rush_yards', line: 55 }]);
    await look('2026-11-14T10:00:00.000Z', true, []); // nothing moved

    const latest = await repo.latestForPlayers([a, b]);
    expect(latest.get(a)?.[0]?.line).toBe(55);
    expect(latest.get(b)?.[0]?.line).toBe(40);
    // Each line is current as of the newest look, not the look that wrote it.
    expect(latest.get(b)?.[0]?.snapshot?.fetchedAt).toBe('2026-11-14T10:00:00.000Z');

    const previous = await repo.previousForPlayers([a, b]);
    expect(previous.get(a)?.[0]?.line).toBe(55);
    expect(previous.get(a)?.[0]?.snapshot?.fetchedAt).toBe('2026-11-13T10:00:00.000Z');
  });

  it('a "gone" marker hides the line, and an old full copy cannot bring back a line a newer one dropped', async () => {
    const { repo, ids, look } = await world();
    const [a, b] = ids as [string, string];
    await look('2026-11-11T10:00:00.000Z', false, [
      { player: a, market: 'rush_yards', line: 50 },
      { player: b, market: 'receptions', line: 3.5 },
    ]);
    await look('2026-11-12T10:00:00.000Z', false, [{ player: a, market: 'rush_yards', line: 51 }]);
    await look('2026-11-13T10:00:00.000Z', true, [{ player: a, market: 'rush_yards', line: null, method: 'none' }]);
    const latest = await repo.latestForPlayers([a, b]);
    expect(latest.get(a)).toBeUndefined();
    expect(latest.get(b)).toBeUndefined();
    expect(await repo.pricedPlayerCount()).toBe(0);
  });

  it('counts priced players across change-only looks', async () => {
    const { repo, ids, look } = await world();
    const [a, b] = ids as [string, string];
    await look('2026-11-12T10:00:00.000Z', true, [{ player: a, market: 'rush_yards', line: 50 }]);
    await look('2026-11-13T10:00:00.000Z', true, [{ player: b, market: 'receptions', line: 3.5 }]);
    expect(await repo.pricedPlayerCount()).toBe(2);
  });

  it('knows which looks count', () => {
    const s = (delta: boolean, id: number) => ({ id, delta });
    expect(eligibleSnapshots([s(true, 4), s(true, 3), s(false, 2), s(false, 1)], false).map((x) => x.id)).toEqual([4, 3, 2]);
    expect(eligibleSnapshots([s(true, 4), s(true, 3), s(false, 2), s(false, 1)], true).map((x) => x.id)).toEqual([3, 2]);
    expect(eligibleSnapshots([s(true, 2), s(true, 1)], false).map((x) => x.id)).toEqual([2, 1]);
  });
});

// ------------------------------------------------------------ end to end

describe('a refresh that finds nothing new writes no lines', () => {
  it('second look at unchanged odds: zero player lines, game row untouched', async () => {
    const { MockVegasProvider } = await import('../src/core/vegas/mockProvider.ts');
    const { MOCK_GAMES, seedDemoData } = await import('../src/devserver/seed.ts');
    const { VegasRefreshService } = await import('../src/server/services/vegasRefresh.ts');

    class Books extends MockVegasProvider {
      now = Date.now();
      constructor() {
        super(MOCK_GAMES);
      }
      override async getPlayerProps(eventId: string, markets?: never) {
        const raw = await super.getPlayerProps(eventId, markets);
        const at = new Date(this.now).toISOString();
        return {
          ...raw,
          fetchedAt: at,
          // Two books per line, the same numbers every time.
          quotes: raw.quotes.flatMap((x) => [x, { ...x, book: 'fanduel' }]),
          gameLines: {
            total: 44.5,
            spread: -3,
            spreadTeam: 'KC',
            teams: ['KC', 'CIN'],
            books: [
              { book: 'draftkings', total: 44.5, spread: -3, spreadTeam: 'KC', at },
              { book: 'fanduel', total: 44.5, spread: -3, spreadTeam: 'KC', at },
            ],
          },
        };
      }
      async getAccountUsage(): Promise<unknown> {
        return { rateLimits: { 'per-month': { 'max-entities': 2500, 'current-entities': 0 } } };
      }
    }

    const db = await createTestDb();
    await seedDemoData(db);
    const provider = new Books();
    const service = new VegasRefreshService(db, provider);
    const count = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM player_props').first<{ n: number }>())!.n);
    const seen = async () => (await db.prepare('SELECT event_id, lines_seen_at FROM vegas_events ORDER BY event_id').all()).results;

    provider.now = Date.now();
    await service.refresh({ manual: true, now: provider.now });
    const afterFirst = await count();
    const linesFirst = await seen();

    provider.now = Date.now() + 7 * H; // past the manual cooldown, so the games are bought again
    const second = await new VegasRefreshService(db, provider).refresh({ manual: true, now: provider.now });
    expect(second.fetched).toBeGreaterThan(0);
    expect(await count(), 'no player line changed, so none was written').toBe(afterFirst);
    expect(await seen(), 'the game line did not change, so its row was not rewritten').toEqual(linesFirst);
  });
});

describe('rounding', () => {
  it('reads a spread the same from either side (half away from zero)', () => {
    const at = new Date(NOW).toISOString();
    const lac = combineBookValues([{ book: 'a', value: -4.5, at }, { book: 'b', value: -4, at }], 'spread', opts);
    const bal = combineBookValues([{ book: 'a', value: 4.5, at }, { book: 'b', value: 4, at }], 'spread', opts);
    expect(lac.value).toBe(-4.3);
    expect(bal.value).toBe(4.3);
  });
});
