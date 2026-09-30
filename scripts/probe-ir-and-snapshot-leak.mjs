/**
 * Two questions against production, both read-only, GET only.
 *
 * 1. Does any in-season support snapshot still carry the real Sleeper league
 *    id? Every snapshot kind is fetched and walked; each JSON path whose key or
 *    value contains the id is printed. The id itself is never printed — this
 *    log is public, and printing it would be the leak this probe looks for.
 *
 * 2. Is a player sitting in an injured-reserve slot being started? The waiver
 *    snapshot carries the owner's `reserveIds` (it is the one public read that
 *    does); the lineup route carries the recommended starters. Any overlap is
 *    printed with the slot, the projection and the injury designation, and the
 *    player now filling each slot is listed so a fix can be checked.
 */
const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

const leagues = await get('/api/leagues');
const league = (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? null;
if (!league) {
  console.log('no selected league');
  process.exit(0);
}
const id = String(league.id);
const deployed = await get('/api/health');
console.log(`deployed sha: ${deployed.json?.release?.gitSha ?? '(unknown)'}`);

function pathsContaining(node, needle, at = '', out = []) {
  if (typeof node === 'string') {
    if (node.includes(needle)) out.push(at || '(root)');
    return out;
  }
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child, i) => pathsContaining(child, needle, `${at}[${i}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(node)) {
    const here = at === '' ? key : `${at}.${key}`;
    if (key.includes(needle)) out.push(`${here} (as a key)`);
    pathsContaining(child, needle, here, out);
  }
  return out;
}

console.log('\n== 1. league id in support snapshots ==');
let waiverSnapshot = null;
for (const kind of ['lineup', 'matchup', 'waiver-plan', 'dst-plan', 'trade-offer']) {
  const r = await get(`/api/leagues/${id}/support-snapshot?context=${kind}`);
  if (r.status !== 200 || r.json == null) {
    console.log(`${kind}: HTTP ${r.status} ${(r.json?.error ?? r.text).slice(0, 160)}`);
    continue;
  }
  if (r.json?.decision?.kind === 'waiver-plan') waiverSnapshot = r.json;
  const hits = pathsContaining(r.json, id);
  console.log(`${kind}: sha ${r.json.release?.gitSha ?? '?'} · ${hits.length === 0 ? 'clean' : `${hits.length} leak(s)`}`);
  for (const hit of hits.slice(0, 20)) console.log(`  ${hit}`);
}

console.log('\n== 2. reserve-slot players in the recommended lineup ==');
const reserveIds = waiverSnapshot?.decision?.inputs?.reserveIds ?? null;
if (reserveIds == null) {
  console.log('reserve ids unknown (no waiver snapshot)');
  process.exit(0);
}
const rosterInputs = waiverSnapshot.decision.inputs.roster ?? [];
const nameOf = new Map(rosterInputs.map((i) => [i.player?.id, i.player?.fullName]));
console.log(`reserve slot: ${reserveIds.length === 0 ? '(empty)' : ''}`);
for (const rid of reserveIds) {
  const input = rosterInputs.find((i) => i.player?.id === rid);
  console.log(
    `  ${nameOf.get(rid) ?? rid} · injuryStatus=${JSON.stringify(input?.injuryStatus ?? null)} · designation=${JSON.stringify(input?.injury?.designation ?? null)}`,
  );
}

const lineup = await get(`/api/leagues/${id}/lineup`);
if (lineup.json == null) {
  console.log(`lineup: HTTP ${lineup.status}`);
  process.exit(0);
}
const reserve = new Set(reserveIds);
console.log('recommended slots:');
let started = 0;
for (const slot of lineup.json.slots ?? []) {
  const flag = slot.playerId && reserve.has(slot.playerId) ? '   <-- IN THE IR SLOT' : '';
  if (flag) started++;
  console.log(`  ${slot.slot.padEnd(10)} ${slot.name ?? '(empty)'} · ${slot.projection ?? '—'}${flag}`);
}
console.log(`reserve-slot players started: ${started}`);
for (const w of lineup.json.warnings ?? []) console.log(`  warning: ${w}`);
