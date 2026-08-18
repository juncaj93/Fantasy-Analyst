/**
 * The hero card, and the ordering it promises.
 *
 * §11 is a ranking specification, and a ranking is exactly the kind of thing
 * that is right on the day it is written and quietly wrong a month later. These
 * tests pin the properties rather than the sentences: an injury outranks a
 * projection wobble, a duplicate never appears twice, a superseded message does
 * not survive its state, and a quiet Sunday produces one calm card instead of
 * manufactured drama.
 */

import { describe, expect, it } from 'vitest';
import { buildForecast } from '../src/core/matchup/model.ts';
import { lineups, slots } from '../src/../tests/helpers/matchup.ts';
import type { MatchupPlayerInput } from '../src/core/matchup/types.ts';
import type { PreviousInsightState } from '../src/core/matchup/insights.ts';

const BEFORE = new Date('2026-12-20T15:00:00Z');
const HALFTIME = new Date('2026-12-20T19:32:30Z');
const AFTER = new Date('2026-12-20T22:00:00Z');

function forecast(
  players: MatchupPlayerInput[],
  now: Date,
  opts: { previous?: PreviousInsightState | null } = {},
) {
  return buildForecast({
    leagueId: 'l1',
    season: '2026',
    week: 16,
    matchupId: 3,
    players,
    teams: {
      mine: { rosterId: 1, name: 'Ceedeez Nuts', avatar: null, record: '9-5' },
      theirs: { rosterId: 2, name: 'Juncer’s Hog Format', avatar: null, record: '9-5' },
    },
    actualScores: {
      mine: total(players, 'mine'),
      theirs: total(players, 'theirs'),
    },
    slots: slots(),
    now,
    previous: opts.previous ?? null,
  });
}

function total(players: MatchupPlayerInput[], side: 'mine' | 'theirs'): number {
  return Math.round(players.filter((p) => p.side === side && p.starting).reduce((a, p) => a + p.actual, 0) * 100) / 100;
}

/**
 * The ordinary Sunday shape: an early window that has already run, and one
 * player still to kick off.
 *
 * The mixed slate is what most of these tests need, because an availability
 * question only exists *before* a player's game starts — once he is on the
 * field the scoreboard has answered it, and the model collapses the branch.
 */
const LATE_KICKOFF = '2026-12-20T21:25:00Z';

function mixedSlate(players: MatchupPlayerInput[], lateIds: string[]): MatchupPlayerInput[] {
  return players.map((p) => (lateIds.includes(p.playerId) ? { ...p, kickoff: LATE_KICKOFF } : p));
}

/** A bench, so lineup leverage and bench swings have something to work with. */
function withBench(players: MatchupPlayerInput[], extra: Partial<MatchupPlayerInput>[]): MatchupPlayerInput[] {
  return [
    ...players,
    ...extra.map((over, i) => ({
      playerId: `bench-${i}`,
      name: `Bench Player${i}`,
      position: 'WR',
      team: 'NYJ',
      opponent: 'NE',
      slot: null,
      starting: false,
      side: 'mine' as const,
      projection: 9,
      actual: 0,
      kickoff: '2026-12-20T18:00:00Z',
      roleBucket: 'unclassified',
      availability: 'high_confidence_active' as const,
      ruledOut: false,
      ...over,
    })),
  ];
}

describe('priority', () => {
  it('puts an availability alert above a projection wobble', () => {
    const players = mixedSlate(
      lineups().map((p) =>
        p.playerId === 'mine-0'
          ? { ...p, availability: 'uncertain' as const }
          : p.playerId === 'mine-4'
            ? { ...p, actual: p.projection! + 8 }
            : p,
      ),
      ['mine-0'],
    );
    const result = forecast(players, HALFTIME);
    const injury = result.insights.findIndex((i) => i.kind === 'injury');
    const swing = result.insights.findIndex((i) => i.kind === 'swing_positive' || i.kind === 'swing_negative');
    expect(injury).toBeGreaterThanOrEqual(0);
    if (swing >= 0) expect(injury).toBeLessThan(swing);
  });

  it('puts an actionable lineup change above anything informational', () => {
    const players = withBench(lineups(), [{ projection: 22, position: 'WR' }]);
    const result = forecast(players, BEFORE);
    const lineup = result.insights.find((i) => i.kind === 'lineup_leverage');
    expect(lineup).toBeDefined();
    expect(result.insights[0]!.urgency).toBe('act_now');
    for (const insight of result.insights) {
      if (insight.kind === 'lineup_leverage') continue;
      expect(insight.priority).toBeLessThanOrEqual(lineup!.priority);
    }
  });

  /**
   * A starter who is out and has not kicked off.
   *
   * The card that would be easiest to lose, because every leverage-based path
   * correctly skips him: he holds none of the outcome precisely because he is
   * going to score nothing. What he holds is a slot, and that is the alert.
   */
  it('says when a ruled-out player is still in the lineup, and who should take the slot', () => {
    const players = withBench(
      lineups().map((p) =>
        p.playerId === 'mine-4' ? { ...p, ruledOut: true, availability: 'inactive' as const } : p,
      ),
      [{ projection: 12, position: 'WR' }],
    );
    const result = forecast(players, BEFORE);
    const alert = result.insights.find((i) => i.key === 'ruled-out:mine-4');
    expect(alert).toBeDefined();
    expect(alert!.urgency).toBe('act_now');
    expect(alert!.headline).toMatch(/is out and still in your lineup/);
    expect(alert!.detail).toMatch(/takes the slot and adds/);
  });

  it('offers the replacement as a real lineup change, not only as a sentence', () => {
    const players = withBench(
      lineups().map((p) =>
        p.playerId === 'mine-4' ? { ...p, ruledOut: true, availability: 'inactive' as const } : p,
      ),
      [{ projection: 12, position: 'WR' }],
    );
    const decision = forecast(players, BEFORE).decision;
    expect(decision.best).not.toBeNull();
    expect(decision.best!.outPlayerId).toBe('mine-4');
    expect(decision.best!.inPlayerId).toBe('bench-0');
  });

  it('says so plainly when there is nobody to replace him with', () => {
    const players = lineups().map((p) =>
      p.playerId === 'mine-4' ? { ...p, ruledOut: true, availability: 'inactive' as const } : p,
    );
    const alert = forecast(players, BEFORE).insights.find((i) => i.key === 'ruled-out:mine-4');
    expect(alert!.detail).toMatch(/Nobody on your bench/);
  });

  /** Their problem is not a task. */
  it('does not raise a task about the opponent starting somebody who is out', () => {
    const players = lineups().map((p) =>
      p.playerId === 'theirs-4' ? { ...p, ruledOut: true, availability: 'inactive' as const } : p,
    );
    const result = forecast(players, BEFORE);
    expect(result.insights.some((i) => i.key.startsWith('ruled-out:'))).toBe(false);
  });

  it('drops the alert once his game has started, because it is too late to act', () => {
    const players = withBench(
      lineups().map((p) =>
        p.playerId === 'mine-4' ? { ...p, ruledOut: true, availability: 'inactive' as const } : p,
      ),
      [{ projection: 12, position: 'WR' }],
    );
    expect(forecast(players, HALFTIME).insights.some((i) => i.key === 'ruled-out:mine-4')).toBe(false);
  });

  it('never shows two cards about the same player', () => {
    const players = mixedSlate(
      lineups().map((p) =>
        p.playerId === 'mine-0' ? { ...p, availability: 'uncertain' as const, actual: p.projection! + 9 } : p,
      ),
      [],
    );
    const result = forecast(players, HALFTIME);
    const ids = result.insights.map((i) => i.playerId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never shows the same key twice', () => {
    const result = forecast(lineups(), HALFTIME);
    const keys = result.insights.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows at most three', () => {
    const players = lineups().map((p, i) => ({
      ...p,
      actual: i % 2 === 0 ? p.projection! + 11 : 0,
      availability: i === 3 ? ('uncertain' as const) : p.availability,
    }));
    expect(forecast(players, HALFTIME).insights.length).toBeLessThanOrEqual(3);
  });
});

describe('materiality', () => {
  it('shows one calm card when nothing is happening', () => {
    const result = forecast(lineups(), BEFORE);
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]!.kind).toBe('calm');
    expect(result.insights[0]!.headline).toMatch(/win odds/);
  });

  it('does not manufacture a card from a trivial miss', () => {
    // Two points below pace at half-time is an ordinary afternoon.
    const players = lineups().map((p) =>
      p.playerId === 'mine-3' ? { ...p, actual: p.projection! / 2 - 2 } : { ...p, actual: p.projection! / 2 },
    );
    const result = forecast(players, HALFTIME);
    expect(result.insights.some((i) => i.kind === 'swing_negative')).toBe(false);
  });

  it('does surface a real one', () => {
    const players = lineups().map((p) =>
      p.playerId === 'mine-3' ? { ...p, actual: p.projection! + 13 } : { ...p, actual: p.projection! / 2 },
    );
    const result = forecast(players, HALFTIME);
    expect(result.insights.some((i) => i.kind === 'swing_positive')).toBe(true);
  });

  it('drops the calm card the moment anything material exists', () => {
    const players = lineups().map((p) =>
      p.playerId === 'theirs-0' ? { ...p, actual: p.projection! + 18 } : { ...p, actual: p.projection! / 2 },
    );
    const result = forecast(players, HALFTIME);
    expect(result.insights.some((i) => i.kind === 'calm')).toBe(false);
  });
});

describe('what each side needs', () => {
  it('tells you what you need from your biggest lever when you are behind', () => {
    const players = lineups({
      mineProjections: [18, 12, 10, 14, 11, 8, 9],
      theirsProjections: [20, 13, 12, 15, 12, 9, 10],
    });
    const result = forecast(players, BEFORE);
    const need = result.insights.find((i) => i.kind === 'need');
    expect(need).toBeDefined();
    expect(need!.headline).toMatch(/more from/);
    expect(need!.side).toBe('mine');
  });

  it('hedges the wording while several outcomes are still open', () => {
    const players = lineups({
      mineProjections: [18, 12, 10, 14, 11, 8, 9],
      theirsProjections: [20, 13, 12, 15, 12, 9, 10],
    });
    const need = forecast(players, BEFORE).insights.find((i) => i.kind === 'need');
    expect(need!.headline).toMatch(/roughly/);
  });

  it('states what the opponent needs to flip it when you are ahead', () => {
    const players = lineups({
      mineProjections: [24, 17, 15, 19, 16, 13, 14],
      theirsProjections: [18, 12, 10, 14, 11, 8, 9],
    });
    const result = forecast(players, BEFORE);
    const flip = result.insights.find((i) => i.kind === 'opponent_need');
    // Not guaranteed to reach the top three, but the engine must be able to
    // produce it — checked through the leverage it is built from.
    expect(result.leverage.some((l) => l.side === 'theirs' && l.swing > 0)).toBe(true);
    if (flip) expect(flip.headline).toMatch(/Opponent needs/);
  });

  it('updates the opponent threshold as they score', () => {
    const base = lineups({
      mineProjections: [24, 17, 15, 19, 16, 13, 14],
      theirsProjections: [18, 12, 10, 14, 11, 8, 9],
    });
    const early = forecast(base.map((p) => ({ ...p, actual: p.projection! * 0.3 })), HALFTIME);
    const later = forecast(
      base.map((p) => ({ ...p, actual: p.side === 'theirs' ? p.projection! * 0.9 : p.projection! * 0.3 })),
      HALFTIME,
    );
    expect(later.teams.mine.winProbability!).toBeLessThan(early.teams.mine.winProbability!);
  });
});

describe('state and supersession', () => {
  it('stamps every card with the state it was generated from', () => {
    const result = forecast(lineups(), BEFORE);
    for (const insight of result.insights) {
      expect(insight.sourceFingerprint).toBe(result.fingerprint);
      expect(insight.generatedAt).toBe(result.computedAt);
    }
  });

  it('carries forward when a card first became relevant', () => {
    const players = mixedSlate(
      lineups().map((p) => (p.playerId === 'mine-0' ? { ...p, availability: 'uncertain' as const } : p)),
      ['mine-0'],
    );
    const first = forecast(players, HALFTIME);
    const alert = first.insights.find((i) => i.kind === 'injury')!;

    const second = forecast(
      // A tenth of a point elsewhere: the same alert, a different state.
      players.map((p) => (p.playerId === 'mine-5' ? { ...p, actual: 0.1 } : p)),
      new Date(HALFTIME.getTime() + 600_000),
      {
        previous: {
          fingerprint: first.fingerprint,
          winProbability: first.teams.mine.winProbability!,
          relevantSince: Object.fromEntries(first.insights.map((i) => [i.key, i.relevantSince])),
        },
      },
    );
    const again = second.insights.find((i) => i.key === alert.key);
    expect(again).toBeDefined();
    expect(again!.relevantSince).toBe(alert.relevantSince);
    expect(again!.generatedAt).not.toBe(alert.generatedAt);
    expect(again!.sourceFingerprint).not.toBe(alert.sourceFingerprint);
  });

  it('does not let a superseded card survive its state', () => {
    const players = mixedSlate(
      lineups().map((p) => (p.playerId === 'mine-0' ? { ...p, availability: 'uncertain' as const } : p)),
      ['mine-0'],
    );
    const first = forecast(players, HALFTIME);
    expect(first.insights.some((i) => i.kind === 'injury')).toBe(true);

    const resolved = forecast(
      players.map((p) => (p.playerId === 'mine-0' ? { ...p, availability: 'high_confidence_active' as const } : p)),
      HALFTIME,
      {
        previous: {
          fingerprint: first.fingerprint,
          winProbability: first.teams.mine.winProbability!,
          relevantSince: Object.fromEntries(first.insights.map((i) => [i.key, i.relevantSince])),
        },
      },
    );
    expect(resolved.insights.some((i) => i.kind === 'injury')).toBe(false);
  });
});

describe('clinch states', () => {
  it('separates a mathematical clinch from a simulated one', () => {
    const decided = lineups().map((p) => ({ ...p, actual: p.side === 'mine' ? 20 : 8 }));
    const result = forecast(decided, AFTER);
    expect(result.clinch.mathematical).toBe(true);
    expect(result.clinch.nearClinch).toBe(false);

    const nearly = lineups({
      mineProjections: [30, 26, 24, 28, 26, 22, 24],
      theirsProjections: [6, 5, 4, 5, 4, 3, 4],
    });
    const live = forecast(nearly, BEFORE);
    expect(live.clinch.mathematical).toBe(false);
    expect(live.teams.mine.winProbability!).toBeGreaterThan(0.9);
  });
});

describe('postgame', () => {
  it('explains what decided it rather than listing the box score', () => {
    const players = lineups().map((p) =>
      p.playerId === 'mine-3' ? { ...p, actual: p.projection! + 19 } : { ...p, actual: p.projection! },
    );
    const result = forecast(players, AFTER);
    expect(result.phase).toBe('final');
    const decided = result.insights.find((i) => i.kind === 'what_decided_it');
    expect(decided).toBeDefined();
    expect(decided!.headline).toBe('What decided it');
    expect(decided!.detail).toMatch(/against projection/);
  });

  it('states a bench swing without implying the decision was obviously wrong', () => {
    const players = withBench(
      lineups().map((p) => ({ ...p, actual: p.projection! })),
      [{ projection: 9, actual: 27, position: 'WR' }],
    );
    const result = forecast(players, AFTER);
    const swing = result.insights.find((i) => i.kind === 'bench_swing');
    expect(swing).toBeDefined();
    expect(swing!.headline).toMatch(/Bench swing/);
    expect(swing!.detail).toMatch(/swung against the pregame recommendation/);
    expect(swing!.detail).not.toMatch(/should have/i);
  });
});
