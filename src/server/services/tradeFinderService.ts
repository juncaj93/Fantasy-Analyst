/**
 * The trade finder, read from stored rows (Round 19, November 2026).
 *
 * One run feeds both Trades screens: the ideas on today's screen (through
 * `core/trades/finderBoard.ts`) and the new screens behind the feature switch
 * (`/api/trades/offers`). The reads are Check a trade's own preparation of the
 * league (`TradeValueService.prepareRosters`) plus two small reads for who
 * trades often: completed trades and the ledger's roster identities, the same
 * ones Build a trade reads. No Sleeper request: every read is a stored row.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { RosterRecord } from '../../core/sleeper/types.ts';
import { tradeCapabilityOf, type TradeCapability } from '../../core/trades/capability.ts';
import { partnerActivity } from '../../core/trades/builderResponse.ts';
import { findTrades, type FinderResult, type FinderRoster } from '../../core/trades/finder.ts';
import type { Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import { activityOf } from './tradeBuilderService.ts';
import { TradeCheckError, TradeValueService, type Prepared } from './tradeValueService.ts';

export interface FinderRun {
  league: { id: string; name: string } | null;
  capability: TradeCapability | null;
  result: FinderResult;
  /** The preparation the finder ran on, for a caller that checks more deals on it. Null when none was read. */
  prepared: Prepared | null;
  /** Managers by roster id, for the board's manager line. */
  partners: Map<number, { ownerId: string | null; activityClass: string; sample: number; earlier: number | null }>;
}

const EMPTY: FinderResult['funnel'] = { partners: 0, skippedPartners: 0, generated: 0, removed: {}, unfair: {}, checked: 0, fair: 0, close: 0 };

function none(note: string, status: FinderResult['status'] = 'none'): FinderResult {
  return { status, offers: [], note, funnel: { ...EMPTY, removed: {}, unfair: {} } };
}

export class TradeFinderService {
  constructor(
    private readonly db: Database,
    private readonly sleeper: SleeperClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(opts: { leagueId?: string; focus?: { sell?: string | null; get?: string | null } | null } = {}): Promise<FinderRun> {
    const leagues = new LeagueRepo(this.db);
    const league = opts.leagueId ? await leagues.getLeague(opts.leagueId) : await leagues.getSelectedLeague();
    const partners = new Map<number, { ownerId: string | null; activityClass: string; sample: number; earlier: number | null }>();
    if (!league) return { league: null, capability: null, result: none('No league is selected, so there is nobody to trade with.'), prepared: null, partners };
    const named = { id: league.id, name: league.name };
    const capability = tradeCapabilityOf({ leagueSettings: league.leagueSettings });
    if (!capability.tradeable) return { league: named, capability, result: none(capability.reason ?? 'This league does not trade.', 'closed'), prepared: null, partners };

    let prepared: Prepared;
    let rosterLimit: number;
    try {
      ({ prepared, rosterLimit } = await new TradeValueService(this.db, this.sleeper, this.now).prepareRosters(league.id));
    } catch (err) {
      if (err instanceof TradeCheckError) return { league: named, capability, result: none(err.message), prepared: null, partners };
      throw err;
    }
    const rosters = prepared.rosters;
    if (!rosters.some((r) => r.isMine)) {
      return { league: named, capability, result: none('Your roster is not identified in this league.'), prepared, partners };
    }
    if (!rosters.some((r) => !r.isMine && r.playerIds.length > 0)) {
      return { league: named, capability, result: none('No other roster has any players yet.'), prepared, partners };
    }

    const [trades, identities] = await Promise.all([
      new TransactionRepo(this.db).completedTrades(league.id, 200).catch(() => []),
      new ManagerLedgerRepo(this.db).rosterIdentities(league.id).catch(() => []),
    ]);
    const mine = rosters.find((r) => r.isMine)!;
    const withYou = (roster: RosterRecord): number =>
      trades.filter((t) => {
        if (t.season !== league.season) return false;
        const ids = (t.transaction.roster_ids ?? []).map(Number);
        return ids.includes(roster.rosterId) && ids.includes(mine.rosterId);
      }).length;

    const finderRosters: FinderRoster[] = rosters.map((r) => {
      const activity = activityOf(r, league.season, trades, identities);
      const activityClass = partnerActivity(activity);
      partners.set(r.rosterId, { ownerId: r.ownerId, activityClass, sample: activity.thisSeason + (activity.earlier ?? 0), earlier: activity.earlier });
      return {
        rosterId: r.rosterId,
        label: r.ownerName?.trim() || `Roster ${r.rosterId}`,
        isMine: r.isMine,
        playerIds: r.playerIds,
        starterIds: r.starterIds,
        activity: { class: activityClass, thisSeason: activity.thisSeason, withYou: withYou(r), line: activity.line },
      };
    });

    const opponent = await opponentOf(this.db, { leagueId: league.id, season: league.season, week: prepared.horizon.currentWeek, rosterId: mine.rosterId });
    const result = findTrades({
      horizon: prepared.horizon,
      shape: prepared.shape,
      replacement: prepared.replacement,
      rates: prepared.rates,
      rosters: finderRosters,
      rosterLimit,
      ...(opts.focus ? { focus: opts.focus } : {}),
      opponent,
    });
    return { league: named, capability, result, prepared, partners };
  }
}

/**
 * Alex's opponent this week, and whether their matchup is final: one stored
 * row, the same one Team and Waivers read for the pairing (the matchup
 * forecast, written when the Matchup screen or its Sunday capture first sees
 * the week). Null when nobody has looked at this week's matchup yet, or on a
 * bye: then nothing is marked or hidden. Never asks Sleeper.
 */
export async function opponentOf(
  db: Database,
  opts: { leagueId: string; season: string; week: number; rosterId: number },
): Promise<{ rosterId: number; final: boolean } | null> {
  try {
    const row = await db
      .prepare(
        `SELECT opponent_roster_id AS opponent, latest_phase AS phase, settled_at AS settled
           FROM matchup_forecasts
          WHERE league_id = ? AND season = ? AND week = ? AND roster_id = ?`,
      )
      .bind(opts.leagueId, opts.season, opts.week, opts.rosterId)
      .first<{ opponent: number | null; phase: string | null; settled: string | null }>();
    if (!row || row.opponent == null) return null;
    return { rosterId: Number(row.opponent), final: row.phase === 'final' || row.settled != null };
  } catch {
    return null;
  }
}
