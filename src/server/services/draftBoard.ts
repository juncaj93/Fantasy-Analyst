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
import { offersFlexFilter, positionMatchesFilter } from '../../core/sleeper/eligibility.ts';
import { buildRosterShape, buildScoringProfile, leagueFitNotes, startablePositions } from '../../core/sleeper/scoring.ts';
import { buildLiveRoster } from '../../core/draft/liveRoster.ts';
import { demandBetweenPicks } from '../../core/draft/demandAhead.ts';
import { injuryStatusTag } from '../../core/draft/injury.ts';
import { injuryLine, type InjuryState } from '../../core/injury/model.ts';
import { InjuryService } from './injuryService.ts';
import { tierContextLine } from '../../core/draft/tierContext.ts';
import { RepairService } from './repairService.ts';
import { seasonFor } from './seasonMarketService.ts';
import { SeasonMarketsRepo } from '../repos/seasonMarkets.ts';
import { nextPickForSlot, slotForRoster, slotFromPicks, waitHorizonForSlot } from '../../core/sleeper/transform.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { PlayerFlagsRepo } from '../repos/playerFlags.ts';
import { PlayerRepo } from '../repos/players.ts';

/**
 * A ranked player plus whether the user bookmarked him.
 *
 * The queue is deliberately bolted on out here rather than passed into the
 * engine. It is a bookmark: it says where to look, not how good the player is,
 * and the ranking must come out identical whether or not the star is lit. The
 * engine cannot accidentally read what it is never given.
 */
export type BoardRecommendation = DraftRecommendation & {
  queued: boolean;
  /**
   * The injury designation worth showing — `Questionable`, `Out`, `IR` — or
   * null.
   *
   * Filtered here rather than in the card. The canonical `status` field falls
   * back to Sleeper's *roster* status when there is no injury, so it reads
   * `Active` for almost everybody and `DNR` for a long tail; sending that
   * meant every one of two hundred players arrived carrying a "status" the
   * board must then know to ignore. The rule for what counts lives in
   * `injury.ts`, so it is applied once and cannot drift between the wire and
   * the screen.
   */
  status: string | null;
  /**
   * One line of market context, or null when the board has nothing to say.
   *
   * Attached out here rather than produced by the engine, because half of it —
   * who picks before you do again and what they still need — is live draft
   * state the engine is deliberately never given. Nothing about the ranking
   * depends on it; it is read by the card and by nothing else.
   */
  tierContext: string | null;
  /**
   * One line about his availability: `Q · hamstring · practised fully`.
   *
   * Resolved from the same normalized state Start/Sit and Trades read, so a
   * player cannot be Questionable on one screen and fine on another. Null for
   * the overwhelming majority, which is what keeps the badge meaning something.
   */
  injuryLine: string | null;
};

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
  /**
   * The pick every "will he last" number on this board is measured against —
   * your next selection *after* the one on the clock.
   *
   * The same as `myNextPick` while you are waiting for your turn, and one pick
   * further on once it arrives. Sent so the board can name it rather than
   * leaving the reader to work out which pick "next pick" meant.
   */
  waitHorizonPick: number | null;
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  rosterCounts: Record<string, number>;
  myRoster: { playerId: string; name: string; position: string; team: string; pickNo: number }[];
  /** Starting slots with nobody to fill them yet. */
  openStarters: { slot: string; count: number; accepts: string[] }[];
  /**
   * Every starting slot the league has, filled out of required.
   *
   * The draft header states this and nothing else about the roster: `0/1 QB ·
   * 1/2 RB · 3/3 WR`. What to do about it is the ranked list's job.
   */
  rosterProgress: { slot: string; filled: number; required: number; accepts: string[] }[];
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  recommendations: BoardRecommendation[];
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
  /**
   * Whether the W/R/T flex view is worth a chip in this league.
   *
   * The same rule as every other chip: a filter that can only ever return
   * nothing is worse than no filter. A league that starts none of RB, WR or TE
   * has nothing for FLX to show.
   */
  offersFlex: boolean;
  /**
   * Where the player count stands at each stage that can lose one.
   *
   * A completeness report rather than a statistic. The board silently ending
   * near ADP 78 was possible because no stage said how many players it had
   * dropped; these numbers make the next such regression visible immediately,
   * in the response itself.
   */
  poolHealth: {
    /** Active, startable, not already drafted — before any cap. */
    activeEligible: number;
    drafted: number;
    /** How many of those were actually scored (bounded by `cap`). */
    scored: number;
    /** How many were sent, after the caller's own limit. */
    returned: number;
    withAdp: number;
    /** Kept rather than deleted — the whole point of the repair. */
    withoutAdp: number;
    deepestAdp: number | null;
    byPosition: Record<string, number>;
    cap: number;
  };
  warnings: string[];
}

/**
 * How many available players the board scores.
 *
 * Comfortably more than any draft reaches (a 12-team, 16-round draft is 192
 * picks), while keeping the request small enough to answer quickly.
 */
export const MAX_CANDIDATES = 300;

export class DraftBoardService {
  private readonly leagues: LeagueRepo;
  private readonly players: PlayerRepo;
  private readonly adp: AdpRepo;
  private readonly evidence: EvidenceRepo;
  private readonly seasonMarkets: SeasonMarketsRepo;

  constructor(private readonly db: Database) {
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.adp = new AdpRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.seasonMarkets = new SeasonMarketsRepo(db);
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
    /*
     * Two different questions about the same snake order.
     *
     * `next` is "when is my turn", which is what the header says: on the clock
     * it is this pick, and the screen reads YOUR PICK.
     *
     * `horizon` is "when could I next take him if I pass", which is what every
     * wait-flavoured number is measured against — survival, positional
     * scarcity, and how urgent a tier cliff is. Off the clock they are the same
     * pick. On the clock they are not, and using `next` there asked whether a
     * player available now would still be available now: true of everybody, so
     * the entire board read 100% at the one moment the number was being used to
     * decide something.
     */
    const next = mySlot == null ? null : nextPickForSlot(mySlot, teams, rounds, draft.type, currentPick);
    const horizon = mySlot == null ? null : waitHorizonForSlot(mySlot, teams, rounds, draft.type, currentPick);
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
      // `FLX` narrows to RB/WR/TE; every other value is the exact position it
      // names. One helper, shared with the player list and the compare picker.
      positionMatchesFilter(player.position, positionFilter) &&
      (!queuedOnly || allFlags.get(player.id)?.queued === true);

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

    /*
     * Everyone eligible, whether or not the market has priced him.
     *
     * This used to keep a player only if his position had no ranking at all or
     * he personally had an ADP — which sounds like tidiness and was in fact the
     * ceiling on the whole board. The published ADP file covers about two
     * hundred players; every other active quarterback, back, receiver and tight
     * end in the league was being deleted from the draft universe for the crime
     * of not appearing in it. That is precisely backwards: a player nobody has
     * ranked is a player you might get late, which is the one thing a draft
     * assistant is for in the eleventh round.
     *
     * Missing ADP is now unknown rather than disqualifying. It costs the player
     * nothing he has earned: `marketValueComponent` already returns `unknown`
     * with a zero contribution when ADP is null, scarcity is flagged the same
     * way, `Val` is null and the row is marked degraded — so an unpriced player
     * is ranked on what is actually known about him and shows `ADP —` rather
     * than a number the app made up.
     *
     * The sort below puts every priced player first, so nothing about the top
     * of the board moves; unranked players fill the tail in `search_rank` order,
     * and `MAX_CANDIDATES` still bounds how many are scored.
     */
    const pool: CanonicalPlayer[] = allPlayers.filter(eligible);
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
    /*
     * Capped silently, and deliberately so.
     *
     * This used to push a warning saying how many players were below the cut.
     * That was reasonable when the pool was two hundred priced players and the
     * cut meant something; now that every eligible player is a candidate it
     * reads "2,764 further down the order are not scored", which is a true
     * sentence about three hundred players nobody will draft, sitting at the
     * top of the screen during a draft. The counts belong in `poolHealth`,
     * where the probe reads them, not in the two lines above the board.
     */
    const candidates = pool.slice(0, MAX_CANDIDATES);
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

    const candidateIds = candidates.map((c) => c.id);
    const signals = await this.evidence.getSignals(candidateIds);
    // Season-long market lines, read from the newest stored snapshot. Nothing is
    // fetched here: the draft board must never wait on a provider, and the
    // refresh has its own slow clock.
    const seasonLines = await this.seasonMarkets.latestForPlayers(seasonFor(), candidateIds);
    // The user's own shortlist, already read above.
    const flags = allFlags;
    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const shape = buildRosterShape(league.rosterPositions);

    const ranked = rankAvailablePlayers(
      candidates.map((player) => ({
        player,
        adp: rankOf(player),
        adpRank: importedValues.get(player.id)?.rank ?? null,
        signal: signals.get(player.id) ?? null,
        myGuyLevel: flags.get(player.id)?.level ?? 0,
        seasonMarkets: seasonLines.get(player.id) ?? [],
      })),
      {
        currentPick,
        nextPick: horizon?.pickNo ?? null,
        shape,
        profile,
        rosterCounts,
        totalPicks: teams * rounds,
      },
    )
      .slice(0, opts.limit ?? 50);

    /*
     * How short the teams picking before your next turn are, per position.
     *
     * Computed once for the whole board from the pick stream, the actual snake
     * order and the league's own starting slots — never from ADP or from how
     * many are left. It is attached to the tier line below and read nowhere
     * else; no score, weight or ordering sees it.
     */
    const demand = demandBetweenPicks({
      picks,
      positionOf: (id) => byId.get(id)?.position ?? null,
      currentPick,
      horizonPick: horizon?.pickNo ?? null,
      mySlot,
      teams,
      type: draft.type,
      shape,
    });

    /*
     * Availability for the ranked page only.
     *
     * Forty rows, one query, and it never blocks the board: a failure of the
     * injury store costs the extra line and leaves Sleeper's own designation —
     * which is what the board showed before this existed — exactly in place.
     */
    const injuries = await new InjuryService(this.db)
      .statesFor(ranked.map((rec) => ({ playerId: rec.playerId, status: byId.get(rec.playerId)?.status ?? null })))
      .catch(() => new Map<string, InjuryState>());

    const recommendations = ranked.map((rec) => ({
      ...rec,
      queued: allFlags.get(rec.playerId)?.queued === true,
      status: designationOf(byId.get(rec.playerId)?.status ?? null),
      tierContext: tierContextLine(rec.position, rec.tierCliff, demand.get(rec.position) ?? null),
      injuryLine: injuryLineFor(injuries.get(rec.playerId)),
    }));

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
      waitHorizonPick: horizon?.pickNo ?? null,
      league: {
        id: league.id,
        name: league.name,
        scoringLabel: profile.label,
        notes: leagueFitNotes(profile, shape),
      },
      rosterCounts,
      myRoster,
      openStarters: live.openStarters,
      rosterProgress: live.progress,
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
      offersFlex: offersFlexFilter(startable),
      /*
       * The counts, so a truncated board can never look healthy again.
       *
       * This board once ended near ADP 78 and said nothing about it, because
       * every stage was individually reasonable and nothing reported what it
       * had thrown away. These are the numbers that would have made it obvious
       * in one glance, and they are computed from the same variables the board
       * was built from rather than recounted afterwards.
       */
      poolHealth: {
        activeEligible: pool.length,
        drafted: takenIds.size,
        scored: candidates.length,
        returned: recommendations.length,
        withAdp: recommendations.filter((r) => r.adp != null).length,
        withoutAdp: recommendations.filter((r) => r.adp == null).length,
        deepestAdp: recommendations.reduce<number | null>(
          (deepest, r) => (r.adp == null ? deepest : Math.max(deepest ?? r.adp, r.adp)),
          null,
        ),
        byPosition: recommendations.reduce<Record<string, number>>((counts, r) => {
          counts[r.position] = (counts[r.position] ?? 0) + 1;
          return counts;
        }, {}),
        cap: MAX_CANDIDATES,
      },
      warnings,
    };
  }
}

/**
 * The injury line, but only when it adds to the badge already on the row.
 *
 * A card that says `Q` and then says `Q` again underneath is noise. This
 * returns a line only when the report contributed something the designation
 * alone does not carry — the body part, or how the week's practice went.
 */
function injuryLineFor(state: InjuryState | undefined): string | null {
  if (!state) return null;
  if (!state.bodyPart && !state.practice.label) return null;
  return injuryLine(state);
}

/** The status only when it is a designation a drafter acts on. */
function designationOf(status: string | null): string | null {
  return injuryStatusTag(status) ? status : null;
}

/** Conventional reading order, with anything unexpected kept and put last. */
const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'DEF'];

function orderPositions(positions: Set<string>): string[] {
  const known = POSITION_ORDER.filter((p) => positions.has(p));
  const rest = [...positions].filter((p) => !POSITION_ORDER.includes(p)).sort();
  return [...known, ...rest];
}
