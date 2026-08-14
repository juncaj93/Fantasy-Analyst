/**
 * Is the draft board deep enough to draft with?
 *
 * The board once ended around ADP 78 and looked completely healthy doing it:
 * the rows it showed were correct, well-ranked and well-formed, and there was
 * simply nothing after them. Two caps caused it — the screen asked for forty
 * rows, and the server kept only players carrying a published ADP — and neither
 * reported what it had dropped, so nothing anywhere said "there are two hundred
 * more players".
 *
 * This asks the live board how many players it actually has, how deep they go,
 * and how many it kept without a price. Read-only: one GET, no writes, nothing
 * stored.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/**
 * The floor a real draft needs.
 *
 * A twelve-team, sixteen-round draft is 192 picks, so a board that cannot show
 * two hundred players cannot cover its own draft. Deliberately a floor rather
 * than a target -- the point is to catch a collapse, not to assert an exact
 * number that a different league format would fail for no reason.
 */
const MINIMUM_USABLE_POOL = 200;

let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

console.log(`Checking ${BASE}\n`);

const status = await get('/api/setup/status');
const draftId = status.json?.league?.draftId ?? null;
check('a league with a draft is configured', !!draftId, draftId ?? 'none');
if (!draftId) process.exit(1);

/*
 * Asked the way the app asks it. A limit far above the server's own cap, so
 * anything missing is missing because the server dropped it rather than because
 * this probe asked for too little -- which is exactly the mistake being tested.
 */
const board = await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=400`);
check('the draft board builds', board.status === 200, `HTTP ${board.status}`);

const recs = board.json?.recommendations ?? [];
const health = board.json?.poolHealth ?? null;

check('it reports pool health', !!health, health ? '' : 'missing — deploy may predate the completeness repair');

const withAdp = recs.filter((r) => r.adp != null);
const withoutAdp = recs.filter((r) => r.adp == null);
const deepest = withAdp.reduce((max, r) => Math.max(max, r.adp), 0);

console.log('');
check(
  `the board is deep enough to draft with (>= ${MINIMUM_USABLE_POOL})`,
  recs.length >= MINIMUM_USABLE_POOL,
  `${recs.length} available players`,
);
check(
  'it goes well past where it used to stop',
  deepest > 100,
  `deepest known ADP ${deepest || 'none'} (it once ended near 78)`,
);
check(
  'players with no published ADP are kept rather than deleted',
  withoutAdp.length > 0 || (health?.activeEligible ?? 0) <= withAdp.length,
  `${withoutAdp.length} carried with no ADP, ${withAdp.length} with one`,
);

/*
 * The honesty check. An unpriced player must show nothing rather than a number
 * the app made up, and must not be floated up the board by the absence.
 */
for (const rec of withoutAdp.slice(0, 5)) {
  check(
    `${rec.name} is unknown rather than invented`,
    rec.adp == null && rec.adpValue == null && rec.degraded === true,
    `adp=${rec.adp ?? '—'} val=${rec.adpValue ?? '—'} degraded=${rec.degraded}`,
  );
}
if (withoutAdp.length > 0) {
  const firstUnpriced = recs.findIndex((r) => r.adp == null);
  const lastPriced = recs.map((r) => r.adp == null).lastIndexOf(false);
  check(
    'unpriced players rank behind the priced ones',
    firstUnpriced > lastPriced,
    `first unpriced at ${firstUnpriced + 1}, last priced at ${lastPriced + 1}, of ${recs.length}`,
  );
}

console.log('');
if (health) {
  console.log(
    `      eligible ${health.activeEligible} · drafted ${health.drafted} · scored ${health.scored} ` +
      `· returned ${health.returned} (cap ${health.cap})`,
  );
  console.log(
    `      by position: ${Object.entries(health.byPosition)
      .map(([pos, n]) => `${pos} ${n}`)
      .join(' · ')}`,
  );
  check(
    'the cap is what bounds the board, not an accident',
    health.scored <= health.cap && health.returned <= health.scored,
    `${health.activeEligible} eligible → ${health.scored} scored → ${health.returned} returned`,
  );
}

console.log('\nthe depth, in bands:');
for (const [from, to] of [
  [1, 50],
  [50, 100],
  [100, 150],
  [150, 200],
  [200, 300],
]) {
  const n = withAdp.filter((r) => r.adp >= from && r.adp < to).length;
  console.log(`      ADP ${String(from).padStart(3)}–${String(to).padStart(3)}: ${n}`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
