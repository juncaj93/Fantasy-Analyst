/**
 * Why did the injury pipeline write nothing?
 *
 * There are two very different reasons a five-minute tick writes zero rows, and
 * from the outside they look identical:
 *
 *   1. The file exists and has not changed. The check sent a validator, got a
 *      304, and exited. This is the design working.
 *   2. There is no file. The season's report has not been published, so there
 *      is nothing to check, nothing to parse, and nothing to compare against.
 *      Nothing is working -- there is simply nothing there yet.
 *
 * "Zero writes" is only evidence that the pipeline is cheap if it is the first
 * one. This probe refuses to let the two be confused: it reads the live source
 * and the deployed app's own record of it, and prints which case is true.
 *
 * Read-only in both directions. It sends no writes, forces no ingest, and
 * changes nothing in production -- it asks the source with HEAD and the app
 * with GET, and prints what they say.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download/injuries';

function line(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

/** HEAD the release asset. Never GET: this must not download 700KB to answer. */
async function head(season) {
  try {
    const res = await fetch(`${RELEASE}/injuries_${season}.csv`, { method: 'HEAD' });
    return {
      status: res.status,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      length: res.headers.get('content-length'),
    };
  } catch (err) {
    return { status: 0, error: String(err) };
  }
}

const now = new Date();
console.log(`Injury source state at ${now.toISOString()}`);
console.log(`  app:    ${BASE}`);
console.log(`  source: ${RELEASE}\n`);

/*
 * The season the app asks for. Reports run into January, so a January date
 * still belongs to the previous calendar year's season -- the same rule the
 * service uses, restated here rather than imported so this probe stays
 * standalone.
 */
const season = String(now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

console.log('Live source (HEAD, no download)');
const current = await head(season);
line(`injuries_${season}.csv`, current.error ?? `HTTP ${current.status}`);
if (current.status === 200) {
  line('  ETag', current.etag ?? 'none');
  line('  Last-Modified', current.lastModified ?? 'none');
  line('  Content-Length', current.length ?? 'unknown');
}

/*
 * The previous season, as a control. If this one answers 200 while the current
 * one 404s, the 404 is "not published yet" rather than "the source is broken",
 * and that distinction is the whole point of the probe.
 */
const previous = await head(String(Number(season) - 1));
line(`injuries_${Number(season) - 1}.csv`, `HTTP ${previous.status}` + (previous.status === 200 ? ` (${previous.length} bytes)` : ''));

console.log('\nWhat the deployed app has stored');
const res = await fetch(`${BASE}/api/setup/status`, { headers: { accept: 'application/json' } });
const status = res.ok ? await res.json() : null;
const injury = status?.injury ?? null;

if (!injury) {
  console.log(`  could not read /api/setup/status — HTTP ${res.status}`);
  process.exit(1);
}

const run = injury.lastRun;
line('stored ETag', injury.etag ?? 'none');
line('stored Last-Modified', injury.lastModified ?? 'none');
line('source last changed', injury.sourceModifiedAt ?? 'unknown');
line('last checked', injury.checkedAt ?? 'never');
line('last stored anything', injury.ingestedAt ?? 'never');
line('last outcome', `${injury.lastOutcome ?? 'none'}${injury.lastNote ? ` — ${injury.lastNote}` : ''}`);
line('players with a stored report', String(injury.players ?? 0));
line('latest week stored', injury.latestWeek == null ? 'none' : String(injury.latestWeek));
line('rows parsed on last run', run ? String(run.rowsReturned) : 'no run recorded');
line('players matched on last run', run ? `${run.matchedById} by id + ${run.matchedByName} by name` : 'n/a');
line('changed players (recent events)', String((injury.recentEvents ?? []).length));
line('writes used today', `${injury.writesToday ?? 0} of ${injury.writeCeiling}`);
line('designation source', injury.statusSource);

/*
 * The verdict. This is the sentence the probe exists to print, and it is
 * derived from the two readings above rather than from the write count -- the
 * write count is the thing being explained, so it cannot also be the evidence.
 */
console.log('\nVerdict');
if (current.status === 404) {
  console.log(`  The ${season} file does not exist yet — the source returns 404, with no`);
  console.log('  ETag and no Last-Modified to store. Zero writes here means THERE IS NO');
  console.log('  SOURCE DATA, not that an existing report was unchanged. The conditional');
  console.log('  304 path has not run in production and cannot until this file appears.');
  console.log(`  Availability comes from ${injury.statusSource} designations alone until then.`);
  if (injury.etag || injury.lastModified) {
    console.log('  WARNING: a validator is stored for a file that 404s. That should not');
    console.log('  happen — a fingerprint from a missing or empty file would 304 forever');
    console.log('  against nothing.');
    process.exitCode = 1;
  }
} else if (current.status === 200 && injury.etag) {
  const same = injury.etag === current.etag;
  console.log(`  The ${season} file exists and the app holds a validator for it.`);
  console.log(`  Stored ETag ${same ? 'matches' : 'DIFFERS FROM'} the live one${same ? '' : ' — an ingest is due'}.`);
  console.log('  Zero writes here means the file was unchanged, which is the design.');
} else if (current.status === 200) {
  console.log(`  The ${season} file exists but the app holds no validator for it yet.`);
  console.log('  The next check will download and ingest it in full.');
} else {
  console.log(`  The source answered HTTP ${current.status}, which is neither 200 nor 404.`);
  console.log('  Treat this as a source failure rather than a steady state.');
  process.exitCode = 1;
}
