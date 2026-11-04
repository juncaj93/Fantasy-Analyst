/**
 * Trades round 2 (November 2026 review, T1 and T9): the round's ONE combined
 * production check. Read-only, and Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. the search with its rejections, its season data and every rostered
 *      player's rest-of-season rate (`/api/diagnostics/smart-trades?cost=1`,
 *      once): what the rates were built from, Love against Young, the buy-low
 *      and sell-high reads, and the closest ideas with what blocks each;
 *   3. the trade ideas as the phone sees them (`/api/trades/smart`, once): who,
 *      what, to whom, Alex's value edge, both sides' season gains;
 *   4. Build a trade for all teams with unmarked players on (one request, with
 *      its own row count): packages checked per team, and its picks.
 *
 * The Probe workflow runs the D1 budget guard first and stands down past 50%.
 * Run after 7:05 PM ET. Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const pct = (share) => (share == null ? '?' : `${Math.round(share * 100)}%`);
const names = (list) => (list ?? []).map((p) => (typeof p === 'string' ? p : p.name)).join(' + ');
const signed = (v) => (v == null ? '?' : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`);

async function getJson(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`).catch((err) => ({ ok: false, status: String(err) }));
  const body = res.ok ? await res.json().catch(() => null) : null;
  return { status: res.status, ms: Date.now() - started, body };
}

/** Today's D1 rows, from Cloudflare's own analytics (free; no database read). */
function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'round 2 probe'], {
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

heading('The search on the season, with rejections and the season data (one request)');
const diag = await getJson(`/api/diagnostics/smart-trades?cost=1${leagueId ? `&leagueId=${encodeURIComponent(leagueId)}` : ''}`);
const d = diag.body ?? {};
console.log(`HTTP ${diag.status}, ${diag.ms} ms; rows returned ${d.cost?.rowsReturned ?? '?'} in ${d.cost?.statements ?? '?'} statements`);
console.log(`warnings: ${JSON.stringify(d.warnings ?? [])}`);
const s = d.season;
if (s) {
  console.log(
    `weeks ${s.weeks?.[0]}-${s.weeks?.[s.weeks.length - 1]} (${s.weightedWeeks} weighted); season points through week ${s.seasonPointsThrough ?? 'none'}; ` +
      `Sleeper's later weeks stored: ${(s.aheadWeeks ?? []).join(', ') || 'none'}`,
  );
  console.log(`rostered players: ${JSON.stringify(s.players)}`);
  console.log(`replacement: ${(s.replacement ?? []).map((r) => `${r.position} ${r.rate}`).join(', ')}`);
  const byName = new Map((s.rates ?? []).map((r) => [r.name, r]));
  for (const name of ['Jordan Love', 'Bryce Young', 'Patrick Mahomes', 'Trevor Lawrence']) {
    const r = byName.get(name);
    if (!r) continue;
    console.log(
      `  ${name.padEnd(16)} rate ${r.rate} (this week ${r.weekRate ?? '-'}; projection ${r.projection} over ${r.projectionWeeks} wk; ` +
        `season ${r.production} in ${r.games} games; ${r.basis}; plays ${r.weeksPlayed} wks)`,
    );
  }
  const love = byName.get('Jordan Love');
  const young = byName.get('Bryce Young');
  if (love && young) console.log(`Love vs Young: ${love.rate} vs ${young.rate} a game (${signed((love.rate ?? 0) - (young.rate ?? 0))} to Love)`);
} else {
  console.log('no season data: the search ran on this week');
}
const tally = {};
for (const r of d.rejections ?? []) tally[r.reason] = (tally[r.reason] ?? 0) + 1;
console.log(`search: ${JSON.stringify(d.search ?? {})}`);
console.log(`rejections: ${JSON.stringify(tally)}`);
const reads = d.arbitrageReads ?? [];
const nameOf = new Map((s?.rates ?? []).map((r) => [r.id, r.name]));
const buy = reads.filter((r) => r.kind === 'buy_low');
const sell = reads.filter((r) => r.kind === 'sell_high');
console.log(`buy-low / sell-high reads: ${reads.length} (buy low ${buy.length}, sell high ${sell.length})`);
for (const r of reads) {
  console.log(`  ${r.kind.padEnd(9)} ${String(nameOf.get(r.playerId) ?? r.playerId).padEnd(22)} ${r.observedPerGame} a game vs ${r.expectedPerGame} expected (${signed(r.residualPerGame)}), ${r.games} games`);
}
console.log('\nclosest ideas (each through Check a trade):');
for (const [i, c] of (d.closest ?? []).entries()) {
  console.log(
    `${i + 1}. to ${c.partner}: give ${names(c.give)}, get ${names(c.get)}; you ${signed(c.you)}, them ${signed(c.them)} ` +
      `(bars ${c.bars?.user} and ${c.bars?.partner}); Alex's edge ${c.edgePercent}%; ` +
      `${c.blockedBy == null ? 'FAIR' : `blocked: ${c.blockedBy}`}; search: ${c.searchReason}`,
  );
}

heading('Trade ideas, as the phone sees them (one request)');
const ideas = await getJson('/api/trades/smart?limit=5');
console.log(`HTTP ${ideas.status}, ${ideas.ms} ms, ${(ideas.body?.offers ?? []).length} ideas`);
console.log(`notes: ${JSON.stringify(ideas.body?.notes ?? [])}`);
for (const [i, o] of (ideas.body?.offers ?? []).entries()) {
  const c = o.seasonCheck ?? {};
  console.log(`${i + 1}. to ${o.partner?.displayName} (${o.managerFit?.activity}): give ${names(o.give)}, get ${names(o.get)}`);
  console.log(`   ${o.headline}; Alex's edge ${pct(c.edge)}; ${c.kind ?? c.status}${c.drop ? `; you drop ${c.drop}` : ''}; ${o.category}`);
  console.log(`   reason: ${o.reasons?.[0] ?? ''}`);
}

if (leagueId) {
  heading('Build a trade: all teams, unmarked players on (one request)');
  const build = await getJson(`/api/leagues/${encodeURIComponent(leagueId)}/trades/build?team=all&unmarked=1&cost=1`);
  const b = build.body ?? {};
  console.log(`HTTP ${build.status}, ${build.ms} ms, ${(b.packages ?? []).length} packages; status ${b.status}`);
  console.log(`message: ${b.message ?? ''}`);
  console.log(`audit: ${JSON.stringify(b.audit ?? {})}`);
  console.log(`rows returned: ${b.cost?.rowsReturned ?? '?'} in ${b.cost?.statements ?? '?'} statements`);
  for (const [i, p] of (b.packages ?? []).entries()) {
    const larger = Math.max(p.balance?.give ?? 0, p.balance?.get ?? 0);
    const edge = larger > 0 ? (p.balance.get - p.balance.give) / larger : 0;
    console.log(
      `${i + 1}. to ${p.partner?.label} (${p.partner?.activity?.line}): give ${names(p.give)}, get ${names(p.get)}; ${p.status}; ` +
        `Alex ${p.alex?.restOfSeason}, them ${p.them?.restOfSeason}; value ${p.balance?.give} vs ${p.balance?.get} (edge ${pct(edge)})` +
        `${(p.drops ?? []).length ? `; drop ${names(p.drops)}` : ''}`,
    );
  }
  for (const t of b.teams ?? []) {
    console.log(`  team ${t.label}: ${t.activity?.line}; needs ${JSON.stringify(t.needs)}; suggested ${JSON.stringify(t.suggested)}; ${t.packages?.length ?? 0} packages`);
  }
}

const after = rowsToday();
console.log(`\nD1 rows read today after: ${after ?? 'unknown'}${before != null && after != null ? ` (+${after - before}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`Finished ${eastern()} ET`);
