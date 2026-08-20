/**
 * The simulator, pinned by direction rather than by number.
 *
 * Almost nothing in here asserts a probability. The model's constants are
 * assumptions — no public dataset says how much likelier a manager is to take a
 * tight end when his tight-end slot is empty — so tests that pinned "31%" would
 * be pinning a guess, and would have to be rewritten every time the guess
 * improved. What can be asserted, and what a wrong model would break, is the
 * *shape*: more teams needing the position must not raise survival, a thinner
 * tier must not raise it, a longer wait must not raise it.
 *
 * The exceptions are the three things that are not judgement calls: an empty
 * interval is 100%, an unpriced player is unknown, and the same board twice is
 * the same number twice.
 */

import { describe, expect, it } from 'vitest';
import { SIMULATION, simulateNextPick } from '../src/core/draft/nextpick/simulate.ts';
import { readRoom } from '../src/core/draft/nextpick/room.ts';
import { buildPickOwnership } from '../src/core/draft/nextpick/ownership.ts';
import { positionsInPlay } from '../src/core/draft/nextpick/demand.ts';
import {
  MY_SLOT,
  ROUNDS,
  TEAMS,
  allSlots,
  buildBoard,
  defaultPool,
  filledRosters,
  neutralHistory,
  neutralUniverse,
  pool,
  type BoardOptions,
} from './helpers/nextpick.ts';
import type { PositionCounts } from '../src/core/draft/nextpick/demand.ts';

/** The probability the simulator gives one player on one board. */
function survivalOf(playerId: string, opts: BoardOptions = {}): number {
  const board = buildBoard(opts);
  const room = readRoom({
    picks: opts.completed ?? [],
    currentPick: board.currentPick,
    positions: positionsInPlay(board.shape),
    universe: opts.universe ?? [],
  });
  const result = simulateNextPick({ ...board, room });
  const availability = result.byPlayer.get(playerId);
  if (!availability) throw new Error(`${playerId} is not on this board`);
  if (availability.probability == null) throw new Error(`${playerId} has no probability`);
  return availability.probability;
}

/**
 * The managers who actually pick between 53 and 68.
 *
 * Named rather than derived in each test because the whole point of "more teams
 * ahead need this position" is that the teams are *ahead*: making slots 1 to 3
 * short at tight end changes nothing, since none of them picks again before you
 * do. That mistake is easy to make and produces two identical numbers and a
 * passing-looking model, so the set is written down once.
 */
const AHEAD_SLOTS = [6, 7, 8, 9, 10, 11, 12];

/** Rosters where `needy` of the teams picking ahead are short at `position`. */
function rostersNeeding(position: string, needy: number) {
  const full: PositionCounts = { QB: 1, RB: 2, WR: 3, TE: 1 };
  const out: Record<number, PositionCounts> = {};
  for (const slot of allSlots()) out[slot] = { ...full };
  for (const slot of AHEAD_SLOTS.slice(0, needy)) {
    out[slot] = { ...full, [position]: Math.max(0, (full[position] ?? 1) - 1) };
  }
  return out;
}

describe('the shape of one simulation', () => {
  it('simulates exactly the opposing picks between now and your next selection', () => {
    const board = buildBoard({ currentPick: 53 });
    const result = simulateNextPick(board);

    // Slot 5 owns 53 and 68. Picks 54..67 belong to somebody else: fourteen of
    // them, which is the brief's canonical interval.
    expect(result.targetPick).toBe(68);
    expect(result.picksSimulated).toBe(14);
    expect(result.slotsAhead).not.toContain(MY_SLOT);
    // Slots 6-12 each pick twice — once on the way up round five, once on the
    // way back down round six. Seven managers, fourteen picks.
    expect(result.slotsAhead).toEqual(AHEAD_SLOTS);
  });

  it('takes exactly one player per simulated pick, and never the same one twice', () => {
    /*
     * The strongest thing that can be asserted about this model, and the reason
     * it is worth asserting exactly rather than approximately.
     *
     * Every simulated pick selects one player and every selected player leaves
     * the board, so the total number of selections across the whole run must
     * equal simulations × picks — to the unit. Three separate bugs all show up
     * here and nowhere else: a player taken twice inside one simulation pushes
     * the total *over*; a pick skipped because the board looked empty pushes it
     * *under*; and rosters carried between simulations would drift it in a way
     * no probability assertion would notice, because every individual number
     * would still look plausible.
     */
    const board = buildBoard({ simulations: 500 });
    const result = simulateNextPick(board);

    const totalTaken = [...result.byPlayer.values()].reduce((a, p) => a + p.timesTaken, 0);
    expect(totalTaken).toBe(result.simulations * result.picksSimulated);

    // And nobody was taken in more simulations than there were simulations.
    for (const availability of result.byPlayer.values()) {
      expect(availability.timesTaken).toBeLessThanOrEqual(result.simulations);
    }
  });

  it('gives everyone a 100% chance when nobody picks in between', () => {
    // Back-to-back picks: you own 53 and 54, so the interval is empty. This is
    // arithmetic about the pick order, not an estimate.
    const ownership = buildPickOwnership({ teams: TEAMS, rounds: ROUNDS, type: 'snake' });
    const result = simulateNextPick(buildBoard({ currentPick: 53, targetPick: 54, mySlot: 5, ownership }));
    expect(result.picksSimulated).toBe(0);
    expect(result.byPlayer.get('RB-52')?.probability).toBe(1);
  });

  it('answers "unknown" rather than a number when the draft has no later pick', () => {
    const result = simulateNextPick(buildBoard({ targetPick: null }));
    expect(result.byPlayer.size).toBe(0);
    expect(result.degraded.join(' ')).toContain('nothing to survive to');
  });

  it('reports an unpriced player as unknown while still simulating him', () => {
    const candidates = [...defaultPool(), { playerId: 'WR-unpriced', position: 'WR', adp: null, order: 900 }];
    const result = simulateNextPick(buildBoard({ candidates }));
    expect(result.byPlayer.get('WR-unpriced')?.probability).toBeNull();
    expect(result.degraded.join(' ')).toContain('no market ADP');
  });
});

describe('directional invariants', () => {
  it('does not raise survival when there are more picks to wait through', () => {
    const near = survivalOf('RB-58', { currentPick: 53, targetPick: 58 });
    const far = survivalOf('RB-58', { currentPick: 53, targetPick: 68 });
    expect(far).toBeLessThan(near);
  });

  it('does not raise survival when more teams ahead need the position', () => {
    const nobodyNeedsTe = survivalOf('TE-55', { rosters: rostersNeeding('TE', 0) });
    const threeNeedTe = survivalOf('TE-55', { rosters: rostersNeeding('TE', 3) });
    const sevenNeedTe = survivalOf('TE-55', { rosters: rostersNeeding('TE', 7) });

    expect(threeNeedTe).toBeLessThan(nobodyNeedsTe);
    expect(sevenNeedTe).toBeLessThan(threeNeedTe);
  });

  it('raises QB survival once the teams ahead already have a quarterback', () => {
    // The brief's scenario: a one-QB league where the room is set at the
    // position. The market alone cannot see this; the simulator can.
    const roomNeedsQb = survivalOf('QB-58', { rosters: rostersNeeding('QB', 8) });
    const roomIsSet = survivalOf('QB-58', { rosters: rostersNeeding('QB', 0) });
    expect(roomIsSet).toBeGreaterThan(roomNeedsQb);
  });

  it('lowers survival when the tier behind him is thin', () => {
    /*
     * Same player, same ADP, same needy teams — the only difference is how many
     * comparable tight ends stand behind him.
     *
     * Two effects and both point the same way: a manager who needs a tight end
     * and finds two takes one of two, and the tier engine marks a nearly-empty
     * group as urgent.
     */
    const thin = pool([
      { position: 'TE', from: 55, count: 2, spacing: 4 },
      { position: 'TE', from: 120, count: 6, spacing: 10 },
      { position: 'RB', from: 52, count: 26, spacing: 6 },
      { position: 'WR', from: 50, count: 30, spacing: 5 },
      { position: 'QB', from: 58, count: 12, spacing: 13 },
    ]);
    const deep = pool([
      { position: 'TE', from: 55, count: 8, spacing: 4 },
      { position: 'RB', from: 52, count: 26, spacing: 6 },
      { position: 'WR', from: 50, count: 30, spacing: 5 },
      { position: 'QB', from: 58, count: 12, spacing: 13 },
    ]);
    const rosters = rostersNeeding('TE', 3);

    expect(survivalOf('TE-55', { candidates: thin, rosters })).toBeLessThan(
      survivalOf('TE-55', { candidates: deep, rosters }),
    );
  });

  it('protects a player whose position is deep more than one whose position is thin', () => {
    /*
     * The brief's own comparison, at one ADP: the last tight end in a tier
     * against a receiver with nine comparable alternatives. Both are priced at
     * 52, both have three needy teams ahead of them; only the supply differs.
     */
    const candidates = pool([
      { position: 'TE', from: 52, count: 1 },
      { position: 'TE', from: 130, count: 6, spacing: 12 },
      { position: 'WR', from: 52, count: 10, spacing: 3 },
      { position: 'RB', from: 52, count: 26, spacing: 6 },
      { position: 'QB', from: 58, count: 12, spacing: 13 },
    ]);
    const rosters: Record<number, PositionCounts> = {};
    for (const slot of allSlots()) rosters[slot] = { QB: 1, RB: 2, WR: 2, TE: 0 };

    const te = survivalOf('TE-52', { candidates, rosters });
    const wr = survivalOf('WR-52', { candidates, rosters });
    expect(te).toBeLessThan(wr);
  });

  it('treats a falling player as conditional, not as his pre-draft distribution', () => {
    /*
     * ADP 20, still there at 53. The unconditional distribution says he is long
     * gone — it answers a question about pick 30 — and would return a survival
     * near zero. The conditional model says the room has been declining him for
     * thirty picks, which is a much better reason to think it may keep doing so
     * for another fourteen.
     */
    const candidates = [{ playerId: 'RB-faller', position: 'RB', adp: 20, order: 20 }, ...defaultPool()];
    const survival = survivalOf('RB-faller', { candidates });

    expect(survival).toBeGreaterThan(0);
    // He is the most attractive player on the board, so he is in real danger —
    // but "in danger" is not "mathematically certain to be gone".
    expect(survival).toBeLessThan(0.5);
  });

  it('lets a manager with two picks in a row see his own first pick', () => {
    /*
     * The turn: slot 12 owns picks 84 and 85, so one manager makes both of the
     * selections standing between you and pick 86.
     *
     * He needs a tight end and nothing else — quarterback, backs and receivers
     * are all filled, and a surplus back has already taken his flex. Two tight
     * ends are on the board **at the same ADP**, which is what makes this an
     * isolation rather than an observation: identical price means identical
     * market weight, so any asymmetry in what happens to them can only have come
     * from his roster changing between his two picks.
     *
     * The assertion is on how many of the two he takes. Every simulation makes
     * exactly two selections, so `P(A gone) + P(B gone)` is the expected number
     * of tight ends taken:
     *
     *   - roster updated:     he takes one, then no longer needs one — about 1.
     *   - roster not updated: he wants a tight end twice — close to 2.
     *
     * A model that evaluated both picks from the same pre-pick roster lands
     * outside the band below, which a "second one is safer" assertion would have
     * missed entirely: the two are equally priced, so that comparison holds
     * either way.
     */
    const candidates = pool([
      { position: 'TE', from: 84, count: 1 },
      { position: 'TE', from: 140, count: 4, spacing: 12 },
      { position: 'RB', from: 84, count: 20, spacing: 3 },
      { position: 'WR', from: 84, count: 24, spacing: 2 },
      { position: 'QB', from: 90, count: 8, spacing: 8 },
    ]);
    candidates.push({ playerId: 'TE-84b', position: 'TE', adp: 84, order: 84 });

    const rosters: Record<number, PositionCounts> = {};
    // Everything filled except tight end, with a spare back already in the flex.
    for (const slot of allSlots()) rosters[slot] = { QB: 1, RB: 3, WR: 3, TE: 0 };

    const shared = { currentPick: 84, targetPick: 86, mySlot: 6, candidates, rosters, simulations: 5000 };
    const oneManager = buildBoard({
      ...shared,
      ownership: buildPickOwnership({ teams: TEAMS, rounds: ROUNDS, type: 'snake' }),
    });
    const twoManagers = buildBoard({
      ...shared,
      ownership: buildPickOwnership({ teams: TEAMS, rounds: ROUNDS, type: 'linear' }),
    });

    // The turn in a snake gives both picks to slot 12; the same two pick numbers
    // in a linear draft give one each to slot 12 and slot 1. Same picks, same
    // board, same rosters, same market weights, same point in the draft — the
    // only difference in the entire fixture is whether one manager makes both.
    expect(oneManager.ownership.ownerAt(84)).toBe(12);
    expect(oneManager.ownership.ownerAt(85)).toBe(12);
    expect(twoManagers.ownership.ownerAt(84)).toBe(12);
    expect(twoManagers.ownership.ownerAt(85)).toBe(1);

    /*
     * Counted from `timesTaken` rather than from `probability`.
     *
     * This measures what the *simulation* did — whether the manager's roster
     * updated between his two picks — and `probability` is the simulated share
     * after the late-round idiosyncratic floor has thinned it (see
     * `idiosyncraticHazard`). That floor is a uniform additive dilution applied
     * to both boards equally, so it cancels from a difference and does not
     * cancel from a ratio. Reading the raw counts keeps this assertion about
     * the thing it is named for.
     */
    const tightEndsTaken = (result: ReturnType<typeof simulateNextPick>) =>
      (result.byPlayer.get('TE-84')!.timesTaken + result.byPlayer.get('TE-84b')!.timesTaken) /
      result.simulations;

    const alone = simulateNextPick(oneManager);
    const apart = simulateNextPick(twoManagers);

    // The fixture is fair: same price, same treatment.
    expect(Math.abs(alone.byPlayer.get('TE-84')!.probability! - alone.byPlayer.get('TE-84b')!.probability!))
      .toBeLessThan(0.05);

    /*
     * Two hungry managers take about twice as many tight ends as one hungry
     * manager picking twice, because the second of his picks is made by a
     * manager who now has a tight end. Evaluate both his picks from the same
     * pre-pick roster and the two numbers converge — which is exactly the bug,
     * and exactly what this margin catches.
     */
    expect(tightEndsTaken(apart)).toBeGreaterThan(tightEndsTaken(alone) * 1.25);
  });
});

describe('the room', () => {
  it('lowers survival for a position the room is running on', () => {
    const candidates = defaultPool();
    const currentPick = 53;
    const universe = neutralUniverse(currentPick, candidates);
    const neutral = neutralHistory(currentPick);
    // The same board, with the last ten picks turned into a receiver run.
    const run = neutral.map((pick) =>
      pick.pickNo >= currentPick - 10 ? { ...pick, position: 'WR' } : pick,
    );

    const calm = survivalOf('WR-70', { completed: neutral, universe });
    const running = survivalOf('WR-70', { completed: run, universe });

    expect(running).toBeLessThan(calm);
    // Capped, because runs end. A run may not halve a player's chances.
    expect(running).toBeGreaterThan(calm * 0.75);
  });

  it('says nothing at all when there is not enough draft to read', () => {
    const candidates = defaultPool();
    const room = readRoom({
      picks: neutralHistory(4),
      currentPick: 4,
      positions: ['QB', 'RB', 'WR', 'TE'],
      universe: neutralUniverse(4, candidates),
    });
    expect(room.runs.size).toBe(0);
    expect(room.bias.size).toBe(0);
    expect(room.dispersion).toBe(1);
  });
});

describe('determinism', () => {
  it('returns the identical number for the identical board', () => {
    const a = simulateNextPick(buildBoard());
    const b = simulateNextPick(buildBoard());
    expect(a.seed).toBe(b.seed);
    for (const [playerId, availability] of a.byPlayer) {
      expect(b.byPlayer.get(playerId)!.probability).toBe(availability.probability);
    }
  });

  it('returns a different number once the board has moved', () => {
    /*
     * A pick lands, the clock advances, and one fewer manager stands between
     * the reader and their turn. `Next` has to move — a number that held still
     * through a live pick would be a cache bug, and this is the assertion that
     * would catch it.
     */
    const before = simulateNextPick(buildBoard({ currentPick: 53, simulations: 5000 }));
    const after = simulateNextPick(buildBoard({ currentPick: 62, targetPick: 68, simulations: 5000 }));
    // Fourteen opposing picks become six: nine picks were made, and one of the
    // nine was the reader's own, which was never counted as opposition.
    expect(before.picksSimulated).toBe(14);
    expect(after.picksSimulated).toBe(6);
    expect(after.byPlayer.get('RB-58')!.probability).not.toBe(before.byPlayer.get('RB-58')!.probability);
    expect(after.byPlayer.get('RB-58')!.probability!).toBeGreaterThan(before.byPlayer.get('RB-58')!.probability!);
  });
});

describe('convergence and cost', () => {
  /*
   * How the default simulation count was chosen.
   *
   * Not by preference: the brief asks for roughly five thousand "subject to
   * performance measurement", so this measures. The three counts must agree
   * inside a couple of points on a representative board — if they do not, the
   * default is too low and this test says so.
   */
  it('ships the simulation count the documentation claims', () => {
    // A literal, because every other assertion in this block reads the count
    // from the constant and so cannot notice the constant itself moving.
    expect(SIMULATION.default).toBe(5000);
  });

  const CONVERGENCE_PLAYERS = ['RB-58', 'WR-60', 'TE-55', 'QB-58', 'WR-100'];

  it('converges: a quarter of the simulations moves the answer by a few points at most', () => {
    const at = (simulations: number) => {
      const result = simulateNextPick(buildBoard({ simulations }));
      return CONVERGENCE_PLAYERS.map((id) => result.byPlayer.get(id)!.probability!);
    };
    const low = at(1000);
    const mid = at(2500);
    const high = at(SIMULATION.default);

    for (let i = 0; i < CONVERGENCE_PLAYERS.length; i++) {
      expect(Math.abs(low[i]! - high[i]!)).toBeLessThanOrEqual(0.04);
      expect(Math.abs(mid[i]! - high[i]!)).toBeLessThanOrEqual(0.03);
    }
  });

  it('is stable to within two points at the count actually shipped', () => {
    /*
     * The number that decides whether the default is high enough.
     *
     * Convergence between counts confounds two things — sampling error and the
     * fact that a smaller run is a different run. This isolates the first: the
     * same board, the same count, a different seed. Whatever these two disagree
     * by is the sampling error a reader would see if the seed happened to
     * differ, and the brief's budget for it is one to two points.
     */
    const a = simulateNextPick({ ...buildBoard({ simulations: SIMULATION.default }), stateKey: 'seed-a' });
    const b = simulateNextPick({ ...buildBoard({ simulations: SIMULATION.default }), stateKey: 'seed-b' });
    expect(a.seed).not.toBe(b.seed);

    for (const id of CONVERGENCE_PLAYERS) {
      const drift = Math.abs(a.byPlayer.get(id)!.probability! - b.byPlayer.get(id)!.probability!);
      expect(drift).toBeLessThanOrEqual(0.02);
    }
  });

  it('answers a full board inside the draft-day budget', () => {
    /*
     * A representative live state: three hundred candidates, twelve teams,
     * fourteen intervening picks, the shipped simulation count. The board is
     * polled every few seconds during a draft on a phone, so this is the number
     * that decides whether the feature is usable.
     */
    const candidates = pool([
      { position: 'RB', from: 52, count: 90, spacing: 2 },
      { position: 'WR', from: 50, count: 120, spacing: 1.5 },
      { position: 'TE', from: 55, count: 45, spacing: 4 },
      { position: 'QB', from: 58, count: 45, spacing: 4 },
    ]);
    expect(candidates.length).toBe(300);

    const result = simulateNextPick(buildBoard({ candidates, simulations: SIMULATION.default }));
    expect(result.byPlayer.size).toBe(300);
    // Generous against a laptop and a CI runner alike; the observed figure is an
    // order of magnitude below it. What is being guarded is a change that makes
    // this quadratic, not the last millisecond.
    expect(result.elapsedMs).toBeLessThan(1500);
  });
});

describe('missing data', () => {
  it('answers from the market when the board is too thin to simulate', () => {
    /*
     * Fourteen picks against twenty players.
     *
     * A simulation takes one player off the board per pick, so a pool barely
     * larger than the interval empties and every player reads 0% — which is
     * arithmetic about this pool and a falsehood about the draft. Nobody is
     * choosing from the app's table; a pool this shallow means the table is
     * short. The honest answer is the ADP model's, said with a note and low
     * confidence rather than a confident zero.
     */
    const thin = pool([
      { position: 'RB', from: 52, count: 7, spacing: 8 },
      { position: 'WR', from: 50, count: 7, spacing: 8 },
      { position: 'TE', from: 55, count: 3, spacing: 20 },
      { position: 'QB', from: 58, count: 3, spacing: 20 },
    ]);
    expect(thin.length).toBe(20);

    const result = simulateNextPick(buildBoard({ candidates: thin }));
    expect(result.marketOnly).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.degraded.join(' ')).toContain('too thin to simulate');

    // And it is a real spread rather than a board of zeroes.
    const survivals = [...result.byPlayer.values()].map((p) => p.probability!);
    expect(Math.min(...survivals)).toBeLessThan(0.4);
    expect(Math.max(...survivals)).toBeGreaterThan(0.9);
    // The pick sequence was still measured from the real board, and is true
    // whichever model answered.
    expect(result.picksSimulated).toBe(14);
    expect(result.slotsAhead.length).toBe(7);
  });

  it('simulates properly as soon as the board can support it', () => {
    // The same fixture with a real board behind it: no fallback, no note.
    const result = simulateNextPick(buildBoard());
    expect(result.marketOnly).toBe(false);
    expect(result.degraded.join(' ')).not.toContain('too thin');
    expect(result.confidence).toBe('high');
  });

  it('falls back to the market rather than inventing need for an unreadable roster', () => {
    const unknown = new Set(allSlots().filter((s) => s !== MY_SLOT));
    const board = buildBoard({ rosters: filledRosters(buildBoard().shape), unknownRosters: unknown });
    const result = simulateNextPick(board);

    expect(result.degraded.join(' ')).toContain('no readable roster');
    // Still a working board: every priced player still has a number.
    expect(result.byPlayer.get('RB-58')!.probability).toBeGreaterThan(0);
  });
});
