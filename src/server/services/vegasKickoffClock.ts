/**
 * The scheduled odds job: look at each game when its own kickoff says to.
 *
 * `core/vegas/kickoffClock.ts` holds the arithmetic and this holds the state.
 * It is called from the five-minute tick and has to cost almost nothing on the
 * ticks where nothing is due, because there are 288 of them a day and a handful
 * that matter.
 *
 * ## What a tick costs
 *
 * **Nothing is due: one settings row.** The gate stores the next instant any
 * game gets a new checkpoint. A tick before it reads that row and returns.
 *
 * **A checkpoint has arrived: about 100 rows to find out whether anything
 * needs buying**, plus whatever the pass reads to plan. The stored schedule for
 * this week and next is read by primary-key prefix (two `forWeek` reads of 32
 * rows, never a scan of the season), the roster is read, and per-game ages
 * decide. A pass whose games are all fresh buys nothing and calls the provider
 * zero times beyond one free usage read.
 *
 * ## Why a gate at all
 *
 * Without it every tick would plan, and planning reads the roster, the players
 * and the stored quotes: hundreds of rows, 288 times a day, to learn what the
 * schedule already says. With it a week is about forty planning passes (seven kickoff
 * slots, six checkpoints each), which is what the checkpoints are.
 *
 * ## Failure is "look sooner"
 *
 * A missing, unreadable or future-dated gate row means "plan now". A pass that
 * could not reach every due game (the per-run cap, the provider's per-minute
 * limit) comes back in ten minutes, six times at most. A pass the budget
 * refused on purpose is not retried until the next checkpoint: the answer will
 * not change before then and the retry would cost reads to hear it again.
 */

import {
  CLOCK_MAX_SLEEP_MINUTES,
  checkpointPending,
  nextPassAfter,
  plannedPasses,
} from '../../core/vegas/kickoffClock.ts';
import type { VegasProvider } from '../../core/vegas/types.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import type { Database } from '../db.ts';
import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { VegasRefreshService, type VegasRefreshReport } from './vegasRefresh.ts';
import { LeagueRepo } from '../repos/league.ts';

/** How long a pass that could not reach every due game waits before trying again. */
export const CLOCK_RETRY_MINUTES = 10;
/** And how many times in a row it may, before it waits for the next checkpoint. */
export const CLOCK_MAX_RETRIES = 6;

export interface ClockLast {
  at: string;
  outcome: 'ran' | 'skipped';
  fetched: number;
  cached: number;
  spent: number;
  discovered: number;
  leftover: number;
  note: string;
}

export interface ClockState {
  /** Every checkpoint up to here has had its pass. Null means "unknown". */
  processedThrough: string | null;
  /** The first tick that could have anything new, ISO. Null means "look now". */
  next: string | null;
  retries: number;
  last: ClockLast | null;
}

export interface ClockPlanPass {
  /** The five-minute tick the pass fires on, ISO. */
  at: string;
  /** The kickoffs with a checkpoint at this tick, and how many hours out it is. */
  kickoffs: { kickoff: string; hoursBefore: number }[];
  leagueGames: number;
  /** Games the job may buy at this tick: the most it can cost in entities. */
  rosterGames: number;
}

export interface ClockRun {
  outcome: 'ran' | 'skipped';
  report: VegasRefreshReport | null;
  note: string;
}

export class VegasKickoffClock {
  private readonly settings: SettingsRepo;

  constructor(
    private readonly db: Database,
    private readonly provider: VegasProvider,
  ) {
    this.settings = new SettingsRepo(db);
  }

  /**
   * Run a pass if a checkpoint has arrived. Null means the tick had nothing to do.
   *
   * Never throws for a reason about the data: the caller wraps it anyway, but a
   * schedule that cannot be read is an `idle` outcome with a note, not a crash.
   */
  async runIfDue(now: number = Date.now()): Promise<ClockRun | null> {
    const state = await this.readState();
    const next = state.next == null ? NaN : Date.parse(state.next);
    // One row, and out. A gate row in the future of the clock is believed.
    if (Number.isFinite(next) && next > now) return null;

    const kickoffs = await this.upcomingKickoffs(now);
    if (kickoffs == null) {
      await this.writeState({ ...state, next: iso(now + 60 * 60_000) });
      return null;
    }

    const pending = checkpointPending(kickoffs, state.processedThrough, now);
    if (!pending) {
      await this.writeState({
        ...state,
        processedThrough: state.processedThrough ?? iso(now),
        next: iso(this.nextWake(kickoffs, now)),
        retries: 0,
      });
      return null;
    }

    if (!this.provider.isConfigured()) {
      const note = `provider "${this.provider.name}" is not configured; nothing was fetched`;
      await this.writeState({
        processedThrough: iso(now),
        next: iso(this.nextWake(kickoffs, now)),
        retries: 0,
        last: { at: iso(now), outcome: 'skipped', fetched: 0, cached: 0, spent: 0, discovered: 0, leftover: 0, note },
      });
      return { outcome: 'skipped', report: null, note };
    }

    const report = await new VegasRefreshService(this.db, this.provider).refresh({ clock: true, now });

    const retry = report.leftover > 0 && state.retries < CLOCK_MAX_RETRIES;
    const wake = retry ? now + CLOCK_RETRY_MINUTES * 60_000 : this.nextWake(kickoffs, now);
    const last: ClockLast = {
      at: iso(now),
      outcome: 'ran',
      fetched: report.fetched,
      cached: report.cached,
      spent: report.spent,
      discovered: report.discovered,
      leftover: report.leftover,
      note: report.blocked[0] ?? report.errors[0] ?? report.note,
    };
    await this.writeState({
      // A pass with games still to reach keeps the old mark, so the next tick
      // finds the same checkpoint pending and finishes the job.
      processedThrough: retry ? state.processedThrough : iso(now),
      next: iso(wake),
      retries: retry ? state.retries + 1 : 0,
      last,
    });
    return { outcome: 'ran', report, note: last.note };
  }

  /**
   * Forget what has been processed, so the next tick plans afresh.
   *
   * Called when the stored schedule has just been refreshed: a flexed game's
   * checkpoints moved, and the ones already behind it may be owed a pass. The
   * per-game rule decides what that pass buys, so an unchanged week costs a
   * planning pass and no entities.
   */
  async invalidate(): Promise<void> {
    await invalidateKickoffClock(this.db);
  }

  /**
   * The passes the stored schedule implies over the next `days` days.
   *
   * A read: the same arithmetic the job runs, over the same stored kickoffs, so
   * what it prints is what will fire. `games` is every game the league plays at
   * that tick; `rosterGames` is the subset the job would be allowed to buy,
   * which is the number an entity bill is made of. A game two of the roster's
   * teams share counts once.
   */
  async plan(now: number = Date.now(), days = 7): Promise<ClockPlanPass[]> {
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    const state = await this.settings.get<NflState | null>(SETTING_KEYS.nflState, null);
    const week = Number(state?.week);
    if (!league?.season || !Number.isInteger(week) || week < 1) return [];
    const repo = new NflScheduleRepo(this.db);
    const rows = [...(await repo.forWeek(league.season, week)), ...(await repo.forWeek(league.season, week + 1))];
    const covered = new Set(await new VegasRefreshService(this.db, this.provider).coveredTeams(now));

    const games = new Map<string, { kickoff: string; roster: boolean }>();
    for (const row of rows) {
      if (row.kickoff == null || row.opponent == null) continue;
      const key = `${row.kickoff}|${[row.team, row.opponent].sort().join('@')}`;
      const held = games.get(key) ?? { kickoff: row.kickoff, roster: false };
      held.roster ||= covered.has(row.team.toUpperCase());
      games.set(key, held);
    }

    const to = now + days * 86_400_000;
    const passes = plannedPasses([...games.values()].map((g) => g.kickoff), now, to);
    const rosterKickoffs = new Map<string, number>();
    for (const g of games.values()) if (g.roster) rosterKickoffs.set(g.kickoff, (rosterKickoffs.get(g.kickoff) ?? 0) + 1);
    const leagueKickoffs = new Map<string, number>();
    for (const g of games.values()) leagueKickoffs.set(g.kickoff, (leagueKickoffs.get(g.kickoff) ?? 0) + 1);

    return passes.map((pass) => {
      const byKickoff = new Map<string, { hoursBefore: number[]; }>();
      for (const g of pass.games) {
        const held = byKickoff.get(g.kickoff) ?? { hoursBefore: [] };
        held.hoursBefore.push(g.hoursBefore);
        byKickoff.set(g.kickoff, held);
      }
      let leagueGames = 0;
      let rosterGames = 0;
      for (const kickoff of byKickoff.keys()) {
        leagueGames += leagueKickoffs.get(kickoff) ?? 0;
        rosterGames += rosterKickoffs.get(kickoff) ?? 0;
      }
      return {
        at: pass.at,
        kickoffs: [...byKickoff.entries()].map(([kickoff, v]) => ({ kickoff, hoursBefore: v.hoursBefore[0]! })),
        leagueGames,
        rosterGames,
      };
    });
  }

  /** The gate row as stored, for diagnostics. Never a write. */
  async state(): Promise<ClockState> {
    return this.readState();
  }

  /**
   * Every kickoff the clock cares about: the NFL week in play and the next one.
   *
   * By week, because the schedule's primary key starts `(season, week)` and a
   * range over `kickoff` has no index to use. Null when the week or the season
   * is unknown, which the caller reads as "ask again in an hour".
   */
  private async upcomingKickoffs(now: number): Promise<string[] | null> {
    try {
      const league = await new LeagueRepo(this.db).getSelectedLeague();
      const state = await this.settings.get<NflState | null>(SETTING_KEYS.nflState, null);
      const week = Number(state?.week);
      if (!league?.season || !Number.isInteger(week) || week < 1) return null;
      const repo = new NflScheduleRepo(this.db);
      const [thisWeek, nextWeek] = await Promise.all([
        repo.forWeek(league.season, week),
        repo.forWeek(league.season, week + 1),
      ]);
      const seen = new Set<string>();
      for (const row of [...thisWeek, ...nextWeek]) {
        if (row.kickoff != null && Date.parse(row.kickoff) > now) seen.add(row.kickoff);
      }
      return [...seen];
    } catch {
      return null;
    }
  }

  /** The next checkpoint, but never further off than the sleep ceiling. */
  private nextWake(kickoffs: readonly string[], now: number): number {
    const ceiling = now + CLOCK_MAX_SLEEP_MINUTES * 60_000;
    const next = nextPassAfter(kickoffs, now);
    return next == null ? ceiling : Math.min(next, ceiling);
  }

  private async readState(): Promise<ClockState> {
    const raw = await this.settings.get<Partial<ClockState> | null>(SETTING_KEYS.vegasClock, null).catch(() => null);
    return {
      processedThrough: typeof raw?.processedThrough === 'string' ? raw.processedThrough : null,
      next: typeof raw?.next === 'string' ? raw.next : null,
      retries: Number.isInteger(raw?.retries) ? Number(raw?.retries) : 0,
      last: raw?.last ?? null,
    };
  }

  private async writeState(state: ClockState): Promise<void> {
    await this.settings.set(SETTING_KEYS.vegasClock, state);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * {@link VegasKickoffClock.invalidate} without a provider in hand.
 *
 * What the schedule ingest calls, which has a database and no odds provider and
 * should not need one to say "a kickoff moved".
 */
export async function invalidateKickoffClock(db: Database): Promise<void> {
  const settings = new SettingsRepo(db);
  const raw = await settings.get<Partial<ClockState> | null>(SETTING_KEYS.vegasClock, null).catch(() => null);
  await settings.set(SETTING_KEYS.vegasClock, {
    processedThrough: null,
    next: null,
    retries: 0,
    last: raw?.last ?? null,
  } satisfies ClockState);
}
