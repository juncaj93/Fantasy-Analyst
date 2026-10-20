/**
 * Pick up and start, round 3 (20 October 2026): the McLaughlin roster check,
 * the replay with every free agent's gain, and the data cost.
 *
 *   node --experimental-transform-types --no-warnings scripts/pickup-roster-report.ts <leagueId> <sleeperLeagueId> gather <out.json>
 *   node --experimental-transform-types --no-warnings scripts/pickup-roster-report.ts <leagueId> <sleeperLeagueId> report [<before.json>]
 *
 * `gather` runs the Team screen's two decision gatherers against production
 * and writes the rows they read; it is all the code before the round is asked
 * to do. `report` does the same on this checkout, then reads, once each:
 *
 *  1. the roster timeline for Jaleel McLaughlin: the app's stored roster row
 *     and when it was written, every league sync logged on Sunday, the stored
 *     transactions that moved him, Sleeper's own transactions and rosters, and
 *     what the waiver clock said about him at 16:48 UTC Sunday;
 *  2. the pick-up-and-start call now, with every scanned free agent's gain.
 *
 * Reads only. A gatherer that would write a cache row is answered as if the
 * write succeeded and nothing is sent.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { d1Http } from './lib/d1Http.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { gatherLineupInputs, gatherWaiverInputs } from '../src/server/services/decisionInputs.ts';
import type { PreparedStatement } from '../src/server/db.ts';

const [leagueId, sleeperLeagueId, mode, file] = process.argv.slice(2);
if (!leagueId || !sleeperLeagueId || (mode !== 'gather' && mode !== 'report')) {
  throw new Error('usage: pickup-roster-report.ts <leagueId> <sleeperLeagueId> gather <out.json> | report [<before.json>]');
}

const source = await d1Http();
const skipped: string[] = [];
const noop = (sql: string): PreparedStatement =>
  ({
    bind: () => noop(sql),
    first: async () => (skipped.push(sql.slice(0, 50)), null),
    all: async () => (skipped.push(sql.slice(0, 50)), { results: [], success: true, meta: {} }),
    run: async () => (skipped.push(sql.slice(0, 50)), { results: [], success: true, meta: {} }),
  }) as unknown as PreparedStatement;
const db = Object.assign(Object.create(source) as typeof source, {
  prepare: (sql: string) => (/^\s*(select|with)\b/i.test(sql) ? source.prepare(sql) : noop(sql)),
  batch: async (list: unknown[]) => (skipped.push(`batch of ${list.length}`), []),
  rowsRead: () => source.rowsRead(),
  statements: () => source.statements(),
});
const sleeper = new SleeperClient({});

const measure = async <T,>(run: () => Promise<T>) => {
  const r0 = db.rowsRead();
  const s0 = db.statements();
  try {
    return { value: await run(), rows: db.rowsRead() - r0, statements: db.statements() - s0, error: null as string | null };
  } catch (err) {
    return { value: null, rows: db.rowsRead() - r0, statements: db.statements() - s0, error: String(err).slice(0, 300) };
  }
};
const lineupRead = await measure(() => gatherLineupInputs(db, sleeper, leagueId));
const waiverRead = await measure(() => gatherWaiverInputs(db, sleeper, leagueId));
const cost = {
  lineup: lineupRead.rows,
  waivers: waiverRead.rows,
  scanned: waiverRead.value?.pool.scanned ?? null,
  errors: [lineupRead.error, waiverRead.error].filter(Boolean),
};
if (skipped.length) console.log(`writes not sent (reads only): ${[...new Set(skipped)].join(' | ')}`);
console.log(`rows read: lineup ${cost.lineup}, waivers ${cost.waivers}, scanned ${cost.scanned}${cost.errors.length ? `, errors ${cost.errors.join('; ')}` : ''}`);
if (mode === 'gather') {
  writeFileSync(file!, JSON.stringify(cost));
  process.exit(0);
}

const { assembleWaiverPlan } = await import('../src/core/waivers/assemble.ts');
const { pickupStateFor, waiverRulesOf } = await import('../src/core/waivers/clearWindow.ts');
const f2 = (v: number | null | undefined) => (v == null ? '-' : v.toFixed(2));
const NAME = (process.env.PLAYER_NAME || 'Jaleel McLaughlin').toLowerCase();
const SUNDAY = { picker: '2026-10-18T16:48:00Z', probe: '2026-10-18T18:08:21Z', from: '2026-10-18T00:00:00Z', to: '2026-10-19T00:00:00Z' };

/* ======================================================== 1. THE ROSTER CHECK */
console.log(`\n################ 1. ROSTER CHECK: ${NAME} ################`);
const r1 = db.rowsRead();
const players = (
  await db.prepare('SELECT id, sleeper_player_id, full_name, team, position FROM players WHERE lower(full_name) = ?').bind(NAME).all<Record<string, unknown>>()
).results;
console.log(`player rows with that name: ${players.map((p) => `id ${p['id']} sleeper ${p['sleeper_player_id']} ${p['team']} ${p['position']}`).join('; ') || 'none'}`);
const ids = players.flatMap((p) => [String(p['id']), String(p['sleeper_player_id'] ?? '')]).filter((x) => x && x !== 'null');
const league = await db.prepare('SELECT last_synced_at FROM leagues WHERE id = ?').bind(leagueId).first<Record<string, unknown>>();
console.log(`app league row last synced: ${league?.['last_synced_at'] ?? '?'}`);
const rosters = (
  await db.prepare('SELECT roster_id, owner_name, is_mine, players_json, updated_at FROM rosters WHERE league_id = ?').bind(leagueId).all<Record<string, unknown>>()
).results;
for (const r of rosters) {
  const held = (JSON.parse(String(r['players_json'] ?? '[]')) as string[]).filter((id) => ids.includes(id));
  if (held.length) console.log(`app roster row holding him: roster ${r['roster_id']} (${r['owner_name']}${Number(r['is_mine']) === 1 ? ', Alex' : ''}) as id ${held.join(',')}, row written ${r['updated_at']}`);
}
if (!rosters.some((r) => (JSON.parse(String(r['players_json'] ?? '[]')) as string[]).some((id) => ids.includes(id)))) console.log('no app roster row holds him');
console.log(`roster rows written: ${[...new Set(rosters.map((r) => String(r['updated_at'])))].join(', ')}`);
const syncs = (
  await db
    .prepare("SELECT status, detail, started_at, finished_at FROM sync_log WHERE kind = 'league' AND started_at >= ? AND started_at < ? ORDER BY started_at")
    .bind(SUNDAY.from, SUNDAY.to)
    .all<Record<string, unknown>>()
).results;
console.log(`league syncs logged Sunday (UTC): ${syncs.map((s) => `${String(s['started_at']).slice(11, 19)} ${s['status']}`).join(', ') || 'none'}`);
const stored = (
  await db
    .prepare('SELECT transaction_id, week, txn_type, status, created_at_ms, roster_ids_json, adds_json, drops_json, fetched_at FROM league_transactions WHERE league_id = ? AND week >= 5')
    .bind(leagueId)
    .all<Record<string, unknown>>()
).results.filter((t) => ids.some((id) => String(t['adds_json'] ?? '').includes(`"${id}"`) || String(t['drops_json'] ?? '').includes(`"${id}"`)));
const iso = (ms: unknown) => (ms == null ? '?' : new Date(Number(ms)).toISOString());
console.log('stored transactions that moved him:');
for (const t of stored) console.log(`  wk ${t['week']} ${t['txn_type']} ${t['status']} at ${iso(t['created_at_ms'])} adds ${t['adds_json']} drops ${t['drops_json']} (stored ${t['fetched_at']})`);
if (stored.length === 0) console.log('  none');
console.log(`(roster check read ${db.rowsRead() - r1} rows)`);

const get = async (path: string) => (await fetch(`https://api.sleeper.app/v1${path}`)).json();
const sleeperIds = players.map((p) => String(p['sleeper_player_id'] ?? p['id']));
const liveRaw = await get(`/league/${sleeperLeagueId}/rosters`).catch(() => []);
const live = (Array.isArray(liveRaw) ? liveRaw : []) as { roster_id: number; players: string[] | null }[];
console.log(`Sleeper now: ${live.filter((r) => (r.players ?? []).some((id) => sleeperIds.includes(id))).map((r) => `roster ${r.roster_id}`).join(', ') || 'on nobody'}`);
const moves: { at: number; text: string }[] = [];
for (const week of [5, 6, 7]) {
  const raw = await get(`/league/${sleeperLeagueId}/transactions/${week}`).catch(() => []);
  const txns = (Array.isArray(raw) ? raw : []) as {
    type: string;
    status: string;
    created: number;
    status_updated: number;
    adds: Record<string, number> | null;
    drops: Record<string, number> | null;
    settings: { waiver_bid?: number } | null;
  }[];
  for (const t of txns) {
    for (const id of sleeperIds) {
      if (t.adds?.[id] != null) moves.push({ at: t.status_updated, text: `wk ${week} ${t.type} ${t.status}: added by roster ${t.adds[id]}${t.settings?.waiver_bid != null ? ` for $${t.settings.waiver_bid}` : ''} (created ${new Date(t.created).toISOString()}, done ${new Date(t.status_updated).toISOString()})` });
      if (t.drops?.[id] != null) moves.push({ at: t.status_updated, text: `wk ${week} ${t.type} ${t.status}: dropped by roster ${t.drops[id]} (done ${new Date(t.status_updated).toISOString()})` });
    }
  }
}
console.log('Sleeper transactions for him, oldest first:');
for (const m of moves.sort((a, b) => a.at - b.at)) console.log(`  ${m.text}`);
if (moves.length === 0) console.log('  none');

/* What the waiver clock said at the picker's time, from the drops the app had stored. */
const req = waiverRead.value?.request;
const rules = req?.waiverWindow?.rules ?? waiverRulesOf(((await get(`/league/${sleeperLeagueId}`)) as { settings: Record<string, unknown> }).settings);
const appDrop = ids.map((id) => req?.waiverWindow?.drops.get(id)).find((x) => x != null) ?? null;
const sleeperDrop = moves.filter((m) => m.text.includes('dropped') && m.at <= Date.parse(SUNDAY.picker)).map((m) => new Date(m.at).toISOString()).pop() ?? null;
const input = req ? [...req.rosterInputs, ...req.candidateInputs].find((i) => i.player.fullName.toLowerCase() === NAME) : undefined;
if (rules) {
  for (const [label, dropped] of [['app\'s stored drop', appDrop], ['Sleeper\'s drop', sleeperDrop]] as const) {
    const state = pickupStateFor({ droppedAt: dropped, kickoff: input?.kickoff ?? null, hasTeam: true, now: new Date(SUNDAY.picker), rules });
    console.log(`waiver clock at 16:48 UTC Sunday from the ${label} (${dropped ?? 'none'}): ${state.state}${state.until ? ` until ${state.until} (${state.reason})` : ''}`);
  }
  console.log(`league rules: clear ${rules.clearDays} days, run day ${rules.runDay} (Mon = 0), FAAB ${rules.usesFaab}`);
}
console.log(`his kickoff in the app this week: ${input?.kickoff ?? 'not in this scan'}`);

/* ================================================== 2. THE CALL, EVERY GAIN */
console.log('\n################ 2. PICK UP AND START, NOW ################');
if (!req) throw new Error('waivers gatherer failed');
const now = new Date(process.env.REPLAY_NOW || Date.now());
const assembly = await assembleWaiverPlan({ ...req, now });
const plan = assembly.pickupStart;
console.log(`as of ${now.toISOString()}, week ${req.week}; free agents scanned ${req.candidateInputs.length}; open spots ${Math.max(0, req.shape.totalStarters + req.shape.benchSlots - req.rosterInputs.filter((i) => !req.reserveIds.includes(i.player.id)).length)}`);
if (!plan) {
  console.log('no call could be made');
} else {
  const nameOf = new Map([...req.rosterInputs, ...req.candidateInputs].map((i) => [i.player.id, i.player.fullName] as const));
  console.log(`best owned lineup ${plan.bestOwned.toFixed(2)}: ${plan.bestOwnedSlots.map((s) => `${s.slot} ${nameOf.get(s.playerId) ?? s.playerId}`).join(', ')}`);
  const withGain = plan.audit.filter((a) => a.gain != null).length;
  console.log(`audit: ${plan.audit.length} scanned free agents, ${withGain} with a gain (the rest have no number this week)`);
  const counts = new Map<string, number>();
  for (const a of plan.audit) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  console.log(`by status: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('  player                     pos  number  basis      gain     margin   status');
  for (const a of plan.audit.slice(0, 20)) {
    console.log(`  ${a.name.padEnd(26)} ${a.position.padEnd(4)} ${f2(a.points).padStart(6)}  ${String(a.basis).padEnd(9)} ${f2(a.gain).padStart(7)}  ${f2(a.margin).padStart(7)}   ${a.status}`);
  }
  const s = plan.start;
  console.log(
    `BEST MOVE WOULD SAY: ${
      s
        ? `Pick up and start ${s.name}${s.over ? ` over ${s.over.name}` : ''} · ${s.points.toFixed(1)}${s.over?.points != null ? ` vs ${s.over.points.toFixed(1)}` : ''} projected · gain ${f2(s.gain)}` +
          `${s.drop ? ` · drop ${s.drop.name}` : s.pickDrop ? ` · Pick your drop (${s.pickDrop.map((d) => d.name).join(', ')})` : ''}${s.starterOut ? ' · Starter out' : ''}`
        : 'no pickup clears 0.5: as before'
    }`,
  );
  console.log(`Worth considering (ties and gains under 0.5): ${plan.consider.map((c) => `${c.name} gain ${f2(c.gain)}`).join('; ') || 'none'}`);
  console.log(`not now (on a clock or playing): ${plan.notNow.map((n) => `${n.name} +${f2(n.gain)} (${n.why})`).join('; ') || 'none'}`);
}
console.log(`tiers: Do this ${(assembly.tiers?.doThese ?? []).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);
console.log(`       Worth considering ${(assembly.tiers?.consider ?? []).map((m) => `${m.name} (${m.reason})`).join('; ') || 'none'}`);

/* ============================================================== 3. THE COST */
const beforePath = file;
if (beforePath && existsSync(beforePath)) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  console.log('\n################ 3. DATA COST: D1 rows per Team load (lineup + waivers) ################');
  console.log(`before: lineup ${before.lineup}, waivers ${before.waivers}, total ${before.lineup + before.waivers} (scanned ${before.scanned})`);
  console.log(`after:  lineup ${cost.lineup}, waivers ${cost.waivers}, total ${cost.lineup + cost.waivers} (scanned ${cost.scanned})`);
}
