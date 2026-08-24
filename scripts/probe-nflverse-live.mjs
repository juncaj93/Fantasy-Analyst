/**
 * Run the three new nflverse ingests against the live files, for real.
 *
 *   node --experimental-transform-types scripts/probe-nflverse-live.mjs [season]
 *
 * `--transform-types` rather than `--strip-types`: this reaches the server layer,
 * and `server/adapters/nodeSqlite.ts` uses TypeScript parameter properties, which
 * strip-only mode refuses.
 *
 * Read-only against the internet and write-only against a throwaway in-memory
 * database. It touches no deployment and no D1.
 *
 * ## Why this exists rather than a unit test
 *
 * The unit tests feed the parsers fixtures, which is the right way to test a
 * parser and cannot tell you three things that only the live endpoint knows:
 *
 *   - whether the **ranged read** actually works. The depth-chart ingest asks
 *     for `bytes=0-786431` of a 42MiB file and depends on the asset answering
 *     `206`, on the `ETag` being the same one a full request returns, and on
 *     `If-None-Match` still being honoured *with* a `Range` header. All three
 *     were measured by hand once; this is what re-measures them.
 *   - whether the **conditional check** is free on the second call. A pipeline
 *     that quietly downloads 42MiB every morning looks identical to one that
 *     does not, until a bandwidth bill or a CPU limit says otherwise.
 *   - what the **identity join** is worth today. The crosswalk's value is a
 *     percentage, and a percentage measured on a fixture is a percentage of
 *     the fixture.
 *
 * It is also the check to run in August, when `snap_counts_YYYY.csv` is a 404
 * and the correct output is a calm "not published" rather than a failure.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { NflverseService } from '../src/server/services/nflverseService.ts';
import { DepthChartRepo, IdentityCrosswalkRepo } from '../src/server/repos/nflverse.ts';

const SEASON = process.argv[2] ?? String(new Date().getUTCFullYear());
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const db = new NodeSqliteDatabase(':memory:');
for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
}

/** Count what actually crossed the wire, which is the number under test. */
let requests = 0;
let bytes = 0;
const wire = [];
const countingFetch = async (url, init) => {
  const started = Date.now();
  const res = await fetch(url, init);
  const clone = res.clone();
  const body = res.status === 304 || res.status === 404 ? '' : await clone.text();
  requests++;
  bytes += body.length;
  const headers = new Headers(init?.headers ?? {});
  wire.push({
    file: url.split('/').pop()?.split('?')[0] ?? url,
    status: res.status,
    range: headers.get('range') ?? '—',
    conditional: headers.get('if-none-match') ? 'if-none-match' : '—',
    bytes: body.length,
    ms: Date.now() - started,
  });
  return res;
};

const service = new NflverseService(db, { fetch: countingFetch, log: () => {} });

const line = (s = '') => process.stdout.write(`${s}\n`);
const kb = (n) => `${(n / 1024).toFixed(0)}KiB`;

line();
line(`nflverse live ingest — season ${SEASON}`);
line('='.repeat(78));
line();

const first = await service.refreshAll(SEASON);
line('first run, cold — nothing stored, so every file that exists is downloaded');
line('-'.repeat(78));
line('  feed                 outcome         returned  matched  unmatched  written  note');
for (const run of first) {
  line(
    `  ${run.source.padEnd(20)} ${run.outcome.padEnd(15)} ${String(run.rowsReturned).padStart(8)} ` +
      `${String(run.matched).padStart(8)} ${String(run.unmatched).padStart(10)} ${String(run.rowsWritten).padStart(8)}  ${run.note ?? ''}`,
  );
}
line();

const afterFirst = { requests, bytes };
const second = await service.refreshAll(SEASON);
line('second run, warm — the conditional check, which is the cost that actually recurs');
line('-'.repeat(78));
for (const run of second) {
  line(`  ${run.source.padEnd(20)} ${run.outcome.padEnd(15)} ${run.note ?? ''}`);
}
line(
  `  bytes downloaded on the second pass: ${kb(bytes - afterFirst.bytes)} ` +
    `(first pass: ${kb(afterFirst.bytes)})`,
);
line();

line('what crossed the wire');
line('-'.repeat(78));
line('  file                              status  range                conditional     bytes    ms');
for (const r of wire) {
  line(
    `  ${r.file.padEnd(33)} ${String(r.status).padStart(6)}  ${r.range.padEnd(20)} ${r.conditional.padEnd(14)} ${kb(r.bytes).padStart(7)} ${String(r.ms).padStart(5)}`,
  );
}
line();

const health = await service.health(SEASON);
line('what is stored');
line('-'.repeat(78));
line(`  ${health.dataHealth}`);
line();
line(
  `  identity   ${health.identity.rows} rows · ` +
    `${share(health.identity.withSleeper, health.identity.rows)} with a Sleeper id · ` +
    `${share(health.identity.withPfr, health.identity.rows)} with a PFR id · as of ${health.identity.asOf ?? 'unknown'}`,
);
line(
  `  snaps      ${health.snaps.rows} rows · ${health.snaps.players} players · ` +
    `through week ${health.snaps.latestWeek ?? '—'}`,
);
line(`  depth      ${health.depth.captures.length} capture(s) · latest ${health.depth.latest ?? '—'}`);
line(`  writes today ${health.writesToday} of ${health.writeCeiling}`);
line();

const captures = await new DepthChartRepo(db).captures(SEASON);
if (captures.length > 0) {
  const roles = await new DepthChartRepo(db).rolesAt(SEASON, captures[0]);
  const crosswalk = await new IdentityCrosswalkRepo(db).forSeason(SEASON);
  const nameOf = new Map(crosswalk.map((c) => [c.gsisId, c.fullName]));
  const club = process.env.CLUB ?? [...roles.values()][0]?.team;
  const shown = [...roles.entries()]
    .filter(([, role]) => role.team === club)
    .sort((a, b) => a[1].position.localeCompare(b[1].position) || a[1].rank - b[1].rank)
    .slice(0, 14);
  line(`the chart as ${club} publishes it, captured ${captures[0]}`);
  line('-'.repeat(78));
  line('  pos  rank  of   starter  player');
  for (const [gsisId, role] of shown) {
    line(
      `  ${role.position.padEnd(4)} ${String(role.rank).padStart(4)}  ${String(role.starterSlots).padStart(2)}   ` +
        `${(role.isStarter ? 'yes' : 'no').padEnd(7)} ${nameOf.get(gsisId) ?? gsisId}`,
    );
  }
  line();
  line('  "starter" counts the spots the club fields at that position in this');
  line('  personnel grouping. It is not a fantasy ranking and nothing here treats');
  line('  it as one — see core/nflverse/depthChart.ts.');
  line();
}

line(`total: ${requests} requests, ${kb(bytes)} downloaded.`);

function share(part, whole) {
  if (!whole) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}
