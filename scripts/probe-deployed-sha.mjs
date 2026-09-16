/**
 * What is actually running?
 *
 * The lineup fix merged and deployed, and production is still emitting the
 * sentence the change deleted. Either the worker is serving an older bundle, or
 * the call site never hands `recommendLineup` the published figures and the new
 * branch cannot fire. Those need telling apart before anything else is touched.
 *
 * Reads only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text), text };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 500) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

console.log(`asking ${APP}\n`);

for (const path of ['/api/health', '/api/setup/status']) {
  const res = await get(path);
  const j = res.json ?? {};
  const sha = j.gitSha ?? j.release?.gitSha ?? j.version ?? j.sha ?? null;
  console.log(`${path} -> ${res.status}  gitSha=${sha ?? '(none in body)'}`);
  if (path === '/api/health') console.log(`  keys: ${Object.keys(j).join(', ')}`);
}

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0] ?? null;

const snap = await get(`/api/leagues/${league.id}/support-snapshot?context=lineup`);
console.log(`\nsupport-snapshot?lineup -> ${snap.status}`);
console.log(`  release: ${JSON.stringify(snap.json?.release ?? null)}`);

console.log('\n--- the sentence under the card, verbatim ---');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
for (const note of lineup.json?.notes ?? []) console.log(`  ${JSON.stringify(note)}`);

console.log('\n--- what the deployed build believes about Stevenson ---');
const all = [...(lineup.json?.slots ?? []), ...(lineup.json?.bench ?? [])];
for (const r of all) {
  if (!/Stevenson|Harvey|Concepcion|Allgeier/i.test(String(r.name ?? ''))) continue;
  console.log(
    `  ${String(r.name).padEnd(22)} score=${String(r.score ?? '—').padEnd(8)} proj=${String(r.projection ?? '—').padEnd(8)} src=${r.projectionSource ?? '-'}`,
  );
}
