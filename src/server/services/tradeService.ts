/**
 * Trade ideas for the selected league.
 *
 * Ownership comes from Sleeper's rosters, which is what separates a trade
 * target from a waiver add: if nobody holds a player, suggesting a trade for
 * them is just wrong. Everything else comes from the evidence ledger.
 */

import { groupByVerdict, rankTrades, type Ownership, type TradeSuggestion } from '../../core/trades/engine.ts';
import { partnerContext, type TradePartnerContext } from '../../core/managers/tradeTendencies.ts';
import { ManagerIntelService } from './managerIntelService.ts';
import type { Database } from '../db.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { draftPickLabel, draftProvenanceLine } from '../../core/draft/provenance.ts';
import { PlayerRepo } from '../repos/players.ts';
import { PlayerDetailRepo } from '../repos/playerDetail.ts';
import { InjuryService } from './injuryService.ts';
import { outlookSeason } from './playerDetailService.ts';

export interface TradeBoard {
  league: { id: string; name: string } | null;
  sections: { verdict: string; label: string; players: TradeSuggestion[] }[];
  /** Every suggestion, ranked, for callers that want their own grouping. */
  suggestions: TradeSuggestion[];
  /** Players with evidence but no trade angle, so the count is explicable. */
  considered: number;
  warnings: string[];
}

export class TradeService {
  private readonly leagues: LeagueRepo;
  private readonly players: PlayerRepo;
  private readonly evidence: EvidenceRepo;
  private readonly detail: PlayerDetailRepo;

  constructor(private readonly db: Database) {
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.detail = new PlayerDetailRepo(db);
  }

  async build(opts: { limit?: number } = {}): Promise<TradeBoard> {
    const warnings: string[] = [];
    const league = await this.leagues.getSelectedLeague();
    if (!league) {
      return {
        league: null,
        sections: [],
        suggestions: [],
        considered: 0,
        warnings: ['no league selected, so ownership is unknown and every player would look like a free agent'],
      };
    }

    const rosters = await this.leagues.listRosters(league.id);
    const mine = new Set(rosters.find((r) => r.isMine)?.playerIds ?? []);
    const owned = new Set(rosters.flatMap((r) => r.playerIds));
    if (mine.size === 0) warnings.push('your roster is empty or unidentified, so nothing can be flagged as a sell');

    // Only players the ledger has anything to say about are worth scoring. The
    // rest have no signal, and a trade list built from no signal is noise.
    const withEvidence = await this.evidence.playerIdsWithEvidence();
    const signals = await this.evidence.getSignals(withEvidence);
    const all = await this.players.listAll();
    const byId = new Map(all.map((p) => [p.id, p]));

    const shortlist = withEvidence
      .map((id) => {
        const player = byId.get(id);
        if (!player || !player.active) return null;
        const ownership: Ownership = mine.has(id) ? 'mine' : owned.has(id) ? 'other' : 'free';
        return { player, signal: signals.get(id) ?? null, ownership };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    /*
     * Availability, and the outlook that is the only place a major recovery is
     * ever named.
     *
     * Both are looked up once for the shortlist rather than per card. The
     * outlook is read from the cache only — a trade board must not turn into
     * sixty requests to a third party, and a player with no cached outlook
     * simply has no named history, which is the honest answer.
     */
    const [injuries, outlooks] = await Promise.all([
      new InjuryService(this.db)
        .statesFor(shortlist.map((c) => ({ playerId: c.player.id, status: c.player.status })))
        .catch(() => new Map()),
      this.detail.cachedOutlooks(shortlist.map((c) => c.player.id), outlookSeason()).catch(() => new Map<string, string>()),
    ]);

    const candidates = shortlist.map((c) => ({
      ...c,
      injury: injuries.get(c.player.id) ?? null,
      outlook: outlooks.get(c.player.id) ?? null,
    }));

    const ranked = rankTrades(candidates).slice(0, opts.limit ?? 60);

    /*
     * Where each player came from: `Drafted 1.02 by Joe`.
     *
     * Real context for a trade rather than decoration. What a manager spent on
     * a player is most of what they will want back for him, and the second
     * round pick they used in August is the fact a February offer is being
     * measured against.
     *
     * Read from Sleeper's own draft history for this league, once for the whole
     * board. A manager is named only when Sleeper names the seat — attributing
     * a pick to a person is the worst thing on this screen to get wrong, so an
     * unnamed seat produces a line about the pick alone.
     */
    const provenance = await this.draftProvenance(league);

    /*
     * Who holds him now, by name.
     *
     * `ownership` already says *whether* somebody else has him, which is enough
     * to sort a board into targets and adds. It is not enough to act on: a
     * trade is a conversation with a person, and "somebody in your league has
     * him" is not a person. The rosters this method already loaded carry the
     * seat's name, so this costs no request — it is a second read of a list
     * that is three lines above.
     *
     * Null wherever Sleeper has not named the seat, and for a free agent, and
     * for your own players. Attributing a player to the wrong manager is the
     * worst thing on this screen to get wrong, so an unnamed seat produces no
     * name rather than `Roster 4`.
     */
    const ownerByPlayer = new Map<string, string>();
    for (const roster of rosters) {
      if (roster.isMine || !roster.ownerName) continue;
      for (const playerId of roster.playerIds) ownerByPlayer.set(playerId, roster.ownerName);
    }

    /*
     * And what the league's own trade history says about talking to him.
     *
     * Four things and no more — a plausibility label, the shape his deals
     * usually take, one sentence built from counts, and a tiebreak weight
     * bounded to ±5%. There is deliberately no acceptance probability:
     * Sleeper publishes completed trades and not declined offers, so the
     * denominator of that fraction does not exist. See
     * `core/managers/tradeTendencies.ts`.
     *
     * A read of one table, and empty for a league nobody has backfilled — in
     * which case every suggestion keeps exactly the bilateral reasoning it had
     * before this existed.
     */
    const partners = await this.partnerContexts(league.id, rosters);

    const withProvenance = ranked.map((suggestion) => ({
      ...suggestion,
      draft: provenance.get(suggestion.playerId) ?? null,
      owner: ownerByPlayer.get(suggestion.playerId) ?? null,
      partner: suggestion.ownership === 'other' ? (partners.get(suggestion.playerId) ?? null) : null,
    }));

    return {
      league: { id: league.id, name: league.name },
      sections: groupByVerdict(withProvenance),
      suggestions: withProvenance,
      considered: candidates.length,
      warnings,
    };
  }

  /**
   * The trade-behaviour context for each player somebody else holds.
   *
   * Keyed by player id rather than by manager, because that is what a row on
   * this board is: the question being asked is "what would talking to whoever
   * holds *him* look like", and the position wanted is his own — which is the
   * only position-shaped claim the history can honestly answer, since "has been
   * selling running backs" matters when you want his running back and not
   * otherwise.
   */
  private async partnerContexts(
    leagueId: string,
    rosters: readonly { rosterId: number; ownerId: string | null; ownerName: string | null; isMine: boolean; playerIds: string[] }[],
  ): Promise<Map<string, TradePartnerContext>> {
    const out = new Map<string, TradePartnerContext>();
    const tendencies = await new ManagerIntelService(this.db)
      .tradePartners({ leagueId, rosters })
      .catch(() => new Map());
    if (tendencies.size === 0) return out;

    const me = rosters.find((r) => r.isMine)?.ownerId ?? null;
    const positions = new Map((await this.players.listAll()).map((p) => [p.id, p.position]));
    /*
     * Seasons observed, so "has never traded" can be told from "has not been
     * measured". A manager with no deals in four seasons is a rare trader; one
     * with no deals in his first is simply unknown, and the two must not print
     * the same label.
     */
    const seasonsByUser = new Map([...tendencies].map(([userId, t]) => [userId, t.seasons.length]));

    for (const roster of rosters) {
      if (roster.isMine || !roster.ownerId) continue;
      const tendency = tendencies.get(roster.ownerId) ?? null;
      for (const playerId of roster.playerIds) {
        out.set(
          playerId,
          partnerContext({
            tendencies: tendency,
            askingUserId: me,
            wantPosition: positions.get(playerId) ?? null,
            seasonsObserved: seasonsByUser.get(roster.ownerId) ?? 0,
          }),
        );
      }
    }
    return out;
  }

  /**
   * One line per drafted player, keyed by player id.
   *
   * Empty for a league with no draft attached, a draft nobody has picked in,
   * and every player acquired off waivers — all of which are ordinary, and all
   * of which correctly produce no line rather than a `0.00`.
   */
  private async draftProvenance(
    league: { id: string; draftId: string | null; totalRosters: number },
  ): Promise<Map<string, { pick: string; managerName: string | null; line: string }>> {
    const out = new Map<string, { pick: string; managerName: string | null; line: string }>();
    if (!league.draftId) return out;

    const draft = await this.leagues.getDraft(league.draftId);
    if (!draft) return out;

    const rosters = await this.leagues.listRosters(league.id);
    const nameOf = new Map(
      rosters.map((r) => [r.rosterId, (r.ownerName ?? '').trim() || null] as const),
    );
    const teams = draft.teams || league.totalRosters || 12;

    for (const pick of await this.leagues.listPicks(draft.id)) {
      if (!pick.playerId) continue;
      const label = draftPickLabel(pick.pickNo, teams);
      if (!label) continue;
      const managerName = pick.rosterId == null ? null : (nameOf.get(pick.rosterId) ?? null);
      out.set(pick.playerId, {
        pick: label,
        managerName,
        line:
          draftProvenanceLine({ pickNo: pick.pickNo, teams, managerName, season: draft.season }) ?? '',
      });
    }
    return out;
  }
}
