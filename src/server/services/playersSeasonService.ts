/**
 * What the in-season Players tab reads (Round 24, behind `PLAYERS_INSEASON`).
 *
 * ## The board: one request for the whole tab
 *
 * Every player on a roster plus the free-agent pool Waivers and Trades price
 * replacement level on, each with his rest-of-season value, trade-target read,
 * injury read and the draft list's own numbers (draft order, pick, 7-day and
 * 30-day moves). The values are Check a trade's own preparation of the league
 * (`TradeValueService.prepareRosters`), so a player has the same value here as
 * on Trades and Waivers. "Trades often" is the trade finder's reads: completed
 * trades and the ledger's roster identities. The sort and both filters run on
 * the phone over this one answer, so a filter reads nothing.
 *
 * Remembered for ten minutes per Worker, keyed on who holds whom: a trade or a
 * waiver claim changes the key, so the board is rebuilt; anything else is the
 * rosters (one small read) and nothing more.
 *
 * ## The card: one player
 *
 * This week's number is `weekPoints`, computed the way Compare's list computes
 * it (the same inputs, engine, published week and mode). The next weeks are
 * the stored Sleeper projections for the three weeks after this one; the last
 * games are the stored season row. A few dozen rows.
 *
 * On the preview upload (`PREVIEW = "players"`) both answer from the made-up
 * preview league and read nothing.
 */

import { orderPlayers } from '../../core/draft/playerOrder.ts';
import { draftPickLabel } from '../../core/draft/provenance.ts';
import { injuryRead, lastGames, nextWeeks, overFreeAgent, seasonValue, tradeTargets, type BoardRoster } from '../../core/players/inseason.ts';
import { byOverFreeAgent } from '../../core/players/seasonOrder.ts';
import { previewSeasonBoard, previewSeasonCard } from '../../core/players/seasonPreview.ts';
import type { SeasonBoard, SeasonCard, SeasonRow } from '../../core/players/seasonWire.ts';
import { ownerTeams, rosterOwnership } from '../../core/roster/ownership.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import { buildScoringProfile } from '../../core/sleeper/scoring.ts';
import type { RosterRecord } from '../../core/sleeper/types.ts';
import { aheadPointsKey, seasonPointsKey, type StoredSeasonPoints, type StoredWeekPoints } from '../../core/sleeper/weekPoints.ts';
import { evaluatePlayer } from '../../core/startsit/engine.ts';
import { weekPoints } from '../../core/startsit/weekPoints.ts';
import { partnerActivity } from '../../core/trades/builderResponse.ts';
import { byeOf, currentWeekOf, tradeHorizon } from '../../core/tradeValue/weeks.ts';
import { playedWeeksOf } from '../../core/value/restOfSeason.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { PlayerRepo } from '../repos/players.ts';
import { SettingsRepo } from '../repos/settings.ts';
import { SlowRead } from '../repos/slowRead.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import { readAppNflState } from './appWeek.ts';
import { SleeperProjectionService } from './sleeperProjectionService.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import { activityOf } from './tradeBuilderService.ts';
import { TradeCheckError, TradeValueService } from './tradeValueService.ts';

/** How long a Worker keeps a board it built. */
export const BOARD_MEMO_MS = 10 * 60 * 1000;

const boards = new SlowRead<SeasonBoard>(BOARD_MEMO_MS);

/** Drop every remembered board for this database. For tests. */
export function forgetSeasonBoards(db: Database): void {
  boards.forget(db);
}

/** Who holds whom, as one string: the board's memo key. */
function holdings(rosters: readonly RosterRecord[]): string {
  return rosters.map((r) => `${r.rosterId}:${[...r.playerIds].sort().join(',')}`).join('|');
}

export class PlayersSeasonService {
  constructor(
    private readonly db: Database,
    private readonly sleeper: SleeperClient,
    /** True on the preview upload: answer from the made-up league. */
    private readonly preview: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async board(leagueId?: string | null): Promise<SeasonBoard> {
    if (this.preview) return previewSeasonBoard();
    const leagues = new LeagueRepo(this.db);
    const league = leagueId ? await leagues.getLeague(leagueId) : await leagues.getSelectedLeague();
    if (!league) return { league: null, week: null, tradeOpen: false, teams: [], rows: [], reason: 'No league is selected.' };
    const rosters = await leagues.listRosters(league.id);
    return boards.get(this.db, `${league.id}#${holdings(rosters)}`, () => this.build(league.id, { id: league.id, name: league.name }, league.season));
  }

  private async build(leagueId: string, named: { id: string; name: string }, season: string): Promise<SeasonBoard> {
    let prepared;
    try {
      ({ prepared } = await new TradeValueService(this.db, this.sleeper, this.now).prepareRosters(leagueId));
    } catch (err) {
      if (err instanceof TradeCheckError) return { league: named, week: null, tradeOpen: false, teams: [], rows: [], reason: err.message };
      throw err;
    }
    const { rosters, horizon, rates } = prepared;
    const ids = [...rates.keys()];
    const adp = new AdpRepo(this.db);
    const [trades, identities, snapshot, signals, picks] = await Promise.all([
      new TransactionRepo(this.db).completedTrades(leagueId, 200).catch(() => []),
      new ManagerLedgerRepo(this.db).rosterIdentities(leagueId).catch(() => []),
      adp.latestPlatformSnapshot().catch(() => null),
      new EvidenceRepo(this.db).getSignals(ids).catch(() => new Map()),
      new LeagueRepo(this.db).listLeagueDraftPicks(leagueId).catch(() => []),
    ]);
    const ranks = snapshot ? await adp.valuesByPlayer(snapshot.id).catch(() => new Map()) : new Map();

    const mine = rosters.find((r) => r.isMine);
    const boardRosters: BoardRoster[] = rosters.map((r) => ({
      rosterId: r.rosterId,
      isMine: r.isMine,
      playerIds: r.playerIds,
      activity: partnerActivity(activityOf(r, season, trades, identities)),
      tradedWithYou: mine
        ? trades.filter((t) => {
            if (t.season !== season) return false;
            const inIt = (t.transaction.roster_ids ?? []).map(Number);
            return inIt.includes(r.rosterId) && inIt.includes(mine.rosterId);
          }).length
        : 0,
    }));
    const targets = horizon.deadlinePassed ? new Map() : tradeTargets({ horizon, shape: prepared.shape, rates, rosters: boardRosters });
    const owned = rosterOwnership(rosters);
    const pickOf = new Map<string, string>();
    for (const pick of picks) {
      const label = draftPickLabel(pick.pickNo, pick.teams);
      if (label) pickOf.set(pick.playerId, label);
    }
    const players = await new PlayerRepo(this.db).listByIds(ids).catch(() => new Map());
    const draft = new Map(
      orderPlayers(
        ids.map((id) => ({ id, name: rates.get(id)!.name, draftRank: ranks.get(id)?.adp ?? null, net: signals.get(id)?.raw.net ?? 0 })),
      ).map((r) => [r.player.id, r] as const),
    );

    const rows: SeasonRow[] = ids.map((id) => {
      const rate = rates.get(id)!;
      const signal = signals.get(id);
      const order = draft.get(id);
      return {
        id,
        name: rate.name,
        position: rate.position,
        team: rate.team,
        status: players.get(id)?.status ?? null,
        ownerRosterId: owned.get(id) ?? null,
        value: seasonValue(rate, horizon),
        overFreeAgent: overFreeAgent(rate, prepared.replacement, horizon),
        injury: injuryRead(rate, horizon),
        trade: targets.get(id) ?? null,
        draftRank: order?.draftRank ?? null,
        adjustedRank: order?.adjustedRank ?? null,
        draftPick: pickOf.get(id) ?? null,
        last7: signal?.last7.net ?? 0,
        last30: signal?.last30.net ?? 0,
        lifetime: signal?.raw.net ?? 0,
      };
    });
    rows.sort(byOverFreeAgent);
    return { league: named, week: horizon.weeks.length > 0 ? horizon.currentWeek : null, tradeOpen: !horizon.deadlinePassed, teams: ownerTeams(rosters), rows };
  }

  async card(playerId: string, leagueId?: string | null): Promise<SeasonCard | null> {
    if (this.preview) return previewSeasonCard(playerId);
    const leagues = new LeagueRepo(this.db);
    const [league, player, state] = await Promise.all([
      leagueId ? leagues.getLeague(leagueId) : leagues.getSelectedLeague(),
      new PlayerRepo(this.db).getById(playerId),
      readAppNflState(this.db, this.now()),
    ]);
    if (!player) return null;
    const empty: SeasonCard = { playerId, week: null, thisWeek: { points: null, sleeper: false, out: false }, next: [], last: [] };
    if (!league) return empty;

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const horizon = tradeHorizon({ leagueSettings: league.leagueSettings, currentWeek: currentWeekOf(state) });
    const week = horizon.currentWeek;
    const later = horizon.weeks.slice(1, 4);
    const team = (player.team ?? '').toUpperCase();
    const [inputs, published, stored, fixtures] = await Promise.all([
      startSitInputsFor(this.db, [playerId], { mode: 'balanced', now: this.now() }),
      new SleeperProjectionService(this.db, this.sleeper)
        .publishedFor({ season: league.season, week, playerIds: [playerId], profile, positionOf: () => player.position, narrow: true })
        .catch((): Map<string, number> => new Map()),
      new SettingsRepo(this.db)
        .getMany<unknown>([seasonPointsKey(league.season), ...later.map((w) => aheadPointsKey(league.season, w))])
        .catch(() => new Map<string, unknown>()),
      horizon.weeks.length === 0 || !team
        ? Promise.resolve([])
        : new NflScheduleRepo(this.db).forTeams(league.season, [team], { from: horizon.currentWeek, to: horizon.lastWeek }).catch(() => []),
    ]);
    const input = inputs[0];
    const reading = input ? weekPoints(evaluatePlayer({ ...input, mode: 'balanced', now: this.now() }, profile), published) : null;
    const thisWeek = {
      points: reading?.points == null ? null : Math.round(reading.points * 10) / 10,
      sleeper: reading != null && !reading.out && reading.points != null && reading.basis === 'published',
      out: reading?.out === true,
    };
    const ahead = new Map<number, number>();
    for (const w of later) {
      const row = stored.get(aheadPointsKey(league.season, w)) as StoredWeekPoints | undefined;
      const v = row?.points?.[playerId];
      if (typeof v === 'number') ahead.set(w, v);
    }
    const bye = team ? byeOf(fixtures, team, { from: horizon.currentWeek, to: horizon.lastWeek }) : { known: false, byeWeek: null };
    const season = stored.get(seasonPointsKey(league.season)) as StoredSeasonPoints | undefined;
    return {
      playerId,
      week: horizon.weeks.length > 0 ? week : null,
      thisWeek,
      next: nextWeeks({ weeks: horizon.weeks, byeWeek: bye.byeWeek, thisWeek, ahead }),
      last: lastGames({
        leaguePoints: season?.points?.[playerId] ?? null,
        through: Math.min(season?.through ?? 0, week - 1),
        playedWeeks: playedWeeksOf(input?.usageWeeks),
      }),
    };
  }
}
