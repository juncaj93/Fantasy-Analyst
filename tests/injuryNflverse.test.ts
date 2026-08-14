/**
 * Reading somebody else's published file without trusting its shape.
 *
 * The fixture below is the real thing: the header is `injuries_2025.csv`'s
 * header verbatim, and the rows are real rows from it. That matters because the
 * two mistakes available here are both invisible against a tidy invented
 * fixture — reading columns by position when the publisher inserts one, and
 * assuming a field's spelling ("Limited Participation in Practice", not "LP").
 *
 * The other thing under test is the ingest's honesty about what it cannot do.
 * The source publishes one row per player per WEEK, so there is no within-week
 * `DNP → LP → FP` sequence in it, and nothing here may manufacture one.
 */

import { describe, expect, it } from 'vitest';
import {
  fetchInjuryReport,
  injuryReportUrl,
  latestByPlayer,
  normalizeForMatch,
  parseInjuryReport,
  playerKey,
} from '../src/core/injury/nflverse.ts';

const HEADER =
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,' +
  'practice_secondary_injury,practice_status';

const ROWS = [
  // Practice-only: no game designation, which is most of the file.
  '2025,REG,REG,ARI,1,00-0026190,DE,Calais Campbell,Calais,Campbell,,,,Not injury related - resting player,,Did Not Participate In Practice',
  '2025,REG,REG,ARI,1,00-0038600,LB,Owen Pappoe,Owen,Pappoe,Quadricep,,Questionable,Quadricep,,Limited Participation in Practice',
  '2025,REG,REG,CIN,2,00-0036325,WR,Robert Hunt,Robert,Hunt,Biceps,,Questionable,Biceps,,Limited Participation in Practice',
  '2025,REG,REG,CIN,3,00-0036325,WR,Robert Hunt,Robert,Hunt,Biceps,,Questionable,Biceps,,Full Participation in Practice',
  '2025,REG,REG,CLE,4,00-0033057,OT,Jack Conklin,Jack,Conklin,Concussion,,Out,Concussion,,Did Not Participate In Practice',
];

const CSV = [HEADER, ...ROWS].join('\n');

describe('parsing the published report', () => {
  const report = parseInjuryReport(CSV);

  it('reads every row and drops none of them', () => {
    expect(report.rows).toHaveLength(5);
    expect(report.skipped).toBe(0);
    expect(report.season).toBe('2025');
    expect(report.latestWeek).toBe(4);
  });

  it('reads the fields a decision needs', () => {
    const pappoe = report.rows.find((r) => r.fullName === 'Owen Pappoe')!;
    expect(pappoe.reportStatus).toBe('Questionable');
    expect(pappoe.primaryInjury).toBe('Quadricep');
    expect(pappoe.practiceStatus).toBe('limited');
    expect(pappoe.gsisId).toBe('00-0038600');
    expect(pappoe.team).toBe('ARI');
  });

  it('normalizes the source’s own practice wording', () => {
    expect(report.rows.map((r) => r.practiceStatus)).toEqual(['dnp', 'limited', 'limited', 'full', 'dnp']);
    // …and keeps what it actually said, so a change of wording is traceable.
    expect(report.rows[0]!.practiceRaw).toBe('Did Not Participate In Practice');
  });

  it('treats an absent designation as absent, not as healthy', () => {
    expect(report.rows.find((r) => r.fullName === 'Calais Campbell')!.reportStatus).toBeNull();
  });

  /**
   * The failure that a positional reader cannot see. This is somebody else's
   * file: a column inserted in the middle must not shift every value by one.
   */
  it('reads columns by name, so an inserted column changes nothing', () => {
    const shuffled = [
      'week,full_name,report_status,gsis_id,season,team,position,report_primary_injury,practice_status,note',
      '3,Robert Hunt,Questionable,00-0036325,2025,CIN,WR,Biceps,Full Participation in Practice,anything at all',
    ].join('\n');
    const [row] = parseInjuryReport(shuffled).rows;
    expect(row!.fullName).toBe('Robert Hunt');
    expect(row!.reportStatus).toBe('Questionable');
    expect(row!.primaryInjury).toBe('Biceps');
    expect(row!.practiceStatus).toBe('full');
  });

  it('survives a file it cannot understand rather than throwing', () => {
    expect(parseInjuryReport('').rows).toHaveLength(0);
    expect(parseInjuryReport('nothing,useful\n1,2').rows).toHaveLength(0);
    expect(parseInjuryReport(`${HEADER}\n2025,REG,REG,ARI,,,,,,,,,,,,`).skipped).toBe(1);
  });
});

describe('the latest word on each player', () => {
  const latest = latestByPlayer(parseInjuryReport(CSV));

  it('keeps the most recent week, not the first one seen', () => {
    const hunt = latest.get('gsis:00-0036325')!;
    expect(hunt.latest.week).toBe(3);
    expect(hunt.latest.practiceStatus).toBe('full');
  });

  /**
   * A week-over-week run, and it is called that. The source has one practice
   * status per week, so this is "limited last week, full this week" — not the
   * three days of one week's practice report, which are not in this data at all.
   */
  it('carries the consecutive weeks behind it', () => {
    expect(latest.get('gsis:00-0036325')!.practiceByWeek).toEqual(['limited', 'full']);
  });

  it('breaks the run at a gap, because the missing week is unobserved', () => {
    const gapped = parseInjuryReport(
      [
        HEADER,
        '2025,REG,REG,CIN,2,00-0036325,WR,Robert Hunt,Robert,Hunt,Biceps,,Questionable,Biceps,,Did Not Participate In Practice',
        '2025,REG,REG,CIN,5,00-0036325,WR,Robert Hunt,Robert,Hunt,Biceps,,Questionable,Biceps,,Full Participation in Practice',
      ].join('\n'),
    );
    // Week 2 then week 5 is not "DNP improving to full" — it is one reading
    // with a hole in front of it.
    expect(latestByPlayer(gapped).get('gsis:00-0036325')!.practiceByWeek).toEqual(['full']);
  });
});

describe('identity', () => {
  it('keys on the identifier when there is one', () => {
    const [row] = parseInjuryReport(CSV).rows;
    expect(playerKey(row!)).toBe('gsis:00-0026190');
  });

  it('falls back to name and team when there is not', () => {
    const [row] = parseInjuryReport(
      `${HEADER}\n2025,REG,REG,SEA,1,,WR,Nobody Known,Nobody,Known,Knee,,Out,Knee,,Did Not Participate In Practice`,
    ).rows;
    expect(playerKey(row!)).toBe('name:nobody known|SEA');
  });

  it('normalizes the things that differ between sources and mean nothing', () => {
    expect(normalizeForMatch('A.J. Brown')).toBe('aj brown');
    expect(normalizeForMatch('Marvin Harrison Jr.')).toBe('marvin harrison');
    expect(normalizeForMatch("Ja'Marr Chase")).toBe('jamarr chase');
  });
});

describe('fetching it', () => {
  const ok = (body: string, headers: Record<string, string> = {}) =>
    async () =>
      new Response(body, { status: 200, headers });

  it('asks for the season’s own file', () => {
    expect(injuryReportUrl('2026')).toContain('injuries_2026.csv');
  });

  it('takes freshness from the file, since the rows carry none', async () => {
    const result = await fetchInjuryReport('2025', {
      fetch: ok(CSV, { 'last-modified': 'Wed, 18 Mar 2026 04:12:33 GMT' }),
    });
    expect(result.report!.rows).toHaveLength(5);
    expect(result.publishedAt).toBe('2026-03-18T04:12:33.000Z');
  });

  /**
   * The state this project is actually in as it ships: `injuries_2026.csv` is
   * a 404 in August because the NFL has not filed an injury report yet. That
   * is a fact about the calendar and must not be reported as a fault — an
   * alarm that fires every preseason is one nobody reads in November.
   */
  it('calls a missing season "not published yet", not a failure', async () => {
    const result = await fetchInjuryReport('2026', {
      fetch: async () => new Response('Not Found', { status: 404 }),
    });
    expect(result.report).toBeNull();
    expect(result.note).toContain('not published');
  });

  it('reports a real failure as one, without throwing', async () => {
    const result = await fetchInjuryReport('2025', {
      fetch: async () => new Response('nope', { status: 503 }),
    });
    expect(result.report).toBeNull();
    expect(result.note).toContain('503');
  });

  it('does not accept an empty file as an answer', async () => {
    const result = await fetchInjuryReport('2025', { fetch: ok(HEADER) });
    expect(result.report).toBeNull();
    expect(result.note).toContain('no 2025 rows');
  });
});
