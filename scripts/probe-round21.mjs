/**
 * Round 21 (Vegas sources, report only): the round's ONE production check.
 * Read-only. Every statement is a SELECT, and no odds provider is called.
 *
 * What it measures, from the odds the app already stored (about the last three
 * weeks are kept, plus each game's final copy):
 *
 *   1. per game: kickoff, when we first looked, when a game total first
 *      appeared, when player props first appeared, how many looks, how many
 *      times the total, the spread and the props changed;
 *   2. the same, rolled up by kickoff day (Thu / Sun early / Sun late / Mon):
 *      median hours before kickoff of the first total and the first props;
 *   3. when lines moved, bucketed by hours before kickoff, so we know how often
 *      a refresh is worth buying;
 *   4. the odds rows written per day (player_props, prop_snapshots), the cost
 *      side of any second or third source;
 *   5. what the provider ledger says we spent per day and on what;
 *   6. the discovery settings (which teams came back empty, and when).
 *
 * Env: CLOUDFLARE_API_TOKEN and ACCOUNT_ID (the Probe workflow passes them for
 * this script only). The workflow's D1 budget guard runs first. Times printed
 * in Eastern.
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
let probeRows = 0;

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const et = (iso) =>
  iso
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso))
    : '-';
const hoursBefore = (kickoff, at) => (Date.parse(kickoff) - Date.parse(at)) / 3_600_000;
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f1 = (x) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(1));

let dbUuid = null;
async function sql(text) {
  if (!/^\s*select\b/i.test(text)) throw new Error('read-only: SELECT only');
  const cf = async (path, init = {}) =>
    (
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      })
    ).json();
  dbUuid ??= ((await cf('/d1/database?name=fantasy_analyst')).result ?? []).find((d) => d.name === 'fantasy_analyst')?.uuid;
  if (!dbUuid) throw new Error('no D1 database called fantasy_analyst');
  const body = await cf(`/d1/database/${dbUuid}/query`, { method: 'POST', body: JSON.stringify({ sql: text, params: [] }) });
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 300)}`);
  probeRows += Number(body.result?.[0]?.meta?.rows_read ?? 0);
  return body.result?.[0]?.results ?? [];
}

console.log(`Round 21 probe, started ${et(new Date().toISOString())} ET`);
const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
if (!TOKEN || !ACCOUNT) {
  console.log('No Cloudflare token: nothing read.');
  process.exit(0);
}

// ---------------------------------------------------------------- 1. games ---
heading('1. Every stored weekly snapshot (one row per look at a game)');
const snaps = await sql(`
  SELECT ps.id, ps.event_id, ps.game_start, ps.fetched_at,
         json_extract(ps.raw_json, '$.gameLines.total') AS total,
         json_extract(ps.raw_json, '$.gameLines.spread') AS spread,
         json_extract(ps.raw_json, '$.gameLines.spreadTeam') AS spread_team
    FROM prop_snapshots ps
   WHERE ps.scope = 'week' AND ps.game_start >= datetime('now', '-30 days')
   ORDER BY ps.event_id, ps.fetched_at`);
console.log(`${snaps.length} snapshots`);

const ids = snaps.map((s) => s.id);
const lines = ids.length
  ? await sql(`
      SELECT snapshot_id, COALESCE(player_id, source_player_name) AS who, market, line
        FROM player_props
       WHERE snapshot_id IN (${ids.join(',')}) AND scope = 'week'`)
  : [];
console.log(`${lines.length} stored prop lines across them`);

const bySnap = new Map();
for (const l of lines) {
  const m = bySnap.get(l.snapshot_id) ?? new Map();
  m.set(`${l.who}|${l.market}`, l.line);
  bySnap.set(l.snapshot_id, m);
}

const events = new Map();
for (const s of snaps) {
  const list = events.get(s.event_id) ?? [];
  list.push(s);
  events.set(s.event_id, list);
}

const slotOf = (kickoff) => {
  const d = new Date(kickoff);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));
  if (day === 'Sun') return hour < 15 ? 'Sun early' : hour < 19 ? 'Sun late' : 'Sun night';
  return day;
};

const BUCKETS = [
  ['>96h', 96, Infinity],
  ['72-96h', 72, 96],
  ['48-72h', 48, 72],
  ['24-48h', 24, 48],
  ['6-24h', 6, 24],
  ['1.5-6h', 1.5, 6],
  ['<1.5h', -Infinity, 1.5],
];
const bucketOf = (h) => BUCKETS.find(([, lo, hi]) => h >= lo && h < hi)?.[0] ?? '?';
const moveStats = new Map(BUCKETS.map(([k]) => [k, { looks: 0, totalMoves: 0, spreadMoves: 0, propLooks: 0, propsChanged: 0, linesChanged: 0, linesCompared: 0, newLines: 0 }]));

const perGame = [];
for (const [eventId, list] of events) {
  const kickoff = list[list.length - 1].game_start;
  const first = list[0];
  const firstTotal = list.find((s) => s.total != null);
  const firstProps = list.find((s) => (bySnap.get(s.id)?.size ?? 0) > 0);
  let totalMoves = 0;
  let spreadMoves = 0;
  let propLooksChanged = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const h = hoursBefore(kickoff, s.fetched_at);
    const b = moveStats.get(bucketOf(h));
    b.looks++;
    if (i === 0) continue;
    const p = list[i - 1];
    if (s.total != null && p.total != null && s.total !== p.total) {
      totalMoves++;
      b.totalMoves++;
    }
    if (s.spread != null && p.spread != null && Math.abs(s.spread) !== Math.abs(p.spread)) {
      spreadMoves++;
      b.spreadMoves++;
    }
    const now = bySnap.get(s.id);
    const before = bySnap.get(p.id);
    if (now && before && now.size && before.size) {
      b.propLooks++;
      let changed = 0;
      for (const [k, v] of now) {
        if (!before.has(k)) {
          b.newLines++;
          continue;
        }
        b.linesCompared++;
        if (before.get(k) !== v) changed++;
      }
      b.linesChanged += changed;
      if (changed > 0) {
        b.propsChanged++;
        propLooksChanged++;
      }
    }
  }
  perGame.push({
    eventId,
    kickoff,
    slot: slotOf(kickoff),
    looks: list.length,
    firstLookH: hoursBefore(kickoff, first.fetched_at),
    firstTotalH: firstTotal ? hoursBefore(kickoff, firstTotal.fetched_at) : null,
    firstPropsH: firstProps ? hoursBefore(kickoff, firstProps.fetched_at) : null,
    firstLookHadTotal: first.total != null,
    firstLookHadProps: (bySnap.get(first.id)?.size ?? 0) > 0,
    propsAtFirst: bySnap.get(first.id)?.size ?? 0,
    propsAtLast: bySnap.get(list[list.length - 1].id)?.size ?? 0,
    totalMoves,
    spreadMoves,
    propLooksChanged,
    totalFirst: firstTotal?.total ?? null,
    totalLast: list[list.length - 1].total ?? null,
  });
}
perGame.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
console.log('kickoff (ET)          slot       looks firstLook firstTotal firstProps  props@first props@last  moves(total/spread/propLooks) total first->last');
for (const g of perGame) {
  console.log(
    `${et(g.kickoff).padEnd(21)} ${g.slot.padEnd(10)} ${String(g.looks).padStart(5)} ${f1(g.firstLookH).padStart(9)} ${f1(g.firstTotalH).padStart(10)} ${f1(g.firstPropsH).padStart(10)} ${String(g.propsAtFirst).padStart(12)} ${String(g.propsAtLast).padStart(10)}  ${g.totalMoves}/${g.spreadMoves}/${g.propLooksChanged}`.padEnd(120) +
      ` ${g.totalFirst ?? '-'} -> ${g.totalLast ?? '-'}`,
  );
}

// ---------------------------------------------------------------- 2. slots ---
heading('2. By kickoff slot: median hours before kickoff');
console.log('slot        games  firstLook  firstTotal  firstProps  firstLookAlreadyHadTotal  firstLookAlreadyHadProps  neverProps');
const slots = [...new Set(perGame.map((g) => g.slot))];
for (const slot of slots) {
  const gs = perGame.filter((g) => g.slot === slot);
  console.log(
    `${slot.padEnd(11)} ${String(gs.length).padStart(5)} ${f1(median(gs.map((g) => g.firstLookH))).padStart(10)} ${f1(median(gs.map((g) => g.firstTotalH ?? NaN))).padStart(11)} ${f1(median(gs.map((g) => g.firstPropsH ?? NaN))).padStart(11)} ${`${gs.filter((g) => g.firstLookHadTotal).length}/${gs.length}`.padStart(25)} ${`${gs.filter((g) => g.firstLookHadProps).length}/${gs.length}`.padStart(25)} ${String(gs.filter((g) => g.firstPropsH == null).length).padStart(11)}`,
  );
}

// ---------------------------------------------------------------- 3. moves ---
heading('3. When lines moved, by hours before kickoff (consecutive looks compared)');
console.log('bucket   looks  totalMoved  spreadMoved  propLooks  propLooksWithAChange  linesChanged/compared  newLinesAppeared');
for (const [k] of BUCKETS) {
  const b = moveStats.get(k);
  console.log(
    `${k.padEnd(8)} ${String(b.looks).padStart(5)} ${String(b.totalMoves).padStart(11)} ${String(b.spreadMoves).padStart(12)} ${String(b.propLooks).padStart(10)} ${String(b.propsChanged).padStart(21)} ${`${b.linesChanged}/${b.linesCompared}`.padStart(22)} ${String(b.newLines).padStart(17)}`,
  );
}

// ---------------------------------------------------------------- 4. writes ---
heading('4. Odds rows written per day (UTC day), last 14 days kept');
const writes = await sql(`
  SELECT substr(ps.fetched_at, 1, 10) AS day, COUNT(DISTINCT ps.id) AS snapshots, COUNT(pp.id) AS prop_rows
    FROM prop_snapshots ps LEFT JOIN player_props pp ON pp.snapshot_id = ps.id
   WHERE ps.fetched_at >= datetime('now', '-14 days')
   GROUP BY day ORDER BY day`);
for (const w of writes) console.log(`${w.day}  snapshots ${String(w.snapshots).padStart(4)}  prop rows ${String(w.prop_rows).padStart(6)}`);
console.log('(rows still stored; the nightly trim keeps three weeks, so these are lower bounds of what was written)');

// ---------------------------------------------------------------- 5. ledger ---
heading('5. Provider ledger: entities per day by source and outcome, last 21 days');
const ledger = await sql(`
  SELECT substr(at, 1, 10) AS day, source, outcome, SUM(entities) AS entities, COUNT(*) AS n
    FROM vegas_usage_log
   WHERE at >= datetime('now', '-21 days')
   GROUP BY day, source, outcome ORDER BY day`);
for (const r of ledger) console.log(`${r.day}  ${String(r.source).padEnd(9)} ${String(r.outcome).padEnd(8)} entities ${String(r.entities).padStart(3)}  rows ${r.n}`);
const why = await sql(`
  SELECT at, source, outcome, entities, substr(reason, 1, 90) AS reason
    FROM vegas_usage_log
   WHERE at >= datetime('now', '-8 days') AND outcome <> 'fetched'
   ORDER BY at DESC LIMIT 25`);
console.log('\nLast 8 days, anything not a plain fetch:');
for (const r of why) console.log(`${et(r.at).padEnd(20)} ${r.source.padEnd(9)} ${r.outcome.padEnd(8)} ${r.entities}  ${r.reason ?? ''}`);
const usage = await sql(`SELECT * FROM vegas_usage ORDER BY rowid DESC LIMIT 3`).catch((e) => [{ error: String(e) }]);
console.log('\nvegas_usage (latest):', JSON.stringify(usage));

// -------------------------------------------------------------- 6. settings ---
heading('6. Discovery settings');
const settings = await sql(`SELECT key, substr(value_json, 1, 600) AS v, updated_at FROM settings WHERE key LIKE 'vegas.%'`);
for (const s of settings) console.log(`${s.key.padEnd(24)} updated ${et(s.updated_at)}  ${s.v}`);

const events30 = await sql(`
  SELECT COUNT(*) AS n, SUM(game_total IS NOT NULL) AS with_total, SUM(spread IS NOT NULL) AS with_spread
    FROM vegas_events`);
console.log(`\nvegas_events: ${JSON.stringify(events30[0])}`);

console.log(`\nRows read by this probe: ${probeRows}`);
