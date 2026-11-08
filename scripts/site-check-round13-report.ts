/**
 * Round 13 (whole-site check): Alex's real week, rebuilt from the support
 * snapshots on whichever code this runs on, plus a read of what production
 * itself answered.
 *
 *   node --experimental-transform-types --no-warnings scripts/site-check-round13-report.ts <dir>
 *
 * `<dir>` holds what `probe-site-check-round13.mjs` read: `lineup.json`,
 * `matchup.json`, `waiver-plan.json` (support snapshots) and `screens.json`
 * (every screen's response by path). Uses only exports the code before the
 * round (97d1a39) also has, so the probe can run it on both and diff them.
 *
 * Part A (rebuilt, differs between codes): Team's lineup, swaps, fills and
 * toss-ups, Compare on every starter against his best bench man, Matchup's
 * hole fills, the waiver tiers with their drops, and Pick up and start.
 *
 * Part B (production's own answers): each player's number on Team, Matchup
 * and Waivers, beside Compare rebuilt here (its route needs the passphrase);
 * contradictions between screens (a drop
 * one screen suggests that another builds a trade around, a Best move that
 * Compare calls a toss-up); and the north star scan of every string sent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleLineup } from '../src/core/startsit/assemble.ts';
import { compareStartSit, type StartSitInput } from '../src/core/startsit/engine.ts';
import { rehydrateLeagueRules, rehydrateStartSitInputs } from '../src/core/support/inseason.ts';
import { readSnapshot } from '../src/core/support/dispatch.ts';
import { buildMatchupResponse } from '../src/core/matchup/build.ts';
import { snapshotMatchupSources } from '../src/core/support/matchupSnapshot.ts';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan } from '../src/core/waivers/assemble.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: site-check-round13-report.ts <dir>');
const read = (name: string): any => {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return null;
  }
};
const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '-' : (Math.round(v * 100) / 100).toFixed(2));
const section = (title: string) => console.log(`\n######## ${title}`);
async function guarded(title: string, run: () => Promise<void> | void): Promise<void> {
  section(title);
  try {
    await run();
  } catch (err) {
    console.log(`(failed on this code: ${String(err instanceof Error ? err.message : err).slice(0, 300)})`);
  }
}

const decisionOf = (e: any): number | null =>
  e?.ruledOut ? 0 : e?.decision?.basis === 'market' || e?.decision?.basis === 'published' ? Math.max(0, e.decision.points) : null;
const screens: Record<string, { status: number | string; body: string }> = read('screens.json') ?? {};
const body = (match: (path: string) => boolean): any => {
  const key = Object.keys(screens).find(match);
  if (!key) return null;
  try {
    return JSON.parse(screens[key]!.body);
  } catch {
    return null;
  }
};
const rosterResp = body((p) => /\/api\/leagues\/[^/]+\/roster$/.test(p));
const lineupResp = body((p) => /\/api\/leagues\/[^/]+\/lineup$/.test(p));
const matchupResp = body((p) => /\/api\/leagues\/[^/]+\/matchup$/.test(p));
const waiversResp = body((p) => /\/api\/leagues\/[^/]+\/waivers$/.test(p));
const smartResp = body((p) => p === '/api/trades/smart');
const buildResp = body((p) => p.includes('/trades/build?'));

/* Sleeper's slot for each starter, from the roster response (round 13's `currentSlotsOf`, inline so 97d1a39 runs it). */
const currentSlotOf = (() => {
  const labels = ((rosterResp?.rosterPositions ?? []) as string[]).map((p) => String(p).toUpperCase()).filter((p) => !['BN', 'IR', 'TAXI'].includes(p));
  const ids = (rosterResp?.starterSlotIds ?? []) as (string | null)[];
  const out = new Map<string, string>();
  if (labels.length > 0 && ids.length >= labels.length) labels.forEach((l, i) => ids[i] && out.set(ids[i]!, l));
  return out;
})();

/* ================================================================ PART A */

const lineupRaw = read('lineup.json');
let lineupInputs: StartSitInput[] = [];
let published = new Map<string, number>();
let profile: any = null;
let names = new Map<string, string>();
/* Compare's number per player, rebuilt here: production's Compare is a POST behind the passphrase. */
const compareNums = new Map<string, number | null>();

await guarded('A1. TEAM rebuilt from the lineup snapshot', () => {
  if (!lineupRaw) return console.log('no lineup snapshot');
  const inputs = lineupRaw.decision.inputs;
  const rules = rehydrateLeagueRules(inputs.rules);
  profile = rules.profile;
  lineupInputs = rehydrateStartSitInputs(inputs.startSit);
  published = new Map(Object.entries(inputs.published as Record<string, number>));
  names = new Map(lineupInputs.map((i) => [i.player.id, i.player.fullName] as const));
  const lineup: any = assembleLineup({
    inputs: lineupInputs,
    shape: rules.shape,
    profile: rules.profile,
    currentStarterIds: inputs.currentStarterIds,
    mode: inputs.mode,
    published,
    unknownPlayers: inputs.unknownPlayers,
    now: lineupRaw.capturedAt,
    currentSlotOf,
  } as Parameters<typeof assembleLineup>[0]);
  console.log(`captured ${lineupRaw.capturedAt}; mode ${inputs.mode}; Sleeper slots known for ${currentSlotOf.size} starters`);
  for (const s of lineup.slots) console.log(`  ${s.slot}: ${s.name ?? '(empty)'}${s.locked ? ' (locked)' : ''}`);
  for (const s of lineup.swaps) console.log(`  swap ${s.slot}: start ${s.inName} over ${s.outName} +${f2(s.gain)}`);
  for (const s of lineup.fills) console.log(`  fill ${s.slot}: ${s.inName} +${f2(s.gain)}`);
  for (const s of lineup.tossUps ?? []) console.log(`  toss-up ${s.slot}: lean ${s.inName} over ${s.outName} (${f2(s.gain)})${s.leanTag ? ` ${s.leanTag}` : ''}`);
  if (lineup.swaps.length + lineup.fills.length + (lineup.tossUps ?? []).length === 0) console.log('  no swap, fill or toss-up');
  for (const r of lineup.lateSwapRisks ?? []) if (r.starting) console.log(`  late-swap risk: ${r.name} ${r.verdict}`);
});

await guarded('A2. COMPARE: each starter against his best bench man at the same position', () => {
  if (!profile || !lineupRaw) return;
  const starters = new Set<string>(lineupRaw.decision.inputs.currentStarterIds);
  const byId = new Map(lineupInputs.map((i) => [i.player.id, i] as const));
  const bench = lineupInputs.filter((i) => !starters.has(i.player.id));
  for (const id of starters) {
    const s = byId.get(id);
    if (!s) continue;
    const alts = bench.filter((b) => b.player.position === s.player.position);
    if (alts.length === 0) continue;
    const cmp: any = compareStartSit([s, ...alts].slice(0, 6), profile, { published, mode: lineupRaw.decision.inputs.mode });
    for (const e of cmp.evaluations) compareNums.set(e.playerId, decisionOf(e));
    const top = cmp.evaluations.find((e: any) => e.playerId === cmp.recommendedPlayerId);
    const said = cmp.tossUp ? `toss-up, lean ${cmp.tossUp.leanName}` : top ? `start ${top.name}` : 'no pick';
    console.log(`  ${s.player.fullName} (${s.player.position}) vs ${alts.map((a) => a.player.fullName).join(', ')}: ${said}`);
  }
});

await guarded('A3. MATCHUP hole fills, rebuilt from the matchup snapshot', async () => {
  const raw = read('matchup.json');
  if (!raw) return console.log('no matchup snapshot');
  const snapshot = readSnapshot(raw) as any;
  const { request, output } = snapshot.decision;
  const replayed: any = await buildMatchupResponse(snapshotMatchupSources(snapshot), request.leagueId, {
    week: request.week,
    ...(output.forecast?.seed === undefined ? {} : { seed: output.forecast.seed }),
  } as never);
  const f = replayed.forecast;
  console.log(`  win chance ${f2(f?.teams?.mine?.winProbability)}; projected ${f2(f?.teams?.mine?.projectedFinal)} vs ${f2(f?.teams?.theirs?.projectedFinal)}`);
  const fills = f?.decision?.fills ?? [];
  for (const x of fills) console.log(`  hole ${x.slot}: ${x.inName} for ${x.outName} (+${f2(x.gain * 100)} win %)`);
  if (fills.length === 0) console.log(`  no hole fill: ${f?.decision?.note ?? '-'}`);
});

await guarded('A4. WAIVERS rebuilt from the waiver-plan snapshot', async () => {
  const raw = read('waiver-plan.json');
  if (!raw) return console.log('no waiver-plan snapshot');
  const rebuilt = waiverRequestFromSnapshot(readSnapshot(raw) as any);
  const plan: any = await assembleWaiverPlan(rebuilt.request);
  const t = plan.tiers;
  const line = (m: any) => `${m.name} (${m.position}) gain ${f2(m.gain)}${m.drop ? `, drop ${m.drop.name}` : ''}${m.bid?.recommended != null ? `, bid $${m.bid.recommended}` : ''}: ${m.reason}`;
  console.log(`  weeks ${JSON.stringify(t?.window?.weeks ?? null)}; season ${t?.season ? 'on' : 'off'}`);
  for (const m of t?.doThese ?? []) console.log(`  do: ${line(m)}`);
  for (const m of (t?.consider ?? []).slice(0, 8)) console.log(`  consider: ${line(m)}`);
  for (const m of (t?.watch ?? []).slice(0, 5)) console.log(`  watch: ${line(m)}`);
  const ps = plan.pickupStart;
  console.log(`  pick up and start: ${ps?.start ? `${ps.start.name} +${f2(ps.start.gain)}` : 'none'}; close calls ${(ps?.consider ?? []).map((c: any) => `${c.name} +${f2(c.gain)}`).join(', ') || 'none'}`);
});

/* ================================================================ PART B */

section('B1. NUMBERS BY SCREEN: Team, Matchup, Waivers as production sent them, Compare rebuilt (- is none)');
type Row = { name: string; team?: number | null; matchup?: number | null; waivers?: number | null; compare?: number | null };
const rows = new Map<string, Row>();
const row = (id: string, name?: string) => {
  let r = rows.get(id);
  if (!r) rows.set(id, (r = { name: name ?? names.get(id) ?? id }));
  return r;
};
for (const e of [...(lineupResp?.starters ?? []), ...(lineupResp?.bench ?? [])]) row(e.playerId, e.name).team = decisionOf(e);
const mineSlots = [...(matchupResp?.forecast?.slots ?? []).map((s: any) => s.mine), ...(matchupResp?.forecast?.bench?.mine ?? [])].filter(Boolean);
for (const p of mineSlots) row(p.playerId, p.name).matchup = p.projectedFinal ?? null;
for (const [id, f] of Object.entries<any>(waiversResp?.tiers?.weekFigures ?? {})) {
  const w = f.weeks?.[0];
  if (rows.has(id)) row(id, f.name).waivers = w == null ? null : w.out ? 0 : w.points;
}
for (const [id, v] of compareNums) row(id).compare = v;
let disagree = 0;
for (const [id, r] of [...rows.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const shown = [r.team, r.matchup, r.waivers, r.compare].filter((v): v is number => v != null);
  const ok = shown.length < 2 || Math.max(...shown) - Math.min(...shown) < 0.06;
  if (!ok) disagree++;
  console.log(`  ${r.name} (${id}) | Team ${f2(r.team)} | Matchup ${f2(r.matchup)} | Waivers ${f2(r.waivers)} | Compare ${f2(r.compare)}${ok ? '' : '  <-- DIFFERS'}`);
}
console.log(`  ${disagree} player(s) differ by more than rounding`);

section('B2. CONTRADICTIONS between screens');
{
  const drops = new Set<string>();
  const dropNames: string[] = [];
  for (const m of [...(waiversResp?.tiers?.doThese ?? []), ...(waiversResp?.tiers?.consider ?? [])]) {
    if (m.drop?.playerId) {
      drops.add(m.drop.playerId);
      dropNames.push(`${m.drop.name} (for ${m.name})`);
    }
  }
  console.log(`  Waivers drops: ${dropNames.join('; ') || 'none'}`);
  const offers = smartResp?.offers ?? [];
  const pkgs = buildResp?.packages ?? [];
  const idsIn = (side: any[] | undefined) => (side ?? []).map((p: any) => p.playerId ?? p.id).filter(Boolean);
  for (const o of offers) {
    const give = idsIn(o.give ?? o.userGives);
    const hit = give.filter((id: string) => drops.has(id));
    if (hit.length > 0) console.log(`  idea gives away a Waivers drop: ${hit.join(', ')} (${o.partner?.label ?? o.partnerLabel ?? '?'})`);
  }
  for (const pk of pkgs) {
    const give = idsIn(pk.give);
    const hit = give.filter((id: string) => drops.has(id));
    if (hit.length > 0) console.log(`  Build a trade gives a Waivers drop: ${hit.join(', ')} (${pk.label ?? pk.partner ?? '?'})`);
  }
  console.log(`  trade ideas shown: ${offers.length}; Build a trade packages: ${pkgs.length}`);
  const best = lineupResp?.swaps?.[0];
  if (best) {
    const byId = new Map(lineupInputs.map((i) => [i.player.id, i] as const));
    const a = byId.get(best.inPlayerId);
    const b = byId.get(best.outPlayerId);
    const cmp: any = a && b && profile ? compareStartSit([a, b], profile, { published }) : null;
    console.log(`  Best move ${best.inName} over ${best.outName} +${f2(best.gain)}; Compare (rebuilt) says ${cmp ? (cmp.tossUp ? 'TOSS-UP (contradiction)' : `start ${cmp.evaluations?.find((e: any) => e.playerId === cmp.recommendedPlayerId)?.name ?? 'nobody'}`) : 'not rebuilt'}`);
  } else {
    console.log(`  no Best move swap; toss-ups: ${(lineupResp?.tossUps ?? []).map((t: any) => `${t.inName} over ${t.outName}`).join(', ') || 'none'}`);
  }
  const ps = waiversResp?.pickupStart;
  console.log(`  Pick up and start: ${ps?.start ? `${ps.start.name} over ${ps.start.over?.name ?? ps.start.displaces?.name ?? '?'} +${f2(ps.start.gain)}` : 'none'}`);
  const hole = matchupResp?.forecast?.decision?.fills?.[0];
  console.log(`  Matchup hole fill: ${hole ? `${hole.inName} for ${hole.outName}` : 'none'}`);
}

section('B3. NORTH STAR scan of every string production sent');
{
  const hits = { sleeperNumber: new Set<string>(), emDash: new Set<string>(), disclaimer: new Set<string>() };
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (/Sleeper[^.]{0,20}\d|\d[^.]{0,6}\(?Sleeper/.test(v) && !/sleeper\.app|\/api\//i.test(v)) hits.sleeperNumber.add(`${path}: ${v.slice(0, 140)}`);
      if (v.includes('—') && v.length > 1) hits.emDash.add(`${path}: ${v.slice(0, 140)}`);
      if (/\b(note:|tip:|this is an estimate|learn more|for reference only)/i.test(v)) hits.disclaimer.add(`${path}: ${v.slice(0, 140)}`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [key, v] of Object.entries(screens)) {
    if (key.includes('support-snapshot')) continue;
    try {
      walk(JSON.parse(v.body), key.replace(/\?.*/, ''));
    } catch {
      /* not JSON */
    }
  }
  for (const [label, set] of Object.entries(hits)) {
    console.log(`  ${label}: ${set.size}`);
    for (const line of [...set].slice(0, 12)) console.log(`    ${line}`);
  }
}
