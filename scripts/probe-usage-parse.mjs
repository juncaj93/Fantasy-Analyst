/**
 * Prove the usage extractor right, and price it.
 *
 * The bounded extractor in `src/core/usage/nflverse.ts` reads eight of 150
 * columns in one quote-aware pass and never builds the other 137. That is what
 * makes a 8.3MiB file affordable inside a 10ms CPU allowance — and it is also a
 * second CSV parser, which is exactly the kind of thing that is subtly wrong on
 * one line in five hundred and silently corrupts a usage series.
 *
 * So this compares it against a full RFC4180 parse of **every line** of the real
 * published file and requires zero mismatches. It is the harness that caught the
 * ascending-index bug: given its columns in a readable order rather than a
 * sorted one, the single pass matched up to index 45 and then never matched 32
 * or 44 again, so `carries` and `receptions` came back empty with no error.
 *
 * Read-only. It downloads a public file and prints; it touches no database and
 * no deployment.
 *
 *   node --experimental-strip-types scripts/probe-usage-parse.mjs [path.csv]
 *
 * With no argument it downloads the current file. Node timings only: they are
 * the JavaScript cost and exclude every D1 call, which is I/O on Workers and
 * does not count against the CPU ceiling there.
 */

import { readFileSync } from 'node:fs';
import { extractFields, parseWeeklyUsage, weeklyStatsUrl } from '../src/core/usage/nflverse.ts';

const SEASON = process.env.SEASON ?? '2025';

/** A deliberately naive, deliberately slow, deliberately independent parser. */
function parseLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
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

function line(label, value) {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

async function load() {
  const fromDisk = process.argv[2];
  if (fromDisk) return readFileSync(fromDisk, 'utf8');
  const url = weeklyStatsUrl(SEASON);
  console.log(`downloading ${url}`);
  const res = await fetch(url, { headers: { accept: 'text/csv' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

const text = await load();
const lines = text.split('\n');
const header = parseLine(lines[0]);

console.log('\nthe file');
line('bytes', text.length.toLocaleString());
line('lines (excluding header)', (lines.filter((l) => l.length > 0).length - 1).toLocaleString());
line('columns', header.length);

// --- what a naive split would do -------------------------------------------
const naive = {};
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const n = lines[i].split(',').length;
  naive[n] = (naive[n] ?? 0) + 1;
}
console.log('\nwhat split(",") would produce');
for (const [count, rows] of Object.entries(naive).sort()) {
  line(`${count} fields`, `${rows.toLocaleString()} lines`);
}

// --- correctness ------------------------------------------------------------
const WANTED = ['player_id', 'player_display_name', 'position', 'season', 'season_type', 'week', 'team',
  'attempts', 'carries', 'targets', 'receptions', 'target_share', 'wopr'];
// Deliberately NOT sorted: this is the caller order that broke the prototype.
const indices = WANTED.map((c) => header.indexOf(c));

let mismatches = 0;
let checked = 0;
let sorted = true;
let previousWeek = -1;
const weekColumn = header.indexOf('week');
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const reference = parseLine(lines[i]);
  const got = extractFields(lines[i], indices);
  for (let f = 0; f < indices.length; f++) {
    if ((reference[indices[f]] ?? '') !== got[f]) {
      if (mismatches < 5) {
        console.log(`\n  MISMATCH line ${i} column ${WANTED[f]}: ` +
          `reference ${JSON.stringify(reference[indices[f]])} extractor ${JSON.stringify(got[f])}`);
      }
      mismatches++;
    }
  }
  checked++;
  const week = Number(reference[weekColumn]);
  if (week < previousWeek) sorted = false;
  previousWeek = week;
}

console.log('\ncorrectness against a full quote-aware parse');
line('lines compared', checked.toLocaleString());
line('fields compared', (checked * indices.length).toLocaleString());
line('mismatches', mismatches);
line('monotonically non-decreasing by week', sorted);

// --- cost -------------------------------------------------------------------
const time = (label, fn, runs = 5) => {
  let best = Infinity;
  let out;
  for (let r = 0; r < runs; r++) {
    const started = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - started);
  }
  line(label, `${best.toFixed(3)}ms`);
  return out;
};

console.log('\ncost (Node, JavaScript only — no D1, which is I/O on Workers)');
time('text.split("\\n")', () => text.split('\n'));
const latest = time('parse the latest week, skill positions', () => parseWeeklyUsage(text));
const backfill = time('parse an explicit earlier week (seek)', () => parseWeeklyUsage(text, { week: 3 }));

/*
 * The number that actually matters, and the one that is easy to fool yourself
 * about. Out of season the file's last week is a playoff week of 67 rows and
 * the parse looks free; a real regular-season week is 1,100 rows. So the file
 * is truncated to the end of week 18 and measured again — the worst case the
 * pipeline will ever meet in production.
 */
const weeks = lines.filter((l) => l.length > 0).slice(1).map((l) => Number(extractFields(l, [weekColumn])[0]));
const lastRegular = Math.max(...weeks.filter((w) => w <= 18));
const cut = weeks.findIndex((w) => w > lastRegular);
const inSeason = cut === -1 ? text : [lines[0], ...lines.slice(1, cut + 1)].join('\n');
const worst = time(`same, file truncated to week ${lastRegular} (worst in-season case)`, () => parseWeeklyUsage(inSeason));

console.log('\nwhat came back');
line('latest week in the file', latest.latestWeek);
line('rows in that week', latest.rowsInWeek.toLocaleString());
line('kept (QB/RB/WR/TE)', latest.rows.length.toLocaleString());
line('skipped (no identifier)', latest.skipped);
line('week 3, kept', backfill.rows.length.toLocaleString());
line('worst in-season week, rows', `${worst.rowsInWeek} in the week, ${worst.rows.length} kept`);
const sample = latest.rows[0];
if (sample) {
  line('example', `${sample.fullName} (${sample.position}) week ${sample.week}: ` +
    `${sample.targets} targets, ${sample.carries} carries, ${sample.receptions} receptions`);
}

console.log(mismatches === 0 ? '\nOK — zero mismatches.\n' : `\nFAILED — ${mismatches} mismatches.\n`);
process.exit(mismatches === 0 ? 0 : 1);
