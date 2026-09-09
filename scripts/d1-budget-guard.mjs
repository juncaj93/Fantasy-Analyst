/**
 * Should an expensive job be allowed to touch production today?
 *
 * On 8 September the daily row allowance was spent by three runs of the
 * production browser suite — two dispatched by hand and one scheduled — which
 * between them read about 5.06 million of the day's 5.33 million rows. None of
 * the three knew what the others had already spent, because nothing in the
 * system could say. The app then answered every request with an error from
 * 12:30 UTC until midnight.
 *
 * This is the thing that could have said. It reads today's usage from
 * Cloudflare's analytics before the suite starts and reports whether there is
 * room, so a run that would exhaust the allowance declines instead of finishing
 * the job.
 *
 * ## Fail closed, deliberately
 *
 * A full production sweep is never urgent. If usage cannot be determined —
 * no token, an unreachable API, a payload whose shape changed — this exits
 * non-zero rather than shrugging and proceeding, because the cost of a
 * needlessly skipped sweep is one missed screenshot crawl and the cost of a
 * wrong "proceed" is the app being down for the rest of the day.
 *
 * The one thing it will not do is guess. Field names are found, as in
 * `probe-d1-usage-hours.mjs` and for the same reason: a rows-read field that
 * has been renamed must read as "cannot determine", never as zero.
 *
 * Usage:
 *   ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/d1-budget-guard.mjs [--ceiling 50]
 *
 * Writes `proceed=yes|no`, `percent` and `rows` to $GITHUB_OUTPUT when set.
 */

import { appendFileSync } from 'node:fs';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const DAILY_ROWS = 5_000_000;

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const ceiling = Number(argOf('--ceiling', process.env.CEILING_PERCENT ?? '50'));

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;

function emit(fields) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  appendFileSync(out, Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

function refuse(why) {
  emit({ proceed: 'no', percent: '', rows: '' });
  console.error(`Cannot determine today's D1 usage, so the run is declined: ${why}`);
  console.error('A full production sweep is never urgent; a wrong "proceed" costs the rest of the day.');
  process.exit(1);
}

if (!TOKEN) refuse('CLOUDFLARE_API_TOKEN is not set.');
if (!ACCOUNT) refuse('ACCOUNT_ID is not set.');

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}; body was not JSON: ${text.slice(0, 300)}`);
  }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  return body.data;
}

const today = new Date().toISOString().slice(0, 10);

let data;
try {
  data = await graphql(
    `query Budget($account: String!, $day: Date!) {
       viewer {
         accounts(filter: { accountTag: $account }) {
           d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $day }) {
             sum { rowsRead }
           }
         }
       }
     }`,
    { account: ACCOUNT, day: today },
  );
} catch (err) {
  refuse(err instanceof Error ? err.message : String(err));
}

const groups = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
if (!Array.isArray(groups)) refuse('the response carried no d1AnalyticsAdaptiveGroups block.');

/*
 * Nothing recorded yet is a real state, not a missing one.
 *
 * Analytics lag the database by a few minutes, so an empty list early in the
 * UTC day means "no rows read yet", which is the most permissive answer there
 * is and the correct one. That is different from a *present* group with no
 * recognisable metric on it, which is the renamed-field case and is refused.
 */
let rows = 0;
for (const group of groups) {
  const sum = group?.sum;
  if (!sum || typeof sum !== 'object') continue;
  const key = Object.keys(sum).find((k) => /^rows?_?read/i.test(k));
  if (!key) refuse(`no rows-read field on the response. Fields returned: ${Object.keys(sum).join(', ') || 'none'}.`);
  rows += Number(sum[key] ?? 0);
}

const percent = Math.round((1000 * rows) / DAILY_ROWS) / 10;
const proceed = percent < ceiling;

console.log(`${rows.toLocaleString('en-GB')} of ${DAILY_ROWS.toLocaleString('en-GB')} rows read today (${percent}%).`);
console.log(`Ceiling for an expensive run is ${ceiling}%. ${proceed ? 'Proceeding.' : 'Declining.'}`);
emit({ proceed: proceed ? 'yes' : 'no', percent: String(percent), rows: String(rows) });

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(
    summary,
    `### D1 budget\n\n${rows.toLocaleString('en-GB')} rows read today, **${percent}%** of the daily allowance.\n\n` +
      (proceed
        ? `Under the ${ceiling}% ceiling, so the full production sweep ran.\n`
        : `Over the ${ceiling}% ceiling, so the full production sweep was **skipped**. ` +
          `It is a screenshot crawl and a content check; the deploy gate is unaffected and still runs on every release.\n`),
  );
}
