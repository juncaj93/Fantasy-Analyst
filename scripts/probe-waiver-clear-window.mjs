/**
 * Which free agents are still inside this league's waiver window, and which are
 * free to add right now. Beside what the live Waivers screen prices them at.
 *
 * Written for the waivers follow-up round (1 October 2026). Sleeper's public
 * API has no per-player "on waivers" flag, so this prints the inputs the app
 * computes it from, straight from Sleeper:
 *
 *   - the league's waiver settings (type, budget, clear days, run day);
 *   - every completed drop in the current and previous week, with when, and
 *     when the clear-days window ends;
 *   - each board row and plan claim as the live app draws it, including the
 *     `pickup` state once the app carries one.
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
const sleeperLeagueId = process.env.LEAGUE_ID || league.sleeperLeagueId || league.sleeper_league_id || null;
console.log(`league: ${league.name}  now ${new Date().toISOString()}`);

const state = (await get(`${SLEEPER}/state/nfl`)).json ?? {};
const week = Number(state.week ?? 1);
console.log(`Sleeper state: week ${week}\n`);

const players = (await get(`${SLEEPER}/players/nfl`)).json ?? {};
const nameOf = (id) => {
  const p = players[id];
  return p ? `${p.first_name} ${p.last_name} (${p.position} ${p.team ?? 'FA'})` : id;
};

if (sleeperLeagueId) {
  const L = (await get(`${SLEEPER}/league/${sleeperLeagueId}`)).json;
  const s = L?.settings ?? {};
  console.log('== waiver settings (Sleeper)');
  for (const k of ['waiver_type', 'waiver_budget', 'waiver_bid_min', 'waiver_clear_days', 'waiver_day_of_week', 'daily_waivers', 'daily_waivers_hour']) {
    console.log(`  ${k}: ${s[k]}`);
  }
  const clearDays = Number(s.waiver_clear_days ?? 2);
  console.log('\n== completed drops, this week and last');
  for (const w of [week - 1, week]) {
    const txns = (await get(`${SLEEPER}/league/${sleeperLeagueId}/transactions/${w}`)).json ?? [];
    for (const t of txns) {
      if (t.status !== 'complete' || !t.drops) continue;
      for (const id of Object.keys(t.drops)) {
        if (t.adds && t.adds[id]) continue;
        const at = new Date(t.status_updated ?? t.created);
        const clears = new Date(at.getTime() + clearDays * 86_400_000);
        console.log(`  wk${w} ${t.type.padEnd(10)} dropped ${at.toISOString()}  window ends ~${clears.toISOString()}  ${nameOf(id)}`);
      }
    }
  }
} else {
  console.log('(no Sleeper league id on /api/leagues; set league_id to read settings and drops)');
}

const W = (await get(`${APP}/api/leagues/${league.id}/waivers`)).json ?? {};
console.log('\n== plan');
for (const c of W.claimPlan?.claims ?? []) {
  console.log(`  ${c.rank}. ${c.headline}${c.qualifier ? `  [${c.qualifier}]` : ''}  pickup=${JSON.stringify(c.pickup ?? null)}`);
}
for (const g of W.claimPlan?.groups ?? []) console.log(`  group ${g.index}: ${g.headline}  keep=${JSON.stringify(g.keep)}`);

console.log('\n== board rows');
const rows = [
  ...(W.upgrades ?? []).flatMap((u) => u.candidates ?? []),
  ...(W.valueAdds ?? []),
];
for (const r of rows) {
  const bid = (W.bids ?? []).find((b) => b.playerId === r.playerId);
  console.log(
    `  ${r.name.padEnd(22)} ${String(r.position).padEnd(3)} gain=${r.gain?.toFixed?.(2) ?? '-'} ` +
      `bid=${bid?.recommended ?? '-'} expected=${bid?.expected ? `${bid.expected.low}-${bid.expected.high}` : '-'} ` +
      `pickup=${JSON.stringify(r.pickup ?? null)}`,
  );
}
