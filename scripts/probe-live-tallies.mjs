/**
 * What does the live app actually say these players are worth?
 *
 * The tally magnitude repair is proven by tests against the document in the
 * repository, but the thing that matters is the number on the deployed site
 * after the import has run. This asks it directly.
 *
 * Reads only, and only public endpoints — no passphrase, no writes.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/** The handoff's reference totals, plus the case the whole repair was for. */
const EXPECTED = {
  'Jaxon Smith-Njigba': 11,
  'Puka Nacua': 13,
  'Josh Allen': 10,
  'Jahmyr Gibbs': 9,
  'Jonathan Taylor': 7,
  'Jalen Hurts': 7,
  'Sam LaPorta': 6,
  'Trevor Lawrence': 6,
  "De'Von Achane": 6,
  "D'Andre Swift": 6,
  'Kyle Pitts': -5,
  'Chuba Hubbard': -4,
};

async function tallyFor(name) {
  const res = await fetch(`${URL}/api/players?q=${encodeURIComponent(name)}&limit=10`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const body = await res.json();
  const match = (body.players ?? []).find((p) => p.name === name);
  if (!match) return { error: 'not in the player list' };
  return {
    lifetime: match.signal?.raw.net ?? 0,
    items: match.signal?.raw.items ?? 0,
    last30: match.signal?.last30.net ?? 0,
    pending: match.signal?.pendingCount ?? 0,
  };
}

let wrong = 0;
console.log('player'.padEnd(24), 'live'.padStart(6), 'expected'.padStart(9), '  items  30d');
for (const [name, expected] of Object.entries(EXPECTED)) {
  const result = await tallyFor(name);
  if (result.error) {
    console.log(name.padEnd(24), '     —', String(expected).padStart(9), '  ' + result.error);
    wrong++;
    continue;
  }
  const ok = result.lifetime === expected;
  if (!ok) wrong++;
  console.log(
    name.padEnd(24),
    String(result.lifetime).padStart(6),
    String(expected).padStart(9),
    ` ${ok ? 'ok ' : 'MISMATCH'}`,
    String(result.items).padStart(5),
    String(result.last30).padStart(5),
  );
}

console.log(`\n${Object.keys(EXPECTED).length - wrong}/${Object.keys(EXPECTED).length} match the reference.`);
if (wrong > 0) process.exit(1);
