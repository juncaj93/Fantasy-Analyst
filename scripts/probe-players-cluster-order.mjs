/**
 * How does the live Players list order the cluster that prompted the fix?
 *
 * The floor defect was proven against the formula and against a locally served
 * copy of the endpoint, but the thing that settles it is the deployed site. This
 * asks production directly and prints the ordering with the numbers that produce
 * it, so the answer can be read rather than inferred.
 *
 * For each named player it prints the position on the page, the ADP the row
 * shows, the tally behind it, the adjusted rank the response carries, the rank
 * the row would print, and the movement. It then checks the two properties the
 * fix exists to establish:
 *
 *   1. Gibbs — better on ADP and better on tally — is above Bijan.
 *   2. Movement is the half-pick-per-point rule, even for a player whose
 *      printed rank has landed on the floor.
 *
 * Reads only, and only public endpoints — no passphrase, no writes.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/** The live cluster from the ranking-integrity handoff. */
const CLUSTER = [
  'Jahmyr Gibbs',
  'Puka Nacua',
  'Bijan Robinson',
  'Christian McCaffrey',
  'Jaxon Smith-Njigba',
  'Jonathan Taylor',
];

const res = await fetch(`${URL}/api/players?limit=100`);
if (!res.ok) {
  console.log(`could not read the players list: HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
const players = body.players ?? [];
const weight = body.tallyWeight;

console.log(`source: ${body.rankingSource ?? 'none'}   tallyWeight: ${weight}   returned: ${players.length}\n`);

const rows = [];
console.log('page  player                  ADP    tally  adjusted  prints  movement  expected');
for (const name of CLUSTER) {
  const index = players.findIndex((p) => p.name === name);
  if (index === -1) {
    console.log(`   —  ${name.padEnd(22)} not in the first ${players.length}`);
    continue;
  }
  const p = players[index];
  const net = p.signal?.raw.net ?? 0;
  const expected = Math.round(weight * net * 10) / 10;
  rows.push({ name, index, net, adp: p.draftRank, movement: p.movement, expected });
  console.log(
    String(index + 1).padStart(4),
    ` ${name.padEnd(22)}`,
    String(p.draftRank ?? '—').padEnd(6),
    String(net).padStart(5),
    String(p.adjustedRank ?? '—').padStart(9),
    String(p.adjustedRank == null ? '—' : Math.round(p.adjustedRank)).padStart(7),
    String(p.movement).padStart(9),
    String(expected).padStart(9),
    p.movement === expected ? '' : '  MISMATCH',
  );
}

console.log('\n--- the two properties the fix establishes ---');

let failed = 0;

const gibbs = rows.find((r) => r.name === 'Jahmyr Gibbs');
const bijan = rows.find((r) => r.name === 'Bijan Robinson');
if (!gibbs || !bijan) {
  console.log('1. cannot check Gibbs v Bijan — one of them is not on the page');
  failed++;
} else {
  const better = gibbs.adp != null && bijan.adp != null && gibbs.adp < bijan.adp && gibbs.net > bijan.net;
  const above = gibbs.index < bijan.index;
  console.log(
    `1. Gibbs (ADP ${gibbs.adp}, tally ${gibbs.net}) v Bijan (ADP ${bijan.adp}, tally ${bijan.net}):` +
      ` better on both = ${better}; Gibbs above Bijan = ${above} ${above ? 'ok' : 'FAILED'}`,
  );
  if (!above) failed++;
}

const wrongMovement = rows.filter((r) => r.movement !== r.expected);
console.log(
  `2. movement is ${weight} x tally for all ${rows.length} of them: ` +
    (wrongMovement.length === 0 ? 'ok' : `FAILED for ${wrongMovement.map((r) => r.name).join(', ')}`),
);
if (wrongMovement.length > 0) failed++;

console.log(`\norder on the page: ${rows.sort((a, b) => a.index - b.index).map((r) => r.name).join(' | ')}`);
if (failed > 0) process.exit(1);
