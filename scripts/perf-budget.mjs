#!/usr/bin/env node
/**
 * Measure the built site against its budgets, and fail if it has outgrown them.
 *
 * The problem this is for: this app is free to run and expected to stay that
 * way, and every channel of work adds model. Monte Carlo survival runs, tier
 * arithmetic, injury normalisation, usage trends — none of it individually
 * looks like a page-weight decision, and all of it ships to a phone. Without a
 * number that fails, the only signal is somebody eventually noticing the app
 * feels slow, by which point the cause is a year of commits.
 *
 * **Deterministic on purpose.** This measures bytes, not milliseconds. A
 * gzipped byte count is the same on a laptop and on a shared CI runner, so a
 * failure here is always a real regression and never the runner having a bad
 * morning. The timing budgets — which genuinely need a browser — live in
 * `e2e/performance.spec.ts` and are set generously for exactly that reason.
 *
 * **No paid monitoring, no service, no account.** Node, `zlib`, and a JSON file
 * in the repo. It runs in the same CI job that already builds the site, so it
 * costs nothing beyond the gzip.
 *
 * Usage:
 *   node scripts/perf-budget.mjs            # measure, exit non-zero if over
 *   node scripts/perf-budget.mjs --report   # print the table, always exit 0
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist', 'web');
const budgetsPath = join(root, 'perf-budgets.json');

const reportOnly = process.argv.includes('--report');

/** Every file under `dir`, as paths relative to it, with forward slashes. */
function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Glob matching, deliberately tiny.
 *
 * Supports `*`, `**` and `{a,b}` — which covers every pattern the budget file
 * needs and nothing else. A dependency for this would be a dependency shipped
 * to a project whose whole point is not needing any.
 */
function matches(path, pattern) {
  const escaped = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`);

  /*
   * Built by walking the pattern rather than by chained replaces.
   *
   * The chained version got this wrong in a way that reported green: it
   * translated a leading `**` + slash into "one or more directories", so the
   * "everything the browser must fetch" pattern required a slash and silently
   * excluded `index.html` at the root of the build. A budget that measures
   * less than it claims to is worse than no budget at all, so the traversal is
   * explicit and `**` + slash is optional, as every glob implementation means it.
   */
  let out = '^';
  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i];
    if (ch !== '*') {
      out += ch;
      continue;
    }
    if (expanded[i + 1] === '*') {
      i++;
      if (expanded[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else {
      out += '[^/]*';
    }
  }
  return new RegExp(out + '$').test(path);
}

const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
const files = walk(distDir);

if (files.length === 0) {
  console.error('No built site found at dist/web — run `npm run build` first.');
  process.exit(reportOnly ? 0 : 1);
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)}kB`;

const rows = [];
let failed = 0;

for (const budget of budgets.bundles) {
  /*
   * `excludeMatch` exists for exactly one thing, and it is not for hiding
   * weight.
   *
   * A budget named "everything the browser must fetch to render" has to mean
   * it. Once part of the site is genuinely not on the render path — a chunk no
   * page load can pull in, only a deliberate act can — counting it makes the
   * number describe something nobody experiences, and the usual reaction to a
   * number like that is to raise it until it stops complaining.
   *
   * So a pattern may be excluded, on one condition, enforced by convention and
   * by review rather than by code: **the excluded bytes must be covered by a
   * budget of their own.** Excluding without capping is how a budget stops
   * meaning anything, which is the failure this whole script exists to prevent.
   */
  const included = files.filter(
    (f) =>
      matches(f, budget.match) &&
      !(budget.excludeSuffix && f.endsWith(budget.excludeSuffix)) &&
      !(budget.excludeMatch && matches(f, budget.excludeMatch)),
  );

  /*
   * Each file gzipped on its own, then summed.
   *
   * Not the concatenation: the browser fetches them separately and compresses
   * them separately, so concatenating would report a compression ratio no
   * client will ever see and quietly grant headroom that does not exist.
   */
  let gzipBytes = 0;
  let rawBytes = 0;
  for (const file of included) {
    const buf = readFileSync(join(distDir, file));
    rawBytes += buf.length;
    gzipBytes += gzipSync(buf, { level: 9 }).length;
  }

  const over = gzipBytes > budget.maxGzipBytes;
  if (over) failed++;

  rows.push({
    name: budget.name,
    files: included.length,
    raw: rawBytes,
    gzip: gzipBytes,
    limit: budget.maxGzipBytes,
    headroom: budget.maxGzipBytes - gzipBytes,
    over,
    why: budget.why,
  });
}

const width = Math.max(...rows.map((r) => r.name.length), 4);
console.log('');
console.log(`${'what'.padEnd(width)}  ${'gzip'.padStart(9)}  ${'budget'.padStart(9)}  ${'headroom'.padStart(9)}  files`);
console.log('-'.repeat(width + 44));
for (const row of rows) {
  const mark = row.over ? '  ✗' : '';
  console.log(
    `${row.name.padEnd(width)}  ${kb(row.gzip).padStart(9)}  ${kb(row.limit).padStart(9)}  ${kb(row.headroom).padStart(9)}  ${String(row.files).padStart(5)}${mark}`,
  );
}
console.log('');

if (failed > 0 && !reportOnly) {
  console.error(`${failed} budget${failed === 1 ? '' : 's'} exceeded.\n`);
  for (const row of rows.filter((r) => r.over)) {
    console.error(`  ${row.name}: ${kb(row.gzip)} against a budget of ${kb(row.limit)}`);
    console.error(`    ${row.why}\n`);
  }
  console.error(
    'If the growth is deliberate and justified, raise the number in perf-budgets.json\n' +
      'in the same commit, with the reason in the commit message. Raising it on its own,\n' +
      'to make a red build green, is how a budget stops meaning anything.\n',
  );
  process.exit(1);
}

console.log(failed > 0 ? 'Over budget (reporting only).' : 'Within budget.');
