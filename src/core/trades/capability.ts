/**
 * Can this league trade at all?
 *
 * A question that has to be asked before any of the bilateral machinery runs,
 * and one the engine had been quietly assuming the answer to. Smart Trades will
 * happily price two rosters against each other in a format where nobody can
 * accept the result — a best-ball league has populated rosters and no trading,
 * so "no offers because the rosters are empty" would be both wrong and, worse,
 * wrong for a reason that stops being true the moment a draft ends.
 *
 * The distinction that matters to a reader is *why* there is nothing here:
 *
 *   - **"your draft has not happened yet"** is a state that changes on its own;
 *   - **"this format does not have trading"** never changes.
 *
 * Reporting the first when the second is true is how a screen tells somebody to
 * come back after their draft for a feature their league will never have.
 *
 * ## Only what Sleeper publishes
 *
 * Every signal below is read from the league's own settings blob. Deliberately
 * not read: the league's *name* (a string somebody typed), anything the user
 * configured in this app (a setting they set once and forget next season), or
 * the calendar. That is the same rule `core/sleeper/bestBall.ts` states at
 * length and for the same reason — this is a fact about a league, and the only
 * place it lives is Sleeper.
 *
 * Pure. No database, no network.
 */

import { detectBestBall } from '../sleeper/bestBall.ts';

/** Why trading is unavailable, when it is. */
export type TradeBlockBasis = 'best_ball' | 'trades_disabled';

export interface TradeCapability {
  /** False when this league cannot trade at all. */
  tradeable: boolean;
  /** What decided it, or null when nothing blocks. */
  basis: TradeBlockBasis | null;
  /**
   * One sentence for the screen, or null when trading is available.
   *
   * Written to be final rather than provisional: a reader must be able to tell
   * this from "nothing to suggest yet" without knowing anything about the
   * engine behind it.
   */
  reason: string | null;
}

export const TRADEABLE: TradeCapability = { tradeable: true, basis: null, reason: null };

export interface TradeCapabilityInput {
  /** `league.settings` exactly as Sleeper published it. */
  leagueSettings?: Record<string, unknown> | null;
  /** `league.metadata`, for the leagues that carry the format flag there. */
  leagueMetadata?: Record<string, unknown> | null;
}

/**
 * Read whether this league supports trading.
 *
 * Two blocks, checked in the order of how permanent they are.
 *
 * **Best ball first.** It is the stronger statement: a best-ball league has no
 * weekly lineup decision at all — Sleeper scores the optimal lineup after the
 * fact — so it is not only that nobody can trade, it is that the entire
 * marginal-utility model underneath Smart Trades has nothing to measure. "Does
 * this player enter your lineup" has no answer in a format with no lineup.
 *
 * **Then Sleeper's own trade switch.** `disable_trades` is a commissioner
 * setting and is exactly what it says. A league that has turned trading off is
 * a normal league whose reader should be told the switch is off, not that their
 * roster is thin.
 *
 * Everything else is tradeable. Notably including a league whose trade deadline
 * has passed — see the known limitation in `docs/SMART_TRADES.md`; that needs a
 * clock this function deliberately does not take.
 */
export function tradeCapabilityOf(input: TradeCapabilityInput): TradeCapability {
  const format = detectBestBall({
    leagueSettings: input.leagueSettings ?? null,
    leagueMetadata: input.leagueMetadata ?? null,
  });

  /*
   * `confident` is checked, not just `bestBall`.
   *
   * `detectBestBall` returns `bestBall: false, confident: false` for a league
   * Sleeper has said nothing about, which is "not stated" rather than "not best
   * ball". That degraded case must fall through to tradeable: refusing to
   * suggest trades because a flag was absent would turn a missing field into a
   * disabled feature, and the overwhelmingly common league has no flag and does
   * trade.
   */
  if (format.confident && format.bestBall) {
    return {
      tradeable: false,
      basis: 'best_ball',
      reason: 'This is a best-ball league — there are no lineup decisions and no trading, so there is nothing to offer.',
    };
  }

  if (tradesDisabled(input.leagueSettings)) {
    return {
      tradeable: false,
      basis: 'trades_disabled',
      reason: 'Trading is switched off in this league’s Sleeper settings.',
    };
  }

  return TRADEABLE;
}

/**
 * Sleeper's `disable_trades`, read strictly.
 *
 * Only an unambiguous truthy value blocks. An absent key, a null, or anything
 * unrecognised means the setting was not stated — and an unstated setting is
 * not a disabled one. Same rule as the format flag above, for the same reason:
 * this feature must degrade toward working, never toward silence.
 */
function tradesDisabled(settings: Record<string, unknown> | null | undefined): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const raw = settings['disable_trades'];
  return raw === 1 || raw === true || raw === '1' || raw === 'true';
}
