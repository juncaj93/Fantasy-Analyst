/**
 * Waivers round 2 on Alex's real roster: before and after, from one snapshot.
 *
 *   node --experimental-transform-types --no-warnings scripts/waiver-round2-report.ts <snapshot.json> <sleeperDir> [oldCodeDir]
 *
 * One production Waivers support snapshot is rebuilt into its assembly request
 * once (`waiverRequestFromSnapshot`) and handed to:
 *
 * - **before**: the code before this round (`oldCodeDir`, a checkout of the
 *   last commit before it), which ignores the round-2 inputs;
 * - **production**: the board the deployed code drew, as captured;
 * - **with full history**: the new code, with the earlier seasons' rival rows
 *   built from Sleeper's public transactions in `<sleeperDir>`, plus season
 *   points and injury notes from the same public data wherever production had
 *   not stored them yet. This is the board once the Wednesday manager refresh
 *   and the three-hourly league read have run.
 *
 * Names: the snapshot calls every manager `Manager N`. The roster id survives
 * aliasing, so the real Sleeper display name (public) is put back beside it.
 *
 * Read-only. Prints text.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waiverRequestFromSnapshot } from '../src/core/support/waiverSnapshot.ts';
import { assembleWaiverPlan, type WaiverAssemblyRequest, type WaiverRound2Inputs } from '../src/core/waivers/assemble.ts';
import { buildRivalSeasonAggregates, historyFromTransactions, type RivalSeasonAggregate } from '../src/core/waivers/rivalHistory.ts';
import { playerNotesOf, readPlayerNotes } from '../src/core/sleeper/playerNotes.ts';
import { eliteBacks } from '../src/core/waivers/dropScore.ts';
import type { WaiverTiersView, TierRow } from '../src/core/waivers/tierPlan.ts';

const [snapshotFile, dir, ...oldDirs] = process.argv.slice(2);
if (!snapshotFile || !dir) {
  console.error('usage: waiver-round2-report.ts <snapshot.json> <sleeperDir> [oldCodeDir]');
  process.exit(1);
}
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const has = (name: string) => existsSync(join(dir, name));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as any;
const { request } = waiverRequestFromSnapshot(snapshot);

/* Real names, by roster id, from Sleeper's public league data. */
const rootLeague = process.env.SLEEPER_LEAGUE_ID || '1385016656425668608';
const users = read<{ user_id: string; display_name: string }[]>(`users_${rootLeague}.json`);
const rosters = read<{ roster_id: number; owner_id: string }[]>(`rosters_${rootLeague}.json`);
const nameOfUser = new Map(users.map((u) => [u.user_id, u.display_name]));
const realByRoster = new Map(rosters.map((r) => [r.roster_id, nameOfUser.get(r.owner_id) ?? `Roster ${r.roster_id}`]));
const aliasToRoster = new Map<string, number>((snapshot.decision.inputs.rosters as { rosterId: number; ownerName: string | null }[]).map((r) => [r.ownerName ?? '', r.rosterId]));
const real = (alias: string) => {
  const id = aliasToRoster.get(alias);
  return id != null ? `${realByRoster.get(id) ?? alias}` : alias;
};
const players = read<Record<string, { full_name?: string; position?: string; team?: string }>>('players.json');
const nameOf = (id: string) => players[id]?.full_name ?? id;

function line(row: TierRow): string {
  const bid =
    row.bid.kind === 'free'
      ? 'free agent, no bid'
      : row.bid.kind === 'claim'
        ? `$${row.bid.recommended} (range $${row.bid.low}-${row.bid.high})${row.bid.posture ? ` [${row.bid.posture}]` : ''}`
        : 'no bid';
  const rivals = row.bid.likely.length
    ? row.bid.likely.map((r) => `${real(r.name)} ${Math.round(r.chance * 100)}%${r.why ? ` (${r.why})` : ''}`).join(', ')
    : 'none likely';
  const best = row.bestDrops?.length ? `\n      best drops: ${row.bestDrops.map((c, i) => `${i + 1}. ${c.name} ${c.position ?? ''} · ${c.stat ?? ''}`).join('  ')}` : '';
  const drop = row.needsSpot
    ? `none honest: you need a spot first; cheapest: ${row.needsSpot.map((c) => `${c.name} (${c.reason})`).join('; ')}`
    : row.drop
      ? `${row.drop.viaReserve ? 'move to IR: ' : ''}${row.drop.name}${row.drop.reason ? ` [${row.drop.reason}]` : ''}`
      : 'open spot';
  return [
    `  ${row.name.padEnd(22)} ${row.position.padEnd(3)} +${row.gain.toFixed(1)}  ${row.reason}`,
    `      drop: ${drop}${best}`,
    `      bid: ${bid}; rivals: ${rivals}`,
    `      why the bid: ${row.bid.reason.replace(/Manager \d+/g, (m) => real(m))}`,
    ...(row.alternatives.length ? [`      also fits: ${row.alternatives.join(', ')}`] : []),
    ...(row.competesWith.length ? [`      same spot as: ${row.competesWith.join(', ')}`] : []),
  ].join('\n');
}

function board(label: string, tiers: WaiverTiersView | null | undefined) {
  console.log(`\n=== ${label} ===`);
  if (!tiers) {
    console.log('  (no tiers)');
    return;
  }
  const doThese = tiers.doThese ?? (tiers.doThis ? [tiers.doThis] : []);
  console.log(`DO THIS (${doThese.length}):`);
  for (const r of doThese) console.log(line(r));
  console.log(`WORTH CONSIDERING (${tiers.consider.length}):`);
  for (const r of tiers.consider) console.log(line(r));
  console.log(`WATCH LIST (${tiers.watch.length}):`);
  for (const r of tiers.watch) console.log(line(r));
  if (tiers.excluded?.length) console.log(`NEVER OFFERED: ${tiers.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}`);
  if (tiers.dropScores?.length) {
    console.log('DROP SCORES (lowest is cut first):');
    tiers.dropScores.forEach((d, i) => console.log(`  ${String(i + 1).padStart(2)}. ${d.name.padEnd(22)} ${d.score.toFixed(2).padStart(6)}  ${d.protectedAs ? `[${d.protectedAs}] ` : ''}${d.reason}`));
    /* Every factor for the players Alex named, so the ranking can be checked by hand. */
    for (const name of ["Tre' Harris", 'Brian Robinson', 'Emmett Johnson', 'Emeka Egbuka']) {
      const d = tiers.dropScores.find((x) => x.name === name);
      if (!d) continue;
      const dead = d.deadSpot ? ' DEAD SPOT' : '';
      console.log(`  FACTORS ${name}:${dead} score ${d.score.toFixed(2)}${d.parts ? ` parts ${JSON.stringify(d.parts)}` : ''}${d.factors ? ` signals ${JSON.stringify(d.factors)}` : ''}`);
    }
  }
  const drops = doThese.concat(tiers.consider).map((r) => r.drop?.name).filter(Boolean);
  console.log(`distinct drops across Do this and Worth considering: ${new Set(drops).size} of ${drops.length}`);
  /* The two cases Alex named, checked on every board. */
  const everyRow = [...doThese, ...tiers.consider, ...tiers.watch];
  const named = everyRow.filter((r) => r.drop && !r.drop.viaReserve).map((r) => r.drop!.name);
  const shared = [...new Set(named.filter((n, i) => named.indexOf(n) !== i))];
  console.log(`SAME-DROP CHECK (every row): ${shared.length === 0 ? 'no player is named as the drop on two rows' : `shared: ${shared.map((n) => `${n} on ${everyRow.filter((r) => r.drop?.name === n).map((r) => r.name).join(' and ')}`).join('; ')}`}`);
  const mc = everyRow.filter((r) => r.drop?.name === 'Ladd McConkey').map((r) => r.name);
  console.log(`MCCONKEY CHECK: ${mc.length === 0 ? 'Ladd McConkey is nobody\'s drop' : `Ladd McConkey is the drop for ${mc.join(', ')}`}`);
  for (const r of doThese) console.log(`SPOT: ${r.name} uses ${r.drop?.viaReserve ? `an IR move (${r.drop.name} to IR)` : r.drop ? `a drop (${r.drop.name})` : 'an open spot'}`);
  for (const r of tiers.consider.filter((x) => x.needsSpot)) console.log(`SPOT: ${r.name} needs a spot first`);
}

// ---------------------------------------------------------------- inputs --
const r2: WaiverRound2Inputs | null = snapshot.decision.inputs.round2 ?? null;
console.log('=== WHAT PRODUCTION HAD FOR ROUND 2 ===');
if (!r2) console.log('  no round-2 inputs in the capture (captured before the deploy?)');
else {
  const seasons = Object.entries(r2.managerSeasons).map(([roster, rows]) => `${realByRoster.get(Number(roster)) ?? roster}: ${rows.map((r) => r.season).join('+') || 'none'}`);
  console.log(`  rival seasons stored, by manager: ${seasons.join('; ')}`);
  console.log(`  season points through week ${r2.seasonPointsThrough} (${Object.keys(r2.seasonPoints).length} players)`);
  console.log(`  Sleeper depth order for ${Object.keys(r2.depthOrder).length} players, injury notes for ${Object.keys(r2.injuryNotes).length}`);
  const held = Object.entries(r2.heldSince).map(([id, h]) => `${nameOf(id)} since week ${h.week} (${h.how})`);
  console.log(`  weeks held: ${held.join('; ') || 'none from transactions'}; drafted: ${r2.drafted.map(nameOf).join(', ')}`);
}

// ------------------------------------------------- full history, public data --
const chain: { id: string; season: string }[] = [];
for (let id: string | null = rootLeague; id && id !== '0' && has(`league_${id}.json`); ) {
  const l: { season: string; previous_league_id: string | null } = read(`league_${id}.json`);
  chain.push({ id, season: l.season });
  id = l.previous_league_id;
}
console.log(`\nseasons in the previous_league_id chain: ${chain.length} (${chain.map((c) => c.season).join(', ')})`);
const season = String(request.season);
const rowsTx: { season: string; transaction: Record<string, unknown> }[] = [];
const userBySeasonRoster = new Map<string, string>();
const seasonsByUser = new Map<string, string[]>();
for (const link of chain) {
  if (link.season === season) continue;
  for (const r of read<{ roster_id: number; owner_id: string }[]>(`rosters_${link.id}.json`)) {
    userBySeasonRoster.set(`${link.season}|${r.roster_id}`, r.owner_id);
    seasonsByUser.set(r.owner_id, [...(seasonsByUser.get(r.owner_id) ?? []), link.season]);
  }
  for (let w = 1; w <= 18; w++) if (has(`tx_${link.id}_${w}.json`)) for (const t of read<Record<string, unknown>[]>(`tx_${link.id}_${w}.json`)) rowsTx.push({ season: link.season, transaction: t });
}
const { claims, adds } = historyFromTransactions(
  rowsTx as never,
  (s, r) => userBySeasonRoster.get(`${s}|${r}`) ?? null,
  (id) => players[id]?.position ?? null,
);
const prior = buildRivalSeasonAggregates({ claims, adds, seasonsByUser, budgetTotal: 100 });
const rosterOfUser = new Map(rosters.map((r) => [r.owner_id, r.roster_id]));

const full: WaiverRound2Inputs = r2
  ? JSON.parse(JSON.stringify(r2))
  : { managerSeasons: {}, seasonPoints: {}, seasonPointsThrough: 0, heldSince: {}, drafted: [], injuryNotes: {}, depthOrder: {} };
for (const row of prior) {
  const rosterId = rosterOfUser.get(row.userId);
  if (rosterId == null) continue;
  const list: RivalSeasonAggregate[] = (full.managerSeasons[String(rosterId)] ??= []);
  if (!list.some((x) => x.season === row.season)) list.push({ ...row, userId: String(rosterId) });
}
if (full.seasonPointsThrough === 0) {
  const league = read<{ scoring_settings: Record<string, number> }>(`league_${rootLeague}.json`);
  const through = Number(request.week) - 1;
  const points: Record<string, number[]> = {};
  for (let w = 1; w <= through; w++) {
    if (!has(`stats_${season}_${w}.json`)) continue;
    for (const [id, s] of Object.entries(read<Record<string, Record<string, number>>>(`stats_${season}_${w}.json`))) {
      let t = 0;
      for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && league.scoring_settings[k] != null) t += league.scoring_settings[k]! * v;
      if (Math.abs(t) >= 0.05) (points[id] ??= Array.from({ length: through }, () => 0))[w - 1] = Math.round(t * 10) / 10;
    }
  }
  full.seasonPoints = points;
  full.seasonPointsThrough = through;
  console.log(`(season points rebuilt from Sleeper's public weekly stats, weeks 1 to ${through})`);
}
if (Object.keys(full.injuryNotes).length === 0) {
  const notes = readPlayerNotes(playerNotesOf(players as never, new Date()));
  full.injuryNotes = notes.injury;
  full.depthOrder = notes.depth;
  console.log(`(depth order and injury notes from Sleeper's public player file: ${Object.keys(notes.depth).length} and ${Object.keys(notes.injury).length})`);
}

/* The elite-back rule, on the season points. */
const totals = new Map(Object.entries(full.seasonPoints).map(([id, w]) => [id, { total: w.reduce((a, b) => a + b, 0), games: w.filter((x) => x !== 0).length }] as const));
const elite = eliteBacks(totals, (id) => players[id]?.position === 'RB');
console.log(`elite backs (top 12 RB by points a game, 2+ games): ${[...elite].map(nameOf).join(', ')}`);
for (const n of ['Bijan Robinson', 'Kenneth Walker', 'Braelon Allen', 'Will Shipley']) {
  const id = Object.entries(players).find(([, p]) => p.full_name === n && p.position === 'RB')?.[0];
  console.log(`  ${n}: ${id && elite.has(id) ? 'elite' : 'not elite'}`);
}

// ---------------------------------------------------------------- boards --
/* Each earlier build, oldest first, on the same request: `label=dir`, or a bare dir. */
for (const arg of oldDirs) {
  const [label, oldDir] = arg.includes('=') ? (arg.split('=') as [string, string]) : ['the code before this round', arg];
  const old = (await import(pathToFileURL(join(oldDir, 'src/core/waivers/assemble.ts')).href)) as { assembleWaiverPlan: (r: WaiverAssemblyRequest) => Promise<{ tiers: WaiverTiersView | null }> };
  const before = await old.assembleWaiverPlan({ ...request, round2: full } as WaiverAssemblyRequest);
  board(`BEFORE: ${label}, same inputs`, before.tiers);
}
board('PRODUCTION: what the deployed Waivers screen drew', snapshot.decision.output.tiers);
const after = await assembleWaiverPlan({ ...request, round2: full });
board('AFTER, WITH FULL HISTORY: once the Wednesday rival rows and the season points are stored', after.tiers);

const reads = after.tiers?.bidderReads ?? [];
if (reads.length) {
  console.log('\nRIVAL READS (rate = chance he bids on a player somebody bids on, before need):');
  for (const r of reads) {
    const interest = Object.entries(r.interest).map(([p, v]) => `${p} x${v}`).join(' ');
    console.log(`  ${real(r.name).padEnd(15)} rate ${(r.rate * 100).toFixed(0)}%  seasons ${r.seasons.join('+') || '-'} (${r.source})  FAAB left ${r.remaining ?? '?'}  chase x${r.chase}  ${interest}`);
  }
}
