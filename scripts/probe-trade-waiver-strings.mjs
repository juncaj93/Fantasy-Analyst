/**
 * The two sentences the first probe printed the *key* of but not the value.
 *
 * `/api/trades/smart` carried an `arbitrageOff` field, which is only added when
 * it is a non-empty string — so the buy-low / sell-high lane is switched off in
 * production and the reason is a sentence the service already wrote. Same for
 * the waiver board's FAAB rule and the reason nothing on the wire could be
 * scored. This prints them verbatim rather than paraphrasing them.
 *
 * Reads only, GET only, no passphrase.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) return { __error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: `not json: ${text.slice(0, 200)}` };
  }
}

const leagues = await get('/api/leagues');
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0];
console.log(`league: ${league.name} (${league.id})`);

console.log('\n=== 4. why buy-low / sell-high is empty, in the service\'s own words ===');
const smart = await get(`/api/trades/smart?limit=8&leagueId=${encodeURIComponent(league.id)}`);
console.log('  arbitrageOff:', JSON.stringify(smart.arbitrageOff));
console.log('  warnings:   ', JSON.stringify(smart.warnings ?? []));
console.log('  notes:      ', JSON.stringify(smart.notes ?? []));
console.log('  capability: ', JSON.stringify(smart.capability ?? null));
console.log('  search:     ', JSON.stringify(smart.search ?? null));
console.log('  history:    ', JSON.stringify(smart.history ?? null).slice(0, 400));
console.log('  offers:     ', JSON.stringify(smart.offers ?? []).slice(0, 1500));

console.log('\n=== 4b. how many games of usage the league actually has stored ===');
const lineup = await get(`/api/leagues/${league.id}/lineup`);
for (const e of [...(lineup.starters ?? []), ...(lineup.bench ?? [])]) {
  console.log(
    `  ${String(e.name).padEnd(22)} usage="${e.usage?.display ?? '-'}" games=${e.usage?.games ?? '?'} ` +
      `unknown=${e.usage?.unknown} roleBucket=${e.roleProfile?.bucket ?? '?'} tdProfile=${e.tdDependency?.profile ?? '?'}`,
  );
}

console.log('\n=== 6. the waiver board: the pool, the trend, and why nothing scored ===');
const w = await get(`/api/leagues/${league.id}/waivers`);
console.log('  headline:', JSON.stringify(w.headline));
console.log('  notes:   ', JSON.stringify(w.notes ?? []));
console.log('  pending: ', JSON.stringify(w.pending ?? []));
console.log('  pool:    ', JSON.stringify(w.pool ?? null));
console.log('  considered:', w.considered, ' rows:', (w.rows ?? []).length, ' upgrades:', (w.upgrades ?? []).length);
console.log('  faab.rule:', JSON.stringify(w.faab?.rule ?? null));
console.log('  faab.trendingCapturedAt:', w.faab?.trendingCapturedAt ?? 'NEVER');
console.log('  faab.mine:', JSON.stringify(w.faab?.mine ?? null));
console.log('  faab.prices:', JSON.stringify(w.faab?.prices ?? []).slice(0, 900));
console.log('  faab.losingBids:', JSON.stringify(w.faab?.losingBids ?? []).slice(0, 600));
console.log('  faab.bids:', JSON.stringify(w.faab?.bids ?? []).slice(0, 1500));
for (const r of (w.rows ?? []).slice(0, 8)) {
  console.log(
    `  row ${String(r.name).padEnd(22)} strength=${r.strength?.level} score=${r.score} ` +
      `bid.trending=${JSON.stringify(r.bid?.trending ?? null)} why="${r.why}"`,
  );
}
console.log('  dst:', JSON.stringify(w.dst ?? null).slice(0, 500));

console.log('\n=== 6b. the trending capture itself, through the league strategy ===');
const plan = await get(`/api/leagues/${league.id}/plan`);
console.log('  plan keys:', Object.keys(plan).join(', '));
console.log('  plan.trending:', JSON.stringify(plan.trending ?? null).slice(0, 900));
console.log('  plan.disagreement:', JSON.stringify(plan.disagreement ?? null).slice(0, 900));
console.log('  plan.notes:', JSON.stringify(plan.notes ?? []).slice(0, 600));
