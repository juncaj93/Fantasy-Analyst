/**
 * The Trades screen's ideas, each put through Check a trade.
 *
 * The orchestration for `core/trades/seasonCheck.ts` (finding T3): one
 * `TradeValueService.checkIdeas` call for every surfaced idea, turned into the
 * small verdict the board carries. Kept out of `SmartTradeService` so that
 * service still imports no Sleeper client; the trade check never asks Sleeper
 * for anything (see `tests/tradeValue.service.test.ts`), so the Trades page
 * still makes zero Sleeper requests.
 *
 * Never throws. A season check that cannot run returns no checks, and the board
 * is shown exactly as the idea search produced it.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { OfferEvaluation } from '../../core/trades/bilateral.ts';
import { seasonCheckOf, type SeasonCheck } from '../../core/trades/seasonCheck.ts';
import type { StartSitInput } from '../../core/startsit/engine.ts';
import type { Database } from '../db.ts';
import { TradeValueService, type Prepared } from './tradeValueService.ts';

export async function seasonChecksFor(
  db: Database,
  sleeper: SleeperClient,
  leagueId: string | null | undefined,
  offers: readonly OfferEvaluation[],
  /** Inputs the board already read for every rostered player, so they are not read twice. */
  known?: readonly StartSitInput[],
  /**
   * The league already priced on the season, when the board was searched on
   * it (review T1): the checks then read nothing at all.
   */
  prepared?: Prepared | null,
): Promise<Map<string, SeasonCheck>> {
  if (!leagueId || offers.length === 0) return new Map();
  try {
    const service = new TradeValueService(db, sleeper);
    const ideas = offers.map((o) => ({
      id: o.id,
      partnerRosterId: o.partner.rosterId,
      give: o.give.map((p) => p.playerId),
      get: o.get.map((p) => p.playerId),
    }));
    const evaluations =
      prepared && prepared.league.id === leagueId
        ? service.checkPrepared(prepared, ideas)
        : await service.checkIdeas(leagueId, ideas, known);
    return new Map([...evaluations].map(([id, evaluation]) => [id, seasonCheckOf(evaluation)] as const));
  } catch (err) {
    console.error('season check for trade ideas failed', err);
    return new Map();
  }
}
