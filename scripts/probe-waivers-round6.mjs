/**
 * Waivers round 6 (November 2026 review: W3, W4, W9, W10): the round's ONE
 * production check. Read-only, and Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. Alex's Waivers screen as the phone reads it (`/api/leagues/:id/waivers`,
 *      once): Do this, Worth considering and the Watch list with each row's
 *      reason, season gain, drop and bid; FAAB left and what a bid may spend
 *      (the $20 playoff reserve); whether any bid was capped by it; the
 *      season weeks and weights; the lowest drop scores; the claim card.
 *
 * "Before" is the round 5 probe's read of the same screen (3 November,
 * 11:52 PM ET, run 41775790805), printed alongside.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));

async function getJson(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`).catch((err) => ({ ok: false, status: String(err) }));
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ms: Date.now() - started, bytes: text.length, body };
}

/** Today's D1 rows, from Cloudflare's own analytics (free; no database read). */
function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'waivers round 6 probe'], {
    encoding: 'utf8',
    env: process.env,
  });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Started ${eastern()} ET`);
const before = rowsToday();
console.log(`D1 rows read today before: ${before ?? 'unknown'}`);

heading('Production SHA');
const health = await getJson('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);
const setup = await getJson('/api/setup/status');
const leagueId = process.env.LEAGUE_ID || setup.body?.league?.id;
console.log(`league: ${leagueId ? 'found' : '?'}`);
if (!leagueId) process.exit(0);

heading("Alex's Waivers screen, as the phone reads it (one request)");
const w = await getJson(`/api/leagues/${encodeURIComponent(leagueId)}/waivers`);
console.log(`HTTP ${w.status}, ${w.ms} ms, ${w.bytes} bytes`);
const t = w.body?.tiers ?? null;
if (t) {
  console.log(`near window: weeks ${t.window?.weeks?.join(', ')}; season: weeks ${t.season?.weeks?.join(', ') ?? 'none'} weighted ${t.season?.weights?.join(', ') ?? '-'}; bar scale ${t.season?.scale ?? '-'}`);
  console.log(`bars: Do this ${t.thresholds?.doThis}, Worth considering ${t.thresholds?.consider}, Watch ${t.thresholds?.watch}; valued ${t.valued}, unvalued ${t.unvalued}`);
  let faab = null;
  const row = (r) => {
    const tr = r.bid?.trace;
    if (tr && faab == null) faab = { remaining: tr.remaining, spendable: tr.spendable };
    const bid =
      r.bid?.kind === 'free'
        ? 'free agent'
        : r.bid?.kind === 'claim'
          ? r.bid.recommended == null
            ? 'waivers, no bid'
            : `bid $${r.bid.recommended} ($${r.bid.low}-${r.bid.high})${r.bid.reserve?.capped ? ' CAPPED by the $20 reserve' : ''}`
          : (r.bid?.kind ?? '?');
    const drop = r.needsSpot ? `needs a drop (${r.needsSpot.map((c) => c.name).join(', ') || 'none listed'})` : r.drop ? `${r.drop.viaReserve ? 'IR' : 'drop'} ${r.drop.name}` : 'open spot';
    return `${r.name} (${r.position}) [${r.reasonCode}] "${r.reason}"; season gain ${fmt(r.gain)}; by week ${JSON.stringify((r.byWeek ?? []).map((x) => x.change))}; ${drop}; ${bid}`;
  };
  for (const r of t.doThese ?? []) console.log(`DO THIS: ${row(r)}`);
  for (const r of t.consider ?? []) console.log(`CONSIDER: ${row(r)}`);
  for (const r of (t.watch ?? []).slice(0, 6)) console.log(`WATCH: ${row(r)}`);
  console.log(`FAAB left: ${faab?.remaining ?? '?'}; a bid may spend now: ${faab?.spendable ?? '?'}`);
  console.log(`drop-ready: ${(t.dropReady ?? []).map((d) => `${d.name} (${d.reason})`).join('; ') || 'none'}`);
  console.log(`lowest drop scores: ${(t.dropScores ?? []).slice(0, 6).map((d) => `${d.name} ${fmt(d.score)}${d.protectedAs ? ` [${d.protectedAs}]` : ''}`).join('; ')}`);
  const loveDropped = [...(t.doThese ?? []), ...(t.consider ?? []), ...(t.watch ?? [])].filter((r) => r.drop?.name === 'Jordan Love');
  console.log(`any row that drops Jordan Love: ${loveDropped.length === 0 ? 'none' : loveDropped.map((r) => r.name).join(', ')}`);
  heading('Top of the audit: season gains the tiers rank on');
  for (const a of (t.audit ?? []).slice(0, 8)) console.log(`${a.name} (${a.position}) gain ${fmt(a.gain)}; "${a.reason}"; drop ${a.drop ?? 'none'}`);
} else {
  console.log('no tiers in the response');
}
const claim = w.body?.claimPlan;
console.log(`claim card: ${claim?.surface ? claim.claims.map((c) => c.headline).join(' | ') : (claim?.headline ?? 'none')}`);
const ps = w.body?.pickupStart;
console.log(`pick up and start: ${ps?.start ? `${ps.start.name} +${fmt(ps.start.gain)}` : 'none'}`);

heading('CPU per Waivers request, last 24 hours (Cloudflare logs; no database read)');
/*
 * Round 6 values nine weeks instead of three, about 9 ms more planning per
 * request on a 60-player wire in tests. Cloudflare's own telemetry says what
 * each real Waivers request cost, before and after the deploy.
 */
await (async () => {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return console.log('no Cloudflare token: skipped');
  let account = process.env.ACCOUNT_ID;
  if (!account) {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    account = (await res?.json().catch(() => null))?.result?.[0]?.id;
  }
  if (!account) return console.log('account not found: skipped');
  const to = Date.now();
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      queryId: `waivers-cpu-${to}`,
      timeframe: { from: to - 24 * 3_600_000, to },
      view: 'events',
      limit: 50,
      parameters: {
        datasets: ['cloudflare-workers'],
        filters: [
          { key: '$metadata.service', operation: 'eq', type: 'string', value: process.env.SCRIPT_NAME ?? 'fantasy-analyst' },
          { key: '$workers.event.request.url', operation: 'includes', type: 'string', value: '/waivers' },
        ],
        filterCombination: 'and',
      },
    }),
  }).catch(() => null);
  const json = await res?.json().catch(() => null);
  const events = json?.result?.events?.events ?? [];
  if (!json?.success) return console.log(`telemetry query: HTTP ${res?.status ?? '?'} ${JSON.stringify(json?.errors ?? '').slice(0, 300)}`);
  const rows = events
    .map((e) => ({ at: Number(e.timestamp), cpu: e.$workers?.cpuTimeMs, wall: e.$workers?.wallTimeMs, outcome: e.$workers?.outcome, url: String(e.$workers?.event?.request?.url ?? '') }))
    .filter((r) => /\/api\/leagues\/[^/]+\/waivers(\?|$)/.test(r.url))
    .sort((a, b) => a.at - b.at);
  for (const r of rows) console.log(`${new Date(r.at).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true })} ET  ${r.outcome}  cpu=${r.cpu}ms  wall=${r.wall}ms`);
  if (rows.length === 0) console.log(`no Waivers requests in the telemetry (${events.length} events matched the url filter)`);
})();

heading('Before (round 5 probe, 3 November 11:52 PM ET, sha 1e6552e)');
console.log('DO THIS: Sam Darnold (QB) [big_upgrade] "Starts over Jordan Love, +6.6 pts in week 9"; gain 9.19; drop Jordan Love; bid $17 ($8-17)');
console.log('CONSIDER: Malik Willis (QB) [bye_depth] "Your QB Jordan Love is on bye in week 11"; gain 10.06; drop Makai Lemon; bid $6 ($3-25)');
console.log('drop-ready: Makai Lemon, Antonio Williams. Claim card: Add Sam Darnold, bid $17. No FAAB reserve (cap: all $56).');

const after = rowsToday();
console.log(`\nD1 rows read today after: ${after ?? 'unknown'}${before != null && after != null ? ` (+${after - before}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`Finished ${eastern()} ET`);
