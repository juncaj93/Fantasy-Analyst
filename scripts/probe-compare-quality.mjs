/**
 * Six questions about the compare screen, asked of production rather than of a fixture.
 *
 * The brief behind this probe is the September 2026 quality round: a FLEX
 * comparison showed Trey McBride at 0% coverage with a column of bold `0.00`s,
 * and the preseason snapshot had just been imported for the first time. Every
 * claim in the report this feeds has to come from a reading, so this prints
 * readings and nothing else.
 *
 *   1. Does the selected league have a preseason snapshot under *its* scoring,
 *      and does the player in the screenshot have a row in it?
 *   2. What does the start/sit engine actually produce for him — expectation,
 *      coverage, every component and its `unknown` flag?
 *   3. Which of those components are unknown-but-printed-as-a-number, and do
 *      they reach the score at all?
 *   4. Does the trade generator produce real buy-low/sell-high output?
 *   5. Does anybody get a preseason-tier (`projectionEstimated`) figure?
 *   6. What is the waivers screen's "trend" built from, and how fresh is it?
 *
 * Reads only, GET only, no passphrase — writes are the only thing the app gates.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) return { __error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: `not json: ${text.slice(0, 200)}` };
  }
}

const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? String(v) : String(v));

const leagues = await get('/api/leagues');
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league on this deployment:', JSON.stringify(leagues).slice(0, 400));
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})  season ${league.season ?? '?'}`);
console.log('roster_positions:', JSON.stringify(league.rosterPositions ?? []));

const release = await get('/api/health');
console.log('deployed sha:', release.release?.gitSha ?? '(none reported)');

// ---------------------------------------------------------------- 1. snapshot
console.log('\n=== 1. the preseason snapshot, and whether this league can read it ===');
const pre = await get('/api/preseason-projection');
if (pre.__error) console.log('  ', pre.__error);
else {
  console.log(`  season ${pre.season}  league scoringKey=${pre.scoringKey ?? '(none)'}  (${pre.scoringLabel ?? '-'})`);
  if (pre.current) {
    const c = pre.current;
    console.log(
      `  CURRENT snapshot: ${c.label}  key=${c.scoringKey}  rows=${c.rows}  players=${c.players}  ` +
        `unresolved=${c.unresolved}  imported=${c.importedAt}`,
    );
  } else {
    console.log('  CURRENT snapshot: NONE under this league\'s scoring key.');
  }
  for (const o of pre.others ?? []) {
    console.log(`  other snapshot:   ${o.label}  key=${o.scoringKey}  rows=${o.rows}  players=${o.players}`);
  }
}

// ------------------------------------------------- 2/3. the engine on a roster
console.log('\n=== 2. the start/sit engine on the whole roster: expectation, coverage, source ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
const evals = [];
if (lineup.__error) console.log('  ', lineup.__error);
else if (!lineup.found) console.log('  lineup not found:', lineup.error ?? '(no reason)');
else {
  console.log(`  mode=${lineup.mode ?? '?'}  publishedRefusal=${lineup.publishedRefusal ?? '(none)'}`);
  console.log(`  notes: ${JSON.stringify(lineup.notes ?? [])}`);
  for (const group of ['starters', 'bench', 'undecidable']) {
    for (const e of lineup[group] ?? []) evals.push({ group, ...e });
  }
  console.log(`  ${evals.length} evaluations across starters/bench/undecidable`);
  console.log('');
  console.log(
    '  ' +
      ['group', 'player', 'pos', 'exp.pts', 'cover', 'score', 'projection', 'source'].map((h) => h.padEnd(11)).join(''),
  );
  for (const e of evals) {
    console.log(
      '  ' +
        [
          e.group,
          String(e.name ?? e.playerId).slice(0, 18),
          e.position ?? '?',
          fmt(e.expectation?.points),
          e.expectation?.coverage == null ? '—' : `${Math.round(e.expectation.coverage * 100)}%`,
          fmt(e.score),
          fmt(e.projection),
          e.projectionSource ?? 'none',
        ]
          .map((c) => String(c).padEnd(11))
          .join(''),
    );
  }
  const unpriced = evals.filter((e) => e.expectation?.points == null);
  console.log(`\n  ${unpriced.length} of ${evals.length} carry NO market expectation:`);
  for (const e of unpriced) {
    console.log(
      `     ${e.name} (${e.position} ${e.team}) coverage=${Math.round((e.expectation?.coverage ?? 0) * 100)}% ` +
        `score=${fmt(e.score)} projection=${fmt(e.projection)}/${e.projectionSource ?? 'none'} ` +
        `missing=${JSON.stringify(e.expectation?.missing ?? e.expectation?.missingMarkets ?? [])}`,
    );
  }
}

console.log('\n=== 3. the zero-vs-missing audit: every component, per unpriced player ===');
console.log('  (`unknown=true` components are filtered out of the score by engine.ts; the UI still prints value.toFixed(2))');
const componentTally = new Map();
for (const e of evals) {
  for (const c of e.components ?? []) {
    const k = `${c.key}|${c.unknown ? 'unknown' : 'known'}`;
    const t = componentTally.get(k) ?? { n: 0, nonZero: 0, sample: null };
    t.n++;
    if (Math.abs(c.value) > 0.0001) {
      t.nonZero++;
      if (!t.sample) t.sample = `${e.name}: ${c.value} (${c.display})`;
    }
    componentTally.set(k, t);
  }
}
console.log('\n  component key            state     count  nonzero-value  sample');
for (const [k, t] of [...componentTally.entries()].sort()) {
  const [key, state] = k.split('|');
  console.log(
    `  ${key.padEnd(24)} ${state.padEnd(9)} ${String(t.n).padEnd(6)} ${String(t.nonZero).padEnd(14)} ${t.sample ?? ''}`,
  );
}
const worst = evals
  .map((e) => ({ e, n: (e.components ?? []).filter((c) => c.unknown).length }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 4);
for (const { e, n } of worst) {
  console.log(`\n  --- ${e.name} (${e.position}) — ${n} unknown component(s) of ${(e.components ?? []).length}`);
  for (const c of e.components ?? []) {
    console.log(
      `      ${c.unknown ? 'UNKNOWN ' : 'computed'} ${String(c.key).padEnd(16)} value=${String(c.value).padEnd(8)}` +
        ` base=${String(c.baseValue).padEnd(8)} w=${String(c.modeWeight).padEnd(5)} "${c.display}"`,
    );
  }
  const known = (e.components ?? []).filter((c) => !c.unknown).reduce((a, c) => a + c.value, 0);
  const all = (e.components ?? []).reduce((a, c) => a + c.value, 0);
  console.log(
    `      sum(known)=${Math.round(known * 100) / 100}  sum(all)=${Math.round(all * 100) / 100}  score=${fmt(e.score)}`,
  );
  console.log(`      confidence=${e.confidence} reasons=${JSON.stringify(e.confidenceReasons ?? [])}`);
}

// ------------------------------------- the named players from the screenshots
console.log('\n=== 3b. the two players in the screenshots, from the player card ===');
for (const name of ['McBride', 'Gibbs']) {
  const found = await get(`/api/players?q=${encodeURIComponent(name)}&leagueId=${encodeURIComponent(league.id)}&limit=5`);
  const hit = (found.players ?? [])[0] ?? null;
  if (!hit) {
    console.log(`  ${name}: not found by search — ${JSON.stringify(found).slice(0, 200)}`);
    continue;
  }
  console.log(`  ${name} -> ${hit.name} id=${hit.id} ${hit.position} ${hit.team} availability=${hit.availability ?? '?'}`);
  const detail = await get(`/api/players/${hit.id}/detail`);
  if (detail.__error) {
    console.log(`      detail: ${detail.__error}`);
    continue;
  }
  const p = detail.preseasonProjection;
  console.log(
    `      preseasonProjection: ${
      p ? `points=${p.points} label=${p.label ?? '?'} scoring=${p.scoringLabel ?? '?'}` : 'NULL (no row in the snapshot for this scoring)'
    }`,
  );
  const ev = evals.find((e) => e.playerId === hit.id);
  console.log(
    `      on the lineup response: ${
      ev ? `exp=${fmt(ev.expectation?.points)} cover=${Math.round((ev.expectation?.coverage ?? 0) * 100)}% score=${fmt(ev.score)} proj=${fmt(ev.projection)}/${ev.projectionSource ?? 'none'}` : '(not on this roster)'
    }`,
  );
}

// ------------------------------------------------------------ 4. smart trades
console.log('\n=== 4. buy-low / sell-high: what the generator actually produces ===');
const smart = await get(`/api/trades/smart?limit=8&leagueId=${encodeURIComponent(league.id)}`);
if (smart.__error) console.log('  ', smart.__error);
else {
  console.log(`  keys: ${Object.keys(smart).join(', ')}`);
  const offers = smart.offers ?? smart.suggestions ?? smart.trades ?? [];
  console.log(`  ${offers.length} suggestion(s); notes=${JSON.stringify(smart.notes ?? [])}`);
  for (const o of offers) {
    console.log(`  --- ${JSON.stringify(o).slice(0, 900)}`);
  }
}
const explain = await get(`/api/diagnostics/smart-trades?leagueId=${encodeURIComponent(league.id)}`);
if (explain.__error) console.log('  diagnostics:', explain.__error);
else {
  console.log(`  diagnostics keys: ${Object.keys(explain).join(', ')}`);
  const rejected = explain.rejected ?? explain.rejections ?? [];
  console.log(`  ${rejected.length} rejected candidate(s)`);
  const reasons = new Map();
  for (const r of rejected) {
    const key = r.reason ?? r.why ?? 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${reason}`);
  }
  console.log(`  first three rejections: ${JSON.stringify(rejected.slice(0, 3)).slice(0, 1200)}`);
}

// ------------------------------------------------------- 5. the third tier
console.log('\n=== 5. the third projection tier in production: who gets a ~ figure ===');
const matchup = await get(`/api/leagues/${league.id}/matchup`);
if (matchup.__error) console.log('  ', matchup.__error);
else if (!matchup.forecast) console.log('  no forecast. reason:', matchup.reason ?? '(none)');
else {
  const f = matchup.forecast;
  console.log(`  week ${f.week ?? matchup.week ?? '?'}  degraded=${f.degraded}  win%=${fmt(f.teams?.mine?.winProbability)}`);
  const rows = (f.slots ?? []).flatMap((r) => [r.mine, r.theirs]).filter(Boolean);
  const est = rows.filter((p) => p.projectionEstimated);
  const bor = rows.filter((p) => p.projectionBorrowed);
  const none = rows.filter((p) => p.projection == null && p.projectedFinal == null);
  console.log(`  ${rows.length} rows: ${bor.length} borrowed (sleeper), ${est.length} ESTIMATED (preseason), ${none.length} with no number`);
  for (const p of est) {
    console.log(`     ESTIMATED: ${p.name} (${p.position} ${p.team}) side=${p.side} projection=${fmt(p.projection)} final=${fmt(p.projectedFinal)}`);
  }
  for (const p of bor) {
    console.log(`     borrowed:  ${p.name} (${p.position} ${p.team}) side=${p.side} projection=${fmt(p.projection)}`);
  }
  for (const p of none) {
    console.log(`     NO NUMBER: ${p.name} (${p.position} ${p.team}) side=${p.side}`);
  }
}

// ------------------------------------------------------------- 6. waiver trend
console.log('\n=== 6. waivers: what the "trend" is, and how fresh ===');
const waivers = await get(`/api/leagues/${league.id}/waivers`);
if (waivers.__error) console.log('  ', waivers.__error);
else {
  console.log(`  found=${waivers.found}  considered=${waivers.considered ?? '?'}  upgrades=${(waivers.upgrades ?? []).length}`);
  console.log(`  headline: ${JSON.stringify(waivers.headline ?? null).slice(0, 300)}`);
  console.log(`  notes: ${JSON.stringify(waivers.notes ?? [])}`);
  console.log(`  pool: ${JSON.stringify(waivers.pool ?? null).slice(0, 400)}`);
  const faab = waivers.faab;
  if (!faab) console.log('  faab: NULL — no league strategy, so no trending line at all');
  else {
    console.log(`  faab.rule=${faab.rule}  trendingCapturedAt=${faab.trendingCapturedAt ?? 'NEVER'}`);
    console.log(`  faab.notes=${JSON.stringify(faab.notes ?? [])}`);
    const bids = faab.bids ?? [];
    console.log(`  ${bids.length} bid row(s):`);
    for (const b of bids.slice(0, 12)) {
      console.log(
        `     ${String(b.name ?? b.playerId).padEnd(22)} bid=${fmt(b.amount ?? b.bid)} ` +
          `trending=${JSON.stringify(b.trending ?? null)} heat=${fmt(b.heat)}`,
      );
    }
  }
  for (const u of (waivers.upgrades ?? []).slice(0, 6)) {
    console.log(`  --- upgrade: ${JSON.stringify(u).slice(0, 700)}`);
  }
}

console.log('\n=== data-health, for the freshness of everything above ===');
const health = await get('/api/data-health');
for (const s of health.sources ?? []) {
  console.log(
    `  ${String(s.id).padEnd(24)} state=${String(s.state).padEnd(10)} lastSuccess=${s.lastSuccessAt ?? 'never'} age=${s.ageMinutes ?? '?'}m`,
  );
}
