/**
 * Is anyone's tally missing evidence that was already resolved?
 *
 * Identity reviews used to be resolved by recording the decision alone: the
 * review went green and no evidence was ever created, so the player's tally
 * stayed at zero. That path is fixed going forward, but anything resolved
 * before the fix is still missing — silently.
 *
 * Checks the live app for the names the tally backfill named.
 */

const URL = 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log('=== players the tally should have moved ===');
for (const name of ['Jaxon Smith-Njigba', 'AD Mitchell', 'R.J. Harvey', 'JJ McCarthy', 'JK Dobbins', 'Kenneth Gainwell']) {
  const { body } = await get(`/api/players?q=${encodeURIComponent(name)}&limit=3`);
  const p = (body?.players ?? [])[0];
  if (!p) {
    console.log(`  ${name.padEnd(22)} not found in the player list`);
    continue;
  }
  const raw = p.signal?.raw ?? { net: 0, items: 0 };
  console.log(`  ${p.name.padEnd(22)} net ${String(raw.net).padStart(4)} from ${raw.items} item(s)`);
}

console.log('\n=== unresolved names still waiting ===');
const { body: repair } = await get('/api/repair');
console.log('  ', repair?.summary?.headline ?? '(no repair endpoint)');
for (const g of repair?.groups ?? []) console.log(`   ${g.alias}: ${g.items} item(s), net ${g.net}`);

console.log('\n=== ledger totals ===');
const { body: ov } = await get('/api/overview');
console.log('  players:', ov?.players, '| pending evidence:', ov?.pendingEvidence, '| pending names:', ov?.pendingIdentity);
