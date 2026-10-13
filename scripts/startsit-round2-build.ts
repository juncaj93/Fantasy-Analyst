/**
 * Start/Sit round 2: gather production data for the audit and the backtest.
 *
 *   node --experimental-transform-types --no-warnings scripts/startsit-round2-build.ts <dir>
 *
 * Reads `<dir>/state.json`, `<dir>/league.json` and `<dir>/stats<w>.json`
 * (Sleeper's public answers, fetched by the probe) and, through the read-only
 * D1 adapter, the stored prop snapshots, game lines, usage weeks, players and
 * the fixture list. Writes:
 *
 *   backtest-inputs.json  every priced player-week of the completed weeks, as
 *                         the engine would have seen it before kickoff (props
 *                         from the last snapshot before the game, usage and
 *                         the defence table from earlier weeks only), with the
 *                         league-scored actual points;
 *   current.json          this week's priced players and props (pill counts,
 *                         conversion audit), the stale-prop check, the
 *                         weather coverage of this week's fixtures;
 *   cost.json             rows D1 reported reading for all of the above.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { d1Http } from './lib/d1Http.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { UsageRepo } from '../src/server/repos/usage.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { defenseTendenciesFromRows, roleMetricsFrom, TENDENCY_WINDOW_WEEKS } from '../src/server/services/usageService.ts';
import { captureStartSitInputs } from '../src/core/support/inseason.ts';
import { DEFENSE } from '../src/core/startsit/defense.ts';
import { tableRoofFor } from '../src/core/nfl/roofs.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { StoredUsageWeek } from '../src/server/repos/usage.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: startsit-round2-build.ts <dir>');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const state = read('state.json') as { season: string; week: number; season_type: string };
const league = read('league.json') as { scoring_settings: Record<string, number>; roster_positions: string[] };
const season = String(state.season);
const currentWeek = Number(state.week);
/*
 * LOCAL_SEED=1 runs the same code over the seeded demo database, for a dry run
 * with no production access. The probe never sets it.
 */
async function localDb() {
  const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
  const { seedDemoData } = await import('../src/devserver/seed.ts');
  const { readdirSync } = await import('node:fs');
  const raw = new NodeSqliteDatabase(':memory:');
  const migrations = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) await raw.exec(readFileSync(join(migrations, f), 'utf8'));
  await seedDemoData(raw);
  return Object.assign(raw, { rowsRead: () => 0, statements: () => 0 });
}
const db = process.env.LOCAL_SEED ? await localDb() : await d1Http();

/* ---------------------------------------------------------------- props */
type Snap = { id: number; event_id: string; game_start: string; fetched_at: string; total: number | null; spread: number | null; spread_team: string | null };
const snaps = (await db
  .prepare(
    `SELECT ps.id, ps.event_id, ps.game_start, ps.fetched_at,
            json_extract(ps.raw_json, '$.gameLines.total') AS total,
            json_extract(ps.raw_json, '$.gameLines.spread') AS spread,
            json_extract(ps.raw_json, '$.gameLines.spreadTeam') AS spread_team
       FROM prop_snapshots ps WHERE ps.scope = 'week' AND ps.game_start >= ?`,
  )
  .bind(`${season}-08-25`)
  .all<Snap>()).results;
type Event = { event_id: string; home_team: string | null; away_team: string | null; kickoff: string | null; game_total: number | null; spread: number | null; spread_team: string | null; lines_seen_at: string | null };
const events = new Map(
  (await db.prepare('SELECT event_id, home_team, away_team, kickoff, game_total, spread, spread_team, lines_seen_at FROM vegas_events WHERE kickoff >= ?').bind(`${season}-08-25`).all<Event>()).results.map((e) => [e.event_id, e]),
);

/** The last snapshot of each game taken before it kicked off, and the newest of each game overall. */
const preKick = new Map<string, Snap>();
const newest = new Map<string, Snap>();
for (const s of snaps) {
  if (s.fetched_at < s.game_start && (!preKick.get(s.event_id) || preKick.get(s.event_id)!.fetched_at < s.fetched_at)) preKick.set(s.event_id, s);
  if (!newest.get(s.event_id) || newest.get(s.event_id)!.fetched_at < s.fetched_at) newest.set(s.event_id, s);
}
const wanted = new Set([...preKick.values(), ...newest.values()].map((s) => s.id));
type PropRow = { snapshot_id: number; player_id: string; source_player_name: string; market: string; line: number | null; over_price: number | null; under_price: number | null; book_count: number; books_json: string; consensus_method: string; implied_probability: number | null };
const propRows: PropRow[] = [];
const ids = [...wanted];
for (let i = 0; i < ids.length; i += 80) {
  const batch = ids.slice(i, i + 80);
  propRows.push(
    ...(await db
      .prepare(
        `SELECT snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, implied_probability
           FROM player_props WHERE player_id IS NOT NULL AND snapshot_id IN (${batch.map(() => '?').join(',')})`,
      )
      .bind(...batch)
      .all<PropRow>()).results,
  );
}
const bySnap = new Map<number, PropRow[]>();
for (const r of propRows) (bySnap.get(r.snapshot_id) ?? bySnap.set(r.snapshot_id, []).get(r.snapshot_id)!).push(r);
const toProp = (r: PropRow, s: Snap): PlayerProp => ({
  playerId: r.player_id,
  sourcePlayerName: r.source_player_name,
  market: r.market as PlayerProp['market'],
  line: r.line,
  overPrice: r.over_price,
  underPrice: r.under_price,
  bookCount: Number(r.book_count ?? 0),
  consensusMethod: r.consensus_method as PlayerProp['consensusMethod'],
  books: (() => { try { return JSON.parse(r.books_json); } catch { return []; } })(),
  impliedProbability: r.implied_probability,
  snapshot: { fetchedAt: s.fetched_at, total: s.total, spread: s.spread, spreadTeam: s.spread_team },
});

/* -------------------------------------------------------------- players */
const playerIds = [...new Set(propRows.map((r) => r.player_id))];
const players = await new PlayerRepo(db).listByIds(playerIds);

/* ------------------------------------------------------------- weeks */
const weekOf = (iso: string): number | null => {
  // NFL weeks run Thursday to Monday; read the week off the fixture list instead where it can.
  return fixtureWeek.get(iso.slice(0, 10)) ?? null;
};
const schedule = new NflScheduleRepo(db);
const fixtures: Awaited<ReturnType<typeof schedule.forWeek>>[] = [];
const fixtureWeek = new Map<string, number>();
for (let w = 1; w <= currentWeek; w++) {
  const rows = await schedule.forWeek(season, w);
  fixtures[w] = rows;
  for (const r of rows) if (r.kickoff) fixtureWeek.set(r.kickoff.slice(0, 10), w);
}
const teamGame = (w: number, team: string) => fixtures[w]?.find((f) => f.team.toUpperCase() === team.toUpperCase()) ?? null;

/* -------------------------------------------------------------- usage */
const usageRows: StoredUsageWeek[] = await new UsageRepo(db).leagueWeeksSince(season, 1);
const usageBy = new Map<string, StoredUsageWeek[]>();
for (const r of usageRows) (usageBy.get(r.playerId) ?? usageBy.set(r.playerId, []).get(r.playerId)!).push(r);

/* ------------------------------------------------------ actual points */
const scoring = league.scoring_settings;
const actualOf = (w: number): Map<string, number> => {
  const file = join(dir, `stats${w}.json`);
  const out = new Map<string, number>();
  if (!existsSync(file)) return out;
  const stats = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, number>>;
  for (const [id, line] of Object.entries(stats)) {
    if (!line || !(Number(line.gp ?? 0) > 0)) continue;
    let pts = 0;
    for (const [k, v] of Object.entries(scoring)) if (typeof line[k] === 'number') pts += line[k]! * v;
    out.set(id, Math.round(pts * 100) / 100);
  }
  return out;
};

/* --------------------------------------------------- the inputs, per week */
function inputFor(playerId: string, snap: Snap, w: number): StartSitInput | null {
  const player = players.get(playerId);
  if (!player || !['QB', 'RB', 'WR', 'TE'].includes(player.position)) return null;
  const event = events.get(snap.event_id);
  const team = player.team.toUpperCase();
  const sides = [event?.home_team, event?.away_team].map((t) => (t ?? '').toUpperCase());
  if (!sides.includes(team)) return null; // traded since: his team then is not known here
  const opponent = sides.find((t) => t !== team) ?? null;
  const spreadTeam = (snap.spread_team ?? '').toUpperCase();
  const spread = snap.spread == null ? null : spreadTeam === team ? snap.spread : spreadTeam === opponent ? -snap.spread : null;
  const earlier = (usageBy.get(playerId) ?? []).filter((u) => u.week < w);
  const fixture = teamGame(w, team);
  const roof = (fixture?.roof ?? '').toLowerCase();
  const indoor = roof === 'dome' || roof === 'closed' || (!roof && tableRoofFor(team, opponent, fixture?.home ?? null) === 'dome');
  const props = (bySnap.get(snap.id) ?? []).filter((r) => r.player_id === playerId).map((r) => toProp(r, snap));
  return {
    player,
    props,
    signal: null,
    kickoff: snap.game_start,
    now: snap.fetched_at,
    game: { spread, total: snap.total, opponent },
    opponent,
    ...(earlier.length ? { usageWeeks: earlier, usage: roleMetricsFrom([{ playerId, position: player.position }], new Map([[playerId, earlier]])).get(playerId) } : {}),
    ...(indoor ? { weather: { indoor: true, source: 'fixture list' } } : {}),
  } as StartSitInput;
}

const backtest: { week: number; idx: number; playerId: string; name: string; position: string; actual: number }[] = [];
const bundles: Record<number, ReturnType<typeof captureStartSitInputs>> = {};
const weeks: number[] = [];
for (let w = 1; w < currentWeek; w++) {
  const actual = actualOf(w);
  if (actual.size === 0) continue;
  const windowRows = usageRows.filter((u) => u.week < w && u.week >= w - TENDENCY_WINDOW_WEEKS);
  const defense = w - 1 >= DEFENSE.minWeeks ? defenseTendenciesFromRows(windowRows, w - 1) : new Map();
  const weekInputs: StartSitInput[] = [];
  for (const snap of preKick.values()) {
    if (weekOf(snap.game_start) !== w) continue;
    const ids = new Set((bySnap.get(snap.id) ?? []).map((r) => r.player_id));
    for (const id of ids) {
      if (!actual.has(id)) continue;
      const input = inputFor(id, snap, w);
      if (!input) continue;
      input.defenseTendencies = defense;
      backtest.push({ week: w, idx: weekInputs.length, playerId: id, name: input.player.fullName, position: input.player.position, actual: actual.get(id)! });
      weekInputs.push(input);
    }
  }
  if (weekInputs.length > 0) {
    weeks.push(w);
    bundles[w] = captureStartSitInputs(weekInputs);
  }
}

/* ------------------------------------------------------- this week */
const thisWeek = [...newest.values()].filter((s) => weekOf(s.game_start) === currentWeek || (s.game_start > new Date().toISOString() && s.game_start < new Date(Date.now() + 8 * 86400e3).toISOString()));
const current: { playerId: string; name: string; position: string; team: string; props: PlayerProp[] }[] = [];
const stale: { event: string; propsAt: string; linesAt: string | null; propsTotal: number | null; nowTotal: number | null; propsSpread: number | null; nowSpread: number | null; spreadTeam: string | null; nowSpreadTeam: string | null }[] = [];
for (const snap of thisWeek) {
  const ev = events.get(snap.event_id);
  stale.push({ event: `${ev?.away_team ?? '?'} @ ${ev?.home_team ?? '?'}`, propsAt: snap.fetched_at, linesAt: ev?.lines_seen_at ?? null, propsTotal: snap.total, nowTotal: ev?.game_total ?? null, propsSpread: snap.spread, nowSpread: ev?.spread ?? null, spreadTeam: snap.spread_team, nowSpreadTeam: ev?.spread_team ?? null });
  const ids = new Set((bySnap.get(snap.id) ?? []).map((r) => r.player_id));
  for (const id of ids) {
    const p = players.get(id);
    if (!p || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    current.push({ playerId: id, name: p.fullName, position: p.position, team: p.team, props: (bySnap.get(snap.id) ?? []).filter((r) => r.player_id === id).map((r) => toProp(r, snap)) });
  }
}
const weather = (fixtures[currentWeek] ?? []).filter((f) => f.home).map((f) => ({
  game: `${f.opponent} @ ${f.team}`,
  kickoff: f.kickoff,
  roof: f.roof,
  table: tableRoofFor(f.team, f.opponent, true),
}));

/* Dry run only: the seed has no finished weeks, so stand this week's players in for one. */
if (process.env.LOCAL_SEED && backtest.length === 0) {
  const inputs: StartSitInput[] = [];
  for (const snap of newest.values()) {
    for (const id of new Set((bySnap.get(snap.id) ?? []).map((r) => r.player_id))) {
      const p = players.get(id);
      if (!p) continue;
      const props = (bySnap.get(snap.id) ?? []).filter((r) => r.player_id === id).map((r) => toProp(r, snap));
      inputs.push({ player: p, props, signal: null, now: snap.fetched_at, kickoff: snap.game_start, defenseTendencies: new Map() } as StartSitInput);
      backtest.push({ week: 1, idx: inputs.length - 1, playerId: id, name: p.fullName, position: p.position, actual: 5 + (inputs.length * 7) % 17 });
    }
  }
  bundles[1] = captureStartSitInputs(inputs);
  weeks.push(1);
}

writeFileSync(join(dir, 'backtest-inputs.json'), JSON.stringify({ season, weeks, scoring: league.scoring_settings, rosterPositions: league.roster_positions, items: backtest, bundles }));
writeFileSync(join(dir, 'current.json'), JSON.stringify({ week: currentWeek, players: current, stale, weather, scoring: league.scoring_settings, rosterPositions: league.roster_positions }));
writeFileSync(join(dir, 'cost.json'), JSON.stringify({ rowsRead: db.rowsRead(), statements: db.statements() }));
console.log(`built: ${backtest.length} player-weeks over weeks ${weeks.join(', ')}; ${current.length} priced players this week; D1 ${db.statements()} statements, ${db.rowsRead()} rows read`);
