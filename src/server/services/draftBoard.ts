/**
 * Draft board assembly: combine live draft state, the frozen ADP snapshot, the
 * user's roster and the evidence signal into a ranked, explained board.
 *
 * This service NEVER makes a pick. It only reads Sleeper and returns rankings.
 */

import { rankAvailablePlayers, type DraftRecommendation } from '../../core/draft/engine.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes } from '../../core/sleeper/scoring.ts';
import { nextPickForSlot, slotForRoster } from '../../core/sleeper/transform.ts';
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

    const mySlot = slotForRoster(draft.slotToRosterId, myRosterRecord?.rosterId ?? null);
    const next = mySlot == null ? null : nextPickForSlot(mySlot, teams, rounds, draft.type, currentPick);

    // Players already taken.
    const takenIds = new Set(picks.map((p) => p.playerId).filter((id): id is string => !!id));

    // Frozen ADP snapshot for this draft (explicit link, else the latest one).
    const snapshotMeta = draft.adpSnapshotId
      ? await this.adp.get(draft.adpSnapshotId)
      : await this.adp.latest();
    if (!snapshotMeta) warnings.push('no ADP snapshot imported — market value and survival are unavailable');
    const adpValues = snapshotMeta ? await this.adp.valuesByPlayer(snapshotMeta.id) : new Map();

    const allPlayers = await this.players.listAll();
    const byId = new Map(allPlayers.map((p) => [p.id, p]));

    // My roster composition drives need.
    const myPickRecords = picks.filter((p) => p.rosterId != null && p.rosterId === myRosterRecord?.rosterId && p.playerId);
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

    // Candidate pool: ranked ADP players who are still available.
    const positionFilter = opts.position ? opts.position.toUpperCase() : null;
    const candidates: CanonicalPlayer[] = [];
    for (const [playerId, value] of adpValues) {
      if (takenIds.has(playerId)) continue;
      const player = byId.get(playerId);
      if (!player || !player.active) continue;
      if (positionFilter && player.position !== positionFilter) continue;
      void value;
      candidates.push(player);
    }
    // Without a snapshot, fall back to every active fantasy player so the board
    // is still usable (clearly flagged as degraded).
    if (candidates.length === 0 && !snapshotMeta) {
      for (const player of allPlayers) {
        if (!player.active || takenIds.has(player.id)) continue;
        if (positionFilter && player.position !== positionFilter) continue;
        candidates.push(player);
      }
    }

    const signals = await this.evidence.getSignals(candidates.map((c) => c.id));
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    const recommendations = rankAvailablePlayers(
      candidates.map((player) => ({
        player,
        adp: adpValues.get(player.id)?.adp ?? null,
        adpRank: adpValues.get(player.id)?.rank ?? null,
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
