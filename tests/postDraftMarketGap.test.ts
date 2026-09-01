/**
 * The week between a finished draft and the first game the market has priced.
 *
 * Reported on 31 August 2026, hours after a real in-person draft finished and
 * nine days before week one: the Matchup screen showing both sides at `0.00`
 * with every starter row `0.0` and "forecast temporarily unavailable"; the
 * Waivers tab showing `Wait — no DST needed yet` over an empty DEF slot; and
 * the Team screen leading with `Start Mark Andrews over Kenneth Walker (FLEX)`
 * for a lineup nobody had priced.
 *
 * One cause under them, and it is not the draft-state detection that shipped the
 * day before — that only made these screens *reachable*, which is why all three
 * arrived at once. No betting market had priced week one: the refresh returns
 * at "no roster to price" while a roster is empty, which it was until the final
 * pick, and discovery then looked only eight days ahead, which does not reach a
 * season that starts in ten. Every model that runs on the market was left with
 * nothing, and each of them failed in its own way rather than saying so. These
 * are the failures, held separately so a regression in one is legible.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { MarketKey, TeamPropsResult } from '../src/core/vegas/types.ts';
import { VegasRefreshService } from '../src/server/services/vegasRefresh.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

/** Alex's league: 1 QB / 2 RB / 3 WR / 2 FLEX / 1 DEF. */
const SHAPE = buildRosterShape([
  'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
]);

function signalWithNet(net: number, items = 3): PlayerSignal {
  const signal = emptySignal('x');
  signal.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  signal.last30 = { ...signal.raw };
  return signal;
}

/**
 * A rostered player nobody has priced, carrying a news tally.
 *
 * The tally is what makes this the interesting case rather than a trivial one:
 * with no market *and* no news the engine already returns a null score and the
 * player is reported undecidable. A newsletter mention is enough to produce a
 * score made entirely of nudges, which is the number that was deciding lineups.
 */
function unpriced(id: string, name: string, position: string, net: number): StartSitInput {
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props: [],
    signal: signalWithNet(net),
    injuryStatus: null,
    propsStale: false,
  };
}

/** The same player, with a market behind him. Receiving yards convert at 0.1. */
function priced(id: string, name: string, position: string, points: number): StartSitInput {
  return {
    player: player({ id, fullName: name, position, team: 'NE' }),
    props: [
      {
        playerId: id,
        sourcePlayerName: name,
        market: position === 'QB' ? 'pass_yards' : 'receiving_yards',
        line: position === 'QB' ? points / 0.04 : points * 10,
        overPrice: -110,
        underPrice: -110,
        bookCount: 3,
        consensusMethod: 'median',
        books: ['a', 'b', 'c'],
        impliedProbability: null,
      },
    ],
    signal: null,
    injuryStatus: null,
    propsStale: false,
  };
}

describe('a lineup nobody has priced', () => {
  /*
   * The roster as it was reported: a defence-less nine-slot lineup, a Sleeper
   * lineup already set, and a bench player whose only distinction is a
   * friendlier newsletter tally than the starter he displaces.
   */
  const roster = [
    unpriced('qb1', 'Passer One', 'QB', 1),
    unpriced('rb1', 'Kenneth Walker', 'RB', -1),
    unpriced('rb2', 'Runner Two', 'RB', 0),
    unpriced('rb3', 'KC Concepcion', 'RB', 2),
    unpriced('wr1', 'Catcher One', 'WR', 0),
    unpriced('wr2', 'Catcher Two', 'WR', 0),
    unpriced('wr3', 'Catcher Three', 'WR', 0),
    unpriced('wr4', 'Jayden Reed', 'WR', 2),
    unpriced('te1', 'Mark Andrews', 'TE', 3),
  ];
  const sleeperLineup = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'wr4'];

  it('proposes no change it cannot price', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: sleeperLineup });

    expect(out.swaps).toEqual([]);
  });

  it('leaves the lineup the reader already set exactly where it is', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: sleeperLineup });

    const recommended = out.slots.map((slot) => slot.playerId).filter((id): id is string => id != null);
    expect([...recommended].sort()).toEqual([...sleeperLineup].sort());
    // Every filled slot is somebody already starting, so no row carries the
    // "on your bench" mark and the card and the rows agree.
    expect(out.slots.filter((slot) => slot.playerId && !slot.alreadyStarting)).toEqual([]);
  });

  it('does not let Ceiling mode stack a lineup nobody has priced', () => {
    /*
     * The preference pass is worth at most a tie, and "a tie" is measured in
     * points. Every unpriced pair is a tie, so without a guard the shape
     * preference would become the whole decision — and silently, because the
     * swap it makes is one the card below is now right not to report.
     */
    const out = recommendLineup(roster, SHAPE, HALF_PPR, {
      currentStarterIds: sleeperLineup,
      mode: 'ceiling',
    });

    expect(out.slots.filter((slot) => slot.playerId && !slot.alreadyStarting)).toEqual([]);
    expect(out.notes.filter((note) => /ceiling mode/i.test(note))).toEqual([]);
  });

  it('says why it is quiet rather than leaving a blank card unexplained', () => {
    const out = recommendLineup(roster, SHAPE, HALF_PPR, { currentStarterIds: sleeperLineup });

    expect(out.notes.join(' ')).toMatch(/no betting market has priced this week/i);
  });

  it('still benches an unpriced starter for a player the market has quoted', () => {
    /*
     * The one-sidedness of the rule, which is the whole reason it is stated as
     * "the incoming player needs a market" and not "both of them do". A bye
     * week is an unpriced starter, and replacing him with somebody the books
     * have actually quoted is a real comparison.
     */
    const mixed = [
      priced('qb1', 'Passer One', 'QB', 20),
      priced('rb1', 'Runner One', 'RB', 15),
      priced('rb2', 'Runner Two', 'RB', 12),
      priced('wr1', 'Catcher One', 'WR', 14),
      priced('wr2', 'Catcher Two', 'WR', 11),
      unpriced('wr3', 'Bye Week Wideout', 'WR', 0),
      priced('wr4', 'Catcher Four', 'WR', 10),
      priced('te1', 'End One', 'TE', 8),
      priced('rb3', 'Runner Three', 'RB', 9),
    ];
    const out = recommendLineup(mixed, SHAPE, HALF_PPR, {
      currentStarterIds: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'rb3'],
    });

    expect(out.swaps.map((s) => s.outPlayerId)).toContain('wr3');
    expect(out.swaps.every((s) => s.inPlayerId !== 'wr3')).toBe(true);
  });
});

/**
 * A provider that records the window it was asked about and answers from a
 * fixture list of its own, so "what did discovery ask for" is observable.
 */
class WindowRecordingProvider extends MockVegasProvider {
  readonly windows: { from: string; to: string }[] = [];

  constructor(private readonly kickoffs: Record<string, string[]> = {}) {
    super(MOCK_GAMES);
  }

  override async getPropsForTeams(
    teamIds: string[],
    opts: { from?: string; to?: string; markets?: MarketKey[]; maxEvents?: number } = {},
  ): Promise<TeamPropsResult> {
    this.windows.push({ from: opts.from ?? '', to: opts.to ?? '' });
    const base = await super.getPropsForTeams(teamIds, opts);
    const extra = Object.keys(this.kickoffs).length;
    if (extra === 0) return base;

    /*
     * One entry per (team, fixture), which is the shape the real adapter
     * returns when a window spans more than one of a team's games.
     */
    const results = base.results.flatMap((entry) =>
      (this.kickoffs[entry.teamId] ?? []).map((start, index) => ({
        teamId: entry.teamId,
        set: { ...entry.set, eventId: `${entry.teamId}-game-${index}`, gameStart: start },
      })),
    );
    return { ...base, results: results.length > 0 ? results : base.results };
  }
}

describe('discovery reaches the roster’s next fixture', () => {
  let db: NodeSqliteDatabase;
  /** The Monday after a draft, with week one still nine days out. */
  const NOW = Date.parse('2026-08-31T12:00:00.000Z');

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  /** Every team the demo roster spans, playing on one day. */
  async function fixturesOn(kickoff: string, week = 1): Promise<void> {
    const teams = ['KC', 'CIN', 'DAL', 'BUF', 'SF', 'NE', 'NYJ', 'MIA', 'PIT', 'BAL', 'CLE', 'DEN'];
    await new NflScheduleRepo(db).save(
      teams.map((team, index) => ({
        season: '2026',
        week,
        team,
        opponent: teams[(index + 1) % teams.length] ?? null,
        home: index % 2 === 0,
        kickoff,
        roof: null,
      })),
      '2026-08-25T00:00:00.000Z',
    );
  }

  it('stretches the window past eight days when the next game is further out', async () => {
    await fixturesOn('2026-09-10T00:20:00.000Z');
    const provider = new WindowRecordingProvider();

    await new VegasRefreshService(db, provider).refresh({ now: NOW });

    expect(provider.windows).toHaveLength(1);
    const asked = Date.parse(provider.windows[0]!.to);
    expect(asked).toBeGreaterThan(Date.parse('2026-09-10T00:20:00.000Z'));
    // And no further than the fixture needs: the ceiling is not the target.
    expect(asked).toBeLessThan(NOW + 28 * 86_400_000 + 1);
  });

  it('leaves an ordinary in-season week exactly as it was', async () => {
    await fixturesOn('2026-09-03T00:20:00.000Z');
    const provider = new WindowRecordingProvider();

    await new VegasRefreshService(db, provider).refresh({ now: NOW });

    expect(Date.parse(provider.windows[0]!.to)).toBe(NOW + 8 * 86_400_000);
  });

  it('falls back to the ordinary horizon when no fixture list is stored', async () => {
    const provider = new WindowRecordingProvider();

    await new VegasRefreshService(db, provider).refresh({ now: NOW });

    expect(Date.parse(provider.windows[0]!.to)).toBe(NOW + 8 * 86_400_000);
  });

  it('stores one fixture per team, so a player is never priced from two games', async () => {
    /*
     * The invariant a wider window would otherwise have broken.
     * `PropsRepo.latestForPlayers` returns the newest snapshot per *event*, so
     * a player quoted in two stored games comes back with two lines for one
     * week and the expectation reads them as one.
     */
    await fixturesOn('2026-09-10T00:20:00.000Z');
    const provider = new WindowRecordingProvider({
      KC: ['2026-09-10T00:20:00.000Z', '2026-09-17T00:20:00.000Z'],
      CIN: ['2026-09-10T00:20:00.000Z', '2026-09-17T00:20:00.000Z'],
      DAL: ['2026-09-13T17:00:00.000Z', '2026-09-20T17:00:00.000Z'],
      BUF: ['2026-09-13T17:00:00.000Z', '2026-09-20T17:00:00.000Z'],
      SF: ['2026-09-13T17:00:00.000Z', '2026-09-20T17:00:00.000Z'],
    });

    await new VegasRefreshService(db, provider).refresh({ now: NOW });

    const stored = await new VegasEventsRepo(db).between(
      new Date(NOW).toISOString(),
      new Date(NOW + 60 * 86_400_000).toISOString(),
    );
    // The second fixture of every team is left where it is until the week it
    // becomes the next one.
    expect(stored.every((row) => Date.parse(row.kickoff ?? '') < Date.parse('2026-09-15T00:00:00.000Z'))).toBe(true);

    const snapshots = await new PropsRepo(db).freshness();
    expect(snapshots.events).toBeGreaterThan(0);
  });
});
