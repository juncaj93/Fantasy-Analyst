/**
 * Round 7 (Floor/Ceiling decide toss-ups, Doubtful counts as Out; 5 November
 * 2026): the one combined production read, after the deploy.
 *
 * Run after the D1 daily reset (7:05 PM ET in November, 00:05 UTC). Reads, once each:
 *
 *   - GET  /api/health                  the production SHA
 *   - GET  /api/leagues                 the selected league
 *   - GET  /api/leagues/:id/lineup      Team: the mode, every number, each player's
 *                                       spread, the toss-ups and their leans
 *   - GET  /api/leagues/:id/matchup     Matchup: the same numbers, and any hole filled
 *   - POST /api/startsit/compare        Compare: Team's top toss-up, in Team's mode
 *
 * "Before" is rebuilt from the answer itself: each player's components times
 * the Floor/Ceiling weights the old engine applied (`startsit@6`), and a
 * Doubtful player's number before the gate (his number less six). A toss-up
 * leaned to the higher number then, in every mode. Reads only. No odds are
 * bought, nothing is written, Sleeper is not asked.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const et = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';
const json = async (res) => (res.ok ? res.json() : { httpStatus: res.status });
const fmt = (v) => (v == null || !Number.isFinite(v) ? '-' : Number(v).toFixed(2));

/** The weights `startsit@6` applied (`core/startsit/mode.ts` before 5 November 2026). */
const OLD_WEIGHTS = {
  balanced: {},
  floor: { usage_level: 1.4, role_trend: 1.2, status: 1.3, replacement_risk: 1.3, explosiveness: 0.4, td_dependency: 1.5, vegas: 0.9, weather: 1.2, game_script: 1, uncertainty: 1.3 },
  ceiling: { usage_level: 1.1, role_trend: 1.1, vegas: 1.2, game_script: 1.3, explosiveness: 1.5, td_dependency: 0.5, uncertainty: 0.7, weather: 0.9 },
};
function oldWeight(key, mode, value) {
  if (mode === 'floor' && key === 'role_trend' && value > 0) return 1;
  if (mode === 'ceiling' && key === 'td_dependency' && value > 0) return 1;
  return OLD_WEIGHTS[mode]?.[key] ?? 1;
}

/** Today's D1 rows, from Cloudflare's own analytics (free; no database read). */
function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'start/sit round 7 probe'], {
    encoding: 'utf8',
    env: process.env,
  });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`started ${et(new Date())}`);
const before = rowsToday();
console.log(`D1 rows read today before: ${before ?? 'unknown'}`);
const health = await fetch(`${APP}/api/health`).then(json).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then(json);
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

/* ------------------------------------------------------------------ Team */
const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then(json);
const mode = lineup?.mode ?? '?';
const s = lineup?.modeSuggestion ?? {};
console.log(`\n## Team`);
console.log(`mode: ${mode} (auto ${s.auto ?? '?'}, margin ${fmt(s.margin)}, ${s.detail ?? ''})`);
const rows = [...(lineup?.starters ?? []), ...(lineup?.bench ?? [])];
const starters = new Set((lineup?.starters ?? []).map((e) => e.playerId));
const byId = new Map(rows.map((e) => [e.playerId, e]));

/** The old Team number: the decision number with each component's old weight put back. */
function oldNumber(e) {
  const now = e.decision?.points ?? null;
  if (now == null) return null;
  let delta = 0;
  for (const c of e.components ?? []) {
    if (c.unknown || c.textOnly) continue;
    if (e.decision?.basis === 'published' && (c.key === 'vegas' || c.key === 'uncertainty')) continue;
    delta += c.value * (oldWeight(c.key, mode, c.value) - 1);
  }
  return Math.round((now + delta) * 100) / 100;
}
const designation = (e) => (e.injury?.designation ?? '').toLowerCase();

console.log('player | pos | starts | number now | number before (rebuilt) | spread share, games, basis | status');
for (const e of rows) {
  const sp = e.spread ? `${fmt(e.spread.share)}, ${e.spread.games}, ${e.spread.basis}` : '-';
  const nowNumber = e.ruledOut ? 'Out' : fmt(e.decision?.points);
  let was = oldNumber(e);
  if (designation(e) === 'doubtful') {
    /* Before: his number less six, never below zero. */
    const healthy = (e.decision?.points ?? 0) - (e.components?.find((c) => c.key === 'status')?.value ?? 0);
    was = Math.max(0, Math.round((healthy - 6) * 100) / 100);
  }
  console.log(`${e.name} | ${e.position} | ${starters.has(e.playerId) ? 'yes' : 'bench'} | ${nowNumber} | ${fmt(was)} | ${sp} | ${e.statusFlag ?? '-'}`);
}

const line = (w) => `${w.inName} over ${w.outName} at ${w.slot} (${w.gain >= 0 ? '+' : ''}${fmt(w.gain)})${w.leanTag ? ` [${w.leanTag}]` : ''}`;
console.log(`swaps: ${(lineup?.swaps ?? []).map(line).join('; ') || 'none'}`);
console.log(`fills: ${(lineup?.fills ?? []).map((f) => `${f.inName} at ${f.slot}`).join('; ') || 'none'}`);
const tossUps = lineup?.tossUps ?? [];
console.log(`toss-ups now: ${tossUps.map(line).join('; ') || 'none'}`);
for (const t of tossUps) {
  const a = byId.get(t.inPlayerId);
  const b = byId.get(t.outPlayerId);
  const oa = a ? oldNumber(a) : null;
  const ob = b ? oldNumber(b) : null;
  const beforeLean = oa != null && ob != null ? (oa >= ob ? t.inName : t.outName) : '?';
  const changed = beforeLean !== t.inName;
  console.log(`  lean now ${t.inName}${t.leanTag ? ` (${t.leanTag})` : ''}; before ${beforeLean} on the old numbers ${fmt(oa)} vs ${fmt(ob)}${changed ? '  <- CHANGED' : ''}`);
}

/* --------------------------------------------------------------- Compare */
if (tossUps[0]) {
  const t = tossUps[0];
  const res = await fetch(`${APP}/api/startsit/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leagueId, playerIds: [t.outPlayerId, t.inPlayerId], slot: t.slot, mode }),
  }).then(json);
  console.log(`\n## Compare, Team's top toss-up in ${mode}`);
  console.log(`lean: ${res?.tossUp?.leanName ?? '(none)'}${res?.tossUp?.leanTag ? ` (${res.tossUp.leanTag})` : ''}; start: ${res?.recommendedPlayerId ?? 'none'}; agrees with Team: ${res?.tossUp?.leanPlayerId === t.inPlayerId}`);
  for (const e of res?.evaluations ?? []) {
    const team = byId.get(e.playerId)?.decision?.points;
    console.log(`  ${e.name}: Compare ${fmt(e.decision?.points)}, Team ${fmt(team)}`);
  }
} else {
  console.log('\n## Compare: no toss-up on Team, nothing to open');
}

/* --------------------------------------------------------------- Matchup */
const matchup = await fetch(`${APP}/api/leagues/${leagueId}/matchup`).then(json);
const f = matchup?.forecast;
console.log('\n## Matchup');
if (!f) {
  console.log(`no forecast (${matchup?.reason ?? matchup?.httpStatus ?? '?'})`);
} else {
  const mine = [...f.slots.map((r) => r.mine), ...(f.bench?.mine ?? [])].filter(Boolean);
  let differ = 0;
  for (const p of mine) {
    const e = byId.get(p.playerId);
    const team = e ? (e.ruledOut ? 0 : e.decision?.points) : null;
    if (team != null && p.projectedFinal != null && Math.abs(team - p.projectedFinal) > 0.01) {
      differ += 1;
      console.log(`  differs: ${p.name} Matchup ${fmt(p.projectedFinal)} vs Team ${fmt(team)}`);
    }
  }
  console.log(`Alex's players on Matchup: ${mine.length}; numbers that differ from Team: ${differ}`);
  const fills = f.decision?.fills;
  console.log(`decision shape: ${fills ? `fills (${fills.length})` : f.decision?.best !== undefined ? 'old best/options (older worker)' : '?'}`);
  for (const x of fills ?? []) console.log(`  hole: ${x.inName} takes ${x.slot} from ${x.outName}, win ${fmt(x.winNow)} -> ${fmt(x.winAfter)}`);
}

const after = rowsToday();
console.log(`\nD1 rows read today after: ${after ?? 'unknown'}${before != null && after != null ? ` (+${after - before}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`finished ${et(new Date())}. Endpoints read once each: health, leagues, lineup, compare (one toss-up), matchup.`);
