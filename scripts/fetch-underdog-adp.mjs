/**
 * Fetch raw Underdog ADP and write an importable snapshot.
 *
 * Run from CI, never from the worker — the same rule the Sleeper ADP fetch
 * follows, and for the same reason: a live draft must not depend on a third
 * party being reachable. The output is the plain JSON the existing ADP importer
 * accepts, plus a sidecar of provenance the import route stores beside it.
 *
 * Usage:
 *   node scripts/fetch-underdog-adp.mjs [--out dog.json] [--meta dog.meta.json]
 *                                       [--primary <url>] [--fallback <url>]
 *
 * Exit codes are deliberately distinct, because a workflow should treat these
 * three failures very differently:
 *
 *   1  neither source was reachable          -> retry later, keep the old snapshot
 *   2  a source answered with something that is not raw ADP
 *                                            -> alert; do NOT import
 *   3  a source answered with a stale board  -> keep the old snapshot
 *
 * The one thing this script will never do is fall back to Sleeper ADP, to
 * Underdog rankings, or to any aggregator's consensus. A missing DOG is a
 * missing DOG: the app renormalises the market baseline around it and says so.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  DOG_PROVIDER_LABELS,
  chooseDogSource,
  parseBestBallTeamBuilder,
  parseFour4Underdog,
  toAdpImportFile,
  validateRawAdp,
} from '../src/core/adp/underdog.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const out = arg('out', 'dog.json');
const metaOut = arg('meta', 'dog.meta.json');
const primaryUrl = arg('primary', process.env.UNDERDOG_ADP_URL ?? '');
const fallbackUrl = arg('fallback', process.env.FOUR4_UNDERDOG_ADP_URL ?? '');

/**
 * A file already on disk, instead of a URL.
 *
 * This is the path that works when the source is behind a login — and both
 * realistic ones are. Export the board from a browser you are already signed
 * in to, hand the file to this script, and everything downstream is identical:
 * the same parser, the same raw-ADP validation, the same freshness check, the
 * same provenance sidecar. No credentials are stored anywhere, nothing is
 * scraped, and no site's terms are strained by an automated session.
 *
 * `--primary-file` is parsed as the Best Ball Team Builder JSON shape;
 * `--fallback-file` as the 4for4 CSV export.
 */
const primaryFile = arg('primary-file', process.env.UNDERDOG_ADP_FILE ?? '');
const fallbackFile = arg('fallback-file', process.env.FOUR4_UNDERDOG_ADP_FILE ?? '');

/**
 * Extra request headers, as JSON: `{"cookie":"...","authorization":"Bearer ..."}`.
 *
 * Needed because a subscription source will not serve its ADP board to an
 * anonymous request, and the script previously sent nothing but a User-Agent —
 * so against 4for4 or a token-gated Underdog endpoint it could only ever have
 * returned HTTP 401/403.
 *
 * Supply it from a CI secret, never from the repository. Malformed JSON is a
 * hard error rather than a silently-ignored header: a fetch that quietly went
 * out unauthenticated would come back as "no rows" and look like a parsing
 * problem.
 */
function readHeaders(raw, label) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`::error::${label} is not valid JSON — expected an object of header names to values`);
    process.exit(2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`::error::${label} must be a JSON object of header names to values`);
    process.exit(2);
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

const primaryHeaders = readHeaders(process.env.UNDERDOG_ADP_HEADERS, 'UNDERDOG_ADP_HEADERS');
const fallbackHeaders = readHeaders(process.env.FOUR4_UNDERDOG_ADP_HEADERS, 'FOUR4_UNDERDOG_ADP_HEADERS');

/**
 * Report what each source returned and write nothing.
 *
 * The first thing to run against a candidate URL: it says whether the payload
 * parsed, whether it is raw ADP rather than a ranking, how fresh it is and how
 * many players it carries — which is the whole question when you are deciding
 * if a URL is the right one.
 */
const dryRun = flag('dry-run');

const fetchedAt = new Date().toISOString();

/**
 * One source, fetched and parsed into a snapshot — or a reason it is not one.
 *
 * Every failure is caught and reported rather than thrown: the whole point of
 * having two sources is that the first one failing is an ordinary Tuesday, and
 * a script that dies on it never reaches the fallback.
 */
async function load(provider, url, parse, { file = '', headers = {} } = {}) {
  if (!url && !file) return { provider, error: 'no URL or file configured' };
  try {
    /*
     * A local export wins over a URL when both are given.
     *
     * Deliberate: if somebody has gone to the trouble of exporting the board
     * by hand, that is the file they mean, and silently preferring a URL that
     * may be stale or unauthenticated would be the wrong way round.
     */
    let text;
    if (file) {
      text = readFileSync(file, 'utf8');
    } else {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
      if (!res.ok) {
        // 401/403 is almost always a missing or expired session rather than a
        // wrong URL, and saying so saves an hour of checking the URL.
        const hint =
          res.status === 401 || res.status === 403
            ? ' — the source needs authentication; set the matching *_HEADERS secret, or export the board and use --primary-file / --fallback-file'
            : '';
        return { provider, error: `HTTP ${res.status}${hint}` };
      }
      text = await res.text();
    }
    const parsed = parse(text);
    return {
      provider,
      snapshot: {
        provider,
        sourceType: 'raw_adp',
        fetchedAt,
        snapshotAt: parsed.snapshotAt ?? null,
        rows: parsed.rows,
      },
      // The headers, when the source has them, so a column literally named
      // "rank" is caught before the shape check has to infer it.
      headers: parsed.headers,
    };
  } catch (err) {
    return { provider, error: err instanceof Error ? err.message : String(err) };
  }
}

const attempts = [
  await load('best_ball_team_builder', primaryUrl, (text) => parseBestBallTeamBuilder(text), {
    file: primaryFile,
    headers: primaryHeaders,
  }),
  await load(
    '4for4',
    fallbackUrl,
    (text) => {
      const { rows, headers } = parseFour4Underdog(text);
      return { rows, snapshotAt: null, headers };
    },
    { file: fallbackFile, headers: fallbackHeaders },
  ),
];

for (const attempt of attempts) {
  const label = DOG_PROVIDER_LABELS[attempt.provider] ?? attempt.provider;
  if (attempt.error) console.log(`${label}: unavailable (${attempt.error})`);
  else console.log(`${label}: ${attempt.snapshot.rows.length} rows`);
}

const candidates = attempts
  .filter((a) => a.snapshot)
  .map((a) => ({ snapshot: a.snapshot, verdict: validateRawAdp(a.snapshot.rows, a.headers) }));

for (const candidate of candidates) {
  const label = DOG_PROVIDER_LABELS[candidate.snapshot.provider] ?? candidate.snapshot.provider;
  console.log(`${label}: ${candidate.verdict.valid ? 'raw ADP' : 'REJECTED'} — ${candidate.verdict.reason}`);
}

if (candidates.length === 0) {
  console.error('no Underdog source was reachable — keeping the existing snapshot');
  process.exit(1);
}

const { chosen, freshness, rejected } = chooseDogSource(candidates, new Date());

if (!chosen) {
  // Say which failure it was, because the workflow's response differs.
  const notRaw = candidates.some((c) => !c.verdict.valid);
  for (const reason of rejected) console.error(reason);
  if (notRaw) {
    console.error('a source served something that is not raw Underdog ADP — refusing to write a mislabelled snapshot');
    process.exit(2);
  }
  console.error('every Underdog source is too old to treat as the current market');
  process.exit(3);
}

const content = toAdpImportFile(chosen.rows);
const count = JSON.parse(content).length;

if (dryRun) {
  console.log(
    `\n--dry-run: would import ${count} players from ${DOG_PROVIDER_LABELS[chosen.provider]}` +
      ` (${freshness?.note}). Nothing written.`,
  );
  process.exit(0);
}

writeFileSync(out, content);

/*
 * Everything the app needs to judge this file later, written beside it.
 *
 * The import route stores these verbatim. `snapshotAt` is the one that earns
 * its place: without it, "fetched at 14:00" is the only timestamp there is, and
 * a board regenerated at 03:00 would look eleven hours fresher than it is.
 */
const meta = {
  source: 'underdog',
  provider: chosen.provider,
  sourceType: 'raw_adp',
  fetchedAt,
  snapshotAt: chosen.snapshotAt,
  label: `${DOG_PROVIDER_LABELS[chosen.provider]} Underdog ADP`,
  freshness: freshness?.state ?? 'unknown',
  rows: count,
};
writeFileSync(metaOut, JSON.stringify(meta, null, 2));

console.log(`chose ${DOG_PROVIDER_LABELS[chosen.provider]} — ${count} players, ${freshness?.note} -> ${out}`);
if (rejected.length > 0) console.log(`rejected: ${rejected.join(' | ')}`);
