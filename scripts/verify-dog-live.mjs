/**
 * Check what the live app is actually doing with DOG.
 *
 * Everything about this feature is verifiable offline except the one thing that
 * matters — whether the deployed board is really pricing against two markets.
 * A unit test proves the blend arithmetic; only the live response proves the
 * snapshot arrived, resolved to real players, was judged fresh, and reached the
 * ranking rather than being dropped somewhere between the importer and the card.
 *
 * Read-only. It logs in, reads one draft board, and writes nothing.
 *
 * Usage:
 *   node scripts/verify-dog-live.mjs --url https://... --passphrase ...
 *
 * Exits non-zero when a claim the board makes about itself is not true, so it
 * can be a gate rather than a report somebody has to read.
 */

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_BASE = arg('url', process.env.URL ?? '').replace(/\/$/, '');
const PASSPHRASE = arg('passphrase', process.env.PASSPHRASE ?? '');

if (!URL_BASE) {
  console.error('::error::no --url given');
  process.exit(2);
}

const failures = [];
const check = (ok, claim, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(claim);
};

const cookies = [];
async function call(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: cookies.join('; '), ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) cookies.push(c.split(';')[0]);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 400);
  }
  return { status: res.status, body };
}

if (PASSPHRASE) {
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ passphrase: PASSPHRASE }) });
  if (login.status !== 200) {
    console.error(`::error::could not unlock the app (HTTP ${login.status})`);
    process.exit(2);
  }
}

// ------------------------------------------------------- find a draft to read

const leagues = await call('/api/leagues');
const all = leagues.body?.leagues ?? [];
// The selected league first, because that is the board the user actually reads.
const league = all.find((l) => l.isSelected && l.draftId) ?? all.find((l) => l.draftId);
if (!league) {
  console.error('::error::no league on the live app carries a draft to read a board from');
  process.exit(2);
}
console.log(`reading ${league.name} (${league.season}), draft ${league.draftId}`);

const board = await call(`/api/drafts/${league.draftId}/board?limit=250&diagnostics=1`);
if (board.status !== 200) {
  console.error(`::error::the board endpoint answered HTTP ${board.status}`);
  console.error(JSON.stringify(board.body).slice(0, 600));
  process.exit(2);
}

const state = board.body;
const recs = state.recommendations ?? [];

// ------------------------------------------------------------ the ingestion

const dog = state.dogState ?? {};
console.log('\n# the snapshot');
console.log(JSON.stringify(dog, null, 2));

check(dog.available === true, 'DOG is available on the live board', dog.reason ?? '');
check(dog.sourceType === 'raw_adp', 'the snapshot is labelled raw ADP', String(dog.sourceType));
check(!!dog.provider, 'the snapshot records which provider served it', String(dog.provider));
check(!!dog.snapshotAt, 'the source published an effective time', String(dog.snapshotAt));
check(
  dog.freshness === 'fresh' || dog.freshness === 'aging',
  'the snapshot is fresh enough to use',
  `${dog.freshness}, ${dog.ageHours == null ? 'age unknown' : `${Math.round(dog.ageHours)}h old`}`,
);
check((dog.matched ?? 0) > 100, 'the snapshot resolved to real players', `${dog.matched} matched`);

// --------------------------------------------------------------- the ranking

const withDog = recs.filter((r) => r.dogAdp != null);
console.log('\n# the board');
check(recs.length > 0, 'the board returned recommendations', `${recs.length} rows`);
check(withDog.length > 0, 'DOG reached the ranking', `${withDog.length}/${recs.length} rows carry a DOG value`);

const disagreeing = withDog.filter((r) => r.adp != null && Math.abs(r.adp - r.dogAdp) >= 1);
check(
  disagreeing.length > 0,
  'the two markets are genuinely different numbers',
  `${disagreeing.length} rows differ by a pick or more`,
);

for (const r of withDog.slice(0, 5)) {
  const blend = r.marketBlend ?? {};
  console.log(
    `  ${String(r.name).padEnd(24)} ADP ${String(r.adp ?? '-').padStart(6)}  DOG ${String(r.dogAdp).padStart(6)}` +
      `  blended ${String(blend.adp ?? '-').padStart(6)}  weights ${JSON.stringify(blend.weights ?? {})}`,
  );
}

// --------------------------------------------------------------- the weights

console.log('\n# the weighting');
const format = state.marketFormat ?? {};
console.log(JSON.stringify(format, null, 2));

const expected = format.bestBall ? { dog: 0.75, sleeper: 0.25 } : { dog: 0.6, sleeper: 0.4 };
const blended = withDog.filter((r) => r.marketBlend?.sources?.length === 2);

check(
  blended.length > 0,
  'some rows are priced against both markets',
  `${blended.length} two-source rows (the rest are single-source, which is correct rather than a fault)`,
);

const wrongWeights = blended.filter(
  (r) => r.marketBlend.weights?.dog !== expected.dog || r.marketBlend.weights?.sleeper !== expected.sleeper,
);
check(
  wrongWeights.length === 0,
  `every two-source row uses ${expected.dog * 100}/${expected.sleeper * 100} for ${
    format.bestBall ? 'best ball' : 'an ordinary league'
  }`,
  wrongWeights.length ? `${wrongWeights.length} rows disagree` : '',
);

/*
 * The blend is the weights, applied. Checked against the numbers on the row
 * rather than trusted: a `weights` field that says 60/40 while the baseline was
 * computed some other way is exactly the kind of thing that survives every
 * unit test and is wrong in production.
 */
const misblended = blended.filter((r) => {
  const want = r.dogAdp * expected.dog + r.adp * expected.sleeper;
  return Math.abs(want - r.marketBlend.adp) > 0.05;
});
check(misblended.length === 0, 'the blended baseline is those weights actually applied',
  misblended.length ? `${misblended.length} rows do not reconcile` : `checked ${blended.length} rows`);

/*
 * Val is Sleeper's, and stays Sleeper's.
 *
 * The one number on the card whose meaning would change silently if the blend
 * leaked into it — it has always meant "how far past Sleeper's ADP this pick
 * is", and a DOG-versus-Sleeper composite wearing the same label would be a
 * different quantity with the same name.
 */
const currentPick = state.currentPick ?? null;
if (currentPick != null) {
  const valLeaked = recs.filter(
    (r) => r.adp != null && r.adpValue != null && Math.abs(currentPick - r.adp - r.adpValue) > 0.06,
  );
  check(valLeaked.length === 0, 'Val is still measured against Sleeper alone',
    valLeaked.length ? `${valLeaked.length} rows look blended` : `checked against pick ${currentPick}`);
}

console.log('');
if (failures.length > 0) {
  console.error(`::error::${failures.length} live check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('every live DOG check passed');
