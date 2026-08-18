/**
 * The 2026 -> 2027 fixture suite.
 *
 * Every case in §7 of the resilience brief, plus the two that make the rest of
 * them meaningful: that a Week 1 collision is structurally impossible, and that
 * a missing 2027 feed never promotes 2026 to current truth.
 *
 * These are written as facts about the pure modules rather than as an
 * end-to-end walk through a database, deliberately. The rollover happens once a
 * year, at a moment nobody chooses, on a deployment nobody is watching — the
 * behaviour has to be checkable without a season boundary actually occurring.
 */

import { describe, expect, it } from 'vitest';
import { resolveSeasonContext } from '../src/core/season/context.ts';
import { isForeignSeasonKey, leagueKey, seasonKey, seasonOfKey, sourceKey, weekKey } from '../src/core/season/keys.ts';
import { resolveLifecycle } from '../src/core/season/lifecycle.ts';
import {
  ROLLOVER_RULES,
  carryWeight,
  findSuccessorLeague,
  rolloverRule,
  type LeagueLike,
} from '../src/core/season/rollover.ts';
import { buildReadinessReport, gradeSource } from '../src/core/season/readiness.ts';

const league = (over: Partial<LeagueLike> & Pick<LeagueLike, 'id' | 'season'>): LeagueLike => ({
  name: 'The Junculator',
  totalRosters: 12,
  scoringLabel: 'Half-PPR',
  ...over,
});

const context2027 = (over: { seasonType?: string; week?: number } = {}) =>
  resolveSeasonContext({
    state: {
      season: '2027',
      seasonType: over.seasonType ?? 'pre',
      week: over.week ?? 0,
      fetchedAt: '2027-08-01T00:00:00Z',
    },
    now: new Date('2027-08-01T12:00:00Z'),
  });

// ------------------------------------------------------- same user, new league

describe('finding next season’s league', () => {
  it('takes Sleeper’s own succession link without asking', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, [
      league({ id: 'L2027', season: '2027', previousLeagueId: 'L2026' }),
      league({ id: 'OTHER', season: '2027', name: 'Work League', totalRosters: 10 }),
    ]);
    expect(result.league?.id).toBe('L2027');
    expect(result.confidence).toBe('exact');
    // The only confidence that may switch the user's league silently.
    expect(result.autoSelect).toBe(true);
  });

  it('proposes but does not take a name/size/scoring match', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, [
      league({ id: 'L2027', season: '2027' }),
      league({ id: 'OTHER', season: '2027', name: 'Work League', totalRosters: 10, scoringLabel: 'PPR' }),
    ]);
    expect(result.league?.id).toBe('L2027');
    expect(result.confidence).toBe('likely');
    // Likely is a suggestion. Being asked one question in March beats
    // analysing the wrong league until somebody notices in September.
    expect(result.autoSelect).toBe(false);
  });

  it('sees through a year in the league name', () => {
    const previous = league({ id: 'L2026', season: '2026', name: 'The Junculator 2026' });
    const result = findSuccessorLeague(previous, [league({ id: 'L2027', season: '2027', name: 'The Junculator 2027' })]);
    expect(result.league?.id).toBe('L2027');
  });

  it('asks when two leagues look equally like the answer', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, [
      league({ id: 'A', season: '2027' }),
      league({ id: 'B', season: '2027' }),
    ]);
    expect(result.league).toBeNull();
    expect(result.confidence).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  it('asks when two leagues both claim the succession link', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, [
      league({ id: 'A', season: '2027', previousLeagueId: 'L2026' }),
      league({ id: 'B', season: '2027', previousLeagueId: 'L2026', name: 'Split League' }),
    ]);
    expect(result.confidence).toBe('ambiguous');
    expect(result.autoSelect).toBe(false);
  });

  it('says nothing has appeared yet rather than inventing one', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, []);
    expect(result.league).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.reason).toContain('2027');
  });

  it('never proposes the league the user is already in', () => {
    const previous = league({ id: 'L2026', season: '2026' });
    const result = findSuccessorLeague(previous, [previous]);
    // Same season means it is not a successor, whatever it matches on.
    expect(result.confidence).toBe('none');
  });
});

// ------------------------------------------------- what survives the boundary

describe('carry forward with decay, rebuild everything about this season', () => {
  it('carries behavioural signals and ages them', () => {
    const faab = rolloverRule('manager FAAB tendencies')!;
    expect(faab.disposition).toBe('carry_decayed');
    expect(carryWeight(faab, 0)).toBe(1);
    expect(carryWeight(faab, 1)).toBeCloseTo(0.5, 6);
    expect(carryWeight(faab, 2)).toBeCloseTo(0.25, 6);
  });

  it('rebuilds everything whose subject is this season', () => {
    for (const category of ['roster', 'draft', 'injuries', 'ADP', 'waiver pool', 'standings', 'props', 'schedule']) {
      expect(rolloverRule(category)?.disposition).toBe('rebuild');
    }
  });

  it('gives a rebuilt category no carried weight at all', () => {
    // The assertion behind "an old OUT designation does not survive": there is
    // no decay curve for an injury, only a rebuild.
    expect(carryWeight(rolloverRule('injuries')!, 0)).toBe(0);
    expect(carryWeight(rolloverRule('roster')!, 0)).toBe(0);
  });

  it('keeps last season queryable without letting it be sourced as current', () => {
    expect(rolloverRule('historical recommendations')?.disposition).toBe('retain_history');
    expect(rolloverRule('injury history')?.disposition).toBe('retain_history');
  });

  it('has an entry for every category, so a gap is visible rather than assumed', () => {
    expect(ROLLOVER_RULES.length).toBeGreaterThan(0);
    for (const rule of ROLLOVER_RULES) {
      expect(rule.reason.length).toBeGreaterThan(0);
      if (rule.disposition === 'carry_decayed') expect(rule.halfLifeSeasons).toBeGreaterThan(0);
    }
  });
});

// -------------------------------------------------------- key collisions

describe('Week 1 2026 and Week 1 2027 cannot be the same key', () => {
  it('separates two seasons of the same week', () => {
    expect(weekKey('2026', 1, 'usage')).not.toBe(weekKey('2027', 1, 'usage'));
    expect(weekKey('2026', 1, 'usage')).toBe('2026:usage:w1');
  });

  it('separates two seasons of the same source fingerprint', () => {
    // The one that would have broken quietly: 2026's ETag sent against the
    // 2027 file can never match, so every tick downloads the whole file.
    expect(sourceKey('2026', 'injuries', 'etag')).not.toBe(sourceKey('2027', 'injuries', 'etag'));
  });

  it('separates two seasons of the same league', () => {
    expect(leagueKey('2026', 'L1', 'roster')).not.toBe(leagueKey('2027', 'L1', 'roster'));
  });

  it('can be read back, so a rollover sweep knows what it is deleting', () => {
    expect(seasonOfKey(weekKey('2026', 3, 'injuries'))).toBe('2026');
    expect(isForeignSeasonKey(weekKey('2026', 3, 'injuries'), '2027')).toBe(true);
    expect(isForeignSeasonKey(weekKey('2027', 3, 'injuries'), '2027')).toBe(false);
  });

  it('leaves keys it does not understand alone', () => {
    // A sweep must not delete something it cannot identify — that is how the
    // manager tendencies §2 says to carry forward would get thrown away.
    expect(seasonOfKey('sleeper.nflState')).toBeNull();
    expect(isForeignSeasonKey('sleeper.nflState', '2027')).toBe(false);
  });

  it('cannot be made ambiguous by a component containing the separator', () => {
    const key = seasonKey('2027', 'source:with:colons', 'x');
    expect(seasonOfKey(key)).toBe('2027');
    // Three components in, three separator-delimited fields out: the colons
    // inside the component were substituted rather than allowed to split it.
    expect(key.split(':')).toHaveLength(3);
    expect(key).toBe('2027:source_with_colons:x');
  });
});

// ------------------------------------------------- provider rollover protection

describe('a missing 2027 feed never makes 2026 current truth', () => {
  it('calls previous-season data stale, not a fallback, once the season is under way', () => {
    const check = gradeSource(
      { name: 'injuries', season: '2026', records: 6068, publishesBeforeKickoff: false, blocking: false },
      context2027({ seasonType: 'regular', week: 3 }),
    );
    expect(check.status).toBe('stale');
    expect(check.found).toBe('2026');
    expect(check.wanted).toBe('2027');
    // Names both seasons, so the diagnosis is "waiting on 2027", not "stale".
    expect(check.detail).toContain('2027');
    expect(check.detail).toContain('2026');
  });

  it('calls the same data “waiting” in August, because August is not a fault', () => {
    const check = gradeSource(
      { name: 'injuries', season: '2026', records: 6068, publishesBeforeKickoff: false },
      context2027({ seasonType: 'pre', week: 0 }),
    );
    // Weekly injury reports cannot exist before week one. An alarm here every
    // preseason is an alarm nobody reads in November.
    expect(check.status).toBe('waiting');
  });

  it('does hold a preseason-published source to its word', () => {
    // ADP prices next season in May, so having only 2026 in August is a gap.
    const check = gradeSource(
      { name: 'ADP', season: '2026', records: 300, publishesBeforeKickoff: true },
      context2027({ seasonType: 'pre', week: 0 }),
    );
    expect(check.status).toBe('stale');
  });

  it('is ready when the source has current-season data, however little', () => {
    const check = gradeSource({ name: 'ADP', season: '2027', records: 1 }, context2027());
    expect(check.status).toBe('ready');
  });

  it('treats zero records as nothing, not as data', () => {
    const check = gradeSource(
      { name: 'ADP', season: '2027', records: 0, publishesBeforeKickoff: true },
      context2027(),
    );
    expect(check.status).toBe('stale');
    expect(check.found).toBeNull();
  });

  it('reports an error as failed rather than guessing from what is stored', () => {
    const check = gradeSource({ name: 'ADP', season: '2027', records: 40, error: 'timeout' }, context2027());
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('timeout');
  });
});

describe('the readiness report', () => {
  it('is ready in August with 2027 ADP and no 2027 injuries', () => {
    const report = buildReadinessReport(
      [
        { name: 'ADP', season: '2027', records: 300, publishesBeforeKickoff: true, blocking: true },
        { name: 'injuries', season: '2026', records: 6068, publishesBeforeKickoff: false, blocking: false },
        { name: 'Vegas props', season: null, blocking: false },
      ],
      context2027(),
    );
    expect(report.ready).toBe(true);
    // Ready and still waiting on something is the normal state of a preseason.
    expect(report.waitingOn).toBe('injuries');
    expect(report.summary).toContain('2027');
  });

  it('is not ready when a blocking source is still on last season', () => {
    const report = buildReadinessReport(
      [{ name: 'ADP', season: '2026', records: 300, publishesBeforeKickoff: true, blocking: true }],
      context2027(),
    );
    expect(report.ready).toBe(false);
    expect(report.waitingOn).toBe('ADP');
  });

  it('refuses to call the app ready on a guessed season', () => {
    // Nothing authoritative was read, so every check below is grading sources
    // against a season nobody confirmed.
    const guessed = resolveSeasonContext({ now: new Date('2027-09-01T00:00:00Z') });
    const report = buildReadinessReport([{ name: 'ADP', season: '2027', records: 300 }], guessed);
    expect(report.ready).toBe(false);
    expect(report.waitingOn).toBe('Sleeper season state');
  });

  it('publishes the carry-forward policy alongside the checks', () => {
    const report = buildReadinessReport([], context2027());
    expect(report.policy.find((p) => p.category === 'injuries')?.disposition).toBe('rebuild');
    expect(report.policy.find((p) => p.category === 'manager FAAB tendencies')?.disposition).toBe('carry_decayed');
  });
});

// ------------------------------------------------------------- lifecycle

describe('the eight lifecycle states', () => {
  const state = (seasonType: string, week: number, season = '2027') => ({
    season,
    seasonType,
    week,
    fetchedAt: '2027-08-01T00:00:00Z',
  });

  it('reads a live draft off the draft, not the calendar', () => {
    const r = resolveLifecycle({
      state: state('pre', 0),
      league: { season: '2027', status: 'pre_draft' },
      draft: { status: 'drafting' },
    });
    expect(r.lifecycle).toBe('draft_live');
    expect(r.draftLive).toBe(true);
    expect(r.draftVisible).toBe(true);
  });

  it('keeps the board up for a draft still running when Sleeper flips to regular', () => {
    /*
     * The one that would lose somebody their draft.
     *
     * Sleeper flips `season_type` to `regular` a little before week one, and
     * leagues that draft late are still drafting when it does. A live draft is
     * proof the draft has not happened yet, whatever the calendar says.
     */
    const r = resolveLifecycle({
      state: state('regular', 1),
      league: { season: '2027', status: 'in_season' },
      draft: { status: 'drafting' },
    });
    expect(r.lifecycle).toBe('draft_live');
    expect(r.draftVisible).toBe(true);
  });

  it('separates a scheduled draft from a finished one', () => {
    const open = resolveLifecycle({ state: state('pre', 0), league: { season: '2027' }, draft: { status: 'pre_draft' } });
    expect(open.lifecycle).toBe('draft_open');

    const done = resolveLifecycle({ state: state('pre', 0), league: { season: '2027' }, draft: { status: 'complete' } });
    expect(done.lifecycle).toBe('post_draft');
    // A finished draft is not the regular season: the board is still what
    // people open the app for during the month afterwards.
    expect(done.draftVisible).toBe(true);
  });

  it('reaches the regular season and hides the board', () => {
    const r = resolveLifecycle({
      state: state('regular', 3),
      league: { season: '2027', status: 'in_season' },
      draft: { status: 'complete' },
    });
    expect(r.lifecycle).toBe('regular_season');
    expect(r.draftVisible).toBe(false);
  });

  it('tells the NFL postseason apart from this league being finished', () => {
    const playoffs = resolveLifecycle({ state: state('post', 1), league: { season: '2027', status: 'in_season' } });
    expect(playoffs.lifecycle).toBe('playoffs');

    const done = resolveLifecycle({ state: state('post', 1), league: { season: '2027', status: 'complete' } });
    expect(done.lifecycle).toBe('season_complete');
  });

  it('calls a league the NFL has moved past the offseason', () => {
    const r = resolveLifecycle({ state: state('pre', 0, '2028'), league: { season: '2027' } });
    expect(r.lifecycle).toBe('offseason');
    expect(r.draftVisible).toBe(false);
  });

  it('keeps the board when it knows nothing at all', () => {
    const r = resolveLifecycle({});
    expect(r.lifecycle).toBe('preseason');
    expect(r.draftVisible).toBe(true);
    expect(r.assumed).toBe(true);
  });

  /**
   * Matchup's gate, which is the mirror of the board's.
   *
   * A head-to-head has nothing to say until a draft is finished — every lineup
   * is empty and every projection is zero — and from that moment on it is the
   * screen an in-season reader opens first. Both directions matter: a tab that
   * arrives too early leads to a screen full of nothing, and one that never
   * arrives is a feature nobody can reach.
   */
  it('opens Matchup the day the draft finishes, and not before', () => {
    const drafting = resolveLifecycle({
      state: state('pre', 0),
      league: { season: '2027' },
      draft: { status: 'drafting' },
    });
    expect(drafting.matchupVisible).toBe(false);

    const scheduled = resolveLifecycle({
      state: state('pre', 0),
      league: { season: '2027' },
      draft: { status: 'pre_draft' },
    });
    expect(scheduled.matchupVisible).toBe(false);

    const done = resolveLifecycle({
      state: state('pre', 0),
      league: { season: '2027' },
      draft: { status: 'complete' },
    });
    expect(done.lifecycle).toBe('post_draft');
    expect(done.matchupVisible).toBe(true);
    // Both, for the one stretch of the year the bar carries seven.
    expect(done.draftVisible).toBe(true);
  });

  it('keeps Matchup through the season and drops it when the league is over', () => {
    const inSeason = resolveLifecycle({
      state: state('regular', 3),
      league: { season: '2027', status: 'in_season' },
      draft: { status: 'complete' },
    });
    expect(inSeason.matchupVisible).toBe(true);

    const playoffs = resolveLifecycle({ state: state('post', 1), league: { season: '2027', status: 'in_season' } });
    expect(playoffs.matchupVisible).toBe(true);

    const finished = resolveLifecycle({ state: state('post', 1), league: { season: '2027', status: 'complete' } });
    expect(finished.matchupVisible).toBe(false);

    const gone = resolveLifecycle({ state: state('pre', 0, '2028'), league: { season: '2027' } });
    expect(gone.matchupVisible).toBe(false);
  });

  it('does not offer Matchup when it knows nothing at all', () => {
    expect(resolveLifecycle({}).matchupVisible).toBe(false);
  });
});
