/**
 * Expert review (November 2026): rebuild what the app would have started in
 * weeks 1 to 8, from stored rows only, and score it against real points.
 *
 *   node --experimental-transform-types --no-warnings scripts/expert-review-build.ts <dir>
 *
 * Reads from <dir>: league.json, mine.json ({ rosterId }), matchups<w>.json
 * (Sleeper's documented /league/<id>/matchups/<w>). Reads through the
 * read-only D1 adapter (SELECT only): the last prop snapshot of each game
 * before it kicked off, those snapshots' props for Alex's players only, the
 * players, the fixture list, and Sleeper's published week for his players.
 *
 * For each week it runs today's lineup engine (recommendLineup, balanced, and
 * floor and ceiling for comparison) on the roster Alex held that week, then
 * scores three lineups with Sleeper's league-scored points: the one he played,
 * the app's, and the best possible in hindsight. Offense only (QB, RB, WR, TE,
 * FLEX); the defence slot is left out of all three.
 *
 * Writes <dir>/backtest.json. Approximations, stated in the report: today's
 * engine rather than the version Alex saw that week; props from the last
 * snapshot before each kickoff; no news, usage or injury nudges.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { d1Http } from './lib/d1Http.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SleeperProjectionService } from '../src/server/services/sleeperProjectionService.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { StartSitMode } from '../src/core/startsit/mode.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { SleeperClient } from '../src/core/sleeper/client.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: expert-review-build.ts <dir>');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const league = read('league.json') as { season: string; scoring_settings: Record<string, number>; roster_positions: string[] };
const mine = Number(read('mine.json').rosterId);
const season = String(league.season);
const LAST_WEEK = Number(process.env.LAST_WEEK ?? 8);

async function localDb() {
  const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
  const { seedDemoData } = await import('../src/devserver/seed.ts');
  const { readdirSync } = await import('node:fs');
  const raw = new NodeSqliteDatabase(':memory:');
  const migrations = new URL('../migrations/', import.meta.url).pathname;
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) await raw.exec(readFileSync(join(migrations, f), 'utf8'));
  await seedDemoData(raw);
  /* Dry run only: the seed has no fixture list or published week, so give week 1 one of each. */
  const snap = (await raw.prepare(`SELECT game_start FROM prop_snapshots WHERE scope = 'week' ORDER BY game_start LIMIT 1`).all<{ game_start: string }>()).results[0];
  const teams = (await raw.prepare(`SELECT DISTINCT team FROM players WHERE team IS NOT NULL AND team != ''`).all<{ team: string }>()).results;
  for (const t of teams) {
    await raw.prepare(`INSERT OR IGNORE INTO nfl_schedule (season, week, team, opponent, home, kickoff, roof, fetched_at) VALUES ('2026', 1, ?, 'ZZZ', 1, ?, null, ?)`).bind(t.team, snap?.game_start ?? null, new Date().toISOString()).run();
  }
  await raw.prepare(`INSERT OR IGNORE INTO sleeper_weekly_projections (season, week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, fetched_at) VALUES ('2026', 1, '1002', 9, 11, 13, 'rotowire', ?)`).bind(new Date().toISOString()).run();
  return Object.assign(raw, { rowsRead: () => 0, statements: () => 0 });
}
const db = process.env.LOCAL_SEED ? await localDb() : await d1Http();

const NO_SLEEPER = new Proxy({} as SleeperClient, {
  get: () => () => {
    throw new Error('the backtest must not call Sleeper through the app');
  },
});

const profile = buildScoringProfile(league.scoring_settings, league.roster_positions);
const offense = league.roster_positions.filter((p) => p !== 'DEF' && p !== 'K');
const shape = buildRosterShape(offense);

type Matchup = { roster_id: number; matchup_id: number; players: string[] | null; starters: string[] | null; players_points: Record<string, number> | null; starters_points: number[] | null };
const weeks: { week: number; roster: string[]; starters: string[]; points: Record<string, number> }[] = [];
for (let w = 1; w <= LAST_WEEK; w++) {
  const file = join(dir, `matchups${w}.json`);
  if (!existsSync(file)) continue;
  const m = (read(`matchups${w}.json`) as Matchup[]).find((x) => x.roster_id === mine);
  if (!m) continue;
  const isOffense = (id: string) => /^\d+$/.test(id);
  weeks.push({
    week: w,
    roster: (m.players ?? []).filter(isOffense),
    starters: (m.starters ?? []).filter((id) => id && id !== '0' && isOffense(id)),
    points: m.players_points ?? {},
  });
}
const everyone = [...new Set(weeks.flatMap((w) => w.roster))];

/* ---------------------------------------------------------- the reads */
const players = await new PlayerRepo(db).listByIds(everyone);
const schedule = new NflScheduleRepo(db);
const fixtureWeek = new Map<string, number>();
const fixtures = new Map<number, Awaited<ReturnType<typeof schedule.forWeek>>>();
for (const { week } of weeks) {
  const rows = await schedule.forWeek(season, week);
  fixtures.set(week, rows);
  for (const r of rows) if (r.kickoff) fixtureWeek.set(r.kickoff.slice(0, 10), week);
}

type Snap = { id: number; event_id: string; game_start: string; fetched_at: string; total: number | null; spread: number | null; spread_team: string | null };
const snaps = (await db
  .prepare(
    `SELECT ps.id, ps.event_id, ps.game_start, ps.fetched_at,
            json_extract(ps.raw_json, '$.gameLines.total') AS total,
            json_extract(ps.raw_json, '$.gameLines.spread') AS spread,
            json_extract(ps.raw_json, '$.gameLines.spreadTeam') AS spread_team
       FROM prop_snapshots ps WHERE ps.scope = 'week' AND ps.game_start >= ? AND ps.game_start < ?`,
  )
  .bind(`${season}-08-25`, `${season}-12-31`)
  .all<Snap>()).results;
const preKick = new Map<string, Snap>();
for (const s of snaps) {
  if (s.fetched_at < s.game_start && (!preKick.get(s.event_id) || preKick.get(s.event_id)!.fetched_at < s.fetched_at)) preKick.set(s.event_id, s);
}
type Event = { event_id: string; home_team: string | null; away_team: string | null };
const events = new Map(
  (await db.prepare('SELECT event_id, home_team, away_team FROM vegas_events WHERE kickoff >= ?').bind(`${season}-08-25`).all<Event>()).results.map((e) => [e.event_id, e]),
);

type PropRow = { snapshot_id: number; player_id: string; source_player_name: string; market: string; line: number | null; over_price: number | null; under_price: number | null; book_count: number; books_json: string; consensus_method: string; implied_probability: number | null };
const snapIds = [...preKick.values()].map((s) => s.id);
const propRows: PropRow[] = [];
for (let i = 0; i < snapIds.length; i += 60) {
  const batch = snapIds.slice(i, i + 60);
  for (let j = 0; j < everyone.length; j += 30) {
    const ids = everyone.slice(j, j + 30);
    propRows.push(
      ...(await db
        .prepare(
          `SELECT snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, implied_probability
             FROM player_props WHERE snapshot_id IN (${batch.map(() => '?').join(',')}) AND player_id IN (${ids.map(() => '?').join(',')})`,
        )
        .bind(...batch, ...ids)
        .all<PropRow>()).results,
    );
  }
}
const snapById = new Map([...preKick.values()].map((s) => [s.id, s] as const));
const propsBy = new Map<string, { snap: Snap; rows: PropRow[] }>(); // key week:player
for (const r of propRows) {
  const snap = snapById.get(r.snapshot_id)!;
  const w = fixtureWeek.get(snap.game_start.slice(0, 10));
  if (w == null) continue;
  const key = `${w}:${r.player_id}`;
  const entry = propsBy.get(key) ?? { snap, rows: [] };
  if (entry.snap.id !== snap.id) continue;
  entry.rows.push(r);
  propsBy.set(key, entry);
}
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

const projections = new SleeperProjectionService(db, NO_SLEEPER);

/* ---------------------------------------------------------- the replay */
const sum = (ids: readonly string[], pts: Record<string, number>) => Math.round(ids.reduce((s, id) => s + (pts[id] ?? 0), 0) * 100) / 100;

/** The best lineup in hindsight: dedicated slots best-first, then FLEX from what is left. */
function hindsight(roster: string[], pts: Record<string, number>): string[] {
  const pos = (id: string) => players.get(id)?.position ?? '?';
  const used = new Set<string>();
  const pick = (p: string, n: number) =>
    roster.filter((id) => pos(id) === p && !used.has(id)).sort((a, b) => (pts[b] ?? 0) - (pts[a] ?? 0)).slice(0, n).forEach((id) => used.add(id));
  const count = (s: string) => offense.filter((x) => x === s).length;
  for (const p of ['QB', 'RB', 'WR', 'TE']) pick(p, count(p));
  roster
    .filter((id) => ['RB', 'WR', 'TE'].includes(pos(id)) && !used.has(id))
    .sort((a, b) => (pts[b] ?? 0) - (pts[a] ?? 0))
    .slice(0, count('FLEX'))
    .forEach((id) => used.add(id));
  return [...used];
}

const out: unknown[] = [];
for (const wk of weeks) {
  const w = wk.week;
  const published = await projections
    .publishedFor({ season, week: w, playerIds: wk.roster, profile, positionOf: (id) => players.get(id)?.position ?? null, narrow: true })
    .catch(() => new Map<string, number>());
  const sunday = (fixtures.get(w) ?? []).map((f) => f.kickoff).filter((k): k is string => !!k).sort()[0] ?? null;
  const inputs: StartSitInput[] = [];
  const basisOf: Record<string, string> = {};
  for (const id of wk.roster) {
    const player = players.get(id);
    if (!player || !['QB', 'RB', 'WR', 'TE'].includes(player.position)) continue;
    const entry = propsBy.get(`${w}:${id}`);
    const fixture = (fixtures.get(w) ?? []).find((f) => f.team.toUpperCase() === player.team.toUpperCase()) ?? null;
    if (entry) {
      const ev = events.get(entry.snap.event_id);
      const sides = [ev?.home_team, ev?.away_team].map((t) => (t ?? '').toUpperCase());
      const team = player.team.toUpperCase();
      const opponent = sides.includes(team) ? (sides.find((t) => t !== team) ?? null) : (fixture?.opponent ?? null);
      const st = (entry.snap.spread_team ?? '').toUpperCase();
      const spread = entry.snap.spread == null ? null : st === team ? entry.snap.spread : st === opponent ? -entry.snap.spread : null;
      inputs.push({
        player,
        props: entry.rows.map((r) => toProp(r, entry.snap)),
        signal: null,
        kickoff: entry.snap.game_start,
        now: entry.snap.fetched_at,
        game: { spread, total: entry.snap.total, opponent },
        opponent,
      } as StartSitInput);
      basisOf[id] = 'props';
    } else {
      inputs.push({
        player,
        props: [],
        signal: null,
        ...(fixture?.kickoff ? { kickoff: fixture.kickoff } : {}),
        now: fixture?.kickoff ?? sunday ?? `${season}-09-10T12:00:00.000Z`,
        opponent: fixture?.opponent ?? null,
        ...(fixture ? {} : { onBye: true }),
      } as StartSitInput);
      basisOf[id] = published.has(id) ? 'published' : 'none';
    }
  }
  const lineupFor = (mode: StartSitMode) => {
    const rec = recommendLineup(inputs, shape, profile, { published, mode, currentStarterIds: wk.starters, ...(sunday ? { now: new Date(new Date(sunday).getTime() - 3600e3) } : {}) });
    return {
      ids: rec.slots.map((s) => s.playerId).filter((id): id is string => id != null),
      swaps: rec.swaps.map((s) => ({ in: s.inPlayerId, out: s.outPlayerId, gain: s.gain })),
    };
  };
  const balanced = lineupFor('balanced');
  const floor = lineupFor('floor');
  const ceiling = lineupFor('ceiling');
  const best = hindsight(wk.roster, wk.points);
  const name = (id: string) => players.get(id)?.fullName ?? id;
  out.push({
    week: w,
    actual: sum(wk.starters, wk.points),
    app: sum(balanced.ids, wk.points),
    floor: sum(floor.ids, wk.points),
    ceiling: sum(ceiling.ids, wk.points),
    best: sum(best, wk.points),
    appOnly: balanced.ids.filter((id) => !wk.starters.includes(id)).map((id) => ({ name: name(id), pts: wk.points[id] ?? 0, basis: basisOf[id] ?? '?' })),
    alexOnly: wk.starters.filter((id) => !balanced.ids.includes(id)).map((id) => ({ name: name(id), pts: wk.points[id] ?? 0, basis: basisOf[id] ?? '?' })),
    swaps: balanced.swaps.map((s) => ({ in: name(s.in), inPts: wk.points[s.in] ?? 0, out: name(s.out), outPts: wk.points[s.out] ?? 0, gain: s.gain })),
    priced: Object.values(basisOf).filter((b) => b === 'props').length,
    publishedOnly: Object.values(basisOf).filter((b) => b === 'published').length,
    noNumber: Object.values(basisOf).filter((b) => b === 'none').length,
  });
}

writeFileSync(join(dir, 'backtest.json'), JSON.stringify({ season, weeks: out, cost: { rowsRead: db.rowsRead(), statements: db.statements() } }));
console.log(`backtest: ${out.length} weeks; D1 ${db.statements()} statements, ${db.rowsRead()} rows read`);
