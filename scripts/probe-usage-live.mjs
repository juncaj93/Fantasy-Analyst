/**
 * Is the per-game usage feed alive, and does the app still answer without it?
 *
 * Three states look identical from a card that says "insufficient data", and
 * only one of them is a fault:
 *
 *   1. **there is no file yet.** `stats_player_week_2026.csv` is a 404 until
 *      the season starts, so nothing has been ingested and nothing can be. This
 *      is the expected state from February to September.
 *   2. **the file exists and has not changed.** The check sent a validator, got
 *      a 304, and exited. This is the design working, and it is only
 *      distinguishable from (1) by whether a validator is stored.
 *   3. **nobody has six games yet.** The file is being ingested weekly and the
 *      detector still says nothing, because three recent games against three of
 *      baseline is the minimum and it is right to insist on it.
 *
 * This prints which one is true, and then checks the thing that matters more
 * than any of them: that Start/Sit still answers. Usage is a nudge in a close
 * call, never a dependency — the read path swallows its own failures — and the
 * lineup must come back whole whether or not a single target has been stored.
 *
 * Read-only in both directions: it asks the source with HEAD and the app with
 * GET. It writes nothing, forces no ingest, and changes nothing in production.
 *
 *   node scripts/probe-usage-live.mjs [https://your-app.workers.dev]
 */

const BASE = process.argv[2] ?? process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/stats_player';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function line(label, value) {
  console.log(`      ${label.padEnd(30)} ${value}`);
}

async function get(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json — reported by the caller */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** HEAD the release asset. Never GET: this must not download 8MB to answer. */
async function head(season) {
  try {
    const res = await fetch(`${RELEASE}/stats_player_week_${season}.csv`, { method: 'HEAD' });
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      length: res.headers.get('content-length'),
    };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

console.log(`Checking ${BASE}\n`);

// --------------------------------------------------------------- the source

console.log('the published file');
const status = await get('/api/setup/status');
const usage = status.json?.usage ?? null;
const season = usage?.season ?? String(new Date().getUTCFullYear());
const current = await head(season);
const previous = await head(String(Number(season) - 1));

line(`${season}`, current.status === 404 ? '404 — not published yet' : `${current.status}, ${current.length ?? '?'} bytes`);
line(`${Number(season) - 1}`, previous.status === 404 ? '404' : `${previous.status} (last season, for comparison)`);

/*
 * Last season's file existing while this season's does not is what proves the
 * URL is right and the season is simply not under way. Both missing would mean
 * the release moved.
 */
check(
  'the release the app reads from is still there',
  previous.status === 200 || previous.status === 302,
  `last season answers ${previous.status}`,
);

// ------------------------------------------------------------------ the app

console.log('\nwhat the app has stored');
check('/api/setup/status answers', status.status === 200, `HTTP ${status.status}`);
check('and it reports the usage feed at all', !!usage, usage ? `source ${usage.source}` : 'no usage block');

if (usage) {
  line('summary', usage.summary);
  line('data health', usage.dataHealth);
  line('last outcome', `${usage.lastOutcome ?? 'never'}${usage.lastNote ? ` — ${usage.lastNote}` : ''}`);
  line('checked / changed / stored', `${usage.checkedAt ?? 'never'} · ${usage.sourceModifiedAt ?? 'unknown'} · ${usage.ingestedAt ?? 'never'}`);
  line('validators', `etag ${usage.etag ?? 'none'} · last-modified ${usage.lastModified ?? 'none'}`);
  line('coverage', `${usage.players} player(s), ${usage.weeks} week(s), ${usage.rows} row(s), latest week ${usage.latestWeek ?? 'none'}`);
  line('ready for the detector', `${usage.playersWithEnoughGames} of ${usage.players} have ${usage.minimumGames} games`);
  line('writes today', `${usage.writesToday} of ${usage.writeCeiling}`);

  /*
   * The two ways of writing nothing, told apart. A stored validator means the
   * app asked and the file had not changed; no validator means there was
   * nothing to ask about, which is what an unpublished season looks like.
   */
  if (current.status === 404) {
    check(
      'an unpublished season is reported as a fact, not a failure',
      usage.lastOutcome === 'not_published' || usage.players > 0,
      `last outcome ${usage.lastOutcome}`,
    );
    check(
      'and no validator is stored for a file that does not exist',
      !usage.etag && !usage.lastModified,
      `etag ${usage.etag ?? 'none'}, last-modified ${usage.lastModified ?? 'none'}`,
    );
  } else {
    check(
      'a published season has been ingested',
      !!usage.ingestedAt,
      usage.ingestedAt ?? 'never stored',
    );
    check(
      'and its validator is stored, so the next check costs no bytes',
      !!(usage.etag || usage.lastModified),
      usage.etag ?? usage.lastModified ?? 'none',
    );
  }

  check(
    'checking, changing and storing are reported separately',
    'checkedAt' in usage && 'sourceModifiedAt' in usage && 'ingestedAt' in usage,
    'three timestamps, not one',
  );

  check(
    'the usage pipeline is not churning the database',
    (usage.writesToday ?? 0) < usage.writeCeiling,
    `${usage.writesToday ?? 0} of ${usage.writeCeiling} writes used today`,
  );

  check(
    'a run of failed ingests would be visible',
    (usage.consecutiveFailures ?? 0) === 0,
    usage.consecutiveFailures ? `${usage.consecutiveFailures} in a row since ${usage.failingSince}` : 'none',
  );
}

/*
 * The injury feed, checked here too and deliberately. The two feeds now share
 * the *code* behind the fingerprint, the lease and the failure counter — though
 * not the tables or the ledgers, which stay separate on purpose — so "did
 * adding usage disturb the pipeline that decides whether somebody plays today"
 * is a question this probe should answer rather than assume.
 */
const injury = status.json?.injury ?? null;
if (injury) {
  console.log('\nthe injury feed, which shares this machinery');
  if (injury.checkedAt) {
    const minutes = (Date.now() - Date.parse(injury.checkedAt)) / 60_000;
    check('the five-minute injury check is still running', minutes < 15, `last checked ${minutes.toFixed(1)} minutes ago`);
  } else {
    console.log('      never checked yet — expected only in the first minutes after a deploy');
  }
  // Printed rather than asserted: the two ledgers being equal is not wrong, it
  // is what a quiet day looks like. What would be wrong is one pipeline's
  // spending being invisible, and that is what showing both makes impossible.
  line('write ledgers', `injury ${injury.writesToday}/${injury.writeCeiling} · usage ${usage?.writesToday ?? '?'}/${usage?.writeCeiling ?? '?'}`);
}

// ------------------------------------------------------------- the decision

console.log('\nwhat Start/Sit does with it');
const league = status.json?.league ?? null;
if (!league?.id) {
  console.log('      no league selected on this deployment — nothing to compare');
} else {
  const lineup = await get(`/api/leagues/${encodeURIComponent(league.id)}/lineup`);
  check('the lineup still answers', lineup.status === 200, `HTTP ${lineup.status}`);

  check('and it found your team in the league', lineup.json?.found !== false, lineup.json?.error ?? 'found');

  /*
   * The lineup answers with slots, a bench and the undecidable — the full
   * evaluation lives on the last two, and a slot carries only what the row
   * draws. Both are read, because "it answered" and "it evaluated somebody"
   * are different claims and only the second is worth much.
   */
  const slots = Array.isArray(lineup.json?.slots) ? lineup.json.slots : [];
  const all = [...(lineup.json?.bench ?? []), ...(lineup.json?.undecidable ?? [])];
  const filled = slots.filter((s) => s.playerId);
  const roles = all.map((e) => e.role).filter(Boolean);

  line('lineup', `${filled.length} of ${slots.length} slot(s) filled · ${all.length} further evaluation(s)`);

  /*
   * An empty roster is a preseason state, not a fault.
   *
   * Sleeper does not populate a league's rosters until its draft has finished,
   * so between now and then the lineup correctly answers with a full set of
   * empty slots and nothing to evaluate. Asserting otherwise would produce a
   * probe that fails every August — and a check that cries wolf every preseason
   * is one nobody reads in November.
   */
  if (slots.length > 0 && filled.length === 0 && all.length === 0) {
    console.log('      no players on the roster yet — Sleeper fills these in when the draft finishes');
  } else {
    check('and it evaluated somebody in full', all.length > 0, `${all.length} evaluation(s) beyond the slots`);
    check(
      'every evaluation carries a role verdict',
      roles.length === all.length,
      `${roles.length} of ${all.length}`,
    );
    check(
      'and the lineup is still scored without usage',
      filled.some((s) => s.score != null),
      `${filled.filter((s) => s.score != null).length} of ${filled.length} filled slot(s) carry a score`,
    );
  }

  const counts = {};
  for (const role of roles) counts[role.trend] = (counts[role.trend] ?? 0) + 1;
  line('role verdicts', Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none');

  /*
   * The claim that matters while nothing is stored: an empty usage feed costs
   * the role trend and nothing else. A player with no series must come back as
   * `insufficient_data` — never as a trend inferred from nothing.
   */
  if ((usage?.players ?? 0) === 0) {
    check(
      'with nothing stored, no role change is claimed for anybody',
      roles.every((r) => r.trend === 'insufficient_data'),
      Object.keys(counts).join(', ') || 'nobody to claim anything about yet',
    );
  }
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
