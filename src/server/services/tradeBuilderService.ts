/**
 * Build a trade, assembled from what is already stored.
 *
 * One request, on a deliberate tap, never on the Trades screen's first paint.
 * It reads:
 *
 *  - the rosters and their players' rates through `TradeValueService`, the
 *    same preparation Check a trade uses (so a package here and the same deal
 *    typed into Check a trade carry the same numbers): Alex's roster and the
 *    team asked about, or every roster when Alex asks all teams;
 *  - three settings rows the Waivers screen already keeps: this season's
 *    points by week, Sleeper's depth order and injury notes, and this league's
 *    draft rounds (for the drop score and its protections);
 *  - this season's stored transactions (weeks held, and who has traded), the
 *    completed trades of earlier seasons, and the ledger's roster identities to
 *    say whose those were.
 *
 * Every read is batched; there is no per-player query, and Sleeper is never
 * called. Marks are not stored: they arrive on the request from the phone.
 */

import { buildTradePackages, BUILDER, type BuilderTeam } from '../../core/trades/builder.ts';
import type { BuilderResponse, TradeActivity } from '../../core/trades/builderResponse.ts';
import { tradeCapabilityOf } from '../../core/trades/capability.ts';
import { readPlayerNotes, PLAYER_NOTES_KEY, type StoredPlayerNotes } from '../../core/sleeper/playerNotes.ts';
import { seasonPointsKey, type StoredSeasonPoints } from '../../core/sleeper/weekPoints.ts';
import type { RosterRecord } from '../../core/sleeper/types.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { PlayerRate } from '../../core/tradeValue/rate.ts';
import { eliteBacks, eliteHandcuffs, type DropSignals } from '../../core/waivers/dropScore.ts';
import { draftCapital } from '../../core/waivers/tierInputs.ts';
import type { Database } from '../db.ts';
import { ManagerLedgerRepo } from '../repos/managerLedger.ts';
import { SettingsRepo } from '../repos/settings.ts';
import { TransactionRepo } from '../repos/transactions.ts';
import { PlayerRepo } from '../repos/players.ts';
import { seasonMovesOf } from './leagueStrategyService.ts';
import { TradeValueService } from './tradeValueService.ts';
import { draftRoundsKey } from './waiverRound2.ts';

/** Most marks of each kind a request may carry. */
export const MAX_MARKS = 12;

export interface BuilderRequest {
  sell: string[];
  /** Want marks, by roster id. */
  want: Map<number, string[]>;
  team: number | 'all';
  considerUnmarked: boolean;
  /** One team of an All teams sweep; see `BuilderInput.sweep`. */
  sweep?: boolean;
}

export class TradeBuilderService {
  constructor(
    private readonly db: Database,
    private readonly sleeper: SleeperClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async build(leagueId: string, request: BuilderRequest): Promise<BuilderResponse> {
    const values = new TradeValueService(this.db, this.sleeper, this.now);
    /* Alex's roster and the team asked about, or every roster for all teams. */
    const { prepared, rosterLimit } = await values.prepareRosters(
      leagueId,
      request.team === 'all' ? undefined : (r) => r.isMine || r.rosterId === request.team,
    );
    const { league, rosters, horizon, shape, rates, replacement } = prepared;
    const mine = rosters.find((r) => r.isMine);
    const base = { league: { id: league.id, name: league.name } };
    if (!mine) {
      return { ...base, ...notFound('No roster in this league is marked as yours.') };
    }
    if (!tradeCapabilityOf({ leagueSettings: league.leagueSettings }).tradeable) {
      return { ...base, ...notFound('This league does not allow trades.') };
    }

    const others = rosters.filter((r) => !r.isMine && r.playerIds.length > 0 && (request.team === 'all' || r.rosterId === request.team));
    const [rows, seasonTxns, trades, identities, players] = await Promise.all([
      new SettingsRepo(this.db)
        .getMany<unknown>([seasonPointsKey(league.season), PLAYER_NOTES_KEY, draftRoundsKey(league.id)])
        .catch(() => new Map<string, unknown>()),
      new TransactionRepo(this.db).list(league.id, { season: league.season }).catch(() => []),
      new TransactionRepo(this.db).completedTrades(league.id, 200).catch(() => []),
      new ManagerLedgerRepo(this.db).rosterIdentities(league.id).catch(() => []),
      new PlayerRepo(this.db).listAll().catch(() => []),
    ]);
    const season = (rows.get(seasonPointsKey(league.season)) as StoredSeasonPoints | undefined) ?? null;
    const notes = readPlayerNotes((rows.get(PLAYER_NOTES_KEY) as StoredPlayerNotes | undefined) ?? null);
    const rounds = new Map(Object.entries((rows.get(draftRoundsKey(league.id)) as Record<string, number> | undefined) ?? {}));

    const rateList = (roster: RosterRecord): PlayerRate[] =>
      roster.playerIds.map((id) => rates.get(id)).filter((p): p is PlayerRate => p != null);
    const myRoster = rateList(mine);

    /* Alex's elite backs: the league's top backs by points a game, or a back at an elite number, or a first- or second-round pick. */
    const positionOf = new Map(players.map((p) => [p.id, p.position ?? ''] as const));
    const totals = new Map<string, { total: number; games: number }>();
    for (const [id, weeks] of Object.entries(season?.points ?? {})) {
      totals.set(id, { total: weeks.reduce((a, b) => a + b, 0), games: weeks.filter((x) => x !== 0).length });
    }
    const elite = eliteBacks(totals, (id) => positionOf.get(id) === 'RB');
    const eliteRbs = new Set(
      myRoster
        .filter(
          (p) =>
            p.position === 'RB' &&
            (elite.has(p.playerId) || (p.rate ?? 0) >= BUILDER.eliteRbRate || (rounds.get(p.playerId) ?? 99) <= BUILDER.eliteRbRound),
        )
        .map((p) => p.playerId),
    );

    /* The waiver planner's protections, for a forced drop. */
    const depth = new Map(Object.entries(notes.depth).map(([id, rank]) => [id, { rank }] as const));
    const handcuffs = eliteHandcuffs({
      roster: myRoster.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team, rate: p.rate })),
      elite: new Set([...elite, ...eliteRbs]),
      depth,
    });
    const protections = new Map<string, string>();
    for (const [id, star] of handcuffs) protections.set(id, `backs up ${star.name}`);
    for (const [id, note] of draftCapital(myRoster, rounds, new Map(Object.entries(notes.injury)), horizon.currentWeek)) {
      if (!protections.has(id)) protections.set(id, note);
    }

    /* The drop score's inputs, as the waiver planner builds them. */
    const moves = seasonMovesOf(seasonTxns, mine.rosterId);
    const dropSignals = new Map<string, DropSignals>();
    if (season) {
      const through = season.through;
      for (const p of myRoster) {
        if (p.rate == null) continue;
        const weeks = season.points[p.playerId] ?? [];
        const span = Math.max(1, Math.min(3, p.weekly.length));
        const trend = prepared.evaluations?.get(p.playerId)?.role.trend ?? null;
        const held = moves.heldSince.get(p.playerId) ?? null;
        dropSignals.set(p.playerId, {
          playerId: p.playerId,
          name: p.name,
          position: p.position,
          seasonPoints: Math.round(weeks.reduce((a, b) => a + b, 0) * 10) / 10,
          weeksPlayed: through,
          recent: [through, through - 1, through - 2].filter((w) => w >= 1).map((w) => weeks[w - 1] ?? 0),
          projection: Math.round(((p.rate ?? 0) * p.weekly.slice(0, span).reduce((a, b) => a + b, 0)) / span * 100) / 100,
          role: trend?.startsWith('rising') ? 'rising' : trend?.startsWith('falling') ? 'falling' : trend === 'stable' ? 'stable' : null,
          heldWeeks: held ? Math.max(0, horizon.currentWeek - held.week) : null,
          drafted: held == null && rounds.has(p.playerId),
          weeksSinceDraft: Math.max(0, horizon.currentWeek - 1),
          draftRound: rounds.get(p.playerId) ?? null,
          handcuffOf: handcuffs.get(p.playerId)?.name ?? null,
          inLineup: false,
          unavailable: ['out', 'ir', 'pup', 'suspended'].includes(p.designation),
          injured: !['healthy', 'unknown'].includes(p.designation),
          healthyRate: p.rate,
        });
      }
    }

    const activity = (roster: RosterRecord): TradeActivity => activityOf(roster, league.season, trades, identities);
    const teams: BuilderTeam[] = others.map((r) => ({
      rosterId: r.rosterId,
      label: r.ownerName?.trim() || `Roster ${r.rosterId}`,
      roster: rateList(r),
      starterIds: r.starterIds,
      activity: activity(r),
    }));

    const result = buildTradePackages({
      horizon,
      shape,
      replacement,
      rosterLimit,
      reserveSlots: Math.max(shape.irSlots, Number(league.leagueSettings['reserve_slots']) || 0),
      reserveAllows: {
        out: Number(league.leagueSettings['reserve_allow_out']) === 1,
        doubtful: Number(league.leagueSettings['reserve_allow_doubtful']) === 1,
        sus: Number(league.leagueSettings['reserve_allow_sus']) === 1,
      },
      me: {
        rosterId: mine.rosterId,
        label: mine.ownerName?.trim() || 'You',
        roster: myRoster,
        starterIds: mine.starterIds,
        reserveIds: mine.reserveIds,
        activity: activity(mine),
      },
      teams,
      sell: request.sell,
      want: request.want,
      team: request.team,
      considerUnmarked: request.considerUnmarked,
      eliteRbs,
      handcuffs: new Set(handcuffs.keys()),
      ...(request.sweep && request.team !== 'all' ? { sweep: true } : {}),
      protections,
      dropSignals: dropSignals.size > 0 ? dropSignals : null,
    });
    return { ...base, ...result };
  }
}

function notFound(message: string): Omit<BuilderResponse, 'league'> {
  return {
    status: 'not_found',
    message,
    weeks: null,
    deadline: null,
    packages: [],
    teams: [],
    audit: { generated: 0, evaluated: 0, shown: 0, hidden: {} },
    notes: [],
    willingness: '',
    advisory: '',
  };
}

/**
 * How many completed trades a manager has made, this season and in earlier
 * seasons this app has read.
 *
 * This season is counted on the roster id directly. An earlier season's roster
 * ids are that season's, so they are mapped to the Sleeper user through the
 * ledger's identities for that season before they are counted. A note only:
 * it moves no number and ranks nothing.
 */
export function activityOf(
  roster: Pick<RosterRecord, 'rosterId' | 'ownerId'>,
  season: string,
  trades: readonly { season: string; transaction: { roster_ids?: number[] | null } }[],
  identities: readonly { season: string; rosterId: number; userId: string | null }[],
): TradeActivity {
  const thisSeason = trades.filter((t) => t.season === season && (t.transaction.roster_ids ?? []).map(Number).includes(roster.rosterId)).length;
  const earlierSeasons = new Set(identities.filter((i) => i.season !== season && i.userId != null && i.userId === roster.ownerId).map((i) => i.season));
  let earlier: number | null = null;
  if (roster.ownerId && earlierSeasons.size > 0) {
    earlier = 0;
    for (const t of trades) {
      if (t.season === season || !earlierSeasons.has(t.season)) continue;
      const ids = new Set(identities.filter((i) => i.season === t.season && i.userId === roster.ownerId).map((i) => i.rosterId));
      if ((t.transaction.roster_ids ?? []).map(Number).some((id) => ids.has(id))) earlier += 1;
    }
  }
  const plural = (n: number) => `${n} trade${n === 1 ? '' : 's'}`;
  const line =
    thisSeason > 0
      ? `Has made ${plural(thisSeason)} this season${earlier ? `, ${earlier} before` : ''}`
      : earlier
        ? `No trades this season, ${plural(earlier)} in earlier seasons`
        : earlier === 0
          ? 'No trades on record'
          : 'No trades this season';
  return { thisSeason, earlier, line };
}
