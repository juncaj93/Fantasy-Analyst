/**
 * The trade check, assembled from what is already stored.
 *
 * ## What it reads, and what it does not
 *
 * One request prepares one batch of inputs and runs the model on it:
 *
 *  - the league and its rosters (two small reads);
 *  - **only the players that matter**: the two rosters in the trade and a short
 *    list of free agents per position to set replacement level. Not every rostered
 *    player in the league, which is what the Smart Trades board reads and is four
 *    times the work for a question about two teams;
 *  - Sleeper's published week for those players **through the table's key**, not
 *    the whole stored week;
 *  - the market's season line, **only for players whose own week is not a read of
 *    them** (a bye, an injury, nothing priced), asked after the first pass says
 *    who those are;
 *  - the fixture list for the clubs involved, for bye weeks.
 *
 * There is no per-player query and no loop that touches the database. Every read
 * is a batched `IN (...)`, and the Sleeper client is never called: this is a read
 * of stored rows, so it adds nothing to the free-plan request count.
 *
 * The free-agent shortlist is ordered by Sleeper's own rank, with no draft-ADP
 * read: it only has to contain the free agents a manager would actually claim,
 * and the model then ranks them by its own number.
 */

import { evaluatePlayer, type StartSitEvaluation } from '../../core/startsit/engine.ts';
import { boundedFreeAgentIds } from '../../core/roster/freeAgents.ts';
import { buildRosterShape, buildScoringProfile, startablePositions } from '../../core/sleeper/scoring.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import type { LeagueRecord, RosterRecord, SleeperTransaction } from '../../core/sleeper/types.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import { SEASON_GAMES } from '../../core/waivers/seasonOutlook.ts';
import { MIN_MARKET_COVERAGE } from '../../core/waivers/seasonOutlook.ts';
import { seasonBaseline } from '../../core/vegas/season.ts';
import { buildPlayerRate, type PlayerRate } from '../../core/tradeValue/rate.ts';
import { needsSeasonLine } from '../../core/tradeValue/rate.ts';
import {
  evaluateTrade,
  replacementLevels,
  type PlayerLine,
  type ReplacementLevels,
  type TradeEvaluation,
  type TradeSide,
} from '../../core/tradeValue/evaluate.ts';
import { byeOf, tradeHorizon, type TradeHorizon } from '../../core/tradeValue/weeks.ts';
import {
  TRADE_CHECK_ADVISORY,
  type TradeCheckResponse,
  type TradeHorizonView,
  type TradeReplay,
  type TradeReplayResponse,
  type TradeTeam,
  type TradeTeamsResponse,
} from '../../core/tradeValue/response.ts';
import { LeagueRepo } from '../repos/league.ts';
import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import { SettingsRepo, SETTING_KEYS } from '../repos/settings.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import type { SeasonMarketKey } from '../../core/vegas/types.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import type { Database } from '../db.ts';
import { buildStartSitContext, startSitInputsFor } from './startSitInputs.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';

/** Free agents read per position to set replacement level. */
export const REPLACEMENT_POOL_PER_POSITION = 10;

/** Most players on one side of a checked trade. */
export const MAX_PLAYERS_PER_SIDE = 4;

/** An error that carries the HTTP status the route should answer with. */
export class TradeCheckError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TradeCheckError';
    this.status = status;
  }
}

interface Prepared {
  league: LeagueRecord;
  rosters: RosterRecord[];
  horizon: TradeHorizon;
  shape: ReturnType<typeof buildRosterShape>;
  rates: Map<string, PlayerRate>;
  replacement: ReplacementLevels;
  /** How many players were evaluated, for the cost report. */
  evaluated: number;
}

function labelOf(roster: RosterRecord): string {
  return roster.ownerName?.trim() || `Roster ${roster.rosterId}`;
}

function viewOf(horizon: TradeHorizon): TradeHorizonView {
  return {
    currentWeek: horizon.currentWeek,
    lastWeek: horizon.lastWeek,
    weeks: horizon.weeks.length,
    playoffWeeks: horizon.playoffWeeks,
    deadlineWeek: horizon.deadlineWeek,
    deadlinePassed: horizon.deadlinePassed,
    weeksToDeadline: horizon.weeksToDeadline,
  };
}

/**
 * The week a trade made now first affects.
 *
 * Preseason is week one, the whole season ahead. After the regular season, or
 * out of season, there is nothing left to affect, and 19 makes the horizon empty
 * so the model says so instead of valuing weeks that cannot be played.
 */
export function currentWeekOf(state: NflState | null): number {
  if (!state) return 1;
  if (state.seasonType === 'post' || state.seasonType === 'off') return 19;
  if (state.seasonType === 'pre') return 1;
  return state.week != null && state.week > 0 ? state.week : 1;
}

/**
 * How many players a roster may hold in this league, from its own settings.
 *
 * Starters, bench, and the injured-reserve and taxi slots Sleeper reports in
 * `settings`. Sleeper's `roster_positions` names the starters and the bench but
 * not always the reserve slots (this league has two and lists none), so reading
 * the slot list alone undercounts and flags a full roster as over the limit.
 */
export function rosterLimitOf(league: LeagueRecord, shape: ReturnType<typeof buildRosterShape>): number {
  const reserve = Number(league.leagueSettings['reserve_slots']);
  const taxi = Number(league.leagueSettings['taxi_slots']);
  const extra = Math.max(shape.irSlots, (Number.isFinite(reserve) ? reserve : 0) + (Number.isFinite(taxi) ? taxi : 0));
  return shape.totalStarters + shape.benchSlots + extra;
}

const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/**
 * How far back to look for an earlier week's published projection when a
 * player has no number this week. Three weeks covers a bye plus a week or two
 * of injury without reaching back to a different role.
 */
const RECENT_WEEKS_BACK = 3;

export class TradeValueService {
  private readonly leagues: LeagueRepo;

  constructor(
    private readonly db: Database,
    private readonly sleeper: SleeperClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.leagues = new LeagueRepo(db);
  }

  private async leagueOf(leagueId: string): Promise<{ league: LeagueRecord; rosters: RosterRecord[]; state: NflState | null }> {
    const league = await this.leagues.getLeague(leagueId);
    if (!league) throw new TradeCheckError('league not found', 404);
    const [rosters, state] = await Promise.all([
      this.leagues.listRosters(league.id),
      new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null),
    ]);
    return { league, rosters, state };
  }

  /**
   * The rosters, for the screen's pickers. Names and slots only, no values.
   *
   * A separate, cheap request: it reads the rosters and the players on them,
   * which is what a reader needs to choose who is in the trade, and none of the
   * market reads the check itself needs.
   */
  async teams(leagueId: string): Promise<TradeTeamsResponse> {
    const { league, rosters, state } = await this.leagueOf(leagueId);
    if (!rosters.some((r) => r.isMine)) {
      return { found: false, reason: 'No roster in this league is marked as yours.' };
    }
    if (!rosters.some((r) => !r.isMine && r.playerIds.length > 0)) {
      return { found: false, reason: 'Nobody has a roster yet, so there is nothing to trade.' };
    }
    const ids = [...new Set(rosters.flatMap((r) => r.playerIds))];
    const players = await new PlayerRepo(this.db).listByIds(ids);
    const horizon = tradeHorizon({ leagueSettings: league.leagueSettings, currentWeek: currentWeekOf(state) });

    const teams: TradeTeam[] = rosters
      .map((roster) => ({
        rosterId: roster.rosterId,
        label: labelOf(roster),
        isMine: roster.isMine,
        players: roster.playerIds
          .map((id) => {
            const p = players.get(id);
            return {
              playerId: id,
              name: p?.fullName ?? id,
              position: p?.position ?? '',
              team: p?.team ?? '',
              status: p?.status ?? null,
              reserve: roster.reserveIds.includes(id),
              starter: roster.starterIds.includes(id),
            };
          })
          .sort(
            (x, y) =>
              (POSITION_ORDER.indexOf(x.position) + 1 || 99) - (POSITION_ORDER.indexOf(y.position) + 1 || 99) ||
              x.name.localeCompare(y.name),
          ),
      }))
      .sort((x, y) => Number(y.isMine) - Number(x.isMine) || x.label.localeCompare(y.label));

    return { found: true, league: { id: league.id, name: league.name }, horizon: viewOf(horizon), teams };
  }

  /** Evaluate one trade between two rosters. */
  async check(
    leagueId: string,
    request: { a: number; b: number; aSends: string[]; bSends: string[] },
  ): Promise<TradeCheckResponse> {
    const { league, rosters, state } = await this.leagueOf(leagueId);
    const a = rosters.find((r) => r.rosterId === request.a);
    const b = rosters.find((r) => r.rosterId === request.b);
    if (!a || !b) throw new TradeCheckError('One of those teams is not in this league.');
    if (a.rosterId === b.rosterId) throw new TradeCheckError('A trade needs two different teams.');
    if (request.aSends.length > MAX_PLAYERS_PER_SIDE || request.bSends.length > MAX_PLAYERS_PER_SIDE) {
      throw new TradeCheckError(`A side can give at most ${MAX_PLAYERS_PER_SIDE} players.`);
    }
    if (request.aSends.length + request.bSends.length === 0) throw new TradeCheckError('Pick at least one player to move.');
    for (const id of request.aSends) if (!a.playerIds.includes(id)) throw new TradeCheckError(`${labelOf(a)} does not have that player.`);
    for (const id of request.bSends) if (!b.playerIds.includes(id)) throw new TradeCheckError(`${labelOf(b)} does not have that player.`);

    const prepared = await this.prepare({
      league,
      rosters,
      state,
      playerIds: [...a.playerIds, ...b.playerIds],
      reserveIds: [...a.reserveIds, ...b.reserveIds],
      movedIds: [...request.aSends, ...request.bSends],
    });

    const sideOf = (roster: RosterRecord): TradeSide => ({
      label: labelOf(roster),
      rosterId: roster.rosterId,
      isMine: roster.isMine,
      roster: roster.playerIds.map((id) => prepared.rates.get(id)).filter((p): p is PlayerRate => p != null),
      starterIds: roster.starterIds,
    });

    const evaluation = evaluateTrade({
      horizon: prepared.horizon,
      shape: prepared.shape,
      replacement: prepared.replacement,
      a: sideOf(a),
      b: sideOf(b),
      rosterLimit: rosterLimitOf(league, prepared.shape),
      aSends: request.aSends,
      bSends: request.bSends,
    });

    return {
      found: true,
      league: { id: league.id, name: league.name },
      horizon: viewOf(prepared.horizon),
      sides: {
        a: { rosterId: a.rosterId, label: labelOf(a), isMine: a.isMine },
        b: { rosterId: b.rosterId, label: labelOf(b), isMine: b.isMine },
      },
      evaluation,
      notes: leagueNotes(league),
      advisory: TRADE_CHECK_ADVISORY,
    };
  }

  /**
   * Several trades from one league, with the data read once.
   *
   * For the Trades screen's ideas (finding T3, October 2026): every surfaced
   * idea is held to the same rest-of-season verdict a reader would get by
   * typing it into Check a trade. `check` prepares two rosters per call; this
   * prepares the union of every roster the ideas touch once and evaluates each
   * deal in memory, so five ideas cost about one check, not five.
   *
   * A deal that is not valid (a player not on the roster sending him, too many
   * players, the same team twice) is skipped rather than thrown on: the caller
   * is a board that must not fail because one idea went stale.
   */
  async checkMany(
    leagueId: string,
    deals: readonly { id: string; a: number; b: number; aSends: readonly string[]; bSends: readonly string[] }[],
  ): Promise<Map<string, TradeEvaluation>> {
    if (deals.length === 0) return new Map<string, TradeEvaluation>();
    const { league, rosters, state } = await this.leagueOf(leagueId);
    return this.evaluateDeals(league, rosters, state, deals);
  }

  /**
   * The Trades screen's ideas, each checked from the user's side.
   *
   * The same as {@link checkMany} with side A always the user's own roster,
   * resolved here from the one roster read the check makes anyway. Returns
   * nothing when the league has no roster marked as the user's.
   */
  async checkIdeas(
    leagueId: string,
    ideas: readonly { id: string; partnerRosterId: number; give: readonly string[]; get: readonly string[] }[],
  ): Promise<Map<string, TradeEvaluation>> {
    if (ideas.length === 0) return new Map<string, TradeEvaluation>();
    const { league, rosters, state } = await this.leagueOf(leagueId);
    const mine = rosters.find((r) => r.isMine);
    if (!mine) return new Map<string, TradeEvaluation>();
    return this.evaluateDeals(
      league,
      rosters,
      state,
      ideas.map((i) => ({ id: i.id, a: mine.rosterId, b: i.partnerRosterId, aSends: i.give, bSends: i.get })),
    );
  }

  private async evaluateDeals(
    league: LeagueRecord,
    rosters: RosterRecord[],
    state: NflState | null,
    deals: readonly { id: string; a: number; b: number; aSends: readonly string[]; bSends: readonly string[] }[],
  ): Promise<Map<string, TradeEvaluation>> {
    const out = new Map<string, TradeEvaluation>();
    const byId = new Map(rosters.map((r) => [r.rosterId, r] as const));
    const valid = deals.filter((d) => {
      const a = byId.get(d.a);
      const b = byId.get(d.b);
      if (!a || !b || a.rosterId === b.rosterId) return false;
      if (d.aSends.length + d.bSends.length === 0) return false;
      if (d.aSends.length > MAX_PLAYERS_PER_SIDE || d.bSends.length > MAX_PLAYERS_PER_SIDE) return false;
      return d.aSends.every((id) => a.playerIds.includes(id)) && d.bSends.every((id) => b.playerIds.includes(id));
    });
    if (valid.length === 0) return out;

    const involved = [...new Set(valid.flatMap((d) => [d.a, d.b]))].map((id) => byId.get(id)!);
    const prepared = await this.prepare({
      league,
      rosters,
      state,
      playerIds: [...new Set(involved.flatMap((r) => r.playerIds))],
      reserveIds: [...new Set(involved.flatMap((r) => r.reserveIds))],
      movedIds: [...new Set(valid.flatMap((d) => [...d.aSends, ...d.bSends]))],
    });
    const sideOf = (roster: RosterRecord): TradeSide => ({
      label: labelOf(roster),
      rosterId: roster.rosterId,
      isMine: roster.isMine,
      roster: roster.playerIds.map((id) => prepared.rates.get(id)).filter((p): p is PlayerRate => p != null),
      starterIds: roster.starterIds,
    });
    for (const d of valid) {
      out.set(
        d.id,
        evaluateTrade({
          horizon: prepared.horizon,
          shape: prepared.shape,
          replacement: prepared.replacement,
          a: sideOf(byId.get(d.a)!),
          b: sideOf(byId.get(d.b)!),
          rosterLimit: rosterLimitOf(league, prepared.shape),
          aSends: [...d.aSends],
          bSends: [...d.bSends],
        }),
      );
    }
    return out;
  }

  /**
   * Past trades from this league, replayed through the model.
   *
   * For a person asking "does this say anything absurd", not a prediction test:
   * the model is run today, on today's data, about deals made in the past. A
   * trade from this season is replayed against both rosters rebuilt from their
   * current state with the deal reversed, when every player still sits where the
   * trade put him. Anything older, or any deal whose players have since moved, is
   * reported as each side's bundle valued over replacement, which is what those
   * players are worth now and says nothing about what they were worth then.
   */
  async replay(leagueId: string, opts: { limit?: number } = {}): Promise<TradeReplayResponse> {
    const { league, rosters, state } = await this.leagueOf(leagueId);
    const limit = Math.max(1, Math.min(opts.limit ?? 12, 20));
    const stored = await new TransactionRepo(this.db).completedTrades(league.id, limit);
    const horizon = tradeHorizon({ leagueSettings: league.leagueSettings, currentWeek: currentWeekOf(state) });
    const notes: string[] = [];
    if (stored.length === 0) {
      return { league: { id: league.id, name: league.name }, horizon: viewOf(horizon), considered: 0, replays: [], notes: ['No completed trades are stored for this league yet.'] };
    }

    type Plan = {
      row: { season: string; transaction: SleeperTransaction };
      received: Map<number, string[]>;
      rosterIds: number[];
      reversible: boolean;
    };
    const byRoster = new Map(rosters.map((r) => [r.rosterId, r] as const));
    const plans: Plan[] = stored.map((row) => {
      const received = new Map<number, string[]>();
      for (const [playerId, rosterId] of Object.entries(row.transaction.adds ?? {})) {
        const list = received.get(rosterId) ?? [];
        list.push(playerId);
        received.set(rosterId, list);
      }
      const rosterIds = [...received.keys()].sort((x, y) => x - y);
      const current = row.season === league.season;
      const reversible =
        current &&
        rosterIds.length === 2 &&
        rosterIds.every((id) => byRoster.has(id)) &&
        rosterIds.every((id) => (received.get(id) ?? []).every((p) => byRoster.get(id)!.playerIds.includes(p)));
      return { row, received, rosterIds, reversible };
    });

    const ids = new Set<string>();
    const reserve: string[] = [];
    for (const plan of plans) {
      for (const players of plan.received.values()) for (const p of players) ids.add(p);
      if (plan.reversible) {
        for (const id of plan.rosterIds) {
          const roster = byRoster.get(id)!;
          for (const p of roster.playerIds) ids.add(p);
          reserve.push(...roster.reserveIds);
        }
      }
    }
    const prepared = await this.prepare({ league, rosters, state, playerIds: [...ids], reserveIds: reserve, movedIds: plans.flatMap((plan) => [...plan.received.values()].flat()) });

    const replays: TradeReplay[] = plans.map((plan) => {
      const tx = plan.row.transaction;
      const rosterList = plan.rosterIds.map((rosterId) => ({
        rosterId,
        label: byRoster.get(rosterId) ? labelOf(byRoster.get(rosterId)!) : `Roster ${rosterId}`,
      }));
      const base = {
        id: tx.transaction_id,
        season: plan.row.season,
        week: tx.leg ?? 0,
        rosters: rosterList,
        received: plan.rosterIds.map((rosterId) => ({
          rosterId,
          players: (plan.received.get(rosterId) ?? []).map((id) => prepared.rates.get(id)?.name ?? id),
        })),
        picksMoved: (tx.draft_picks ?? []).length,
        faabMoved: (tx.waiver_budget ?? []).reduce((sum, m) => sum + (Number(m.amount) || 0), 0),
      };
      const extra: string[] = [];
      if (base.picksMoved > 0) extra.push(`${base.picksMoved} draft pick(s) moved in this deal and are not valued.`);
      if (base.faabMoved > 0) extra.push(`$${base.faabMoved} of waiver money moved in this deal and is not valued.`);

      if (plan.reversible) {
        const [x, y] = plan.rosterIds as [number, number];
        const rx = byRoster.get(x)!;
        const ry = byRoster.get(y)!;
        const gotX = plan.received.get(x) ?? [];
        const gotY = plan.received.get(y) ?? [];
        // Before the trade: each roster has what it has now, minus what it
        // received, plus what it gave away.
        const before = (roster: RosterRecord, got: string[], gave: string[]): PlayerRate[] =>
          [...roster.playerIds.filter((id) => !got.includes(id)), ...gave]
            .map((id) => prepared.rates.get(id))
            .filter((p): p is PlayerRate => p != null);
        const side = (roster: RosterRecord, got: string[], gave: string[]): TradeSide => ({
          label: labelOf(roster),
          rosterId: roster.rosterId,
          isMine: roster.isMine,
          roster: before(roster, got, gave),
          starterIds: roster.starterIds.filter((id) => !got.includes(id)),
        });
        const evaluation = evaluateTrade({
          horizon: prepared.horizon,
          shape: prepared.shape,
          replacement: prepared.replacement,
          a: side(rx, gotX, gotY),
          b: side(ry, gotY, gotX),
          rosterLimit: rosterLimitOf(league, prepared.shape),
          aSends: gotY,
          bSends: gotX,
        });
        return { ...base, mode: 'roster_aware' as const, evaluation, notes: extra };
      }

      const bundles = plan.rosterIds.map((rosterId) => {
        const lines = (plan.received.get(rosterId) ?? []).map((id) => {
          const rate = prepared.rates.get(id);
          const level = rate ? prepared.replacement.get(rate.position) : undefined;
          const rosValue =
            rate?.rate == null || !level ? null : Math.max(0, Math.round(rate.games * (rate.rate - level.rate) * 10) / 10);
          return { name: rate?.name ?? id, position: rate?.position ?? '', rosValue, basis: rate?.basis ?? 'none' };
        });
        const priced = lines.every((l) => l.rosValue != null);
        return { rosterId, players: lines, total: priced ? Math.round(lines.reduce((s, l) => s + (l.rosValue ?? 0), 0) * 10) / 10 : null };
      });
      const why =
        plan.row.season !== league.season
          ? 'An earlier season, so these are the players’ values today and not what they were worth then.'
          : 'A player in this deal has since moved, so only each side’s players are valued, not the lineups.';
      return { ...base, mode: 'bundles' as const, evaluation: null, bundles, notes: [why, ...extra] };
    });

    notes.push(
      'Run today on today’s data. This checks for absurd outputs. It does not test whether the model predicts anything.',
    );
    return { league: { id: league.id, name: league.name }, horizon: viewOf(horizon), considered: stored.length, replays, notes };
  }

  /* ------------------------------------------------------------------------ */

  private async prepare(opts: {
    league: LeagueRecord;
    rosters: RosterRecord[];
    state: NflState | null;
    playerIds: string[];
    reserveIds: string[];
    /** The players the question is about. A defence among them is what makes every defence get read. */
    movedIds: string[];
  }): Promise<Prepared> {
    const { league, rosters, state } = opts;
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);
    const horizon = tradeHorizon({ leagueSettings: league.leagueSettings, currentWeek: currentWeekOf(state) });
    const week = horizon.currentWeek;

    const rosteredIds = new Set<string>();
    for (const roster of rosters) for (const id of roster.playerIds) rosteredIds.add(id);

    /*
     * The free agents that set replacement level.
     *
     * The dictionary read is memoised for an hour in `PlayerRepo`, and the
     * ordering is Sleeper's own rank with no ADP read. Defences are only taken
     * when one is in the trade: a defence nobody moves cancels out of both
     * lineups, and reading all thirty-two to prove it would be a waste.
     */
    const players = await new PlayerRepo(this.db).listAll();
    const startable = startablePositions(shape);
    const positionById = new Map(players.map((p) => [p.id, p.position] as const));
    const wantDef = startable.has('DEF') && opts.movedIds.some((id) => positionById.get(id) === 'DEF');
    const positions = new Set([...startable].filter((p) => p !== 'DEF' || wantDef));
    const freeAgentIds = boundedFreeAgentIds(players, {
      rosteredIds,
      startable: positions,
      ranks: new Map(),
      perPosition: REPLACEMENT_POOL_PER_POSITION,
    });

    const allIds = [...new Set([...opts.playerIds, ...freeAgentIds])];
    const context = await buildStartSitContext(this.db, undefined, this.now());
    const inputs = await startSitInputsFor(this.db, allIds, {
      context,
      now: this.now(),
      reserveIds: opts.reserveIds,
    });
    const evaluations = new Map<string, StartSitEvaluation>();
    for (const input of inputs) {
      evaluations.set(input.player.id, evaluatePlayer({ ...input, mode: 'balanced', now: this.now() }, profile));
    }

    const positionOf = new Map(inputs.map((i) => [i.player.id, i.player.position ?? null] as const));
    const published =
      horizon.weeks.length === 0
        ? new Map<string, number>()
        : await new SleeperProjectionService(this.db, this.sleeper)
            .publishedFor({
              season: league.season,
              week,
              playerIds: allIds,
              profile,
              positionOf: (id) => positionOf.get(id) ?? null,
              narrow: true,
            })
            .catch((): Map<string, number> => new Map<string, number>());

    // Byes, for the clubs of the players actually on the two rosters.
    const rosterPlayers = inputs.filter((i) => opts.playerIds.includes(i.player.id));
    const clubs = [...new Set(rosterPlayers.map((i) => (i.player.team ?? '').toUpperCase()).filter((t) => t.length > 0))];
    const fixtures =
      horizon.weeks.length === 0 || clubs.length === 0
        ? []
        : await new NflScheduleRepo(this.db)
            .forTeams(league.season, clubs, { from: horizon.currentWeek, to: horizon.lastWeek })
            .catch(() => []);
    const byeFor = (player: CanonicalPlayer): { known: boolean; byeWeek: number | null } =>
      player.position === 'DEF' || !player.team
        ? byeOf(fixtures, player.team ?? player.id, { from: horizon.currentWeek, to: horizon.lastWeek })
        : byeOf(fixtures, player.team, { from: horizon.currentWeek, to: horizon.lastWeek });

    // Season lines, for the players whose own week is not a read of them.
    const byes = new Map(inputs.map((i) => [i.player.id, byeFor(i.player)] as const));
    const needy = inputs
      .filter((i) => {
        const evaluation = evaluations.get(i.player.id)!;
        const bye = byes.get(i.player.id)!;
        return needsSeasonLine({ evaluation, published, byeThisWeek: bye.byeWeek != null && bye.byeWeek === horizon.currentWeek });
      })
      .map((i) => i.player.id);
    const markets =
      needy.length === 0
        ? new Map<string, { market: SeasonMarketKey; line: number | null }[]>()
        : await new SeasonMarketsRepo(this.db)
            .latestForPlayers(league.season, needy)
            .catch(() => new Map<string, { market: SeasonMarketKey; line: number | null }[]>());
    const seasonLineOf = (id: string): number | null => {
      const position = positionOf.get(id);
      const lines = markets.get(id);
      if (!position || !lines) return null;
      const baseline = seasonBaseline(position, lines, profile);
      if (baseline.points == null || baseline.coverage < MIN_MARKET_COVERAGE) return null;
      return baseline.points / SEASON_GAMES;
    };

    /*
     * An earlier week, for the needy players the season line does not cover.
     *
     * This provider publishes no season lines, so on a bye week every player
     * on that club had no rate and any trade that moved one got no verdict.
     * His most recent earlier week's published projection is the stand-in,
     * read through the same scoring gate as this week's (a quarterback this
     * league's scoring refuses stays refused). One keyed read for the players
     * still missing, over the last few weeks, so a few dozen rows at most.
     */
    const missing = needy.filter((id) => seasonLineOf(id) == null);
    const lookBack = Array.from({ length: RECENT_WEEKS_BACK }, (_, i) => week - 1 - i).filter((w) => w >= 1);
    const recentWeeks =
      missing.length === 0 || lookBack.length === 0
        ? new Map<string, { week: number; points: number }>()
        : await new SleeperProjectionService(this.db, this.sleeper)
            .publishedRecent({
              season: league.season,
              weeks: lookBack,
              playerIds: missing,
              profile,
              positionOf: (id) => positionOf.get(id) ?? null,
              floor: 1,
            })
            .catch(() => new Map<string, { week: number; points: number }>());

    const reserved = new Set(opts.reserveIds);
    const rates = new Map<string, PlayerRate>();
    for (const input of inputs) {
      const id = input.player.id;
      const bye = byes.get(id)!;
      rates.set(
        id,
        buildPlayerRate({
          evaluation: evaluations.get(id)!,
          published,
          seasonLine: seasonLineOf(id),
          recentWeek: recentWeeks.get(id) ?? null,
          weeks: horizon.weeks,
          byeWeek: bye.byeWeek,
          byeKnown: bye.known,
          onReserve: reserved.has(id),
        }),
      );
    }

    const freeAgents = freeAgentIds.map((id) => rates.get(id)).filter((p): p is PlayerRate => p != null);
    return { league, rosters, horizon, shape, rates, replacement: replacementLevels(freeAgents), evaluated: inputs.length };
  }
}

/** What the number does not cover, said once and always. */
function leagueNotes(league: LeagueRecord): string[] {
  const notes: string[] = [];
  const picks = Number(league.leagueSettings['pick_trading']);
  notes.push(
    picks === 1
      ? 'Draft picks are not valued here. A deal with picks in it is only half measured.'
      : 'This league does not trade draft picks this season.',
  );
  notes.push('Waiver money (FAAB) that moves in a trade is not valued.');
  return notes;
}

export type { PlayerLine, TradeEvaluation };
