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
import { PlayerRepo } from '../repos/players.ts';

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

  constructor(db: Database) {
    this.leagues = new LeagueRepo(db);
    this.players = new PlayerRepo(db);
    this.evidence = new EvidenceRepo(db);
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

    const candidates = withEvidence
      .map((id) => {
        const player = byId.get(id);
        if (!player || !player.active) return null;
        const ownership: Ownership = mine.has(id) ? 'mine' : owned.has(id) ? 'other' : 'free';
        return { player, signal: signals.get(id) ?? null, ownership };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const ranked = rankTrades(candidates).slice(0, opts.limit ?? 60);
    return {
      league: { id: league.id, name: league.name },
      sections: groupByVerdict(ranked),
      suggestions: ranked,
      considered: candidates.length,
      warnings,
    };
  }
}
