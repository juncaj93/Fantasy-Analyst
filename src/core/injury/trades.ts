/**
 * What an injury is worth in a *trade*, which is not what it is worth on Sunday.
 *
 * Start/Sit asks "can he play this week", and the answer is a hard gate.
 * A trade asks "is he worth what he costs for the rest of the season", and a
 * hamstring that keeps him out of one game barely touches that. Treating the
 * two the same is how a one-week Questionable turns into a sell recommendation,
 * which is the specific overreaction the brief rules out.
 *
 * So this classifies availability by *duration*, not by severity:
 *
 *   - **temporary** — Questionable, or Doubtful for one week. Little or no
 *     effect on his season, and occasionally a reason to buy rather than sell.
 *   - **multi-week** — Out, IR, PUP, suspended. A real cost to this season, and
 *     bounded, because a player on IR in October is still a player in December.
 *   - **major recovery** — a named structural injury with a long return, and
 *     only where a supported source actually names it. Never inferred from
 *     "missed time".
 *   - **healthy** — including a player who has recovered. History is context on
 *     his card, never a standing penalty; a player does not stay discounted
 *     forever because of something he came back from.
 */

import { isRuledOut, type InjuryState } from './model.ts';
import { majorInjuryHistory } from '../draft/injury.ts';

export type TradeInjuryCategory = 'healthy' | 'temporary' | 'multi_week' | 'major_recovery';

export interface TradeInjuryContext {
  category: TradeInjuryCategory;
  /**
   * A bounded adjustment to trade urgency, in the same units `urgencyOf`
   * produces. Negative reduces how loudly a player is suggested.
   */
  urgencyDelta: number;
  /** `Q · hamstring — appears short-term`, or null when there is nothing to say. */
  line: string | null;
  /** A sentence for the reasons list, when it is decision-relevant. */
  note: string | null;
}

/**
 * The size of the adjustment, and its ceiling.
 *
 * `urgencyOf` produces roughly 0–8 for a real signal, so half a point is a
 * nudge and a point and a half is a demotion without being a veto. Nothing here
 * can flip a verdict on its own — classification still comes from the evidence
 * ledger, and it should, because "he is hurt" is not a claim about whether he
 * is good.
 */
export const TRADE_INJURY = {
  temporary: -0.25,
  multiWeek: -1.5,
  majorRecovery: -1,
} as const;

export const NO_TRADE_INJURY: TradeInjuryContext = {
  category: 'healthy',
  urgencyDelta: 0,
  line: null,
  note: null,
};

/**
 * Classify a player's availability for trade purposes.
 *
 * `outlook` is the season-outlook text, the one supported place a major
 * recovery is ever named. Passing it is optional and its absence means "no
 * major recovery known", never "no major recovery" — the two are different and
 * only the first is claimed.
 */
export function tradeInjuryContext(
  state: InjuryState,
  opts: {
    outlook?: string | null;
    /**
     * Last season's counted note, e.g. `2025: missed 6 games with a hamstring
     * injury`. Context only -- it never moves urgency.
     */
    history?: string | null;
  } = {},
): TradeInjuryContext {
  /*
   * A named structural injury, from supported text.
   *
   * Checked first because it survives a clean current designation: a player
   * back from an Achilles is healthy today and still carries a season of
   * uncertainty, and that is the one piece of history worth a trade note.
   */
  const history = majorInjuryHistory(opts.outlook ?? null);

  if (isRuledOut(state.designation)) {
    const named = history ? ` (${history.injuries[0]})` : '';
    return {
      category: history ? 'major_recovery' : 'multi_week',
      urgencyDelta: history ? TRADE_INJURY.majorRecovery + TRADE_INJURY.multiWeek : TRADE_INJURY.multiWeek,
      line: `${describe(state)} — expect a multi-week absence${named}`,
      note: history
        ? `Out with ${history.injuries[0]} named in the season outlook — a long-term question, not a one-week one.`
        : 'Out for the near term, so the cost is this season rather than this week.',
    };
  }

  if (state.designation === 'questionable' || state.designation === 'doubtful') {
    return {
      category: 'temporary',
      urgencyDelta: TRADE_INJURY.temporary,
      line: `${describe(state)} — appears short-term`,
      // Deliberately quiet. A week-to-week designation is not a trade thesis,
      // and saying so on every card is how the signal gets ignored.
      note: null,
    };
  }

  if (history) {
    return {
      category: 'major_recovery',
      urgencyDelta: TRADE_INJURY.majorRecovery,
      line: `Healthy now · prior ${history.injuries[0]} noted in the season outlook`,
      note: `Returning from ${history.injuries[0]}, which the season outlook names — worth pricing, not worth avoiding.`,
    };
  }

  /*
   * Last season, on a player who is fine today.
   *
   * Context and nothing else: `urgencyDelta` is zero, deliberately and
   * permanently. A player who missed six games last October is not a sell
   * signal this August — he is a player with a history a trading partner may
   * also remember, and the app's job is to say so once, not to price it. The
   * branch above is different: a *named structural* injury from supported prose
   * is a claim about this season's availability, and it carries a number.
   */
  if (opts.history) {
    return {
      category: 'healthy',
      urgencyDelta: 0,
      line: `Healthy now · ${opts.history}`,
      note: null,
    };
  }

  return NO_TRADE_INJURY;
}

function describe(state: InjuryState): string {
  const code = { questionable: 'Q', doubtful: 'D', out: 'Out', ir: 'IR', pup: 'PUP', suspended: 'Suspended' }[
    state.designation as 'questionable' | 'doubtful' | 'out' | 'ir' | 'pup' | 'suspended'
  ];
  return state.bodyPart ? `${code} · ${state.bodyPart.toLowerCase()}` : (code ?? 'Designated');
}
