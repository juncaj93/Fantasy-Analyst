/**
 * Draft board assembly: combine live draft state, the frozen ADP snapshot, the
 * user's roster and the evidence signal into a ranked, explained board.
 *
 * This service NEVER makes a pick. It only reads Sleeper and returns rankings.
 */

import { rankAvailablePlayers, type DraftRecommendation } from '../../core/draft/engine.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../../core/sleeper/scoring.ts';
import { nextPickForSlot, slotForRoster, slotFromPicks } from '../../core/sleeper/transform.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
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
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  recommendations: DraftRecommendation[];
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

  constructor(db: Database) {
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.adp = new AdpRepo(db);
    this.evidence = new EvidenceRepo(db);
  }

  async build(draftId: string, opts: { limit?: number; position?: string | null } = {}): Promise<DraftBoardState> {
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

    // My roster composition drives need. Match on the Sleeper user as well as
    // the roster id: drafts that record only `picked_by` would otherwise look
    // like an empty roster, which reports every position as an unfilled need.
    const isMine = (p: { rosterId: number | null; pickedBy: string | null }): boolean =>
      (p.rosterId != null && p.rosterId === myRosterRecord?.rosterId) ||
      (!!myRosterRecord?.ownerId && p.pickedBy === myRosterRecord.ownerId);
    const myPickRecords = picks.filter((p) => p.playerId && isMine(p));
    const rosterCounts: Record<string, number> = {};
    const myRoster = myPickRecords.map((p) => {
      const player = byId.get(p.playerId!);
      const position = player?.position ?? '';
      if (position) rosterCounts[position] = (rosterCounts[position] ?? 0) + 1;
      return {
        playerId: p.playerId!,
        name: player?.fullName ?? p.playerId!,
        position,
        team: player?.team ?? '',
        pickNo: p.pickNo,
      };
    });

    // Candidate pool: ranked players who are still available. Unranked players
    // are included only when nothing is ranked at all, so the board degrades to
    // "everyone" rather than to nothing.
    const positionFilter = opts.position ? opts.position.toUpperCase() : null;
    // Only positions this league starts. A league with no kicker slot should
    // never be shown a kicker, however Sleeper ranks them.
    const startable = startablePositions(buildRosterShape(league.rosterPositions));
    const eligible = (player: CanonicalPlayer): boolean =>
      player.active &&
      !takenIds.has(player.id) &&
      (startable.size === 0 || startable.has(player.position)) &&
      (!positionFilter || player.position === positionFilter);

    const pool: CanonicalPlayer[] = allPlayers.filter(
      (p) => eligible(p) && (rankedCount === 0 || rankOf(p) != null),
    );
    pool.sort((a, b) => (rankOf(a) ?? Infinity) - (rankOf(b) ?? Infinity));

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

    const signals = await this.evidence.getSignals(candidates.map((c) => c.id));
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    const recommendations = rankAvailablePlayers(
      candidates.map((player) => ({
        player,
        adp: rankOf(player),
        adpRank: importedValues.get(player.id)?.rank ?? null,
        signal: signals.get(player.id) ?? null,
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
      adpSnapshot: snapshotMeta
        ? {
            id: snapshotMeta.id,
            label: snapshotMeta.label,
            capturedAt: snapshotMeta.capturedAt,
            matched: snapshotMeta.matchedCount,
          }
        : null,
      recommendations,
      warnings,
    };
  }
}
