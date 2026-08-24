/**
 * Historical manager behaviour, and the bounded thing it is allowed to do.
 *
 * Three separate claims are being pinned here, and they fail in different ways:
 *
 *   - **The reconstruction is honest.** It follows the previous-league chain,
 *     identifies a manager by the only key that survives a season boundary, and
 *     refuses to invent a market price that Sleeper does not publish. The
 *     failure mode is silent and severe: a profile confidently describing
 *     somebody else.
 *   - **The tendency math shrinks.** Almost every real profile rests on one or
 *     two drafts. A model that reported those at face value would be reporting
 *     noise in a font that looks like signal.
 *   - **The effect stays small and stays in its lane.** It may move `Next%` by
 *     a few points and it may not touch `Score`, `ADP`, `DOG` or `PTS` at all.
 *
 * Numbers are asserted only where they are not judgement calls — the ceiling,
 * the identity, the byte-for-byte equalities. Everything else is directional,
 * for the reason `nextpick.simulate.test.ts` gives at length: pinning a
 * constant that was chosen rather than measured just makes it expensive to
 * improve.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANAGER_HISTORY_CEILING,
  clearNextPickCache,
  estimateNextPickAvailability,
  readManagerPrior,
  slotsAheadOf,
  type ManagerPriorResult,
} from '../src/core/draft/nextpick/index.ts';
import { buildPickOwnership } from '../src/core/draft/nextpick/ownership.ts';
import { positionsInPlay } from '../src/core/draft/nextpick/demand.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import {
  fromStoredTendencies,
  neutralTendencies,
  readManagerTendencies,
  toStoredTendencies,
  type ManagerTendencies,
} from '../src/core/managers/managerTendencies.ts';
import { buildManagerDraftProfile, type HistoricalPick } from '../src/core/managers/draftProfile.ts';
import {
  MY_SLOT,
  ROUNDS,
  TEAMS,
  allSlots,
  buildBoard,
  neutralHistory,
  neutralUniverse,
} from './helpers/nextpick.ts';
import type { PositionCounts } from '../src/core/draft/nextpick/demand.ts';

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']);
const POSITIONS = positionsInPlay(SHAPE);
const DRAFT_ROUNDS = 16;
const DRAFT_TEAMS = 10;

/**
 * A whole historical draft, with named managers and dictated habits.
 *
 * Managers are named up front rather than renamed afterwards, because the habit
 * map is keyed by manager: renaming after the fact silently looked up the wrong
 * key and produced a fixture that tested nothing while still passing.
 *
 * Everybody not named in `qbRound`/`teRound` takes theirs in the room's round,
 * so "earlier than the room" is a property the test sets rather than one it
 * hopes for. Every other pick alternates back and receiver, which holds the
 * positional mix identical between two drafts differing in one habit.
 */
function historicalDraft(opts: {
  draftId: string;
  season: string;
  /** Manager name -> the round he takes his first QB. */
  qbRound?: Record<string, number>;
  teRound?: Record<string, number>;
  roomQbRound?: number;
  roomTeRound?: number;
  users?: string[];
}): HistoricalPick[] {
  const users = opts.users ?? Array.from({ length: DRAFT_TEAMS }, (_, i) => `u${i + 1}`);
  const roomQb = opts.roomQbRound ?? 8;
  const roomTe = opts.roomTeRound ?? 12;
  const out: HistoricalPick[] = [];

  for (let round = 1; round <= DRAFT_ROUNDS; round++) {
    for (let seat = 1; seat <= users.length; seat++) {
      // A snake, so a seat's slot alternates by round — exactly the sort of
      // thing that must not change who a pick belongs to.
      const indexInRound = round % 2 === 0 ? users.length - seat + 1 : seat;
      const userId = users[indexInRound - 1]!;
      const pickNo = (round - 1) * users.length + seat;
      const qb = opts.qbRound?.[userId] ?? roomQb;
      const te = opts.teRound?.[userId] ?? roomTe;
      const position = round === qb ? 'QB' : round === te ? 'TE' : pickNo % 2 === 0 ? 'RB' : 'WR';
      out.push({
        season: opts.season,
        draftId: opts.draftId,
        pickNo,
        round,
        userId,
        rosterId: indexInRound,
        position,
        marketRank: null,
        yearsExp: 3,
      });
    }
  }
  return out;
}

/** The default ten managers with one renamed, so habits can be keyed by name. */
function usersWith(...named: string[]): string[] {
  const rest = Array.from({ length: DRAFT_TEAMS - named.length }, (_, i) => `u${i + named.length + 1}`);
  return [...named, ...rest];
}

function tendenciesFor(picks: HistoricalPick[]): Map<string, ManagerTendencies> {
  return readManagerTendencies({ picks, positions: POSITIONS, rounds: DRAFT_ROUNDS, latestSeason: '2025' });
}

// ---------------------------------------------------------------------------

describe('historical reconstruction (§2)', () => {
  it('identifies a manager by user id even when his roster id changes every season', () => {
    /*
     * The manager moves seats: roster 7, then roster 2, then roster 9. His
     * quarterback habit is the same all three years. Keyed by user id he is one
     * consistent drafter; keyed by roster id he is three strangers.
     */
    const users = usersWith('mover');
    const seatBySeason: Record<string, number> = { '2023': 7, '2024': 2, '2025': 9 };
    const picks = ['2023', '2024', '2025'].flatMap((season, i) =>
      historicalDraft({ draftId: `d${i}`, season, users, qbRound: { mover: 2 } }).map((p) =>
        // Same man, a different seat every year. Only `rosterId` moves.
        p.userId === 'mover' ? { ...p, rosterId: seatBySeason[season]! } : p,
      ),
    );

    const byUser = tendenciesFor(picks).get('mover');
    expect(byUser?.usable).toBe(true);
    expect(byUser?.draftsObserved).toBe(3);
    // He takes quarterbacks six rounds before the room, so demand is positive.
    expect(byUser!.byPosition.get('QB')!.lift).toBeGreaterThan(0);
  });

  it('refuses to hand a roster id’s history to whoever holds it now', () => {
    /*
     * The real case from the league this was built against: roster 4 belonged
     * to three different people in three seasons. A newcomer inheriting it must
     * inherit nothing.
     */
    const picks = historicalDraft({ draftId: 'd1', season: '2024', qbRound: { u4: 1 } });
    const newcomer = buildManagerDraftProfile({ rosterId: 4, userId: 'brand-new', picks });
    expect(newcomer.picksObserved).toBe(0);
    expect(newcomer.confident).toBe(false);

    // And the manager who actually made those picks still has them.
    const incumbent = buildManagerDraftProfile({ rosterId: 4, userId: 'u4', picks });
    expect(incumbent.picksObserved).toBe(DRAFT_ROUNDS);
  });

  it('claims nothing for a manager it cannot identify at all', () => {
    const picks = historicalDraft({ draftId: 'd1', season: '2024' });
    const unmatched = buildManagerDraftProfile({ rosterId: 1, userId: null, picks });
    expect(unmatched.picksObserved).toBe(0);
    expect(unmatched.notes.join(' ')).toContain('not enough');
  });

  it('survives a missing prior season and an empty history', () => {
    expect(tendenciesFor([]).size).toBe(0);
    const only = tendenciesFor(historicalDraft({ draftId: 'd1', season: '2025' }));
    // One draft is enough to be read, but every manager is close to the room.
    expect(only.get('u1')?.usable).toBe(true);
  });

  it('drops picks with no position rather than counting them as a position', () => {
    const picks = historicalDraft({ draftId: 'd1', season: '2025', qbRound: { u1: 2 } }).map((p) =>
      p.userId === 'u2' ? { ...p, position: null } : p,
    );
    const read = tendenciesFor(picks);
    // u2's picks were all unreadable, so he falls below the minimum entirely.
    expect(read.get('u2')?.usable ?? false).toBe(false);
    expect(read.get('u1')?.usable).toBe(true);
  });
});

describe('tendency math (§3, §5)', () => {
  const pair = usersWith('early', 'late');
  const twoConsistent = ['2024', '2025'].flatMap((season, i) =>
    historicalDraft({ draftId: `d${i}`, season, users: pair, qbRound: { early: 2, late: 15 } }),
  );

  it('reads an early-quarterback manager as wanting quarterbacks sooner', () => {
    const qb = tendenciesFor(twoConsistent).get('early')!.byPosition.get('QB')!;
    expect(qb.medianFirstRound).toBe(2);
    expect(qb.roomMedianFirstRound).toBeGreaterThan(2);
    expect(qb.lift).toBeGreaterThan(0);
  });

  it('reads a wait-on-quarterback manager as wanting them later', () => {
    const qb = tendenciesFor(twoConsistent).get('late')!.byPosition.get('QB')!;
    expect(qb.medianFirstRound).toBe(15);
    expect(qb.lift).toBeLessThan(0);
  });

  it('shrinks a manager who disagrees with himself below one who does not', () => {
    /*
     * The test the whole shrinkage design exists for, and the one sample size
     * alone cannot pass. Both managers have exactly two drafts. `steady` took
     * his quarterback in round 4 twice; `erratic` took his in rounds 7 and 16,
     * whose mean of 11.5 is a confident-looking claim about a man who has not
     * made one.
     */
    const users = usersWith('steady', 'erratic');
    const picks = [
      ...historicalDraft({ draftId: 'd1', season: '2024', users, qbRound: { steady: 4, erratic: 7 } }),
      ...historicalDraft({ draftId: 'd2', season: '2025', users, qbRound: { steady: 4, erratic: 16 } }),
    ];

    const read = tendenciesFor(picks);
    const steady = read.get('steady')!.byPosition.get('QB')!;
    const erratic = read.get('erratic')!.byPosition.get('QB')!;

    expect(steady.spread).toBe(0);
    expect(erratic.spread!).toBeGreaterThan(4);
    expect(steady.confidence).toBeGreaterThan(erratic.confidence);
    // And the erratic manager's *signal* is weaker, not merely his label.
    expect(Math.abs(erratic.lift)).toBeLessThan(Math.abs(steady.lift));
  });

  it('lets more drafts say more than fewer drafts of the same habit', () => {
    const users = usersWith('early');
    const habit = { early: 2 };
    const one = tendenciesFor(historicalDraft({ draftId: 'd1', season: '2025', users, qbRound: habit }));
    const three = tendenciesFor(
      ['2023', '2024', '2025'].flatMap((season, i) =>
        historicalDraft({ draftId: `d${i}`, season, users, qbRound: habit }),
      ),
    );
    expect(three.get('early')!.byPosition.get('QB')!.confidence).toBeGreaterThan(
      one.get('early')!.byPosition.get('QB')!.confidence,
    );
  });

  it('weights the recent season a little more without erasing the older one', () => {
    /*
     * Two managers, mirror images: one drafted the habit last year and not
     * before, the other the year before and not last year. Recency should
     * separate them — and only modestly, because a habit two years ago is still
     * a habit.
     */
    const users = usersWith('m');
    const recent = tendenciesFor([
      ...historicalDraft({ draftId: 'd1', season: '2024', users }),
      ...historicalDraft({ draftId: 'd2', season: '2025', users, qbRound: { m: 2 } }),
    ]).get('m')!;
    const older = tendenciesFor([
      ...historicalDraft({ draftId: 'd1', season: '2024', users, qbRound: { m: 2 } }),
      ...historicalDraft({ draftId: 'd2', season: '2025', users }),
    ]).get('m')!;

    const recentQb = Math.abs(recent.byPosition.get('QB')!.lift);
    const olderQb = Math.abs(older.byPosition.get('QB')!.lift);
    expect(recentQb).toBeGreaterThan(olderQb);
    // Modest: the old season keeps most of its vote rather than being erased.
    expect(olderQb).toBeGreaterThan(recentQb * 0.5);
  });

  it('says nothing at all about a manager below the pick minimum', () => {
    const thin = historicalDraft({ draftId: 'd1', season: '2025', qbRound: { u1: 1 } }).filter(
      (p) => p.userId !== 'u1' || p.round <= 3,
    );
    const read = tendenciesFor(thin).get('u1');
    expect(read?.usable).toBe(false);
    expect(read?.notes.join(' ')).toContain('below the');
  });

  it('treats an unknown manager as neutral rather than as a penalty', () => {
    const neutral = neutralTendencies('nobody');
    expect(neutral.usable).toBe(false);
    expect(neutral.byPosition.size).toBe(0);
    const prior = readManagerPrior({
      tendencies: new Map([['nobody', neutral]]),
      userBySlot: new Map([[6, 'nobody']]),
      slotsAhead: [6],
      rosters: new Map(),
      shape: SHAPE,
      positions: POSITIONS,
    });
    expect(prior.bySlot.size).toBe(0);
    expect(prior.unknownSlots).toEqual([6]);
  });

  it('survives the round trip through storage without losing its positions', () => {
    /*
     * `byPosition` is a Map, and `JSON.stringify` turns a Map into `{}` without
     * complaining. The failure would look like every manager becoming neutral.
     */
    const original = tendenciesFor(twoConsistent).get('early')!;
    const restored = fromStoredTendencies(JSON.parse(JSON.stringify(toStoredTendencies(original))));
    expect(restored.byPosition.get('QB')!.lift).toBe(original.byPosition.get('QB')!.lift);
    expect(restored.usable).toBe(true);
  });
});

describe('historical reach-vs-ADP integrity (§4)', () => {
  it('offers no reach number when no historical market price exists', () => {
    const picks = historicalDraft({ draftId: 'd1', season: '2024' });
    const profile = buildManagerDraftProfile({ rosterId: 1, userId: 'u1', picks });
    expect(profile.reachTendency).toBeNull();
    expect(profile.reachAvailability).toBe('no-historical-market');
  });

  it('tells "no market to measure against" apart from "not enough of one"', () => {
    const priced = historicalDraft({ draftId: 'd1', season: '2024' }).map((p, i) => ({
      ...p,
      marketRank: i < 4 ? p.pickNo : null,
    }));
    const profile = buildManagerDraftProfile({ rosterId: 1, userId: 'u1', picks: priced });
    // Some price exists, just not enough of it — a different answer, and one
    // that could change next season.
    expect(profile.reachAvailability).toBe('insufficient-sample');
  });

  it('never lets today’s ranking stand in for draft-day ADP', () => {
    /*
     * The integrity rule, expressed as the thing that must not happen. The
     * Sleeper ingestion writes `marketRank: null` unconditionally, so a pick
     * arriving here with a price can only have come from a real contemporaneous
     * snapshot — and there is no code path that fills one in from the current
     * market.
     */
    const source = readFileSync(
      new URL('../src/server/services/leagueStrategyService.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/marketRank:\s*numberOrNull\(meta\['search_rank'\]\)/);
    expect(source).toMatch(/marketRank:\s*null/);
  });
});

describe('current-draft override (§8)', () => {
  const qbUsers = usersWith('qbLover');
  const earlyQb = tendenciesFor(
    ['2024', '2025'].flatMap((season, i) =>
      historicalDraft({ draftId: `d${i}`, season, users: qbUsers, qbRound: { qbLover: 1 } }),
    ),
  );

  function priorWithRoster(counts: PositionCounts): ManagerPriorResult {
    return readManagerPrior({
      tendencies: earlyQb,
      userBySlot: new Map([[6, 'qbLover']]),
      slotsAhead: [6],
      rosters: new Map([[6, counts]]),
      shape: SHAPE,
      positions: POSITIONS,
    });
  }

  it('lifts quarterback demand for a manager who has not taken one yet', () => {
    const prior = priorWithRoster({ RB: 2, WR: 3 });
    expect(prior.bySlot.get(6)!.get('QB')!).toBeGreaterThan(1);
  });

  it('ignores an early-quarterback history once he already has two quarterbacks', () => {
    /*
     * The brief's own example. He has taken quarterbacks in round one twice,
     * and this afternoon he has two of them — so his history says nothing about
     * what he does with the next pick. Current-draft truth outranks history.
     */
    const prior = priorWithRoster({ QB: 2, RB: 2, WR: 3 });
    expect(prior.bySlot.get(6)?.get('QB')).toBeUndefined();
    expect(prior.entries[0]!.suppressed).toContain('QB');
  });

  it('ends the lift at exactly the point the starting requirement is met', () => {
    // A one-quarterback league: one is enough, and the second changes nothing.
    expect(priorWithRoster({ QB: 1 }).bySlot.get(6)?.get('QB')).toBeUndefined();
    expect(priorWithRoster({ QB: 0 }).bySlot.get(6)?.get('QB')).toBeGreaterThan(1);
  });

  it('scales a partly-filled depth position rather than switching it off', () => {
    const teUsers = usersWith('teEarly');
    const teLover = tendenciesFor(
      ['2024', '2025'].flatMap((season, i) =>
        historicalDraft({ draftId: `d${i}`, season, users: teUsers, teRound: { teEarly: 2 } }),
      ),
    );
    const at = (counts: PositionCounts) =>
      readManagerPrior({
        tendencies: teLover,
        userBySlot: new Map([[6, 'teEarly']]),
        slotsAhead: [6],
        rosters: new Map([[6, counts]]),
        shape: SHAPE,
        positions: POSITIONS,
      }).bySlot.get(6)?.get('TE') ?? 1;

    // The league starts one tight end, so holding one closes it outright.
    expect(at({})).toBeGreaterThan(1);
    expect(at({ TE: 1 })).toBe(1);
  });
});

describe('only the managers who actually pick (§8)', () => {
  it('never reads a manager with no pick between now and your next selection', () => {
    const ownership = buildPickOwnership({ teams: TEAMS, rounds: ROUNDS, type: 'snake' });
    const ahead = slotsAheadOf(ownership, 53, 68, MY_SLOT);

    // Slots 1-4 pick in round five before pick 53 and again in round six after
    // pick 68: they own nothing in between.
    expect(ahead).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(ahead).not.toContain(MY_SLOT);
    expect(ahead).not.toContain(1);

    const everyone = tendenciesFor([
      ...historicalDraft({ draftId: 'd1', season: '2024', qbRound: { u1: 1, u7: 1 } }),
      ...historicalDraft({ draftId: 'd2', season: '2025', qbRound: { u1: 1, u7: 1 } }),
    ]);
    const prior = readManagerPrior({
      tendencies: everyone,
      userBySlot: new Map(allSlots().map((slot) => [slot, `u${slot}`])),
      slotsAhead: ahead,
      rosters: new Map(),
      shape: SHAPE,
      positions: POSITIONS,
    });

    // u7 is ahead and reads; u1 is not ahead and is absent entirely.
    expect(prior.bySlot.has(7)).toBe(true);
    expect(prior.bySlot.has(1)).toBe(false);
  });
});

describe('the Next% ceiling (§6, §7)', () => {
  /** One board, optionally with a historical prior applied. */
  function report(prior?: ManagerPriorResult) {
    clearNextPickCache();
    const board = buildBoard({ currentPick: 53, simulations: 4000 });
    return estimateNextPickAvailability({
      ...board,
      completed: neutralHistory(53),
      universe: neutralUniverse(53, board.candidates),
      managerPrior: prior,
      noCache: true,
    });
  }

  /** Every manager ahead, maximally hungry for one position. */
  function extremePrior(position: string, multiplier: number): ManagerPriorResult {
    const bySlot = new Map<number, Map<string, number>>();
    for (const slot of [6, 7, 8, 9, 10, 11, 12]) bySlot.set(slot, new Map([[position, multiplier]]));
    return { bySlot, entries: [], unknownSlots: [], notes: [] };
  }

  it('moves Next% when the managers ahead have a history, and only a little', () => {
    const before = report();
    const after = report(extremePrior('QB', 1.15));

    const target = 'QB-58';
    const b = before.byPlayer.get(target)!.probability!;
    const a = after.byPlayer.get(target)!.probability!;

    // It moved — a quarterback-hungry room takes quarterbacks sooner.
    expect(a).toBeLessThan(b);
    // And it moved by an amount a reader would call "slightly".
    expect(Math.abs(a - b)).toBeLessThanOrEqual(MANAGER_HISTORY_CEILING);
  });

  it('holds the ceiling even against a prior far past anything the model builds', () => {
    /*
     * The multipliers here are outside `MANAGER_PRIOR.bounds` on purpose. The
     * ceiling must be a property of the seam rather than a consequence of the
     * generator being well behaved — a future gain change must not be able to
     * quietly raise the cap.
     */
    const before = report();
    const after = report(extremePrior('QB', 4));

    let largest = 0;
    for (const [playerId, availability] of after.byPlayer) {
      const b = before.byPlayer.get(playerId)?.probability;
      if (b == null || availability.probability == null) continue;
      largest = Math.max(largest, Math.abs(availability.probability - b));
    }
    expect(largest).toBeLessThanOrEqual(MANAGER_HISTORY_CEILING + 1e-9);
    // And the report says out loud that it had to clamp.
    expect(after.historyCeilingHits).toBeGreaterThan(0);
  });

  it('combines several managers’ histories without letting them stack past the cap', () => {
    const one = report(extremePrior('QB', 1.15));
    const all = report(extremePrior('QB', 1.15));
    for (const [playerId, availability] of all.byPlayer) {
      const single = one.byPlayer.get(playerId)?.probability;
      if (single == null || availability.probability == null) continue;
      expect(Math.abs(availability.probability - single)).toBeLessThanOrEqual(MANAGER_HISTORY_CEILING * 2);
    }
    expect(all.historyLargestMovePoints).toBeLessThanOrEqual(MANAGER_HISTORY_CEILING * 100 + 1e-9);
  });

  it('reports the raw adjustment alongside the bounded one', () => {
    const after = report(extremePrior('QB', 4));
    const clamped = [...after.byPlayer.values()].find(
      (a) => a.historyAdjustmentRaw != null && Math.abs(a.historyAdjustmentRaw) > MANAGER_HISTORY_CEILING,
    );
    expect(clamped).toBeDefined();
    expect(Math.abs(clamped!.historyAdjustment!)).toBe(MANAGER_HISTORY_CEILING);
    // The counterfactual is carried too, so the effect is auditable per player.
    expect(clamped!.historyBaseline).toBeGreaterThanOrEqual(0);
  });

  it('is exactly the old model when no manager ahead has a history', () => {
    /*
     * The most important equality in the file. A league with no previous
     * season, or one whose managers are all new, must get byte-identical
     * numbers — not merely similar ones.
     */
    const before = report();
    const withEmpty = report({ bySlot: new Map(), entries: [], unknownSlots: [6], notes: [] });
    for (const [playerId, availability] of withEmpty.byPlayer) {
      expect(availability.probability).toBe(before.byPlayer.get(playerId)?.probability);
    }
    expect(withEmpty.historyCeilingHits).toBe(0);
    expect(withEmpty.historyLargestMovePoints).toBe(0);
  });

  it('carries no counterfactual fields when history never applied', () => {
    const plain = report();
    for (const availability of plain.byPlayer.values()) {
      expect(availability.historyAdjustment).toBeUndefined();
      expect(availability.historyBaseline).toBeUndefined();
    }
  });

  it('gives the same board the same answer twice, prior and all', () => {
    const prior = extremePrior('QB', 1.12);
    const first = report(prior);
    const second = report(prior);
    for (const [playerId, availability] of first.byPlayer) {
      expect(second.byPlayer.get(playerId)!.probability).toBe(availability.probability);
    }
  });
});

describe('what the adjustment is not allowed to touch (§6)', () => {
  it('reaches the hazard table and nothing else in the simulator', () => {
    /*
     * A structural pin rather than a behavioural one. `managerPrior` is read in
     * exactly one expression — the per-slot, per-position demand table — and the
     * day it appears in a second one is the day it can start moving something
     * that is not `Next%`.
     */
    const source = readFileSync(
      new URL('../src/core/draft/nextpick/simulate.ts', import.meta.url),
      'utf8',
    );
    const uses = source.match(/managerMultiplier\(/g) ?? [];
    expect(uses).toHaveLength(1);
  });

  it('is absent from every module that prices or ranks a player', () => {
    for (const file of [
      '../src/core/draft/score.ts',
      '../src/core/draft/marketBaseline.ts',
      '../src/core/draft/tiers.ts',
      '../src/core/managers/tradeProfile.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toContain('managerPrior');
      expect(source).not.toContain('managerTendencies');
    }
  });
});
