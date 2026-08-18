/**
 * Trade ideas for the selected league.
 *
 * Ownership comes from Sleeper's rosters, which is what separates a trade
 * target from a waiver add: if nobody holds a player, suggesting a trade for
 * them is just wrong. Everything else comes from the evidence ledger.
 */

import { groupByVerdict, rankTrades, type Ownership, type TradeSuggestion } from '../../core/trades/engine.ts';
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
    const withProvenance = ranked.map((suggestion) => ({
      ...suggestion,
      draft: provenance.get(suggestion.playerId) ?? null,
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
