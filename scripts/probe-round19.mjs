/**
 * Round 19 (trades rebuild): the round's ONE production check. Read-only, and
 * Sleeper is never called. Run after 7:05 PM ET (D1 resets at 7:00 PM ET).
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. why nothing passed before: the older idea search, still served by
 *      `/api/diagnostics/smart-trades`, with every rejection counted by
 *      reason and what the season rule then left off;
 *   3. the trade finder on Alex's real league (`/api/diagnostics/trade-finder`):
 *      what each step removed, the offers it shows, the deals it checked;
 *   4. Check a trade's one line on the top offer;
 *   5. the Trades preview loads, with its switches, on the made-up league
 *      (no database read there).
 *
 * Every request carries `cost=1`, so the rows each one read are printed.
 * Times in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const heading = (t) => console.log(`\n## ${t}`);
const signed = (n) => (n == null ? '?' : `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`);

function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 19 probe'], { encoding: 'utf8', env: process.env });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - started };
}

console.log(`Round 19 probe, started ${eastern()} ET`);
const rowsBefore = rowsToday();
console.log(`D1 rows read today before: ${rowsBefore ?? 'unknown'}`);
let probeRows = 0;

heading('Production revision');
const health = await get('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);
const leagues = await get('/api/leagues');
const leagueId = process.env.LEAGUE_ID || (leagues.body?.leagues ?? []).find((l) => l.isSelected)?.id || '';
if (!leagueId) {
  console.log('no selected league; stopping');
  process.exit(0);
}
const q = `leagueId=${encodeURIComponent(leagueId)}&cost=1`;

heading('Why nothing passed before: the older idea search, on today’s data');
const old = await get(`/api/diagnostics/smart-trades?${q}`);
probeRows += old.body?.cost?.rowsReturned ?? 0;
if (old.status !== 200 || !old.body) {
  console.log(`  HTTP ${old.status}`);
} else {
  const b = old.body;
  console.log(`  partners ${b.search?.partners}, candidates generated ${b.search?.generated}, scored ${b.search?.scored}, passed the search ${b.search?.viable}, on the board ${b.offers?.length ?? 0} (+${b.reserve?.length ?? 0} held behind)`);
  const byReason = {};
  for (const r of b.rejections ?? []) {
    const n = r.reason === 'pruned_by_bound' ? Number(/(\d+)/.exec(r.detail ?? '')?.[1] ?? 1) : 1;
    byReason[r.reason] = (byReason[r.reason] ?? 0) + n;
  }
  for (const [reason, n] of Object.entries(byReason).sort((x, y) => y[1] - x[1])) console.log(`  removed by ${reason}: ${n}`);
  if (b.seasonRule) console.log(`  season rule: checked ${b.seasonRule.checked}, kept ${b.seasonRule.kept}, left off ${JSON.stringify(b.seasonRule.leftOff)}`);
  console.log(`  notes: ${(b.notes ?? []).join(' | ') || '(none)'}`);
  for (const c of b.closest ?? []) console.log(`  closest: ${c.partner}: give ${c.give.join(' + ')} get ${c.get.join(' + ')}; you ${signed(c.you)} them ${signed(c.them)} edge ${c.edgePercent ?? '?'}%; blocked by ${c.blockedBy ?? 'nothing'} (${c.searchReason})`);
  console.log(`  rows read: ${b.cost?.rowsReturned ?? '?'} in ${b.cost?.statements ?? '?'} statements, ${old.ms} ms`);
}

heading('The trade finder on Alex’s real league');
const found = await get(`/api/diagnostics/trade-finder?${q}`);
probeRows += found.body?.cost?.rowsReturned ?? 0;
let top = null;
if (found.status !== 200 || !found.body) {
  console.log(`  HTTP ${found.status}`);
} else {
  const f = found.body;
  console.log(`  week ${f.week}; status ${f.status}; ${f.note ?? ''}`);
  const fun = f.funnel ?? {};
  console.log(`  partners ${fun.partners} (+${fun.skippedPartners} who almost never trade); deals generated ${fun.generated}; checked exactly ${fun.checked}; fair ${fun.fair}; close ${fun.close}`);
  for (const [step, n] of Object.entries(fun.removed ?? {}).sort((x, y) => y[1] - x[1])) console.log(`  ${step}: ${n}`);
  console.log(`  not fair, by the rule each broke: ${JSON.stringify(fun.unfair ?? {})}`);
  for (const o of f.offers ?? []) {
    console.log(
      `  [${o.label}] ${o.partner.label} (${o.partner.activity ?? 'no record'}): give ${o.give.map((p) => p.name).join(' + ')}, get ${o.get.map((p) => p.name).join(' + ')}; ` +
        `edge ${o.edgePercent}%; you this week ${signed(o.you.thisWeek)}, rest of season ${signed(o.you.restOfSeason)}, playoffs ${signed(o.you.playoffs)}; them ${signed(o.them.restOfSeason)}; ${o.reason}${o.drop ? ` (cut ${o.drop})` : ''}`,
    );
  }
  for (const d of (f.checkedDeals ?? []).slice(0, 8)) console.log(`  checked: ${d.id} you ${signed(d.you)} them ${signed(d.them)} edge ${d.edgePercent}% ${d.verdict} ${d.unfair ?? 'fair'}`);
  console.log(`  rows read: ${f.cost?.rowsReturned ?? '?'} in ${f.cost?.statements ?? '?'} statements; worker ${f.ms} ms; request ${found.ms} ms`);
  top = (f.offers ?? [])[0] ?? null;
}

heading('Check a trade on the top offer');
if (!top) {
  console.log('  no offer to check');
} else {
  const mine = (await get(`/api/leagues/${encodeURIComponent(leagueId)}/trades/check/teams`)).body?.teams?.find((t) => t.isMine);
  if (!mine) {
    console.log('  your roster was not found');
  } else {
    const path =
      `/api/leagues/${encodeURIComponent(leagueId)}/trades/check?a=${mine.rosterId}&b=${top.partner.rosterId}` +
      `&give=${top.give.map((p) => p.playerId).join(',')}&get=${top.get.map((p) => p.playerId).join(',')}&cost=1`;
    const check = await get(path);
    probeRows += check.body?.cost?.rowsReturned ?? 0;
    const s = check.body?.summary;
    if (!s) console.log(`  HTTP ${check.status}; no summary (${check.body?.evaluation?.insufficientReason ?? check.body?.reason ?? '?'})`);
    else
      console.log(
        `  ${s.word}. ${s.reason} You: this week ${signed(s.you.thisWeek)}, rest of season ${signed(s.you.restOfSeason)}. Them: ${signed(s.them.restOfSeason)}. Edge ${s.edgePercent}%. ` +
          `You get better at ${s.positions.you.better.join(', ') || 'nothing'}${s.positions.you.thinner.length ? `, thinner at ${s.positions.you.thinner.join(', ')}` : ''}; ` +
          `they get better at ${s.positions.them.better.join(', ') || 'nothing'}. Rows read: ${check.body?.cost?.rowsReturned ?? '?'}`,
      );
  }
}

heading('The Trades preview (made-up league, reads no database)');
{
  const PREVIEW = process.env.PREVIEW_URL || 'https://ef6f57d0-fantasy-analyst.juncaj93.workers.dev';
  const page = await fetch(`${PREVIEW}/`).catch(() => null);
  const html = page ? await page.text() : '';
  console.log(`  ${PREVIEW}: page HTTP ${page?.status ?? 'unreachable'}, ${/<div id="root"/.test(html) ? 'app shell served' : 'no app shell'}`);
  const status = await fetch(`${PREVIEW}/api/auth/status`).then((r) => r.json()).catch(() => null);
  console.log(`  switches: ${JSON.stringify(status?.features ?? null)}`);
  for (const week of ['', '?week=quiet']) {
    const body = await fetch(`${PREVIEW}/api/trades/screens/offers${week}`).then((r) => r.json()).catch(() => null);
    console.log(`  offers${week || ' (normal week)'}: ${body?.league?.name ?? '?'}, status ${body?.status ?? '?'}, ${(body?.offers ?? []).map((o) => `[${o.label}] ${o.partner.label} edge ${o.edgePercent}%`).join('; ') || 'none'}`);
  }
}

heading('Cost');
const rowsAfter = rowsToday();
console.log(`rows read by this probe's requests (metered): ${probeRows}`);
console.log(`D1 rows read today after: ${rowsAfter ?? 'unknown'}${rowsBefore != null && rowsAfter != null ? ` (+${rowsAfter - rowsBefore}, Cloudflare's count, which lags a few minutes)` : ''}`);
console.log(`finished ${eastern()} ET`);
