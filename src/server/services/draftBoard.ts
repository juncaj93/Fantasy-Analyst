/**
 * Draft board assembly: combine live draft state, the frozen ADP snapshot, the
 * user's roster and the evidence signal into a ranked, explained board.
 *
 * This service NEVER makes a pick. It only reads Sleeper and returns rankings.
 */

import { rosterAlerts, type RosterAlert } from '../../core/draft/decisions.ts';
import { rankAvailablePlayers, type DraftRecommendation } from '../../core/draft/engine.ts';
import { computeNeed } from '../../core/draft/need.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../../core/sleeper/scoring.ts';
import { buildLiveRoster } from '../../core/draft/liveRoster.ts';
import { RepairService } from './repairService.ts';
import { nextPickForSlot, slotForRoster, slotFromPicks } from '../../core/sleeper/transform.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerFlagsRepo } from '../repos/playerFlags.ts';
import { PlayerRepo } from '../repos/players.ts';

export interface DraftBoardState {
  draftId: string;
  status: string;
  type: string;
  teams: number;
  rounds: number;
  currentPick: number;
  picksMade: number;
  mySlot: number | null;
  myNextPick: number | null;
  picksUntilMyTurn: number | null;
  onTheClock: boolean;
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  rosterCounts: Record<string, number>;
  myRoster: { playerId: string; name: string; position: string; team: string; pickNo: number }[];
  /** Starting slots with nobody to fill them yet. */
  openStarters: { slot: string; count: number; accepts: string[] }[];
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  recommendations: DraftRecommendation[];
  /** What the shape of the live roster is saying, given how late it is. */
  rosterAlerts: RosterAlert[];
  /** 1-based round currently on the clock. */
  round: number;
  /**
   * Positions this league actually starts, in a sensible reading order.
   *
   * The board already hides positions the league does not use; sending the
   * list means the filter row can stop offering chips that are guaranteed to
   * return nothing — which is what a DEF chip does in a league with no defence
   * slot, and what a K chip did everywhere.
   */
  startablePositions: string[];
  warnings: string[];
}

/**
 * How many available players the board scores.
 *
 * Comfortably more than any draft reaches (a 12-team, 16-round draft is 192
 * picks), while keeping the request small enough to answer quickly.
 */
const MAX_CANDIDATES = 300;

export class DraftBoardService {
  private readonly leagues: LeagueRepo;
  private readonly players: PlayerRepo;
  private readonly adp: AdpRepo;
  private readonly evidence: EvidenceRepo;

  constructor(private readonly db: Database) {
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.adp = new AdpRepo(db);
    this.evidence = new EvidenceRepo(db);
  }

  async build(
    draftId: string,
    opts: { limit?: number; position?: string | null; queuedOnly?: boolean } = {},
  ): Promise<DraftBoardState> {
    const draft = await this.leagues.getDraft(draftId);
    if (!draft) throw new Error(`draft ${draftId} not found`);
    const league = await this.leagues.getLeague(draft.leagueId);
    if (!league) throw new Error(`league ${draft.leagueId} not found`);

    const warnings: string[] = [];
    const picks = await this.leagues.listPicks(draftId);
    const rosters = await this.leagues.listRosters(league.id);
    const myRosterRecord = rosters.find((r) => r.isMine) ?? null;
    if (!myRosterRecord) warnings.push('your roster could not be identified in this league; roster need is disabled');

    const teams = draft.teams || league.totalRosters || 12;
    const rounds = draft.rounds || 15;
    const picksMade = picks.filter((p) => p.playerId).length;
    const currentPick = picksMade + 1;
    // Round drives how loudly an unfilled starting slot is said: no tight end in
    // round three is a plan, and no tight end in round twelve is a problem.
    const round = Math.max(1, Math.ceil(currentPick / teams));

    const mySlot =
      slotForRoster(draft.slotToRosterId, myRosterRecord?.rosterId ?? null) ??
      slotFromPicks(picks, myRosterRecord?.rosterId ?? null, myRosterRecord?.ownerId ?? null);
    const next = mySlot == null ? null : nextPickForSlot(mySlot, teams, rounds, draft.type, currentPick);
    // Without a slot there is no "your next pick", so survival and scarcity are
    // both computed against an unknown horizon. Say so rather than let the board
    // look confident about numbers it could not work out.
    if (myRosterRecord && mySlot == null) {
      warnings.push(
        'your draft slot is unknown — Sleeper has not published one and you have not picked yet, so "who lasts until your next pick" is guesswork',
      );
    }

    // Players already taken.
    const takenIds = new Set(picks.map((p) => p.playerId).filter((id): id is string => !!id));

    // Draft order comes from an imported ADP snapshot. A draft can be pinned to
    // a specific one so a board opened mid-draft does not shift under the user
    // when a fresher snapshot lands; otherwise the newest applies.
    const snapshotMeta = draft.adpSnapshotId
      ? await this.adp.get(draft.adpSnapshotId)
      : await this.adp.latest();
    const importedValues = snapshotMeta ? await this.adp.valuesByPlayer(snapshotMeta.id) : new Map();

    const allPlayers = await this.players.listAll();
    // Only a real ranking counts. Sleeper's search_rank measures who gets
    // looked up rather than who gets picked — using it here put Drake Maye near
    // the top of the board and retired players on it at all.
    const rankOf = (player: CanonicalPlayer): number | null =>
      importedValues.get(player.id)?.adp ?? null;
    const rankedCount = allPlayers.filter((p) => p.active && rankOf(p) != null).length;
    if (rankedCount === 0) {
      warnings.push(
        'no draft order yet — players are ranked by news and roster need only, which is a poor substitute. Sleeper ADP for this league is fetched each morning; import a ranking file if you need one before then.',
      );
    }
    const byId = new Map(allPlayers.map((p) => [p.id, p]));

    // Roster need comes from the same reconstruction the Team page shows, so the
    // two can never disagree about what has been drafted.
    const shapeForRoster = buildRosterShape(league.rosterPositions);
    const live = buildLiveRoster({
      picks,
      rosterId: myRosterRecord?.rosterId ?? null,
      ownerId: myRosterRecord?.ownerId ?? null,
      sleeperPlayerIds: myRosterRecord?.playerIds ?? [],
      byId,
      shape: shapeForRoster,
      draftStatus: draft.status,
    });
    const rosterCounts = live.counts;
    const myRoster = live.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      team: p.team,
      pickNo: p.pickNo ?? 0,
    }));

    // Candidate pool: ranked players who are still available. Unranked players
    // are included only when nothing is ranked at all, so the board degrades to
    // "everyone" rather than to nothing.
    const positionFilter = opts.position ? opts.position.toUpperCase() : null;
    /*
     * The queue, when that is what was asked for.
     *
     * Read before the pool is cut rather than after: a player you queued in the
     * eleventh round is exactly the one you want the filter to surface, and
     * scoring only the top of the board would hide him. The flag table is a
     * shortlist by nature, so reading all of it costs nothing.
     */
    const allFlags = await new PlayerFlagsRepo(this.db).all();
    const queuedOnly = opts.queuedOnly === true;
    // Only positions this league starts. A league with no kicker slot should
    // never be shown a kicker, however Sleeper ranks them.
    const startable = startablePositions(buildRosterShape(league.rosterPositions));
    const eligible = (player: CanonicalPlayer): boolean =>
      player.active &&
      !takenIds.has(player.id) &&
      (startable.size === 0 || startable.has(player.position)) &&
      (!positionFilter || player.position === positionFilter) &&
      (!queuedOnly || (allFlags.get(player.id) ?? 0) > 0);

    /*
     * "Only ranked players" has to be asked per position, not once for the board.
     *
     * Dropping unranked players stops 2,500 names drowning a board that has a
     * real ranking, and that is right — as long as the position has a ranking
     * to be dropped from. No published ADP this project uses covers defences,
     * so a single global test silently erased the entire position from a league
     * that starts one: the filter chip appeared, the board came back empty, and
     * nothing said why.
     *
     * So a position the ranking does not cover at all keeps its players. A
     * position the ranking does cover keeps only the ranked ones, exactly as
     * before.
     */
    const rankedByPosition = new Map<string, number>();
    for (const p of allPlayers) {
      if (!p.active || rankOf(p) == null) continue;
      rankedByPosition.set(p.position, (rankedByPosition.get(p.position) ?? 0) + 1);
    }
    const positionIsRanked = (position: string): boolean => (rankedByPosition.get(position) ?? 0) > 0;

    const pool: CanonicalPlayer[] = allPlayers.filter(
      // Unranked players are normally dropped, but never from your own queue:
      // you put them there, so leaving them out would be the app overruling you.
      (p) => eligible(p) && (queuedOnly || !positionIsRanked(p.position) || rankOf(p) != null),
    );
    /*
     * Draft order first. Within a position nobody ranks, `search_rank` breaks
     * the tie — it is emphatically not ADP (it measures who gets looked up) and
     * is never allowed to set the board's order, but ordering thirty-two
     * defences by how often they are searched beats ordering them by accident.
     * Their market-value component is still `unknown` and they are still marked
     * degraded, so nothing here pretends to a draft position it does not have.
     */
    pool.sort(
      (a, b) =>
        (rankOf(a) ?? Infinity) - (rankOf(b) ?? Infinity) ||
        (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
        a.fullName.localeCompare(b.fullName),
    );

    // Say it out loud, because those rows will look thin next to ranked ones.
    const unrankedStartable = [...startable].filter((p) => !positionIsRanked(p)).sort();
    if (unrankedStartable.length > 0 && rankedCount > 0) {
      warnings.push(
        `no draft order covers ${unrankedStartable.join(', ')} in this ranking, so they are listed on news and roster need alone`,
      );
    }

    // Sleeper ranks ~2,500 players; scoring all of them on every request is
    // work nobody reads, and it is far more than any draft will reach. The cap
    // is applied after the position filter, so filtering by QB still considers
    // the best quarterbacks rather than whoever survived a global cut.
    const candidates = pool.slice(0, MAX_CANDIDATES);
    if (pool.length > candidates.length) {
      warnings.push(
        `showing the top ${MAX_CANDIDATES} available by draft order; ${pool.length - candidates.length} ranked lower are not scored`,
      );
    }
    if (queuedOnly && pool.length === 0) {
      warnings.push('your queue is empty — tap the star beside a player to add them');
    }

    // Non-blocking draft-day readiness: unresolved names are research the user
    // did that is not reaching the board. Say so here rather than only in Setup,
    // because this is the screen they are looking at when it matters.
    const repair = await new RepairService(this.db).status();
    if (repair.summary.names > 0 && Math.abs(repair.summary.net) >= 2) {
      warnings.push(
        `${repair.summary.headline} — fix it under Help my scores in Setup; the board is usable meanwhile`,
      );
    }

    const signals = await this.evidence.getSignals(candidates.map((c) => c.id));
    // The user's own shortlist, already read above.
    const flags = allFlags;
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    const recommendations = rankAvailablePlayers(
      candidates.map((player) => ({
        player,
        adp: rankOf(player),
        adpRank: importedValues.get(player.id)?.rank ?? null,
        signal: signals.get(player.id) ?? null,
        myGuyLevel: flags.get(player.id) ?? 0,
      })),
      {
        currentPick,
        nextPick: next?.pickNo ?? null,
        shape,
        profile,
        rosterCounts,
        totalPicks: teams * rounds,
      },
    ).slice(0, opts.limit ?? 50);

    return {
      draftId,
      status: draft.status,
      type: draft.type,
      teams,
      rounds,
      currentPick,
      picksMade,
      mySlot,
      myNextPick: next?.pickNo ?? null,
      picksUntilMyTurn: next?.picksUntil ?? null,
      onTheClock: next?.pickNo === currentPick,
      league: {
        id: league.id,
        name: league.name,
        scoringLabel: profile.label,
        notes: leagueFitNotes(profile, shape),
      },
      rosterCounts,
      myRoster,
      openStarters: live.openStarters,
      adpSnapshot: snapshotMeta
        ? {
            id: snapshotMeta.id,
            label: snapshotMeta.label,
            capturedAt: snapshotMeta.capturedAt,
            matched: snapshotMeta.matchedCount,
          }
        : null,
      recommendations,
      rosterAlerts: rosterAlerts({
        shape,
        counts: rosterCounts,
        needs: computeNeed(shape, rosterCounts),
        round,
        totalRounds: rounds,
      }),
      round,
      startablePositions: orderPositions(startable),
      warnings,
    };
  }
}

/** Conventional reading order, with anything unexpected kept and put last. */
const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'DEF'];

function orderPositions(positions: Set<string>): string[] {
  const known = POSITION_ORDER.filter((p) => positions.has(p));
  const rest = [...positions].filter((p) => !POSITION_ORDER.includes(p)).sort();
  return [...known, ...rest];
}
