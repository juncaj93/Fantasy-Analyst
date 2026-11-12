/**
 * The trade finder: the best few realistic offers for Alex. Round 19
 * (November 2026).
 *
 * ## Why it replaced the ideas search
 *
 * The Round 16 backtest replayed six weeks and no idea ever reached the
 * screen. The rule at the end (`fairToBoth.ts`) was not what stopped them:
 * offline, on the real league at week 10, about 35 deals pass it. The search
 * in front of it never looked at them. It took six of Alex's players and six
 * of theirs per team, kept twelve packages, and threw most of those out on
 * this week's numbers and roster-shape guesses before the season was ever
 * asked. This module asks the season about every realistic deal instead.
 *
 * ## How it works, in three steps
 *
 *  1. **Every small deal, screened cheaply.** 1 for 1, 2 for 1 and 1 for 2
 *     with every manager who trades. A deal survives the screen when nobody
 *     in it is worth nothing over a free agent, the value is near even, and
 *     each side's best lineup (the exact one, on each week of the season)
 *     gets better. No database, no optimiser over byes and depth yet.
 *  2. **The best of those, checked exactly.** Each goes through Check a
 *     trade's own evaluation (`evaluateTrade`), so the numbers on an offer are
 *     the numbers Check a trade prints for it. The verdict is `verdict.ts`.
 *  3. **Ranked by Alex's rules.** His lineup gain over the rest of the season
 *     (playoff weeks 1.5 times) leads, then this week, then whether it fills
 *     a weak spot, sells high or buys low, is a 2 for 1 or depth for a
 *     starter, and whether the manager trades often and needs his players.
 *     At most three, never two with the same player, at most two with one
 *     manager. When nothing is fully fair, the closest few, labelled.
 *
 * Pure. It suggests; it never sends, proposes or accepts anything.
 */

import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import {
  evaluateTrade,
  seasonValueOver,
  type ReplacementLevels,
  type TradeConfidence,
  type TradeEvaluation,
  type TradeSide,
  type VerdictKind,
} from '../tradeValue/evaluate.ts';
import type { PlayerRate } from '../tradeValue/rate.ts';
import type { TradeHorizon } from '../tradeValue/weeks.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import { seasonWeights } from '../value/restOfSeason.ts';
import { FAIR_TO_BOTH, gainBars, valueEdge, wholePercent, type UnfairReason } from './fairToBoth.ts';
import { CLOSE_LABELS, VERDICT_WORDS, verdictOfEvaluation, type TradeVerdict } from './verdict.ts';
import { isRareTrader, type ActivityClass } from './activity.ts';

export const FINDER = {
  /** Offers shown. */
  shown: 3,
  /** Offers to one manager among those shown. */
  perPartner: 2,
  /** Deals given the full season check, in all and per manager. Each is about a millisecond. */
  checked: 20,
  checkedPerPartner: 4,
  /** Deals screened per manager, before the season check. */
  screenedPerPartner: 300,
  /**
   * How far past Alex's fair band a deal may sit and still be screened, as a
   * share of the larger side. Wider than "close" so the exact check, not the
   * screen, decides.
   */
  screenEdge: { user: 0.3, partner: 0.5 },
  /** How far past the band a deal may sit and still be shown as close. */
  closeEdge: { user: 0.1, partner: 0.15 },
  /** A close deal still gains each side at least this share of its bar. */
  closeGainShare: 0.35,
  /** A close deal never helps them more than twice as much as it helps Alex. */
  closeTheirsOverYours: 2,
  /** Ranking, in rest-of-season lineup points. */
  rank: {
    weakSpot: 4,
    buySellTag: 3,
    shape: 2,
    partnerActive: 3,
    partnerSelective: 1.5,
    partnerTradedWithYou: 2,
    /** Per point of their gain, up to `theirGainCap`. */
    theirGain: 0.25,
    theirGainCap: 20,
    /** Per point of this week's change, which leans the order to helping now. */
    thisWeek: 1,
    /** Per player past two. */
    extraPlayer: 1.5,
  },
  /**
   * A buy-low or sell-high: games played this season at least this many, and
   * his season average this far from his projection (points a game, and share).
   */
  form: { minGames: 3, points: 2.5, share: 0.2 },
  /** A starting slot is a weak spot when its starter is within this many points a game of a free agent. */
  weakSpotMargin: 3,
} as const;

export interface FinderRoster {
  rosterId: number;
  label: string;
  isMine: boolean;
  playerIds: readonly string[];
  starterIds?: readonly string[];
  /** Trades on record: this season and earlier ones, for "trades often". */
  activity?: { class: ActivityClass; thisSeason: number; withYou: number; line: string } | null;
}

export interface FinderInput {
  horizon: TradeHorizon;
  shape: RosterShape;
  replacement: ReplacementLevels;
  rates: ReadonlyMap<string, PlayerRate>;
  rosters: readonly FinderRoster[];
  rosterLimit: number;
  /**
   * Build a trade's one question (Round 19): only deals that send this player
   * of Alex's (`sell`) or bring this player of another team's (`get`). A
   * manager Alex names this way is asked even if he seldom trades.
   */
  focus?: { sell?: string | null; get?: string | null } | null;
  /**
   * Alex's opponent this week, and whether their matchup is final (Alex,
   * Round 19 review). A deal with him that helps his lineup more than Alex's
   * this week is hidden until the matchup is final; any deal with him is
   * marked. Absent: nobody is marked or hidden.
   */
  opponent?: { rosterId: number; final: boolean } | null;
  /** Overrides, for tests. */
  bounds?: Partial<Pick<typeof FINDER, 'shown' | 'checked' | 'checkedPerPartner'>>;
}

export type OfferTag = 'fills_weak_spot' | 'buy_low' | 'sell_high' | 'consolidation' | 'depth_for_starter';

export interface FoundPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Rest-of-season value over a free agent. */
  value: number | null;
  /** Weeks he would start for his new team, of the weeks left. */
  starts: number;
}

export interface FoundOffer {
  id: string;
  partner: { rosterId: number; label: string; activity: string | null };
  give: FoundPlayer[];
  get: FoundPlayer[];
  /** `fair`: fair to both sides by Alex's rule. `close`: the nearest when none is. */
  kind: 'fair' | 'close';
  /** "Fair", "Good for you" or a close label. */
  label: string;
  verdict: TradeVerdict;
  /** The rule a close deal breaks. */
  closeReason: UnfairReason | null;
  /** Check a trade's own reading of the same deal, so the two screens print the same thing. */
  check: { kind: VerdictKind | null; headline: string | null; confidence: TradeConfidence };
  /** Alex's value edge, whole percent, positive his way. */
  edgePercent: number;
  you: { thisWeek: number; restOfSeason: number; playoffs: number };
  them: { thisWeek: number; restOfSeason: number };
  /** The partner is Alex's opponent this week (marked "This week's opponent"). */
  opponent?: boolean;
  /** Who gets better where: positions where each side's new player starts. */
  better: { you: string[]; them: string[] };
  /** The player Alex would cut to make room, when he receives more than he sends. */
  drop: string | null;
  tags: OfferTag[];
  /** One short reason. */
  reason: string;
  shape: '1 for 1' | '2 for 1' | '1 for 2';
  /** Weeks left in the season, the count `starts` is out of. */
  weeks?: number;
  /** The internal order. Never printed. */
  score: number;
}

export type FinderStep =
  | 'opponent_this_week'
  | 'rare_trader'
  | 'worthless_piece'
  | 'value_far_apart'
  | 'your_lineup_no_better'
  | 'their_lineup_no_better'
  | 'not_checked_bound'
  | 'insufficient'
  | 'bad_for_you'
  | 'not_fair'
  | 'fair';

export interface FinderResult {
  status: 'fair' | 'close' | 'none' | 'closed';
  offers: FoundOffer[];
  /** One plain line when there is nothing to show. */
  note: string | null;
  /** What each step kept and removed, for the probe. */
  funnel: {
    partners: number;
    skippedPartners: number;
    generated: number;
    removed: Partial<Record<FinderStep, number>>;
    unfair: Partial<Record<UnfairReason, number>>;
    checked: number;
    fair: number;
    close: number;
  };
  /** The checked deals, nearest to fair first, for the probe. */
  checkedDeals?: { id: string; you: number; them: number; edgePercent: number; verdict: TradeVerdict; unfair: UnfairReason | null }[];
}

interface Screened {
  partner: FinderRoster;
  /** Stable id: partner, what Alex sends, what he gets. */
  key: string;
  give: string[];
  get: string[];
  you: number;
  them: number;
  edge: number;
  order: number;
}

/**
 * Find the offers.
 */
export function findTrades(input: FinderInput): FinderResult {
  const bounds = { ...FINDER, ...input.bounds };
  const removed: Partial<Record<FinderStep, number>> = {};
  const unfair: Partial<Record<UnfairReason, number>> = {};
  const bump = (step: FinderStep, n = 1) => (removed[step] = (removed[step] ?? 0) + n);
  const funnel: FinderResult['funnel'] = { partners: 0, skippedPartners: 0, generated: 0, removed, unfair, checked: 0, fair: 0, close: 0 };
  const empty = (status: FinderResult['status'], note: string): FinderResult => ({ status, offers: [], note, funnel });

  const { horizon, shape, replacement, rates } = input;
  if (horizon.deadlinePassed) return empty('closed', 'Trades are closed for the season.');
  if (horizon.weeks.length === 0) return empty('closed', 'The fantasy season is over.');
  const mine = input.rosters.find((r) => r.isMine);
  if (!mine) return empty('none', 'Your roster is not identified in this league.');

  const weights = seasonWeights(horizon);
  const slots = slotsOf(shape);
  const solve = lineupSolver(slots);
  const tradeable = new Set<string>();
  for (const slot of slots) for (const p of slot.eligible) if (p !== 'DEF' && p !== 'K') tradeable.add(p);

  /* Each player's season value over a free agent, and whether he can be traded at all. */
  const value = new Map<string, number>();
  for (const roster of input.rosters) {
    for (const id of roster.playerIds) {
      const rate = rates.get(id);
      if (!rate || rate.rate == null || !tradeable.has(rate.position) || !replacement.has(rate.position)) continue;
      value.set(id, seasonValueOver(rate, replacement, weights) ?? 0);
    }
  }
  const pieces = (roster: FinderRoster) => roster.playerIds.filter((id) => value.has(id));

  /*
   * Each roster's best lineup, week by week, before any trade, kept as
   * sorted lists so a deal's lineup is a few small edits, not a new solve.
   */
  const fills = replacementFills(slots, replacement);
  const fast = fastLineups({ slots, fills, rates, weeks: horizon.weeks.length });
  const slowLineup = (ids: readonly string[]): number[] =>
    horizon.weeks.map((_, w) => solve([...weekValues(rates, ids, w), ...fills]));
  const baseOf = new Map(input.rosters.map((r) => [r.rosterId, fast ? fast.base(r.playerIds) : null] as const));
  const before = new Map(input.rosters.map((r) => [r.rosterId, fast ? fast.totals(baseOf.get(r.rosterId)!) : slowLineup(r.playerIds)] as const));
  const change = (roster: FinderRoster, out: readonly string[], inn: readonly string[]): number => {
    const after = fast
      ? fast.totals(baseOf.get(roster.rosterId)!, out, inn)
      : slowLineup([...roster.playerIds.filter((id) => !out.includes(id)), ...inn]);
    const was = before.get(roster.rosterId)!;
    let sum = 0;
    for (let w = 0; w < after.length; w++) sum += (weights[w] ?? 1) * (after[w]! - (was[w] ?? 0));
    return sum;
  };

  /* --------------------------------------------- 1. every deal, screened -- */
  const screened: Screened[] = [];
  const bars = gainBars(weights.reduce((a, b) => a + b, 0));
  const focus = input.focus ?? null;
  const opponent = input.opponent ?? null;
  for (const partner of input.rosters) {
    if (partner.isMine || partner.playerIds.length === 0) continue;
    if (focus?.get && !partner.playerIds.includes(focus.get)) continue;
    const named = focus?.get != null;
    if (!named && partner.activity && isRareTrader(partner.activity.class)) {
      funnel.skippedPartners += 1;
      bump('rare_trader');
      continue;
    }
    funnel.partners += 1;
    const mineAll = pieces(mine);
    const theirAll = pieces(partner);
    const count = (m: number, t: number) => m * t + ((m * (m - 1)) / 2) * t + m * ((t * (t - 1)) / 2);
    /* A piece worth nothing over a free agent is not part of a deal; it is a roster spot. */
    const mineIds = mineAll.filter((id) => (value.get(id) ?? 0) > 0);
    const theirIds = theirAll.filter((id) => (value.get(id) ?? 0) > 0);
    const generated = count(mineAll.length, theirAll.length);
    funnel.generated += generated;
    bump('worthless_piece', generated - count(mineIds.length, theirIds.length));

    /*
     * A lineup can only get better if somebody arriving would start in it in
     * some week. Exact, and cheap: each player is asked once per roster.
     */
    const startsForMe = new Set(fast ? theirIds.filter((id) => fast.wouldStart(baseOf.get(mine.rosterId)!, id)) : theirIds);
    const startsForThem = new Set(fast ? mineIds.filter((id) => fast.wouldStart(baseOf.get(partner.rosterId)!, id)) : mineIds);

    const here: Screened[] = [];
    const userMax = FAIR_TO_BOTH.userEdgeMax + bounds.screenEdge.user;
    const partnerMax = FAIR_TO_BOTH.partnerEdgeMax + bounds.screenEdge.partner;
    const consider = (give: string[], get: string[], giveValue: number, getValue: number) => {
      if (focus?.sell && !give.includes(focus.sell)) return;
      if (focus?.get && !get.includes(focus.get)) return;
      const edge = valueEdge(giveValue, getValue);
      if (edge > userMax || -edge > partnerMax) {
        bump('value_far_apart');
        return;
      }
      if (!get.some((id) => startsForMe.has(id))) {
        bump('your_lineup_no_better');
        return;
      }
      if (!give.some((id) => startsForThem.has(id))) {
        bump('their_lineup_no_better');
        return;
      }
      here.push({ partner, key: dealKey({ partner, give, get }), give, get, you: 0, them: 0, edge, order: 0 });
    };
    const v = (id: string) => value.get(id)!;
    for (const g of mineIds) for (const t of theirIds) consider([g], [t], v(g), v(t));
    for (let i = 0; i < mineIds.length; i++)
      for (let j = i + 1; j < mineIds.length; j++) {
        const pair = v(mineIds[i]!) + v(mineIds[j]!);
        for (const t of theirIds) consider([mineIds[i]!, mineIds[j]!], [t], pair, v(t));
      }
    for (const g of mineIds)
      for (let i = 0; i < theirIds.length; i++)
        for (let j = i + 1; j < theirIds.length; j++) consider([g], [theirIds[i]!, theirIds[j]!], v(g), v(theirIds[i]!) + v(theirIds[j]!));

    /*
     * The lineup screen on the deals nearest even first, so the bound (when it
     * bites) keeps the likeliest. Each side's exact best lineup, week by week,
     * on the season rates: the evaluation's lineup half, without depth.
     */
    here.sort((a, b) => Math.abs(a.edge) - Math.abs(b.edge) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cap = fast ? bounds.screenedPerPartner : Math.min(bounds.screenedPerPartner, 60);
    if (here.length > cap) {
      bump('not_checked_bound', here.length - cap);
      here.length = cap;
    }
    for (const deal of here) {
      deal.you = change(mine, deal.give, deal.get);
      if (!(deal.you > 0)) {
        bump('your_lineup_no_better');
        continue;
      }
      deal.them = change(partner, deal.get, deal.give);
      if (!(deal.them > 0)) {
        bump('their_lineup_no_better');
        continue;
      }
      deal.order = nearFair(deal, bars);
      screened.push(deal);
    }
  }

  /* ------------------------------------------ 2. the best, checked exactly -- */
  screened.sort((a, b) => a.order - b.order || b.you - a.you || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const toCheck: Screened[] = [];
  const perPartner = new Map<number, number>();
  for (const deal of screened) {
    if (toCheck.length >= bounds.checked) break;
    const n = perPartner.get(deal.partner.rosterId) ?? 0;
    if (n >= bounds.checkedPerPartner) continue;
    /* A 2 for 1 whose extra piece adds nothing to either side is the 1 for 1 with a roster spot attached. */
    if (toCheck.some((c) => c.partner === deal.partner && padded(c, deal))) continue;
    perPartner.set(deal.partner.rosterId, n + 1);
    toCheck.push(deal);
  }
  if (screened.length > toCheck.length) bump('not_checked_bound', screened.length - toCheck.length);

  const sideOf = (roster: FinderRoster): TradeSide => ({
    label: roster.label,
    rosterId: roster.rosterId,
    isMine: roster.isMine,
    roster: roster.playerIds.map((id) => rates.get(id)).filter((p): p is PlayerRate => p != null),
    starterIds: roster.starterIds ?? [],
  });
  const weak = weakSpots(mine, rates, replacement, slots, horizon.weeks.length);

  const fair: FoundOffer[] = [];
  const close: FoundOffer[] = [];
  const checkedDeals: NonNullable<FinderResult['checkedDeals']> = [];
  for (const deal of toCheck) {
    funnel.checked += 1;
    const evaluation = evaluateTrade({
      horizon,
      shape,
      replacement,
      a: sideOf(mine),
      b: sideOf(deal.partner),
      rosterLimit: input.rosterLimit,
      aSends: deal.give,
      bSends: deal.get,
    });
    const reading = verdictOfEvaluation(evaluation);
    if (!reading || !evaluation.a || !evaluation.b) {
      bump('insufficient');
      continue;
    }
    checkedDeals.push({ id: deal.key, you: evaluation.a.net, them: evaluation.b.net, edgePercent: reading.edgePercent, verdict: reading.verdict, unfair: reading.unfair });
    if (reading.verdict === 'bad') {
      bump('bad_for_you');
      continue;
    }
    const offer = offerOf({ deal, evaluation, reading, weak, rates, horizon });
    /*
     * This week's opponent (Alex, Round 19 review): marked, and while their
     * matchup is not final, hidden when it helps him more than Alex this week.
     */
    if (opponent && deal.partner.rosterId === opponent.rosterId) {
      offer.opponent = true;
      if (!opponent.final && offer.you.thisWeek < offer.them.thisWeek) {
        bump('opponent_this_week');
        continue;
      }
    }
    if (reading.fairToBoth) {
      bump('fair');
      fair.push(offer);
      continue;
    }
    bump('not_fair');
    unfair[reading.unfair!] = (unfair[reading.unfair!] ?? 0) + 1;
    if (isClose(reading, evaluation.a.net, evaluation.b.net, bounds)) close.push(offer);
  }
  funnel.fair = fair.length;
  funnel.close = close.length;
  checkedDeals.sort((a, b) => Number(b.unfair == null) - Number(a.unfair == null) || b.you - a.you);

  /*
   * ---------------------------------------------------- 3. ranked, at most 3 --
   * Fair offers first, best first. When fewer than three are fair, the rest
   * of the slots go to the closest, each labelled "Close: ..." with its edge
   * (Alex, Round 19 review). A close offer is never labelled fair.
   */
  const nearest = [...close].sort((a, b) => closeness(a, bars) - closeness(b, bars) || b.score - a.score || a.id.localeCompare(b.id));
  if (fair.length > 0) {
    const shown = pick(fair, bounds.shown);
    return { status: 'fair', offers: pick(nearest, bounds.shown, false, shown), note: null, funnel, checkedDeals };
  }
  if (close.length > 0) {
    return {
      status: 'close',
      offers: pick(nearest, bounds.shown, false),
      note: 'No trade is fully fair to both sides right now. These come closest.',
      funnel,
      checkedDeals,
    };
  }
  return {
    status: 'none',
    offers: [],
    note:
      funnel.partners === 0
        ? 'Nobody in this league trades often enough to suggest a deal.'
        : focus?.sell || focus?.get
          ? 'No trade with this player helps both lineups right now.'
          : 'No trade helps both lineups right now.',
    funnel,
    checkedDeals,
  };
}

/* -------------------------------------------------------------------------- */

/** The order deals are checked in: nearest to fair first, on the screen's numbers. */
function nearFair(deal: Pick<Screened, 'you' | 'them' | 'edge'>, bars: { user: number; partner: number }): number {
  const pct = wholePercent(deal.edge) / 100;
  const over = Math.max(0, pct - FAIR_TO_BOTH.userEdgeMax) + Math.max(0, -pct - FAIR_TO_BOTH.partnerEdgeMax);
  const short = Math.max(0, bars.user - deal.you) / bars.user + Math.max(0, bars.partner - deal.them) / bars.partner;
  /* Inside the rule on the screen: the bigger gain for Alex first. */
  return over * 10 + short - (over === 0 && short === 0 ? Math.min(deal.you, 60) / 1000 : 0);
}

function closeness(offer: FoundOffer, bars: { user: number; partner: number }): number {
  return nearFair({ you: offer.you.restOfSeason, them: offer.them.restOfSeason, edge: offer.edgePercent / 100 }, bars);
}

function isClose(
  reading: { edge: number; bars: { user: number; partner: number } },
  you: number,
  them: number,
  bounds: Pick<typeof FINDER, 'closeEdge' | 'closeGainShare' | 'closeTheirsOverYours'>,
): boolean {
  const pct = wholePercent(reading.edge) / 100;
  if (pct > FAIR_TO_BOTH.userEdgeMax + bounds.closeEdge.user) return false;
  if (-pct > FAIR_TO_BOTH.partnerEdgeMax + bounds.closeEdge.partner) return false;
  if (them > you * bounds.closeTheirsOverYours) return false;
  return you >= reading.bars.user * bounds.closeGainShare && them >= reading.bars.partner * bounds.closeGainShare;
}

/** True when `wider` is `narrower` with one more piece on a side. */
function padded(narrower: Screened, wider: Screened): boolean {
  const contains = (a: string[], b: string[]) => b.every((id) => a.includes(id));
  return (
    narrower.give.length + narrower.get.length < wider.give.length + wider.get.length &&
    contains(wider.give, narrower.give) &&
    contains(wider.get, narrower.get)
  );
}

function dealKey(d: Pick<Screened, 'give' | 'get'> & { partner: { rosterId: number } }): string {
  return `${d.partner.rosterId}:${[...d.give].sort().join('+')}>${[...d.get].sort().join('+')}`;
}

/**
 * Up to `n`, best first, never one player twice, at most two per manager.
 * `after`: offers already chosen, kept first; the list fills what is left.
 */
function pick(list: readonly FoundOffer[], n: number, sort = true, after: readonly FoundOffer[] = []): FoundOffer[] {
  const ordered = sort ? [...list].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) : [...list];
  const out: FoundOffer[] = [...after];
  const used = new Set<string>(after.flatMap((o) => [...o.give, ...o.get].map((p) => p.playerId)));
  const perPartner = new Map<number, number>();
  for (const o of after) perPartner.set(o.partner.rosterId, (perPartner.get(o.partner.rosterId) ?? 0) + 1);
  for (const offer of ordered) {
    if (out.length >= n) break;
    const ids = [...offer.give, ...offer.get].map((p) => p.playerId);
    if (ids.some((id) => used.has(id))) continue;
    const k = perPartner.get(offer.partner.rosterId) ?? 0;
    if (k >= FINDER.perPartner) continue;
    for (const id of ids) used.add(id);
    perPartner.set(offer.partner.rosterId, k + 1);
    out.push(offer);
  }
  return out;
}

/** Alex's starting slots where his starter is within a few points of a free agent: the positions a trade should fix. */
function weakSpots(
  mine: FinderRoster,
  rates: ReadonlyMap<string, PlayerRate>,
  replacement: ReplacementLevels,
  slots: readonly LineupSlotSpec[],
  weeks: number,
): Set<string> {
  const avg = (r: PlayerRate) => (r.rate ?? 0) * (r.weekly.length > 0 ? r.weekly.reduce((a, b) => a + b, 0) / r.weekly.length : 1);
  const candidates = mine.playerIds
    .map((id) => rates.get(id))
    .filter((r): r is PlayerRate => r != null && r.rate != null)
    .map((r) => ({ id: r.playerId, position: r.position, value: avg(r) }));
  const lineup = bestLineup(slots, candidates);
  const out = new Set<string>();
  lineup.picks.forEach((pick, i) => {
    const slot = slots[i]!;
    const positions = [...slot.eligible].filter((p) => p !== 'DEF' && p !== 'K');
    if (positions.length === 0) return;
    const level = pick ? (replacement.get(pick.position)?.rate ?? 0) : 0;
    if (!pick || pick.value - level < FINDER.weakSpotMargin) {
      /* A weak flex is a weak spot at whatever could fill it. */
      for (const p of pick && slot.eligible.size === 1 ? [pick.position] : positions) out.add(p);
    }
  });
  void weeks;
  return out;
}

/** Hot or cold against his own projection, from numbers already loaded. */
function formOf(rate: PlayerRate | undefined): 'hot' | 'cold' | null {
  const blend = rate?.blend;
  if (!blend || blend.projection == null || blend.production == null || blend.games < FINDER.form.minGames) return null;
  const gap = blend.production - blend.projection;
  const enough = Math.abs(gap) >= Math.max(FINDER.form.points, FINDER.form.share * blend.projection);
  if (!enough) return null;
  return gap > 0 ? 'hot' : 'cold';
}

function offerOf(args: {
  deal: Screened;
  evaluation: TradeEvaluation;
  reading: NonNullable<ReturnType<typeof verdictOfEvaluation>>;
  weak: ReadonlySet<string>;
  rates: ReadonlyMap<string, PlayerRate>;
  horizon: TradeHorizon;
}): FoundOffer {
  const { deal, evaluation, reading, weak, rates, horizon } = args;
  const a = evaluation.a!;
  const b = evaluation.b!;
  const weekly = (a.weekly ?? []).map((w) => w.lineupAfter + w.depthAfter - (w.lineupBefore + w.depthBefore));
  const theirWeek = b.weekly?.[0];
  const themWeek = theirWeek ? theirWeek.lineupAfter + theirWeek.depthAfter - (theirWeek.lineupBefore + theirWeek.depthBefore) : 0;
  const playoffWeeks = new Set(horizon.playoffWeeks);
  const thisWeek = round1(weekly[0] ?? 0);
  const playoffs = round1(weekly.reduce((s, d, i) => (playoffWeeks.has(horizon.weeks[i]!) ? s + d : s), 0));
  const player = (line: (typeof a.incoming)[number], starts: number): FoundPlayer => ({
    playerId: line.playerId,
    name: line.name,
    position: line.position,
    team: line.team,
    value: line.rosValue,
    starts,
  });
  const get = a.incoming.map((p) => player(p, p.startsWeeks));
  const give = a.outgoing.map((p) => player(p, b.incoming.find((q) => q.playerId === p.playerId)?.startsWeeks ?? 0));
  const half = Math.max(1, Math.ceil(horizon.weeks.length / 2));
  const youBetter = unique(get.filter((p) => p.starts >= half).map((p) => p.position));
  const themBetter = unique(give.filter((p) => p.starts >= half).map((p) => p.position));

  const tags: OfferTag[] = [];
  if (get.some((p) => p.starts >= half && weak.has(p.position))) tags.push('fills_weak_spot');
  if (deal.get.some((id) => formOf(rates.get(id)) === 'cold')) tags.push('buy_low');
  if (deal.give.some((id) => formOf(rates.get(id)) === 'hot')) tags.push('sell_high');
  if (deal.give.length === 2 && deal.get.length === 1) tags.push('consolidation');
  /* Nobody he sends starts for him much; somebody he gets does. */
  if (a.outgoing.every((o) => o.startsWeeks < half) && get.some((p) => p.starts >= half)) tags.push('depth_for_starter');

  const R = FINDER.rank;
  const activity = deal.partner.activity;
  const partnerScore =
    (activity?.class === 'active' ? R.partnerActive : activity?.class === 'selective' ? R.partnerSelective : 0) +
    ((activity?.withYou ?? 0) > 0 ? R.partnerTradedWithYou : 0);
  const score =
    a.net +
    R.thisWeek * thisWeek +
    (tags.includes('fills_weak_spot') ? R.weakSpot : 0) +
    (tags.includes('buy_low') || tags.includes('sell_high') ? R.buySellTag : 0) +
    (tags.includes('consolidation') || tags.includes('depth_for_starter') ? R.shape : 0) +
    partnerScore +
    R.theirGain * Math.min(Math.max(0, b.net), R.theirGainCap) -
    R.extraPlayer * Math.max(0, deal.give.length + deal.get.length - 2);

  const kind: FoundOffer['kind'] = reading.fairToBoth ? 'fair' : 'close';
  const label = kind === 'fair' ? VERDICT_WORDS[reading.verdict === 'bad' ? 'fair' : reading.verdict] : CLOSE_LABELS[reading.unfair!];
  return {
    id: deal.key,
    partner: { rosterId: deal.partner.rosterId, label: deal.partner.label, activity: activity?.line ?? null },
    give,
    get,
    kind,
    label,
    verdict: reading.verdict,
    closeReason: kind === 'close' ? reading.unfair : null,
    check: { kind: evaluation.verdict?.kind ?? null, headline: evaluation.verdict?.headline ?? null, confidence: evaluation.confidence },
    edgePercent: reading.edgePercent,
    you: { thisWeek, restOfSeason: round1(a.net), playoffs },
    them: { thisWeek: round1(themWeek), restOfSeason: round1(b.net) },
    better: { you: youBetter, them: themBetter },
    drop: a.mustDrop?.name ?? null,
    tags,
    reason: reasonOf({ tags, get, give, youBetter, partner: deal.partner.label, them: b.net, rates }),
    shape: deal.give.length === 2 ? '2 for 1' : deal.get.length === 2 ? '1 for 2' : '1 for 1',
    weeks: horizon.weeks.length,
    score: Math.round(score * 100) / 100,
  };
}

function reasonOf(args: {
  tags: readonly OfferTag[];
  get: readonly FoundPlayer[];
  give: readonly FoundPlayer[];
  youBetter: readonly string[];
  partner: string;
  them: number;
  rates: ReadonlyMap<string, PlayerRate>;
}): string {
  const { tags, get, give } = args;
  const lead = [...get].sort((x, y) => y.starts - x.starts)[0];
  if (tags.includes('fills_weak_spot') && lead) return `Fills your weak ${lead.position} spot with ${lead.name}.`;
  if (tags.includes('buy_low')) {
    const cold = get.find((p) => formOf(args.rates.get(p.playerId)) === 'cold');
    if (cold) return `Buy low: ${cold.name} is scoring under his projection.`;
  }
  if (tags.includes('sell_high')) {
    const hot = give.find((p) => formOf(args.rates.get(p.playerId)) === 'hot');
    if (hot) return `Sell high: ${hot.name} is scoring over his projection.`;
  }
  if (tags.includes('consolidation') && lead) return `Two of yours for one better starter, ${lead.name}.`;
  if (tags.includes('depth_for_starter') && lead) return `Bench depth for a starter, ${lead.name}.`;
  if (lead && args.youBetter.length > 0) return `${lead.name} starts for you at ${lead.position}.`;
  return `Both lineups get better.`;
}

/* ------------------------------------------------------ the lineup solver -- */

function weekValues(rates: ReadonlyMap<string, PlayerRate>, ids: readonly string[], w: number): LineupCandidate[] {
  const out: LineupCandidate[] = [];
  for (const id of ids) {
    const r = rates.get(id);
    if (!r || r.rate == null) continue;
    out.push({ id, position: r.position, value: r.rate * (r.weekly[w] ?? 1) });
  }
  return out;
}

/** One roster's week: each position's values, best first, and what it takes to start. */
interface WeekBase {
  positions: string[];
  lists: Map<string, number[]>;
  /** The sum every position's own slots take. */
  fixedTotal: number;
  /** Per position: the sum its own slots take, and the best few left for the flex. */
  fixedSum: Map<string, number>;
  left: Map<string, number[]>;
  /** Per position: the value a newcomer has to beat to start this week. */
  entry: Map<string, number>;
}

/**
 * Every week's best lineup total for a roster, and for the same roster with a
 * few players out and in, without solving from scratch: per position the
 * values are kept sorted, a deal edits the positions it touches, and the
 * flex slots take the best left over. Exact for the shapes `lineupSolver`
 * solves greedily (every flex slot takes the same positions); null otherwise.
 */
export function fastLineups(args: {
  slots: readonly LineupSlotSpec[];
  fills: readonly LineupCandidate[];
  rates: ReadonlyMap<string, PlayerRate>;
  weeks: number;
}): {
  base: (ids: readonly string[]) => WeekBase[];
  totals: (base: readonly WeekBase[], out?: readonly string[], inn?: readonly string[]) => number[];
  /** Whether this player would start for this roster in any week. */
  wouldStart: (base: readonly WeekBase[], id: string) => boolean;
} | null {
  const { slots, fills, rates, weeks } = args;
  const flexSlots = slots.filter((s) => s.eligible.size > 1);
  const flexKey = flexSlots.length > 0 ? [...flexSlots[0]!.eligible].sort().join('/') : '';
  if (!flexSlots.every((s) => [...s.eligible].sort().join('/') === flexKey)) return null;
  const fixed = new Map<string, number>();
  for (const s of slots) if (s.eligible.size === 1) {
    const p = [...s.eligible][0]!;
    fixed.set(p, (fixed.get(p) ?? 0) + 1);
  }
  const flexEligible = flexSlots[0]?.eligible ?? new Set<string>();
  const flexCount = flexSlots.length;
  const desc = (x: number, y: number) => y - x;

  /* Each player's value in each week, read once. */
  const cache = new Map<string, { position: string; values: number[] } | null>();
  const valuesOf = (id: string) => {
    let hit = cache.get(id);
    if (hit === undefined) {
      const r = rates.get(id);
      hit = !r || r.rate == null ? null : { position: r.position, values: Array.from({ length: weeks }, (_, w) => Math.max(0, r.rate! * (r.weekly[w] ?? 1))) };
      cache.set(id, hit);
    }
    return hit;
  };

  const base = (ids: readonly string[]): WeekBase[] =>
    Array.from({ length: weeks }, (_, w) => {
      const lists = new Map<string, number[]>();
      const add = (position: string, v: number) => {
        const list = lists.get(position);
        if (list) list.push(v);
        else lists.set(position, [v]);
      };
      for (const f of fills) add(f.position, Math.max(0, f.value));
      for (const id of ids) {
        const pv = valuesOf(id);
        if (pv) add(pv.position, pv.values[w]!);
      }
      const fixedSum = new Map<string, number>();
      const left = new Map<string, number[]>();
      const pool: number[] = [];
      let fixedTotal = 0;
      for (const [position, list] of lists) {
        list.sort(desc);
        const n = fixed.get(position) ?? 0;
        let sum = 0;
        for (let i = 0; i < Math.min(n, list.length); i++) sum += list[i]!;
        const rest = flexEligible.has(position) ? list.slice(n, n + flexCount) : [];
        fixedSum.set(position, sum);
        fixedTotal += sum;
        left.set(position, rest);
        pool.push(...rest);
      }
      pool.sort(desc);
      const flexWeakest = flexCount > 0 ? (pool[flexCount - 1] ?? 0) : Number.POSITIVE_INFINITY;
      const entry = new Map<string, number>();
      for (const [position, list] of lists) {
        const n = fixed.get(position) ?? 0;
        const own = n > 0 ? (list[n - 1] ?? 0) : Number.POSITIVE_INFINITY;
        entry.set(position, Math.min(own, flexEligible.has(position) ? flexWeakest : Number.POSITIVE_INFINITY));
      }
      return { positions: [...lists.keys()], lists, fixedTotal, fixedSum, left, entry };
    });

  /* The best `flexCount` values offered to the flex, kept without sorting. */
  const best = new Array<number>(flexCount).fill(0);
  let bestSize = 0;
  const offer = (v: number) => {
    if (bestSize < flexCount) {
      let i = bestSize++;
      while (i > 0 && best[i - 1]! < v) {
        best[i] = best[i - 1]!;
        i--;
      }
      best[i] = v;
    } else if (flexCount > 0 && v > best[flexCount - 1]!) {
      let i = flexCount - 1;
      while (i > 0 && best[i - 1]! < v) {
        best[i] = best[i - 1]!;
        i--;
      }
      best[i] = v;
    }
  };
  const totals = (weeksBase: readonly WeekBase[], out: readonly string[] = [], inn: readonly string[] = []): number[] => {
    const outs = out.map(valuesOf).filter((x): x is NonNullable<typeof x> => x != null);
    const ins = inn.map(valuesOf).filter((x): x is NonNullable<typeof x> => x != null);
    const touched: string[] = [];
    for (const x of [...outs, ...ins]) if (!touched.includes(x.position)) touched.push(x.position);
    const result = new Array<number>(weeksBase.length);
    for (let w = 0; w < weeksBase.length; w++) {
      const week = weeksBase[w]!;
      let total = week.fixedTotal;
      bestSize = 0;
      for (const position of week.positions) {
        if (touched.includes(position)) continue;
        const rest = week.left.get(position)!;
        for (let i = 0; i < rest.length; i++) offer(rest[i]!);
      }
      for (const position of touched) {
        const list = (week.lists.get(position) ?? []).slice();
        for (const o of outs) {
          if (o.position !== position) continue;
          const at = list.indexOf(o.values[w]!);
          if (at >= 0) list.splice(at, 1);
        }
        for (const x of ins) {
          if (x.position !== position) continue;
          const v = x.values[w]!;
          let i = list.length;
          list.push(v);
          while (i > 0 && list[i - 1]! < v) {
            list[i] = list[i - 1]!;
            i--;
          }
          list[i] = v;
        }
        const n = fixed.get(position) ?? 0;
        let sum = 0;
        for (let i = 0; i < Math.min(n, list.length); i++) sum += list[i]!;
        total += sum - (week.fixedSum.get(position) ?? 0);
        if (flexEligible.has(position)) for (let i = n; i < Math.min(list.length, n + flexCount); i++) offer(list[i]!);
      }
      for (let i = 0; i < bestSize; i++) total += best[i]!;
      result[w] = total;
    }
    return result;
  };
  const wouldStart = (weeksBase: readonly WeekBase[], id: string): boolean => {
    const pv = valuesOf(id);
    if (!pv) return false;
    return weeksBase.some((week, w) => pv.values[w]! > (week.entry.get(pv.position) ?? Number.POSITIVE_INFINITY));
  };
  return { base, totals, wouldStart };
}


/** Replacement-level free agents, as many as the lineup could call on at each position (as `evaluate.ts` does). */
function replacementFills(slots: readonly LineupSlotSpec[], replacement: ReplacementLevels): LineupCandidate[] {
  const fills: LineupCandidate[] = [];
  for (const [position, level] of replacement) {
    const count = slots.filter((s) => s.eligible.has(position)).length;
    for (let i = 0; i < count; i++) fills.push({ id: `replacement:${position}:${i}`, position, value: level.rate });
  }
  return fills;
}

/**
 * The best lineup's total. Exact and fast when every multi-position slot
 * takes the same positions (this league: two RB/WR/TE flex slots): each
 * position's own slots take its best, then the flex slots the best left. Any
 * other shape uses the exact assignment in `lineup.ts`.
 */
export function lineupSolver(slots: readonly LineupSlotSpec[]): (candidates: readonly LineupCandidate[]) => number {
  const fixed = new Map<string, number>();
  const flexSlots = slots.filter((s) => s.eligible.size > 1);
  for (const s of slots) if (s.eligible.size === 1) {
    const p = [...s.eligible][0]!;
    fixed.set(p, (fixed.get(p) ?? 0) + 1);
  }
  const flexKey = flexSlots.length > 0 ? [...flexSlots[0]!.eligible].sort().join('/') : '';
  const nested = flexSlots.every((s) => [...s.eligible].sort().join('/') === flexKey);
  if (!nested) return (candidates) => bestLineup(slots, candidates).total;
  const flexEligible = flexSlots[0]?.eligible ?? new Set<string>();
  const flexCount = flexSlots.length;
  return (candidates) => {
    const byPosition = new Map<string, number[]>();
    for (const c of candidates) {
      const list = byPosition.get(c.position);
      const v = Math.max(0, c.value);
      if (list) list.push(v);
      else byPosition.set(c.position, [v]);
    }
    let total = 0;
    const left: number[] = [];
    for (const [position, list] of byPosition) {
      list.sort((x, y) => y - x);
      const n = fixed.get(position) ?? 0;
      for (let i = 0; i < Math.min(n, list.length); i++) total += list[i]!;
      if (flexEligible.has(position)) for (let i = n; i < list.length; i++) left.push(list[i]!);
    }
    left.sort((x, y) => y - x);
    for (let i = 0; i < Math.min(flexCount, left.length); i++) total += left[i]!;
    return total;
  };
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}
