/**
 * What is the number printed under "projected", made of?
 *
 * Reported 16 September 2026: the Team row shows Bijan Robinson at 19.0 while
 * his own card shows a market projection of 15.9, and Rotowire has him near 20.
 * The suspicion was an average of this app's number and Rotowire's.
 *
 * `marketProjection` returns `evaluation.score` minus the availability penalty,
 * and `score` is not the market expectation — it is the market expectation plus
 * every bounded nudge the engine applies. So the printed figure is this app's
 * market base plus its own adjustments, and this dumps both halves for every
 * starter so the gap can be read rather than guessed at.
 *
 * Reads only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

const health = await get('/api/health');
/* `/api/health` carries it under `release`, which is why reading the top
 * level alone printed `(none)` against a deploy that had plainly landed. */
console.log(`gitSha=${health.json?.gitSha ?? health.json?.release?.gitSha ?? '(none)'}\n`);

const leagues = await get('/api/leagues');
const league =
  (leagues.json?.leagues ?? []).find((l) => l.isSelected) ?? (leagues.json?.leagues ?? [])[0];

const lineup = await get(`/api/leagues/${league.id}/lineup`);
const rows = [...(lineup.json?.slots ?? []), ...(lineup.json?.bench ?? [])].filter((r) => r.playerId);

console.log('name                     printed   score   market   gap    source     components');
console.log('-'.repeat(110));
for (const r of rows) {
  const market = r.expectation?.points ?? null;
  const gap = market != null && r.score != null ? (r.score - market).toFixed(2) : '—';
  const parts = (r.components ?? [])
    .filter((c) => !c.unknown && Math.abs(c.value ?? 0) > 0.001)
    .map((c) => `${c.key}${(c.value ?? 0) > 0 ? '+' : ''}${(c.value ?? 0).toFixed(2)}`)
    .join(' ');
  console.log(
    `${String(r.name).padEnd(24)} ${String(r.projection ?? '—').padEnd(9)} ${String(r.score ?? '—').padEnd(7)} ${String(market ?? '—').padEnd(8)} ${String(gap).padEnd(6)} ${String(r.projectionSource ?? '-').padEnd(10)} ${parts}`,
  );
}
