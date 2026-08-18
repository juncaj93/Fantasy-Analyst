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

import { writeFileSync } from 'node:fs';
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

const out = arg('out', 'dog.json');
const metaOut = arg('meta', 'dog.meta.json');
const primaryUrl = arg('primary', process.env.UNDERDOG_ADP_URL ?? '');
const fallbackUrl = arg('fallback', process.env.FOUR4_UNDERDOG_ADP_URL ?? '');

const fetchedAt = new Date().toISOString();

/**
 * One source, fetched and parsed into a snapshot — or a reason it is not one.
 *
 * Every failure is caught and reported rather than thrown: the whole point of
 * having two sources is that the first one failing is an ordinary Tuesday, and
 * a script that dies on it never reaches the fallback.
 */
async function load(provider, url, parse) {
  if (!url) return { provider, error: 'no URL configured' };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) return { provider, error: `HTTP ${res.status}` };
    const text = await res.text();
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
  await load('best_ball_team_builder', primaryUrl, (text) => parseBestBallTeamBuilder(text)),
  await load('4for4', fallbackUrl, (text) => {
    const { rows, headers } = parseFour4Underdog(text);
    return { rows, snapshotAt: null, headers };
  }),
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
