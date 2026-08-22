/**
 * When Draft stops being a destination.
 *
 * The failure this suite exists for is the tempting one: hiding the board the
 * moment the draft finishes. Leagues draft in July and play in September, and
 * the weeks in between are exactly when a user opens the board to look at what
 * they ended up with.
 */

import { describe, expect, it } from 'vitest';
import { resolveSeasonPhase } from '../src/core/sleeper/phase.ts';

const LEAGUE = { season: '2026', status: 'pre_draft' };

describe('before the regular season', () => {
  it('keeps Draft with nothing known at all', () => {
    const resolved = resolveSeasonPhase({});
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(true);
    expect(resolved.assumed, 'the safe default is marked as one').toBe(true);
  });

  it('keeps Draft through the preseason', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'pre', week: 3 },
      league: LEAGUE,
    });
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(true);
  });

  /**
   * The rule that matters most, stated on its own.
   *
   * A finished draft is not a started season, and treating it as one takes the
   * board away weeks early.
   */
  /*
   * These two used to assert the opposite, and the change is a product decision
   * rather than a bug fix: the board exists to help make picks, and once the
   * picks are made it is a record rather than a tool. The phase is still
   * preseason — a draft ending does not start a season — and every other
   * consumer of `phase` is unaffected. Only the tab goes.
   */
  it('drops Draft once this league’s draft is complete, while staying preseason', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'pre', week: 3 },
      league: { season: '2026', status: 'drafting' },
      draft: { status: 'complete' },
    });
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(false);
    expect(resolved.reason).toMatch(/draft is finished/);
  });

  it('drops Draft on a completed draft with no NFL state at all', () => {
    const resolved = resolveSeasonPhase({ draft: { status: 'complete' } });
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(false);
    expect(resolved.assumed).toBe(false);
  });

  /*
   * The safe direction, stated as tests.
   *
   * Everything that is not positively a completed draft keeps the board — a
   * draft still to open, one paused mid-round, one Sleeper has said nothing
   * about, and a status nobody has seen before. Hiding a board a user still
   * needs costs them their draft.
   */
  it('keeps Draft for every draft state that is not finished', () => {
    const preseason = { season: '2026', seasonType: 'pre', week: 3 } as const;
    for (const status of ['pre_draft', 'paused', 'drafting', 'unknown', '', null, undefined]) {
      const resolved = resolveSeasonPhase({
        state: preseason,
        league: { season: '2026', status: null },
        draft: { status: status ?? null },
      });
      expect(resolved.draftVisible, `draft status ${JSON.stringify(status)}`).toBe(true);
    }
    // And with no draft object at all.
    expect(resolveSeasonPhase({ state: preseason, league: { season: '2026' } }).draftVisible).toBe(true);
  });

  it('accepts every spelling Sleeper uses for a finished draft', () => {
    const preseason = { season: '2026', seasonType: 'pre', week: 3 } as const;
    for (const status of ['complete', 'completed', 'done', 'COMPLETE', ' Complete ']) {
      const resolved = resolveSeasonPhase({
        state: preseason,
        league: { season: '2026', status: null },
        draft: { status },
      });
      expect(resolved.draftVisible, `draft status ${JSON.stringify(status)}`).toBe(false);
    }
  });

  /**
   * Sleeper flips `season_type` to `regular` a few days before week one and
   * reports week 0 until it actually starts. The tab stays through that gap.
   */
  it('keeps Draft while the state says regular but week zero', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'regular', week: 0 },
      league: LEAGUE,
    });
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(true);
  });
});

describe('once the regular season starts', () => {
  it('hides Draft from week one', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'regular', week: 1 },
      league: { season: '2026', status: 'in_season' },
      draft: { status: 'complete' },
    });
    expect(resolved.phase).toBe('regular');
    expect(resolved.draftVisible).toBe(false);
    expect(resolved.reason).toContain('week 1');
  });

  it('hides Draft mid-season', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'regular', week: 11 },
      league: { season: '2026', status: 'in_season' },
    });
    expect(resolved.draftVisible).toBe(false);
  });

  it('hides Draft in the postseason', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'post', week: 1 },
      league: { season: '2026', status: 'in_season' },
    });
    expect(resolved.phase).toBe('postseason');
    expect(resolved.draftVisible).toBe(false);
  });

  /** The second witness, for when `/state/nfl` was never read. */
  it('hides Draft on the league status alone', () => {
    const resolved = resolveSeasonPhase({ league: { season: '2026', status: 'in_season' } });
    expect(resolved.phase).toBe('regular');
    expect(resolved.draftVisible).toBe(false);
    expect(resolved.assumed).toBe(false);
  });

  it('hides Draft for a league whose season is finished', () => {
    expect(resolveSeasonPhase({ league: { season: '2026', status: 'complete' } }).draftVisible).toBe(false);
  });
});

describe('seasons that do not line up', () => {
  it('treats a league the NFL has moved past as over', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2027', seasonType: 'pre', week: 1 },
      league: { season: '2026', status: 'in_season' },
    });
    expect(resolved.phase).toBe('offseason');
    expect(resolved.draftVisible).toBe(false);
  });

  /**
   * A dynasty league rolled forward before the NFL has: the state describes
   * last season and must not be read as this league's.
   */
  it('does not let last season’s state hide a new league’s draft', () => {
    const resolved = resolveSeasonPhase({
      state: { season: '2026', seasonType: 'regular', week: 14 },
      league: { season: '2027', status: 'pre_draft' },
    });
    expect(resolved.phase).toBe('preseason');
    expect(resolved.draftVisible).toBe(true);
  });
});
