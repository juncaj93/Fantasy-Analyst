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
  if (!/vegas|published|sleeper|usage|nfl|roster|injur|schedule/i.test(id)) continue;
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

// --------------------------------------------- 2b. is the fixture list there
/*
 * The question the first run of this probe did not ask, and should have.
 *
 * Kickoffs now come from `nfl_schedule` with a priced game as the fallback.
 * If that table is empty, and the week's games are unpriced, the app holds no
 * kickoff for anybody — which is the *correct* state on a Tuesday before the
 * odds cron runs, but it is a different state from "the schedule is there",
 * and the difference decides whether locks work on Sunday.
 */
console.log('\n=== 2b. the fixture list, which is where kickoffs come from ===');
const rollover = await get('/api/diagnostics/rollover');
console.log(`  GET /api/diagnostics/rollover -> ${rollover.status}`);
if (rollover.json) {
  for (const c of rollover.json.checks ?? []) {
    console.log(`  ${String(c.name).padEnd(26)} ${String(c.status).padEnd(10)} found=${c.found ?? '-'}  ${c.detail ?? ''}`);
  }
  if (!(rollover.json.checks ?? []).some((c) => /schedule|fixture/i.test(String(c.name)))) {
    console.log('  (no schedule/fixture check in this list — coverage is not reported here)');
  }
}

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
/*
 * Alex, 16 September 2026: the opponent DOES have a full week 2 lineup, seen
 * in Sleeper's own app for this exact matchup. So `theirs starters=0` is not
 * the opponent being slow, it is this app losing him — and the sentence #269
 * shipped ("your opponent has not set a lineup for this week yet") is a false
 * claim stated confidently, which is worse than the confusing 0% it replaced.
 *
 * The discriminator printed below is bench-versus-starters. If the opponent's
 * bench has players and his slots do not, the roster reached us and the
 * *starting* flag or the slot mapping is wrong. If neither has anybody, he was
 * lost earlier — the wrong matchup row, or a roster that did not resolve.
 */
console.log('\n=== 4. the matchup: coverage, phase and the three projection tiers ===');
const matchup = await get(`/api/leagues/${league.id}/matchup`);
if (matchup.status !== 200) {
  console.log(`  GET matchup -> ${matchup.status} ${matchup.text ?? ''}`);
} else {
  const f = matchup.json?.forecast ?? null;
  console.log(`  week             : ${matchup.json?.week}  found=${matchup.json?.found}  cached=${matchup.json?.cached}`);
  if (!f) {
    console.log(`  no forecast: ${matchup.json?.reason ?? '(no reason given)'}`);
  } else {
    console.log(`  degraded         : ${f.degraded}  reason=${f.degradedReason ?? '-'}`);
    console.log(`  mine             : roster=${f.teams?.mine?.rosterId} "${f.teams?.mine?.name}" proj=${f.teams?.mine?.projectedFinal} actual=${f.teams?.mine?.actual}`);
    console.log(`  theirs           : roster=${f.teams?.theirs?.rosterId} "${f.teams?.theirs?.name}" proj=${f.teams?.theirs?.projectedFinal} actual=${f.teams?.theirs?.actual}`);

    console.log(`  slot rows        : ${(f.slots ?? []).length}`);
    for (const row of f.slots ?? []) {
      console.log(
        `      ${String(row.slot ?? row.key ?? '?').padEnd(6)} mine=${String(row.mine?.name ?? '—').slice(0, 18).padEnd(19)} theirs=${String(row.theirs?.name ?? '—').slice(0, 18)}`,
      );
    }
    console.log(`  bench mine       : ${(f.bench?.mine ?? []).length}`);
    console.log(`  bench theirs     : ${(f.bench?.theirs ?? []).length}   <-- if this is >0 while the slots are empty, the roster arrived and the slot mapping lost him`);
    for (const p of (f.bench?.theirs ?? []).slice(0, 6)) {
      console.log(`      ${String(p.name).slice(0, 20).padEnd(21)} ${String(p.position ?? '').padEnd(4)} slot=${p.slot ?? 'null'} starting=${p.starting} proj=${p.projectedFinal ?? '—'}`);
    }

    const all = [
      ...(f.slots ?? []).flatMap((r) => [r.mine, r.theirs]),
      ...(f.bench?.mine ?? []),
      ...(f.bench?.theirs ?? []),
    ].filter(Boolean);
    const tier = (p) => (p.projectionEstimated ? 'preseason' : p.projectionBorrowed ? 'rotowire' : p.projectedFinal == null ? 'NONE' : 'market');
    for (const side of ['mine', 'theirs']) {
      const rows = all.filter((p) => p.side === side);
      const starting = rows.filter((p) => p.starting);
      console.log(
        `  ${side.padEnd(7)} players=${rows.length} starting=${starting.length}  tiers=${JSON.stringify(starting.reduce((a, p) => ((a[tier(p)] = (a[tier(p)] ?? 0) + 1), a), {}))}`,
      );
    }
  }
}

// ----------------------------------------------------------- 5. the waivers
console.log('\n=== 5. waivers: how many candidates, and what thinned them ===');
const waivers = await get(`/api/leagues/${league.id}/waivers`);
if (waivers.status !== 200) {
  console.log(`  GET waivers -> ${waivers.status} ${waivers.text ?? ''}`);
} else {
  /*
   * The board's own vocabulary, not a guess at it.
   *
   * The first run of this probe read `candidates` / `recommendations` / `rows`,
   * none of which this endpoint has, and printed "returned: 0" — which reads
   * exactly like an empty board and was in fact an empty question. The real
   * lanes are `upgrades`, `valueAdds` and `unknowns`.
   */
  const w = waivers.json ?? {};
  const lanes = ['upgrades', 'valueAdds', 'unknowns'];
  for (const lane of lanes) {
    const rows = w[lane] ?? [];
    console.log(`  ${lane.padEnd(10)} : ${rows.length}`);
    for (const c of rows.slice(0, 5)) {
      console.log(
        `      ${String(c.name ?? c.playerId).slice(0, 22).padEnd(23)} ${String(c.position ?? '').padEnd(4)}` +
          ` score=${c.score ?? '?'} proj=${c.projection ?? '—'} shelf=${c.shelfLife ?? '-'} role=${c.role ?? '-'}`,
      );
    }
  }
  console.log(`  considered       : ${w.considered ?? '?'}   skipped: ${w.skipped ?? '?'}   threshold: ${JSON.stringify(w.threshold ?? null)}`);
  console.log(`  pool             : ${JSON.stringify(w.pool ?? null)}`);
  console.log(`  headline         : ${w.headline ?? '(none)'}`);
  for (const n of w.notes ?? []) console.log(`  note             : ${n}`);
}

// ------------------------------------------------------------ 6. the trades
console.log('\n=== 6. trades: offers, and whether the arbitrage lane produced anything ===');
const diag = await get('/api/diagnostics/smart-trades');
if (diag.status !== 200) {
  console.log(`  GET diagnostics/smart-trades -> ${diag.status} ${diag.text ?? ''}`);
} else {
  const d = diag.json ?? {};
  console.log(`  keys             : ${Object.keys(d).join(', ')}`);
  /*
   * The field added in #268, checked rather than assumed present. An empty
   * board because the market is quiet and an empty board because nobody has
   * imported the preseason snapshot are different states, and if this comes
   * back absent while section 7 reports zero snapshots then the warning is
   * not reaching the screen and the reader is still being left to infer.
   */
  console.log(`  arbitrageOff     : ${d.arbitrageOff ?? '(absent)'}`);
  console.log(`  warnings         : ${JSON.stringify(d.warnings ?? [])}`);
  console.log(`  search           : ${JSON.stringify(d.search ?? null)}`);
  console.log(`  notes            : ${JSON.stringify(d.notes ?? [])}`);
}

// ------------------------------------------- 7. does the preseason tier exist
console.log('\n=== 7. the preseason snapshot the arbitrage lane needs ===');
const pre = await get('/api/preseason-projection');
if (pre.status !== 200) {
  console.log(`  GET preseason-projection -> ${pre.status} ${pre.text ?? ''}`);
} else {
  /*
   * `current` and `others`, which are the keys this route actually returns.
   *
   * The first two runs of this probe read `snapshots` / `all`, neither of
   * which exists, and printed "snapshots stored: 0" — which reads exactly like
   * an empty database and was in fact an empty question. That false negative
   * was reported to Alex as "buy-low and sell-high shipped inert", so it is
   * worth saying plainly: the probe was wrong, not necessarily the app.
   */
  const j = pre.json ?? {};
  console.log(`  season           : ${j.season}`);
  console.log(`  this league's key: ${j.scoringKey} ("${j.scoringLabel}")`);
  console.log(`  current          : ${j.current ? `id=${j.current.id} captured=${j.current.capturedAt} players=${j.current.players} rows=${j.current.rows}` : '(none for this scoring)'}`);
  console.log(`  others           : ${(j.others ?? []).length}`);
  for (const o of j.others ?? []) {
    console.log(`      id=${o.id} key=${o.scoringKey} label="${o.scoringLabel}" players=${o.players}`);
  }
}

// -------------------------------------- 8. why the arbitrage lane is silent
/*
 * If a snapshot *is* present, "no buy-low or sell-high offers" has a much more
 * likely explanation than a missing import: `ARBITRAGE.minGames` is 3, and in
 * week 2 every player has played one game. The lane would then be correctly
 * silent, and the honest message is "too early in the season", not "import
 * something".
 */
console.log('\n=== 8. how many games the season has actually produced ===');
const usage = await get('/api/data-health');
for (const src of usage.json?.sources ?? []) {
  if (!/usage|nfl-state/i.test(String(src.id ?? ''))) continue;
  console.log(`  ${String(src.id).padEnd(12)} ${src.state}  ${src.technical?.lastOutcome ?? ''}  ${src.note ?? ''}`);
}
console.log('  (week 2 means one completed game per team; ARBITRAGE.minGames is 3)');

console.log('\ndone. nothing was written.');
