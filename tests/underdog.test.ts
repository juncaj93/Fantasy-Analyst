/**
 * DOG has to be Underdog's ADP, and it has to be recent.
 *
 * Everything here guards one of two failures, and both are silent by nature —
 * the board keeps working, the column keeps showing numbers, and the numbers
 * are about something else:
 *
 *   * a ranking, an expert rank or a projection stored as raw ADP;
 *   * a stale file presented as the current market.
 */

import { describe, expect, it } from 'vitest';
import {
  DOG_FRESHNESS,
  chooseDogSource,
  dogFreshness,
  dogIsUsable,
  parseBestBallTeamBuilder,
  parseFour4Underdog,
  toAdpImportFile,
  validateRawAdp,
  type DogRow,
  type DogSnapshot,
} from '../src/core/adp/underdog.ts';

/** An ADP board that looks like one: fractional, gappy, duplicated. */
function realAdp(count = 40): DogRow[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Player ${i + 1}`,
    team: 'DET',
    position: 'WR',
    // Averages, spreading out as the board deepens, with repeats and fractions.
    adp: Math.round((1.4 + i * 1.9 + (i % 3) * 0.4) * 10) / 10,
  }));
}

/** A ranking wearing an ADP column: 1..N, whole, one of each. */
function rankingDressedAsAdp(count = 40): DogRow[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Player ${i + 1}`,
    team: 'DET',
    position: 'WR',
    adp: i + 1,
  }));
}

describe('expert and ranking data cannot validate as raw DOG', () => {
  it('accepts a real ADP board', () => {
    const verdict = validateRawAdp(realAdp());
    expect(verdict.valid).toBe(true);
    expect(verdict.sourceType).toBe('raw_adp');
  });

  it('rejects a dense run of whole numbers, whatever the column was called', () => {
    const verdict = validateRawAdp(rankingDressedAsAdp(), ['name', 'adp']);
    expect(verdict.valid).toBe(false);
    expect(verdict.sourceType).toBe('ranking');
    expect(verdict.reason).toContain('ranking');
  });

  it('rejects a payload whose only numeric column is a rank', () => {
    const verdict = validateRawAdp(realAdp(), ['name', 'overall_rank']);
    expect(verdict.valid).toBe(false);
    expect(verdict.sourceType).toBe('ranking');
  });

  it('rejects a projection column', () => {
    const verdict = validateRawAdp(realAdp(), ['name', 'projected_points']);
    expect(verdict.valid).toBe(false);
    expect(verdict.sourceType).toBe('projection');
  });

  it('rejects a board that does not start near the top of a draft', () => {
    // A positional ADP board — the best receiver at 14 — is not a full-draft one.
    const verdict = validateRawAdp(realAdp().map((r) => ({ ...r, adp: r.adp + 20 })));
    expect(verdict.valid).toBe(false);
  });

  it('refuses to characterise a handful of rows without an explicit ADP column', () => {
    expect(validateRawAdp(realAdp(5)).valid).toBe(false);
    expect(validateRawAdp(realAdp(5), ['name', 'adp']).valid).toBe(true);
  });
});

describe('freshness is measured, and staleness is never presented as fresh', () => {
  const now = '2026-08-18T12:00:00.000Z';

  it('is fresh inside the window', () => {
    const state = dogFreshness({ fetchedAt: now, snapshotAt: '2026-08-18T03:00:00.000Z' }, now);
    expect(state.state).toBe('fresh');
    expect(dogIsUsable(state.state)).toBe(true);
  });

  it('is stale well past the window, and stale is not usable', () => {
    const state = dogFreshness({ fetchedAt: now, snapshotAt: '2026-08-01T03:00:00.000Z' }, now);
    expect(state.state).toBe('stale');
    expect(dogIsUsable(state.state)).toBe(false);
    expect(state.note).toContain('too old');
  });

  /**
   * The specific trap: fetching a stale file successfully. The fetch is minutes
   * old and the numbers are a fortnight old, and it is the numbers that matter.
   */
  it('does not call a just-fetched stale snapshot fresh', () => {
    const state = dogFreshness({ fetchedAt: now, snapshotAt: '2026-07-20T00:00:00.000Z' }, now);
    expect(state.basis).toBe('snapshot');
    expect(state.state).toBe('stale');
  });

  it('falls back to the fetch time when the source publishes no effective time', () => {
    const state = dogFreshness({ fetchedAt: '2026-08-18T09:00:00.000Z', snapshotAt: null }, now);
    expect(state.basis).toBe('fetch');
    expect(state.state).toBe('fresh');
  });

  it('is unknown rather than fresh when there is no usable timestamp at all', () => {
    const state = dogFreshness({ fetchedAt: 'not a date', snapshotAt: null }, now);
    expect(state.state).toBe('unknown');
    expect(dogIsUsable(state.state)).toBe(false);
  });

  it('crosses from fresh to aging exactly at the stated window', () => {
    const at = (hours: number) =>
      dogFreshness(
        { fetchedAt: now, snapshotAt: new Date(Date.parse(now) - hours * 3_600_000).toISOString() },
        now,
      ).state;
    expect(at(DOG_FRESHNESS.freshHours - 1)).toBe('fresh');
    expect(at(DOG_FRESHNESS.freshHours + 1)).toBe('aging');
    expect(at(DOG_FRESHNESS.staleHours + 1)).toBe('stale');
  });
});

describe('the source hierarchy', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const snapshot = (provider: DogSnapshot['provider'], snapshotAt: string): DogSnapshot => ({
    provider,
    sourceType: 'raw_adp',
    fetchedAt: now,
    snapshotAt,
    rows: realAdp(),
  });

  it('prefers Best Ball Team Builder when both are valid and fresh', () => {
    const chosen = chooseDogSource(
      [
        { snapshot: snapshot('4for4', now), verdict: validateRawAdp(realAdp()) },
        { snapshot: snapshot('best_ball_team_builder', now), verdict: validateRawAdp(realAdp()) },
      ],
      now,
    );
    expect(chosen.chosen?.provider).toBe('best_ball_team_builder');
  });

  it('falls back to 4for4 when the primary is not raw ADP', () => {
    const chosen = chooseDogSource(
      [
        {
          snapshot: { ...snapshot('best_ball_team_builder', now), rows: rankingDressedAsAdp() },
          verdict: validateRawAdp(rankingDressedAsAdp()),
        },
        { snapshot: snapshot('4for4', now), verdict: validateRawAdp(realAdp()) },
      ],
      now,
    );
    expect(chosen.chosen?.provider).toBe('4for4');
    expect(chosen.rejected.join(' ')).toContain('Best Ball Team Builder');
  });

  it('falls back when the primary is stale', () => {
    const chosen = chooseDogSource(
      [
        {
          snapshot: snapshot('best_ball_team_builder', '2026-07-01T00:00:00.000Z'),
          verdict: validateRawAdp(realAdp()),
        },
        { snapshot: snapshot('4for4', now), verdict: validateRawAdp(realAdp()) },
      ],
      now,
    );
    expect(chosen.chosen?.provider).toBe('4for4');
  });

  it('chooses nothing rather than something else when neither is usable', () => {
    const chosen = chooseDogSource(
      [
        {
          snapshot: snapshot('best_ball_team_builder', '2026-01-01T00:00:00.000Z'),
          verdict: validateRawAdp(realAdp()),
        },
      ],
      now,
    );
    expect(chosen.chosen).toBeNull();
    expect(chosen.rejected).toHaveLength(1);
  });
});

describe('the providers are parsed for ADP and nothing that merely sorts like it', () => {
  it('reads a Best Ball Team Builder board, nested or flat', () => {
    const payload = JSON.stringify({
      updatedAt: '2026-08-18T03:00:00.000Z',
      players: [
        { player: { fullName: 'Amon-Ra St. Brown', position: 'WR', teamId: 'DET' }, adp: 12.4 },
        { firstName: 'Jahmyr', lastName: 'Gibbs', position: 'RB', team: 'DET', adp: 6.1 },
      ],
    });
    const parsed = parseBestBallTeamBuilder(payload);
    expect(parsed.snapshotAt).toBe('2026-08-18T03:00:00.000Z');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.find((r) => r.name === 'Amon-Ra St. Brown')?.adp).toBe(12.4);
    expect(parsed.rows.find((r) => r.name === 'Jahmyr Gibbs')?.team).toBe('DET');
  });

  it('drops a Best Ball Team Builder row whose only number is a rank', () => {
    const payload = JSON.stringify([
      { fullName: 'Real Player', adp: 4.2 },
      { fullName: 'Rank Only', rank: 5 },
    ]);
    expect(parseBestBallTeamBuilder(payload).rows.map((r) => r.name)).toEqual(['Real Player']);
  });

  it('reads the 4for4 export from the column that names Underdog', () => {
    const csv = 'Name,Pos,Team,ADP,Underdog ADP\nJahmyr Gibbs,RB,DET,8.4,6.1\n';
    const parsed = parseFour4Underdog(csv);
    // 6.1 — Underdog's — and emphatically not 8.4, which is 4for4's own.
    expect(parsed.rows[0]!.adp).toBe(6.1);
  });

  it('refuses a 4for4 export with no Underdog column rather than using another', () => {
    const csv = 'Name,Pos,ADP,Consensus Rank\nJahmyr Gibbs,RB,8.4,3\n';
    expect(() => parseFour4Underdog(csv)).toThrow(/Underdog/);
  });

  it('derives rank from the ADP order rather than carrying one', () => {
    const file = JSON.parse(
      toAdpImportFile([
        { name: 'Later', team: 'DET', position: 'WR', adp: 40 },
        { name: 'Earlier', team: 'DET', position: 'RB', adp: 4 },
      ]),
    ) as { name: string; rank: number }[];
    expect(file.map((r) => r.name)).toEqual(['Earlier', 'Later']);
    expect(file.map((r) => r.rank)).toEqual([1, 2]);
  });
});

describe('ingestion is idempotent in the ways that matter', () => {
  it('produces byte-identical output for the same rows in any order', () => {
    const rows = realAdp(30);
    const shuffled = [...rows].reverse();
    expect(toAdpImportFile(shuffled)).toBe(toAdpImportFile(rows));
  });

  it('drops nothing and invents nothing across a round trip', () => {
    const rows = realAdp(30);
    const file = JSON.parse(toAdpImportFile(rows)) as unknown[];
    expect(file).toHaveLength(rows.length);
  });
});
