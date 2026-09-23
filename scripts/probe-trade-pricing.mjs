#!/usr/bin/env node
/**
 * Which players is the trade engine valuing with no market underneath them?
 *
 * The Smart Trades search ranks players on their start/sit score. When the
 * betting market has not priced a player, that score is not a low valuation —
 * it is the news, usage and availability nudges with no base at all, and the
 * engine has been ranking those nudges against real market numbers.
 *
 * This asks production, read-only:
 *
 *   1. the live board and its rejections, as a phone would see them;
 *   2. a Trades support snapshot — the exact inputs `assembleSmartTrades` was
 *      handed — which is then replayed through *this checkout's* engine by
 *      `lib/tradePricingReplay.ts`, so the same live data can be read before
 *      and after a change to `core/trades/`.
 *
 *   node scripts/probe-trade-pricing.mjs
 *   URL=http://127.0.0.1:8788 node scripts/probe-trade-pricing.mjs
 *
 * Every request is a GET. Nothing is written anywhere.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const LEAGUE_ID = (process.env.LEAGUE_ID ?? '').trim();

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: text.slice(0, 200) } };
  }
}

function fmt(v) {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

const health = await get('/api/health');
console.log(`\n=== trade pricing @ ${URL_BASE} (sha ${health.body?.gitSha ?? '?'}) ===\n`);

const setup = await get('/api/setup/status');
const leagueId = LEAGUE_ID || setup.body?.league?.id;
if (!leagueId) {
  console.log('no league selected; nothing to report');
  process.exit(0);
}
console.log(`league: ${setup.body?.league?.name ?? leagueId}`);

// ---------------------------------------------------------- 1. the live board
const smart = await get(`/api/trades/smart?limit=8&leagueId=${encodeURIComponent(leagueId)}`);
console.log(`\n--- live /api/trades/smart (HTTP ${smart.status}) ---`);
for (const offer of smart.body?.offers ?? []) {
  const side = (ps) => (ps ?? []).map((p) => `${p.name} (${p.position} ${fmt(p.value)})`).join(' + ');
  console.log(`  [${offer.category}] GIVE ${side(offer.give)}  →  GET ${side(offer.get)}  @ ${offer.partner?.displayName}`);
}
for (const note of smart.body?.notes ?? []) console.log(`  note: ${note}`);
for (const w of smart.body?.warnings ?? []) console.log(`  warning: ${w}`);
if (smart.body?.pricing) console.log(`  pricing: ${JSON.stringify(smart.body.pricing)}`);

const explain = await get(`/api/diagnostics/smart-trades?leagueId=${encodeURIComponent(leagueId)}`);
const rejections = explain.body?.rejections ?? [];
const byReason = new Map();
for (const r of rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
console.log(`\n--- live rejections (${rejections.length}) ---`);
for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
const gaps = rejections.filter((r) => r.reason === 'value_gap_outside_range').slice(0, 6);
for (const r of gaps) console.log(`        e.g. ${r.detail}`);

// ------------------------------------------------ 2. the snapshot, replayed
const snap = await get(`/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=trade-offer`);
if (snap.status !== 200) {
  console.log(`\nsupport snapshot answered HTTP ${snap.status}: ${JSON.stringify(snap.body).slice(0, 300)}`);
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'trade-pricing-'));
const file = join(dir, 'snapshot.json');
writeFileSync(file, JSON.stringify(snap.body));

const here = dirname(fileURLToPath(import.meta.url));
const run = spawnSync(
  process.execPath,
  ['--experimental-transform-types', '--no-warnings', join(here, 'lib', 'tradePricingReplay.ts'), file],
  { stdio: 'inherit' },
);
process.exit(run.status ?? 1);
