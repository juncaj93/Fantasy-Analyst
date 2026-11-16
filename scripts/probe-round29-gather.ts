/**
 * Round 29 (full audit): the saved data the accuracy backtest needs, read-only.
 *
 *   node --experimental-transform-types --no-warnings scripts/probe-round29-gather.ts <out.json>
 *
 * Run once by `probe-round29.mjs` inside the Probe workflow. Same shape as the
 * Round 16 file (`docs/backtest/round16-data.json`), so the Round 16 scorer can
 * read it, with three differences:
 *
 *  - lines are read the way the app reads them since Round 23: a look holds
 *    only the lines that changed, so a game's lines as of a moment are the
 *    newest row per player and market over its looks, back to the newest full
 *    copy (`eligibleSnapshots`), and "gone" markers are dropped;
 *  - numbers are rebuilt with today's engine for weeks 8 onward only (weeks 1
 *    to 7 are in the Round 16 file, and their lines may be trimmed by now);
 *  - for each game of weeks 8 to 11 the time of every look is kept, and for
 *    weeks 9 and 10 the number is also rebuilt as of Tuesday 9 PM, Saturday
 *    noon and Sunday 11 AM Eastern, so the freshness section can say how far
 *    the number moved between those moments and kickoff.
 *
 * Reads Sleeper's documented league endpoints, and production D1 by SELECT
 * only, through the app's repositories where one exists.
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
import { eligibleSnapshots } from '../src/server/repos/props.ts';
import type { PlayerProp } from '../src/core/vegas/types.ts';
import type { ScheduleTeamWeek } from '../src/core/nfl/schedule.ts';

const outFile = process.argv[2];
if (!outFile) throw new Error('usage: probe-round29-gather.ts <out.json>');
const SLEEPER = 'https://api.sleeper.app/v1';
const LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
if (!LEAGUE) throw new Error('SLEEPER_LEAGUE_ID is not set');
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const FROM_WEEK = 8;
/* DRY_RUN=<dir>: a rehearsal with no production access (see the Round 16 gather). */
const DRY = process.env.DRY_RUN ?? '';

async function sleeper<T>(path: string): Promise<T> {
  if (DRY) {
    try {
      return JSON.parse(readFileSync(`${DRY}/sleeper${path.replace(/[?].*$/, '')}.json`, 'utf8')) as T;
    } catch {
      return [] as unknown as T;
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${SLEEPER}${path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

/* ------------------------------------------------------------ Sleeper */
const state = await sleeper<{ season: string; week: number; season_type: string; display_week?: number }>('/state/nfl');
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

type Matchup = { roster_id: number; matchup_id: number | null; players: string[] | null; starters: string[] | null; points: number | null; players_points?: Record<string, number> | null };
const rosters: Record<number, Record<number, string[]>> = {};
const starters: Record<number, Record<number, string[]>> = {};
const pairings: Record<number, Record<number, number | null>> = {};
const teamPoints: Record<number, Record<number, number | null>> = {};
const livePoints: Record<number, Record<string, number>> = {};
for (let w = 1; w <= currentWeek + 1; w++) {
  const list = await sleeper<Matchup[]>(`/league/${LEAGUE}/matchups/${w}`);
  rosters[w] = {};
  starters[w] = {};
  pairings[w] = {};
  teamPoints[w] = {};
  livePoints[w] = {};
  for (const m of list ?? []) {
    rosters[w]![m.roster_id] = (m.players ?? []).filter(Boolean);
    starters[w]![m.roster_id] = (m.starters ?? []).filter((s) => s && s !== '0');
    pairings[w]![m.roster_id] = m.matchup_id ?? null;
    teamPoints[w]![m.roster_id] = m.points ?? null;
    for (const [id, p] of Object.entries(m.players_points ?? {})) livePoints[w]![id] = Math.round(Number(p) * 100) / 100;
  }
}
type Tx = { type: string; status: string; leg: number; roster_ids: number[]; adds: Record<string, number> | null; drops: Record<string, number> | null; status_updated: number; created: number; settings?: { waiver_bid?: number } | null; metadata?: Record<string, unknown> | null };
const transactions: { week: number; type: string; status: string; at: number; created: number; rosters: number[]; adds: [string, number][]; drops: [string, number][]; bid: number | null }[] = [];
for (let w = 1; w <= currentWeek + 1; w++) {
  const list = await sleeper<Tx[]>(`/league/${LEAGUE}/transactions/${w}`);
  for (const t of list ?? []) {
    transactions.push({
      week: t.leg ?? w,
      type: t.type,
      status: t.status,
      at: t.status_updated,
      created: t.created,
      rosters: t.roster_ids ?? [],
      adds: Object.entries(t.adds ?? {}),
      drops: Object.entries(t.drops ?? {}),
      bid: t.settings?.waiver_bid ?? null,
    });
  }
}
const sleeperRosters = await sleeper<{ roster_id: number; players: string[] | null; starters: string[] | null; reserve: string[] | null; settings: Record<string, number> }[]>(`/league/${LEAGUE}/rosters`);
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
  const row = await db.prepare('SELECT id, season FROM leagues WHERE sleeper_league_id = ?').bind(LEAGUE).first<{ id: string; season: string }>();
  if (!row) throw new Error('league not stored');
  const mine = await db.prepare('SELECT roster_id FROM rosters WHERE league_id = ? AND is_mine = 1').bind(row.id).first<{ roster_id: number }>();
  return { ...row, myRosterId: mine?.roster_id ?? null };
});
console.log(`league stored; Alex's roster id ${leagueRow.myRosterId ?? 'not marked'}`);

const lastPlayed = currentWeek - 1;
const weekPoints = await step('weekly league points', async () => {
  const keys = Array.from({ length: currentWeek }, (_, i) => weekPointsKey(season, i + 1));
  return new SettingsRepo(db).getMany<StoredWeekPoints>(keys);
});

type ProjRow = { week: number; player_id: string; pts_std: number | null; pts_half_ppr: number | null; pts_ppr: number | null; publisher: string | null; fetched_at: string };
const projRows = await step('weekly projections', async () =>
  (
    await db
      .prepare(`SELECT week, player_id, pts_std, pts_half_ppr, pts_ppr, publisher, fetched_at FROM sleeper_weekly_projections WHERE season = ? AND week >= ?`)
      .bind(season, FROM_WEEK)
      .all<ProjRow>()
  ).results,
);
const storedByWeek = new Map<number, Map<string, StoredWeeklyProjection>>();
const fetched: Record<number, { rows: number; first: string; last: string }> = {};
for (const r of projRows) {
  const m = storedByWeek.get(r.week) ?? storedByWeek.set(r.week, new Map()).get(r.week)!;
  m.set(r.player_id, { playerId: r.player_id, publisher: r.publisher, points: { pts_std: r.pts_std, pts_half_ppr: r.pts_half_ppr, pts_ppr: r.pts_ppr }, defense: null });
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
      .prepare(`SELECT player_id, week, report_status FROM player_injury_reports WHERE season = ? AND report_status IS NOT NULL`)
      .bind(season)
      .all<{ player_id: string; week: number; report_status: string }>()
  ).results,
);

/* -------------------------------------------------------------- lines */
type Look = { id: number; event_id: string; game_start: string; fetched_at: string; delta: boolean; total: number | null; spread: number | null; spread_team: string | null };
type Event = { event_id: string; home_team: string | null; away_team: string | null; kickoff: string | null };
type PropRow = { id: number; snapshot_id: number; player_id: string | null; source_player_name: string; market: string; line: number | null; over_price: number | null; under_price: number | null; book_count: number; books_json: string; consensus_method: string; implied_probability: number | null };

const kickoffs = schedule.map((f) => f.kickoff).filter((k): k is string => !!k);
const weekOfDate = new Map<string, number>();
for (const f of schedule) if (f.kickoff) weekOfDate.set(f.kickoff.slice(0, 10), f.week);
const weekOfGame = (gameStart: string): number | null => {
  const exact = weekOfDate.get(gameStart.slice(0, 10));
  if (exact != null) return exact;
  /* A kickoff the fixture list has on a neighbouring UTC date (a late game). */
  const t = Date.parse(gameStart);
  let best: { w: number; d: number } | null = null;
  for (const f of schedule) {
    if (!f.kickoff) continue;
    const d = Math.abs(Date.parse(f.kickoff) - t);
    if (d < 36 * 3_600_000 && (!best || d < best.d)) best = { w: f.week, d };
  }
  return best?.w ?? null;
};
const firstKick = kickoffs.filter((k) => weekOfDate.get(k.slice(0, 10)) === FROM_WEEK).sort()[0] ?? `${season}-10-20`;
const windowFrom = new Date(Date.parse(firstKick) - 3 * 86_400_000).toISOString();

const { looks, events } = await step('looks (every weekly look, weeks 8 on)', async () => {
  const looks = (
    await db
      .prepare(
        `SELECT id, event_id, game_start, fetched_at,
                json_extract(raw_json, '$.delta') AS delta,
                json_extract(raw_json, '$.gameLines.total') AS total,
                json_extract(raw_json, '$.gameLines.spread') AS spread,
                json_extract(raw_json, '$.gameLines.spreadTeam') AS spread_team
           FROM prop_snapshots WHERE scope = 'week' AND game_start >= ?`,
      )
      .bind(windowFrom)
      .all<Record<string, unknown>>()
  ).results.map(
    (r): Look => ({
      id: Number(r['id']),
      event_id: String(r['event_id']),
      game_start: String(r['game_start']),
      fetched_at: String(r['fetched_at']),
      delta: r['delta'] === 1 || r['delta'] === true || r['delta'] === 'true',
      total: r['total'] == null ? null : Number(r['total']),
      spread: r['spread'] == null ? null : Number(r['spread']),
      spread_team: r['spread_team'] == null ? null : String(r['spread_team']),
    }),
  );
  const events = new Map(
    (await db.prepare('SELECT event_id, home_team, away_team, kickoff FROM vegas_events WHERE kickoff >= ?').bind(windowFrom).all<Event>()).results.map((e) => [e.event_id, e]),
  );
  return { looks, events };
});
const looksByEvent = new Map<string, Look[]>();
for (const l of looks) (looksByEvent.get(l.event_id) ?? looksByEvent.set(l.event_id, []).get(l.event_id)!).push(l);
for (const list of looksByEvent.values()) list.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at) || b.id - a.id);

/* Eastern wall time to UTC, DST-aware (Intl knows the offset). */
const etToUtc = (ymd: string, hh: number, mm = 0): string => {
  const guess = Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asEt = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return new Date(guess + (guess - asEt)).toISOString();
};
const sundayOf = (w: number): string | null => {
  const sundays = schedule
    .filter((f) => f.week === w && f.kickoff)
    .map((f) => new Date(Date.parse(f.kickoff!) - 5 * 3_600_000))
    .filter((d) => d.getUTCDay() === 0)
    .map((d) => d.toISOString().slice(0, 10));
  return sundays.sort()[0] ?? null;
};
const addDays = (ymd: string, k: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const moments: Record<number, Record<string, string>> = {};
for (let w = FROM_WEEK; w <= currentWeek + 1; w++) {
  const sun = sundayOf(w);
  if (!sun) continue;
  moments[w] = {
    tue9pm: etToUtc(addDays(sun, -5), 21),
    thu6pm: etToUtc(addDays(sun, -3), 18),
    sat12pm: etToUtc(addDays(sun, -1), 12),
    sun11am: etToUtc(sun, 11),
  };
}

/* Which looks' rows to read: the pre-kick chain for every game, plus every chain an "as of" moment needs. */
const AS_OF_WEEKS = new Set([9, 10]);
const chainAt = (eventId: string, before: string): Look[] => {
  const list = (looksByEvent.get(eventId) ?? []).filter((l) => l.fetched_at < before);
  return eligibleSnapshots(list, false);
};
const plans: { eventId: string; week: number; label: string; asOf: string; chain: Look[] }[] = [];
for (const [eventId, list] of looksByEvent) {
  const gameStart = list[0]!.game_start;
  const w = weekOfGame(gameStart);
  if (w == null || w < FROM_WEEK) continue;
  const now = new Date().toISOString();
  const kick = gameStart < now ? gameStart : now;
  plans.push({ eventId, week: w, label: gameStart < now ? 'kick' : 'now', asOf: kick, chain: chainAt(eventId, kick) });
  if (AS_OF_WEEKS.has(w) && moments[w]) {
    for (const [label, at] of Object.entries(moments[w]!)) {
      if (at >= gameStart || label === 'thu6pm') continue;
      plans.push({ eventId, week: w, label, asOf: at, chain: chainAt(eventId, at) });
    }
  }
}
const needIds = [...new Set(plans.flatMap((p) => p.chain.map((l) => l.id)))];
const propRows = await step('lines for those looks', async () => {
  const out: PropRow[] = [];
  for (let i = 0; i < needIds.length; i += 80) {
    const batch = needIds.slice(i, i + 80);
    out.push(
      ...(
        await db
          .prepare(
            `SELECT id, snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, implied_probability
               FROM player_props WHERE snapshot_id IN (${batch.map(() => '?').join(',')}) AND +scope = 'week'`,
          )
          .bind(...batch)
          .all<PropRow>()
      ).results,
    );
  }
  return out;
});
const rowsBySnap = new Map<number, PropRow[]>();
for (const r of propRows) (rowsBySnap.get(r.snapshot_id) ?? rowsBySnap.set(r.snapshot_id, []).get(r.snapshot_id)!).push(r);

/* Every player the backtest could touch. */
const ids = new Set<string>();
for (const wp of weekPoints.values()) for (const id of Object.keys(wp.points ?? {})) ids.add(id);
for (const m of storedByWeek.values()) for (const id of m.keys()) ids.add(id);
for (const r of propRows) if (r.player_id) ids.add(r.player_id);
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
const teamIn = (id: string, w: number): string => {
  const rows = (usageBy.get(id) ?? []).filter((u) => u.week <= w && u.team).sort((a, b) => b.week - a.week);
  return (rows[0]?.team ?? players.get(id)?.team ?? '').toUpperCase();
};
const toProp = (r: PropRow, look: Look): PlayerProp => ({
  playerId: r.player_id!,
  sourcePlayerName: r.source_player_name,
  market: r.market as PlayerProp['market'],
  line: r.line,
  overPrice: r.over_price,
  underPrice: r.under_price,
  bookCount: Number(r.book_count ?? 0),
  consensusMethod: r.consensus_method as PlayerProp['consensusMethod'],
  books: (() => {
    try {
      const parsed = JSON.parse(r.books_json);
      return Array.isArray(parsed) ? parsed.map((b: unknown) => (typeof b === 'string' ? b : String((b as { book?: string })?.book ?? ''))).filter(Boolean) : [];
    } catch {
      return [];
    }
  })(),
  impliedProbability: r.implied_probability,
  snapshot: { fetchedAt: look.fetched_at, total: look.total, spread: look.spread, spreadTeam: look.spread_team },
});
/** The newest line per player and market over a chain, "gone" markers dropped. */
const linesOf = (chain: Look[]): Map<string, PlayerProp[]> => {
  const order = new Map(chain.map((l, i) => [l.id, i]));
  const newest = new Map<string, PropRow>();
  for (const l of chain) {
    for (const r of rowsBySnap.get(l.id) ?? []) {
      const k = `${String(r.source_player_name ?? '').toLowerCase()}|${r.market}`;
      const h = newest.get(k);
      const ra = order.get(r.snapshot_id) ?? Infinity;
      const rb = h ? (order.get(h.snapshot_id) ?? Infinity) : Infinity;
      if (!h || ra < rb || (ra === rb && r.id > h.id)) newest.set(k, r);
    }
  }
  const asOf = chain[0];
  const out = new Map<string, PlayerProp[]>();
  if (!asOf) return out;
  for (const r of newest.values()) {
    if (r.player_id == null || r.consensus_method === 'none') continue;
    const list = out.get(r.player_id) ?? [];
    list.push(toProp(r, asOf));
    out.set(r.player_id, list);
  }
  return out;
};

type NumberRow = [number, 'm' | 'p'];
const numbers: Record<number, Record<string, NumberRow>> = {};
const numbersAsOf: Record<number, Record<string, Record<string, NumberRow>>> = {};
const lineCounts: Record<string, { games: number; players: number }> = {};
const buildWeek = (w: number, label: string): Record<string, NumberRow> => {
  const pub = published.get(w) ?? new Map<string, number>();
  const windowRows = usageRows.filter((u) => u.week < w && u.week >= w - TENDENCY_WINDOW_WEEKS);
  const defense = w - 1 >= DEFENSE.minWeeks ? defenseTendenciesFromRows(windowRows, w - 1) : new Map();
  const propsOf = new Map<string, { look: Look; props: PlayerProp[] }>();
  let games = 0;
  for (const p of plans) {
    if (p.week !== w || (p.label !== label && !(label === 'kick' && p.label === 'now'))) continue;
    if (p.chain.length === 0) continue;
    games += 1;
    const ev = events.get(p.eventId);
    const sides = [ev?.home_team, ev?.away_team].map((t) => (t ?? '').toUpperCase());
    for (const [pid, props] of linesOf(p.chain)) {
      if (!sides.includes(teamIn(pid, w))) continue;
      propsOf.set(pid, { look: p.chain[0]!, props });
    }
  }
  /* A moment taken after a game kicked off reads that game's pre-kick lines. */
  if (label !== 'kick') {
    for (const p of plans) {
      if (p.week !== w || (p.label !== 'kick' && p.label !== 'now')) continue;
      const hasMoment = plans.some((q) => q.eventId === p.eventId && q.label === label);
      if (hasMoment) continue;
      const ev = events.get(p.eventId);
      const sides = [ev?.home_team, ev?.away_team].map((t) => (t ?? '').toUpperCase());
      for (const [pid, props] of linesOf(p.chain)) if (sides.includes(teamIn(pid, w)) && !propsOf.has(pid)) propsOf.set(pid, { look: p.chain[0]!, props });
    }
  }
  lineCounts[`${w}:${label}`] = { games, players: propsOf.size };
  const out: Record<string, NumberRow> = {};
  for (const id of new Set([...pub.keys(), ...propsOf.keys()])) {
    const player = players.get(id);
    if (!player || !SKILL.has(player.position)) continue;
    const team = teamIn(id, w);
    const fixture = fixtureOf.get(`${w}:${team}`);
    if (!fixture || !fixture.opponent) continue;
    const priced = propsOf.get(id);
    const kickoff = fixture.kickoff ?? priced?.look.game_start ?? null;
    const now = priced?.look.fetched_at ?? (kickoff ? new Date(Date.parse(kickoff) - 86_400_000).toISOString() : new Date().toISOString());
    const spreadTeam = (priced?.look.spread_team ?? '').toUpperCase();
    const s = priced?.look.spread ?? null;
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
      game: { spread, total: priced?.look.total ?? null, opponent: fixture.opponent },
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
  return out;
};
for (let w = FROM_WEEK; w <= currentWeek + 1; w++) {
  numbers[w] = buildWeek(w, 'kick');
  if (AS_OF_WEEKS.has(w)) {
    numbersAsOf[w] = {};
    for (const label of ['tue9pm', 'sat12pm', 'sun11am']) numbersAsOf[w]![label] = buildWeek(w, label);
  }
}

/* ------------------------------------------------------------- write */
const round1 = (v: number) => Math.round(v * 10) / 10;
const actual: Record<number, Record<string, number>> = {};
const actualFetched: Record<number, string> = {};
for (const [key, wp] of weekPoints) {
  const w = Number(key.split('.').pop());
  actual[w] = {};
  actualFetched[w] = wp.fetchedAt;
  for (const [id, pts] of Object.entries(wp.points ?? {})) if (SKILL.has(positionOf(id) ?? '') || positionOf(id) === 'DEF') actual[w]![id] = round1(pts);
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
const fixtures = schedule.filter((f) => f.week >= FROM_WEEK).map((f) => [f.week, f.team.toUpperCase(), (f.opponent ?? '').toUpperCase(), f.kickoff ?? null]);
const injuryOut: Record<number, Record<string, string>> = {};
for (const r of injuries) (injuryOut[r.week] ??= {})[r.player_id] = r.report_status;
const playerOut: Record<string, [string, string, string, string | null]> = {};
for (const [id, p] of players) if (SKILL.has(p.position) || p.position === 'DEF') playerOut[id] = [p.fullName, p.position, (p.team ?? '').toUpperCase(), (p as { injuryStatus?: string | null }).injuryStatus ?? null];
const lookTimes = [...looksByEvent].map(([eventId, list]) => ({
  eventId,
  week: weekOfGame(list[0]!.game_start),
  gameStart: list[0]!.game_start,
  teams: [events.get(eventId)?.home_team ?? null, events.get(eventId)?.away_team ?? null],
  looks: list.map((l) => [l.fetched_at, l.delta ? 'd' : 'f']),
}));

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
    actualFetched,
    moments,
    lineCounts,
    linesWeeks: Object.fromEntries(Object.entries(numbers).map(([w, m]) => [w, { players: Object.keys(m).length, vegas: Object.values(m).filter((v) => v[1] === 'm').length }])),
    d1RowsRead: cost,
    d1RowsTotal: rowsAt(),
    d1Statements: db.statements(),
  },
  players: playerOut,
  actual,
  livePoints,
  teamPoints,
  pairings,
  proj,
  numbers,
  numbersAsOf,
  played,
  clubs,
  byes,
  fixtures,
  injuries: injuryOut,
  rosters,
  starters,
  currentRosters: (sleeperRosters ?? []).map((r) => ({ roster_id: r.roster_id, players: r.players ?? [], starters: r.starters ?? [], reserve: r.reserve ?? [], settings: r.settings ?? {} })),
  transactions,
  draftRounds,
  lookTimes,
};
writeFileSync(outFile, JSON.stringify(data));
console.log(`gathered: ${Object.keys(playerOut).length} players; actual weeks ${Object.keys(actual).join(',')}; projection weeks ${Object.keys(proj).join(',')}; number weeks ${Object.keys(numbers).join(',')}`);
console.log(`lines: ${looks.length} looks across ${looksByEvent.size} games; ${needIds.length} looks read; ${propRows.length} line rows`);
for (const [k, v] of Object.entries(lineCounts)) console.log(`  week ${k}: ${v.games} games, ${v.players} players priced`);
console.log(`D1: ${db.statements()} statements, ${rowsAt().toLocaleString('en-US')} rows read`);
for (const [k, v] of Object.entries(cost)) console.log(`  ${k}: ${v.toLocaleString('en-US')} rows`);
