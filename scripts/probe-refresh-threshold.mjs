/**
 * Is the per-game refresh table live, and what does it decide for real games?
 *
 * Read-only: it only GETs. It prints the deployed commit, then for every game
 * the planner currently knows (with its kickoff) the wait the manual-refresh
 * table gives it, how old its lines are according to the usage ledger, and so
 * whether a manual refresh would buy it. Then the ledger's newest rows, so a
 * refresh run just before this shows which games it really bought.
 *
 * Env: EXPECT_SHA (prefix of the commit that should be live), APP_URL.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const EXPECT = (process.env.EXPECT_SHA ?? '').trim();

async function get(path) {
  const res = await fetch(`${APP}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 300) };
  }
}

// The same table as manualRefreshThresholdMinutes in src/core/vegas/plan.ts.
function waitMinutes(hours) {
  if (hours == null || !Number.isFinite(hours)) return 360;
  if (hours <= 0) return null;
  if (hours < 2) return 15;
  if (hours <= 24) return 60;
  return 360;
}

const now = Date.now();
console.log(`asking ${APP} at ${new Date(now).toISOString()}\n`);

const health = await get('/api/health');
const sha = health.json?.release?.gitSha ?? health.json?.gitSha ?? null;
console.log(`/api/health -> ${health.status}  gitSha=${sha ?? '(none)'}`);
if (EXPECT) {
  const ok = !!sha && (sha.startsWith(EXPECT) || EXPECT.startsWith(sha));
  console.log(`expected ${EXPECT}: ${ok ? 'LIVE' : 'NOT LIVE'}`);
  if (!ok) process.exitCode = 1;
}

const b = await get('/api/vegas/budget');
if (!b.json) {
  console.log(`\n/api/vegas/budget -> ${b.status} ${b.text ?? ''}`);
  process.exit(1);
}
const recent = b.json.recent ?? [];
const lastFetch = new Map();
for (const r of recent) {
  if (r.outcome === 'fetched' && r.eventId && !lastFetch.has(r.eventId)) lastFetch.set(r.eventId, Date.parse(r.at));
}

console.log('\n=== games the planner knows, and what the table says ===');
const games = b.json.nextPlan?.events ?? [];
if (games.length === 0) console.log('  (none planned under the clock rules right now)');
for (const g of games) {
  const hours = g.kickoff ? (Date.parse(g.kickoff) - now) / 3_600_000 : null;
  const wait = waitMinutes(hours);
  const at = lastFetch.get(g.eventId);
  const age = at ? (now - at) / 60_000 : null;
  const verdict =
    wait === null ? 'SKIP (kicked off)' : age == null ? 'FETCH (no fetch in recent ledger)' : age >= wait ? 'FETCH' : 'SKIP (fresh enough)';
  console.log(
    `  ${g.eventId}  kickoff=${g.kickoff ?? '?'}  ${hours == null ? '?' : hours.toFixed(1)}h out  wait=${wait ?? 'never'}min  ` +
      `age=${age == null ? 'n/a' : Math.round(age) + 'min'}  -> ${verdict}`,
  );
}

console.log('\n=== newest ledger rows ===');
for (const r of recent) {
  console.log(`  ${r.at}  ${r.source}  ${r.outcome}  event=${r.eventId ?? '-'}  entities=${r.entities}  ${String(r.reason ?? '').slice(0, 90)}`);
}
console.log(`\nbudget: ${JSON.stringify(b.json.budget).slice(0, 300)}`);
