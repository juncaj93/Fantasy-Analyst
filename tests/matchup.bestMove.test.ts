/**
 * The answer above the fold, and the four things it is allowed to say.
 *
 * The Matchup screen now answers *is there a lineup change I should make right
 * now?* before a reader taps anything, and this file is the proof that the
 * answer stays honest in every state the afternoon can be in. What it does
 * **not** test is whether the recommendation is right — that is
 * `matchup.decision.test.ts`, and the whole design of this pass is that the
 * screen learned nothing new. There is one lineup optimiser in this
 * repository, it lives in `core/matchup/decision.ts`, and the tests at the
 * bottom of this file exist to keep it that way.
 *
 * Every forecast here is built by `buildForecast` from a list of players,
 * rather than written out as a response literal. A state reached by arithmetic
 * is a state the app can actually be in; one written by hand is a state
 * somebody hoped it could be in.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessLineupDecision, MIN_WIN_PROBABILITY_GAIN } from '../src/core/matchup/decision.ts';
import { buildForecast } from '../src/core/matchup/model.ts';
import { bestMoveState, pointsDeltaText, signedPoints, winShift } from '../src/web/components/matchup.tsx';
import { lineups, player, slots } from './helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';
import type { MatchupForecast } from '../src/core/matchup/model.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');
/** Half an hour into the early window: those games are running, the night game is not. */
const KICKED_OFF = new Date('2026-12-20T18:30:00Z');
/** After everything, including the night game. */
const AFTER_ALL = new Date('2026-12-21T06:00:00Z');
const EARLY_KICKOFF = '2026-12-20T18:00:00Z';
const LATE_KICKOFF = '2026-12-20T21:25:00Z';

function forecast(players: MatchupPlayerInput[], now: Date = BEFORE): MatchupForecast {
  return buildForecast({
    leagueId: 'l1',
    season: '2026',
    week: 16,
    matchupId: 3,
    players,
    teams: {
      mine: { rosterId: 1, name: 'Mine', avatar: null, record: null },
      theirs: { rosterId: 2, name: 'Theirs', avatar: null, record: null },
    },
    actualScores: { mine: 0, theirs: 0 },
    slots: slots(),
    now,
  });
}

/** Every TypeScript file under a directory, so a structural rule can be exhaustive. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out.sort();
}

/** One bench player, ready to be given whatever shape a test needs. */
function bench(over: Partial<MatchupPlayerInput> & { playerId: string }): MatchupPlayerInput {
  return player({ side: 'mine', starting: false, slot: null, position: 'WR', team: 'NYJ', ...over });
}

/** A lineup with one obvious improvement sitting on the bench. */
function withBetterBench(over: Partial<MatchupPlayerInput> = {}): MatchupPlayerInput[] {
  return [...lineups(), bench({ playerId: 'bench-better', name: 'Bench Better', projection: 20, ...over })];
}

describe('what the slot above the lineup says', () => {
  it('offers the move when there is a meaningful legal one', () => {
    const state = bestMoveState(forecast(withBetterBench()));
    expect(state.kind).toBe('move');
    if (state.kind !== 'move') throw new Error('unreachable');
    expect(state.move.inPlayerId).toBe('bench-better');
    // Whatever it says, it says the engine's answer and not its own.
    expect(state.move).toEqual(forecast(withBetterBench()).decision.best);
  });

  it('says nothing is recommended when no change clears the threshold', () => {
    const state = bestMoveState(forecast([...lineups(), bench({ playerId: 'bench-worse', projection: 3 })]));
    expect(state.kind).toBe('none');
  });

  /**
   * The distinction §5 asks for, and the one it is easiest to lose.
   *
   * "Nothing is worth changing" and "we cannot tell you" are different answers
   * and a reader acts differently on each. Both produce `decision.best ===
   * null`, so a screen that keyed off that field alone would tell somebody
   * their lineup was fine on a morning the forecast had failed entirely.
   */
  it('distinguishes a forecast with no move from no forecast at all', () => {
    const blind = lineups().map((p) => (p.side === 'theirs' ? { ...p, projection: null } : p));
    const degraded = forecast(blind);
    expect(degraded.degraded).toBe(true);
    expect(degraded.decision.best).toBeNull();

    expect(bestMoveState(degraded).kind).toBe('unavailable');
    expect(bestMoveState(forecast([...lineups(), bench({ playerId: 'b', projection: 3 })])).kind).toBe('none');
  });

  /**
   * A finished afternoon gets silence rather than restraint.
   *
   * `No lineup change recommended` is true of a settled matchup and it is also
   * pointless: the card above has already dropped its projection and its odds
   * for a result line, and advice about a lineup nobody can change is the kind
   * of furniture this screen has been compacted to remove.
   */
  it('says nothing at all once the matchup is over', () => {
    const settled = forecast(
      withBetterBench({ kickoff: EARLY_KICKOFF }).map((p) => ({ ...p, kickoff: EARLY_KICKOFF })),
      AFTER_ALL,
    );
    expect(settled.phase).toBe('final');
    expect(bestMoveState(settled).kind).toBe('silent');
  });

  /**
   * The kickoff that ends a recommendation, followed all the way to the screen.
   *
   * The same lineup, the same bench player, the same swap — read twice, an
   * hour either side of the early window. §5's rule is that a recommendation
   * must never remain visibly actionable once it is illegal, and this is that
   * rule at the level the reader experiences it: not "the engine stops
   * offering it", which `matchup.decision.test.ts` already holds, but "the row
   * stops being a row".
   */
  it('stops offering a move the moment a kickoff makes it illegal', () => {
    const players = withBetterBench({ kickoff: LATE_KICKOFF }).map((p) =>
      p.playerId === 'bench-better' ? p : { ...p, kickoff: EARLY_KICKOFF },
    );

    const early = forecast(players, BEFORE);
    expect(early.phase).toBe('pregame');
    expect(bestMoveState(early).kind).toBe('move');

    /*
     * Half an hour into the early window, and nothing else about the fixture
     * has changed. The bench player is still unstarted and still the better
     * projection; what has gone is the reader's ability to act on it, which is
     * the only thing that decides whether the row may stand.
     */
    const underway = forecast(players, KICKED_OFF);
    expect(underway.phase).toBe('live');
    expect(underway.decision.note).toMatch(/locked/);
    expect(bestMoveState(underway).kind).toBe('none');
  });

  /**
   * Only the best one is above the fold, and the rest are not discarded.
   *
   * The screen shows `best`; the sheet shows the remainder in the order the
   * engine ranked them. What must never happen is the page growing a second
   * recommendation, which is how a decision surface becomes a dashboard.
   */
  it('keeps every other worthwhile move off the page and in order', () => {
    const players = [
      ...lineups(),
      bench({ playerId: 'best', name: 'Best Option', projection: 24 }),
      bench({ playerId: 'second', name: 'Second Option', projection: 21 }),
    ];
    const built = forecast(players);
    expect(built.decision.options.length).toBeGreaterThan(1);

    const state = bestMoveState(built);
    if (state.kind !== 'move') throw new Error('expected a move');
    expect(state.move).toEqual(built.decision.options[0]);

    const gains = built.decision.options.map((o) => o.gain);
    expect([...gains].sort((a, b) => b - a)).toEqual(gains);
  });

  /** A ruled-out player never reaches the row, because he never reaches the engine. */
  it('never surfaces a player who has been ruled out', () => {
    const players = [
      ...lineups(),
      bench({ playerId: 'injured', projection: 40, ruledOut: true, availability: 'inactive' }),
    ];
    const state = bestMoveState(forecast(players));
    if (state.kind === 'move') expect(state.move.inPlayerId).not.toBe('injured');
    expect(forecast(players).decision.options.some((o) => o.inPlayerId === 'injured')).toBe(false);
  });

  /**
   * A questionable player can still be the answer, and the row has to say so.
   *
   * The engine already prices the chance he does not play — that is the
   * mixture in `distribution.ts` — so suppressing the recommendation would be
   * the screen overriding a model that has already accounted for the risk.
   * What the screen owes is the mark, which it reads off the same player view
   * the lineup rows below it read.
   */
  it('keeps the status mark on a risky player it recommends', () => {
    const players = withBetterBench({ availability: 'uncertain', projection: 26 });
    const built = forecast(players);
    const state = bestMoveState(built);
    if (state.kind !== 'move') throw new Error('expected a move');
    expect(state.move.inPlayerId).toBe('bench-better');

    const view = built.bench.mine.find((p) => p.playerId === 'bench-better');
    expect(view?.statusFlag).toBe('Q');
    expect(view?.availabilityRisky).toBe(true);
  });
});

describe('the numbers the row prints', () => {
  it('keeps the true sign of a projection given up', () => {
    expect(signedPoints(2.84)).toBe('+2.8');
    expect(signedPoints(-1.44)).toBe('-1.4');
    expect(pointsDeltaText(-1.44)).toBe('-1.4 projected pts');
  });

  /** A delta of four hundredths is not `+0.0`, which is a plus sign over nothing. */
  it('refuses fake precision at zero', () => {
    expect(signedPoints(0.04)).toBe('no change');
    expect(signedPoints(-0.04)).toBe('no change');
    expect(pointsDeltaText(0)).toBe('no change in projected pts');
  });

  it('prints the odds before and after, and never the difference as well', () => {
    const move = { winNow: 0.4412, winAfter: 0.4795, gain: 0.0383 } as never;
    const shown = winShift(move);
    expect(shown).toBe('44% → 48%');
    // Two numbers and nothing signed: `+4` would be `gain` in a second unit.
    expect(shown.match(/%/g)).toHaveLength(2);
    expect(shown).not.toContain('+');
  });

  /**
   * `gain` is `winAfter - winNow` and printing it beside them is the same fact
   * twice in two units — the thing §4 forbids. Asserted against the source
   * rather than against a rendering, because the field is easy to reach for
   * and reads as helpful.
   */
  it('never reads gain anywhere in the Matchup UI', () => {
    for (const file of ['src/web/components/matchup.tsx', 'src/web/screens/MatchupScreen.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} reads decision gain`).not.toMatch(/\.gain\b/);
    }
  });
});

describe('nothing about the model moved', () => {
  /**
   * The threshold, pinned at the number and at the reason.
   *
   * §9 forbids changing it to create more cards, and that is exactly the
   * pressure a screen like this puts on it: an empty slot above the lineup
   * looks like a bug, and two points of win probability is the difference
   * between a page that says something most Sundays and one that says nothing.
   * It stays where it is, and `options` at a lower threshold is where the
   * smaller effects go.
   */
  it('leaves the materiality threshold at two points of win probability', () => {
    expect(MIN_WIN_PROBABILITY_GAIN).toBe(0.02);
  });

  it('applies that threshold to what reaches the screen', () => {
    const players = withBetterBench();
    const built = forecast(players);
    for (const option of built.decision.options) {
      expect(option.gain).toBeGreaterThanOrEqual(MIN_WIN_PROBABILITY_GAIN);
    }
    const state = bestMoveState(built);
    if (state.kind !== 'move') throw new Error('expected a move');
    expect(state.move.gain).toBeGreaterThanOrEqual(MIN_WIN_PROBABILITY_GAIN);
  });

  /**
   * There is one lineup optimiser, and the screen is not a second one.
   *
   * The cheapest way to break this feature is to compute something on the
   * client — a points delta the model did not produce, a re-rank of `options`,
   * a "what if" over the bench. Any of those is a second model with no tests
   * behind it that disagrees with the first one on some Sunday nobody is
   * watching. The web layer may read `decision` and may not do arithmetic that
   * decides anything.
   */
  it('leaves every lineup decision in core/matchup', () => {
    for (const file of ['src/web/components/matchup.tsx', 'src/web/screens/MatchupScreen.tsx']) {
      const source = readFileSync(file, 'utf8');
      const imports = source.match(/^import[\s\S]*?from '[^']*core\/matchup[^']*';$/gm) ?? [];
      for (const statement of imports) {
        expect(statement.startsWith('import type'), `${file} imports a value from core/matchup`).toBe(true);
      }
    }
  });

  /**
   * Advisory, and the screen is given no way to be anything else.
   *
   * §9 forbids a Sleeper write path, and the place one would appear is exactly
   * here: a row that says `Start C. Olave over B. Hall` is one short step from
   * a button that does it. There is no such endpoint and no client that could
   * call one, and this is the lock that says so — a `POST` from either Matchup
   * file fails it whatever the endpoint turns out to be.
   */
  it('gives the Matchup screen no way to write a lineup', () => {
    for (const file of ['src/web/components/matchup.tsx', 'src/web/screens/MatchupScreen.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} writes`).not.toMatch(/api\.post|method: 'POST'/);
    }
  });

  /** The model calls the decision layer with its own threshold and no override. */
  it('never overrides the threshold on the way through the model', () => {
    const source = readFileSync('src/core/matchup/model.ts', 'utf8');
    expect(source).toContain('assessLineupDecision({ result, players: input.players, distributions, slots: input.slots })');
    expect(source).not.toContain('minGain');
  });

  /**
   * The decision layer is reachable one way, and it is the way the model uses.
   *
   * A second caller — a service, a route, a screen — would be a second path to
   * the same answer computed from inputs the forecast never saw, and the two
   * would disagree on exactly the Sundays where it mattered.
   */
  it('is called from exactly one place', () => {
    expect(assessLineupDecision).toBeTypeOf('function');
    const callers = sourceFiles('src').filter((file) => {
      if (file.endsWith('src/core/matchup/decision.ts')) return false;
      return readFileSync(file, 'utf8').includes('assessLineupDecision');
    });
    expect(callers).toEqual(['src/core/matchup/model.ts']);
  });
});
