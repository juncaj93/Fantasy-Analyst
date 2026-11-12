/**
 * The trade finder's offers in the shape today's Trades screen draws (Round
 * 19, step one: the logic goes live first, the new screens follow behind a
 * switch). Each found offer becomes an `OfferEvaluation` the existing row and
 * sheet already render, plus `pick`: the label ("Fair", "Good for you", or
 * "Close: you give a bit more than you get") and the exact edge, so a close
 * deal can never read as a fair one.
 *
 * Pure.
 */

import type { OfferEvaluation, OfferPlayer, FairnessBand } from './bilateral.ts';
import { FAIRNESS_LABELS } from './bilateral.ts';
import type { ActivityClass, ManagerFit } from './managerFit.ts';
import type { FinderResult, FoundOffer } from './finder.ts';
import type { SeasonCheck } from './seasonCheck.ts';
import { TRADEABLE, type TradeCapability } from './capability.ts';

/** What a board offer carries beyond the older shape. Optional on the wire. */
export interface OfferPick {
  kind: FoundOffer['kind'];
  label: string;
  verdict: FoundOffer['verdict'];
  edgePercent: number;
  thisWeek: number;
  restOfSeason: number;
  them: number;
  reason: string;
  tags: FoundOffer['tags'];
}

export type FinderBoardOffer = OfferEvaluation & { pick?: OfferPick };

const ACTIVITY_WORDS: Record<ActivityClass, string> = {
  active: 'Trades often',
  selective: 'Trades sometimes',
  unknown: 'Trade history still thin',
  low_activity: 'Trades seldom',
  effectively_inactive: 'Rarely trades',
};

function bandOf(edgePercent: number): FairnessBand {
  if (Math.abs(edgePercent) <= 10) return 'even';
  if (edgePercent < 0 && edgePercent >= -25) return 'edge_opponent';
  return 'outside_range';
}

function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0';
}

function playerOf(p: FoundOffer['give'][number]): OfferPlayer {
  return { playerId: p.playerId, name: p.name, position: p.position, value: p.value ?? 0, ...(p.value != null ? { seasonValue: p.value } : {}) };
}

export function boardOfferOf(
  offer: FoundOffer,
  partner: { userId: string | null; activity: ActivityClass; sample: number; historyComplete: boolean },
): FinderBoardOffer {
  const incoming = offer.get.reduce((s, p) => s + (p.value ?? 0), 0);
  const outgoing = offer.give.reduce((s, p) => s + (p.value ?? 0), 0);
  const band = bandOf(offer.edgePercent);
  const managerFit: ManagerFit = {
    userId: partner.userId,
    displayName: offer.partner.label,
    activity: partner.activity,
    label: ACTIVITY_WORDS[partner.activity],
    contribution: 0,
    terms: [],
    evidence: {
      sample: partner.sample,
      seasonsObserved: 0,
      historyComplete: partner.historyComplete,
      ratePerSeason: null,
      leagueRate: null,
      confidence: 0,
    },
    notes: offer.partner.activity ? [offer.partner.activity] : [],
    uncertain: partner.activity === 'unknown',
  };
  const seasonCheck: SeasonCheck = {
    status: 'ok',
    kind: offer.check.kind,
    headline: offer.check.headline,
    confidence: offer.check.confidence,
    reason: null,
    you: offer.you.restOfSeason,
    them: offer.them.restOfSeason,
    edge: offer.edgePercent / 100,
    unfair: offer.closeReason,
    drop: offer.drop,
  };
  const side = (gain: number, enters: FoundOffer['get']) => ({
    starterGain: gain,
    depthChange: 0,
    entersLineup: enters.filter((p) => p.starts > 0).map(playerOf),
    displaced: [],
    opensSlot: false,
    rationales: [],
  });
  return {
    id: offer.id,
    category: 'upgrade',
    arbitrage: [],
    partner: { key: String(offer.partner.rosterId), rosterId: offer.partner.rosterId, displayName: offer.partner.label, userId: partner.userId },
    give: offer.give.map(playerOf),
    get: offer.get.map(playerOf),
    fairness: {
      band,
      label: `${FAIRNESS_LABELS[band]} (edge ${offer.edgePercent > 0 ? '+' : ''}${offer.edgePercent}%)`,
      incoming: Math.round(incoming * 10) / 10,
      outgoing: Math.round(outgoing * 10) / 10,
      gap: offer.edgePercent / 100,
    },
    user: side(offer.you.restOfSeason, offer.get),
    counterparty: side(offer.them.restOfSeason, offer.give),
    managerFit,
    scarcity: [],
    score: offer.score,
    breakdown: { user: 0, fairness: 0, counterparty: 0, simplicity: 0, managerFit: 0, total: offer.score },
    reasons: [offer.reason],
    caveats: offer.drop ? [`You would cut ${offer.drop} to make room.`] : [],
    headline: `You ${signed(offer.you.restOfSeason)}, them ${signed(offer.them.restOfSeason)} over the season`,
    seasonCheck,
    pick: {
      kind: offer.kind,
      label: offer.opponent ? `${offer.label} · This week's opponent` : offer.label,
      verdict: offer.verdict,
      edgePercent: offer.edgePercent,
      thisWeek: offer.you.thisWeek,
      restOfSeason: offer.you.restOfSeason,
      them: offer.them.restOfSeason,
      reason: offer.reason,
      tags: offer.tags,
    },
  };
}

/** The board body `/api/trades/smart` answers, from one finder run. */
export function finderBoard(args: {
  league: { id: string; name: string } | null;
  capability: TradeCapability | null;
  result: FinderResult;
  partners: ReadonlyMap<number, { ownerId: string | null; activityClass: string; sample: number; earlier: number | null }>;
}) {
  const { result } = args;
  const offers = result.offers.map((o) => {
    const p = args.partners.get(o.partner.rosterId);
    return boardOfferOf(o, {
      userId: p?.ownerId ?? null,
      activity: (p?.activityClass as ActivityClass | undefined) ?? 'unknown',
      sample: p?.sample ?? 0,
      historyComplete: p?.earlier != null,
    });
  });
  return {
    league: args.league,
    found: offers.length > 0,
    offers,
    /** `fair`, `close` (the nearest, labelled), `none` or `closed`. */
    status: result.status,
    search: {
      partners: result.funnel.partners,
      generated: result.funnel.generated,
      scored: result.funnel.checked,
      viable: result.funnel.fair,
      surfaced: offers.length,
      bounds: {},
    },
    capability: args.capability ?? TRADEABLE,
    history: { measured: args.league != null, profiles: 0, seasonsComplete: [], complete: false, leagueRate: null },
    notes: result.note ? [result.note] : [],
    warnings: [],
    pricing: null,
  };
}
