/**
 * The Waivers screen as the live app draws it, beside what Sleeper itself says.
 *
 * Written for the waivers rebuild (30 September 2026 research round). It prints
 * the facts that round's report rested on so they can be re-checked on the
 * current wire before anything is built on them, and again afterwards to show
 * what changed:
 *
 *   - the claim plan and every card's "Better than" name, side by side, so a
 *     card and a plan that disagree about the cut are visible in one glance;
 *   - each card's projection, the man it is measured against, and the basis;
 *   - the cost column, and how many winning bids the price model rests on,
 *     against how many paid winning bids Sleeper itself publishes;
 *   - Sleeper's trending adds and drops, intersected with the free agents on
 *     the board;
 *   - Sleeper's published projection for every name above.
 *
 * Reads only, GET only. The league id is never printed.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app/v1';

async function get(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 300) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const leagues = (await get(`${APP}/api/leagues`)).json?.leagues ?? [];
const league = leagues.find((l) => l.isSelected) ?? leagues[0] ?? null;
if (!league) {
  console.log('no league');
  process.exit(0);
}
console.log(`league: ${league.name}`);

const state = (await get(`${SLEEPER}/state/nfl`)).json ?? {};
const week = Number(state.week ?? 1);
const season = String(state.season ?? league.season ?? '2026');
console.log(`Sleeper state: season ${season}, week ${week}, now ${new Date().toISOString()}\n`);

const W = (await get(`${APP}/api/leagues/${league.id}/waivers`)).json ?? {};
const players = (await get(`${SLEEPER}/players/nfl`)).json ?? {};
const nameOf = (id) => {
  const p = players[id];
  return p ? `${p.first_name} ${p.last_name}` : id;
};
const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(2) : String(v));

// ------------------------------------------------------------------ the plan
const plan = W.claimPlan;
console.log('== Claim plan');
if (!plan) console.log('  (none)');
else {
  console.log(`  ${plan.headline} [${plan.state}]${plan.instruction ? ` · ${plan.instruction}` : ''}`);
  const groups = plan.groups ?? [];
  if (groups.length === 0) {
    for (const c of plan.claims ?? []) {
      console.log(`  ${c.rank}. ${c.headline}${c.qualifier ? `  (${c.qualifier})` : ''}`);
    }
  }
  for (const g of groups) {
    console.log(`  ${g.headline}`);
    for (const c of (plan.claims ?? []).filter((x) => x.group === g.index)) {
      console.log(`    ${c.rank}. ${c.headline}${c.qualifier ? `  (${c.qualifier})` : ''}`);
      if (c.detail) console.log(`       ${c.detail}`);
    }
    for (const k of g.keep ?? []) console.log(`    ${k}`);
  }
  if (plan.budget) console.log(`  budget: ${plan.budget}`);
  for (const line of plan.protectedPlayers ?? []) console.log(`  protected: ${line}`);
  if (plan.note) console.log(`  note: ${plan.note}`);
}
console.log(`  updatedAt: ${W.updatedAt ?? '(field absent)'}`);

// ----------------------------------------------------------------- the cards
console.log('\n== Cards (value adds)');
/* The invariant: for every card the plan claims, the plan's drop for that player is the card's name. */
const planDropFor = new Map();
for (const c of plan?.claims ?? []) if (!planDropFor.has(c.addPlayerId)) planDropFor.set(c.addPlayerId, c.dropName);
let disagreements = 0;
for (const a of W.valueAdds ?? []) {
  const b = a.basis ?? {};
  const yard = b.yardstick ? ` basis=${b.yardstick}` : '';
  const planned = planDropFor.has(a.playerId);
  const agree = !planned ? ' [not in plan]' : planDropFor.get(a.playerId) === a.overName ? ' [plan drops the same player]' : ' [PLAN CUTS SOMEONE ELSE]';
  if (planned && planDropFor.get(a.playerId) !== a.overName) disagreements += 1;
  console.log(
    `  ${a.position} ${a.name} over ${a.overName ?? '—'}${agree}: proj ${fmt(b.projection)} vs ${fmt(b.overProjection)} gap ${fmt(b.projectionGap)}${yard} gain ${fmt(a.gain)} prio ${fmt(a.priority)}`,
  );
  for (const r of a.reasons ?? []) console.log(`      · ${r}`);
  if (a.notes) for (const n of a.notes) console.log(`      ! ${n}`);
  if (a.planExcluded) console.log(`      kept out of plan: ${a.planExcluded}`);
}
console.log(`  card/plan disagreements: ${disagreements}`);
console.log('\n== Cards (starter upgrades)');
for (const u of W.upgrades ?? []) {
  for (const c of u.candidates ?? []) console.log(`  ${u.slot}: ${c.name} over ${u.currentName ?? '—'} gain ${fmt(c.gain)} cut ${c.cut?.name ?? '—'}`);
}
console.log('\n== Unknowns');
for (const u of W.unknowns ?? []) console.log(`  ${u.position} ${u.name}: ${u.trending ?? ''}`);
console.log('\n== Other options / warnings');
for (const o of W.otherOptions ?? []) console.log(`  ${o.position} ${o.name}: ${o.label ?? ''} ${o.warning ?? ''}`);

// ------------------------------------------------------------------- the cost
console.log('\n== Cost');
const faab = W.faab;
if (!faab) console.log('  faab: null');
else {
  const p = faab.prices ?? {};
  console.log(`  price model: sample ${p.sample} median ${fmt(p.median)} range ${fmt(p.low)}-${fmt(p.high)} max ${fmt(p.max)} (${p.confidence})`);
  console.log(`  remaining: ${faab.mine?.remaining ?? '—'}`);
  for (const bid of faab.bids ?? []) {
    console.log(`  bid ${nameOf(bid.playerId)}: expected ${bid.expected ? `${bid.expected.low}-${bid.expected.high}` : '—'} rec ${fmt(bid.recommended)} ${bid.withheld ? `withheld: ${bid.withheld}` : ''}`);
  }
}

// ------------------------------------------ what Sleeper publishes, for truth
/* Not on `/api/leagues`; the draft Sleeper names carries it. Never printed. */
const sleeperLeagueId = league.draftId ? ((await get(`${SLEEPER}/draft/${league.draftId}`)).json?.league_id ?? null) : null;
if (sleeperLeagueId) {
  console.log('\n== Sleeper transactions (paid winning waiver bids)');
  let paid = 0;
  const amounts = [];
  for (let w = 1; w <= week; w++) {
    const rows = (await get(`${SLEEPER}/league/${sleeperLeagueId}/transactions/${w}`)).json ?? [];
    const won = rows.filter((t) => t.type === 'waiver' && t.status === 'complete');
    const bids = won.map((t) => Number(t.settings?.waiver_bid ?? 0));
    const weekPaid = bids.filter((b) => b > 0);
    paid += weekPaid.length;
    amounts.push(...weekPaid);
    const stamps = won.map((t) => new Date(t.status_updated ?? t.created).toISOString().slice(0, 16));
    console.log(`  week ${w}: ${won.length} completed waiver claims, ${weekPaid.length} paid [${weekPaid.join(', ')}] at ${[...new Set(stamps)].join(', ')}`);
  }
  amounts.sort((a, b) => a - b);
  const q = (f) => (amounts.length ? amounts[Math.min(amounts.length - 1, Math.floor(f * amounts.length))] : null);
  console.log(`  total paid winning bids: ${paid}; p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} max ${amounts.at(-1) ?? '—'}`);
} else {
  console.log('\n(no sleeperLeagueId on /api/leagues, skipping Sleeper transactions)');
}

console.log('\n== Sleeper trending (free agents on the board or unknown list)');
const boardIds = new Set([
  ...(W.valueAdds ?? []).map((a) => a.playerId),
  ...(W.unknowns ?? []).map((u) => u.playerId),
  ...(W.upgrades ?? []).flatMap((u) => (u.candidates ?? []).map((c) => c.playerId)),
  ...(W.otherOptions ?? []).map((o) => o.playerId),
]);
for (const type of ['add', 'drop']) {
  const rows = (await get(`${SLEEPER}/players/nfl/trending/${type}?lookback_hours=24&limit=50`)).json ?? [];
  const top = rows.slice(0, 10).map((r, i) => `#${i + 1} ${nameOf(r.player_id)}`);
  console.log(`  ${type} top 10: ${top.join(', ')}`);
  rows.forEach((r, i) => {
    if (boardIds.has(r.player_id)) console.log(`    on the board: #${i + 1} ${nameOf(r.player_id)} (${r.count})`);
  });
}

console.log('\n== Sleeper published projection (half PPR), board and cut names');
const proj = (await get(`https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`)).json ?? [];
const projOf = new Map(proj.map((r) => [r.player_id, r.stats?.pts_half_ppr ?? null]));
const named = new Set([...boardIds]);
for (const a of W.valueAdds ?? []) if (a.overPlayerId) named.add(a.overPlayerId);
for (const c of plan?.claims ?? []) if (c.dropPlayerId) named.add(c.dropPlayerId);
for (const id of named) console.log(`  ${nameOf(id)}: ${fmt(projOf.get(id))}`);
