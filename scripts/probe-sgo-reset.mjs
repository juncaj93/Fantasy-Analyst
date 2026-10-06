/**
 * When does the odds provider's monthly count reset, and where can Alex see it?
 *
 * The app believes the provider's own `per-month` counter, and on 6 October 2026
 * that counter was still carrying September's spend (327 at a moment the ledger
 * had booked 47 for October). So "month" on the provider's side is not the
 * calendar month, and nobody has written down what it is. This looks in four
 * places, in order of how much each can be trusted:
 *
 *   1. the usage response itself, and its headers: every key, so a reset or
 *      billing-period field is found if it exists rather than guessed at;
 *   2. the provider's own documentation, fetched from here (the build
 *      environment cannot reach it) and searched for how the month is defined;
 *   3. the provider's site, for the address of its account or billing page;
 *   4. the ledger against the provider's readings: for every candidate reset
 *      day, how many calls the provider would have to have seen that the ledger
 *      did not. A reset day that makes that number small and steady across
 *      every reading is the likely one.
 *
 * Read-only. `/account/usage` was measured to bill nothing, and this reads it
 * before and after anything else it asks so that stays true. No odds are bought.
 *
 * Env: SPORTSGAMEODDS_API_KEY; CLOUDFLARE_API_TOKEN and ACCOUNT_ID for part 4.
 */

const BASE = 'https://api.sportsgameodds.com/v2';
const KEY = process.env.SPORTSGAMEODDS_API_KEY;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
let ACCOUNT = process.env.ACCOUNT_ID;
const CF = 'https://api.cloudflare.com/client/v4';

const WORDS = /reset|renew|cycle|period|billing|expire|until|start|end|anchor|since|window|next/i;

function walk(value, path, out) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, out);
  } else out.push([path, value]);
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* shown raw */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), json, text };
}
const monthly = (r) => Number(r?.json?.data?.rateLimits?.['per-month']?.['current-entities']);

console.log('=== 1. the usage response, every key ===');
if (!KEY) {
  console.log('  no SPORTSGAMEODDS_API_KEY in this run');
} else {
  const before = await api('/account/usage');
  console.log(`  GET /account/usage -> HTTP ${before.status}`);
  console.log('  headers:');
  for (const [k, v] of Object.entries(before.headers)) console.log(`    ${k}: ${String(v).slice(0, 120)}`);
  console.log('  body:');
  // The response names the account owner and the billing customer. Neither is
  // needed to answer the question, and a log is not the place for them.
  const shown = JSON.parse(JSON.stringify(before.json ?? null));
  for (const k of ['keyID', 'customerID', 'email']) if (shown?.data?.[k] != null) shown.data[k] = '(hidden)';
  console.log(JSON.stringify(shown, null, 2).split('\n').map((l) => `    ${l}`).join('\n').slice(0, 6000));
  const flat = [];
  walk(before.json, '', flat);
  const hits = flat.filter(([p]) => WORDS.test(p.split('.').pop() ?? ''));
  console.log(`\n  keys that look like a date, period or reset: ${hits.length === 0 ? 'NONE' : ''}`);
  for (const [p, v] of hits) console.log(`    ${p} = ${JSON.stringify(v)}`);
  const dateLike = flat.filter(([, v]) => typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v));
  console.log(`  values that look like a date: ${dateLike.length === 0 ? 'NONE' : ''}`);
  for (const [p, v] of dateLike) console.log(`    ${p} = ${v}`);
  const resetHeaders = Object.keys(before.headers).filter((h) => /reset|limit|remaining|retry|period/i.test(h));
  console.log(`  rate-limit style headers: ${resetHeaders.length === 0 ? 'NONE' : resetHeaders.join(', ')}`);

  console.log('\n  other account endpoints (each checked for cost):');
  for (const path of ['/account', '/account/limits', '/usage', '/account/billing', '/account/subscription']) {
    const r = await api(path);
    const keys = r.json && typeof r.json === 'object' ? Object.keys(r.json.data ?? r.json).slice(0, 12).join(', ') : '';
    console.log(`    ${path.padEnd(24)} HTTP ${r.status}  ${keys || String(r.text).slice(0, 90).replace(/\s+/g, ' ')}`);
    if (r.json) {
      const f = [];
      walk(r.json, '', f);
      for (const [p, v] of f.filter(([p2, v2]) => WORDS.test(p2.split('.').pop() ?? '') || (typeof v2 === 'string' && /\d{4}-\d{2}-\d{2}/.test(v2)))) {
        console.log(`      ${p} = ${JSON.stringify(v)}`);
      }
    }
  }
  const after = await api('/account/usage');
  console.log(`\n  per-month current-entities before=${monthly(before)} after=${monthly(after)}  -> asking cost ${monthly(after) - monthly(before)}`);
  console.log(`  per-month window as reported: ${JSON.stringify(after.json?.data?.rateLimits?.['per-month'])}`);
}

console.log('\n=== 2. the provider\'s own documentation ===');
const pages = [
  'https://sportsgameodds.com/docs/info/rate-limiting.mdx',
  'https://sportsgameodds.com/docs/info/best-practices.mdx',
  'https://sportsgameodds.com/pricing/',
];
for (const url of pages) {
  try {
    const res = await fetch(url, { headers: { accept: 'text/markdown,text/html,*/*' } });
    const text = await res.text();
    console.log(`  ${url} -> HTTP ${res.status}, ${text.length} chars`);
    const lines = text.split('\n');
    let shown = 0;
    for (let i = 0; i < lines.length && shown < 30; i++) {
      if (/reset|billing|billed|cycle|renew|calendar|rolling|per month|monthly|dashboard|account|usage/i.test(lines[i])) {
        console.log(`    ${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        shown++;
      }
    }
  } catch (err) {
    console.log(`  ${url} -> ${err.message}`);
  }
}

console.log('\n=== 3. where the account page is ===');
for (const url of ['https://sportsgameodds.com/', 'https://sportsgameodds.com/docs/info/rate-limiting']) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const html = await res.text();
    const links = [...new Set([...html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))].filter((h) =>
      /dashboard|account|login|log-in|sign|billing|portal|app\./i.test(h),
    );
    console.log(`  ${url} -> HTTP ${res.status}, final ${res.url}`);
    for (const l of links.slice(0, 20)) console.log(`    ${l}`);
    if (links.length === 0) console.log('    no account-like links found');
  } catch (err) {
    console.log(`  ${url} -> ${err.message}`);
  }
}
for (const url of ['https://sportsgameodds.com/dashboard', 'https://dashboard.sportsgameodds.com/', 'https://sportsgameodds.com/account', 'https://sportsgameodds.com/login']) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    console.log(`  candidate ${url} -> HTTP ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`);
  } catch (err) {
    console.log(`  candidate ${url} -> ${err.message}`);
  }
}

console.log('\n=== 4. the ledger against the provider\'s readings ===');
if (!TOKEN) {
  console.log('  no Cloudflare token in this run');
  process.exit(0);
}
async function call(path, init = {}) {
  const res = await fetch(`${CF}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  return res.json().catch(() => null);
}
if (!ACCOUNT) ACCOUNT = (await call('/accounts'))?.result?.[0]?.id;
const dbs = await call(`/accounts/${ACCOUNT}/d1/database?name=fantasy_analyst`);
const DB = dbs?.result?.find((d) => d.name === 'fantasy_analyst')?.uuid;
async function select(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error(`refusing a non-SELECT: ${sql}`);
  const r = await call(`/accounts/${ACCOUNT}/d1/database/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
  if (!r?.success) throw new Error(JSON.stringify(r?.errors ?? r).slice(0, 300));
  return r.result?.[0]?.results ?? [];
}

const months = await select('SELECT month, entities, provider_entities, provider_limit, provider_read_at FROM vegas_usage ORDER BY month');
console.log('  the provider\'s readings the app kept (one per month, the latest):');
for (const m of months) console.log(`    ${m.month}: reading ${m.provider_entities} at ${m.provider_read_at}   (ledger booked ${m.entities} in the month)`);

const log = await select("SELECT at, source, outcome, entities, reason FROM vegas_usage_log WHERE at >= '2026-07-01' ORDER BY at, id");
// A refusal booked as spent (before 24 September's fix) was never billed.
const billed = log.filter((r) => ['fetched', 'failed'].includes(r.outcome) && !/rate limited/i.test(String(r.reason ?? '')));
const refused = log.filter((r) => ['fetched', 'failed'].includes(r.outcome) && /rate limited/i.test(String(r.reason ?? '')));
console.log(`  ledger rows: ${log.length}; billed ${billed.reduce((s, r) => s + Number(r.entities), 0)} entities in ${billed.length} rows; ${refused.length} refusals booked as spent (${refused.reduce((s, r) => s + Number(r.entities), 0)} entities, not billed)`);
console.log(`  first ledger row: ${log[0]?.at}`);
const byDay = new Map();
for (const r of billed) byDay.set(r.at.slice(0, 10), (byDay.get(r.at.slice(0, 10)) ?? 0) + Number(r.entities));
console.log('  billed entities by UTC day:');
console.log('    ' + [...byDay.entries()].map(([d, n]) => `${d.slice(5)}:${n}`).join('  '));

const live = KEY ? monthly(await api('/account/usage')) : NaN;
const points = months
  .filter((m) => m.provider_read_at && m.provider_entities != null)
  .map((m) => ({ label: `${m.provider_read_at.slice(0, 16)}Z`, at: Date.parse(m.provider_read_at), reading: Number(m.provider_entities) }));
if (Number.isFinite(live)) points.push({ label: 'now (live)', at: Date.now(), reading: live });
points.sort((a, b) => a.at - b.at);

const sumBetween = (from, to) => billed.filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) <= to).reduce((s, r) => s + Number(r.entities), 0);

console.log('\n  If the counter reset at 00:00 UTC on day R, each reading taken after R should equal the');
console.log('  ledger\'s billed entities since R plus calls the ledger never saw (probes). The right R');
console.log('  makes that last number small, never negative, and steady from one reading to the next.');
console.log('  Readings: ' + points.map((p) => `${p.label}=${p.reading}`).join('  '));
console.log('\n  R (UTC)      ' + points.map((p) => p.label.slice(5, 16).padEnd(14)).join(' ') + '  verdict');
const start = Date.parse('2026-08-20T00:00:00Z');
for (let t = start; t <= Date.parse('2026-10-06T00:00:00Z'); t += 86_400_000) {
  const cells = [];
  const unseen = [];
  for (const p of points) {
    if (p.at < t) {
      cells.push('(before R)'.padEnd(14));
      continue;
    }
    const u = p.reading - sumBetween(t, p.at);
    unseen.push(u);
    cells.push(String(u).padEnd(14));
  }
  let verdict = '';
  if (unseen.length >= 2) {
    const neg = unseen.some((u) => u < -12);
    const spread = Math.max(...unseen) - Math.min(...unseen);
    verdict = neg ? 'impossible (ledger exceeds provider)' : spread <= 20 ? `PLAUSIBLE (spread ${spread})` : `no (spread ${spread})`;
  }
  console.log(`  ${new Date(t).toISOString().slice(0, 10)}   ${cells.join(' ')}  ${verdict}`);
}

console.log('\n  The other hypothesis, a rolling 30 days: unseen = reading - billed in the 30 days before the reading');
for (const p of points) {
  const u = p.reading - sumBetween(p.at - 30 * 86_400_000, p.at);
  console.log(`    ${p.label}: reading ${p.reading}, ledger in the last 30 days ${sumBetween(p.at - 30 * 86_400_000, p.at)}, unseen ${u}`);
}
console.log('\n  And the calendar month, which is what the app assumes: unseen = reading - billed since the 1st');
for (const p of points) {
  const first = Date.parse(new Date(p.at).toISOString().slice(0, 7) + '-01T00:00:00Z');
  console.log(`    ${p.label}: reading ${p.reading}, ledger since the 1st ${sumBetween(first, p.at)}, unseen ${p.reading - sumBetween(first, p.at)}`);
}
