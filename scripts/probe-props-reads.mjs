/**
 * What does each Start/Sit props read actually cost, and does a rewrite return
 * the same rows for less?
 *
 * `d1 insights` on 1 October 2026 put the three props reads behind every lineup
 * (`PropsRepo.latestForPlayers`, `previousForPlayers`, `kickoffsForPlayers`)
 * at about 60% of two days' rows read, at 1,000-22,000 rows a call. This runs
 * each one against production, as written and as rewritten, and prints D1's
 * own `rows_read` for each beside a fingerprint of the rows returned — so the
 * saving is a measurement and "same answer" is a comparison, not a claim.
 *
 * Read-only: SELECTs and EXPLAIN QUERY PLAN, nothing else. It does spend rows
 * (that is the point), a few tens of thousands at most.
 *
 * Usage (from d1-explain.yml, with wrangler.toml pointed at the database):
 *   DATABASE_NAME=fantasy_analyst node scripts/probe-props-reads.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DB = process.env.DATABASE_NAME ?? 'fantasy_analyst';

function run(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const first = parsed[0];
  return { rows: first.results ?? [], read: Number(first.meta?.rows_read ?? NaN) };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const fingerprint = (rows) =>
  createHash('sha1')
    .update(rows.map((r) => JSON.stringify(r)).sort().join('\n'))
    .digest('hex')
    .slice(0, 10);

const now = Date.now();
const from = new Date(now - 12 * 3_600_000).toISOString();
const to = new Date(now + 9 * 86_400_000).toISOString();
console.log(`slate window ${from} .. ${to}`);

for (const [label, sql] of [
  ['prop_snapshots rows', "SELECT COUNT(*) AS n FROM prop_snapshots"],
  ['  of which week scope', "SELECT COUNT(*) AS n FROM prop_snapshots WHERE scope = 'week'"],
  ['  in the slate window', `SELECT COUNT(*) AS n FROM prop_snapshots WHERE game_start >= ${lit(from)} AND game_start <= ${lit(to)}`],
  ['player_props rows', 'SELECT COUNT(*) AS n FROM player_props'],
]) {
  const r = run(sql);
  console.log(`${label.padEnd(24)} ${String(r.rows[0]?.n).padStart(8)}   (count cost ${r.read} rows)`);
}

// Players a lineup would really ask about: priced in this window, plus a few
// that are not (a kicker, a defence), as a roster always has.
const priced = run(
  `SELECT DISTINCT pp.player_id AS id FROM player_props pp
    WHERE pp.player_id IS NOT NULL
      AND pp.snapshot_id IN (SELECT id FROM prop_snapshots WHERE game_start >= ${lit(from)} AND game_start <= ${lit(to)})
    LIMIT 80`,
).rows.map((r) => r.id);
const unpriced = run(
  `SELECT id FROM players WHERE position IN ('K','DEF') AND active = 1 LIMIT 5`,
).rows.map((r) => r.id);
console.log(`priced players in window: ${priced.length}`);

const W = `AND ps.game_start >= ${lit(from)} AND ps.game_start <= ${lit(to)}`;
const newest = (plus, offset) =>
  `(SELECT s2.id FROM prop_snapshots s2 WHERE s2.event_id = ps.event_id AND ${plus}s2.scope = 'week' ORDER BY s2.fetched_at DESC LIMIT 1${offset})`;

function variants(inList) {
  return {
    latest: {
      current: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' ${W} AND ps.id = ${newest('', '')}`,
      subqueryOnly: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' ${W} AND ps.id = ${newest('+', '')}`,
      byPlayer: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND +ps.scope = 'week' ${W} AND ps.id = ${newest('+', '')}`,
    },
    previous: {
      current: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' ${W} AND ps.id = ${newest('', ' OFFSET 1')}`,
      subqueryOnly: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' ${W} AND ps.id = ${newest('+', ' OFFSET 1')}`,
      byPlayer: `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND +ps.scope = 'week' ${W} AND ps.id = ${newest('+', ' OFFSET 1')}`,
    },
    kickoffs: {
      current: `SELECT pp.player_id AS player_id, ps.game_start AS game_start FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' ${W} ORDER BY ps.fetched_at ASC`,
      byPlayer: `SELECT pp.player_id AS player_id, ps.game_start AS game_start FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND +ps.scope = 'week' ${W} ORDER BY ps.fetched_at ASC`,
    },
  };
}

// The two heaviest per call in insights: the unwindowed read the Vegas refresh
// planner makes over a roster (`snapshotAges`), and the health screen's count.
{
  const inList = [...priced.slice(0, 28), ...unpriced.slice(0, 2)].map(lit).join(',');
  const forms = {
    'unwindowed current': `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' AND ps.id = ${newest('', '')}`,
    'unwindowed fixed': `SELECT pp.* FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IN (${inList}) AND ps.scope = 'week' AND ps.id = ${newest('+', '')}`,
    'priced current': `SELECT COUNT(DISTINCT pp.player_id) AS priced FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IS NOT NULL AND ps.scope = 'week' AND ps.id = ${newest('', '')}`,
    'priced fixed': `SELECT COUNT(DISTINCT pp.player_id) AS priced FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id WHERE pp.player_id IS NOT NULL AND ps.scope = 'week' AND ps.id = ${newest('+', '')}`,
  };
  console.log('');
  console.log('== 30 players, no window; and the priced-player count');
  for (const [form, sql] of Object.entries(forms)) {
    const plan = run(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => r.detail).join(' | ');
    const r = run(sql);
    console.log(`${form.padEnd(22)} rows_read ${String(r.read).padStart(7)}   returned ${String(r.rows.length).padStart(4)}   ${fingerprint(r.rows)}`);
    console.log(`          plan: ${plan}`);
  }
}

for (const size of process.env.SIZES ? process.env.SIZES.split(",").map(Number) : [15, 40]) {
  const ids = [...priced.slice(0, size - 2), ...unpriced.slice(0, 2)];
  const inList = ids.map(lit).join(',');
  console.log('');
  console.log(`== ${ids.length} players`);
  for (const [query, forms] of Object.entries(variants(inList))) {
    let base = null;
    for (const [form, sql] of Object.entries(forms)) {
      const plan = run(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => r.detail).join(' | ');
      const r = run(sql);
      const fp = fingerprint(r.rows);
      base ??= fp;
      console.log(
        `${query.padEnd(9)} ${form.padEnd(13)} rows_read ${String(r.read).padStart(7)}   returned ${String(r.rows.length).padStart(4)}   ${fp}${fp === base ? '' : '  <-- DIFFERENT ROWS'}`,
      );
      console.log(`          plan: ${plan}`);
    }
  }
}
