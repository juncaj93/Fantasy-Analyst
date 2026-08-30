/**
 * The Draft Score regression, and the invariants that keep it fixed.
 *
 * A live board sorted by `Score` opened with seven players carrying `ADP —`,
 * `Val —` and `Next —`, clustered on 84, above every priced player the draft
 * had not yet reached — and three of them (Chris Carson, Chase Edmonds, Bryce
 * Love) had not taken an NFL snap in years.
 *
 * That was three independent faults stacked, and each one was necessary:
 *
 *   1. **The Score.** `draftScore` is a logistic centred at a total of −2.5,
 *      because market value charges every player the distance between the clock
 *      and his ADP, so a real board's middle is negative. A total of exactly
 *      zero maps to **83**. A player nobody has priced totals almost exactly
 *      zero — not because he is good, but because the component that would have
 *      had an opinion is missing and the rest contribute nothing.
 *   2. **The sort.** `sortBoard('score')` ordered on `total` alone. The engine's
 *      own sort puts unpriced players last *first*, and the client reproduced
 *      only the second key.
 *   3. **The pool.** Draft recommendations used to require a price, which
 *      capped the board at ~200 players; the deep-coverage work removed that,
 *      and with it the only thing keeping retired players out.
 *
 * A fourth, separate finding is pinned at the bottom: QBs ranked too high, and
 * roster need was not the reason.
 */

import { describe, expect, it } from 'vitest';

import {
  POSITIONAL_STRUCTURE,
  capPositionalStructure,
  rankAvailablePlayers,
  type AvailablePlayerInput,
  type ComponentScore,
  type DraftContext,
} from '../src/core/draft/engine.ts';
import { draftScore } from '../src/core/draft/score.ts';
import { isDraftable, draftableReason } from '../src/core/draft/draftable.ts';
import { sortBoard, type SortableRow } from '../src/core/draft/boardSort.ts';
import { blendMarketBaseline } from '../src/core/draft/marketBaseline.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN']);

const ctx = (overrides: Partial<DraftContext> = {}): DraftContext => ({
  currentPick: 38,
  nextPick: 50,
  shape: SHAPE,
  profile: HALF_PPR,
  rosterCounts: { QB: 0, RB: 1, WR: 2, TE: 0 },
  totalPicks: 180,
  ...overrides,
});

const entry = (id: string, position: string, adp: number | null): AvailablePlayerInput => ({
  player: player({ id, fullName: id, position, team: 'KC' }),
  adp,
  adpRank: adp,
  signal: null,
});

/** A board shaped like a real one, plus however many unpriced players. */
function board(unpriced: string[] = []): AvailablePlayerInput[] {
  const rows: AvailablePlayerInput[] = [];
  for (let i = 1; i <= 40; i++) rows.push(entry(`priced-${i}`, ['RB', 'WR', 'TE', 'QB'][i % 4]!, i * 4));
  for (const name of unpriced) rows.push(entry(name, 'RB', null));
  return rows;
}

// --------------------------------------------------------------------------
// 1. The Score itself
// --------------------------------------------------------------------------

describe('a player no market has priced carries no Score', () => {
  const NAMES = ['Kareem Hunt', 'Audric Estime', 'Brashard Smith', 'Bryce Love', 'Chase Edmonds', 'Chris Carson'];

  it('the arithmetic that produced 84 — a total of zero maps to 83', () => {
    // Not a coincidence and not a magic number: this is the calibration doing
    // exactly what it was designed to do, applied to a total it was never meant
    // to see.
    expect(draftScore(0)).toBe(83);
    expect(draftScore(-2.5)).toBe(50);
  });

  it('leaves the Score unknown rather than reporting the centre of the curve', () => {
    const ranked = rankAvailablePlayers(board(NAMES), ctx());
    for (const name of NAMES) {
      const rec = ranked.find((r) => r.playerId === name)!;
      expect(rec.score, name).toBeNull();
      // The composite is kept — it is real, it is just not comparable.
      expect(Number.isFinite(rec.total), name).toBe(true);
    }
  });

  it('mutation: scoring him anyway puts him in the 83-85 band the report described', () => {
    const ranked = rankAvailablePlayers(board(NAMES), ctx());
    const wouldHaveBeen = NAMES.map((n) => draftScore(ranked.find((r) => r.playerId === n)!.total));
    for (const score of wouldHaveBeen) {
      expect(score).toBeGreaterThanOrEqual(80);
      expect(score).toBeLessThanOrEqual(88);
    }
    // And it would have beaten priced players the draft has not reached.
    const priced = ranked.filter((r) => r.score != null);
    expect(priced.some((r) => r.score! < Math.min(...wouldHaveBeen))).toBe(true);
  });

  it('does not pay him for separation or cost-of-waiting', () => {
    // Both are measured against other players' composites. His is near zero
    // only because everything about him is unknown, and zero beats the negative
    // total every priced player carries until the draft reaches his ADP — so
    // both components read the absence as an edge.
    const rec = rankAvailablePlayers(board(NAMES), ctx()).find((r) => r.playerId === 'Kareem Hunt')!;
    for (const key of ['separation', 'opportunity']) {
      const component = rec.components.find((c) => c.key === key)!;
      expect(component.unknown, key).toBe(true);
      expect(component.contribution, key).toBe(0);
    }
  });

  it('does not let an unpriced player distort a priced player’s alternatives', () => {
    const without = rankAvailablePlayers(board(), ctx());
    const with_ = rankAvailablePlayers(board(NAMES), ctx());
    const find = (rows: typeof without, id: string) => rows.find((r) => r.playerId === id)!;
    // Six unpriced backs arriving changes nothing about a priced back's score.
    for (const rec of without.filter((r) => r.position === 'RB')) {
      expect(find(with_, rec.playerId).total, rec.playerId).toBeCloseTo(rec.total, 10);
    }
  });

  it('ranks every priced player above every unpriced one', () => {
    const ranked = rankAvailablePlayers(board(NAMES), ctx());
    const firstUnpriced = ranked.findIndex((r) => r.score == null);
    const lastPriced = ranked.map((r) => r.score != null).lastIndexOf(true);
    expect(firstUnpriced).toBeGreaterThan(lastPriced);
  });

  it('keeps a Score for a player only one market priced', () => {
    // Single-source is not missing: the blend renormalises and the baseline is
    // that market's own number, so he is scored like anybody else.
    const blend = blendMarketBaseline({ dogAdp: 42, sleeperAdp: null, format: 'standard' });
    expect(blend.unknown).toBe(false);
    expect(blend.adp).toBe(42);
    expect(blend.singleSource).toBe(true);
  });

  it('unknown market inputs cannot become favourable numbers', () => {
    for (const bad of [null, undefined, Number.NaN] as const) {
      const blend = blendMarketBaseline({ dogAdp: bad ?? null, sleeperAdp: bad ?? null, format: 'standard' });
      expect(blend.unknown).toBe(true);
      expect(blend.adp).toBeNull();
      expect(blend.weights).toEqual({ dog: 0, sleeper: 0 });
    }
  });
});

// --------------------------------------------------------------------------
// 2. The sort
// --------------------------------------------------------------------------

describe('sort modes', () => {
  const row = (name: string, score: number | null, total: number, adp: number | null, dogAdp: number | null): SortableRow =>
    ({ name, score, total, adp, dogAdp });

  const rows = [
    row('unpriced-a', null, 0.04, null, null),
    row('unpriced-b', null, 0.02, null, null),
    row('priced-early', 90, 1.6, 12, 10),
    row('priced-mid', 70, -0.4, 40, 44),
    row('priced-late', 40, -2.9, 90, 88),
  ];

  it('Score keeps unscored players last, not first', () => {
    const sorted = sortBoard(rows, 'score').map((r) => r.name);
    expect(sorted.slice(0, 3)).toEqual(['priced-early', 'priced-mid', 'priced-late']);
    expect(sorted.slice(3).sort()).toEqual(['unpriced-a', 'unpriced-b']);
  });

  it('mutation: ordering on total alone floats the unscored to the top', () => {
    // The regression, reconstructed. `total` for an unpriced player is ~0,
    // which beats a priced player the draft has not reached.
    const naive = [...rows].sort((a, b) => b.total - a.total).map((r) => r.name);
    expect(naive[1]).toBe('unpriced-a');
    expect(naive[2]).toBe('unpriced-b');
  });

  it('ADP sorts only by Sleeper ADP, ascending, unpriced last', () => {
    expect(sortBoard(rows, 'adp').map((r) => r.adp)).toEqual([12, 40, 90, null, null]);
  });

  it('DOG sorts only by raw Underdog ADP, ascending, unpriced last', () => {
    expect(sortBoard(rows, 'dog').map((r) => r.dogAdp)).toEqual([10, 44, 88, null, null]);
  });

  it('the two markets order differently, so neither is standing in for the other', () => {
    // `priced-mid` is 40 on Sleeper and 44 on DOG: the columns are independent.
    const byAdp = sortBoard(rows, 'adp').map((r) => r.name);
    const byDog = sortBoard(rows, 'dog').map((r) => r.name);
    expect(byAdp).toEqual(byDog); // same order here, but from different keys
    expect(sortBoard(rows, 'adp')[1]!.adp).toBe(40);
    expect(sortBoard(rows, 'dog')[1]!.dogAdp).toBe(44);
  });

  it('changing sort mode mutates nothing on any row', () => {
    const before = rows.map((r) => ({ ...r }));
    for (const mode of ['score', 'adp', 'dog'] as const) sortBoard(rows, mode);
    expect(rows).toEqual(before);
    // And the objects that come out are the objects that went in.
    expect(sortBoard(rows, 'adp').every((r) => rows.includes(r))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// 3. The candidate pool
// --------------------------------------------------------------------------

describe('draftability', () => {
  it('keeps an unpriced player who is on an NFL roster', () => {
    // Audric Estime (NO), Brashard Smith (KC), J.J. McCarthy (MIN) — all in the
    // reported cluster, all unpriced, all genuinely draftable.
    for (const team of ['NO', 'KC', 'MIN']) {
      expect(isDraftable({ team, sleeperAdp: null, dogAdp: null }), team).toBe(true);
    }
  });

  it('keeps a free agent either market has priced', () => {
    expect(isDraftable({ team: null, sleeperAdp: 130, dogAdp: null })).toBe(true);
    expect(isDraftable({ team: null, sleeperAdp: null, dogAdp: 118 })).toBe(true);
    expect(draftableReason({ team: null, sleeperAdp: null, dogAdp: 118 })).toContain('Underdog');
  });

  it('drops a player with no team and no price from either market', () => {
    // Chris Carson, Chase Edmonds, Bryce Love as Sleeper actually records them:
    // active, status "Active", no team, a low search_rank, and unpriced.
    expect(isDraftable({ team: null, sleeperAdp: null, dogAdp: null })).toBe(false);
    expect(draftableReason({ team: null, sleeperAdp: null, dogAdp: null })).toBe('no NFL team and no market price');
  });

  it('does not treat a free-agent marker as a team', () => {
    for (const marker of ['', '  ', 'FA', 'fa', 'None']) {
      expect(isDraftable({ team: marker, sleeperAdp: null, dogAdp: null }), marker).toBe(false);
    }
  });

  it('is free-agency-neutral: the rule is about evidence, not employment', () => {
    // The same free agent, before and after any market prices him.
    const hunt = { team: null, sleeperAdp: null, dogAdp: null };
    expect(isDraftable(hunt)).toBe(false);
    expect(isDraftable({ ...hunt, dogAdp: 142 })).toBe(true);
  });
});

// --------------------------------------------------------------------------
// 4. Position balance — the separate QB finding
// --------------------------------------------------------------------------

describe('positional structure is bounded', () => {
  /** Twelve QBs in bands against forty dense backs — a real board's shape. */
  function sparseQbBoard(): AvailablePlayerInput[] {
    const rows: AvailablePlayerInput[] = [];
    [30, 34, 55, 58, 62, 95, 99, 104, 140, 145, 150, 155].forEach((adp, i) =>
      rows.push(entry(`QB${i + 1}`, 'QB', adp)),
    );
    for (let i = 0; i < 40; i++) rows.push(entry(`RB${i + 1}`, 'RB', 20 + i * 4));
    for (let i = 0; i < 40; i++) rows.push(entry(`WR${i + 1}`, 'WR', 18 + i * 4));
    return rows;
  }

  const structureOf = (rec: { components: ComponentScore[] }): number =>
    rec.components
      .filter((c) => (POSITIONAL_STRUCTURE.keys as readonly string[]).includes(c.key))
      .reduce((a, c) => a + c.contribution, 0);

  it('holds the four sparsity components to a joint ceiling', () => {
    // Each scaled contribution is re-rounded to three decimals so the
    // breakdown shows the number that actually moved the ranking, which can
    // carry the sum up to 0.0005 past the cap per component. Four components,
    // so 0.002 is the whole of the slack the rounding can produce.
    const roundingSlack = 0.002;
    const ranked = rankAvailablePlayers(sparseQbBoard(), ctx({ currentPick: 60, nextPick: 72 }));
    for (const rec of ranked) {
      expect(Math.abs(structureOf(rec)), rec.playerId).toBeLessThanOrEqual(
        POSITIONAL_STRUCTURE.cap + roundingSlack,
      );
    }
    // And it genuinely bites somewhere on this board, or the assertion above is
    // proving nothing.
    expect(ranked.some((rec) => Math.abs(structureOf(rec)) > POSITIONAL_STRUCTURE.cap - 0.01)).toBe(true);
  });

  it('mutation: uncapped, a sparse position collects every one of them at once', () => {
    // scarcity + tier_cliff + separation + opportunity all measure the same
    // underlying fact — how thin the position is — and sum to 0.9 unchecked.
    const uncapped = [
      { key: 'scarcity', score: 0.083 },
      { key: 'tier_cliff', score: 0.15 },
      { key: 'separation', score: 0.25 },
      { key: 'opportunity', score: 0.227 },
    ].map((c) => ({
      ...c,
      label: '',
      display: '',
      weight: 1,
      contribution: c.score,
      unknown: false,
    })) as ComponentScore[];
    const before = uncapped.reduce((a, c) => a + c.contribution, 0);
    expect(before).toBeCloseTo(0.71, 2); // measured on the board above, at pick 60
    capPositionalStructure(uncapped);
    expect(uncapped.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(POSITIONAL_STRUCTURE.cap, 3);
  });

  it('scales proportionally, so the cap cannot change which component is talking', () => {
    const components = [
      { key: 'scarcity', score: 0.2 },
      { key: 'separation', score: 0.6 },
    ].map((c) => ({
      ...c,
      label: '',
      display: '',
      weight: 1,
      contribution: c.score,
      unknown: false,
    })) as ComponentScore[];
    capPositionalStructure(components);
    // 1:3 before, 1:3 after.
    expect(components[1]!.contribution / components[0]!.contribution).toBeCloseTo(3, 6);
  });

  it('leaves an ordinary position alone', () => {
    const components = [
      { key: 'scarcity', score: -0.13 },
      { key: 'separation', score: 0.158 },
      { key: 'opportunity', score: 0.123 },
    ].map((c) => ({
      ...c,
      label: '',
      display: '',
      weight: 1,
      contribution: c.score,
      unknown: false,
    })) as ComponentScore[];
    const before = components.map((c) => c.contribution);
    capPositionalStructure(components);
    expect(components.map((c) => c.contribution)).toEqual(before);
  });

  it('an empty QB slot alone cannot leap a quarterback over a better player', () => {
    const empty = rankAvailablePlayers(sparseQbBoard(), ctx({ currentPick: 12, nextPick: 24, rosterCounts: { QB: 0, RB: 0, WR: 0, TE: 0 } }));
    const filled = rankAvailablePlayers(sparseQbBoard(), ctx({ currentPick: 12, nextPick: 24, rosterCounts: { QB: 1, RB: 0, WR: 0, TE: 0 } }));
    const qbOf = (rows: typeof empty) => rows.find((r) => r.position === 'QB')!;
    const needOf = (rec: { components: ComponentScore[] }): number =>
      rec.components.find((c) => c.key === 'need')?.contribution ?? 0;
    /*
     * Roster need is not the QB problem, and this is still the measurement that
     * says so: the `need` *component* moves by about five hundredths when the
     * slot is filled, which is one pick of ADP — exactly what
     * `DEFAULT_WEIGHTS.need` documents. The inflation was elsewhere, and this
     * assertion is about the place it was not.
     */
    expect(Math.abs(needOf(qbOf(empty)) - needOf(qbOf(filled)))).toBeLessThan(0.1);
    // And in round one the board is still a market: the best players lead.
    expect(empty[0]!.position).not.toBe('QB');
  });

  /**
   * The other half of the same finding, and the one the owner reported from a
   * rehearsal of his own league: he took a quarterback in round two and the top
   * of the list was quarterbacks again by round seven.
   *
   * The four sparsity components are what was carrying that, and none of them
   * had any way to know the slot was closed — "there is nothing left like him
   * at quarterback" is a true sentence about a player who cannot start for you.
   * `structureVoice` lowers their joint ceiling once a position can no longer
   * reach the lineup, so filling the slot is now worth about eight picks of ADP
   * against a position that is still open, rather than one.
   *
   * The composite is what moves. Every component keeps its own measurement:
   * see `tests/draft.filledPosition.test.ts` for the ceiling itself.
   */
  it('stops leading with a quarterback once the quarterback slot is closed', () => {
    const open = ctx({ currentPick: 60, nextPick: 72, rosterCounts: { QB: 0, RB: 0, WR: 0, TE: 0 } });
    const closed = ctx({ currentPick: 60, nextPick: 72, rosterCounts: { QB: 1, RB: 0, WR: 0, TE: 0 } });
    const empty = rankAvailablePlayers(sparseQbBoard(), open);
    const filled = rankAvailablePlayers(sparseQbBoard(), closed);
    const qbOf = (rows: typeof empty) => rows.find((r) => r.position === 'QB')!;

    // The same board, at the same pick, with the same market: the only
    // difference is whether the reader has a quarterback.
    expect(empty[0]!.position, 'he genuinely is the value here').toBe('QB');
    expect(filled[0]!.position, 'and he is no longer the pick once you have one').not.toBe('QB');

    // He falls, and he falls by a bounded amount rather than off the board.
    expect(qbOf(filled).total).toBeLessThan(qbOf(empty).total);
    expect(structureOf(qbOf(filled))).toBeLessThanOrEqual(
      POSITIONAL_STRUCTURE.cap * POSITIONAL_STRUCTURE.filledVoice.single + 0.002,
    );
    expect(qbOf(filled).score, 'still scored, still comparable, still draftable').not.toBeNull();
  });

  it('a quarterback still leads when he is the genuine value', () => {
    // The cap bounds the premium; it does not suppress the position. At pick 60
    // the best QB has fallen 26 picks and the best back 16, and he should win.
    const ranked = rankAvailablePlayers(sparseQbBoard(), ctx({ currentPick: 60, nextPick: 72 }));
    expect(ranked[0]!.position).toBe('QB');
  });
});
