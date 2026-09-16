/**
 * Two questions the last round's fixes were supposed to have answered.
 *
 * 1. Jayden Reed and Mark Andrews are still named as drops. The durable-value
 *    safeguard gives a bench player a standing worth over a horizon rather than
 *    over one Sunday, so either it is not reaching them or it is not deciding
 *    the cut order. This prints the drop ranking itself — cost, lineup cost,
 *    option value, standing value and protection, per player — because the
 *    ranking is the thing that is wrong and a claim is only its output.
 *
 * 2. The empty DEF slot still explains itself with "has no betting market this
 *    week, so the figure beside him is Rotowire's". That sentence is only
 *    correct if a published figure exists for that defence, and this app
 *    refuses to quote a published total for a defence in any league. So either
 *    a figure is arriving that should not, or the wrong branch is being taken.
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

// ------------------------------------------------------------- the DEF slot
console.log('=== 1. the empty DEF slot and what it says ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
for (const s of lineup.json?.slots ?? []) {
  if (s.playerId != null && s.slot !== 'DEF') continue;
  console.log(`  slot=${s.slot} player=${s.name ?? '(empty)'} proj=${s.projection ?? '—'} src=${s.projectionSource ?? '-'}`);
  for (const v of s.vacancy ?? []) console.log(`    vacancy: ${JSON.stringify(v)}`);
}
console.log(`  undecidable: ${JSON.stringify((lineup.json?.undecidable ?? []).map((u) => ({ name: u.name, score: u.score })))}`);

// -------------------------------------------------- the drop ranking itself
console.log('\n=== 2. the waiver plan, in full ===');
const snap = await get(`/api/leagues/${league.id}/support-snapshot?context=waiver-plan`);
console.log(`GET support-snapshot?waiver-plan -> ${snap.status}`);
const d = snap.json?.decision ?? {};
console.log(`decision keys: ${keys(d)}`);
console.log(`inputs keys: ${keys(d.inputs)}`);
console.log(`output keys: ${keys(d.output)}`);

/* Anything shaped like a drop ranking, wherever it turns out to live. */
const text = JSON.stringify(d.output ?? d, null, 1);
const dropIdx = text.indexOf('dropRanking');
if (dropIdx >= 0) {
  console.log('\n--- dropRanking ---');
  console.log(text.slice(dropIdx, dropIdx + 6000));
} else {
  console.log('\n(no dropRanking key in the snapshot; printing the output head)');
  console.log(text.slice(0, 6000));
}

// ---------------------------------------- what the board says about the two
console.log('\n=== 3. Reed and Andrews on the waiver board ===');
const w = await get(`/api/leagues/${league.id}/waivers`);
const CP = w.json?.claimPlan ?? null;
console.log(`protectedPlayers: ${JSON.stringify(CP?.protectedPlayers ?? null)}`);
for (const c of CP?.claims ?? []) {
  console.log(`  CLAIM add=${c.addName} drop=${c.dropName} bid=${c.bid} why=${JSON.stringify(c.why)}`);
}

// --------------------------------- does this league hold a capture for them?
console.log('\n=== 4. preseason capture for the two in question ===');
for (const q of ['Jayden Reed', 'Mark Andrews', 'Rhamondre Stevenson']) {
  const res = await get(`/api/players?q=${encodeURIComponent(q)}`);
  const hit = (res.json?.players ?? [])[0];
  if (!hit) { console.log(`  ${q}: not found`); continue; }
  const detail = await get(`/api/players/${hit.id}/detail`);
  const pre = detail.json?.preseasonProjection ?? null;
  console.log(`  ${String(q).padEnd(22)} id=${hit.id} draftRank=${hit.draftRank ?? '—'} preseason=${pre ? `${pre.points} (${pre.label})` : 'NONE'}`);
}
