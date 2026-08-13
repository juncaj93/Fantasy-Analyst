/**
 * Backfill import of a hand-maintained tally.
 *
 * The cases that matter are the dishonest ones: a net score covering several
 * issues must not become several items, a player listed twice must not be
 * silently resolved, and a name nobody recognises must not be guessed at.
 */

import { describe, expect, it } from 'vitest';
import { PlayerIndex } from '../src/core/identity/index.ts';
import { importTally, parseTally } from '../src/core/newsletter/tally.ts';
import { player } from './helpers/players.ts';

const ROSTER = new PlayerIndex([
  player({ id: 'p1', fullName: 'Puka Nacua', team: 'LAR', position: 'WR' }),
  player({ id: 'p2', fullName: 'Kyle Pitts', team: 'ATL', position: 'TE' }),
  player({ id: 'p3', fullName: 'Mike Evans', team: 'TB', position: 'WR' }),
  player({ id: 'p4', fullName: 'JK Dobbins', team: 'DEN', position: 'RB' }),
  player({ id: 'p5', fullName: 'Chris Johnson', team: 'KC', position: 'RB' }),
  player({ id: 'p6', fullName: 'Chris Johnson', team: 'BUF', position: 'WR' }),
]);

const DOC = `# Fantasy Football Player Tally
*Running score from newsletter recaps.*

## 🟢 Good List

| Player | Score | Key Drivers |
|---|---|---|
| Puka Nacua | +13 | R1-R3 breakout. R4: #1 in FPG excluding injury weeks |

## 🔴 Bad List

| Player | Score | Key Drivers |
|---|---|---|
| Kyle Pitts | -5 | worst-ever TE2 PPG, weak offense |
| Mike Evans | -1 | Worst YAC/reception mark on record |

## ⚪ Neutral (net zero, watching)
- JK Dobbins — strong efficiency, but Payton has never fed an RB 250+ carries
- Mike Evans — worst-ever YAC mark offset by strong YPRR vs. two-high coverage
`;

describe('parseTally', () => {
  it('reads both table rows and neutral bullets, and skips the header', () => {
    const rows = parseTally(DOC);
    expect(rows.map((r) => r.name)).toEqual([
      'Puka Nacua',
      'Kyle Pitts',
      'Mike Evans',
      'JK Dobbins',
      'Mike Evans',
    ]);
    expect(rows.find((r) => r.name === 'Puka Nacua')!.score).toBe(13);
    expect(rows.find((r) => r.name === 'Kyle Pitts')!.score).toBe(-5);
    expect(rows.find((r) => r.name === 'JK Dobbins')!.score).toBe(0);
  });

  it('records which list each row came from', () => {
    const rows = parseTally(DOC);
    expect(rows.find((r) => r.name === 'Puka Nacua')!.section).toBe('good');
    expect(rows.find((r) => r.name === 'Kyle Pitts')!.section).toBe('bad');
    expect(rows.find((r) => r.name === 'JK Dobbins')!.section).toBe('neutral');
  });
});

describe('importTally', () => {
  it('carries a multi-issue net score as one item, not several', () => {
    const result = importTally(DOC, ROSTER);
    const nacua = result.evidence.filter((e) => e.playerId === 'p1');
    expect(nacua).toHaveLength(1);
    expect(nacua[0]!.magnitude).toBe(13);
    expect(nacua[0]!.polarity).toBe('positive');
    expect(nacua[0]!.contextSummary).toContain('several earlier issues');
  });

  it('takes the sign from the score', () => {
    const result = importTally(DOC, ROSTER);
    const pitts = result.evidence.find((e) => e.playerId === 'p2')!;
    expect(pitts.polarity).toBe('negative');
    expect(pitts.magnitude).toBe(5);
  });

  /** Mike Evans really does appear twice in the source document. */
  it('sends a player listed twice to review instead of choosing for them', () => {
    const result = importTally(DOC, ROSTER);
    const evans = result.evidence.filter((e) => e.playerId === 'p3');
    expect(evans.length).toBeGreaterThan(1);
    for (const item of evans) {
      expect(item.reviewStatus).toBe('pending');
      expect(item.notes).toContain('listed-twice');
    }
    expect(result.conflicts.join(' ')).toContain('listed twice');
  });

  it('never auto-applies a net-zero row, which would apply nothing', () => {
    const result = importTally(DOC, ROSTER);
    const dobbins = result.evidence.find((e) => e.playerId === 'p4')!;
    expect(dobbins.polarity).toBe('neutral');
    expect(dobbins.magnitude).toBe(0);
    expect(dobbins.reviewStatus).toBe('pending');
  });

  it('flags a score that disagrees with the list it sits under', () => {
    const contradictory = `## 🔴 Bad List

| Player | Score | Key Drivers |
|---|---|---|
| Puka Nacua | +4 | somehow in the wrong list |
`;
    const result = importTally(contradictory, ROSTER);
    expect(result.conflicts.join(' ')).toContain('sits in the bad list');
    expect(result.evidence[0]!.reviewStatus).toBe('pending');
    expect(result.evidence[0]!.notes).toContain('score-disagrees-with-section');
  });

  it('reports an unrecognised name rather than guessing', () => {
    const doc = `## 🟢 Good List

| Player | Score | Key Drivers |
|---|---|---|
| Nobody McNothing | +3 | who? |
`;
    const result = importTally(doc, ROSTER);
    expect(result.evidence).toHaveLength(0);
    expect(result.unmatched.map((u) => u.name)).toEqual(['Nobody McNothing']);
    expect(result.detail).toContain('not recognised');
  });

  it('reports an ambiguous name with its candidates rather than picking one', () => {
    const doc = `## 🟢 Good List

| Player | Score | Key Drivers |
|---|---|---|
| Chris Johnson | +2 | which one? |
`;
    const result = importTally(doc, ROSTER);
    expect(result.evidence).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.candidates.length).toBeGreaterThan(1);
  });

  it('is idempotent: the same document produces the same dedupe keys', () => {
    const a = importTally(DOC, ROSTER);
    const b = importTally(DOC, ROSTER);
    expect(a.evidence.map((e) => e.dedupeKey)).toEqual(b.evidence.map((e) => e.dedupeKey));
  });

  it('gives a changed score a different key, so a later revision still lands', () => {
    const a = importTally(DOC, ROSTER, { sourceMessageId: 'tally-v1' });
    const b = importTally(DOC.replace('+13', '+15'), ROSTER, { sourceMessageId: 'tally-v1' });
    const nacuaA = a.evidence.find((e) => e.playerId === 'p1')!;
    const nacuaB = b.evidence.find((e) => e.playerId === 'p1')!;
    expect(nacuaB.dedupeKey).not.toBe(nacuaA.dedupeKey);
    expect(nacuaB.magnitude).toBe(15);
  });

  it('never claims high confidence for material the app never read', () => {
    const result = importTally(DOC, ROSTER);
    for (const item of result.evidence) {
      expect(item.confidence).not.toBe('high');
      expect(item.ruleId).toBe('tally-backfill');
      expect(item.notes).toContain('imported-tally');
    }
  });

  it('summarises what happened in plain language', () => {
    const result = importTally(DOC, ROSTER);
    expect(result.detail).toContain('row(s) read');
    expect(result.detail).toContain('applied');
    expect(result.rowsParsed).toBe(5);
  });
});
