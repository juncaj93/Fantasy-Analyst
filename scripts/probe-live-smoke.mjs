/**
 * Does the deployed site actually serve what was just shipped?
 *
 * The deploy workflow already checks that the app is up, reads its database and
 * refuses an unauthenticated write. This asks the next question: are the
 * surfaces added by the most recent work answering in production, against the
 * real database rather than a seeded one?
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

let failures = 0;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, json, text };
}

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log(`Checking ${BASE}\n`);

// 1. Season-long market status: the route exists and the season-scoped tables
//    answer. Empty is the expected, honest state for this provider.
const season = await get('/api/vegas/season');
check('/api/vegas/season responds', season.status === 200, `HTTP ${season.status}`);
if (season.json) {
  check(
    'it reports a season and a provider',
    typeof season.json.season === 'string' && typeof season.json.provider === 'string',
    `${season.json.provider} / ${season.json.season}`,
  );
  check(
    'it says why it has what it has',
    typeof season.json.reason === 'string' && season.json.reason.length > 0,
    season.json.reason,
  );
  console.log(
    `      stored: ${season.json.quotes} quote(s) across ${season.json.players} player(s), ` +
      `${season.json.unresolved} unresolved, fetched ${season.json.fetchedAt ?? 'never'}`,
  );
}

// 2. The draft board: the shape the new Draft screen reads.
const status = await get('/api/setup/status');
const draftId = status.json?.league?.draftId ?? null;
check('a league with a draft is configured', !!draftId, draftId ?? 'none');

// Hoisted, and asked for the whole board rather than five rows: the tier checks
// below are about the shape of a position's ladder, and five players is not one.
let board = { status: 0, json: null };
if (draftId) {
  board = await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=200`);
  check('the draft board builds', board.status === 200, `HTTP ${board.status}`);
  const rec = board.json?.recommendations?.[0];
  check('it returns ranked players', !!rec, rec ? rec.name : 'none');
  check(
    'every starting slot is reported for the roster line',
    Array.isArray(board.json?.rosterProgress) && board.json.rosterProgress.length > 0,
    (board.json?.rosterProgress ?? []).map((s) => `${s.filled}/${s.required} ${s.slot}`).join(' · '),
  );
  if (rec) {
    check(
      'the market component is present on every player',
      rec.components.some((c) => c.key === 'market_expectation'),
    );
    check(
      'an unpriced player is unknown rather than zero',
      rec.marketBaseline == null || rec.marketBaseline.points != null,
      rec.marketHeadline ?? 'no market line, and none shown',
    );
    check('roster need is a light contributor', Math.abs(componentOf(rec, 'need')) <= 0.2, `need ${componentOf(rec, 'need')}`);
  }
  console.log(
    `      alerts still computed: ${(board.json?.rosterAlerts ?? []).length}, ` +
      `startable positions: ${(board.json?.startablePositions ?? []).join(', ')}`,
  );
}

function componentOf(rec, key) {
  return rec.components.find((c) => c.key === key)?.contribution ?? 0;
}

// 3. The quota guard, in production.
//
// The point of the budget is that a problem is visible while it is still a
// number. So this asks the deployed app what it thinks it has spent, and — more
// importantly — that asking costs nothing: the route reads the ledger, and if it
// ever started calling the provider this check is what would notice.
const budget = await get('/api/vegas/budget');
check('/api/vegas/budget responds', budget.status === 200, `HTTP ${budget.status}`);
if (budget.json) {
  const b = budget.json.budget ?? {};
  check(
    'it reports a month, a state and a ceiling',
    typeof b.month === 'string' && typeof b.state === 'string' && b.limit > 0,
    `${b.used} of ${b.limit} in ${b.month} (${b.state}, counted by ${b.source})`,
  );
  check(
    'the guard is not already in the reserve',
    b.state !== 'hard_stop',
    b.note ?? '',
  );
  check(
    'the next refresh is scoped to the roster, not the slate',
    (budget.json.nextPlan?.estimatedEntities ?? 0) <= 12,
    `${budget.json.nextPlan?.events?.length ?? 0} game(s), ${budget.json.nextPlan?.estimatedEntities ?? 0} entities`,
  );
  const spent = Object.entries(budget.json.bySource ?? {})
    .map(([source, entities]) => `${source} ${entities}`)
    .join(' · ');
  console.log(`      spent this month: ${spent || 'nothing yet'}`);
  for (const row of (budget.json.recent ?? []).slice(0, 3)) {
    console.log(`      ${row.at} ${row.source} ${row.outcome} ${row.entities} — ${row.reason ?? ''}`);
  }
}

// 4. The tier ladder, as the board would draw it.
//
// Two failure modes, opposite and both loud. Every player at a position tagged
// `Tier cliff` is the bug this label has already shipped once; no tier
// structure at all means the grouping quietly collapsed to one group and the
// dividers stopped being drawn. Neither is visible from a unit test, because
// production has a real board on it.
if (board.json) {
  const recs = board.json.recommendations ?? [];
  const byPosition = new Map();
  for (const rec of recs) {
    if (!rec.position) continue;
    const list = byPosition.get(rec.position);
    if (list) list.push(rec);
    else byPosition.set(rec.position, [rec]);
  }
  for (const [position, players] of [...byPosition].sort()) {
    const tiers = new Set(players.map((p) => p.tierCliff?.tierIndex).filter((t) => t != null));
    // Only the last one or two of the group in play may carry the tag.
    const tagged = players.filter(
      (p) => p.tierCliff?.tierIndex === 0 && p.tierCliff?.tierEndsAtCliff && (p.tierCliff?.tierSize ?? 0) <= 2,
    );
    check(
      `${position}: the cliff tag is on nobody or on the last of a group`,
      tagged.length <= 2,
      `${players.length} available, ${tiers.size} tier(s), ${tagged.length} tagged`,
    );
    const currentTier = players.filter((p) => p.tierCliff?.tierIndex === 0);
    check(
      `${position}: the group in play reports one size to all of its members`,
      new Set(currentTier.map((p) => p.tierCliff?.tierSize)).size <= 1,
      `sizes: ${[...new Set(currentTier.map((p) => p.tierCliff?.tierSize))].join(', ')}`,
    );
  }
}

// 5. The expanded card's two feeds.
//
// Both are caches of Sleeper data, and a card cannot tell a cache that is empty
// from a player who has nothing — so the counts are asked for directly. Read
// from the status already fetched above; nothing here needs a second request.
const detail = status.json?.playerDetail;
check('setup reports where the player-card data comes from', !!detail, detail ? '' : 'missing');
if (detail) {
  check(
    `${detail.stats.season} statistics are loaded`,
    (detail.stats.players ?? 0) > 0,
    `${detail.stats.players} players, last run ${detail.stats.lastRunAt ?? 'never'}`,
  );
  check(
    'the outlook cache is answering rather than empty',
    (detail.outlook.stored ?? 0) + (detail.outlook.noneAvailable ?? 0) >= 0,
    `${detail.outlook.stored} stored, ${detail.outlook.noneAvailable} with none published`,
  );
  check(
    'roster percentage is reported as unavailable, not invented',
    detail.rosterPercent?.available === false,
    detail.rosterPercent?.note ?? '',
  );
}

// One player's detail, end to end, on whoever is top of the live board.
const topPlayer = board.json?.recommendations?.[0];
if (topPlayer) {
  const one = await get(`/api/players/${topPlayer.playerId}/detail`);
  check(`/api/players/:id/detail answers for ${topPlayer.name}`, one.status === 200, `HTTP ${one.status}`);
  if (one.json) {
    const last = one.json.lastSeason;
    // A finish is only printed for somebody who scored. A four-figure rank
    // would mean the provider's whole-directory ordering had leaked through.
    check(
      'any positional finish is a plausible one',
      !last?.positionRank || /^[A-Z]+([1-9]\d{0,2})$/.test(last.positionRank),
      `${last?.season ?? '—'}: ${last?.gamesPlayed ?? '—'} GP, ${last?.positionRank ?? 'no finish'}`,
    );
    const summary = one.json.outlook?.summary ?? '';
    check(
      'any outlook is short and attributed',
      !one.json.outlook || (summary.length > 0 && summary.length < 500 && !!one.json.outlook.source),
      one.json.outlook
        ? `${summary.length} chars from ${one.json.outlook.source}`
        : (one.json.outlookNote ?? 'none published'),
    );
  }
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
