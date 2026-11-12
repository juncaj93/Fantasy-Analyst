/**
 * When TheRundown and The Odds API are asked, and where their numbers go
 * (Round 23, steps 3 and 4).
 *
 * Part of the same Vegas refresh as SportsGameOdds: it runs at the end of every
 * `VegasRefreshService.refresh` (the kickoff clock's passes and a person's
 * refresh tap) and on the clock's own wake-ups, each source skipped while it is
 * inside its interval. There is no second refresh path.
 *
 * | Source | What | How often | Cost |
 * |---|---|---|---|
 * | TheRundown | totals and spreads, per game date | hourly when a tracked game is inside 48 hours, else every 3 hours | about 150 data points a date; capped at 6,000 a day |
 * | The Odds API | totals and spreads, whole slate | every 8 hours | 2 credits |
 * | The Odds API | player props, the week's tracked games | Friday from 9 AM ET, once a week | about 6 credits a game, at most 8 games |
 *
 * Only games already on file (`vegas_events`, the roster's, the opponent's and
 * the waiver tier's) are fed: a game no one tracks is not created here, so
 * SportsGameOdds discovery still finds it the ordinary way.
 *
 * A source with no key is skipped quietly. A source that fails is noted and
 * skipped until its next interval; it never stops the rest of the refresh.
 */

import type { ExternalGame, OddsApiExtraSource, TheRundownSource } from '../../core/vegas/extraSources.ts';
import { MARKET_KEYS } from '../../core/vegas/types.ts';
import { nflTeamCode } from '../../core/nfl/teams.ts';
import type { Database } from '../db.ts';
import { SettingsRepo } from '../repos/settings.ts';
import { VegasEventsRepo, type VegasEventRow } from '../repos/vegasEvents.ts';
import { LookStore } from './lookStore.ts';

export interface ExtraSources {
  rundown?: TheRundownSource;
  oddsApi?: OddsApiExtraSource;
}

/** A Vegas provider that carries the extra sources the worker built for it. */
export function extraSourcesOf(provider: unknown): ExtraSources | null {
  const extras = (provider as { extraSources?: ExtraSources } | null)?.extraSources;
  if (!extras) return null;
  const any = (extras.rundown?.isConfigured() ?? false) || (extras.oddsApi?.isConfigured() ?? false);
  return any ? extras : null;
}

export const EXTRA_SOURCES_KEY = 'vegas.extraSources';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const INTERVALS = {
  /** TheRundown, when a tracked game is inside 48 hours. */
  rundownNearMinutes: 60,
  rundownFarMinutes: 180,
  oddsApiLinesMinutes: 8 * 60,
} as const;

/**
 * TheRundown free tier: 20,000 data points a day, and one page also says
 * 200,000 a month (unverified, Round 21). 6,000 a day stays under both.
 */
export const RUNDOWN_DAILY_POINTS_CAP = 6_000;
/** What one date's request is assumed to cost when the answer does not say. */
export const RUNDOWN_POINTS_PER_REQUEST_GUESS = 150;
/** The Odds API free tier: 500 credits a month. Keep this many back. */
export const ODDS_API_RESERVE = 60;
/** At most this many games in the Friday props fill (about 6 credits each). */
export const PROPS_FILL_MAX_GAMES = 8;
/** How far ahead a tracked game may be. The first SportsGameOdds look is 120 hours. */
const HORIZON_MS = 5.5 * DAY;

export interface ExtraState {
  rundown?: { lastAt?: string; outcome?: string; day?: string; points?: number };
  oddsApi?: { linesAt?: string; propsWeek?: string; outcome?: string; remaining?: number | null };
}

export interface ExtraRun {
  ran: string[];
  notes: string[];
  /** When the next source is due, ms, or null when none is configured. */
  nextDue: number | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The Eastern calendar date of an instant, and how far Eastern is behind UTC then, in minutes. */
export function easternDate(at: number): { date: string; offsetMinutes: number; weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour'));
  const localAsUtc = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const offsetMinutes = Math.round((Math.floor(at / HOUR) * HOUR - localAsUtc) / MIN);
  return { date, offsetMinutes, weekday: get('weekday'), hour };
}

/** The tracked game an outside source's game is, by its sides and a kickoff within six hours. */
export function matchGame(game: ExternalGame, rows: readonly VegasEventRow[]): VegasEventRow | null {
  const sides = new Set(game.teams.map((t) => nflTeamCode(t)).filter(Boolean));
  const at = Date.parse(game.kickoff);
  for (const row of rows) {
    const kick = row.kickoff ? Date.parse(row.kickoff) : NaN;
    if (!Number.isFinite(kick) || !Number.isFinite(at) || Math.abs(kick - at) > 6 * HOUR) continue;
    const mine = [row.homeTeam, row.awayTeam].map((t) => nflTeamCode(t)).filter(Boolean);
    if (mine.some((t) => sides.has(t))) return row;
  }
  return null;
}

export class ExtraOddsSources {
  private readonly settings: SettingsRepo;

  constructor(
    private readonly db: Database,
    private readonly sources: ExtraSources,
    private readonly looks: LookStore = new LookStore(db),
  ) {
    this.settings = new SettingsRepo(db);
  }

  /**
   * Ask whichever sources are due, feed the tracked games, and say when the
   * next one is due. Never throws.
   */
  async runIfDue(now: number): Promise<ExtraRun> {
    const out: ExtraRun = { ran: [], notes: [], nextDue: null };
    const rundown = this.sources.rundown?.isConfigured() ? this.sources.rundown : null;
    const oddsApi = this.sources.oddsApi?.isConfigured() ? this.sources.oddsApi : null;
    if (!rundown && !oddsApi) return out;

    const state = await this.settings.get<ExtraState>(EXTRA_SOURCES_KEY, {}).catch(() => ({}) as ExtraState);
    const tracked = await new VegasEventsRepo(this.db).between(iso(now), iso(now + HORIZON_MS)).catch(() => []);
    const nearest = tracked.map((r) => (r.kickoff ? Date.parse(r.kickoff) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const rundownEvery = (nearest != null && nearest - now <= 48 * HOUR ? INTERVALS.rundownNearMinutes : INTERVALS.rundownFarMinutes) * MIN;

    let changed = false;
    const today = new Date(now).toISOString().slice(0, 10);

    // ---------------------------------------------------------------- TheRundown
    if (rundown) {
      const r = (state.rundown ??= {});
      if (r.day !== today) {
        r.day = today;
        r.points = 0;
      }
      const last = r.lastAt ? Date.parse(r.lastAt) : NaN;
      const due = !Number.isFinite(last) || now - last >= rundownEvery;
      if (due && tracked.length > 0 && (r.points ?? 0) < RUNDOWN_DAILY_POINTS_CAP) {
        const dates = new Map<string, number>();
        for (const row of tracked) {
          const kick = row.kickoff ? Date.parse(row.kickoff) : NaN;
          if (!Number.isFinite(kick)) continue;
          const e = easternDate(kick);
          dates.set(e.date, e.offsetMinutes);
        }
        const asked = [...dates.entries()].sort().slice(0, 3).map(([date, offsetMinutes]) => ({ date, offsetMinutes }));
        try {
          const answer = await rundown.gameLines(asked);
          r.points = (r.points ?? 0) + (answer.cost > 0 ? answer.cost : answer.requests * RUNDOWN_POINTS_PER_REQUEST_GUESS);
          const fed = await this.feed(answer.value, tracked, now, rundown.name);
          r.outcome = `${answer.requests} request(s), ${fed} game(s) fed`;
          out.ran.push(rundown.name);
        } catch (err) {
          r.outcome = `failed: ${err instanceof Error ? err.message : String(err)}`;
          out.notes.push(`${rundown.name} ${r.outcome}`);
        }
        r.lastAt = iso(now);
        changed = true;
      }
      const next = (r.lastAt ? Date.parse(r.lastAt) : now) + rundownEvery;
      out.nextDue = Math.min(out.nextDue ?? Infinity, next);
    }

    // ---------------------------------------------------------------- The Odds API
    if (oddsApi) {
      const o = (state.oddsApi ??= {});
      const last = o.linesAt ? Date.parse(o.linesAt) : NaN;
      const linesDue = !Number.isFinite(last) || now - last >= INTERVALS.oddsApiLinesMinutes * MIN;
      const et = easternDate(now);
      const propsDue = et.weekday === 'Fri' && et.hour >= 9 && o.propsWeek !== et.date;
      const reserveOk = o.remaining == null || o.remaining > ODDS_API_RESERVE;
      if ((linesDue || propsDue) && tracked.length > 0 && reserveOk) {
        try {
          const answer = await oddsApi.gameLines();
          o.remaining = answer.remaining;
          const fed = await this.feed(answer.value, tracked, now, oddsApi.name);
          o.outcome = `game lines: ${fed} game(s) fed, ${answer.cost} credit(s)`;
          o.linesAt = iso(now);
          out.ran.push(oddsApi.name);
          if (propsDue) {
            o.propsWeek = et.date;
            o.outcome += `; ${await this.propsFill(oddsApi, answer.value, tracked, now, o)}`;
          }
        } catch (err) {
          o.outcome = `failed: ${err instanceof Error ? err.message : String(err)}`;
          o.linesAt = iso(now);
          out.notes.push(`${oddsApi.name} ${o.outcome}`);
        }
        changed = true;
      }
      const next = (o.linesAt ? Date.parse(o.linesAt) : now) + INTERVALS.oddsApiLinesMinutes * MIN;
      out.nextDue = Math.min(out.nextDue ?? Infinity, next);
    }

    if (out.nextDue === Infinity) out.nextDue = null;
    if (changed) {
      await this.looks.flush(now).catch((err: unknown) => out.notes.push(`could not save game books: ${String(err)}`));
      await this.settings.set(EXTRA_SOURCES_KEY, state).catch(() => undefined);
    }
    return out;
  }

  /** Feed each matched game's books into the per-book average. Returns how many games matched. */
  private async feed(games: readonly ExternalGame[], tracked: readonly VegasEventRow[], now: number, provider: string): Promise<number> {
    let fed = 0;
    for (const game of games) {
      const row = matchGame(game, tracked);
      if (!row || game.books.length === 0) continue;
      // Seen in this pass: stamped with the pass's own time.
      const books = game.books.map((b) => ({ ...b, at: iso(now) }));
      await this.looks.storeGameBooks(row.eventId, books, {
        now,
        kickoff: row.kickoff ?? game.kickoff,
        teams: game.teams,
        provider,
      });
      fed++;
    }
    return fed;
  }

  /**
   * The Friday props fill: player lines for the week's tracked games, through
   * the same per-book average and write-on-change as SportsGameOdds' looks.
   * Its books join theirs; a line only The Odds API has becomes a line.
   */
  private async propsFill(
    source: OddsApiExtraSource,
    games: readonly ExternalGame[],
    tracked: readonly VegasEventRow[],
    now: number,
    o: NonNullable<ExtraState['oddsApi']>,
  ): Promise<string> {
    const wanted = games
      .map((g) => ({ game: g, row: matchGame(g, tracked) }))
      .filter((m): m is { game: ExternalGame; row: VegasEventRow } => m.row != null && m.game.sourceId != null)
      .filter((m) => Date.parse(m.game.kickoff) - now <= 4 * DAY && Date.parse(m.game.kickoff) > now)
      .slice(0, PROPS_FILL_MAX_GAMES);
    let filled = 0;
    let credits = 0;
    for (const { game, row } of wanted) {
      if (o.remaining != null && o.remaining <= ODDS_API_RESERVE) break;
      try {
        const answer = await source.playerProps(game.sourceId!, MARKET_KEYS);
        o.remaining = answer.remaining ?? o.remaining;
        credits += answer.cost;
        if (answer.value.length === 0) continue;
        const fetchedAt = iso(now);
        await this.looks.storeLook({
          provider: source.name,
          eventId: row.eventId,
          gameStart: row.kickoff ?? game.kickoff,
          fetchedAt,
          quotes: answer.value,
          raw: null,
          topUp: true,
        });
        filled++;
      } catch (err) {
        return `props fill stopped: ${err instanceof Error ? err.message : String(err)} (${filled} game(s), ${credits} credit(s))`;
      }
    }
    return `props fill: ${filled} game(s), ${credits} credit(s)`;
  }
}
