/**
 * The SportsGameOdds adapter, against the shapes the live API actually returns.
 *
 * The fixtures below are copied from `scripts/probe-sportsgameodds.mjs` output
 * rather than invented, down to the odd id format and the fact that lines and
 * prices arrive as strings. An odds adapter fails silently — a wrong key name
 * parses cleanly and returns nothing, which looks like a quiet week — so the
 * tests are about the specific ways this one could quietly return nothing.
 */

import { describe, expect, it } from 'vitest';
import { providerTeamId, SportsGameOddsProvider } from '../src/core/vegas/sportsGameOddsProvider.ts';
import { NFL_TEAMS } from '../src/core/nfl/teams.ts';
import { VegasProviderError } from '../src/core/vegas/types.ts';

/** One quote, in the provider's own shape. */
function odd(over: Record<string, unknown>): Record<string, unknown> {
  return {
    periodID: 'game',
    betTypeID: 'ou',
    sideID: 'over',
    bookOdds: '-110',
    fairOdds: '-110',
    cancelled: false,
    byBookmaker: {},
    ...over,
  };
}

const EVENT = {
  eventID: 'evt-1',
  leagueID: 'NFL',
  type: 'match',
  status: { startsAt: '2026-09-13T17:00:00.000Z', cancelled: false, started: false },
  teams: {
    home: { teamID: 'SAN_FRANCISCO_49ERS_NFL', names: { long: 'San Francisco 49ers' } },
    away: { teamID: 'TENNESSEE_TITANS_NFL', names: { long: 'Tennessee Titans' } },
  },
  players: {
    TONY_POLLARD_1_NFL: {
      playerID: 'TONY_POLLARD_1_NFL',
      teamID: 'TENNESSEE_TITANS_NFL',
      firstName: 'Tony',
      lastName: 'Pollard',
      name: 'Tony Pollard',
    },
    ELIC_AYOMANOR_1_NFL: {
      playerID: 'ELIC_AYOMANOR_1_NFL',
      teamID: 'TENNESSEE_TITANS_NFL',
      name: 'Elic Ayomanor',
    },
  },
  odds: {
    'rushing_yards-TONY_POLLARD_1_NFL-game-ou-over': odd({
      oddID: 'rushing_yards-TONY_POLLARD_1_NFL-game-ou-over',
      statID: 'rushing_yards',
      statEntityID: 'TONY_POLLARD_1_NFL',
      playerID: 'TONY_POLLARD_1_NFL',
      marketName: 'Tony Pollard Rushing Yards Over/Under',
      bookOverUnder: '62.5',
      fairOverUnder: '62.5',
    }),
    // The matching under: the same market under a second identity.
    'rushing_yards-TONY_POLLARD_1_NFL-game-ou-under': odd({
      oddID: 'rushing_yards-TONY_POLLARD_1_NFL-game-ou-under',
      statID: 'rushing_yards',
      statEntityID: 'TONY_POLLARD_1_NFL',
      playerID: 'TONY_POLLARD_1_NFL',
      sideID: 'under',
      bookOverUnder: '62.5',
    }),
    'receiving_yards-ELIC_AYOMANOR_1_NFL-game-ou-over': odd({
      oddID: 'receiving_yards-ELIC_AYOMANOR_1_NFL-game-ou-over',
      statID: 'receiving_yards',
      statEntityID: 'ELIC_AYOMANOR_1_NFL',
      playerID: 'ELIC_AYOMANOR_1_NFL',
      bookOverUnder: '48.5',
      bookOdds: '+105',
    }),
    // A first-half line: a different question from the one a lineup asks.
    'rushing_yards-TONY_POLLARD_1_NFL-1h-ou-over': odd({
      oddID: 'rushing_yards-TONY_POLLARD_1_NFL-1h-ou-over',
      statID: 'rushing_yards',
      statEntityID: 'TONY_POLLARD_1_NFL',
      playerID: 'TONY_POLLARD_1_NFL',
      periodID: '1h',
      bookOverUnder: '31.5',
    }),
    // The game total: a side, not a player.
    'points-all-game-ou-over': odd({
      oddID: 'points-all-game-ou-over',
      statID: 'points',
      statEntityID: 'all',
      bookOverUnder: '44.5',
    }),
    // A market nobody asked for.
    'fieldGoals_made-EDDY_PINEIRO_1_NFL-game-ou-over': odd({
      oddID: 'fieldGoals_made-EDDY_PINEIRO_1_NFL-game-ou-over',
      statID: 'fieldGoals_made',
      statEntityID: 'EDDY_PINEIRO_1_NFL',
      playerID: 'EDDY_PINEIRO_1_NFL',
      bookOverUnder: '1.5',
    }),
    // Pulled from the board.
    'receiving_yards-TONY_POLLARD_1_NFL-game-ou-over': odd({
      oddID: 'receiving_yards-TONY_POLLARD_1_NFL-game-ou-over',
      statID: 'receiving_yards',
      statEntityID: 'TONY_POLLARD_1_NFL',
      playerID: 'TONY_POLLARD_1_NFL',
      bookOverUnder: '18.5',
      cancelled: true,
    }),
  },
};

function providerFor(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const provider = new SportsGameOddsProvider({
    apiKey: 'test-key',
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
    },
  });
  return { provider, calls };
}

describe('configuration', () => {
  it('is not configured without a key, and refuses rather than calling out', async () => {
    const provider = new SportsGameOddsProvider({ apiKey: null });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.getUpcomingNFLGames()).rejects.toBeInstanceOf(VegasProviderError);
  });

  it('is configured with one', () => {
    expect(new SportsGameOddsProvider({ apiKey: 'k' }).isConfigured()).toBe(true);
  });
});

describe('upcoming games', () => {
  it('reads the kickoff from status.startsAt, where it actually lives', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const games = await provider.getUpcomingNFLGames({ from: '2026-09-10T00:00:00.000Z' });
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      eventId: 'evt-1',
      startTime: '2026-09-13T17:00:00.000Z',
      homeTeam: 'San Francisco 49ers',
    });
  });

  /** An unfiltered NFL query answers with the Puppy Bowl. */
  it('asks only for real matches with odds', async () => {
    const { provider, calls } = providerFor({ data: [] });
    await provider.getUpcomingNFLGames({ from: '2026-09-10T00:00:00.000Z', to: '2026-09-18T00:00:00.000Z' });
    expect(calls[0]).toContain('type=match');
    expect(calls[0]).toContain('startsAfter=2026-09-10');
    expect(calls[0]).toContain('startsBefore=2026-09-18');
    expect(calls[0]).toContain('leagueID=NFL');
  });

  it('skips a cancelled game and one with no kickoff', async () => {
    const { provider } = providerFor({
      data: [
        { ...EVENT, eventID: 'a', status: { startsAt: '2026-09-13T17:00:00.000Z', cancelled: true } },
        { ...EVENT, eventID: 'b', status: {} },
        EVENT,
      ],
    });
    const games = await provider.getUpcomingNFLGames();
    expect(games.map((g) => g.eventId)).toEqual(['evt-1']);
  });
});

describe('player props', () => {
  it('maps the provider’s statIDs onto our market keys', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    expect(set.quotes.map((q) => [q.playerName, q.market, q.line])).toEqual([
      ['Tony Pollard', 'rush_yards', 62.5],
      ['Elic Ayomanor', 'receiving_yards', 48.5],
    ]);
  });

  it('reads lines and prices that arrive as strings', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    const ayomanor = set.quotes.find((q) => q.playerName === 'Elic Ayomanor')!;
    expect(ayomanor.line).toBe(48.5);
    expect(ayomanor.overPrice).toBe(105);
    // The provider quotes each side separately, so the under is genuinely
    // absent on this row rather than zero.
    expect(ayomanor.underPrice).toBeNull();
  });

  it('takes one row per market, not one per side', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    expect(set.quotes.filter((q) => q.playerName === 'Tony Pollard' && q.market === 'rush_yards')).toHaveLength(1);
  });

  it('ignores anything that is not a full-game player over/under', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    // First-half line, game total, unwanted market, cancelled row.
    expect(set.quotes).toHaveLength(2);
    expect(set.quotes.some((q) => q.line === 31.5)).toBe(false);
    expect(set.quotes.some((q) => q.line === 44.5)).toBe(false);
    expect(set.quotes.some((q) => q.line === 1.5)).toBe(false);
    expect(set.quotes.some((q) => q.line === 18.5)).toBe(false);
  });

  it('honours a narrowed market list', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1', ['receiving_yards']);
    expect(set.quotes.map((q) => q.market)).toEqual(['receiving_yards']);
  });

  it('recovers a usable name when the player directory has no entry', async () => {
    const { provider } = providerFor({ data: [{ ...EVENT, players: {} }] });
    const set = await provider.getPlayerProps('evt-1');
    // The identity matcher can work with a name and nothing with an id.
    expect(set.quotes.map((q) => q.playerName)).toContain('Tony Pollard');
  });

  it('reports one consensus book rather than pretending several agreed', async () => {
    // `byBookmaker` is empty on the free plan.
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    for (const quote of set.quotes) expect(quote.book).toBe('sportsgameodds');
  });

  it('keeps the kickoff and the raw payload on the snapshot', async () => {
    const { provider } = providerFor({ data: [EVENT] });
    const set = await provider.getPlayerProps('evt-1');
    expect(set.gameStart).toBe('2026-09-13T17:00:00.000Z');
    expect(set.provider).toBe('sportsgameodds');
    expect(set.raw).toBeTruthy();
  });

  it('says so when the event is not there rather than returning an empty week', async () => {
    const { provider } = providerFor({ data: [] });
    await expect(provider.getPlayerProps('missing')).rejects.toBeInstanceOf(VegasProviderError);
  });
});

describe('failures are named', () => {
  it('separates auth from quota from everything else', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'quota'],
      [500, 'network'],
    ] as const) {
      const { provider } = providerFor({}, status);
      await expect(provider.getUpcomingNFLGames()).rejects.toMatchObject({ kind });
    }
  });

  it('records what the provider says is left', async () => {
    const { provider } = providerFor({ data: [] }, 200, { 'x-ratelimit-remaining': '2431' });
    await provider.getUpcomingNFLGames();
    expect(provider.getQuotaStatus().remaining).toBe(2431);
    expect(provider.getQuotaStatus().lastRequestAt).toBeTruthy();
  });
});

describe('team ids are translated, not passed through', () => {
  /*
   * The bug this suite exists for: the refresh service collects team codes off
   * the user's rostered players, which are Sleeper's, and the provider's filter
   * only answers to its own. `teamID=SF` returns 200 with an empty list —
   * measured against the live API — which every layer above reads as "no
   * fixtures", and which is billed an entity all the same.
   */
  it('sends the provider its own id for a Sleeper code', async () => {
    const { provider, calls } = providerFor({ data: [EVENT] });
    await provider.getPropsForTeams(['SF']);
    expect(calls[0]).toContain('teamID=SAN_FRANCISCO_49ERS_NFL');
    expect(calls[0]).not.toContain('teamID=SF&');
  });

  it('keys the result by the code the caller asked with', async () => {
    // The caller holds Sleeper codes and nothing else; handing back the
    // provider's id would break the mapping from a rostered player to an event.
    const { provider } = providerFor({ data: [EVENT] });
    const result = await provider.getPropsForTeams(['SF']);
    expect(result.results[0]?.teamId).toBe('SF');
  });

  it('covers all thirty-two clubs the app knows about', async () => {
    // A gap here is invisible in production: those players simply never get an
    // event, which looks exactly like a bye.
    const codes = NFL_TEAMS.map((t) => t.code);
    expect(codes).toHaveLength(32);
    for (const code of codes) {
      expect(providerTeamId(code), `no provider id for ${code}`).toMatch(/_NFL$/);
    }
  });

  it('knows the one code the two vocabularies disagree on', () => {
    // Sleeper says LAR, the provider says LA. This single exception is why the
    // mapping is a table rather than a naming rule.
    expect(providerTeamId('LAR')).toBe('LOS_ANGELES_RAMS_NFL');
    expect(providerTeamId('LAC')).toBe('LOS_ANGELES_CHARGERS_NFL');
  });

  it('passes an id that is already the provider\'s through untouched', () => {
    expect(providerTeamId('SAN_FRANCISCO_49ERS_NFL')).toBe('SAN_FRANCISCO_49ERS_NFL');
  });

  it('reports an unplaceable code instead of spending an entity on it', async () => {
    const { provider, calls } = providerFor({ data: [EVENT] });
    const result = await provider.getPropsForTeams(['SF', 'XXX']);
    // One request, not two: the unknown code is never sent, because sending it
    // would cost a billed entity to be told nothing.
    expect(calls).toHaveLength(1);
    expect(result.requests).toBe(1);
    expect(result.unmapped).toEqual(['XXX']);
  });

  it('does not silently drop a team it could not place', async () => {
    const { provider } = providerFor({ data: [] });
    const result = await provider.getPropsForTeams(['NOT_A_TEAM']);
    expect(result.results).toHaveLength(0);
    // The distinction that matters: nothing came back AND we never asked.
    expect(result.unmapped).toEqual(['NOT_A_TEAM']);
  });
});
