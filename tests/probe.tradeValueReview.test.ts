/**
 * The trade-value probe's checks, run against answers that are wrong on purpose.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs with no declarations
import { reviewAntisymmetry, reviewCheck, reviewReplay } from '../scripts/lib/tradeValueReview.mjs';

function line(over: Record<string, unknown> = {}) {
  return { name: 'P', position: 'WR', rate: 15, games: 12, startsWeeks: 12, rosValue: 50, ...over };
}
function side(over: Record<string, unknown> = {}) {
  return {
    label: 'Dermot',
    isMine: false,
    lineupChange: 20,
    depthChange: 1,
    adjustmentTotal: 0,
    adjustments: [],
    net: 21,
    incoming: [line()],
    outgoing: [line()],
    ...over,
  };
}
function answer(over: Record<string, unknown> = {}, a = side({ label: 'Alex', isMine: true }), b = side({ net: 10, lineupChange: 9 })) {
  return {
    found: true,
    evaluation: {
      status: 'ok',
      weeks: { first: 5, last: 17, count: 13 },
      a,
      b,
      verdict: { kind: 'leans_a', gap: 11, band: 4, headline: 'Leans toward you, about 11 pts.' },
      confidence: 'high',
      ...over,
    },
  };
}

describe('the checks', () => {
  it('pass a sound answer', () => {
    expect(reviewCheck('t', answer())).toEqual([]);
  });

  it('catch a net that is not a credible season total', () => {
    const bad = answer({}, side({ label: 'Alex', isMine: true, net: 900, lineupChange: 899, depthChange: 1 }));
    expect(reviewCheck('t', bad).join(' ')).toMatch(/credible/);
  });

  it('catch parts that do not add up', () => {
    const bad = answer({}, side({ label: 'Alex', isMine: true, net: 40 }));
    expect(reviewCheck('t', bad).join(' ')).toMatch(/does not add up/);
  });

  it('catch a gap inside the band that was not called a close call, and the reverse', () => {
    const inside = answer({ verdict: { kind: 'leans_a', gap: 11, band: 20, headline: 'Leans toward you, about 11 pts.' } });
    expect(reviewCheck('t', inside).join(' ')).toMatch(/not called a close call/);
    const outside = answer({ verdict: { kind: 'close', gap: 11, band: 4, headline: 'Close call. Within about 4 pts.' } });
    expect(reviewCheck('t', outside).join(' ')).toMatch(/was called a close call/);
  });

  it('catch a verdict pointing the wrong way', () => {
    const bad = answer({ verdict: { kind: 'favors_b', gap: 11, band: 4, headline: 'Favors Dermot by about 11 pts.' } });
    expect(reviewCheck('t', bad).join(' ')).toMatch(/wrong way/);
  });

  it('catch a band under its floor and a gap that is not the difference of the nets', () => {
    expect(reviewCheck('t', answer({ verdict: { kind: 'leans_a', gap: 11, band: 1, headline: 'Leans toward you, about 11.' } })).join(' ')).toMatch(/floor/);
    expect(reviewCheck('t', answer({ verdict: { kind: 'leans_a', gap: 30, band: 4, headline: 'Leans toward you, about 30.' } })).join(' ')).toMatch(/difference/);
  });

  it('catch preferences on anybody but Alex', () => {
    const bad = answer({}, side({ label: 'Alex', isMine: true }), side({ adjustments: [{ key: 'rb_lean' }] }));
    expect(reviewCheck('t', bad).join(' ')).toMatch(/not Alex/);
  });

  it('catch weekly figures that do not add up to the lineup change', () => {
    const weekly = [
      { week: 5, lineupBefore: 100, lineupAfter: 110, depthBefore: 0, depthAfter: 0 },
      { week: 6, lineupBefore: 100, lineupAfter: 110, depthBefore: 0, depthAfter: 0 },
    ];
    const bad = answer({}, side({ label: 'Alex', isMine: true, lineupChange: 50, net: 51, weekly }));
    const ok = answer({}, side({ label: 'Alex', isMine: true, lineupChange: 20, net: 21, weekly }));
    (bad as { evaluation: { weeks: unknown } }).evaluation.weeks = { first: 5, last: 6, count: 2 };
    (ok as { evaluation: { weeks: unknown } }).evaluation.weeks = { first: 5, last: 6, count: 2 };
    expect(reviewCheck('t', bad).join(' ')).toMatch(/weeks add to 20.0/);
    expect(reviewCheck('t', ok).join(' ')).not.toMatch(/weeks add to/);
  });

  it('catch a player who is not credible', () => {
    const bad = answer({}, side({ label: 'Alex', isMine: true, incoming: [line({ rosValue: 700 })] }));
    expect(reviewCheck('t', bad).join(' ')).toMatch(/not credible/);
  });

  it('catch wording that implies the app acts', () => {
    const bad = { ...answer(), advisory: 'We will send this offer for you.' };
    expect(reviewCheck('t', bad).join(' ')).toMatch(/implies the app acts/);
  });

  it('catch a refusal with no reason, and a refusal that still carries a verdict', () => {
    expect(reviewCheck('t', { found: true, evaluation: { status: 'insufficient', verdict: null } }).join(' ')).toMatch(/no reason/);
    expect(
      reviewCheck('t', { found: true, evaluation: { status: 'insufficient', insufficientReason: 'x', verdict: { kind: 'close' } } }).join(' '),
    ).toMatch(/still carried/);
  });

  it('catch an answer that is missing altogether', () => {
    expect(reviewCheck('t', { found: false })).toHaveLength(1);
  });
});

describe('antisymmetry', () => {
  const forward = answer();
  const reversed = {
    found: true,
    evaluation: {
      ...forward.evaluation,
      a: forward.evaluation.b,
      b: forward.evaluation.a,
      verdict: { ...forward.evaluation.verdict, gap: -11, kind: 'leans_b' },
    },
  };

  it('passes when the two directions agree', () => {
    expect(reviewAntisymmetry('t', forward, reversed)).toEqual([]);
  });

  it('catches a team whose number depends on which chair it sat in', () => {
    const skewed = JSON.parse(JSON.stringify(reversed));
    skewed.evaluation.b.net = 50;
    expect(reviewAntisymmetry('t', forward, skewed).join(' ')).toMatch(/one way and/);
  });

  it('catches directions that disagree about whether there is a verdict', () => {
    const refused = { found: true, evaluation: { status: 'insufficient', insufficientReason: 'x', verdict: null } };
    expect(reviewAntisymmetry('t', forward, refused).join(' ')).toMatch(/disagree/);
  });
});

describe('the replay review', () => {
  it('runs the same checks on a roster-aware replay and bounds a bundle', () => {
    const body = {
      replays: [
        { season: '2026', week: 4, mode: 'roster_aware', rosters: [{ label: 'Alex' }, { label: 'Dermot' }], evaluation: answer().evaluation },
        { season: '2025', week: 6, mode: 'bundles', rosters: [{ label: 'A' }, { label: 'B' }], bundles: [{ total: 9999 }] },
      ],
    };
    const findings = reviewReplay(body);
    expect(findings.join(' ')).toMatch(/bundle totals 9999/);
    expect(findings.join(' ')).not.toMatch(/2026 week 4/);
  });

  it('says so when nothing came back', () => {
    expect(reviewReplay({})).toHaveLength(1);
  });
});
