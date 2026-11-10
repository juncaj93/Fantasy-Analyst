/**
 * Round 16 (backtest of the rest-of-season value): gather, read-only.
 *
 *   node --experimental-transform-types --no-warnings scripts/probe-round16-gather.ts <out.json>
 *
 * Run once by `probe-round16-backtest.mjs` through the Probe workflow. Reads,
 * and writes nothing anywhere but `<out.json>`:
 *
 *   - Sleeper, documented endpoints only: `/state/nfl`, `/league/<id>`,
 *     `/league/<id>/matchups/<week>` (every roster's players each week),
 *     `/league/<id>/transactions/<week>` and `/draft/<id>/picks`.
 *   - Production D1, SELECT only, through the app's own repositories where one
 *     exists: the league row and which roster is Alex's, the stored weekly
 *     league points (`sleeper.weekPoints.<season>.<week>`), the stored weekly
 *     projections (`sleeper_weekly_projections`, quarterbacks rescored with the
 *     stored `sleeper.qbLines` rows exactly as the app does), the usage weeks
 *     (games played, club by week), the fixture list (byes), the injury
 *     reports, and the betting lines (the last prop snapshot of each game
 *     before kickoff).
 *
 * Every player-week is then put through the app's own Start/Sit engine and
 * `resolveRate` (the trade model's "this week's number"), so the file carries
 * the number each screen would have read that week: a full Vegas week, or
 * Sleeper's published week, and which. The backtest (`probe-round16-score.ts`)
 * needs no database at all after this.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { d1Http } from './lib/d1Http.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { UsageRepo, type StoredUsageWeek } from '../src/server/repos/usage.ts';
import { NflScheduleRepo } from '../src/server/repos/nflSchedule.ts';
import { SettingsRepo } from '../src/server/repos/settings.ts';
import type { StoredWeeklyProjection } from '../src/server/repos/sleeperProjections.ts';
import { SleeperProjectionService } from '../src/server/services/sleeperProjectionService.ts';
import { defenseTendenciesFromRows, roleMetricsFrom, TENDENCY_WINDOW_WEEKS } from '../src/server/services/usageService.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { weekPointsKey, type StoredWeekPoints } from '../src/core/sleeper/weekPoints.ts';
import { evaluatePlayer, type StartSitInput } from '../src/core/startsit/engine.ts';
import { DEFENSE } from '../src/core/startsit/defense.ts';
import { resolveRate } from '../src/core/tradeValue/rate.ts';
import { tableRoofFor } from '../src/core/nfl/roofs.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

const outFile = process.argv[2];
if (!outFile) throw new Error('usage: probe-round16-gather.ts <out.json>');
const SLEEPER = 'https://api.sleeper.app/v1';
const LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
if (!LEAGUE) throw new Error('SLEEPER_LEAGUE_ID is not set');
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

/*
 * DRY_RUN=<dir>: a rehearsal with no production access. Sleeper's answers are
 * read from <dir>/sleeper/<path>.json and the database is <dir>/d1.sqlite (a
 * local copy built from the migrations). The Probe workflow never sets it.
 */
const DRY = process.env.DRY_RUN ?? '';

async function sleeper<T>(path: string): Promise<T> {
  if (DRY) return JSON.parse(readFileSync(`${DRY}/sleeper${path.replace(/[?].*$/, '')}.json`, 'utf8')) as T;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${SLEEPER}${path}`);
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

/* ------------------------------------------------------------ Sleeper */
const state = await sleeper<{ season: string; week: number; season_type: string }>('/state/nfl');
const league = await sleeper<{
  season: string;
  draft_id: string | null;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  settings: Record<string, unknown>;
}>(`/league/${LEAGUE}`);
const season = String(league.season);
const currentWeek = Number(state.week);
console.log(`Sleeper: season ${season}, NFL week ${currentWeek} (${state.season_type})`);

type Matchup = { roster_id: number; players: string[] | null; starters: string[] | null; points: number | null };
const rosters: Record<number, Record<number, string[]>> = {};
const starters: Record<number, Record<number, string[]>> = {};
for (let w = 1; w <= currentWeek; w++) {
  const list = await sleeper<Matchup[]>(`/league/${LEAGUE}/matchups/${w}`);
  rosters[w] = {};
  starters[w] = {};
  for (const m of list ?? []) {
    rosters[w]![m.roster_id] = (m.players ?? []).filter(Boolean);
    starters[w]![m.roster_id] = (m.starters ?? []).filter((s) => s && s !== '0');
  }
}
type Tx = { type: string; status: string; leg: number; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null; status_updated: number; settings?: { waiver_bid?: number } | null };
const transactions: { week: number; type: string; at: number; adds: [string, number][]; drops: [string, number][]; bid: number | null }[] = [];
for (let w = 1; w <= currentWeek; w++) {
  const list = await sleeper<Tx[]>(`/league/${LEAGUE}/transactions/${w}`);
  for (const t of list ?? []) {
    if (t.status !== 'complete') continue;
    transactions.push({
      week: t.leg ?? w,
      type: t.type,
      at: t.status_updated,
      adds: Object.entries(t.adds ?? {}),
      drops: Object.entries(t.drops ?? {}),
      bid: t.settings?.waiver_bid ?? null,
    });
  }
}
const draftRounds: Record<string, number> = {};
if (league.draft_id) {
  const picks = await sleeper<{ player_id: string; round: number }[]>(`/draft/${league.draft_id}/picks`);
  for (const p of picks ?? []) if (p.player_id) draftRounds[p.player_id] = p.round;
}

/* ----------------------------------------------------------------- D1 */
const db = DRY
  ? await (async () => {
      const { NodeSqliteDatabase } = await import('../src/server/adapters/nodeSqlite.ts');
      const local = new NodeSqliteDatabase(`${DRY}/d1.sqlite`);
      return Object.assign(local, { rowsRead: () => 0, statements: () => 0 });
    })()
  : await d1Http();
const rowsAt = () => db.rowsRead();
const cost: Record<string, number> = {};
const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const before = rowsAt();
  const out = await run();
  cost[name] = rowsAt() - before;
  return out;
};

const leagueRow = await step('league and roster', async () => {
  const row = await db
    .prepare('SELECT id, season FROM leagues WHERE sleeper_league_id = ?')
    .bind(LEAGUE)
    .first<{ id: string; season: string }>();
  if (!row) throw new Error('league not stored');
  const mine = await db
    .prepare('SELECT roster_id FROM rosters WHERE league_id = ? AND is_mine = 1')
    .bind(row.id)
    .first<{ roster_id: number }>();
  return { ...row, myRosterId: mine?.roster_id ?? null };
});
console.log(`league stored; Alex's roster id ${leagueRow.myRosterId ?? 'not marked'}`);

const lastPlayed = currentWeek - 1;
const weekPoints = await step('weekly league points', async () => {
  const keys = Array.from({ length: lastPlayed }, (_, i) => weekPointsKey(season, i + 1));
  return new SettingsRepo(db).getMany<StoredWeekPoints>(keys);
});

type ProjRow = { week: number; player_id: string; pts_std: number | null; pts_half_ppr: number | null; pts_ppr: number | null; publisher: string | null; fetched_at: string };
const projRows = await step('weekly projections', async () =>
  (
    await db
      .prepare(
        `SELECT week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, fetched_at
           FROM sleeper_weekly_projections WHERE season = ?`,
      )
      .bind(season)
      .all<ProjRow>()
  ).results,
);
const storedByWeek = new Map<number, Map<string, StoredWeeklyProjection>>();
const fetched: Record<number, { rows: number; first: string; last: string }> = {};
for (const r of projRows) {
  const m = storedByWeek.get(r.week) ?? storedByWeek.set(r.week, new Map()).get(r.week)!;
  m.set(r.player_id, {
    playerId: r.player_id,
    publisher: r.publisher,
    points: { pts_std: r.pts_std, pts_half_ppr: r.pts_half_ppr, pts_ppr: r.pts_ppr },
    defense: null,
  });
  const f = (fetched[r.week] ??= { rows: 0, first: r.fetched_at, last: r.fetched_at });
  f.rows += 1;
  if (r.fetched_at < f.first) f.first = r.fetched_at;
  if (r.fetched_at > f.last) f.last = r.fetched_at;
}

const usageRows: StoredUsageWeek[] = await step('usage weeks', () => new UsageRepo(db).leagueWeeksSince(season, 1));
const usageBy = new Map<string, StoredUsageWeek[]>();
for (const r of usageRows) (usageBy.get(r.playerId) ?? usageBy.set(r.playerId, []).get(r.playerId)!).push(r);

const schedule: ScheduleTeamWeek[] = await step('fixture list', () => new NflScheduleRepo(db).season(season));

const injuries = await step('injury reports', async () =>
  (
    await db
      .prepare(
        `SELECT player_id, week, report_status FROM player_injury_reports
          WHERE season = ? AND report_status IS NOT NULL`,
      )
      .bind(season)
      .all<{ player_id: string; week: number; report_status: string }>()
  ).results,
);

/* Props: the last snapshot of each game taken before it kicked off (as Start/Sit round 2). */
type Snap = { id: number; event_id: string; game_start: string; fetched_at: string; total: number | null; spread: number | null; spread_team: string | null };
type Event = { event_id: string; home_team: string | null; away_team: string | null };
type PropRow = { snapshot_id: number; player_id: string; source_player_name: string; market: string; line: number | null; over_price: number | null; under_price: number | null; book_count: number; books_json: string; consensus_method: string; implied_probability: number | null };
const { snaps, events, propRows } = await step('betting lines', async () => {
  const snaps = (
    await db
      .prepare(
        `SELECT ps.id, ps.event_id, ps.game_start, ps.fetched_at,
                json_extract(ps.raw_json, '$.gameLines.total') AS total,
                json_extract(ps.raw_json, '$.gameLines.spread') AS spread,
                json_extract(ps.raw_json, '$.gameLines.spreadTeam') AS spread_team
           FROM prop_snapshots ps WHERE ps.scope = 'week' AND ps.game_start >= ?`,
      )
      .bind(`${season}-08-25`)
      .all<Snap>()
  ).results;
  const events = new Map(
    (await db.prepare('SELECT event_id, home_team, away_team FROM vegas_events WHERE kickoff >= ?').bind(`${season}-08-25`).all<Event>()).results.map((e) => [e.event_id, e]),
  );
  const preKick = new Map<string, Snap>();
  for (const s of snaps) {
    if (s.fetched_at < s.game_start && (!preKick.get(s.event_id) || preKick.get(s.event_id)!.fetched_at < s.fetched_at)) preKick.set(s.event_id, s);
  }
  const ids = [...preKick.values()].map((s) => s.id);
  const propRows: PropRow[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const batch = ids.slice(i, i + 80);
    propRows.push(
      ...(
        await db
          .prepare(
            `SELECT snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, implied_probability
               FROM player_props WHERE player_id IS NOT NULL AND snapshot_id IN (${batch.map(() => '?').join(',')})`,
          )
          .bind(...batch)
          .all<PropRow>()
      ).results,
    );
  }
  return { snaps: [...preKick.values()], events, propRows };
});

/* Every player the backtest could touch. */
const ids = new Set<string>();
for (const wp of weekPoints.values()) for (const id of Object.keys(wp.points ?? {})) ids.add(id);
for (const m of storedByWeek.values()) for (const id of m.keys()) ids.add(id);
for (const r of propRows) ids.add(r.player_id);
for (const w of Object.values(rosters)) for (const list of Object.values(w)) for (const id of list) ids.add(id);
const players = await step('players', () => new PlayerRepo(db).listByIds([...ids]));
const positionOf = (id: string) => players.get(id)?.position ?? null;

const scoring = league.scoring_settings;
const profile = buildScoringProfile(scoring, league.roster_positions);
const projService = new SleeperProjectionService(db, {} as never);
const published = new Map<number, Map<string, number>>();
await step('quarterback lines (inside the projections read)', async () => {
  for (const [week, stored] of [...storedByWeek].sort((a, b) => a[0] - b[0])) {
    const skill = [...stored.keys()].filter((id) => SKILL.has(positionOf(id) ?? ''));
    published.set(week, await projService.publishedFor({ season, week, playerIds: skill, profile, positionOf, stored }));
  }
});

/* ------------------------------------------------ this week's number */
const fixtureOf = new Map<string, ScheduleTeamWeek>();
for (const f of schedule) fixtureOf.set(`${f.week}:${f.team.toUpperCase()}`, f);
const weekOfDate = new Map<string, number>();
for (const f of schedule) if (f.kickoff) weekOfDate.set(f.kickoff.slice(0, 10), f.week);
const teamIn = (id: string, w: number): string => {
  const rows = (usageBy.get(id) ?? []).filter((u) => u.week <= w && u.team).sort((a, b) => b.week - a.week);
  /* His club that week if he played; else his latest earlier club; else today's. */
  return (rows[0]?.team ?? players.get(id)?.team ?? '').toUpperCase();
};
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
  books: (() => {
    try {
      return JSON.parse(r.books_json);
    } catch {
      return [];
    }
  })(),
  impliedProbability: r.implied_probability,
  snapshot: { fetchedAt: s.fetched_at, total: s.total, spread: s.spread, spreadTeam: s.spread_team },
});

/** Each player's number for each week: [points, 'm' (full Vegas week) | 'p' (Sleeper's week)]. */
const numbers: Record<number, Record<string, [number, 'm' | 'p']>> = {};
const lastWeekWithLines = Math.min(currentWeek, Math.max(0, ...snaps.map((s) => weekOfDate.get(s.game_start.slice(0, 10)) ?? 0)));
for (let w = 1; w <= Math.max(lastWeekWithLines, lastPlayed); w++) {
  const pub = published.get(w) ?? new Map<string, number>();
  const windowRows = usageRows.filter((u) => u.week < w && u.week >= w - TENDENCY_WINDOW_WEEKS);
  const defense = w - 1 >= DEFENSE.minWeeks ? defenseTendenciesFromRows(windowRows, w - 1) : new Map();
  const propsOf = new Map<string, { snap: Snap; props: PlayerProp[] }>();
  for (const s of snaps) {
    if (weekOfDate.get(s.game_start.slice(0, 10)) !== w) continue;
    const ev = events.get(s.event_id);
    for (const r of bySnap.get(s.id) ?? []) {
      const team = teamIn(r.player_id, w);
      const sides = [ev?.home_team, ev?.away_team].map((t) => (t ?? '').toUpperCase());
      if (!sides.includes(team)) continue;
      const entry = propsOf.get(r.player_id) ?? propsOf.set(r.player_id, { snap: s, props: [] }).get(r.player_id)!;
      entry.props.push(toProp(r, s));
    }
  }
  const out: Record<string, [number, 'm' | 'p']> = {};
  for (const id of new Set([...pub.keys(), ...propsOf.keys()])) {
    const player = players.get(id);
    if (!player || !SKILL.has(player.position)) continue;
    const team = teamIn(id, w);
    const fixture = fixtureOf.get(`${w}:${team}`);
    if (!fixture || !fixture.opponent) continue; // a bye: no number this week
    const priced = propsOf.get(id);
    const kickoff = priced?.snap.game_start ?? fixture.kickoff ?? null;
    const now = priced?.snap.fetched_at ?? (kickoff ? new Date(Date.parse(kickoff) - 86_400_000).toISOString() : new Date().toISOString());
    const spreadTeam = (priced?.snap.spread_team ?? '').toUpperCase();
    const s = priced?.snap.spread ?? null;
    const spread = s == null ? null : spreadTeam === team ? s : spreadTeam === fixture.opponent.toUpperCase() ? -s : null;
    const earlier = (usageBy.get(id) ?? []).filter((u) => u.week < w);
    const roof = (fixture.roof ?? '').toLowerCase();
    const indoor = roof === 'dome' || roof === 'closed' || (!roof && tableRoofFor(team, fixture.opponent, fixture.home) === 'dome');
    const input = {
      player: { ...player, team },
      props: priced?.props ?? [],
      signal: null,
      kickoff,
      now,
      game: { spread, total: priced?.snap.total ?? null, opponent: fixture.opponent },
      opponent: fixture.opponent,
      defenseTendencies: defense,
      ...(earlier.length ? { usageWeeks: earlier, usage: roleMetricsFrom([{ playerId: id, position: player.position }], new Map([[id, earlier]])).get(id) } : {}),
      ...(indoor ? { weather: { indoor: true, source: 'fixture list' } } : {}),
    } as StartSitInput;
    const evaluation = evaluatePlayer(input, profile);
    const r = resolveRate({ evaluation, published: pub, seasonLine: null, byeThisWeek: false });
    if (r.rate == null || r.fromThisWeek !== true) continue;
    out[id] = [r.rate, r.basis === 'market' ? 'm' : 'p'];
  }
  numbers[w] = out;
}

/* ------------------------------------------------------------- write */
const round1 = (v: number) => Math.round(v * 10) / 10;
const actual: Record<number, Record<string, number>> = {};
for (const [key, wp] of weekPoints) {
  const w = Number(key.split('.').pop());
  actual[w] = {};
  for (const [id, pts] of Object.entries(wp.points ?? {})) if (SKILL.has(positionOf(id) ?? '')) actual[w]![id] = round1(pts);
}
const proj: Record<number, Record<string, number>> = {};
for (const [w, m] of published) {
  proj[w] = {};
  for (const [id, v] of m) proj[w]![id] = Math.round(v * 100) / 100;
}
const played: Record<string, number[]> = {};
const clubs: Record<string, [number, string][]> = {};
for (const [id, rows] of usageBy) {
  played[id] = rows.filter((u) => [u.passAttempts, u.carries, u.targets, u.receptions].some((v) => v != null)).map((u) => u.week);
  clubs[id] = rows.filter((u) => u.team).map((u) => [u.week, String(u.team).toUpperCase()]);
}
const byes: Record<string, number[]> = {};
const teams = new Set(schedule.map((f) => f.team.toUpperCase()));
for (const t of teams) {
  const weeks = new Set(schedule.filter((f) => f.team.toUpperCase() === t && f.opponent).map((f) => f.week));
  byes[t] = [];
  for (let w = 1; w <= 18; w++) if (!weeks.has(w)) byes[t]!.push(w);
}
const injuryOut: Record<number, Record<string, string>> = {};
for (const r of injuries) (injuryOut[r.week] ??= {})[r.player_id] = r.report_status;
const playerOut: Record<string, [string, string, string]> = {};
for (const [id, p] of players) if (SKILL.has(p.position) || p.position === 'DEF') playerOut[id] = [p.fullName, p.position, (p.team ?? '').toUpperCase()];

const data = {
  meta: {
    season,
    generatedAt: new Date().toISOString(),
    currentWeek,
    lastPlayed,
    myRosterId: leagueRow.myRosterId,
    scoring,
    rosterPositions: league.roster_positions,
    settings: {
      playoff_week_start: league.settings.playoff_week_start ?? null,
      trade_deadline: league.settings.trade_deadline ?? null,
      reserve_slots: league.settings.reserve_slots ?? null,
      reserve_allow_out: league.settings.reserve_allow_out ?? null,
      reserve_allow_doubtful: league.settings.reserve_allow_doubtful ?? null,
      playoff_teams: league.settings.playoff_teams ?? null,
      waiver_budget: league.settings.waiver_budget ?? null,
    },
    projectionFetched: fetched,
    linesWeeks: Object.fromEntries(Object.entries(numbers).map(([w, m]) => [w, { players: Object.keys(m).length, vegas: Object.values(m).filter((v) => v[1] === 'm').length }])),
    d1RowsRead: cost,
    d1RowsTotal: rowsAt(),
    d1Statements: db.statements(),
  },
  players: playerOut,
  actual,
  proj,
  numbers,
  played,
  clubs,
  byes,
  injuries: injuryOut,
  rosters,
  starters,
  transactions,
  draftRounds,
};
writeFileSync(outFile, JSON.stringify(data));
console.log(`gathered: ${Object.keys(playerOut).length} players; actual weeks ${Object.keys(actual).join(',')}; projection weeks ${Object.keys(proj).join(',')}; number weeks ${Object.keys(numbers).join(',')}`);
console.log(`D1: ${db.statements()} statements, ${rowsAt().toLocaleString('en-US')} rows read`);
for (const [k, v] of Object.entries(cost)) console.log(`  ${k}: ${v.toLocaleString('en-US')} rows`);
