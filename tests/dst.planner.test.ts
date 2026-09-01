/**
 * The DST planner: when a defence is worth a roster spot, and when it is not.
 *
 * Every test here is built on the product this lane is for — a manager who
 * often drafts no defence, streams through the season, and holds a good one
 * when the schedule says so. The assertions that matter most are the negative
 * ones: that a better defence is not automatically a swap, that a stash is not
 * recommended by default, and that an unscorable bench player is never given a
 * price so a marginal defence can look free.
 */

import { describe, expect, it } from 'vitest';
import { planDst, DST_PLAN, type DstOption, type DstPlanInput } from '../src/core/dst/planner.ts';
import type { DstOutlook } from '../src/core/dst/outlook.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import { DST_ROSTER_POSITIONS } from '../src/core/demo/fixtures/dst.ts';
import type { StreamingAssessment } from '../src/core/startsit/streaming.ts';

const SHAPE = buildRosterShape(DST_ROSTER_POSITIONS);
const TWO_DEF = buildRosterShape([...DST_ROSTER_POSITIONS, 'DEF']);
const NO_DEF = buildRosterShape(DST_ROSTER_POSITIONS.filter((p) => p !== 'DEF'));

const NOW = '2026-09-10T12:00:00.000Z';
/** Inside the 72-hour window. */
const SOON = '2026-09-11T00:20:00.000Z';
/** Outside it — a fortnight of nothing to do. */
const FAR = '2026-09-24T00:20:00.000Z';

function outlook(perWeek: number | null, extra: Partial<DstOutlook> = {}): DstOutlook {
  return {
    team: extra.team ?? 'XX',
    weeks: extra.weeks ?? [],
    perWeek,
    total: perWeek == null ? null : perWeek * (extra.playable ?? 3),
    ratedFromLine: extra.ratedFromLine ?? 0,
    ratedFromForm: extra.ratedFromForm ?? 3,
    playable: extra.playable ?? 3,
    byes: extra.byes ?? [],
    confidence: extra.confidence ?? 'low',
    display: extra.display ?? '',
    notes: extra.notes ?? [],
  };
}

function option(team: string, thisWeek: number | null, extra: Partial<DstOption> = {}): DstOption {
  return {
    playerId: extra.playerId ?? team.toLowerCase(),
    name: extra.name ?? `${team} Defense`,
    team,
    thisWeek,
    confidence: extra.confidence ?? 'high',
    unavailable: extra.unavailable ?? false,
    unavailableReason: extra.unavailableReason ?? null,
    locked: extra.locked ?? false,
    opponent: extra.opponent ?? 'OPP',
    opponentImpliedTotal: extra.opponentImpliedTotal ?? 20,
    forward: extra.forward ?? null,
    playoff: extra.playoff ?? null,
  };
}

function streaming(replacementLevel: number | null): StreamingAssessment {
  return {
    position: 'DEF',
    verdict: 'streamable',
    label: '',
    rosteredPlayerId: null,
    rosteredName: null,
    rosteredScore: null,
    replacementLevel,
    poolConsidered: 3,
    options: [],
    detail: '',
    notes: [],
  };
}

function input(over: Partial<DstPlanInput> = {}): DstPlanInput {
  return {
    now: NOW,
    currentWeek: 1,
    shape: SHAPE,
    bestBall: false,
    draftComplete: true,
    nextKickoff: SOON,
    rostered: [],
    available: [],
    streaming: streaming(6),
    roster: { openSpots: 1, dropCandidate: null },
    playoff: { weeks: [15, 16, 17], emphasis: 0 },
    ...over,
  };
}

describe('activation is decided on game state, never on a calendar date', () => {
  it('says nothing at all before a draft has finished', () => {
    const plan = planDst(input({ draftComplete: false, available: [option('PIT', 9)] }));

    expect(plan.activation).toBe('pre_draft');
    expect(plan.surface).toBe(false);
    expect(plan.headline).toBe('');
  });

  it('waits when the draft is done, the kickoff is a fortnight away and the slot would cost a drop', () => {
    const plan = planDst(
      input({
        nextKickoff: FAR,
        available: [option('PIT', 9)],
        // The bench spot the wait is buying. Without one there is nothing to
        // buy and the empty slot is filled — see the test below.
        roster: { openSpots: 0, dropCandidate: { playerId: 'wr9', name: 'Deep Flier', position: 'WR', surplus: 1.2 } },
      }),
    );

    expect(plan.decision).toBe('wait');
    expect(plan.activation).toBe('outside_window');
    expect(plan.headline).toMatch(/your DEF slot is empty/i);
    expect(plan.why.join(' ')).toMatch(/would cost/i);
  });

  /*
   * The post-draft report this rule came from: an empty DEF slot, room on the
   * roster, and a card reading "no DST needed yet" nine days before week one.
   */
  it('fills an empty DEF slot before the window when it costs no drop', () => {
    const plan = planDst(input({ nextKickoff: FAR, available: [option('PIT', 9)] }));

    expect(plan.activation).toBe('active');
    expect(plan.decision).toBe('add');
    expect(plan.headline).toMatch(/Add PIT/);
    expect(plan.why.join(' ')).toMatch(/Nothing is in the DEF slot/i);
  });

  it('names the empty slot even when the wire cannot be ranked', () => {
    /*
     * The state between a draft and the first priced slate: the window is open
     * because the slot is empty and free, and nothing in the pool has a number
     * on it yet. "DST outlook unavailable" alone describes what the app could
     * not do; the reader needs the slot first.
     */
    const plan = planDst(input({ nextKickoff: FAR, available: [option('PIT', null)] }));

    expect(plan.activation).toBe('active');
    expect(plan.decision).toBe('unknown');
    expect(plan.why.join(' ')).toMatch(/nothing is in your DEF slot/i);
  });

  it('still waits on an empty slot when no kickoff is known at all', () => {
    const plan = planDst(input({ nextKickoff: null, available: [option('PIT', 9)] }));

    expect(plan.decision).toBe('wait');
    expect(plan.activation).toBe('outside_window');
    expect(plan.headline).toMatch(/your DEF slot is empty/i);
  });

  it('activates inside the window', () => {
    const plan = planDst(input({ available: [option('PIT', 9)] }));

    expect(plan.activation).toBe('active');
    expect(plan.decision).toBe('add');
    expect(plan.headline).toMatch(/Add PIT/);
  });

  it('acts before the window when the rostered defence has a bye to cover', () => {
    const current = option('BUF', 8, { forward: outlook(7, { byes: [2] }) });
    const plan = planDst(input({ nextKickoff: FAR, currentWeek: 1, rostered: [current], available: [option('NYJ', 9)] }));

    expect(plan.activation).toBe('active');
    expect(plan.surface).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/bye in week 2/i);
  });

  it('is silent in a best-ball league, where there is no weekly decision', () => {
    const plan = planDst(input({ bestBall: true, available: [option('PIT', 12)] }));

    expect(plan.activation).toBe('best_ball');
    expect(plan.surface).toBe(false);
    expect(plan.decision).toBe('unknown');
  });

  it('is silent in a league that starts no defence', () => {
    const plan = planDst(input({ shape: NO_DEF, available: [option('PIT', 12)] }));

    expect(plan.activation).toBe('no_def_slot');
    expect(plan.surface).toBe(false);
  });

  it('is quiet rather than reassuring when a rostered defence needs nothing', () => {
    const plan = planDst(input({ nextKickoff: FAR, rostered: [option('BUF', 9)], available: [option('NYJ', 10)] }));

    expect(plan.surface).toBe(false);
    expect(plan.decision).toBe('hold');
  });
});

describe('streaming: better is not the same as worth it', () => {
  it('adds the best available defence into an empty slot', () => {
    const plan = planDst(input({ available: [option('PIT', 9), option('DEN', 7)] }));

    expect(plan.decision).toBe('add');
    expect(plan.target?.team).toBe('PIT');
  });

  it('streams when the upgrade is material', () => {
    const plan = planDst(
      input({ rostered: [option('BUF', 5)], available: [option('NYJ', 9.2)], streaming: streaming(6) }),
    );

    expect(plan.decision).toBe('stream');
    expect(plan.headline).toBe('Stream NYJ over BUF · +4.2');
    expect(plan.gain).toBeCloseTo(4.2, 5);
  });

  it('holds when the gain is real but small', () => {
    const plan = planDst(input({ rostered: [option('BUF', 8)], available: [option('NYJ', 9.4)] }));

    expect(plan.decision).toBe('hold');
    expect(plan.headline).toBe('No clear upgrade');
    expect(plan.gain! < plan.bar!).toBe(true);
  });

  it('asks for a wider gap when either side is thinly known', () => {
    const thin = { rostered: [option('BUF', 8, { confidence: 'low' as const })], available: [option('NYJ', 11)] };
    const plan = planDst(input(thin));

    // 3.0 clears the ordinary 2.5 bar and not the low-confidence one.
    expect(plan.bar).toBe(DST_PLAN.lowConfidenceChurnGain);
    expect(plan.decision).toBe('hold');
  });

  it('holds when the rostered defence is simply the best of them', () => {
    const plan = planDst(input({ rostered: [option('BUF', 12)], available: [option('NYJ', 8)] }));

    expect(plan.decision).toBe('hold');
    expect(plan.gain! < 0).toBe(true);
  });

  it('says so rather than guessing when nothing can be scored', () => {
    const plan = planDst(input({ available: [option('PIT', null)] }));

    expect(plan.decision).toBe('unknown');
    expect(plan.headline).toBe('DST outlook unavailable');
  });
});

describe('the roster spot has a price, and it is charged', () => {
  it('charges nothing when there is an open spot', () => {
    const plan = planDst(input({ rostered: [option('BUF', 8)], available: [option('NYJ', 11.5)] }));

    expect(plan.cost.needsDrop).toBe(false);
    expect(plan.bar).toBe(DST_PLAN.churnGain);
    expect(plan.decision).toBe('stream');
  });

  it('lets a weak bench player be dropped for a real upgrade', () => {
    const plan = planDst(
      input({
        available: [option('PIT', 9)],
        roster: { openSpots: 0, dropCandidate: { playerId: 'b1', name: 'A Spare Back', position: 'RB', surplus: 0.2 } },
      }),
    );

    expect(plan.decision).toBe('add');
    expect(plan.cost.points).toBe(0.2);
    expect(plan.cost.label).toMatch(/dropping A Spare Back/);
  });

  it('blocks a marginal stream when the bench player is worth more than the gain', () => {
    const plan = planDst(
      input({
        rostered: [option('BUF', 8)],
        available: [option('NYJ', 11.4)],
        roster: { openSpots: 0, dropCandidate: { playerId: 'b1', name: 'A Real Flier', position: 'WR', surplus: 4 } },
      }),
    );

    // +3.4 this week against a bench spot earning 4 a week is not an upgrade.
    expect(plan.decision).toBe('hold');
    expect(plan.bar).toBe(DST_PLAN.churnGain + 4);
  });

  it('never invents a number for a bench player it cannot score', () => {
    const plan = planDst(
      input({
        rostered: [option('BUF', 8)],
        available: [option('NYJ', 11)],
        roster: { openSpots: 0, dropCandidate: { playerId: 'b1', name: 'An Unpriced Rookie', position: 'RB', surplus: null } },
      }),
    );

    expect(plan.cost.points).toBeNull();
    expect(plan.cost.label).toMatch(/cannot be scored/);
    expect(plan.bar).toBe(DST_PLAN.unscorableDropGain);
    expect(plan.decision).toBe('hold');
  });
});

describe('multi-week: this week is not the only week', () => {
  it('holds a defence with a materially better run behind it', () => {
    const current = option('BUF', 8, { forward: outlook(11) });
    const better = option('NYJ', 11, { forward: outlook(5) });
    const plan = planDst(input({ rostered: [current], available: [better] }));

    expect(plan.decision).toBe('hold');
    expect(plan.headline).toMatch(/Hold BUF — next 3 favourable/);
  });

  it('still streams when the future agrees with the present', () => {
    const current = option('BUF', 8, { forward: outlook(7) });
    const better = option('NYJ', 12, { forward: outlook(11) });
    const plan = planDst(input({ rostered: [current], available: [better] }));

    expect(plan.decision).toBe('stream');
  });

  it('never argues a hold from a schedule it has not read', () => {
    const plan = planDst(input({ rostered: [option('BUF', 8)], available: [option('NYJ', 12)] }));

    expect(plan.decision).toBe('stream');
  });
});

describe('a bye is a missing week, not a bad defence', () => {
  it('streams a one-week fill when the rostered defence is out', () => {
    const current = option('BUF', null, { unavailable: true, unavailableReason: 'is on bye' });
    const plan = planDst(input({ rostered: [current], available: [option('NYJ', 7)] }));

    expect(plan.decision).toBe('stream');
    expect(plan.temporary).toBe(true);
    expect(plan.headline).toMatch(/BUF is on bye/);
  });

  it('does not treat the fill as a permanent replacement', () => {
    const current = option('BUF', null, { unavailable: true, unavailableReason: 'is on bye' });
    const plan = planDst(input({ rostered: [current], available: [option('NYJ', 7)] }));

    expect(plan.why.join(' ')).toMatch(/one-week fill/i);
    expect(plan.notes.join(' ')).toMatch(/still the rostered defence/);
  });

  it('goes quiet once the rostered defence has kicked off', () => {
    /*
     * A settled slot is not a decision. This is the same rule every locked
     * slot in the app is held to, and it is separated from the bye above on
     * purpose: a bye leaves a hole somebody has to fill, and a kickoff leaves a
     * slot that cannot be changed.
     */
    const current = option('BUF', 6, { locked: true, unavailable: true, unavailableReason: 'has already kicked off' });
    const plan = planDst(input({ rostered: [current], available: [option('NYJ', 14)] }));

    expect(plan.decision).toBe('hold');
    expect(plan.surface).toBe(false);
    expect(plan.target).toBeNull();
  });

  it('surfaces a bye far enough ahead to act on it', () => {
    const current = option('BUF', 9, { forward: outlook(9, { byes: [3] }) });
    const plan = planDst(input({ currentWeek: 2, rostered: [current], available: [option('NYJ', 9)] }));

    expect(plan.surface).toBe(true);
    expect(plan.headline).toMatch(/bye week 3/);
  });
});

describe('playoffs are the league’s own weeks, and a stash has to earn its slot', () => {
  const playoffWeeks = [14, 15, 16];

  function stashInput(over: Partial<DstPlanInput> = {}) {
    return input({
      currentWeek: 10,
      rostered: [option('BUF', 9, { forward: outlook(9) })],
      available: [option('NYJ', 8), option('DEN', 6, { playoff: outlook(13, { playable: 3 }) })],
      streaming: streaming(6),
      playoff: { weeks: playoffWeeks, emphasis: 0.7 },
      ...over,
    });
  }

  it('uses the weeks the league actually plays, not 15 to 17', () => {
    const plan = planDst(stashInput());

    expect(plan.playoffWeeks).toEqual(playoffWeeks);
    expect(plan.headline).toMatch(/Weeks 14–16/);
  });

  it('does not plan a stash while the season is too young to know', () => {
    const plan = planDst(stashInput({ currentWeek: 3, playoff: { weeks: playoffWeeks, emphasis: 0 } }));

    expect(plan.stash).toBeNull();
    expect(plan.decision).not.toBe('stash');
  });

  it('stashes when the multi-week gain clears the slot cost', () => {
    const plan = planDst(stashInput());

    expect(plan.stash?.team).toBe('DEN');
    expect(['stash', 'stream_and_stash']).toContain(plan.decision);
  });

  it('refuses a stash whose playoff edge does not beat what the wire will offer', () => {
    const plan = planDst(
      stashInput({ available: [option('NYJ', 8), option('DEN', 6, { playoff: outlook(6.4, { playable: 3 }) })] }),
    );

    expect(plan.stash).toBeNull();
  });

  it('charges a second defence more when a real bench player pays for it', () => {
    const plan = planDst(
      stashInput({
        roster: { openSpots: 0, dropCandidate: { playerId: 'b1', name: 'A Real Flier', position: 'WR', surplus: 5 } },
      }),
    );

    expect(plan.stash).toBeNull();
  });

  it('streams now and stashes later when both clear their own bars', () => {
    const plan = planDst(
      stashInput({
        rostered: [option('BUF', 5, { forward: outlook(5) })],
        available: [option('NYJ', 10, { forward: outlook(10) }), option('DEN', 6, { playoff: outlook(13, { playable: 3 }) })],
      }),
    );

    expect(plan.decision).toBe('stream_and_stash');
    expect(plan.target?.team).toBe('NYJ');
    expect(plan.stash?.team).toBe('DEN');
    expect(plan.headline).toMatch(/Stream NYJ this week · stash DEN for Weeks 14–16/);
  });

  it('does not roster a second defence by default', () => {
    const plan = planDst(
      stashInput({ available: [option('NYJ', 8), option('DEN', 6, { playoff: null })] }),
    );

    expect(plan.stash).toBeNull();
  });
});

describe('a league that starts two defences is a different game', () => {
  it('fills the slots rather than streaming one of them', () => {
    const plan = planDst(
      input({ shape: TWO_DEF, rostered: [option('BUF', 9)], available: [option('NYJ', 8)] }),
    );

    expect(plan.decision).toBe('add');
    expect(plan.headline).toMatch(/1 DEF slot unfilled/);
    expect(plan.notes.join(' ')).toMatch(/starts 2 defences/);
  });

  it('holds quietly once both slots are filled, and never streams one', () => {
    const plan = planDst(
      input({ shape: TWO_DEF, rostered: [option('BUF', 9), option('SEA', 7)], available: [option('NYJ', 14)] }),
    );

    expect(plan.decision).toBe('hold');
    expect(plan.surface).toBe(false);
  });
});

describe('nothing here transacts', () => {
  it('never uses the language of an action it cannot take', () => {
    const plan = planDst(
      input({
        rostered: [option('BUF', 5)],
        available: [option('NYJ', 12)],
        roster: { openSpots: 0, dropCandidate: { playerId: 'b1', name: 'A Spare Back', position: 'RB', surplus: 0.1 } },
      }),
    );
    const prose = [plan.headline, ...plan.why, ...plan.notes].join(' ').toLowerCase();

    expect(prose).not.toMatch(/\bclaim(ed|ing)?\b/);
    expect(prose).not.toMatch(/\bbid\b/);
    expect(prose).not.toMatch(/\bsubmit\b/);
  });
});
