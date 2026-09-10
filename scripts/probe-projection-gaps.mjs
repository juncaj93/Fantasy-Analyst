/**
 * Why is there no win probability, no Jacksonville, and a half-empty opponent?
 *
 * Three symptoms reported off one deploy, and the suspicion is that they are
 * one cause: the published (Rotowire) fallback not reaching production. If the
 * weekly feed is not in the database, or the league is refused it, then every
 * unpriced starter contributes nothing — the opponent's column empties, the two
 * sides' coverage diverges, the forecast degrades, and the defence shows a dash.
 *
 * So this asks the live app, in the order the data flows, and prints which of
 * those it actually is rather than which it might be.
 *
 * Reads only, GET only, no passphrase — writes are the only thing the app gates.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`);
  if (!res.ok) return { __error: `HTTP ${res.status}` };
  return res.json();
}

const leagues = await get('/api/leagues');
const league =
  (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league on this deployment:', JSON.stringify(leagues).slice(0, 300));
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})  season ${league.season ?? '?'}`);
console.log('roster_positions:', JSON.stringify(league.rosterPositions ?? []));
console.log('scoringLabel:', league.scoringLabel ?? '(none)');

console.log('\n=== 1. is the published feed in the database at all ===');
const health = await get('/api/data-health');
const named = Array.isArray(health.sources) ? health.sources : [];
if (named.length === 0) {
  console.log('  (no source list; keys were:', Object.keys(health ?? {}).join(', '), ')');
} else {
  for (const s of named) {
    if (!/published|sleeper|roster|vegas|usage|nfl-state/i.test(String(s.id ?? ''))) continue;
    console.log(
      `  ${String(s.id).padEnd(22)} state=${s.state}  lastSuccess=${s.lastSuccessAt ?? 'never'}` +
        `  age=${s.ageMinutes ?? '?'}m  outcome=${s.technical?.lastOutcome ?? '-'}`,
    );
    if (s.note) console.log(`      note: ${s.note}`);
  }
}

console.log('\n=== 2. the lineup: what each slot is scored from ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
if (lineup.__error) console.log('  ', lineup.__error);
else {
  console.log('  found:', lineup.found, ' mode:', lineup.mode ?? '?');
  if (lineup.publishedRefusal) console.log('  publishedRefusal:', lineup.publishedRefusal);
  else console.log('  publishedRefusal: (none — the league may read published totals)');
  for (const slot of lineup.slots ?? []) {
    const src = slot.projectionSource ?? 'none';
    console.log(
      `   ${String(slot.slot).padEnd(6)} ${String(slot.name ?? '(empty)').padEnd(24)} ` +
        `proj=${slot.projection ?? '—'}  source=${src}` +
        (slot.vacancy?.length ? `  vacancy=${slot.vacancy.map((v) => v.reason).join('|')}` : ''),
    );
  }
  const def = (lineup.slots ?? []).find((s) => String(s.slot).toUpperCase() === 'DEF');
  console.log('\n  DEF slot verdict:', def ? JSON.stringify(def).slice(0, 400) : '(no DEF slot)');
}

console.log('\n=== 3. the matchup: coverage, and who is missing a number ===');
const matchup = await get(`/api/leagues/${league.id}/matchup`);
if (matchup.__error) console.log('  ', matchup.__error);
else if (!matchup.forecast) console.log('  no forecast. reason:', matchup.reason ?? '(none given)');
else {
  const f = matchup.forecast;
  console.log('  cached:', matchup.cached ?? f.cached ?? '(not reported)');
  console.log('  week:', f.week ?? matchup.week ?? '?');
  console.log('  degraded:', f.degraded);
  console.log('  win%:', f.teams?.mine?.winProbability ?? 'null', ' projectedFinal:', f.teams?.mine?.projectedFinal ?? 'null');
  console.log('  freshness:', JSON.stringify(f.freshness ?? {}));
  const rows = (f.slots ?? []).flatMap((r) => [r.mine, r.theirs]).filter(Boolean);
  const side = (s) => rows.filter((p) => p.side === s);
  for (const s of ['mine', 'theirs']) {
    const all = side(s);
    const scored = all.filter((p) => p.projectedFinal != null);
    const borrowed = all.filter((p) => p.projectionBorrowed);
    console.log(
      `  ${s}: ${scored.length}/${all.length} starters carry a number, ${borrowed.length} of them borrowed`,
    );
    for (const p of all.filter((p) => p.projectedFinal == null)) {
      console.log(`     NO NUMBER: ${p.name} (${p.position} ${p.team}) slot=${p.slot}`);
    }
  }
}
