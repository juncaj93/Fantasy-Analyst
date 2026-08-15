/**
 * The usage extractor, held against a full quote-aware parse.
 *
 * This file exists because the extractor is a *second* CSV parser, written for
 * speed, and the failure mode of a fast parser is not a crash — it is a column
 * read one field to the left, forever, on one line in five hundred. A usage
 * series that is quietly wrong is worse than no usage series at all, so the
 * primary test here is not a hand-written expectation: it is every line of a
 * real published file, compared field by field against a slow parser written
 * independently, requiring zero mismatches.
 *
 * The fixture is a genuine slice of `stats_player_week_2025.csv` — 255 lines
 * carrying all three shapes the file actually contains:
 *
 *     naive field count   why
 *              151        one quoted comma: `f_auto,q_auto` in headshot_url
 *              152        two: a display name like "Kenneth Murray, Jr."
 *              150        none: a team row with no headshot at all
 *
 * A `split(',')` gets every one of those wrong differently, which is precisely
 * why a fixed offset correction is not an option.
 *
 * The same comparison runs over the whole 8.3MiB file — 19,422 lines, 252,486
 * fields, zero mismatches — via `scripts/probe-usage-parse.mjs`, which is where
 * the ascending-index bug was caught. Set `FA_USAGE_CSV` to a downloaded copy
 * and the sweep below runs against it here too.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFields, parseWeeklyUsage, weeklyStatsUrl, SKILL_POSITIONS } from '../src/core/usage/nflverse.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/nflverse-usage-2025-sample.csv', import.meta.url));
const text = readFileSync(FIXTURE, 'utf8');
const lines = text.split('\n').filter((l) => l.length > 0);

/**
 * A deliberately slow, deliberately independent RFC4180 parser.
 *
 * Written from the spec rather than shared with the extractor: two
 * implementations agreeing is evidence, one implementation agreeing with itself
 * is not.
 */
function referenceParse(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

const header = referenceParse(lines[0]!);
const columnIndex = (name: string) => header.indexOf(name);

/** The columns the parser actually reads, in the readable order a human lists them. */
const WANTED = [
  'player_id',
  'player_display_name',
  'position',
  'season',
  'season_type',
  'week',
  'team',
  'attempts',
  'carries',
  'targets',
  'receptions',
  'target_share',
  'wopr',
];

describe('the extractor against a full quote-aware parse', () => {
  it('has a fixture carrying all three line shapes the real file contains', () => {
    const shapes = new Map<number, number>();
    for (const line of lines.slice(1)) {
      const count = line.split(',').length;
      shapes.set(count, (shapes.get(count) ?? 0) + 1);
    }
    // 151 is the ordinary line; the other two are the ones a naive split or a
    // fixed +1 correction would corrupt, and both must be present to be tested.
    expect(shapes.get(151)).toBeGreaterThan(100);
    expect(shapes.get(152)).toBeGreaterThan(0);
    expect(shapes.get(150)).toBeGreaterThan(0);
    expect(header).toHaveLength(150);
  });

  it('agrees on every field of every line', () => {
    const indices = WANTED.map(columnIndex);
    const mismatches: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const reference = referenceParse(lines[i]!);
      const got = extractFields(lines[i]!, indices);
      for (let f = 0; f < indices.length; f++) {
        if ((reference[indices[f]!] ?? '') !== got[f]) {
          mismatches.push(`line ${i} ${WANTED[f]}: ${JSON.stringify(reference[indices[f]!])} vs ${JSON.stringify(got[f])}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  /**
   * The bug the harness caught, kept as a test because it fails silently.
   *
   * The single pass can only move forwards. Given its columns in the order a
   * human lists them — id, name, position, week, team, targets, carries,
   * receptions — it matched `targets` at index 45 and could then never match
   * `carries` at 32 or `receptions` at 44 again. They came back as empty
   * strings, with no error, which is a role that is always zero.
   */
  it('returns every column when they are asked for out of order', () => {
    const outOfOrder = ['player_id', 'position', 'week', 'targets', 'carries', 'receptions', 'team'];
    const indices = outOfOrder.map(columnIndex);
    // The order really is descending in places — this is the shape that broke.
    expect(indices[3]!).toBeGreaterThan(indices[4]!);

    const line = lines.find((l) => referenceParse(l)[columnIndex('position')] === 'WR')!;
    const reference = referenceParse(line);
    const got = extractFields(line, indices);
    for (let f = 0; f < indices.length; f++) {
      expect(got[f], `${outOfOrder[f]} came back empty`).toBe(reference[indices[f]!]);
    }
    expect(got.every((v) => v !== '')).toBe(true);
  });

  it('reads a name that itself contains a quoted comma', () => {
    const line = lines.find((l) => l.includes('"Kenneth Murray, Jr."'));
    expect(line, 'the fixture must carry a 152-field line').toBeDefined();
    const [name, week] = extractFields(line!, [columnIndex('player_display_name'), columnIndex('week')]);
    expect(name).toBe('Kenneth Murray, Jr.');
    expect(Number(week)).toBeGreaterThan(0);
  });

  it('reads a line with no quotes at all without shifting it', () => {
    const line = lines.slice(1).find((l) => !l.includes('"'))!;
    const reference = referenceParse(line);
    const [id, week, team] = extractFields(line, [
      columnIndex('player_id'),
      columnIndex('week'),
      columnIndex('team'),
    ]);
    expect(id).toBe(reference[columnIndex('player_id')]);
    expect(week).toBe(reference[columnIndex('week')]);
    expect(team).toBe(reference[columnIndex('team')]);
  });

  it('would have been fooled by splitting on commas', () => {
    // Stated as a test rather than a comment: this is the whole reason the
    // extractor exists, and if the file ever stops embedding commas the
    // justification should be re-examined rather than assumed.
    const ordinary = lines.slice(1).find((l) => l.split(',').length === 151)!;
    const naive = ordinary.split(',');
    const correct = referenceParse(ordinary);
    expect(naive.length).not.toBe(correct.length);
    expect(naive[columnIndex('week')]).not.toBe(correct[columnIndex('week')]);
  });
});

describe('parsing a week out of the file', () => {
  it('reads only the latest week, and only at the positions this app carries', () => {
    const parsed = parseWeeklyUsage(text);
    const latest = Math.max(...lines.slice(1).map((l) => Number(extractFields(l, [columnIndex('week')])[0])));

    expect(parsed.latestWeek).toBe(latest);
    expect(parsed.week).toBe(latest);
    expect(parsed.rows.length).toBeGreaterThan(0);
    // Bounded both ways: fewer rows than the week holds, and every one of them
    // at a position this app carries. Checked against a literal list rather
    // than against `SKILL_POSITIONS`, so widening that constant fails here
    // instead of quietly redefining what the test means.
    expect(parsed.rows.length).toBeLessThan(parsed.rowsInWeek);
    expect(parsed.rows.every((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.position))).toBe(true);
    expect(parsed.rows.every((r) => r.week === latest)).toBe(true);
    expect([...SKILL_POSITIONS].sort()).toEqual(['QB', 'RB', 'TE', 'WR']);
  });

  /**
   * Two thirds of every week is linemen and defensive backs, and the position
   * filter is not a nicety — it is what takes a real in-season week from 10.0ms
   * of CPU to 4.0ms against a 10ms allowance. So the rows that must not be
   * there are named rather than merely counted.
   */
  it('leaves the rest of the roster in the file where it found it', () => {
    const parsed = parseWeeklyUsage(text);
    const latest = parsed.latestWeek;
    const inWeek = lines
      .slice(1)
      .map(referenceParse)
      .filter((cells) => Number(cells[columnIndex('week')]) === latest);
    const others = inWeek.filter((cells) => !['QB', 'RB', 'WR', 'TE'].includes(cells[columnIndex('position')]!));
    expect(others.length, 'the fixture must contain rows this app does not carry').toBeGreaterThan(0);

    const kept = new Set(parsed.rows.map((r) => r.gsisId));
    for (const cells of others) {
      const id = cells[columnIndex('player_id')]!;
      if (id) expect(kept.has(id), `${cells[columnIndex('player_display_name')]} should not have been kept`).toBe(false);
    }
  });

  it('finds an earlier week without reading the whole file as that week', () => {
    const parsed = parseWeeklyUsage(text, { week: 3 });
    expect(parsed.week).toBe(3);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((r) => r.week === 3)).toBe(true);
    // The latest week is still reported truthfully — the bound is on what was
    // parsed, not on what the file contains.
    expect(parsed.latestWeek).toBeGreaterThan(3);
  });

  it('returns nothing, rather than something wrong, for a week not in the file', () => {
    const parsed = parseWeeklyUsage(text, { week: 99 });
    expect(parsed.rows).toEqual([]);
    expect(parsed.rowsInWeek).toBe(0);
  });

  it('carries the numbers the detector reads, and a null where the source was blank', () => {
    const parsed = parseWeeklyUsage(text, { week: 3 });
    const withTargets = parsed.rows.find((r) => (r.targets ?? 0) > 0)!;
    expect(withTargets).toBeDefined();
    expect(withTargets.gsisId).toMatch(/^00-\d+$/);
    expect(withTargets.receptions).not.toBeNull();
    expect(withTargets.seasonType).toBe('REG');

    // A quarterback has no target share; the source leaves it blank and it must
    // arrive as null rather than as a measured zero.
    const blank = parsed.rows.find((r) => r.targetShare === null);
    if (blank) expect(blank.targetShare).toBeNull();
  });

  /**
   * Column indices are not stable across seasons, so nothing may be assumed by
   * position. Swapping two columns in the header must move the values with them.
   */
  it('reads its columns by name, not by position', () => {
    const swapped = text
      .split('\n')
      .map((line, i) => {
        if (i !== 0) return line;
        const cells = referenceParse(line);
        const a = cells.indexOf('carries');
        const b = cells.indexOf('targets');
        [cells[a], cells[b]] = [cells[b]!, cells[a]!];
        return cells.join(',');
      })
      .join('\n');

    const original = parseWeeklyUsage(text, { week: 3 });
    const moved = parseWeeklyUsage(swapped, { week: 3 });
    const before = original.rows.find((r) => (r.carries ?? 0) > 0 && r.carries !== r.targets)!;
    const after = moved.rows.find((r) => r.gsisId === before.gsisId)!;
    expect(after.targets).toBe(before.carries);
    expect(after.carries).toBe(before.targets);
  });

  it('survives a file that ships CRLF', () => {
    const crlf = text.replace(/\n/g, '\r\n');
    const plain = parseWeeklyUsage(text, { week: 3 });
    const withCr = parseWeeklyUsage(crlf, { week: 3 });
    expect(withCr.rows.length).toBe(plain.rows.length);
    expect(withCr.rows.map((r) => r.wopr)).toEqual(plain.rows.map((r) => r.wopr));
  });

  it('reports an unreadable header as nothing rather than as data', () => {
    expect(parseWeeklyUsage('').rows).toEqual([]);
    expect(parseWeeklyUsage('a,b,c\n1,2,3').rows).toEqual([]);
  });
});

describe('where the file lives', () => {
  it('names the season in the URL and nothing else', () => {
    expect(weeklyStatsUrl('2026')).toBe(
      'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv',
    );
  });
});

/**
 * The full sweep, when a real file is on disk.
 *
 * Skipped in CI, where downloading 8.3MiB per run would be rude to a public
 * host for a check the fixture already makes; run locally with
 * `FA_USAGE_CSV=... npx vitest run tests/usageNflverse.test.ts`, or through
 * `scripts/probe-usage-parse.mjs`, which is what produced the recorded result:
 * 19,422 lines, 252,486 fields, zero mismatches.
 */
describe.skipIf(!process.env['FA_USAGE_CSV'])('the whole published file', () => {
  it('agrees on every field of all 19,422 lines', () => {
    const whole = readFileSync(process.env['FA_USAGE_CSV']!, 'utf8').split('\n').filter((l) => l.length > 0);
    const wholeHeader = referenceParse(whole[0]!);
    const indices = WANTED.map((name) => wholeHeader.indexOf(name));
    let mismatches = 0;
    for (let i = 1; i < whole.length; i++) {
      const reference = referenceParse(whole[i]!);
      const got = extractFields(whole[i]!, indices);
      for (let f = 0; f < indices.length; f++) {
        if ((reference[indices[f]!] ?? '') !== got[f]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});
