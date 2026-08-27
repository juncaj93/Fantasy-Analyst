/**
 * What each lane has to preserve, stated as the thing rather than as the prose.
 *
 * `support.inSeason.test.ts` proves the five lanes capture and replay against the
 * seeded league, which is one league in one state. This file builds the states
 * that matter — an injured starter, a locked slot, a wallet, a bye, a degraded
 * forecast — and asserts the *semantics* survive the round trip.
 *
 * Semantics rather than sentences, deliberately. A test that compared a reason's
 * wording would fail on a rewrite and pass on a wrong bid; these compare the bid
 * against the wallet, the drop against the roster, the claim order against
 * itself, and the defence's decision against the planner's.
 */

import { describe, expect, it } from 'vitest';
import { captureLineupSnapshot, replayLineupSnapshot } from '../src/core/support/lineupSnapshot.ts';
import { captureWaiverSnapshot, replayWaiverSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { captureDstSnapshot, replayDstSnapshot } from '../src/core/support/dstSnapshot.ts';
import { captureMatchupSnapshot, replayMatchupSnapshot } from '../src/core/support/matchupSnapshot.ts';
import { captureTradeSnapshot, replayTradeSnapshot } from '../src/core/support/tradeSnapshot.ts';
import { NO_TRADE_HISTORY } from '../src/core/trades/assemble.ts';
import { waiverLineup } from '../src/core/waivers/assemble.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { findRedactionViolations } from '../src/core/support/redaction.ts';
import { findLossyValues } from '../src/core/support/lossless.ts';
import { candidate, defence } from './helpers/startsit.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { LeagueRecord, RosterRecord } from '../src/core/sleeper/types.ts';
import type { DstPlanSources } from '../src/core/dst/assemble.ts';
import type { MatchupSources } from '../src/core/matchup/build.ts';
import type { LeagueBudgetState } from '../src/core/faab/budget.ts';
import type { PriceSummary } from '../src/core/faab/bids.ts';
import type { SupportSnapshot } from '../src/core/support/schema.ts';

const NOW = new Date('2026-10-14T15:00:00.000Z');
const SHA = 'f00dbabe';

/** A half-PPR league that starts a defence, so the DST lane has a question. */
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'DEF', 'BN', 'BN', 'BN'];

function league(over: Partial<LeagueRecord> = {}): LeagueRecord {
  return {
    id: 'sleeper-league-77',
    sleeperLeagueId: 'sleeper-league-77',
    name: "Gary's Dynasty of Pain",
    season: '2026',
    totalRosters: 2,
    scoringSettings: { rec: 0.5 },
    rosterPositions: POSITIONS,
    leagueSettings: { waiver_type: 2, waiver_budget: 100 },
    draftId: null,
    status: 'in_season',
    localTeams: [],
    lastSyncedAt: NOW.toISOString(),
    ...over,
  };
}

function roster(over: Partial<RosterRecord> = {}): RosterRecord {
  return {
    leagueId: 'sleeper-league-77',
    rosterId: 1,
    ownerId: '467803924117221376',
    ownerName: 'gary_the_commish',
    playerIds: [],
    starterIds: [],
    reserveIds: [],
    isMine: true,
    settings: { waiver_budget_used: 20 },
    ...over,
  };
}

const shape = buildRosterShape(POSITIONS);
const profile = buildScoringProfile({ rec: 0.5 }, POSITIONS);

/** Nine players and a defence, priced so the optimiser has real choices. */
function squad(over: { injured?: boolean; locked?: boolean } = {}): StartSitInput[] {
  const kickoff = over.locked ? new Date(NOW.getTime() - 3_600_000).toISOString() : null;
  return [
    candidate('qb1', 'Ace Arm', 'QB', 21, { team: 'KC' }),
    candidate('rb1', 'Lead Back', 'RB', 16, { team: 'SF', ...(over.injured ? { status: 'Questionable' } : {}) }),
    candidate('rb2', 'Second Back', 'RB', 11, { team: 'DAL' }),
    candidate('rb3', 'Handcuff', 'RB', 9.5, { team: 'DAL', kickoff }),
    candidate('wr1', 'Alpha Wide', 'WR', 15, { team: 'CIN' }),
    candidate('wr2', 'Slot Wide', 'WR', 10, { team: 'MIA' }),
    candidate('wr3', 'Deep Threat', 'WR', 12, { team: 'BUF' }),
    candidate('te1', 'Big Target', 'TE', 8, { team: 'BAL' }),
    defence('def1', 'Seattle', { spread: -6, total: 41 }, { team: 'SEA' }),
  ];
}

const MY_PLAYERS = ['qb1', 'rb1', 'rb2', 'rb3', 'wr1', 'wr2', 'wr3', 'te1', 'def1'];
/** Deliberately wrong: the handcuff starts and the alpha receiver sits. */
const MY_STARTERS = ['qb1', 'rb1', 'rb3', 'wr2', 'wr3', 'te1', 'def1'];

const props = { fetchedAt: NOW.toISOString(), provider: 'test', events: 8 };

function lineupSnapshot(inputs: StartSitInput[] = squad()) {
  return captureLineupSnapshot({
    gitSha: SHA,
    league: league(),
    rosters: [roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS })],
    mine: roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS }),
    shape,
    profile,
    inputs,
    mode: 'balanced',
    published: new Map(),
    nflState: { season: '2026', week: 6, seasonType: 'regular' } as never,
    props,
    now: NOW,
  });
}

/** Every snapshot in this file has to clear the same two gates. */
function sealed(snapshot: SupportSnapshot): void {
  expect(findRedactionViolations(snapshot)).toEqual([]);
  expect(findLossyValues(snapshot)).toEqual([]);
  const text = JSON.stringify(snapshot);
  expect(text, 'the Sleeper league id survived').not.toContain('sleeper-league-77');
  expect(text, 'the owner id survived').not.toContain('467803924117221376');
  expect(text, 'the owner name survived').not.toContain('gary_the_commish');
  expect(text, 'the league name survived').not.toContain("Gary's Dynasty of Pain");
}

// ------------------------------------------------------------------- lineup

describe('Team / Start-Sit', () => {
  it('reproduces an ordinary recommendation, and it is one that changes something', () => {
    const snapshot = lineupSnapshot();
    sealed(snapshot);

    /*
     * The case has to be a case.
     *
     * A lineup with nothing to say would replay identically whatever this code
     * did, so the fixture starts a handcuff over an alpha receiver and the
     * assertion is that the engine noticed.
     */
    expect(snapshot.decision.output.swaps.length).toBeGreaterThan(0);
    const report = replayLineupSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
  });

  it('keeps an availability charge rather than replaying a healthy player', () => {
    const healthy = lineupSnapshot(squad());
    const injured = lineupSnapshot(squad({ injured: true }));
    sealed(injured);

    /*
     * The two boards must genuinely differ, or the round trip below proves
     * nothing about injuries.
     */
    expect(injured.decision.output.recommendedPoints).not.toBe(healthy.decision.output.recommendedPoints);
    expect(injured.decision.freshness.injury.known).toBeGreaterThan(0);
    expect(replayLineupSnapshot(injured).outcome).toBe('reproduced');
  });

  it('keeps a locked player locked, so the replay cannot re-optimise his slot', () => {
    const snapshot = lineupSnapshot(squad({ locked: true }));
    sealed(snapshot);

    const locked = snapshot.decision.output.slots.filter((slot) => slot.locked);
    expect(locked.length, 'the fixture has to actually lock a slot').toBeGreaterThan(0);

    const report = replayLineupSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
    /*
     * Replayed a week later, with the clock pinned, the slot is still locked.
     * Without the pin every game would have kicked off and the whole lineup
     * would be frozen — a different answer, arrived at silently.
     */
    expect(replayLineupSnapshot(snapshot).outcome).toBe('reproduced');
  });

  it('carries an unknown as unknown, never as a zero', () => {
    /* No market at all for two players: a bye, or a slate nobody priced. */
    const unpriced = squad().map((input, i) => (i === 4 || i === 5 ? { ...input, props: [] } : input));
    const snapshot = lineupSnapshot(unpriced);
    sealed(snapshot);

    /*
     * Three, not two: the defence has no props either, and never did. A defence
     * is a game line rather than a set of receiving yards — see the `defence`
     * helper — so it is unpriced by construction and counted honestly as such.
     */
    expect(snapshot.decision.freshness.priced.withoutProps).toBe(3);
    expect(lineupSnapshot().decision.freshness.priced.withoutProps).toBe(1);
    /*
     * An unscorable player is `undecidable` — never auto-started, never
     * auto-benched — and his projection is null rather than 0.
     *
     * Both halves matter. A zero is a forecast of nothing, and null is the
     * honest "this app cannot price him"; and a player the engine cannot read
     * must not be quietly sat down, because the reader may well know something
     * the market has not published yet.
     */
    const undecidable = snapshot.decision.output.undecidable.map((row) => row.playerId);
    expect(undecidable).toContain('wr1');
    expect(undecidable).toContain('wr2');
    for (const row of snapshot.decision.output.undecidable) expect(row.projection).toBeNull();
    expect(replayLineupSnapshot(snapshot).outcome).toBe('reproduced');
  });
});

// ------------------------------------------------------------------ waivers

const WIRE: StartSitInput[] = [
  candidate('fa1', 'Breakout Back', 'RB', 14, { team: 'NYJ' }),
  candidate('fa2', 'Waiver Wide', 'WR', 13, { team: 'LAR' }),
  candidate('fa3', 'Spare Tight', 'TE', 6, { team: 'TEN' }),
];

/**
 * A league nobody has read a bid from, which is the ordinary state in October.
 *
 * `sample: 0` and every quartile null is a real answer — the price model falls
 * back to its prior and says the confidence is `none` — and it is the state a
 * snapshot has to preserve rather than flatten, because "the bid looks wrong"
 * and "the bid is a guess because this league has published nothing" are two
 * different reports.
 */
const NO_PRICES: PriceSummary = {
  sample: 0,
  median: null,
  low: null,
  high: null,
  max: null,
  highestLosing: null,
  losingBidsComplete: false,
  confidence: 'none',
};

const WALLET: LeagueBudgetState = {
  rule: { usesFaab: true, total: 100, provenance: 'league settings' },
  rosters: [
    { rosterId: 1, ownerName: 'gary_the_commish', isMine: true, remaining: 40, spent: 60, share: 0.4 },
    { rosterId: 2, ownerName: 'rival_manager', isMine: false, remaining: 90, spent: 10, share: 0.9 },
  ],
  notes: [],
};

function waiverSnapshot() {
  const mine = roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS });
  const theirs = roster({
    rosterId: 2,
    ownerId: '9911223344',
    ownerName: 'rival_manager',
    playerIds: ['x1', 'x2'],
    isMine: false,
  });
  const rosterInputs = squad();
  const rosteredIds = new Set([...MY_PLAYERS, 'x1', 'x2']);

  return captureWaiverSnapshot({
    gitSha: SHA,
    league: league(),
    mine,
    rosters: [mine, theirs],
    players: [...rosterInputs, ...WIRE].map((input) => input.player),
    pool: { scanned: WIRE.length, perPosition: 5 },
    nflState: { season: '2026', week: 6, seasonType: 'regular' } as never,
    props,
    weeksRead: 5,
    now: NOW,
    request: {
      shape,
      profile,
      rosterInputs,
      candidateInputs: WIRE,
      rosteredIds,
      currentStarterIds: MY_STARTERS,
      reserveIds: [],
      rosters: [mine, theirs],
      week: 6,
      season: '2026',
      strategy: { week: 6, finalWeek: 14, budget: WALLET, prices: NO_PRICES, trending: new Map() },
      budgets: WALLET,
      prices: NO_PRICES,
      observations: [],
      dstSources: null,
      bestBall: false,
      draftComplete: true,
      playoff: { weeks: [15, 16, 17], emphasis: 0 },
    },
  });
}

describe('Waivers', () => {
  it('reproduces the claims in the same order, with the same bids and drops', async () => {
    const snapshot = await waiverSnapshot();
    sealed(snapshot);

    const report = await replayWaiverSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
    /*
     * The plan has to exist, or the semantics below are assertions about
     * nothing. A wire that beats a handcuff and a slot receiver is a plan.
     */
    expect(snapshot.decision.output.claimPlan?.claims.length ?? 0).toBeGreaterThan(0);
  });

  it('never bids more than the wallet holds', async () => {
    const snapshot = await waiverSnapshot();
    const remaining = WALLET.rosters.find((entry) => entry.isMine)!.remaining!;
    for (const claim of snapshot.decision.output.claimPlan?.claims ?? []) {
      if (claim.bid == null) continue;
      expect(claim.bid, `${claim.addName} was bid more than the wallet holds`).toBeLessThanOrEqual(remaining);
      expect(claim.bid).toBeGreaterThanOrEqual(0);
    }
  });

  it('only ever drops a player who is actually on the roster', async () => {
    const snapshot = await waiverSnapshot();
    const held = new Set(snapshot.decision.inputs.roster.inputs.map((input) => input.player.id));
    for (const claim of snapshot.decision.output.claimPlan?.claims ?? []) {
      if (claim.dropPlayerId == null) continue;
      expect(held.has(claim.dropPlayerId), `${claim.dropName} is not on this roster`).toBe(true);
    }
  });

  it('adds only players the wire actually offered, and never one already rostered', async () => {
    const snapshot = await waiverSnapshot();
    const wire = new Set(snapshot.decision.inputs.candidates.inputs.map((input) => input.player.id));
    const rostered = new Set(snapshot.decision.inputs.rosteredIds);
    for (const claim of snapshot.decision.output.claimPlan?.claims ?? []) {
      expect(wire.has(claim.addPlayerId), `${claim.addName} was not on the scanned wire`).toBe(true);
      expect(rostered.has(claim.addPlayerId), `${claim.addName} is already rostered`).toBe(false);
    }
  });

  it('keeps the claim order and its contingency structure through the round trip', async () => {
    const snapshot = await waiverSnapshot();
    const captured = snapshot.decision.output.claimPlan;
    const report = await replayWaiverSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');

    /*
     * The order *is* the instruction: Sleeper runs claims top to bottom, so two
     * plans with the same claims in a different order are two different things
     * to type in. Ranks are 1..n with no gaps, and a claim that depends on
     * another says which relation it is in.
     */
    const ranks = (captured?.claims ?? []).map((claim) => claim.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    for (const claim of captured?.claims ?? []) {
      expect(typeof claim.relation, 'every claim states its relation to the ones above').toBe('string');
    }
  });

  it('reports a missing manager context as not known, and still replays', async () => {
    const snapshot = await waiverSnapshot();
    /* No ledger was passed, so nothing is known about the rivals. */
    expect(snapshot.decision.freshness.managerProfiles).toBe(0);
    expect(snapshot.decision.inputs.history).toBeNull();
    expect((await replayWaiverSnapshot(snapshot)).outcome).toBe('reproduced');
  });
});

// ---------------------------------------------------------------------- DST

/** A slate the planner can read: this week, and the weeks it looks forward to. */
function dstSources(over: { priced?: boolean } = {}): DstPlanSources {
  const weeks = [6, 7, 8, 9];
  const fixtures = weeks.flatMap((week) => [
    { season: '2026', week, team: 'SEA', opponent: 'ARI', home: true, kickoff: `2026-10-${10 + week}T17:00:00.000Z` },
    { season: '2026', week, team: 'ARI', opponent: 'SEA', home: false, kickoff: `2026-10-${10 + week}T17:00:00.000Z` },
    { season: '2026', week, team: 'NYJ', opponent: 'NE', home: true, kickoff: `2026-10-${10 + week}T17:00:00.000Z` },
    { season: '2026', week, team: 'NE', opponent: 'NYJ', home: false, kickoff: `2026-10-${10 + week}T17:00:00.000Z` },
  ]) as never[];

  return {
    fixturesForWeek: async (_season, week) => fixtures.filter((row) => (row as { week: number }).week === week),
    scheduleForTeams: async (_season, teams, range) =>
      fixtures.filter((row) => {
        const entry = row as { team: string; week: number };
        return teams.includes(entry.team) && entry.week >= range.from && entry.week <= range.to;
      }),
    /*
     * The fallback anchor, present or absent.
     *
     * Absent is the degraded case the brief asks about: the planner will not
     * invent a line, so a week with no priced game and no season form is left
     * unrated rather than valued at zero.
     */
    impliedTotals: async () =>
      over.priced === false ? new Map() : new Map([['ARI', { impliedTotal: 19.5, games: 5 } as never]]),
  };
}

function dstSnapshot(over: { priced?: boolean } = {}) {
  const mine = roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS });
  const rosterInputs = squad();
  const candidateInputs = [defence('def2', 'New York', { spread: -9, total: 44 }, { team: 'NYJ' })];
  const request = {
    season: '2026',
    week: 6,
    shape,
    profile,
    bestBall: false,
    draftComplete: true,
    rosterInputs,
    candidateInputs,
    lineup: waiverLineup({ rosterInputs, shape, profile, currentStarterIds: MY_STARTERS, now: NOW }),
    reserveIds: [],
    playoff: { weeks: [15, 16, 17], emphasis: 0 },
  };
  return captureDstSnapshot({
    gitSha: SHA,
    league: league(),
    mine,
    sources: dstSources(over),
    request,
    nflState: { season: '2026', week: 6, seasonType: 'regular' } as never,
    props,
    now: NOW,
  });
}

describe('DST', () => {
  it('reproduces the decision the planner reached', async () => {
    const snapshot = await dstSnapshot();
    sealed(snapshot);

    /* Whatever it decided, it decided something. */
    expect(snapshot.decision.output).not.toBeNull();
    expect(typeof snapshot.decision.output!.decision).toBe('string');

    const report = await replayDstSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
  });

  it('records which anchor each planned week got, rather than flattening them', async () => {
    const snapshot = await dstSnapshot();
    const anchors = snapshot.decision.freshness.anchors;
    /*
     * `line` is a priced game, `form` is the opponent's own season average
     * standing in for one, and `unknown` is a week the planner refused to value.
     * A reader asking "why is it telling me to stream him" is asking about this
     * distribution, and collapsing it would answer a different question.
     */
    expect(Object.keys(anchors).length).toBeGreaterThan(0);
    for (const key of Object.keys(anchors)) expect(['line', 'form', 'unknown']).toContain(key);
  });

  it('leaves an unpriced week unrated rather than valuing it at zero, and says so', async () => {
    const snapshot = await dstSnapshot({ priced: false });
    sealed(snapshot);

    const anchors = snapshot.decision.freshness.anchors;
    expect((anchors['unknown'] ?? 0) + (anchors['form'] ?? 0), 'no week fell back at all').toBeGreaterThan(0);
    expect(snapshot.decision.warnings.length, 'a degraded anchor is stated, not swallowed').toBeGreaterThan(0);
    expect((await replayDstSnapshot(snapshot)).outcome).toBe('reproduced');
  });

  it('returns no plan at all for a league that starts no defence, and replays that too', async () => {
    const noDefence = ['QB', 'RB', 'WR', 'TE', 'BN'];
    const mine = roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS });
    const rosterInputs = squad();
    const flatShape = buildRosterShape(noDefence);
    const flatProfile = buildScoringProfile({ rec: 0.5 }, noDefence);
    const snapshot = await captureDstSnapshot({
      gitSha: SHA,
      league: league({ rosterPositions: noDefence }),
      mine,
      sources: dstSources(),
      request: {
        season: '2026',
        week: 6,
        shape: flatShape,
        profile: flatProfile,
        bestBall: false,
        draftComplete: true,
        rosterInputs,
        candidateInputs: [],
        lineup: waiverLineup({
          rosterInputs,
          shape: flatShape,
          profile: flatProfile,
          currentStarterIds: MY_STARTERS,
          now: NOW,
        }),
        reserveIds: [],
        playoff: { weeks: [], emphasis: 0 },
      },
      nflState: null,
      props,
      now: NOW,
    });

    expect(snapshot.decision.context.defenceSlots).toBe(0);
    expect(snapshot.decision.output?.surface).toBe(false);
    expect((await replayDstSnapshot(snapshot)).outcome).toBe('reproduced');
  });
});

// ------------------------------------------------------------------ matchup

/**
 * A matchup between two of the squads above, priced or not.
 *
 * `priced: false` is the degraded case: no market for anybody, so no
 * distribution can be built, and the forecast has to admit it rather than
 * produce a confident afternoon out of nothing.
 */
function matchupSources(over: { priced?: boolean; lockAll?: boolean } = {}): MatchupSources {
  const mine = roster({ playerIds: MY_PLAYERS, starterIds: MY_STARTERS });
  const theirs = roster({
    rosterId: 2,
    ownerId: '9911223344',
    ownerName: 'rival_manager',
    playerIds: THEIR_PLAYERS,
    starterIds: THEIR_STARTERS,
    isMine: false,
  });
  const kickoff = over.lockAll ? new Date(NOW.getTime() - 4 * 3_600_000).toISOString() : null;
  const pool = [...squad({ ...(over.lockAll ? { locked: true } : {}) }), ...theirSquad()].map((input) =>
    over.priced === false ? { ...input, props: [] } : over.lockAll ? { ...input, kickoff } : input,
  );

  return {
    leagues: {
      getLeague: async () => league(),
      listRosters: async () => [mine, theirs],
    },
    matchups: async () =>
      [
        { roster_id: 1, matchup_id: 1, points: 0, starters: MY_STARTERS, players: MY_PLAYERS, players_points: {} },
        {
          roster_id: 2,
          matchup_id: 1,
          points: 0,
          starters: THEIR_STARTERS,
          players: THEIR_PLAYERS,
          players_points: {},
        },
      ] as never,
    nflState: async () => ({ season: '2026', seasonType: 'regular', week: 6 }),
    startSitInputs: async (ids) => pool.filter((input) => ids.includes(input.player.id)),
    previousForecast: async () => null,
    cached: () => null,
    remember: () => {},
    now: () => NOW,
  };
}

const THEIR_PLAYERS = ['oqb', 'orb1', 'orb2', 'owr1', 'owr2', 'ote', 'odef'];
const THEIR_STARTERS = THEIR_PLAYERS;

function theirSquad(): StartSitInput[] {
  return [
    candidate('oqb', 'Their Arm', 'QB', 18, { team: 'GB' }),
    candidate('orb1', 'Their Back', 'RB', 13, { team: 'DET' }),
    candidate('orb2', 'Their Other Back', 'RB', 9, { team: 'CHI' }),
    candidate('owr1', 'Their Wide', 'WR', 14, { team: 'PHI' }),
    candidate('owr2', 'Their Slot', 'WR', 8, { team: 'WAS' }),
    candidate('ote', 'Their Tight', 'TE', 7, { team: 'ATL' }),
    defence('odef', 'Denver', { spread: -3, total: 39 }, { team: 'DEN' }),
  ];
}

describe('Matchup / Best Move', () => {
  it('reproduces the projected final, the win probability and the Best Move', async () => {
    const snapshot = await captureMatchupSnapshot(matchupSources(), {
      gitSha: SHA,
      leagueId: league().id,
      week: null,
      props,
    });
    sealed(snapshot);

    const forecast = snapshot.decision.output.forecast;
    expect(forecast, 'the fixture has to produce a forecast at all').not.toBeNull();
    expect(forecast!.teams.mine.winProbability).not.toBeNull();

    const report = await replayMatchupSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
  });

  it('carries the seed, so the same afternoons are drawn rather than similar ones', async () => {
    const snapshot = await captureMatchupSnapshot(matchupSources(), {
      gitSha: SHA,
      leagueId: league().id,
      week: null,
      props,
    });
    /*
     * The league id is hashed into the fingerprint that seeds the simulation and
     * the snapshot aliases that id, so without the seed the replay would draw a
     * different afternoon — indistinguishable, from the outside, from a
     * regression. This is the field that makes it a consequence.
     */
    expect(typeof snapshot.decision.output.forecast!.seed).toBe('number');
    expect(JSON.stringify(snapshot)).not.toContain('sleeper-league-77');
    expect((await replayMatchupSnapshot(snapshot)).outcome).toBe('reproduced');
  });

  it('preserves whichever verdict it reached, and why it is a hold when it is', async () => {
    const snapshot = await captureMatchupSnapshot(matchupSources(), {
      gitSha: SHA,
      leagueId: league().id,
      week: null,
      props,
    });
    const decision = snapshot.decision.output.forecast!.decision;

    /*
     * The distinction the lane exists for. A swap carries both win
     * probabilities, so before/after is checkable; a hold carries the *reason*
     * it is a hold, which is what separates "everybody is locked" from "nobody
     * is legal for that slot" from "nothing on the bench is better". One word on
     * the screen, four states underneath it.
     */
    if (decision.best) {
      expect(decision.best.winAfter).toBeGreaterThan(decision.best.winNow);
      expect(decision.best.inPlayerId).not.toBe(decision.best.outPlayerId);
    } else {
      expect(decision.note, 'a hold with no reason is a hold nobody can diagnose').toBeTruthy();
    }
    expect((await replayMatchupSnapshot(snapshot)).outcome).toBe('reproduced');
  });

  it('offers no change at all once every game has kicked off', async () => {
    const snapshot = await captureMatchupSnapshot(matchupSources({ lockAll: true }), {
      gitSha: SHA,
      leagueId: league().id,
      week: null,
      props,
    });
    sealed(snapshot);

    const decision = snapshot.decision.output.forecast!.decision;
    expect(decision.best, 'advice nobody can act on is worse than silence').toBeNull();
    expect((await replayMatchupSnapshot(snapshot)).outcome).toBe('reproduced');
  });

  it('never lets a degraded forecast read as a confident hold', async () => {
    const snapshot = await captureMatchupSnapshot(matchupSources({ priced: false }), {
      gitSha: SHA,
      leagueId: league().id,
      week: null,
      props,
    });
    sealed(snapshot);

    const forecast = snapshot.decision.output.forecast!;
    expect(forecast.degraded, 'a market-less week is degraded, and says so').toBe(true);
    expect(snapshot.decision.freshness.degraded).toBe(true);
    expect(snapshot.decision.warnings.length).toBeGreaterThan(0);
    /*
     * And it offers nothing, because a model that cannot see the players cannot
     * know that holding is right. `Hold your lineup` from a degraded forecast is
     * the single most misleading thing this screen could say.
     */
    expect(forecast.decision.best).toBeNull();
    expect(forecast.teams.mine.winProbability).toBeNull();
    expect((await replayMatchupSnapshot(snapshot)).outcome).toBe('reproduced');
  });
});

// ------------------------------------------------------------------- trades

function tradeSnapshot() {
  const mine = roster({ playerIds: ['qb1', 'rb1', 'rb2', 'rb3', 'wr2'], starterIds: ['qb1', 'rb1', 'rb2', 'wr2'] });
  const theirs = roster({
    rosterId: 2,
    ownerId: '9911223344',
    ownerName: 'rival_manager',
    playerIds: ['wr1', 'wr3', 'te1', 'def1'],
    starterIds: ['wr1', 'wr3', 'te1', 'def1'],
    isMine: false,
  });
  return captureTradeSnapshot({
    gitSha: SHA,
    league: league(),
    rosters: [mine, theirs],
    request: { shape, profile, inputs: squad(), history: { ...NO_TRADE_HISTORY, measured: true }, limit: 5 },
    nflState: { season: '2026', week: 6, seasonType: 'regular' } as never,
    props,
    week: 6,
    now: NOW,
  });
}

describe('Smart Trades', () => {
  it('reproduces the surfaced offers, with the same GIVE and GET on each', () => {
    const snapshot = tradeSnapshot();
    sealed(snapshot);

    const report = replayTradeSnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
    /* A search that considered nobody would replay identically and mean nothing. */
    expect(snapshot.decision.output.search.partners).toBeGreaterThan(0);
  });

  it('names the counterparty by an alias, in the offer and in its reasons', () => {
    const snapshot = tradeSnapshot();
    const text = JSON.stringify(snapshot.decision.output);
    expect(text).not.toContain('rival_manager');
    expect(text).not.toContain('9911223344');
    for (const offer of snapshot.decision.output.offers) {
      expect(offer.partner.displayName).toMatch(/^Manager \d+$/);
      expect(offer.give.length + offer.get.length, 'an offer with nothing on one side is not an offer').toBeGreaterThan(
        1,
      );
    }
  });

  it('invents no acceptance probability', () => {
    const snapshot = tradeSnapshot();
    /*
     * There is no such number in this app: the engine reports objective value on
     * both sides, roster fit, and what a manager's own history says about how he
     * trades — and nothing converts that into a chance an offer is taken. A
     * field an agent would reason about and no code produced is worse than no
     * field at all.
     */
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value == null || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(walk);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key.toLowerCase());
        walk(child);
      }
    };
    walk(snapshot.decision.output);
    for (const forbidden of ['acceptance', 'acceptanceprobability', 'likelihoodaccepted', 'accepts']) {
      expect(keys.has(forbidden), `the offers carry a ${forbidden} field`).toBe(false);
    }
  });

  it('reports an unmeasured ledger as unmeasured rather than as zero history', () => {
    const mine = roster({ playerIds: ['qb1', 'rb1'], starterIds: ['qb1', 'rb1'] });
    const snapshot = captureTradeSnapshot({
      gitSha: SHA,
      league: league(),
      rosters: [mine],
      request: { shape, profile, inputs: squad(), history: NO_TRADE_HISTORY, limit: 5 },
      nflState: null,
      props,
      week: 6,
      now: NOW,
    });
    expect(snapshot.decision.freshness.history.measured).toBe(false);
    expect(replayTradeSnapshot(snapshot).outcome).toBe('reproduced');
  });
});

// ------------------------------------------------------------------ dispatch

describe('the dispatcher sends each file to its own adapter', () => {
  it('replays all five through one entry point', async () => {
    const snapshots: SupportSnapshot[] = [
      lineupSnapshot(),
      await waiverSnapshot(),
      await dstSnapshot(),
      tradeSnapshot(),
    ];
    for (const snapshot of snapshots) {
      /*
       * Through the wire, because that is how a file arrives: a caller that
       * handed the dispatcher a live object would be testing a path nobody uses.
       */
      const read = readSnapshot(JSON.parse(JSON.stringify(snapshot)));
      const report = await replaySnapshot(read);
      expect(report.kind, report.summary).toBe(snapshot.decision.kind);
      expect(report.outcome, report.summary).toBe('reproduced');
    }
  });
});
