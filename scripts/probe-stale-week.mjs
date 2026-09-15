/**
 * Why does Tuesday of week 2 look like Sunday night of week 1?
 *
 * Four screens reported wrong at once on 15 September 2026 — a lineup of
 * locked players carrying last week's numbers, a matchup of nothing but
 * zeroes, a waiver board with one row on it and a trade board with none — and
 * the suspicion is that they are one cause rather than four.
 *
 * `prop_snapshots` has no season column and no week column. The only temporal
 * thing on the row is `game_start`, and no query in `server/repos/props.ts`
 * filters on it: every read is "the newest snapshot per event", and a week 1
 * event's snapshot stays the newest snapshot of that event for ever. So if the
 * weekly market has not been bought for week 2 — and the cron that buys it
 * runs Saturday 23:00 and Sunday 15:00 UTC, which on a Tuesday is neither
 * three days ago nor three days away but both — then `latestForPlayers` still
 * answers with week 1's lines, and `kickoffsForPlayers` still answers with
 * week 1's kickoffs, which have all passed.
 *
 * If that is right, the damage is not the stale number. It is that a stale
 * number is not *missing*: `marketProjection` returns a figure, so the Rotowire
 * fallback below it and the preseason fallback below that never fire, and the
 * app confidently prints a forecast of a week that has already been played.
 *
 * So this asks production, in the order the data flows, and prints which it is.
 * Reads only, GET only, no passphrase.
 */

const APP = process.env.APP_URL ?? process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const NOW = new Date();

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 300) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const ago = (iso) => {
  if (!iso) return 'never';
  const ms = NOW.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
};

console.log(`probe run at ${NOW.toISOString()}  (${APP})\n`);

// ---------------------------------------------------------------- the league
const leaguesRes = await get('/api/leagues');
const league =
  (leaguesRes.json?.leagues ?? []).find((l) => l.isSelected) ?? (leaguesRes.json?.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league on this deployment:', JSON.stringify(leaguesRes).slice(0, 400));
  process.exit(0);
}
console.log(`league  : ${league.name} (${league.id}) season ${league.season}`);
console.log(`scoring : ${league.scoringLabel ?? '(none)'}`);
console.log(`slots   : ${JSON.stringify(league.rosterPositions ?? [])}`);

// ------------------------------------------------- 1. what week does it think
console.log('\n=== 1. which week does production believe it is ===');
const setup = await get('/api/setup/status');
const s = setup.json ?? {};
console.log(`  nflState         : ${JSON.stringify(s.season ?? s.nflState ?? null)}`);
const health = await get('/api/data-health');
for (const src of health.json?.sources ?? []) {
  const id = String(src.id ?? '');
  if (!/vegas|published|sleeper|usage|nfl|roster|injur/i.test(id)) continue;
  console.log(
    `  ${id.padEnd(24)} state=${String(src.state).padEnd(12)} last=${ago(src.lastSuccessAt)}` +
      `  outcome=${src.technical?.lastOutcome ?? '-'}`,
  );
}

// -------------------------------------------------- 2. the weekly market age
console.log('\n=== 2. the weekly market: how old, and for which games ===');
const v = s.vegas ?? {};
console.log(`  provider         : ${v.provider} (live=${v.live})`);
console.log(`  events stored    : ${v.events}`);
console.log(`  last refreshed   : ${v.lastRefreshedAt ?? 'never'}  (${ago(v.lastRefreshedAt)})`);
console.log(`  budget           : ${v.budget?.used}/${v.budget?.limit} ${v.budget?.state ?? ''}`);
console.log('  --- the question: is that a week 1 refresh being read as week 2? ---');

// ------------------------------------------------------------ 3. the lineup
console.log('\n=== 3. the lineup: kickoffs, locks and whose number each is ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
if (lineup.status !== 200) {
  console.log(`  GET lineup -> ${lineup.status} ${lineup.text ?? ''}`);
} else {
  const L = lineup.json ?? {};
  console.log(`  week reported    : ${L.week ?? '?'}   mode=${L.mode ?? '?'}`);
  const rows = L.lineup ?? L.slots ?? L.rows ?? [];
  console.log(`  ${'player'.padEnd(22)} ${'slot'.padEnd(6)} ${'proj'.padEnd(7)} ${'src'.padEnd(10)} locked  kickoff`);
  let locked = 0;
  let past = 0;
  for (const r of rows.slice(0, 12)) {
    const k = r.kickoff ?? r.lock?.kickoff ?? null;
    const isPast = k ? Date.parse(k) <= NOW.getTime() : false;
    if (r.locked) locked += 1;
    if (isPast) past += 1;
    console.log(
      `  ${String(r.name ?? r.playerId ?? '?').slice(0, 21).padEnd(22)} ` +
        `${String(r.slot ?? '').padEnd(6)} ${String(r.projection ?? '—').padEnd(7)} ` +
        `${String(r.projectionSource ?? '-').padEnd(10)} ${String(!!r.locked).padEnd(7)} ` +
        `${k ?? 'unknown'}${isPast ? '  <-- ALREADY KICKED OFF' : ''}`,
    );
  }
  console.log(`  locked=${locked} of ${rows.length};  kickoffs already in the past=${past}`);
  console.log('  (on a Tuesday, every one of those is a kickoff from a week that is over)');
}

// ----------------------------------------------------------- 4. the matchup
console.log('\n=== 4. the matchup: coverage, phase and the three projection tiers ===');
const matchup = await get(`/api/leagues/${league.id}/matchup`);
if (matchup.status !== 200) {
  console.log(`  GET matchup -> ${matchup.status} ${matchup.text ?? ''}`);
} else {
  const f = matchup.json?.forecast ?? null;
  console.log(`  week             : ${matchup.json?.week}  found=${matchup.json?.found}`);
  if (!f) {
    console.log(`  no forecast: ${matchup.json?.reason ?? '(no reason given)'}`);
  } else {
    console.log(`  degraded         : ${f.degraded}  reason=${f.degradedReason ?? '-'}`);
    console.log(`  mine             : proj=${f.teams?.mine?.projectedFinal} win=${f.teams?.mine?.winProbability}`);
    console.log(`  theirs           : proj=${f.teams?.theirs?.projectedFinal}`);
    const all = [
      ...(f.slots ?? []).flatMap((r) => [r.mine, r.theirs]),
      ...(f.bench?.mine ?? []),
      ...(f.bench?.theirs ?? []),
    ].filter(Boolean);
    const tier = (p) => (p.projectionEstimated ? 'preseason' : p.projectionBorrowed ? 'rotowire' : p.projectedFinal == null ? 'NONE' : 'market');
    for (const side of ['mine', 'theirs']) {
      const rows = all.filter((p) => p.side === side && p.starting);
      const counts = rows.reduce((acc, p) => ((acc[tier(p)] = (acc[tier(p)] ?? 0) + 1), acc), {});
      const phases = rows.reduce((acc, p) => ((acc[p.phase] = (acc[p.phase] ?? 0) + 1), acc), {});
      console.log(`  ${side.padEnd(7)} starters=${rows.length}  tiers=${JSON.stringify(counts)}  phases=${JSON.stringify(phases)}  locked=${rows.filter((p) => p.locked).length}`);
    }
    console.log('  --- tiers: "market" should be week 2 lines; "NONE" means all three missed ---');
  }
}

// ----------------------------------------------------------- 5. the waivers
console.log('\n=== 5. waivers: how many candidates, and what thinned them ===');
const waivers = await get(`/api/leagues/${league.id}/waivers`);
if (waivers.status !== 200) {
  console.log(`  GET waivers -> ${waivers.status} ${waivers.text ?? ''}`);
} else {
  const w = waivers.json ?? {};
  const list = w.candidates ?? w.recommendations ?? w.rows ?? [];
  console.log(`  returned         : ${list.length}`);
  console.log(`  keys             : ${Object.keys(w).join(', ')}`);
  for (const c of list.slice(0, 8)) {
    console.log(`    ${String(c.name ?? c.playerId).slice(0, 24).padEnd(25)} ${c.position ?? ''} score=${c.score ?? '?'} proj=${c.projection ?? '—'} role=${c.role ?? '-'}`);
  }
  if (w.note || w.reason) console.log(`  note             : ${w.note ?? w.reason}`);
}

// ------------------------------------------------------------ 6. the trades
console.log('\n=== 6. trades: offers, and whether the arbitrage lane produced anything ===');
const diag = await get('/api/diagnostics/smart-trades');
if (diag.status !== 200) {
  console.log(`  GET diagnostics/smart-trades -> ${diag.status} ${diag.text ?? ''}`);
} else {
  const d = diag.json ?? {};
  console.log(`  keys             : ${Object.keys(d).join(', ')}`);
  console.log(`  ${JSON.stringify(d).slice(0, 1800)}`);
}

// ------------------------------------------- 7. does the preseason tier exist
console.log('\n=== 7. the preseason snapshot the third tier needs ===');
const pre = await get('/api/preseason-projection');
if (pre.status !== 200) {
  console.log(`  GET preseason-projection -> ${pre.status} ${pre.text ?? ''}`);
} else {
  const snaps = pre.json?.snapshots ?? pre.json?.all ?? [];
  console.log(`  snapshots stored : ${snaps.length}`);
  for (const sn of snaps.slice(0, 6)) {
    console.log(`    id=${sn.id} season=${sn.season} key=${sn.scoringKey} label="${sn.scoringLabel}" players=${sn.players} captured=${sn.capturedAt}`);
  }
  console.log(`  --- the league's own scoring label is "${league.scoringLabel}"; a snapshot under`);
  console.log('      a different scoring key is not a worse answer, it is no answer at all ---');
}

console.log('\ndone. nothing was written.');
