/**
 * Waivers before and after the tiers, on the league's real data.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-tiers-report.ts snapshot.json <sleeperDir>
 *
 * `snapshot.json` is the public `waiver-plan` support snapshot: the exact inputs
 * the deployed Waivers screen read, and what it drew. `<sleeperDir>` holds
 * Sleeper's public answers fetched beside it by `probe-waiver-tiers.mjs`:
 * schedule.json, stats<week>.json, proj<week>.json, users.json, rosters.json.
 *
 * BEFORE is the snapshot's own output (what production drew). AFTER replays the
 * same inputs through the current `assembleWaiverPlan`, with the three inputs a
 * snapshot taken before the tiers existed could not carry, rebuilt from public
 * Sleeper data the same way production now stores them: the bye weeks (from
 * Sleeper's schedule), last week's points (weekly stats in this league's
 * scoring) and the earlier-week projection for players with none this week.
 * Manager names replace the snapshot's aliases, from the league's public user
 * list, so the seed profiles can match.
 *
 * Read-only. Prints names and numbers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assembleWaiverPlan, type WaiverAssembly } from '../src/core/waivers/assemble.ts';
import { scoreWeek, lastCompletedWeek } from '../src/core/sleeper/weekPoints.ts';
import { snapshotDstSources } from '../src/core/support/dstSnapshot.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { rehydratePlayer } from '../src/core/support/players.ts';
import { TIER_RULES } from '../src/core/waivers/tiers.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { decisionPoints } from '../src/core/startsit/decisionPoints.ts';
import { buildPlayerRate, RATE_BASIS_LABEL } from '../src/core/tradeValue/rate.ts';
import { byeOf } from '../src/core/tradeValue/weeks.ts';
import type { DstPlanSources } from '../src/core/dst/assemble.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

const [file, sleeperDir] = process.argv.slice(2);
if (!file || !sleeperDir) {
  console.error('usage: waiver-tiers-report.ts snapshot.json <sleeperDir>');
  process.exit(1);
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const snapshot = readJson<any>(file);
const inputs = snapshot.decision.inputs;
const before = snapshot.decision.output as WaiverAssembly;
const now = new Date(Date.parse(snapshot.capturedAt));
const week: number = inputs.week;
const season: string = inputs.season;

const roster = rehydrateStartSitInputs(inputs.roster);
const candidates = rehydrateStartSitInputs(inputs.candidates);
const { shape, profile } = rehydrateLeagueRules(inputs.rules);
const scoring = inputs.rules.scoringSettings as Record<string, number>;

/* Sleeper's schedule as fixture rows: one per team per week, a bye is a missing row. */
const games = readJson<{ week: number; home: string; away: string; date: string }[]>(join(sleeperDir, 'schedule.json'));
const fixtures: ScheduleTeamWeek[] = [];
for (const g of games) {
  for (const [team, opponent, home] of [
    [g.home, g.away, true],
    [g.away, g.home, false],
  ] as const) {
    fixtures.push({ season, week: g.week, team, opponent, home, kickoff: null, roof: null });
  }
}
const recorded: DstPlanSources | null = inputs.dst == null ? null : snapshotDstSources(inputs.dst);
const dstSources: DstPlanSources = {
  fixturesForWeek: async (s, w) => (recorded ? recorded.fixturesForWeek(s, w) : fixtures.filter((f) => f.week === w)),
  scheduleForTeams: async (s, teams, range) => {
    const hit = recorded ? await recorded.scheduleForTeams(s, teams, range) : [];
    if (hit.length > 0) return hit;
    const wanted = new Set(teams.map((t) => t.toUpperCase()));
    return fixtures.filter((f) => wanted.has(f.team) && f.week >= range.from && f.week <= range.to);
  },
  impliedTotals: async (s, n) => (recorded ? recorded.impliedTotals(s, n) : new Map()),
};

/* Last week's points, in this league's scoring. */
const kickoffs = [...roster, ...candidates].map((i) => i.kickoff ?? null);
const lastWeek = lastCompletedWeek(week, kickoffs, now);
const statsFile = join(sleeperDir, `stats${lastWeek}.json`);
/* A capture taken after the tiers shipped carries its own; prefer it. */
const lastWeekPoints = inputs.lastWeekPoints
  ? { week: inputs.lastWeekPoints.week as number, points: new Map(Object.entries(inputs.lastWeekPoints.points as Record<string, number>)) }
  : existsSync(statsFile)
    ? { week: lastWeek, points: new Map(Object.entries(scoreWeek(readJson(statsFile), scoring))) }
    : null;

/* The earlier-week projection, for players with no number this week. */
const published = new Map<string, number>(Object.entries((inputs.published ?? {}) as Record<string, number>));
const recentPublished = new Map<string, { week: number; points: number }>(
  Object.entries((inputs.recentPublished ?? {}) as Record<string, { week: number; points: number }>),
);
for (let back = 1; back <= 3 && inputs.recentPublished == null; back++) {
  const w = week - back;
  const path = join(sleeperDir, `proj${w}.json`);
  if (w < 1 || !existsSync(path)) continue;
  const rows = readJson<{ player_id: string; stats: Record<string, number> }[]>(path);
  const byId = new Map(rows.map((r) => [r.player_id, r.stats] as const));
  for (const i of [...roster, ...candidates]) {
    const id = i.player.id;
    if (recentPublished.has(id) || ((published.get(id) ?? 0) >= 1)) continue;
    const pts = scoreWeek({ [id]: byId.get(id) ?? {} }, scoring)[id];
    if (pts != null && pts >= 1) recentPublished.set(id, { week: w, points: pts });
  }
}

/* Real manager names in place of the snapshot's aliases, by roster id. */
const users = readJson<{ user_id: string; display_name: string }[]>(join(sleeperDir, 'users.json'));
const sleeperRosters = readJson<{ roster_id: number; owner_id: string }[]>(join(sleeperDir, 'rosters.json'));
const realName = new Map(sleeperRosters.map((r) => [r.roster_id, users.find((u) => u.user_id === r.owner_id)?.display_name ?? null]));
const rosters = (inputs.rosters as { rosterId: number; ownerName: string | null; isMine: boolean; playerIds: string[] }[]).map((r) => ({
  ...r,
  ownerName: realName.get(r.rosterId) ?? r.ownerName,
}));

const after = await assembleWaiverPlan({
  shape,
  profile,
  rosterInputs: roster,
  candidateInputs: candidates,
  rosteredIds: new Set(inputs.rosteredIds as string[]),
  currentStarterIds: inputs.currentStarterIds,
  reserveIds: inputs.reserveIds,
  ...(inputs.preseasonPoints === undefined ? {} : { preseasonPoints: new Map(Object.entries(inputs.preseasonPoints)) }),
  ...(inputs.draftRankOf === undefined ? {} : { draftRankOf: new Map(Object.entries(inputs.draftRankOf)) }),
  published,
  ...(inputs.refusedPositions === undefined ? {} : { refusedPositions: inputs.refusedPositions }),
  ...(inputs.depth === undefined ? {} : { depth: new Map(Object.entries(inputs.depth)) }),
  ...(inputs.trendingDrops === undefined ? {} : { trendingDrops: new Map(inputs.trendingDrops) }),
  ...(inputs.recentlyDropped === undefined ? {} : { recentlyDropped: new Map(Object.entries(inputs.recentlyDropped)) }),
  ...(inputs.waiverWindow == null
    ? {}
    : { waiverWindow: { rules: inputs.waiverWindow.rules, drops: new Map(Object.entries(inputs.waiverWindow.drops)) } }),
  rosters,
  players: inputs.players.map(rehydratePlayer),
  week,
  season,
  strategy: inputs.strategy == null ? null : { ...inputs.strategy, trending: new Map(inputs.strategy.trending) },
  trending: inputs.strategy == null ? undefined : new Map(inputs.strategy.trending),
  ...(inputs.seasonMarkets == null ? {} : { seasonMarkets: new Map(inputs.seasonMarkets) }),
  budgets: inputs.budgets,
  prices: inputs.prices,
  observations: inputs.observations,
  ...(inputs.history == null
    ? {}
    : {
        history: {
          profiles: new Map(inputs.history.profiles),
          baseline: inputs.history.baseline,
          week: inputs.history.week,
          finalWeek: inputs.history.finalWeek,
        },
      }),
  dstSources,
  bestBall: inputs.bestBall,
  draftComplete: inputs.draftComplete,
  playoff: inputs.playoff,
  lastWeekPoints,
  recentPublished,
  reserveSlots: inputs.reserveSlots ?? 2,
  now,
  generatedAt: inputs.generatedAt,
});

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
console.log(`captured ${snapshot.capturedAt}  week ${week}  release ${snapshot.release?.gitSha ?? '?'}`);
console.log(`last week's points: week ${lastWeek}, ${lastWeekPoints ? `${lastWeekPoints.points.size} players` : 'not available'}`);
console.log(`earlier-week projections used for ${recentPublished.size} players with no number this week`);

console.log('\n=== BEFORE: what the deployed screen drew ===');
const plan = before.claimPlan;
console.log(`plan: ${plan?.state ?? 'none'}${plan?.surface ? '' : ' (not drawn)'}`);
for (const g of plan?.groups ?? []) {
  console.log(`  ${g.headline}`);
  for (const c of (plan?.claims ?? []).filter((x) => x.group === g.index)) console.log(`    ${c.rank}. ${c.headline}  ${c.detail ?? ''}`);
}
const oldRows = [...before.upgrades.flatMap((u) => u.candidates.map((c) => ({ ...c, slot: u.slot }))), ...before.valueAdds];
console.log(`board rows: ${oldRows.length}`);
for (const r of oldRows) console.log(`  ${pad(r.name, 24)} ${pad(r.position, 3)} gain ${r.gain.toFixed(2)}  over ${r.cut?.name ?? '-'}`);
if (before.nearestMiss) {
  const m = before.nearestMiss;
  console.log(`closest: ${m.name} ${m.gap.toFixed(2)} over ${m.overName}, needed ${m.bar.toFixed(1)} (${m.basis})`);
}

console.log('\n=== AFTER: the tiers ===');
const t = after.tiers;
if (!t) {
  console.log('tiers: none (the planner failed)');
  process.exit(0);
}
console.log(`window: weeks ${t.window.weeks.join(', ')} weighted ${t.window.weights.join(', ')}; ${t.valued} free agents valued, ${t.unvalued} with no number`);
const line = (r: NonNullable<typeof t.doThis>) =>
  `${pad(r.name, 22)} ${pad(r.position, 3)} +${r.gain.toFixed(2)} (lineup ${r.lineupGain.toFixed(2)}, depth ${r.insurance.toFixed(2)}${r.prefs.map((p) => `, ${p.key} ${p.points}`).join('')})` +
  `  drop ${r.drop?.name ?? '(open spot)'}  | ${r.reason}` +
  `  | ${r.bid.kind === 'claim' ? `bid $${r.bid.recommended} ($${r.bid.low}-${r.bid.high}): ${r.bid.reason}` : r.bid.reason}` +
  (r.competesWith.length > 0 ? `  | competes with ${r.competesWith.join(', ')} for that spot` : '') +
  (r.alternativeTo ? `  | an alternative to ${r.alternativeTo}` : '') +
  (r.alternatives.length > 0 ? `  | alternatives: ${r.alternatives.join(', ')}` : '') +
  `  | last wk ${r.lastWeekPoints == null ? '-' : r.lastWeekPoints.toFixed(1)}`;
console.log(`DO THIS: ${t.doThis ? line(t.doThis) : 'nothing'}`);
console.log('WORTH CONSIDERING:');
for (const r of t.consider) console.log(`  ${line(r)}`);
console.log('WATCH LIST:');
for (const r of t.watch) console.log(`  ${line(r)}`);
console.log('DROP-READY:');
for (const d of t.dropReady) console.log(`  ${pad(d.name, 22)} ${pad(d.position, 3)} cost ${d.cost.toFixed(2)}  over FA ${d.overReplacement?.toFixed(1) ?? '-'}  | ${d.reason}`);
console.log(`claim card: ${after.claimPlan?.surface ? after.claimPlan.claims.map((c) => `${c.headline} / ${after.claimPlan!.groups[0]!.headline}`).join('; ') : 'not drawn'}`);

console.log('\n=== THE THRESHOLD AUDIT: every valued free agent near a line ===');
console.log(`lines: do this ${TIER_RULES.doThis}, consider ${TIER_RULES.consider}, watch ${TIER_RULES.watch} (weighted lineup points)`);
const bands: [string, number, number][] = [
  ['>= 4', 4, Infinity],
  ['3 to 4', 3, 4],
  ['1.5 to 3', 1.5, 3],
  ['1 to 1.5', 1, 1.5],
  ['0.4 to 1', 0.4, 1],
  ['0 to 0.4', 0, 0.4],
];
for (const [label, lo, hi] of bands) {
  const hits = t.audit.filter((r) => r.gain >= lo && r.gain < hi);
  console.log(`  ${pad(label, 9)} ${String(hits.length).padStart(2)}  ${hits.map((r) => `${r.name} ${r.position} ${r.gain.toFixed(2)}`).join(', ')}`);
}
console.log('top of the board, with reasons:');
for (const r of t.audit.slice(0, 12)) console.log(`  ${pad(r.name, 22)} ${pad(r.position, 3)} ${r.gain.toFixed(2)}  drop ${r.drop ?? '(open)'}  | ${r.reason}`);

console.log('\nRIVAL PROFILES (seed or default, blended with this season):');
for (const r of t.profiles) console.log(`  ${pad(r.name, 16)} ${pad(r.style, 28)} ${r.source}  ${r.claimsPerRun.toFixed(2)} claims/run  bids ${r.bids.join(',') || '-'}`);

/*
 * One position, one player at a time: the single number the planner used, where
 * it came from, and (beside it, never fed into it) what Sleeper publishes for
 * each of the window's weeks in this league's scoring. The planner values a
 * player with ONE points-a-game figure and multiplies it by whether he plays
 * each week (0 on a bye or while out), so the week columns below are context
 * for reading the ranking, not inputs to it.
 */
const names = (process.env.BREAKDOWN_NAMES ?? 'Aaron Rodgers,C.J. Stroud,Jordan Love,Sam Darnold,Joe Burrow').split(',').map((n) => n.trim());
const weeks = [week, week + 1, week + 2];
const sleeperWeek = (w: number, id: string): number | null => {
  const path = join(sleeperDir, `proj${w}.json`);
  if (!existsSync(path)) return null;
  const row = readJson<{ player_id: string; stats?: Record<string, number> }[]>(path).find((r) => String(r.player_id) === id);
  if (!row?.stats || row.stats.pts_half_ppr == null) return null;
  return scoreWeek({ [id]: row.stats }, scoring)[id] ?? 0;
};
console.log(`\n=== NUMBER BREAKDOWN: the one figure the planner used, and where it came from ===`);
console.log(`(planner window weeks ${weeks.join(', ')}; "sleeper wk" columns are Sleeper's own projection in this league's scoring, shown for comparison only)`);
for (const name of names) {
  const i = [...roster, ...candidates].find((x) => x.player.fullName === name);
  if (!i) {
    console.log(`  ${pad(name, 16)} not in the snapshot's roster or free-agent scan`);
    continue;
  }
  const evaluation = evaluatePlayer(i, profile);
  const decision = decisionPoints(evaluation, published);
  const status = evaluation.components.find((c) => c.key === 'status');
  const team = (i.player.team ?? '').toUpperCase();
  const bye = byeOf(fixtures, team, { from: week, to: week + 2 });
  const rate = buildPlayerRate({
    evaluation,
    published,
    seasonLine: null,
    recentWeek: recentPublished.get(i.player.id) ?? null,
    weeks,
    byeWeek: bye.byeWeek,
    byeKnown: bye.known,
    onReserve: false,
  });
  const vegas = evaluation.expectation?.points != null;
  console.log(
    `  ${pad(name, 16)} ${pad(team, 4)} rate ${rate.rate == null ? 'none' : rate.rate.toFixed(2)} via ${RATE_BASIS_LABEL[rate.basis]}` +
      ` | decision basis ${decision?.basis ?? 'none'}: base ${decision?.base ?? '-'} + nudges ${rate.rateParts?.nudges ?? '-'}` +
      ` | Vegas line ${vegas ? 'present' : 'absent'}, Sleeper this week ${published.get(i.player.id)?.toFixed(2) ?? 'absent'}` +
      ` | availability by week ${rate.weekly.join('/')}${bye.byeWeek ? ` (bye wk ${bye.byeWeek})` : ''}` +
      ` | earlier-week fill ${recentPublished.has(i.player.id) ? `wk ${recentPublished.get(i.player.id)!.week} ${recentPublished.get(i.player.id)!.points.toFixed(1)}` : 'none'}` +
      ` | status charge ${status && !status.unknown ? status.value.toFixed(2) : '0'} (removed)` +
      ` | sleeper wk ${weeks.map((w) => sleeperWeek(w, i.player.id)?.toFixed(1) ?? 'bye/none').join(' / ')}` +
      (rate.rateNote ? ` | note: ${rate.rateNote}` : ''),
  );
}
