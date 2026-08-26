/**
 * The favourite, end to end: does hearting a player reach the Draft ranking?
 *
 * ## The report
 *
 * > I hearted a player on the Players screen, went to Draft, and he did not
 * > move up.
 *
 * The honest answer turned out to be three separate facts, and only the first
 * of them is what anybody expected.
 *
 * **1. The boost reaches the ranking, exactly as calibrated.** ♥ / ♥♥ / ♥♥♥
 * contribute 0.084 / 0.25 / 0.5 of composite — `DECISION_THRESHOLDS.myGuy.score`
 * times `DEFAULT_WEIGHTS.myGuy`, with nothing lost on the way. Persistence,
 * propagation and recompute are all intact, and the tests below walk the whole
 * chain rather than asserting the arithmetic in one place.
 *
 * **2. At one heart, the board very often does not visibly move — and that is
 * the design.** 0.084 of composite is under two picks of ADP, and a real board
 * is dense: measured on the mid-round demo scenario the ten players around rank
 * 31 sat inside 0.53 of composite of each other. A nudge worth 0.084 crosses
 * somebody only when the player above is within 0.084, which is a minority of
 * the time. The calibration note beside `DECISION_THRESHOLDS.myGuy` says so in
 * as many words — one heart "moves a player about two picks (a real
 * tiebreak) … Wanting a player is allowed to matter; it is not allowed to
 * overrule the board" — so a heart that changes the score and not the order is
 * the feature working.
 *
 * **3. Two things were genuinely wrong, and both were sentences.** The card
 * credited the boost to `★★`, which is the *queue* mark and explicitly changes
 * no ranking; and it promised "about 2 spots", which is a claim about board
 * position that a second-pass composite does not keep. Both are fixed — see
 * `MyGuyFlag.marks` and `picksMoved` — and both are pinned here.
 *
 * Nothing about the weights was touched. The numbers are calibrated, the
 * calibration is documented, and "the boost feels small" is a tuning
 * conversation with a real board in front of it, not a bug fix.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftBoard, type DraftBoardSources } from '../src/core/draft/boardBuilder.ts';
import { DECISION_THRESHOLDS, myGuy } from '../src/core/draft/decisions.ts';
import { DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';

const SCENARIO = 'draft-mid';

function scenario() {
  const data = buildDraftScenario(findScenario(SCENARIO)!);
  return { data, sources: draftBoardSourcesFrom(data), draftId: data.draft!.id };
}

/**
 * The board, with exactly one player hearted and every other mark cleared.
 *
 * Written through `sources.flags`, which is the *only* way a My Guy level
 * reaches the board — the same map the server fills from `player_flags` and the
 * demo fills from its fixture. Substituting the source rather than the
 * component is what makes these tests about the propagation path and not about
 * the arithmetic at the end of it.
 */
async function boardWith(playerId: string | null, level: 0 | 1 | 2 | 3) {
  const { sources, draftId } = scenario();
  const withFlag: DraftBoardSources = {
    ...sources,
    flags: async (id) => {
      const flags = new Map(await sources.flags(id));
      for (const [key, flag] of flags) flags.set(key, { ...flag, level: 0 });
      if (playerId) {
        const existing = flags.get(playerId);
        flags.set(playerId, { level, queued: existing?.queued ?? false, queueOrder: existing?.queueOrder ?? null });
      }
      return flags;
    },
  };
  return buildDraftBoard(withFlag, draftId, { limit: 300 });
}

/** The engine rounds every contribution to three places; so does this. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const rowFor = (board: Awaited<ReturnType<typeof boardWith>>, playerId: string) => {
  const index = board.recommendations.findIndex((rec) => rec.playerId === playerId);
  return { index, rec: board.recommendations[index]! };
};

describe('the favourite reaches the Draft ranking', () => {
  it('scores nothing when the player is not flagged', async () => {
    const baseline = await boardWith(null, 0);
    for (const rec of baseline.recommendations) {
      expect(rec.myGuy.level).toBe(0);
      expect(rec.components.find((c) => c.key === 'my_guy')!.contribution).toBe(0);
      expect(rec.reasons.join(' ')).not.toContain('personal preference');
    }
  });

  it('spends exactly the calibrated contribution at each level', async () => {
    const baseline = await boardWith(null, 0);
    const target = baseline.recommendations[30]!;

    for (const level of [1, 2, 3] as const) {
      const board = await boardWith(target.playerId, level);
      const { rec } = rowFor(board, target.playerId);
      const component = rec.components.find((c) => c.key === 'my_guy')!;

      // Rounded to three places by the engine, so this asserts the number the
      // card actually prints rather than one three decimals behind it.
      const expected = round3(DECISION_THRESHOLDS.myGuy.score[level]! * DEFAULT_WEIGHTS.myGuy);
      expect(component.contribution).toBe(expected);
      expect(rec.myGuy.level).toBe(level);
      expect(rec.myGuy.marks).toBe('♥'.repeat(level));
      // And the composite it feeds actually rose by at least what it spent
      // before the second pass reshuffles anything.
      expect(rec.total).toBeGreaterThan(target.total);
    }
  });

  it('reorders the board once the boost is big enough to cross somebody', async () => {
    const baseline = await boardWith(null, 0);
    /*
     * A player with a real gap above him, so ♥♥♥ can be expected to clear it.
     *
     * Chosen from the board rather than named, because a fixture edit that
     * moved him would otherwise turn this into a test about nothing — it looks
     * for the first candidate whose deficit to the player above is inside the
     * 0.5 a ♥♥♥ is worth, which is exactly the condition the claim rests on.
     */
    const crossable = baseline.recommendations.findIndex(
      (rec, i) => i > 0 && baseline.recommendations[i - 1]!.total - rec.total < DEFAULT_WEIGHTS.myGuy,
    );
    expect(crossable).toBeGreaterThan(0);

    const target = baseline.recommendations[crossable]!;
    const board = await boardWith(target.playerId, 3);
    const { index } = rowFor(board, target.playerId);

    expect(index).toBeLessThan(crossable);
    expect(board.recommendations[index]!.reasons.join(' ')).toContain('personal preference boost');
  });

  it('proves the score moved even where the order does not, which is most of the time', async () => {
    const baseline = await boardWith(null, 0);
    /*
     * A player the single heart cannot lift past the man above him.
     *
     * This is the reported case, made reproducible: the deficit above him is
     * larger than the 0.084 a ♥ is worth, so his position is arithmetically
     * unreachable — and the board is *still* obliged to show that the mark was
     * read and what it was worth. A card that silently scored nothing here
     * would be indistinguishable from a heart that never arrived, which is
     * precisely the ambiguity the original report was stuck in.
     */
    const oneHeart = round3(DECISION_THRESHOLDS.myGuy.score[1]! * DEFAULT_WEIGHTS.myGuy);
    const stuck = baseline.recommendations.findIndex(
      (rec, i) => i > 0 && baseline.recommendations[i - 1]!.total - rec.total > oneHeart * 3,
    );
    expect(stuck).toBeGreaterThan(0);

    const target = baseline.recommendations[stuck]!;
    const board = await boardWith(target.playerId, 1);
    const { index, rec } = rowFor(board, target.playerId);

    // He did not pass the player above him — and the card says why he still counted.
    expect(baseline.recommendations[stuck - 1]!.total - target.total).toBeGreaterThan(oneHeart);
    expect(index).toBeGreaterThanOrEqual(stuck - 1);
    expect(rec.components.find((c) => c.key === 'my_guy')!.contribution).toBe(oneHeart);
    expect(rec.total).toBeGreaterThan(target.total);
    expect(rec.reasons.join(' ')).toContain('personal preference boost');
  });

  it('is global, so it survives leaving the draft and coming back', async () => {
    /*
     * The persistence contract, at the level this layer can prove it.
     *
     * My Guy is a fact about a *player* and is stored globally — see
     * `repos/playerFlags.ts` — unlike the ★ queue, which belongs to one draft.
     * So the board reads the same level whichever draft asks, and rebuilding it
     * (which is what remounting the Draft screen does) reads it again rather
     * than remembering the last answer. `tests/integration.api.test.ts` covers
     * the write and the read-back through the real routes.
     */
    const baseline = await boardWith(null, 0);
    const target = baseline.recommendations[10]!;

    const first = await boardWith(target.playerId, 2);
    const second = await boardWith(target.playerId, 2);
    expect(rowFor(second, target.playerId).rec.total).toBe(rowFor(first, target.playerId).rec.total);
    expect(rowFor(second, target.playerId).index).toBe(rowFor(first, target.playerId).index);

    // Clearing it puts the board back exactly where it started.
    const cleared = await boardWith(target.playerId, 0);
    expect(cleared.recommendations.map((r) => r.playerId)).toEqual(
      baseline.recommendations.map((r) => r.playerId),
    );
  });
});

describe('the card names the mark the reader actually tapped', () => {
  it('credits the boost to ♥, never to the ★ that changes no ranking', async () => {
    const baseline = await boardWith(null, 0);
    const target = baseline.recommendations[4]!;
    const board = await boardWith(target.playerId, 2);
    const { rec } = rowFor(board, target.playerId);

    const sentence = rec.reasons.find((r) => r.includes('personal preference'))!;
    expect(sentence).toContain('♥♥');
    expect(sentence).not.toContain('★');
    expect(rec.components.find((c) => c.key === 'my_guy')!.display).toBe('♥♥ Strong My Guy');
  });

  it('measures the boost in picks of ADP, which is the unit it is actually in', async () => {
    const baseline = await boardWith(null, 0);
    const target = baseline.recommendations[4]!;
    const board = await boardWith(target.playerId, 3);
    const sentence = rowFor(board, target.playerId).rec.reasons.find((r) => r.includes('personal preference'))!;

    /*
     * "about 10 picks of ADP", not "about 10 spots".
     *
     * The number is a distance in market terms and the ADP column on the same
     * card is what a reader checks it against. Board position is a different
     * claim, and one the second-pass composite does not keep — the test above
     * is a case where the promise would have been broken outright.
     */
    expect(sentence).toMatch(/about \d+ picks of ADP/);
    expect(sentence).not.toMatch(/spots?\)/);
  });

  it('says nothing at all about preference for a player with no mark', async () => {
    const baseline = await boardWith(null, 0);
    const rec = baseline.recommendations[4]!;
    expect(rec.components.find((c) => c.key === 'my_guy')!.display).toBe('not flagged');
    expect(myGuy(0).marks).toBe('');
  });
});
