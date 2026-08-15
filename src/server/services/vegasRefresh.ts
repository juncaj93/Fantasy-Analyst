/**
 * The only place in the app that may spend Vegas quota on weekly lines.
 *
 * What it replaces listed every upcoming NFL game and fetched props for all of
 * them, on a timer. That is the wrong shape twice: it pays for games nobody on
 * the roster is playing in, and it does it whether or not anybody is looking.
 *
 * The order of operations here is the whole design:
 *
 *   1. read the provider's own usage — free, and authoritative;
 *   2. work out which players still have an undecided week;
 *   3. find the games those players are in, paying for discovery only when the
 *      schedule is not already known;
 *   4. ask the budget how much of that plan it will allow;
 *   5. fetch that much, in priority order, and record every entity spent.
 *
 * A refusal at step 4 is not an error. The last good lines are already stored,
 * Start/Sit reads them and marks them stale, and the month survives — which is
 * the trade this file exists to make. No Vegas data beats accidental paid usage.
 */

import { getPropsWithCache } from '../../core/vegas/cache.ts';
import { canSpend, readProviderUsage, type BudgetView } from '../../core/vegas/budget.ts';
import { buildFetchPlan, type FetchPlan, type PlannedPlayer } from '../../core/vegas/plan.ts';
import { buildConsensus } from '../../core/vegas/normalize.ts';
import type { RawPropSet, VegasProvider } from '../../core/vegas/types.ts';
import type { Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerRepo } from '../repos/players.ts';
import { PropsRepo } from '../repos/props.ts';
import { SettingsRepo, SETTING_KEYS } from '../repos/settings.ts';
import { VegasEventsRepo } from '../repos/vegasEvents.ts';
import { VegasUsageRepo } from '../repos/vegasUsage.ts';

export interface VegasRefreshReport {
  provider: string;
  /** What the budget allowed, and why. */
  budget: BudgetView;
  /** Entities actually spent by this run. */
  spent: number;
  requests: number;
  /** Events fetched, served from cache, and left alone. */
  fetched: number;
  cached: number;
  skipped: number;
  /** Set when discovery ran, with what it cost. */
  discovered: number;
  plan: { events: number; estimatedEntities: number };
  blocked: string[];
  errors: string[];
  note: string;
}

/**
 * How long the learned schedule stays good.
 *
 * A week of NFL fixtures does not move, so re-discovering it daily would be
 * paying for a fact we already have. Kickoff times do occasionally shift, which
 * is why this is three days rather than never.
 */
const SCHEDULE_TTL_HOURS = 72;

/** How far ahead a refresh cares about. One NFL week, plus the Monday game. */
const HORIZON_DAYS = 8;

export class VegasRefreshService {
  private readonly usage: VegasUsageRepo;
  private readonly events: VegasEventsRepo;
  private readonly props: PropsRepo;

  constructor(
    private readonly db: Database,
    private readonly provider: VegasProvider,
  ) {
    this.usage = new VegasUsageRepo(db);
    this.events = new VegasEventsRepo(db);
    this.props = new PropsRepo(db);
  }

  async refresh(opts: { manual?: boolean; now?: number } = {}): Promise<VegasRefreshReport> {
    const now = opts.now ?? Date.now();
    const errors: string[] = [];
    const blocked: string[] = [];

    await this.syncProviderUsage(errors);
    const budget = await this.usage.view();

    const base: VegasRefreshReport = {
      provider: this.provider.name,
      budget,
      spent: 0,
      requests: 0,
      fetched: 0,
      cached: 0,
      skipped: 0,
      discovered: 0,
      plan: { events: 0, estimatedEntities: 0 },
      blocked,
      errors,
      note: budget.note,
    };

    if (!this.provider.isConfigured()) {
      return { ...base, note: `provider "${this.provider.name}" is not configured; nothing was fetched` };
    }

    const players = await this.rosterPlayers(now);
    if (players.length === 0) {
      return { ...base, note: 'no roster to price — connect a league in Team first' };
    }

    // Discovery, only when the schedule is genuinely unknown or old. This is
    // the fetch as well: the provider has no schedule-only request.
    const discovery = await this.discoverIfNeeded(players, budget, now, { errors, blocked });
    let spent = discovery.entities;
    let requests = discovery.requests;
    let fetched = discovery.events;

    const mapped = discovery.entities > 0 ? await this.rosterPlayers(now) : players;
    const plan = buildFetchPlan(mapped, { now });

    const decision = canSpend(budget, {
      entities: plan.estimatedEntities,
      // A plan is only as urgent as its most urgent event; the list is sorted,
      // so the first one decides what band the whole pass is judged in.
      priority: plan.events[0]?.priority ?? 'low',
    });
    if (!decision.allowed && plan.estimatedEntities > 0) {
      blocked.push(decision.reason);
      await this.usage.record({
        source: 'weekly',
        entities: 0,
        requests: 0,
        outcome: 'blocked',
        reason: decision.reason,
      });
    }

    let cached = 0;
    const allowance = decision.allowed ? decision.entities : 0;
    for (const event of plan.events.slice(0, allowance)) {
      try {
        const result = await getPropsWithCache(event.eventId, this.provider, this.props, {
          now,
          manual: opts.manual ?? false,
        });
        if (result.origin === 'fresh' && result.snapshot) {
          fetched++;
          spent += 1;
          requests += 1;
          await this.persist(result.snapshot.raw);
          // The same response carries the game's own total and spread. Stored
          // here as well as at discovery, because these move during the week
          // and this is the fetch that happens on a Sunday morning.
          await this.storeGameLines(result.snapshot.raw);
          await this.usage.record({
            source: opts.manual ? 'manual' : 'weekly',
            eventId: event.eventId,
            entities: 1,
            requests: 1,
            outcome: 'fetched',
            reason: event.reason,
          });
        } else if (result.origin === 'cache') {
          cached++;
        } else {
          if (result.error) errors.push(`${event.eventId}: ${result.error}`);
          await this.usage.record({
            source: opts.manual ? 'manual' : 'weekly',
            eventId: event.eventId,
            entities: 1,
            requests: 1,
            outcome: 'failed',
            reason: result.error ?? result.reason,
          });
          // A failed request still costs — an empty answer was measured at one
          // entity — so it is counted rather than forgiven.
          spent += 1;
          requests += 1;
        }
      } catch (err) {
        errors.push(`${event.eventId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await new SettingsRepo(this.db).set(SETTING_KEYS.lastVegasRefresh, new Date(now).toISOString());
    const after = await this.usage.view();

    return {
      ...base,
      budget: after,
      spent,
      requests,
      fetched,
      cached,
      discovered: discovery.events,
      skipped: plan.skipped.length + Math.max(0, plan.events.length - allowance),
      plan: { events: plan.events.length, estimatedEntities: plan.estimatedEntities },
      note: after.note,
    };
  }

  /** The plan, without spending anything. Used by diagnostics and by tests. */
  async preview(now = Date.now()): Promise<{ plan: FetchPlan; budget: BudgetView; players: PlannedPlayer[] }> {
    const players = await this.rosterPlayers(now);
    return { plan: buildFetchPlan(players, { now }), budget: await this.usage.view(), players };
  }

  /**
   * Ask the provider what it thinks we have spent.
   *
   * Free — reading usage does not move the counter, which was measured — and
   * authoritative, because it also sees spending from probes and from any other
   * deployment sharing the key.
   */
  private async syncProviderUsage(errors: string[]): Promise<void> {
    const read = (this.provider as { getAccountUsage?: () => Promise<unknown> }).getAccountUsage;
    if (typeof read !== 'function') return;
    try {
      const payload = await read.call(this.provider);
      const usage = readProviderUsage(payload);
      if (usage.entities != null) await this.usage.recordProviderUsage(usage);
    } catch (err) {
      // Not knowing is not a reason to stop; the local ledger still guards.
      errors.push(`could not read provider usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Learn the schedule, if it is not already known.
   *
   * Asking by team is what keeps this proportional to the roster: eight teams
   * cost eight entities however many games the league is playing. The answer
   * carries the odds too, so this is the week's first fetch and not an overhead
   * on top of one.
   */
  private async discoverIfNeeded(
    players: PlannedPlayer[],
    budget: BudgetView,
    now: number,
    sink: { errors: string[]; blocked: string[] },
  ): Promise<{ entities: number; requests: number; events: number }> {
    /*
     * At most one discovery per TTL, whatever the roster looks like.
     *
     * The obvious guard — "run it while any player has no game" — never stops:
     * a player on a bye has no game this week and will still have none in an
     * hour, so it would re-buy the schedule on every single pass. What decides
     * is when we last *asked*, not whether the answer covered everybody.
     */
    const attempted = await new SettingsRepo(this.db).get<string | null>(SETTING_KEYS.lastVegasSchedule, null);
    const attemptedAge = attempted ? (now - Date.parse(attempted)) / 3_600_000 : Infinity;
    if (attemptedAge < SCHEDULE_TTL_HOURS) return { entities: 0, requests: 0, events: 0 };

    const unmapped = players.filter((p) => !p.eventId).length;
    const lastSeen = await this.events.lastSeenAt();
    const ageHours = lastSeen ? (now - Date.parse(lastSeen)) / 3_600_000 : Infinity;
    if (unmapped === 0 && ageHours < SCHEDULE_TTL_HOURS) return { entities: 0, requests: 0, events: 0 };

    const fetchTeams = (this.provider as VegasProvider).getPropsForTeams;
    if (typeof fetchTeams !== 'function') {
      sink.errors.push(`provider "${this.provider.name}" cannot fetch by team; no schedule was discovered`);
      return { entities: 0, requests: 0, events: 0 };
    }

    const teams = await this.rosterTeams();
    if (teams.length === 0) return { entities: 0, requests: 0, events: 0 };

    const decision = canSpend(budget, { entities: teams.length, priority: 'normal' });
    if (!decision.allowed) {
      sink.blocked.push(`schedule discovery: ${decision.reason}`);
      await this.usage.record({
        source: 'schedule',
        entities: 0,
        requests: 0,
        outcome: 'blocked',
        reason: decision.reason,
      });
      return { entities: 0, requests: 0, events: 0 };
    }

    const from = new Date(now).toISOString();
    const to = new Date(now + HORIZON_DAYS * 86_400_000).toISOString();
    // Stamped before the call, not after: a discovery that fails halfway must
    // not become a discovery that retries on every pass for the rest of the day.
    await new SettingsRepo(this.db).set(SETTING_KEYS.lastVegasSchedule, new Date(now).toISOString());
    try {
      const result = await fetchTeams.call(this.provider, teams.slice(0, decision.entities), {
        from,
        to,
        maxEvents: decision.entities,
      });

      /*
       * The team we asked about is the mapping.
       *
       * Reading it back out of the payload would work for one vendor and fail
       * quietly for the next; the request itself already knows which team it
       * asked for. Both slots are used rather than one, so that a roster with
       * players on opposite sides of the same game maps both of them — the two
       * columns are "teams we know are in this game", not a claim about who is
       * at home.
       */
      const sides = new Map<string, { row: (typeof result.results)[number]; teams: string[] }>();
      for (const entry of result.results) {
        const bucket = sides.get(entry.set.eventId);
        if (bucket) {
          if (!bucket.teams.includes(entry.teamId)) bucket.teams.push(entry.teamId);
        } else {
          sides.set(entry.set.eventId, { row: entry, teams: [entry.teamId] });
        }
      }
      await this.events.upsertMany(
        [...sides.values()].map(({ row, teams }) => ({
          eventId: row.set.eventId,
          provider: row.set.provider,
          kickoff: row.set.gameStart || null,
          homeTeam: teams[0] ?? null,
          awayTeam: teams[1] ?? null,
          /*
           * The game's own lines, out of the response already paid for.
           *
           * The spread travels with the team it belongs to, which matters here
           * specifically: `homeTeam` in this table means "a team we asked
           * about" and not "the home side", so a spread stored against a column
           * position would be read backwards for half the slate.
           */
          total: row.set.gameLines?.total ?? null,
          spread: row.set.gameLines?.spread ?? null,
          spreadTeam: row.set.gameLines?.spreadTeam ?? null,
        })),
      );

      for (const { set } of result.results) {
        await this.props.put({
          provider: set.provider,
          eventId: set.eventId,
          gameStart: set.gameStart,
          fetchedAt: set.fetchedAt,
          raw: set,
        });
        await this.persist(set);
      }

      await this.usage.record({
        source: 'schedule',
        entities: result.entities,
        requests: result.requests,
        outcome: 'fetched',
        reason: `${teams.length} roster team(s) -> ${result.results.length} game(s)`,
      });

      return { entities: result.entities, requests: result.requests, events: result.results.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink.errors.push(`schedule discovery failed: ${message}`);
      await this.usage.record({ source: 'schedule', entities: 1, requests: 1, outcome: 'failed', reason: message });
      return { entities: 1, requests: 1, events: 0 };
    }
  }

  /**
   * Keep the game's own lines beside its event row.
   *
   * A no-op when the provider did not quote the game, which leaves whatever was
   * last known in place — the repo COALESCEs, so a quiet week cannot erase a
   * spread the app already had.
   */
  private async storeGameLines(set: RawPropSet): Promise<void> {
    const lines = set.gameLines;
    if (!lines || (lines.total == null && lines.spread == null)) return;
    await this.events.upsertMany([
      {
        eventId: set.eventId,
        provider: set.provider,
        kickoff: set.gameStart || null,
        homeTeam: null,
        awayTeam: null,
        total: lines.total,
        spread: lines.spread,
        spreadTeam: lines.spreadTeam,
      },
    ]);
  }

  /** Resolve names to players and store the consensus rows Start/Sit reads. */
  private async persist(set: RawPropSet): Promise<void> {
    const snapshotId = await this.props.snapshotId(set.provider, set.eventId, set.fetchedAt);
    if (snapshotId == null) return;
    const index = await new PlayerRepo(this.db).buildIndex();
    await this.props.saveConsensus(snapshotId, buildConsensus(set.quotes ?? [], index));
  }

  /** The teams the user's own roster spans, in the provider's vocabulary. */
  private async rosterTeams(): Promise<string[]> {
    const players = await this.rosterPlayers(Date.now());
    const teams = new Set<string>();
    for (const p of players) if (p.team) teams.add(p.team);
    return [...teams];
  }

  /**
   * The user's players, with everything the planner needs to rank them.
   *
   * "Contested" is deliberately generous: a starter whose status is uncertain,
   * or a bench player who could take a starting slot. Those are the two shapes
   * a lineup decision actually has, and everybody else is a player whose week
   * a fresh line cannot change.
   */
  private async rosterPlayers(now: number): Promise<(PlannedPlayer & { team: string | null })[]> {
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league) return [];
    const rosters = await new LeagueRepo(this.db).listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) return [];

    const starters = new Set(mine.starterIds ?? []);
    const playerIds = [...new Set([...(mine.playerIds ?? []), ...starters])].filter(Boolean);
    if (playerIds.length === 0) return [];

    const playerRepo = new PlayerRepo(this.db);
    const [index, ages] = await Promise.all([
      playerRepo.listByIds(playerIds),
      this.snapshotAges(playerIds, now),
    ]);

    const window = await this.events.teamIndex(
      new Date(now).toISOString(),
      new Date(now + HORIZON_DAYS * 86_400_000).toISOString(),
    );

    const out: (PlannedPlayer & { team: string | null })[] = [];
    for (const id of playerIds) {
      const player = index.get(id) ?? null;
      const team = player?.team ? player.team.toUpperCase() : null;
      const event = team ? (window.get(team) ?? matchTeam(window, team)) : null;
      const starter = starters.has(id);
      const status = player?.status ?? null;
      out.push({
        playerId: id,
        position: player?.position ?? '',
        team,
        eventId: event?.eventId ?? null,
        kickoff: event?.kickoff ?? null,
        starter,
        status,
        contested: !starter || (status != null && status.trim() !== ''),
        ageMinutes: ages.get(id) ?? null,
      });
    }
    return out;
  }

  /** Minutes since each player's game was last priced. */
  private async snapshotAges(playerIds: string[], now: number): Promise<Map<string, number>> {
    const props = await this.props.latestForPlayers(playerIds);
    const freshness = await this.props.freshness();
    const at = freshness.fetchedAt ? Date.parse(freshness.fetchedAt) : NaN;
    const ageMinutes = Number.isFinite(at) ? (now - at) / 60_000 : null;
    const out = new Map<string, number>();
    if (ageMinutes == null) return out;
    for (const id of playerIds) if ((props.get(id)?.length ?? 0) > 0) out.set(id, ageMinutes);
    return out;
  }
}

/**
 * Provider team ids are long (`KANSAS_CITY_CHIEFS_NFL`); Sleeper's are short
 * (`KC`). A direct hit is preferred, and this is the fallback — a suffix match
 * on the token before `_NFL`, which is exact enough not to pair two teams and
 * loose enough to survive the two vocabularies disagreeing about punctuation.
 */
function matchTeam<T>(index: Map<string, T>, team: string): T | null {
  for (const [key, value] of index) {
    if (key === team) return value;
    const tokens = key.replace(/_NFL$/, '').split('_');
    if (tokens.includes(team)) return value;
  }
  return null;
}
