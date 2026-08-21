/**
 * Phase 9 of the ranking-integrity audit: what evidence actually reaches a
 * Draft Score, and at what size.
 *
 * The newsletter ledger is the one input a reader edits by hand. They accept a
 * row, ignore another, correct a third, and a re-import supersedes a fourth —
 * and every one of those actions has to land on the board exactly once, at
 * exactly the size the ledger says, or not at all.
 *
 * Two things make that worth testing rather than reading. The tally is the only
 * component whose input is *mutable after the fact*, so a stale read is a real
 * hazard rather than a theoretical one; and it flows through three layers to get
 * to a score — the repo's `WHERE`, `effectiveEvidence`'s counted set, and the
 * engine's three news components — any of which could quietly drop or double a
 * row.
 *
 * So the chain is exercised end to end: build ledger rows in every review state,
 * aggregate them the way the board does, hand the result to the real ranking
 * engine, and read the contribution off the components.
 */

import { describe, expect, it } from 'vitest';
import { aggregatePlayerSignal, effectiveEvidence } from '../src/core/evidence/aggregate.ts';
import type { EvidenceItem, ReviewStatus } from '../src/core/evidence/types.ts';
import {
  rankAvailablePlayers,
  DEFAULT_WEIGHTS,
  NEWS_SATURATION,
  type AvailablePlayerInput,
} from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'];
const CTX = {
  currentPick: 40,
  nextPick: 52,
  shape: buildRosterShape(ROSTER),
  profile: buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER),
  rosterCounts: {},
  totalPicks: 180,
};

const NOW = '2026-08-20T00:00:00.000Z';
/** Inside every recency window, so a magnitude change is not a decay change. */
const RECENT = '2026-08-19T00:00:00.000Z';

let seq = 0;
function evidence(over: Partial<EvidenceItem> = {}): EvidenceItem {
  seq++;
  return {
    id: `ev-${seq}`,
    playerId: 'subject',
    sourceType: 'newsletter',
    sourceName: 'FF Newsletter',
    sourceMessageId: `msg-${seq}`,
    sourceDate: RECENT,
    excerpt: 'something happened',
    contextSummary: null,
    category: 'role',
    polarity: 'positive',
    magnitude: 1,
    confidence: 'high',
    confidenceScore: 0.9,
    ruleId: null,
    reviewStatus: 'auto_applied',
    userOverride: null,
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as EvidenceItem;
}

/*
 * Pinned to a fixed `now`, so the recency windows are the same on every run.
 * Passing a bare Date here type-checks as an options object with no properties
 * and silently defaults to the wall clock — which would make the seven-day
 * assertions below quietly time-dependent.
 */
const signalFrom = (items: EvidenceItem[]) => aggregatePlayerSignal('subject', items, { now: NOW });

function player(id: string, adp: number, signal: AvailablePlayerInput['signal']): AvailablePlayerInput {
  return {
    player: {
      id,
      sleeperPlayerId: id,
      fullName: `Player ${id}`,
      firstName: 'Player',
      lastName: id,
      team: 'DET',
      position: 'WR',
      status: null,
      active: true,
      normalizedName: id,
      aliases: [],
    },
    adp,
    adpRank: Math.round(adp),
    signal,
  };
}

/** The three news components' combined contribution for the subject. */
function newsContribution(items: EvidenceItem[]): number {
  const board = [
    player('subject', 45, items.length ? signalFrom(items) : null),
    // Peers so the board has a shape; none of them carries evidence.
    ...Array.from({ length: 12 }, (_, i) => player(`peer-${i}`, 40 + i * 3, null)),
  ];
  const recs = rankAvailablePlayers(board, CTX, DEFAULT_WEIGHTS);
  const subject = recs.find((r) => r.playerId === 'subject')!;
  return subject.components
    .filter((c) => c.key.startsWith('news_'))
    .reduce((total, c) => total + c.contribution, 0);
}

describe('only the counted ledger reaches a Score', () => {
  const EXCLUDED: ReviewStatus[] = ['ignored', 'superseded', 'pending'] as ReviewStatus[];

  for (const status of EXCLUDED) {
    it(`a ${status} row contributes exactly nothing`, () => {
      const withRow = newsContribution([evidence({ reviewStatus: status, magnitude: 2 })]);
      expect(withRow, `a ${status} row moved the Score`).toBe(0);
    });
  }

  it('counts the three states that are meant to count', () => {
    for (const status of ['auto_applied', 'accepted', 'corrected'] as ReviewStatus[]) {
      expect(newsContribution([evidence({ reviewStatus: status })]), `${status} was dropped`).toBeGreaterThan(0);
    }
  });

  it('does not let an ignored row dilute the ones that count', () => {
    // The failure this catches is an average rather than a sum: an excluded row
    // that still lands in the denominator makes a real row worth less.
    const alone = newsContribution([evidence()]);
    const beside = newsContribution([evidence(), evidence({ reviewStatus: 'ignored' as ReviewStatus, magnitude: 2 })]);
    expect(beside).toBe(alone);
  });

  it('reports a parked row as parked rather than as evidence', () => {
    const signal = signalFrom([evidence({ reviewStatus: 'pending' as ReviewStatus, magnitude: 2 })]);
    expect(signal.pendingCount).toBe(1);
    expect(signal.raw.net).toBe(0);
    expect(signal.raw.items).toBe(0);
  });
});

describe('the size the ledger says is the size the board uses', () => {
  it('keeps +2 twice the weight of +1, rather than flattening both to "positive"', () => {
    const one = newsContribution([evidence({ magnitude: 1 })]);
    const two = newsContribution([evidence({ magnitude: 2 })]);
    expect(two).toBeGreaterThan(one);
    // Below saturation the transfer is linear, so the ratio survives intact.
    expect(two / one).toBeCloseTo(2, 5);
  });

  it('mirrors the negative side exactly', () => {
    const plusTwo = newsContribution([evidence({ polarity: 'positive', magnitude: 2 })]);
    const minusTwo = newsContribution([evidence({ polarity: 'negative', magnitude: 2 })]);
    expect(minusTwo).toBeCloseTo(-plusTwo, 5);
  });

  it('carries −1 and −2 apart from each other too', () => {
    const one = newsContribution([evidence({ polarity: 'negative', magnitude: 1 })]);
    const two = newsContribution([evidence({ polarity: 'negative', magnitude: 2 })]);
    expect(two).toBeLessThan(one);
    expect(two / one).toBeCloseTo(2, 5);
  });

  it('saturates rather than growing without bound', () => {
    // Twenty +2 rows is four times the lifetime saturation point. The component
    // is capped, so the board cannot be carried by one prolific newsletter.
    const many = Array.from({ length: 20 }, () => evidence({ magnitude: 2 }));
    const capped = newsContribution(many);
    const atCap = newsContribution(
      Array.from({ length: NEWS_SATURATION.lifetime / 2 }, () => evidence({ magnitude: 2 })),
    );
    expect(capped).toBeCloseTo(atCap, 5);
  });
});

describe('a correction is the version that counts', () => {
  it('uses the user’s magnitude over the classifier’s', () => {
    const classifier = newsContribution([evidence({ magnitude: 1 })]);
    const corrected = newsContribution([
      evidence({
        magnitude: 1,
        reviewStatus: 'corrected' as ReviewStatus,
        userOverride: { magnitude: 2 },
      } as Partial<EvidenceItem>),
    ]);
    expect(corrected / classifier).toBeCloseTo(2, 5);
  });

  it('uses the user’s polarity over the classifier’s', () => {
    const flipped = effectiveEvidence(
      evidence({
        polarity: 'positive',
        magnitude: 2,
        reviewStatus: 'corrected' as ReviewStatus,
        userOverride: { polarity: 'negative' },
      } as Partial<EvidenceItem>),
    );
    expect(flipped.delta).toBe(-2);
  });

  it('cannot count a row and its correction as two rows', () => {
    /*
     * A revised import supersedes the row it replaces rather than deleting it,
     * so both are in the ledger. Only the live one may reach the board — if the
     * superseded copy still counted, every correction would double the player's
     * tally instead of restating it.
     */
    const revisedOnly = newsContribution([evidence({ magnitude: 2 })]);
    const revisedBesideSuperseded = newsContribution([
      evidence({ magnitude: 2 }),
      evidence({ magnitude: 2, reviewStatus: 'superseded' as ReviewStatus }),
    ]);
    expect(revisedBesideSuperseded).toBe(revisedOnly);
  });
});

describe('no row is counted twice', () => {
  it('scores two identical rows as two, not four', () => {
    const one = newsContribution([evidence({ magnitude: 1 })]);
    const two = newsContribution([evidence({ magnitude: 1 }), evidence({ magnitude: 1 })]);
    expect(two / one).toBeCloseTo(2, 5);
  });

  it('counts a row once even when several windows contain it', () => {
    /*
     * Lifetime, thirty days and seven days are three separate components and a
     * recent row is inside all three — that is the design, and it is why a
     * fresh item is worth more than an old one. What must not happen is the
     * same row landing twice inside a single window.
     */
    const signal = signalFrom([evidence({ magnitude: 2 })]);
    expect(signal.raw.items).toBe(1);
    expect(signal.last7.items).toBe(1);
    expect(signal.last30.items).toBe(1);
    expect(signal.raw.net).toBe(2);
    expect(signal.last7.net).toBe(2);
  });

  it('leaves a player with no ledger at exactly zero', () => {
    expect(newsContribution([])).toBe(0);
  });
});

describe('evidence cannot outrun the market', () => {
  it('never overturns a large ADP gap on its own', () => {
    /*
     * The bound that matters at a draft. A player the market has thirty picks
     * behind another cannot be lifted past him by the newsletter alone, however
     * emphatic it is — the tally is a strong secondary input and this is what
     * "secondary" has to mean in practice.
     */
    const loud = Array.from({ length: 20 }, () => evidence({ magnitude: 2 }));
    const board = [
      player('subject', 70, signalFrom(loud)),
      player('cheaper', 40, null),
      ...Array.from({ length: 10 }, (_, i) => player(`peer-${i}`, 45 + i * 4, null)),
    ];
    const recs = rankAvailablePlayers(board, CTX, DEFAULT_WEIGHTS);
    const at = (id: string) => recs.findIndex((r) => r.playerId === id);
    expect(at('cheaper'), 'the newsletter carried a player past a 30-pick bargain').toBeLessThan(at('subject'));
  });
});
