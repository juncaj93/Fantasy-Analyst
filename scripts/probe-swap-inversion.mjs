/**
 * How does a 7.2 outrank a 19.0?
 *
 * Reported 16 September: `Start RJ Harvey over Bijan Robinson · +4.63 pts`
 * with Bijan at 19.0 and Harvey at 7.2 on the same screen, and the same shape
 * again for Mark Andrews (6.8) over Kenneth Walker (16.2).
 *
 * The suspicion from reading the code: `recommendLineup` ranks on `score`,
 * which contains this app's market expectation plus bounded nudges. A player no
 * book has priced has no expectation, so his score is *only* nudges — while the
 * display layer falls back to Rotowire and prints him a real weekly figure. The
 * ranking and the screen are then reading two different numbers, and a
 * subtraction across them is arithmetic over two different scales.
 *
 * If that is right, every inverted pair has the same signature: the benched
 * player has `projectionSource: sleeper` and a score far below his projection,
 * and the promoted player has `projectionSource: market` and a score that
 * matches his.
 *
 * Reads only, GET only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 400) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(', ') : `(${typeof o})`);

const leaguesRes = await get('/api/leagues');
const league =
  (leaguesRes.json?.leagues ?? []).find((l) => l.isSelected) ?? (leaguesRes.json?.leagues ?? [])[0] ?? null;
console.log(`league: ${league?.name} (${league?.id})\n`);

console.log('=== 1. the lineup, score against projection, per row ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
console.log(`GET lineup -> ${lineup.status}; keys=${keys(lineup.json)}`);
const L = lineup.json ?? {};
console.log(`week=${L.week} mode=${L.mode}`);

const rows = L.lineup ?? L.slots ?? L.starters ?? [];
console.log(`row keys: ${keys(rows[0])}`);
console.log(
  `\n  ${'player'.padEnd(24)} ${'slot'.padEnd(6)} ${'score'.padEnd(8)} ${'proj'.padEnd(8)} ${'src'.padEnd(9)} start locked`,
);
for (const r of rows) {
  console.log(
    `  ${String(r.name ?? r.playerId).slice(0, 23).padEnd(24)} ${String(r.slot ?? '').padEnd(6)} ` +
      `${String(r.score ?? '—').padEnd(8)} ${String(r.projection ?? '—').padEnd(8)} ` +
      `${String(r.projectionSource ?? '-').padEnd(9)} ${String(!!r.alreadyStarting).padEnd(6)}${!!r.locked}`,
  );
}

console.log('\n--- bench ---');
for (const r of L.bench ?? []) {
  console.log(
    `  ${String(r.name ?? r.playerId).slice(0, 23).padEnd(24)} ${String(r.position ?? '').padEnd(6)} ` +
      `${String(r.score ?? '—').padEnd(8)} ${String(r.projection ?? '—').padEnd(8)} ` +
      `${String(r.projectionSource ?? '-').padEnd(9)}`,
  );
}

console.log('\n=== 2. the swaps it is proposing ===');
for (const s of L.swaps ?? []) {
  console.log(`  ${JSON.stringify(s)}`);
}
console.log(`swaps: ${(L.swaps ?? []).length}`);

console.log('\n=== 3. notes and undecidables ===');
console.log(`notes: ${JSON.stringify(L.notes ?? null)}`);
console.log(`undecidable: ${JSON.stringify((L.undecidable ?? []).map((u) => u.name ?? u))}`);

console.log('\n=== 4. how many rows have a market at all ===');
const all = [...rows, ...(L.bench ?? [])];
const bySource = new Map();
for (const r of all) bySource.set(r.projectionSource ?? 'none', (bySource.get(r.projectionSource ?? 'none') ?? 0) + 1);
for (const [src, n] of bySource) console.log(`  ${String(src).padEnd(10)} ${n}`);

console.log('\n=== 5. the waiver board’s drop candidates ===');
const w = await get(`/api/leagues/${league.id}/waivers`);
const CP = w.json?.claimPlan ?? null;
for (const c of CP?.claims ?? []) {
  console.log(`  CLAIM add=${c.addName} drop=${c.dropName} bid=${c.bid}`);
  console.log(`    why: ${JSON.stringify(c.why)}`);
}
console.log(`  protectedPlayers: ${JSON.stringify(CP?.protectedPlayers ?? null)}`);
console.log(`  dropHints: ${JSON.stringify(CP?.dropHints ?? null)}`);
