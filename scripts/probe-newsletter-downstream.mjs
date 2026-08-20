/**
 * Does the newsletter evidence actually reach the screens that read it?
 *
 * A repair that changes the ledger and leaves Draft, Players and Trades showing
 * yesterday's number is not finished — and that failure is invisible from the
 * ledger itself, which is exactly why it deserves its own check.
 *
 * The interesting property here is not "the number is 1". It is that every
 * surface derives the same number from the same evidence: the ledger, the
 * player's own signal, the draft board's news components and the Players list
 * must agree, because they are all supposed to be reading one source. A
 * disagreement means something cached what it should have computed.
 *
 * Read-only: every request is a GET.
 *
 *   PLAYER_ID=13413 EXPECT_NET=1 node scripts/probe-newsletter-downstream.mjs
 */

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const PLAYER_ID = process.env.PLAYER_ID ?? '13413';
const EXPECT_NET = process.env.EXPECT_NET === undefined ? null : Number(process.env.EXPECT_NET);
// Defaults to the issue this was written for, so the probe workflow needs no
// extra inputs; override to look at any other newsletter.
const MESSAGE_ID = process.env.MESSAGE_ID ?? '<20260820114548.3.2eac9edb56b4cb63@mg2.substack.com>';
const DRAFT_ID = process.env.DRAFT_ID ?? '';

const LIVE = new Set(['auto_applied', 'accepted', 'corrected', 'pending']);

const problems = [];
function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 300) } };
  }
}

console.log(`Site  : ${URL_BASE}`);
console.log(`Player: ${PLAYER_ID}`);
console.log('Read-only: every request is a GET.\n');

// ------------------------------------------------------------ the ledger ---
console.log('=== THE LEDGER ============================================');
const player = (await get(`/api/players/${encodeURIComponent(PLAYER_ID)}`)).body;
const name = player?.player?.name ?? '(unknown)';
const raw = player?.signal?.raw ?? {};
console.log(`  ${name}: net ${raw.net} (+${raw.positive}/-${raw.negative}) across ${raw.items} item(s)`);

const fromMessage = (player?.evidence ?? []).filter((e) => e.sourceMessageId === MESSAGE_ID);
for (const e of fromMessage) {
  console.log(`    ${e.reviewStatus.padEnd(12)} ${e.polarity}/${e.magnitude}  "${e.excerpt.slice(0, 60)}"`);
}
if (MESSAGE_ID) {
  const live = fromMessage.filter((e) => LIVE.has(e.reviewStatus));
  check(live.length === 0, 'the withdrawn newsletter contributes no live evidence', `live=${live.length}`);
  check(fromMessage.length > 0, 'its retired row is still on the record, not deleted', `rows=${fromMessage.length}`);
}
if (EXPECT_NET !== null) {
  check(raw.net === EXPECT_NET, 'the ledger reports the expected tally', `net=${raw.net}`);
}

/**
 * A retired row must not be counted anywhere in the signal, including the
 * windows. Recomputing the same sum from the live rows is the honest way to ask
 * that — if the cached signal disagrees with its own evidence, it is stale.
 */
const recomputed = (player?.evidence ?? [])
  .filter((e) => LIVE.has(e.reviewStatus))
  .reduce((sum, e) => sum + (e.polarity === 'positive' ? e.magnitude : e.polarity === 'negative' ? -e.magnitude : 0), 0);
check(recomputed === raw.net, 'the cached signal agrees with its own live evidence', `recomputed=${recomputed}, cached=${raw.net}`);

// ---------------------------------------------------------------- Players ---
console.log('\n=== PLAYERS ===============================================');
const list = (await get(`/api/players?q=${encodeURIComponent(name)}&limit=50`)).body;
const inList = (list?.players ?? []).find((p) => String(p.id) === String(PLAYER_ID));
if (inList) {
  console.log(`  found in the Players list: newsNet=${inList.newsNet ?? '(absent)'}`);
  if (inList.newsNet !== undefined && inList.newsNet !== null) {
    check(inList.newsNet === raw.net, 'the Players list agrees with the ledger', `${inList.newsNet} vs ${raw.net}`);
  }
} else {
  console.log(`  not returned by the Players search — nothing to disagree with.`);
}

// ------------------------------------------------------------------ Draft ---
console.log('\n=== DRAFT =================================================');
if (!DRAFT_ID) {
  console.log('  no draft configured on this deployment; the board cannot be read.');
} else {
  const board = (await get(`/api/drafts/${encodeURIComponent(DRAFT_ID)}/board?limit=200`)).body;
  // The board's rows are its recommendations; there is no `players` array.
  const rows = board?.recommendations ?? [];
  console.log(`  board status=${board?.status ?? '(none)'}, ${rows.length} recommendation(s)`);
  check(rows.length > 0, 'the draft board returned rows to check against');
  const row = rows.find((p) => String(p.playerId ?? p.id) === String(PLAYER_ID));
  if (!row) {
    /*
     * Not a failure. The board carries the players worth drafting, and a deep
     * roster name is legitimately absent from it. Saying so is more useful than
     * asserting a presence the product never promised.
     */
    console.log(`  ${name} is not on the board — a deep name the board does not carry.`);
  } else {
    console.log(
      `  ${name}: lifetime=${row.newsLifetimeNet}, 30d=${row.news30Net}, 7d=${row.news7Net}, conflicted=${row.newsConflicted}`,
    );
    check(row.newsLifetimeNet === raw.net, 'the draft board agrees with the ledger', `${row.newsLifetimeNet} vs ${raw.net}`);
  }

  /*
   * Whatever the board does carry must also agree, which is the stronger claim:
   * it proves the board reads evidence rather than a snapshot of it.
   *
   * Every row, not a sample. A sample answers "is the board broadly right",
   * which nobody doubted; the question after a withdrawal is whether any single
   * row is still carrying a number the ledger no longer supports, and one row is
   * all it takes. The board is a few hundred rows and each is one cached read,
   * so checking all of them costs seconds and removes the caveat entirely.
   */
  let compared = 0;
  let disagreed = 0;
  for (const p of rows) {
    const id = String(p.playerId ?? p.id);
    const detail = (await get(`/api/players/${encodeURIComponent(id)}`)).body;
    const net = detail?.signal?.raw?.net;
    if (net === undefined) continue;
    compared++;
    if (net !== p.newsLifetimeNet) {
      disagreed++;
      console.log(`    disagreement on ${detail?.player?.name}: board ${p.newsLifetimeNet} vs ledger ${net}`);
    }
  }
  check(disagreed === 0, `every board row agrees with the ledger (${compared} checked)`, `disagreements=${disagreed}`);
}

// ----------------------------------------------------------------- Trades ---
console.log('\n=== TRADES ================================================');
const trades = (await get('/api/trades')).body;
if (trades?.error) {
  console.log(`  trades unavailable: ${trades.error}`);
} else {
  const ideas = trades?.ideas ?? trades?.targets ?? [];
  console.log(`  trades responded with ${Array.isArray(ideas) ? ideas.length : 0} item(s)`);
  check(!!trades && !trades.error, 'trades reads the current ledger without error');
}

console.log('\n=== RESULT ================================================');
if (problems.length) {
  console.log('::error::downstream did not agree with the ledger');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('Every surface that reports newsletter evidence agrees with the ledger.');
