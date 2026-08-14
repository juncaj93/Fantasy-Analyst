/**
 * Decision quality where it has to prove itself: inside the ranking.
 *
 * A tag that only prints is decoration. Each of these checks that the judgement
 * actually moved the board — and, just as importantly, that it moved it by a
 * bounded amount. The engine's calibration note puts a point of ADP at roughly
 * 0.05 of contribution, so "how many picks is this worth" is a question every
 * one of these features has to answer honestly.
 */

import { describe, expect, it } from 'vitest';
import { DECISION_THRESHOLDS } from '../src/core/draft/decisions.ts';
import { rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { TEST_PLAYERS, player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const CTX = {
  currentPick: 15,
  nextPick: 30,
  shape: SHAPE,
  profile: HALF_PPR,
  rosterCounts: { QB: 1, RB: 0, WR: 1, TE: 0 },
  totalPicks: 180,
};

function signal(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

const WRS = TEST_PLAYERS.filter((p) => p.active && p.position === 'WR');
const [WR_A, WR_B] = WRS;

/**
 * A genuinely deep pool at one position.
 *
 * The shared fixture holds five wide receivers, which is a thin pool by
 * definition — every one of them really is near the end of the position, so it
 * cannot be used to test the case where a position runs deep.
 */
function deepPool(position: string, count: number, startAdp: number, step: number): AvailablePlayerInput[] {
  return Array.from({ length: count }, (_, i) => ({
    player: player({ id: `${position}-${i}`, fullName: `${position} Depth ${i}`, position, team: 'FA' }),
    adp: startAdp + i * step,
    adpRank: i + 1,
    signal: null,
  }));
}

/** Two interchangeable players at the same ADP, so only the tested signal differs. */
function twin(overrides: { a?: Partial<AvailablePlayerInput>; b?: Partial<AvailablePlayerInput> } = {}) {
  return rankAvailablePlayers(
    [
      { player: WR_A!, adp: 15, adpRank: 1, signal: null, ...(overrides.a ?? {}) },
      { player: WR_B!, adp: 15, adpRank: 2, signal: null, ...(overrides.b ?? {}) },
    ],
    CTX,
  );
}

const contributionOf = (rec: { components: { key: string; contribution: number }[] }, key: string) =>
  rec.components.find((c) => c.key === key)?.contribution ?? 0;

describe('My Guy moves the board', () => {
  it('breaks a tie between two otherwise identical players', () => {
    const ranked = twin({ b: { myGuyLevel: 1 } });
    expect(ranked[0]!.playerId).toBe(WR_B!.id);
    expect(ranked[0]!.myGuy.stars).toBe('★');
  });

  it('is worth more at each level', () => {
    const one = twin({ b: { myGuyLevel: 1 } }).find((r) => r.playerId === WR_B!.id)!;
    const two = twin({ b: { myGuyLevel: 2 } }).find((r) => r.playerId === WR_B!.id)!;
    const three = twin({ b: { myGuyLevel: 3 } }).find((r) => r.playerId === WR_B!.id)!;
    expect(contributionOf(one, 'my_guy')).toBeLessThan(contributionOf(two, 'my_guy'));
    expect(contributionOf(two, 'my_guy')).toBeLessThan(contributionOf(three, 'my_guy'));
  });

  it('justifies a modest reach at ★★★ and no more', () => {
    const three = twin({ b: { myGuyLevel: 3 } }).find((r) => r.playerId === WR_B!.id)!;
    const picks = contributionOf(three, 'my_guy') / 0.05;
    expect(picks).toBeGreaterThan(5);
    expect(picks).toBeLessThanOrEqual(12);
  });

  /** The bound that matters: wanting somebody cannot overrule the market. */
  it('cannot beat a large ADP gap even at ★★★', () => {
    const ranked = rankAvailablePlayers(
      [
        { player: WR_A!, adp: 4, adpRank: 1, signal: null }, // fell 11 picks
        { player: WR_B!, adp: 60, adpRank: 2, signal: null, myGuyLevel: 3 }, // a 45-pick reach
      ],
      CTX,
    );
    expect(ranked[0]!.playerId).toBe(WR_A!.id);
  });

  it('is kept separate from the news tally', () => {
    const ranked = twin({ b: { myGuyLevel: 2, signal: signal(8) } });
    const rec = ranked.find((r) => r.playerId === WR_B!.id)!;
    expect(rec.myGuy.level).toBe(2);
    expect(rec.newsLifetimeNet).toBe(8);
    // Two signals, two components — neither is folded into the other.
    expect(contributionOf(rec, 'my_guy')).toBeGreaterThan(0);
    expect(contributionOf(rec, 'news_lifetime')).toBeGreaterThan(0);
  });

  it('says in the reasons that the boost was the user’s own', () => {
    const rec = twin({ b: { myGuyLevel: 2 } }).find((r) => r.playerId === WR_B!.id)!;
    expect(rec.reasons.join(' ')).toContain('you marked him ★★ Strong My Guy');
  });
});

describe('AVOID moves the board', () => {
  it('pushes a heavily negative player down without removing him', () => {
    const ranked = twin({ b: { signal: signal(-8) } });
    expect(ranked[0]!.playerId).toBe(WR_A!.id);
    const avoided = ranked.find((r) => r.playerId === WR_B!.id)!;
    expect(avoided.avoid.active).toBe(true);
    expect(contributionOf(avoided, 'avoid')).toBeLessThan(0);
    // Still on the board, still explained.
    expect(ranked).toHaveLength(2);
  });

  it('stays advisory: a big enough fall still outranks a clean player at ADP', () => {
    const ranked = rankAvailablePlayers(
      [
        { player: WR_A!, adp: 15, adpRank: 1, signal: null }, // exactly at cost, no caution
        { player: WR_B!, adp: -25, adpRank: 2, signal: signal(-6) }, // fell 40 picks
      ],
      CTX,
    );
    expect(ranked[0]!.playerId).toBe(WR_B!.id);
    expect(ranked[0]!.avoid.active).toBe(true);
    // The conflict is impossible to miss even though he ranks first.
    expect(ranked[0]!.counterpoints.join(' ')).toContain('AVOID');
  });

  it('does not fire one point above the threshold', () => {
    const rec = twin({ b: { signal: signal(DECISION_THRESHOLDS.avoid.lifetimeNet + 1) } }).find(
      (r) => r.playerId === WR_B!.id,
    )!;
    expect(rec.avoid.active).toBe(false);
    expect(contributionOf(rec, 'avoid')).toBe(0);
  });

  it('shows an improving trend beside the tag, not instead of it', () => {
    const improving = emptySignal('x');
    improving.raw = { positive: 2, negative: 10, net: -8, items: 6 };
    improving.last30 = { positive: 4, negative: 0, net: 4, items: 2 };
    const rec = twin({ b: { signal: improving } }).find((r) => r.playerId === WR_B!.id)!;
    expect(rec.avoid.active).toBe(true);
    expect(rec.counterpoints.join(' ')).toContain('AVOID');
    expect(rec.counterpoints.join(' ')).toContain('Recent trend improving');
  });
});

describe('the tier labels a real board produces', () => {
  /**
   * End to end, through the ranking rather than the classifier: the reported
   * tight end board, scored the way the Draft screen scores it. Every one of
   * these seven came back `Tier cliff` before this pass.
   */
  it('does not stamp a spread-out tight end board with cliffs', () => {
    const board = [40, 51, 68, 67, 78, 76, 99];
    const ranked = rankAvailablePlayers(
      board.map((adp, i) => ({
        player: player({ id: `te-${i}`, fullName: `TE ${i}`, team: 'BUF', position: 'TE' }),
        adp,
        adpRank: i + 1,
        signal: null,
      })),
      { ...CTX, currentPick: 32, nextPick: 44, rosterCounts: { QB: 1, RB: 1, WR: 1, TE: 0 } },
    );
    const cliffs = ranked.filter((r) => r.tierCliff.severity === 'last_in_tier');
    expect(cliffs).toHaveLength(1);
    expect(cliffs[0]!.adp).toBe(78);
    // And the ones that are not cliffs say what was measured instead of nothing.
    const quiet = ranked.find((r) => r.adp === 67)!;
    expect(contributionOf(quiet, 'tier_cliff')).toBe(0);
    expect(quiet.components.find((c) => c.key === 'tier_cliff')!.display).toContain('picks later');
  });

  it('is unmoved by roster need', () => {
    const board = [40, 51, 68, 67, 78, 76, 99].map((adp, i) => ({
      player: player({ id: `te-${i}`, fullName: `TE ${i}`, team: 'BUF', position: 'TE' }),
      adp,
      adpRank: i + 1,
      signal: null,
    }));
    const severities = (rosterCounts: Record<string, number>) =>
      rankAvailablePlayers(board, { ...CTX, currentPick: 32, nextPick: 44, rosterCounts })
        .sort((a, b) => (a.adp ?? 0) - (b.adp ?? 0))
        .map((r) => `${r.adp}:${r.tierCliff.severity}`);
    // A tight end already rostered changes what the pick is worth, and must not
    // change whether the market has a hole in it.
    expect(severities({ QB: 1, RB: 1, WR: 1, TE: 0 })).toEqual(severities({ QB: 1, RB: 2, WR: 3, TE: 2 }));
  });
});

describe('tier cliffs move the board', () => {
  /**
   * The brief's own case: a slightly lower-ranked player who is about to
   * disappear can be the better pick than one who will still be there.
   */
  it('promotes the last player in a tier over a comparable one with depth behind him', () => {
    const te = TEST_PLAYERS.find((p) => p.active && p.position === 'TE')!;
    const wr = WR_A!;
    const others = WRS.slice(1, 6);
    // The rest of the tight ends, in a bunch a long way after him. A cliff is a
    // shape in the position, so the position has to be on the board for one to
    // exist at all.
    const laterTes = [62, 66, 70, 74].map((adp, i) => ({
      player: player({ id: `te-${i}`, fullName: `Late TE ${i}`, team: 'BUF', position: 'TE' }),
      adp,
      adpRank: 20 + i,
      signal: null,
    }));

    const ranked = rankAvailablePlayers(
      [
        // The TE is at the end of his group, before a long gap.
        { player: te, adp: 30, adpRank: 2, signal: null },
        ...laterTes,
        // The WR sits in a deep, unbroken tier.
        { player: wr, adp: 28, adpRank: 1, signal: null },
        ...others.map((p, i) => ({ player: p, adp: 31 + i * 3, adpRank: 3 + i, signal: null })),
      ],
      { ...CTX, currentPick: 25, nextPick: 48, rosterCounts: { QB: 1, RB: 2, WR: 2, TE: 0 } },
    );

    const teRec = ranked.find((r) => r.playerId === te.id)!;
    const wrRec = ranked.find((r) => r.playerId === wr.id)!;
    expect(teRec.tierCliff.severity).toBe('last_in_tier');
    expect(wrRec.tierCliff.severity).toBe('none');
    expect(teRec.total).toBeGreaterThan(wrRec.total);
    expect(teRec.wait.state).toBe('take_now');
  });

  it('contributes nothing to the players who still have depth behind them', () => {
    // Thirty receivers in one unbroken run: nobody near the front of it is
    // about to fall off anything.
    const ranked = rankAvailablePlayers(deepPool('WR', 30, 20, 4), CTX);
    const early = ranked.filter((r) => (r.adp ?? 0) <= 60);
    expect(early.length).toBeGreaterThan(5);
    for (const rec of early) {
      expect(rec.tierCliff.severity).toBe('none');
      expect(contributionOf(rec, 'tier_cliff')).toBe(0);
    }
  });
});

describe('wait guidance rides along with the ranking', () => {
  it('attaches a state and an explanation to every recommendation', () => {
    for (const rec of twin()) {
      expect(rec.wait.state).toBeTruthy();
      expect(rec.wait.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * The label is gone from the UI, so it is gone from the sentence too — but
   * the point it was making is not. A player who will still be there has that
   * said against taking him now, with the number that says it.
   */
  it('says a likely survivor can wait, in the counterpoints', () => {
    // Deep pool, and the player goes ninety picks after the user's next turn:
    // nothing here is urgent.
    const pool = deepPool('WR', 30, 20, 4);
    const ranked = rankAvailablePlayers(pool, { ...CTX, currentPick: 15, nextPick: 30 });
    const far = ranked.find((r) => (r.adp ?? 0) === 120)!;
    expect(far.wait.state).toBe('likely_available_later');
    const counterpoints = far.counterpoints.join(' ').toLowerCase();
    expect(counterpoints).toContain('to reach pick 30');
    expect(counterpoints).toMatch(/\d+%/);
    // …and without reintroducing the chip the draft screen no longer shows.
    expect(counterpoints).not.toContain('likely available later');
  });

  it('admits it does not know without an ADP', () => {
    const ranked = rankAvailablePlayers([{ player: WR_A!, adp: null, adpRank: null, signal: null }], CTX);
    expect(ranked[0]!.wait.state).toBe('unknown');
  });
});

describe('the board stays honest', () => {
  it('still exposes every component with its weight and contribution', () => {
    const [top] = twin({ b: { myGuyLevel: 2, signal: signal(-6) } });
    const keys = top!.components.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['tier_cliff', 'avoid', 'my_guy']));
    for (const c of top!.components) expect(c.contribution).toBeCloseTo(c.score * c.weight, 2);
  });

  it('still sums the components into the total', () => {
    const [top] = twin({ b: { myGuyLevel: 3, signal: signal(-9) } });
    expect(top!.total).toBeCloseTo(
      top!.components.reduce((a, c) => a + c.contribution, 0),
      2,
    );
  });

  it('is still deterministic for the same board state', () => {
    const once = twin({ b: { myGuyLevel: 2, signal: signal(-6) } });
    const twice = twin({ b: { myGuyLevel: 2, signal: signal(-6) } });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
