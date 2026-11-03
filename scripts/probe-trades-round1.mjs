/**
 * Trades round 1 (November 2026 review): the round's ONE combined production
 * check. Read-only, and Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`);
 *   2. the trade ideas as the phone sees them (`/api/trades/smart`, once): who
 *      each idea goes to, Alex's value edge, both sides' season gain, the drop;
 *   3. the same search with its rejections and the buy-low / sell-high reads
 *      (`/api/diagnostics/smart-trades`, once): how many reads, which way, and
 *      each one's production against its preseason number;
 *   4. Build a trade for all teams with unmarked players on (one request, with
 *      its own row count): who the packages go to and how fair each one is.
 *
 * The Probe workflow runs the D1 budget guard first and stands down past 50%.
 * Times printed in Eastern.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const pct = (share) => (share == null ? '?' : `${Math.round(share * 100)}%`);
const names = (list) => (list ?? []).map((p) => p.name).join(' + ');

async function getJson(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`).catch((err) => ({ ok: false, status: String(err) }));
  const body = res.ok ? await res.json().catch(() => null) : null;
  return { status: res.status, ms: Date.now() - started, body };
}

console.log(`Started ${eastern()} ET`);

heading('Production SHA');
const health = await getJson('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);

const setup = await getJson('/api/setup/status');
const leagueId = process.env.LEAGUE_ID || setup.body?.league?.id;
console.log(`league: ${leagueId ?? '?'}`);

heading('Trade ideas, as the phone sees them (one request)');
const ideas = await getJson('/api/trades/smart?limit=5');
console.log(`HTTP ${ideas.status}, ${ideas.ms} ms, ${(ideas.body?.offers ?? []).length} ideas`);
console.log(`notes: ${JSON.stringify(ideas.body?.notes ?? [])}`);
for (const [i, o] of (ideas.body?.offers ?? []).entries()) {
  const s = o.seasonCheck ?? {};
  console.log(
    `${i + 1}. to ${o.partner?.displayName} (${o.managerFit?.activity}, ${o.managerFit?.evidence?.sample ?? 0} trades): ` +
      `give ${names(o.give)}, get ${names(o.get)}`,
  );
  console.log(
    `   this week: ${o.headline}; week value edge ${pct(o.fairness?.gap)} (${o.fairness?.label}); ` +
      `season: you ${s.you ?? '?'}, them ${s.them ?? '?'}, value edge ${pct(s.edge)}, ${s.kind ?? s.status}` +
      `${s.drop ? `; you drop ${s.drop}` : ''}`,
  );
  console.log(`   reason: ${o.reasons?.[0] ?? ''}`);
}

heading('The same search, with rejections and the buy-low reads (one request)');
const diag = await getJson(`/api/diagnostics/smart-trades${leagueId ? `?leagueId=${encodeURIComponent(leagueId)}` : ''}`);
console.log(`HTTP ${diag.status}, ${diag.ms} ms, ${(diag.body?.offers ?? []).length} ideas before the season check`);
const tally = {};
for (const r of diag.body?.rejections ?? []) tally[r.reason] = (tally[r.reason] ?? 0) + 1;
console.log(`rejections: ${JSON.stringify(tally)}`);
for (const r of (diag.body?.rejections ?? []).filter((x) => x.reason === 'rare_trader')) console.log(`  ${r.detail}`);
const reads = diag.body?.arbitrageReads ?? [];
const buy = reads.filter((r) => r.kind === 'buy_low');
const sell = reads.filter((r) => r.kind === 'sell_high');
console.log(`buy-low / sell-high reads: ${reads.length} (buy low ${buy.length}, sell high ${sell.length})`);
console.log(`buy-low reads truly under their preseason number by 1.5+ a game: ${buy.filter((r) => r.residualPerGame <= -1.5).length} of ${buy.length}`);
for (const r of reads) {
  console.log(
    `  ${r.kind.padEnd(9)} ${String(r.playerId).padEnd(8)} produced ${r.observedPerGame} a game vs ${r.expectedPerGame} expected ` +
      `(${r.residualPerGame > 0 ? '+' : ''}${r.residualPerGame}), ${r.games} games, strength ${r.strength}`,
  );
}

if (leagueId) {
  heading('Build a trade: all teams, unmarked players on (one request)');
  const build = await getJson(`/api/leagues/${encodeURIComponent(leagueId)}/trades/build?team=all&unmarked=1&cost=1`);
  console.log(`HTTP ${build.status}, ${build.ms} ms, ${(build.body?.packages ?? []).length} packages; status ${build.body?.status}`);
  console.log(`message: ${build.body?.message ?? ''}`);
  console.log(`audit: ${JSON.stringify(build.body?.audit ?? {})}`);
  console.log(`rows returned: ${build.body?.cost?.rowsReturned ?? '?'} in ${build.body?.cost?.statements ?? '?'} statements`);
  for (const [i, p] of (build.body?.packages ?? []).entries()) {
    const larger = Math.max(p.balance?.give ?? 0, p.balance?.get ?? 0);
    const edge = larger > 0 ? ((p.balance.get - p.balance.give) / larger) : 0;
    console.log(
      `${i + 1}. to ${p.partner?.label} (${p.partner?.activity?.line}): give ${names(p.give)}, get ${names(p.get)}; ` +
        `${p.status}; Alex ${p.alex?.restOfSeason} season, them ${p.them?.restOfSeason}; value ${p.balance?.give} vs ${p.balance?.get} (edge ${pct(edge)})` +
        `${(p.drops ?? []).length ? `; drop ${names(p.drops)}` : ''}`,
    );
  }
  for (const t of build.body?.teams ?? []) {
    console.log(`  team ${t.label}: ${t.activity?.line}; needs ${JSON.stringify(t.needs)}; ${t.packages?.length ?? 0} packages`);
  }
}

console.log(`\nFinished ${eastern()} ET`);
