/**
 * Do defences show up now, and are kickers gone?
 *
 * Checks every league the app knows about, not just the selected one — the two
 * leagues had different symptoms with different causes, and only one of them
 * was a bug. For each: what it starts, which filter chips it offers, and what
 * the board actually returns for each of them.
 *
 * Reads only, public endpoints, no passphrase.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

const leagues = (await get('/api/leagues')).leagues ?? [];
console.log(`${leagues.length} league(s)\n`);

for (const league of leagues) {
  console.log(`=== ${league.name}${league.isSelected ? ' (selected)' : ''} ===`);
  const slots = [...new Set(league.rosterPositions ?? [])];
  console.log('  starts:', slots.join(', '));

  if (!league.draftId) {
    console.log('  no draft attached\n');
    continue;
  }

  const board = await get(`/api/drafts/${league.draftId}/board?limit=5`);
  if (board.error) {
    console.log('  board:', board.error, '\n');
    continue;
  }

  console.log('  filter chips offered:', (board.startablePositions ?? []).join(', ') || '(none)');
  for (const w of board.warnings ?? []) console.log('  warning:', w);

  for (const position of board.startablePositions ?? []) {
    const filtered = await get(`/api/drafts/${league.draftId}/board?position=${position}&limit=5`);
    const recs = filtered.recommendations ?? [];
    const top = recs[0];
    console.log(
      `    ${position.padEnd(4)} ${String(recs.length).padStart(2)} shown` +
        (top ? ` — top: ${top.name} (ADP ${top.adp ?? 'none'}${top.degraded ? ', degraded' : ''})` : ''),
    );
  }

  // Kickers must be gone whether or not the league ever started one.
  const kickers = await get(`/api/drafts/${league.draftId}/board?position=K&limit=5`);
  console.log(`    K    ${(kickers.recommendations ?? []).length} shown (expected 0)`);
  console.log('');
}

console.log('=== kickers in the player dictionary ===');
const k = await get('/api/players?position=K&limit=20');
console.log(`  ${(k.players ?? []).length} returned (expected 0)`);
const def = await get('/api/players?position=DEF&limit=40');
console.log(`  defences still carried: ${(def.players ?? []).length}`);
