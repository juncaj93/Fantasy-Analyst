/**
 * What does the Draft ranking total actually look like on a real board?
 *
 * The visible Score has to be a transform of the composite that already drives
 * board order — not a second formula — and it has to be stable: the same total
 * must always produce the same Score, whoever else is on the board. That rules
 * out min-max scaling against the current pool and means the transform needs
 * fixed constants.
 *
 * Fixed constants have to be calibrated against something. The theoretical
 * range of the weight table is far wider than anything real: every component at
 * full strength in the same direction does not happen. Calibrating on the
 * theoretical range would squash a live board into the middle twenty points and
 * lose exactly the separation the Score exists to show.
 *
 * So: ask production what the distribution really is. Read-only.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const status = await get('/api/setup/status');
const draftId = status.json?.league?.draftId;
if (!draftId) {
  console.log('no draft configured');
  process.exit(1);
}

const board = await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=300`);
const recs = board.json?.recommendations ?? [];
console.log(`${recs.length} scored players at pick ${board.json?.currentPick}\n`);

const totals = recs.map((r) => r.total).sort((a, b) => a - b);
const at = (q) => totals[Math.min(totals.length - 1, Math.max(0, Math.round(q * (totals.length - 1))))];
console.log('total distribution');
for (const q of [0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1]) {
  console.log(`  p${String(Math.round(q * 100)).padStart(3)}  ${at(q).toFixed(3)}`);
}

// The top of the board is where separation matters most: these are the players
// actually being chosen between.
console.log('\ntop 15 by board order');
for (const rec of recs.slice(0, 15)) {
  console.log(
    `  ${String(rec.total.toFixed(3)).padStart(7)}  ${rec.name.padEnd(22)} ${rec.position}  ` +
      `adp ${String(rec.adp ?? '—').padStart(5)}  val ${String(rec.adpValue ?? '—').padStart(6)}`,
  );
}

/*
 * How much of the spread lives in the top of the board.
 *
 * If the top twenty are packed into a tenth of the range, a linear transform
 * over the whole range gives them all the same Score and the number says
 * nothing about the decision the user is actually making.
 */
const top20 = recs.slice(0, 20).map((r) => r.total);
if (top20.length > 1) {
  const spreadTop = Math.max(...top20) - Math.min(...top20);
  const spreadAll = totals[totals.length - 1] - totals[0];
  console.log(
    `\ntop-20 spread ${spreadTop.toFixed(3)} of full spread ${spreadAll.toFixed(3)} ` +
      `(${((100 * spreadTop) / spreadAll).toFixed(1)}%)`,
  );
}

// Component ranges, so the theoretical bounds can be checked against reality.
const byKey = new Map();
for (const rec of recs) {
  for (const c of rec.components ?? []) {
    const seen = byKey.get(c.key) ?? { min: Infinity, max: -Infinity, weight: c.weight };
    seen.min = Math.min(seen.min, c.contribution);
    seen.max = Math.max(seen.max, c.contribution);
    seen.weight = c.weight;
    byKey.set(c.key, seen);
  }
}
console.log('\nobserved contribution range per component');
for (const [key, r] of [...byKey].sort()) {
  console.log(`  ${key.padEnd(20)} weight ${String(r.weight).padStart(5)}  ${r.min.toFixed(3)} … ${r.max.toFixed(3)}`);
}
