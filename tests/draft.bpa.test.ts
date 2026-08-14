/**
 * Best player available, and what it takes to move off him.
 *
 * The board used to be decided partly by which slots were empty: an unfilled
 * quarterback slot was worth about thirteen picks of ADP, and stacked on the
 * scarcity and tier-cliff components — which also rise when a position is
 * needed — it could float a quarterback over objectively better players for no
 * reason except that the quarterback slot was empty.
 *
 * These are the regressions for the calibration that fixed it. They are written
 * as questions about behaviour ("does an empty QB slot beat a better player")
 * rather than about weights, so the numbers can be tuned again without
 * rewriting the file.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, needUrgency, rankAvailablePlayers, type AvailablePlayerInput } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../src/core/evidence/types.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

const QB = player({ id: 'qb', fullName: 'Pocket Passer', position: 'QB', team: 'GB' });
const RB = player({ id: 'rb', fullName: 'Lead Back', position: 'RB', team: 'KC' });
const WR = player({ id: 'wr', fullName: 'Field Stretcher', position: 'WR', team: 'CIN' });
const TE = player({ id: 'te', fullName: 'Seam Runner', position: 'TE', team: 'DET' });

/** An empty roster in a league that starts one of each. */
const EMPTY_ROSTER = { QB: 0, RB: 0, WR: 0, TE: 0 };

function ctx(overrides: Partial<Parameters<typeof rankAvailablePlayers>[1]> = {}) {
  return {
    currentPick: 15,
    nextPick: 30,
    shape: SHAPE,
    profile: HALF_PPR,
    rosterCounts: EMPTY_ROSTER,
    totalPicks: 180,
    ...overrides,
  };
}

function entry(p: typeof QB, adp: number, extra: Partial<AvailablePlayerInput> = {}): AvailablePlayerInput {
  return { player: p, adp, adpRank: Math.round(adp), signal: null, ...extra };
}

function signal(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

const contributionOf = (rec: { components: { key: string; contribution: number }[] }, key: string) =>
  rec.components.find((c) => c.key === key)?.contribution ?? 0;

describe('best player available dominates', () => {
  /**
   * The margin here is deliberately small — six picks of ADP, not sixty.
   * A gap that large was already respected; what was not was the ordinary case
   * where the market prefers a running back by half a round and the app
   * preferred the quarterback anyway, because that slot happened to be empty.
   */
  it('does not lift an ordinary quarterback over better players just because QB is empty', () => {
    const ranked = rankAvailablePlayers(
      [entry(QB, 46), entry(RB, 40), entry(WR, 42)],
      ctx({ currentPick: 40, nextPick: 62, rosterCounts: { QB: 0, RB: 2, WR: 2, TE: 1 } }),
    );
    expect(ranked.map((r) => r.playerId)).toEqual(['rb', 'wr', 'qb']);
  });

  it('does not force a tight end early for the same reason', () => {
    const ranked = rankAvailablePlayers(
      [entry(TE, 46), entry(WR, 40), entry(RB, 42)],
      ctx({ currentPick: 40, nextPick: 62, rosterCounts: { QB: 1, RB: 2, WR: 2, TE: 0 } }),
    );
    expect(ranked[0]!.playerId).toBe('wr');
    expect(ranked[ranked.length - 1]!.playerId).toBe('te');
  });

  it('keeps a large ADP gap decisive whatever the roster looks like', () => {
    const withEmptyQb = rankAvailablePlayers(
      [entry(QB, 202), entry(RB, 16)],
      ctx({ currentPick: 38, rosterCounts: { QB: 0, RB: 3, WR: 3, TE: 1 } }),
    );
    expect(withEmptyQb[0]!.playerId).toBe('rb');

    // …and the same board late in the draft, where need matters most.
    const late = rankAvailablePlayers(
      [entry(QB, 202), entry(RB, 90)],
      ctx({ currentPick: 170, rosterCounts: { QB: 0, RB: 3, WR: 3, TE: 1 } }),
    );
    expect(late[0]!.playerId).toBe('rb');
  });

  it('moves a player only a pick or two on roster need alone', () => {
    // Identical players at the same ADP; only the roster differs.
    const needed = rankAvailablePlayers([entry(QB, 40)], ctx({ currentPick: 20, rosterCounts: EMPTY_ROSTER }))[0]!;
    const filled = rankAvailablePlayers(
      [entry(QB, 40)],
      ctx({ currentPick: 20, rosterCounts: { QB: 2, RB: 2, WR: 2, TE: 1 } }),
    )[0]!;

    const swing = contributionOf(needed, 'need') - contributionOf(filled, 'need');
    // A pick of ADP is worth about 0.05 of contribution in the reach regime, so
    // this is "two or three places", not "two rounds".
    expect(swing).toBeGreaterThan(0);
    expect(swing).toBeLessThan(0.15);
  });

  it('still lets roster need break a genuine tie', () => {
    // Same ADP, same everything: the only thing left to decide it is the roster.
    const ranked = rankAvailablePlayers(
      [entry(QB, 100), entry(RB, 100)],
      ctx({ currentPick: 96, nextPick: 120, rosterCounts: { QB: 0, RB: 3, WR: 3, TE: 1 } }),
    );
    expect(ranked[0]!.playerId).toBe('qb');
  });

  it('weighs an unfilled slot more heavily late than early', () => {
    const early = rankAvailablePlayers([entry(QB, 30)], ctx({ currentPick: 3, rosterCounts: EMPTY_ROSTER }))[0]!;
    const late = rankAvailablePlayers([entry(QB, 30)], ctx({ currentPick: 150, rosterCounts: EMPTY_ROSTER }))[0]!;
    expect(contributionOf(late, 'need')).toBeGreaterThan(contributionOf(early, 'need'));
    expect(needUrgency(1, 180)).toBeLessThan(needUrgency(180, 180));
    expect(needUrgency(180, 180)).toBe(1);
  });

  it('leaves the news tally able to reorder players the market rates similarly', () => {
    const ranked = rankAvailablePlayers(
      [entry(WR, 30), entry(RB, 28, { signal: signal(8, 6) })],
      ctx({ currentPick: 25, rosterCounts: { QB: 1, RB: 2, WR: 0, TE: 1 } }),
    );
    // The RB is behind on need and level on the market, and wins on evidence.
    expect(ranked[0]!.playerId).toBe('rb');
  });

  it('leaves a ★★★ My Guy able to win a close call', () => {
    const plain = rankAvailablePlayers([entry(WR, 30), entry(RB, 27)], ctx({ currentPick: 25 }));
    expect(plain[0]!.playerId).toBe('rb');

    const flagged = rankAvailablePlayers(
      [entry(WR, 30, { myGuyLevel: 3 }), entry(RB, 27)],
      ctx({ currentPick: 25 }),
    );
    expect(flagged[0]!.playerId).toBe('wr');
  });

  it('keeps roster need a smaller weight than the market, the tally or a My Guy flag', () => {
    expect(DEFAULT_WEIGHTS.need).toBeLessThan(DEFAULT_WEIGHTS.marketValue);
    expect(DEFAULT_WEIGHTS.need).toBeLessThan(DEFAULT_WEIGHTS.newsLifetime);
    expect(DEFAULT_WEIGHTS.need).toBeLessThan(DEFAULT_WEIGHTS.myGuy);
  });
});
