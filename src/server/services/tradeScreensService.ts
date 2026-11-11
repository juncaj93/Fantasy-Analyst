/**
 * What the new Trades screens read (Round 19, behind the `TRADES_SCREENS`
 * switch): the offers (optionally around one player, for Build a trade's one
 * question), the rosters for Check a trade's pickers, and Check a trade's one
 * line. Live, each reads what the older routes read. On the preview upload
 * (`PREVIEW = "trades"`), each answers from the made-up preview league with no
 * database read (`core/trades/previewLeague.ts`).
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import { evaluateTrade, type PlayerLine, type TradeSide } from '../../core/tradeValue/evaluate.ts';
import { findTrades } from '../../core/trades/finder.ts';
import type { ScreensOffers, ScreensTeams, ScreensVerdict } from '../../core/trades/screensWire.ts';
import { previewLeague, type PreviewWeek } from '../../core/trades/previewLeague.ts';
import { checkSummary } from '../../core/trades/verdict.ts';
import type { PlayerRate } from '../../core/tradeValue/rate.ts';
import type { Database } from '../db.ts';
import { LeagueRepo } from '../repos/league.ts';
import { TradeFinderService } from './tradeFinderService.ts';
import { TradeCheckError, TradeValueService } from './tradeValueService.ts';

const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const byPosition = <T extends { position: string; name: string }>(a: T, b: T) =>
  (POSITION_ORDER.indexOf(a.position) + 1 || 99) - (POSITION_ORDER.indexOf(b.position) + 1 || 99) || a.name.localeCompare(b.name);

const lineOf = (p: PlayerLine) => ({ playerId: p.playerId, name: p.name, position: p.position, value: p.rosValue, starts: p.startsWeeks });

export class TradeScreensService {
  constructor(
    private readonly db: Database,
    private readonly sleeper: SleeperClient,
    /** The preview week, when this Worker is the preview upload. Null on the live site. */
    private readonly preview: PreviewWeek | null,
  ) {}

  async offers(focus: { sell?: string | null; get?: string | null } | null): Promise<ScreensOffers> {
    if (this.preview) {
      const L = previewLeague(this.preview);
      const result = findTrades({ horizon: L.horizon, shape: L.shape, replacement: L.replacement, rates: L.rates, rosters: L.rosters, rosterLimit: L.rosterLimit, focus });
      return { league: L.league, status: result.status, note: result.note, offers: result.offers, deadline: { week: L.horizon.deadlineWeek, weeksLeft: L.horizon.weeksToDeadline } };
    }
    const run = await new TradeFinderService(this.db, this.sleeper).find(focus ? { focus } : {});
    return {
      league: run.league,
      status: run.result.status,
      note: run.result.note,
      offers: run.result.offers,
      deadline: run.prepared ? { week: run.prepared.horizon.deadlineWeek, weeksLeft: run.prepared.horizon.weeksToDeadline } : null,
    };
  }

  async teams(): Promise<ScreensTeams> {
    if (this.preview) {
      const L = previewLeague(this.preview);
      return {
        league: L.league,
        teams: L.rosters.map((r) => ({
          rosterId: r.rosterId,
          label: r.label,
          isMine: r.isMine,
          players: r.playerIds.map((id) => L.rates.get(id)!).map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team })).sort(byPosition),
        })),
      };
    }
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league) return { league: null, teams: [], reason: 'No league is selected.' };
    const read = await new TradeValueService(this.db, this.sleeper).teams(league.id);
    if (!read.found) return { league: { id: league.id, name: league.name }, teams: [], reason: read.reason ?? 'Nobody has a roster yet.' };
    return {
      league: read.league ?? { id: league.id, name: league.name },
      teams: (read.teams ?? []).map((t) => ({
        rosterId: t.rosterId,
        label: t.label,
        isMine: t.isMine,
        players: t.players.filter((p) => p.position !== 'DEF' && p.position !== 'K').map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team })),
      })),
    };
  }

  async verdict(request: { partner: number; give: string[]; get: string[] }): Promise<ScreensVerdict> {
    if (request.give.length + request.get.length === 0) return { found: false, reason: 'Pick at least one player.' };
    if (this.preview) {
      const L = previewLeague(this.preview);
      const mine = L.rosters.find((r) => r.isMine)!;
      const theirs = L.rosters.find((r) => r.rosterId === request.partner);
      if (!theirs) return { found: false, reason: 'That team is not in this league.' };
      const side = (r: typeof mine): TradeSide => ({ label: r.label, rosterId: r.rosterId, isMine: r.isMine, roster: r.playerIds.map((id) => L.rates.get(id)).filter((p): p is PlayerRate => p != null) });
      if (!request.give.every((id) => mine.playerIds.includes(id)) || !request.get.every((id) => theirs.playerIds.includes(id))) {
        return { found: false, reason: 'A player in this trade is not on that roster.' };
      }
      const evaluation = evaluateTrade({ horizon: L.horizon, shape: L.shape, replacement: L.replacement, a: side(mine), b: side(theirs), rosterLimit: L.rosterLimit, aSends: request.give, bSends: request.get });
      return this.shape(evaluation, { rosterId: theirs.rosterId, label: theirs.label });
    }
    const league = await new LeagueRepo(this.db).getSelectedLeague();
    if (!league) return { found: false, reason: 'No league is selected.' };
    const rosters = await new LeagueRepo(this.db).listRosters(league.id);
    const mine = rosters.find((r) => r.isMine);
    if (!mine) return { found: false, reason: 'Your roster is not identified in this league.' };
    try {
      const check = await new TradeValueService(this.db, this.sleeper).check(league.id, { a: mine.rosterId, b: request.partner, aSends: request.give, bSends: request.get });
      if (!check.evaluation || !check.sides) return { found: false, reason: check.reason ?? 'That trade could not be checked.' };
      return this.shape(check.evaluation, { rosterId: check.sides.b.rosterId, label: check.sides.b.label });
    } catch (err) {
      if (err instanceof TradeCheckError) return { found: false, reason: err.message };
      throw err;
    }
  }

  private shape(evaluation: ReturnType<typeof evaluateTrade>, partner: { rosterId: number; label: string }): ScreensVerdict {
    if (evaluation.status !== 'ok' || !evaluation.a) {
      return { found: true, partner, summary: null, insufficient: evaluation.insufficientReason, weeks: evaluation.weeks.count };
    }
    return {
      found: true,
      partner,
      summary: checkSummary(evaluation),
      give: evaluation.a.outgoing.map(lineOf),
      get: evaluation.a.incoming.map(lineOf),
      weeks: evaluation.weeks.count,
      drop: evaluation.a.mustDrop?.name ?? null,
      insufficient: null,
    };
  }
}
