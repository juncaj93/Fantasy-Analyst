/**
 * Waivers round 8 (November 2026 review, W5 and W10; Alex's decisions of
 * 5 November 2026): the block line, the upside stash, the week 16 return
 * cutoff, a rival's Doubtful starter counted as Out, and last week's top
 * free-agent scorers in the scan.
 *
 * Every describe block here fails on the code before round 8: the functions
 * did not exist, the cutoff was week 14, and the competition read counted a
 * Doubtful rival starter as available.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { captureDemoWaivers, DEMO_WAIVER_CLOCK, type CapturedWaivers } from './helpers/waiverDecision.ts';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';
import type { SupportSnapshot } from '../src/core/support/schema.ts';
import type { WaiverPlanPayload } from '../src/core/support/payloads.ts';
import { blockPickup, BLOCK_RULES, type BlockCandidate, type BlockPlayer, type BlockRequest } from '../src/core/waivers/block.ts';
import { eliteBackRates, stashScanIds, upsideStash, type StashCandidate, type StashPlayer, type UpsideStashRequest } from '../src/core/waivers/upsideStash.ts';
import { stashVerdict, STASH_RULES, type StashVerdict } from '../src/core/waivers/stash.ts';
import { positionNeed } from '../src/core/waivers/rivalNeed.ts';
import { waiverLeagueIntel } from '../src/core/waivers/intel.ts';
import { lastWeekScorerIds } from '../src/core/roster/freeAgents.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { extraLine, roomLine } from '../src/web/waiverCard.ts';
import { PLAYOFF_RESERVE, playoffReserve } from '../src/core/faab/budget.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';
import type { Designation } from '../src/core/injury/model.ts';
import type { WaiverAdvice } from '../src/core/startsit/waivers.ts';

/* Tony's Pizza Fantasy: QB, 2 RB, 3 WR, TE, 2 FLEX, DEF, 6 bench, 2 IR. */
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'IR', 'IR']);
const DEF = new Set(['DEF']);

// ------------------------------------------------------------------ block

function opp(id: string, position: string, points: number, over: Partial<BlockPlayer> = {}): BlockPlayer {
  return { playerId: id, name: `Their ${id}`, position, team: 'KC', points, designation: 'healthy', onBye: false, ...over };
}

function fa(id: string, position: string, points: number, over: Partial<BlockCandidate> = {}): BlockCandidate {
  return { playerId: id, name: `Free ${id}`, position, team: 'DET', points, designation: 'healthy', onBye: false, addable: true, free: false, ...over };
}

/** A sound opponent: every slot filled by a real starter, a healthy bench behind. */
function opponentRoster(over: Record<string, Partial<BlockPlayer>> = {}): BlockPlayer[] {
  const base = [
    opp('qb', 'QB', 19),
    opp('rb1', 'RB', 15),
    opp('rb2', 'RB', 13),
    opp('wr1', 'WR', 16),
    opp('wr2', 'WR', 14),
    opp('wr3', 'WR', 12),
    opp('te', 'TE', 9),
    opp('flex1', 'WR', 11),
    opp('flex2', 'RB', 10.5),
    opp('bench-wr', 'WR', 6),
    opp('bench-rb', 'RB', 5),
  ];
  return base.map((p) => ({ ...p, ...(over[p.playerId] ?? {}) }));
}

function blockRequest(over: Partial<BlockRequest> = {}): BlockRequest {
  return {
    shape: SHAPE,
    opponent: { rosterId: 7, roster: opponentRoster() },
    candidates: [fa('wr', 'WR', 10)],
    taken: new Set(),
    excludedPositions: DEF,
    room: [{ kind: 'drop', playerId: 'dead', name: 'Antonio Williams' }],
    spendable: 36,
    usesFaab: true,
    ...over,
  };
}

describe('block: only this week’s opponent, only a real need', () => {
  it('blocks the free agent who covers the opponent’s WR on bye', () => {
    const req = blockRequest({ opponent: { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) } });
    const line = blockPickup(req);
    expect(line).toMatchObject({ playerId: 'wr', reason: 'opponent needs a WR', bid: { kind: 'claim', low: 3, high: 3 } });
    expect(line!.detail).toBe('his WR Their wr1 is on bye');
    expect(line!.gain).toBeGreaterThanOrEqual(BLOCK_RULES.margin);
  });

  it('reads a Doubtful starter as Out (the shared availability rule)', () => {
    const line = blockPickup(blockRequest({ opponent: { rosterId: 7, roster: opponentRoster({ wr1: { designation: 'doubtful' } }) } }));
    expect(line?.detail).toBe('his WR Their wr1 is Doubtful');
  });

  it('does not block when his bench covers the hole within the toss-up bar', () => {
    /* WR1 out, but his bench WR at 9.5 against the free agent's 10: a coin flip for him. */
    const roster = opponentRoster({ wr1: { designation: 'out' }, 'bench-wr': { points: 9.5 } });
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster } }))).toBeNull();
  });

  it('does not block a healthy opponent the free agent would not start for', () => {
    expect(blockPickup(blockRequest())).toBeNull();
  });

  it('blocks over a weak starter only by a real margin (2 points)', () => {
    const roster = opponentRoster({ te: { points: 5 } });
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, candidates: [fa('te', 'TE', 6.5)] }))).toBeNull();
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster }, candidates: [fa('te', 'TE', 7.2)] }))?.detail).toBe(
      'his TE Their te is weak this week',
    );
  });

  it('never runs without a weekly opponent (no stored pairing, or a bye week)', () => {
    expect(blockPickup(blockRequest({ opponent: null }))).toBeNull();
  });

  it('bids one number, never above $3 (round 20: a WR block is the league price, capped at $3)', () => {
    const line = blockPickup(blockRequest({ opponent: { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) }, spendable: 80 }));
    expect(line?.bid).toEqual({ kind: 'claim', low: BLOCK_RULES.maxBid, high: BLOCK_RULES.maxBid });
  });

  it('never takes him under $20 for the playoffs', () => {
    const hole = { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) };
    /* $21 left: $1 spendable above the reserve, so the block bids $1 at most. */
    const tight = playoffReserve(21, { week: 10, finalWeek: 14 });
    expect(blockPickup(blockRequest({ opponent: hole, spendable: tight.spendable }))?.bid).toEqual({ kind: 'claim', low: 1, high: 1 });
    /* $20 left: nothing to spend, no block. */
    const none = playoffReserve(PLAYOFF_RESERVE, { week: 10, finalWeek: 14 });
    expect(blockPickup(blockRequest({ opponent: hole, spendable: none.spendable }))).toBeNull();
    expect(blockPickup(blockRequest({ opponent: hole, spendable: null }))).toBeNull();
  });

  it('costs no starter: no open spot and no drop-ready player means no block', () => {
    expect(blockPickup(blockRequest({ opponent: { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) }, room: [] }))).toBeNull();
  });

  it('never blocks a player who cannot be in a lineup before his game, or one already on another line', () => {
    const hole = { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) };
    expect(blockPickup(blockRequest({ opponent: hole, candidates: [fa('wr', 'WR', 10, { addable: false })] }))).toBeNull();
    expect(blockPickup(blockRequest({ opponent: hole, taken: new Set(['wr']) }))).toBeNull();
  });

  it('needs no bid for a free agent', () => {
    const line = blockPickup(blockRequest({ opponent: { rosterId: 7, roster: opponentRoster({ wr1: { onBye: true } }) }, candidates: [fa('wr', 'WR', 10, { free: true })] }));
    expect(line?.bid).toEqual({ kind: 'free' });
  });
});

// ------------------------------------------------------------------ stash

function mine(id: string, position: string, seasonRate: number, over: Partial<StashPlayer> = {}): StashPlayer {
  return { playerId: id, name: `My ${id}`, position, team: 'GB', seasonRate, designation: 'healthy', ...over };
}

/* Alex's lineup on season numbers: weakest skill starter 9 (the second FLEX). */
const ROSTER: StashPlayer[] = [
  mine('qb', 'QB', 22),
  mine('rb1', 'RB', 16),
  mine('rb2', 'RB', 12),
  mine('wr1', 'WR', 15),
  mine('wr2', 'WR', 13),
  mine('wr3', 'WR', 11),
  mine('te', 'TE', 8),
  mine('flex1', 'RB', 10),
  mine('flex2', 'WR', 9),
  mine('bench1', 'WR', 6),
];

function cand(id: string, position: string, seasonRate: number, over: Partial<StashCandidate> = {}): StashCandidate {
  return { playerId: id, name: `Free ${id}`, position, team: 'ATL', seasonRate, designation: 'healthy', free: false, helpsNow: false, ...over };
}

function stashRequest(over: Partial<UpsideStashRequest> = {}): UpsideStashRequest {
  return {
    shape: SHAPE,
    roster: ROSTER,
    candidates: [],
    taken: new Set(),
    excludedPositions: DEF,
    verdicts: new Map(),
    reserveTakes: (d) => d === 'ir',
    room: { reserve: 0, open: 0, dropReady: [{ playerId: 'bench1', name: 'Antonio Williams' }] },
    players: [],
    depthOrder: new Map(),
    injuryStatus: new Map(),
    elite: new Map(),
    spendable: 36,
    usesFaab: true,
    ...over,
  };
}

const backBy = (week: number): StashVerdict => ({ kind: 'back_by', week, label: `back around week ${week}` });

describe('upside stash: a real path to playoff value', () => {
  it('stashes an injured free agent back by week 16 who would start for you', () => {
    const line = upsideStash(
      stashRequest({ candidates: [cand('hurt', 'WR', 14, { designation: 'ir' })], verdicts: new Map([['hurt', backBy(13)]]) }),
    );
    expect(line).toMatchObject({ playerId: 'hurt', reason: 'back around week 13', path: { kind: 'returning' }, bid: { kind: 'claim', low: 1, high: 1 } });
    expect(line!.room).toEqual({ kind: 'drop', playerId: 'bench1', name: 'Antonio Williams' });
  });

  it('puts him straight on IR when an IR slot is open and takes him', () => {
    const line = upsideStash(
      stashRequest({
        candidates: [cand('hurt', 'WR', 14, { designation: 'ir' })],
        verdicts: new Map([['hurt', backBy(13)]]),
        room: { reserve: 1, open: 0, dropReady: [] },
      }),
    );
    expect(line?.room).toEqual({ kind: 'reserve' });
  });

  it('never stashes a return that is too late, unknown or season-ending', () => {
    for (const verdict of [
      { kind: 'too_late', week: 17, label: 'back around week 17, too late for the playoffs' },
      { kind: 'unknown', label: 'return unknown' },
      { kind: 'season_ending', label: 'out for the season (Knee - ACL)' },
    ] as StashVerdict[]) {
      expect(upsideStash(stashRequest({ candidates: [cand('hurt', 'WR', 14, { designation: 'ir' })], verdicts: new Map([['hurt', verdict]]) }))).toBeNull();
    }
  });

  it('never stashes a player who would not start for you even when healthy', () => {
    expect(
      upsideStash(stashRequest({ candidates: [cand('hurt', 'WR', 7, { designation: 'ir' })], verdicts: new Map([['hurt', backBy(12)]]) })),
    ).toBeNull();
  });

  it('never forces a worse drop: no open spot and no drop-ready player means no stash', () => {
    expect(
      upsideStash(
        stashRequest({
          candidates: [cand('hurt', 'WR', 14, { designation: 'ir' })],
          verdicts: new Map([['hurt', backBy(13)]]),
          room: { reserve: 0, open: 0, dropReady: [] },
        }),
      ),
    ).toBeNull();
  });

  it('leaves a player who helps this week to the pickup tiers', () => {
    expect(upsideStash(stashRequest({ candidates: [cand('now', 'WR', 14, { designation: 'out', helpsNow: true })], verdicts: new Map([['now', backBy(11)]]) }))).toBeNull();
  });

  const PLAYERS = [
    { id: 'star', fullName: 'Star Back', team: 'ATL', position: 'RB' },
    { id: 'cuff', fullName: 'Next Back', team: 'ATL', position: 'RB' },
  ];
  const nextUp = (status: string | null, depth = 2) =>
    stashRequest({
      candidates: [cand('cuff', 'RB', 5)],
      players: PLAYERS,
      depthOrder: new Map([
        ['star', 1],
        ['cuff', depth],
      ]),
      injuryStatus: new Map([['star', status]]),
      elite: new Map([['star', 19.4]]),
    });

  it('stashes the next man up behind a hurt top back', () => {
    const line = upsideStash(nextUp('Questionable'));
    expect(line).toMatchObject({ playerId: 'cuff', reason: 'next up behind Star Back, hurt', path: { kind: 'next_man_up', starterId: 'star' } });
  });

  it('never stashes a backup to a healthy starter, or a third-stringer', () => {
    expect(upsideStash(nextUp(null))).toBeNull();
    expect(upsideStash(nextUp('Questionable', 3))).toBeNull();
  });

  it('scans the backs behind hurt top backs, free agents only', () => {
    const players = PLAYERS.map((p) => ({ ...p, active: true }));
    const opts = {
      players,
      exclude: new Set<string>(),
      depthOrder: new Map([
        ['star', 1],
        ['cuff', 2],
      ]),
      injuryStatus: new Map([['star', 'IR']]),
      elite: new Map([['star', 19.4]]),
    };
    expect(stashScanIds({ ...opts, rosteredIds: new Set(['star']) })).toEqual(['cuff']);
    expect(stashScanIds({ ...opts, rosteredIds: new Set(['star', 'cuff']) })).toEqual([]);
  });

  it('reads top backs by points a game, from the stored season row', () => {
    const season = new Map<string, number[]>([['star', [20, 18, 0, 22, 19]]]);
    expect(eliteBackRates(season, () => true).get('star')).toBe(19.75);
  });
});

// ------------------------------------------------------------------ IR cutoff

describe('IR stash cutoff: back by week 16 still helps a playoff run', () => {
  it('is week 16 in the one place it lives', () => {
    expect(STASH_RULES.lastReturnWeek).toBe(16);
  });

  it('keeps a player back in week 15 or 16, and refuses week 17', () => {
    const at = (week: number, notes: string) => stashVerdict({ designation: 'ir', note: { status: 'IR', bodyPart: 'Hamstring', notes }, week });
    expect(at(10, 'out 5 weeks')).toMatchObject({ kind: 'back_by', week: 15 });
    expect(at(10, 'out 6 weeks')).toMatchObject({ kind: 'back_by', week: 16 });
    expect(at(10, 'out 7 weeks')).toMatchObject({ kind: 'too_late', week: 17 });
    expect(at(10, 'out 7 weeks').label).toBe('back around week 17, too late for the playoffs');
  });

  it('reads a plain Out in week 15 as back for week 16', () => {
    expect(stashVerdict({ designation: 'out', note: { status: 'Out', bodyPart: 'Ankle', notes: null }, week: 15 }).kind).toBe('back_by');
    expect(stashVerdict({ designation: 'out', note: { status: 'Out', bodyPart: 'Ankle', notes: null }, week: 16 }).kind).toBe('too_late');
  });
});

// ------------------------------------------------------------------ rival Doubtful

describe('a rival’s Doubtful starter counts as Out', () => {
  function player(id: string, position: string, status: string | null): CanonicalPlayer {
    return { id, sleeperPlayerId: id, fullName: `P ${id}`, firstName: 'P', lastName: id, team: 'SF', position, status, active: true, normalizedName: id, aliases: [] };
  }
  const advice: Pick<WaiverAdvice, 'upgrades'> = {
    upgrades: [
      {
        slot: 'QB',
        accepts: ['QB'],
        need: 'upgrade',
        currentPlayerId: 'my-qb',
        currentName: 'P my-qb',
        currentScore: 14,
        bar: 14,
        candidates: [{ playerId: 'free-qb', name: 'P free-qb', position: 'QB', team: 'SF', score: 18, gain: 4, reasons: [], statusFlag: null, role: { trend: 'stable', games: 4 } }],
      },
    ],
  };
  const intelWith = (status: string, designations?: Record<string, Designation>) =>
    waiverLeagueIntel({
      advice,
      rosters: [
        { rosterId: 1, ownerName: 'Alex', isMine: true, playerIds: ['my-qb'] },
        { rosterId: 2, ownerName: 'Rival', isMine: false, playerIds: ['rival-qb'] },
      ],
      players: [player('my-qb', 'QB', null), player('rival-qb', 'QB', status), player('free-qb', 'QB', null)],
      shape: SHAPE,
      ...(designations ? { designations } : {}),
      budgets: null,
      prices: null,
    }).competition.get('free-qb')!;

  it('in the competition read: his only QB Doubtful is a team that needs a QB', () => {
    expect(intelWith('Doubtful').needyTeams).toBe(1);
    expect(intelWith('Questionable').needyTeams).toBe(0);
  });

  it('takes the injury report’s worse status when the caller resolved it', () => {
    expect(intelWith('Questionable', { 'rival-qb': 'doubtful' }).needyTeams).toBe(1);
  });

  it('in the need-aware bid read, through the same shared rule', () => {
    const need = (status: string | null, designation?: Designation) =>
      positionNeed(
        {
          starters: { QB: 1 },
          weeks: [10, 11],
          roster: [{ playerId: 'q', name: 'Q', position: 'QB', team: 'SF', status, ...(designation ? { designation } : {}) }],
          onBye: () => false,
        },
        'QB',
      ).state;
    expect(need('Doubtful')).toBe('hole');
    expect(need('D')).toBe('hole');
    expect(need('Questionable', 'doubtful')).toBe('hole');
    expect(need('Questionable')).not.toBe('hole');
  });
});

// ------------------------------------------------------------------ W10

describe('the scan reads last week’s top free-agent scorers (W10)', () => {
  const p = (id: string, position: string, active = true): CanonicalPlayer => ({
    id,
    sleeperPlayerId: id,
    fullName: `P ${id}`,
    firstName: 'P',
    lastName: id,
    team: 'NE',
    position,
    status: null,
    active,
    normalizedName: id,
    aliases: [],
  });
  const players = [p('breakout', 'WR'), p('steady', 'WR'), p('quiet', 'WR'), p('fourth', 'WR'), p('owned', 'WR'), p('gone', 'WR', false), p('dst', 'DEF')];
  /* Week 9 is the last finished week (index 8). */
  const pts = (w9: number) => [...Array(8).fill(4), w9];
  const seasonPoints = { breakout: pts(24.5), steady: pts(12), quiet: pts(9), fourth: pts(7), owned: pts(30), gone: pts(28), dst: pts(20) };

  it('takes the top three free agents a position by last week’s points', () => {
    const ids = lastWeekScorerIds(players, { rosteredIds: new Set(['owned']), startable: new Set(['WR', 'DEF']), seasonPoints, week: 9, exclude: new Set() });
    expect(ids).toEqual(['breakout', 'steady', 'quiet']);
  });

  it('skips anyone already scanned, rostered, inactive, or a defence', () => {
    const ids = lastWeekScorerIds(players, { rosteredIds: new Set(['owned']), startable: new Set(['WR', 'DEF']), seasonPoints, week: 9, exclude: new Set(['breakout']) });
    expect(ids).toEqual(['steady', 'quiet', 'fourth']);
  });

  it('reads nothing before a week has finished', () => {
    expect(lastWeekScorerIds(players, { rosteredIds: new Set(), startable: new Set(), seasonPoints, week: 0, exclude: new Set() })).toEqual([]);
  });
});

// ------------------------------------------------------------------ the words

describe('the two lines, in Alex’s words', () => {
  it('says the block as "Block: Name (opponent needs a WR), bid $1 to $3"', () => {
    expect(extraLine('block', { name: 'Jalen Coker', reason: 'opponent needs a WR', bid: { kind: 'claim', low: 1, high: 3 } })).toBe(
      'Block: Jalen Coker (opponent needs a WR), bid $1 to $3',
    );
  });

  it('says the stash with its bid, or no bid for a free agent', () => {
    expect(extraLine('stash', { name: 'Tank Bigsby', reason: 'next up behind Travis Etienne, hurt', bid: { kind: 'claim', low: 0, high: 1 } })).toBe(
      'Stash: Tank Bigsby (next up behind Travis Etienne, hurt), bid $0 to $1',
    );
    expect(extraLine('stash', { name: 'A', reason: 'back around week 13', bid: { kind: 'free' } })).toBe('Stash: A (back around week 13), free agent, no bid');
    expect(extraLine('block', { name: 'B', reason: 'opponent needs a TE', bid: { kind: 'claim', low: 1, high: 1 } })).toBe('Block: B (opponent needs a TE), bid $1');
  });

  it('says the spot it uses', () => {
    expect(roomLine({ kind: 'reserve' })).toBe('Open IR slot');
    expect(roomLine({ kind: 'open' })).toBe('Open bench spot');
    expect(roomLine({ kind: 'drop', playerId: 'x', name: 'Antonio Williams' })).toBe('Drop Antonio Williams (drop-ready)');
  });

  it('has no em-dash anywhere Alex reads', () => {
    for (const text of [
      extraLine('block', { name: 'B', reason: 'opponent needs a WR', bid: { kind: 'claim', low: 1, high: 3 } }),
      roomLine({ kind: 'drop', playerId: 'x', name: 'Y' }),
    ])
      expect(text).not.toContain('—');
  });
});

// ------------------------------------------------------------------ the whole assembly

/*
 * The seeded league through the real router's support snapshot, then the same
 * request through `assembleWaiverPlan` with this week's opponent added: his
 * only receiver ruled out on the injury report. The block line is the
 * engine's answer, not a hand-built one.
 */
describe('the assembly draws the block for this week’s opponent only', () => {
  let captured: CapturedWaivers;
  beforeAll(async () => {
    captured = await captureDemoWaivers();
  });

  async function replay(opponent: { rosterId: number; designations: Record<string, Designation> } | null) {
    const { request } = waiverRequestFromSnapshot(captured.snapshot as unknown as SupportSnapshot<WaiverPlanPayload>);
    const rival = request.rosters.find((r) => !r.isMine)!;
    const byName = new Map(request.players.map((p) => [p.fullName, p.id] as const));
    const published = new Map<string, number>([
      [rival.playerIds[0]!, 15],
      [byName.get('Kai Brennan')!, 11],
      [byName.get('Dane Petrossian')!, 9],
    ]);
    /*
     * Replayed on the clock it was captured on, as `waiverCard.test.ts` does:
     * part of the assembly reads the real clock, so a real-clock replay
     * drifts with the calendar (round 20).
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(DEMO_WAIVER_CLOCK));
    try {
      const tiers = (await assembleWaiverPlan({ ...request, published, opponent })).tiers!;
      return { tiers, rival };
    } finally {
      vi.useRealTimers();
    }
  }

  it('blocks the free receiver his Out receiver leaves him needing', async () => {
    const { rival } = await replay(null);
    const { tiers } = await replay({ rosterId: rival.rosterId, designations: { [rival.playerIds[0]!]: 'out' } });
    expect(tiers.block).toMatchObject({ name: 'Kai Brennan', reason: 'opponent needs a WR' });
    expect(tiers.block!.bid).toMatchObject({ kind: expect.stringMatching(/^(claim|free)$/) });
    if (tiers.block!.bid.kind === 'claim') expect(tiers.block!.bid.high).toBeLessThanOrEqual(3);
    /* One player, one line: never also a pickup or a Watch list name. */
    const elsewhere = [...(tiers.doThese ?? []), ...tiers.consider, ...tiers.watch].map((r) => r.playerId);
    expect(elsewhere).not.toContain(tiers.block!.playerId);
  });

  it('says nothing without a stored opponent', async () => {
    const { tiers } = await replay(null);
    expect(tiers.block ?? null).toBeNull();
  });

  it('reads the opponent through the worse status: Doubtful on the report is his receiver out', async () => {
    const { rival } = await replay(null);
    const id = rival.playerIds[0]!;
    const doubtful = await replay({ rosterId: rival.rosterId, designations: { [id]: 'doubtful' } });
    expect(doubtful.tiers.block?.detail).toBe('his WR Devin Okafor is Doubtful');
    const healthy = await replay({ rosterId: rival.rosterId, designations: {} });
    expect(healthy.tiers.block?.detail).not.toMatch(/Doubtful|Out/);
  });
});
