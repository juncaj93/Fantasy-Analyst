/**
 * Bilateral trade fit: deals where both teams have a reason to say yes.
 *
 * The existing trade engine answers "whose news is moving". That is a discovery
 * tool and it has no idea who owns anybody or what they need. This answers the
 * next question, which is the one that actually gets a trade accepted: what
 * does *this* manager need, what have I got spare, and is the deal something a
 * person would plausibly agree to.
 *
 * Three scores, kept apart on purpose:
 *
 * - **value to user** — what the deal does for my starting lineup.
 * - **value to partner** — the same arithmetic run from their side of the
 *   table, using their roster and their holes, not mine.
 * - **plausibility** — whether this manager, specifically, does deals like
 *   this. A trade can be fair and still be one nobody would ever accept.
 *
 * Collapsing them into "trade grade: B+" is exactly the thing that makes trade
 * tools useless, because the reader cannot tell a deal that helps them a lot
 * and helps the partner slightly from one that is even and pointless.
 *
 * Advisory only. Nothing here contacts a manager or files a trade.
 */

import type { RoleTrend } from '../startsit/decisions.ts';
import type { NeedLevel } from './competition.ts';
import type { ManagerProfile } from './managers.ts';

/** Timing labels, exactly as the brief specifies them. These are the interface. */
export type TradeTimingLabel =
  | 'Buy before usage converts to points'
  | 'Sell before schedule turns'
  | 'Sell before injured starter returns'
  | 'Buy after temporary box-score dip'
  | 'Avoid buying TD-driven spike';

export interface TradeTiming {
  label: TradeTimingLabel;
  reason: string;
}

/**
 * The opportunity and efficiency signals the timing calls rest on.
 *
 * Every field is optional and every rule requires the fields it actually reads,
 * so a player with no expected-points model produces no timing call rather than
 * a timing call built on a default.
 */
export interface TimingSignal {
  /** Expected fantasy points per game from opportunity alone. */
  xfpPerGame?: number | null;
  /** What he has actually scored per game. */
  fpPerGame?: number | null;
  /** Share of his points that came from touchdowns, 0–1. */
  tdShare?: number | null;
  /** Where the next four weeks sit against the ones just played. */
  scheduleTurn?: 'easing' | 'flat' | 'hardening' | null;
  /** Weeks until the starter he is covering for returns. */
  starterReturnsInWeeks?: number | null;
  roleTrend?: RoleTrend;
}

/** Points of expected-vs-actual gap that count as a real divergence. */
export const USAGE_GAP = 2.5;

/** Share of points from touchdowns above which a spike is being sold. */
export const TD_SPIKE_SHARE = 0.55;

/**
 * The timing calls this player supports.
 *
 * More than one can be true at once and all of them are returned: a receiver
 * can be both under-converting his usage *and* riding a touchdown rate, and a
 * reader who is shown only the flattering half is being sold something.
 */
export function tradeTimingFor(signal: TimingSignal, side: 'mine' | 'theirs'): TradeTiming[] {
  const out: TradeTiming[] = [];
  const { xfpPerGame: xfp, fpPerGame: fp } = signal;

  if (xfp != null && fp != null && xfp - fp >= USAGE_GAP) {
    if (signal.roleTrend === 'rising_high' || signal.roleTrend === 'rising_moderate') {
      out.push({
        label: 'Buy before usage converts to points',
        reason: `${xfp.toFixed(1)} expected vs ${fp.toFixed(1)} actual per game, on a growing role`,
      });
    } else {
      out.push({
        label: 'Buy after temporary box-score dip',
        reason: `the opportunity is intact (${xfp.toFixed(1)} expected) and the box score is not (${fp.toFixed(1)})`,
      });
    }
  }

  if (signal.tdShare != null && signal.tdShare >= TD_SPIKE_SHARE) {
    out.push({
      label: 'Avoid buying TD-driven spike',
      reason: `${Math.round(signal.tdShare * 100)}% of his points are touchdowns, which is the least repeatable part`,
    });
  }

  if (side === 'mine' && signal.scheduleTurn === 'hardening') {
    out.push({
      label: 'Sell before schedule turns',
      reason: 'the next four weeks are harder than the ones just played',
    });
  }

  if (signal.starterReturnsInWeeks != null && signal.starterReturnsInWeeks <= 3) {
    out.push({
      label: 'Sell before injured starter returns',
      reason: `the man he replaced is due back in about ${signal.starterReturnsInWeeks} week(s)`,
    });
  }

  return out;
}

export interface TradeAsset {
  playerId: string;
  name: string;
  position: string;
  /**
   * What he is worth to the team that holds him, in the same units on both
   * sides — the weekly engine's points, or a rest-of-season equivalent. The
   * caller owns this number; this file never invents one.
   */
  value: number;
  /** True when the holder can start somebody else at the position anyway. */
  surplus: boolean;
  byeWeek?: number | null;
  timing?: TimingSignal;
}

export interface TradeTeam {
  rosterId: number;
  userId: string | null;
  displayName: string;
  assets: TradeAsset[];
  /** Position → how badly they need one. */
  needs: Record<string, NeedLevel>;
  profile?: ManagerProfile;
}

export interface TradeIdea {
  partner: { rosterId: number; displayName: string };
  give: TradeAsset[];
  get: TradeAsset[];
  /** Net points of lineup improvement, need-weighted, for each side. */
  valueToUser: number;
  valueToPartner: number;
  /** 0–1. How likely this manager is to entertain it at all. */
  plausibility: number;
  plausibilityNotes: string[];
  timing: TradeTiming[];
  reasons: string[];
  counterpoints: string[];
}

/** How much a need multiplies the value of an incoming player. */
const NEED_MULTIPLIER: Record<NeedLevel, number> = { urgent: 1.35, thin: 1.15, covered: 1 };

/** How much of his value a team keeps when giving away surplus. */
const SURPLUS_DISCOUNT = 0.7;

/**
 * What this side gains, in its own terms.
 *
 * Incoming players are worth more when they fill a hole and outgoing players
 * cost less when they were the fourth of something — which is the entire reason
 * a trade can be positive for both teams at once, and why a raw value
 * subtraction can only ever produce zero-sum deals nobody makes.
 */
export function sideValue(team: TradeTeam, incoming: TradeAsset[], outgoing: TradeAsset[]): number {
  const gained = incoming.reduce((a, p) => a + p.value * NEED_MULTIPLIER[team.needs[p.position] ?? 'covered'], 0);
  const lost = outgoing.reduce((a, p) => a + p.value * (p.surplus ? SURPLUS_DISCOUNT : 1), 0);
  return round2(gained - lost);
}

/**
 * Would this manager entertain it?
 *
 * Built only from what the record shows. A manager who has never completed a
 * trade is not assumed hostile — that is an inference about a person from an
 * absence — but the deal is marked as untested, which is the honest version of
 * the same caution. Everything here is a small multiplier on a base of 0.5, so
 * plausibility can never be the reason a good deal is hidden.
 */
export function plausibilityOf(idea: {
  partner: TradeTeam;
  give: TradeAsset[];
  get: TradeAsset[];
  valueToPartner: number;
}): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0.5;

  if (idea.valueToPartner <= 0) {
    notes.push('the deal does not improve their lineup, so they have no reason to accept');
    return { score: 0.05, notes };
  }

  const profile = idea.partner.profile;
  if (profile?.tradesPerSeason.sufficient && (profile.tradesPerSeason.value ?? 0) >= 1.5) {
    score += 0.2;
    notes.push('trades often');
  } else if (profile?.tradesPerSeason.sufficient) {
    score += 0.05;
    notes.push('trades occasionally');
  } else {
    score -= 0.1;
    notes.push('no trade history on record — untested rather than unwilling');
  }

  // Filling their most urgent hole is the single strongest reason to say yes.
  if (idea.give.some((p) => idea.partner.needs[p.position] === 'urgent')) {
    score += 0.2;
    notes.push('it fills a slot they cannot currently start');
  }

  // Asking for their best player is how a fair offer gets ignored.
  const best = Math.max(0, ...idea.partner.assets.map((a) => a.value));
  if (idea.get.some((p) => p.value >= best - 0.01)) {
    score -= 0.25;
    notes.push('it asks for the best player on their roster');
  }

  // Two-for-one against a full roster costs them a spot they may not have.
  if (idea.give.length > idea.get.length) {
    score -= 0.05;
    notes.push('they end up with more players than they sent, which needs a roster spot');
  }

  return { score: round2(Math.min(1, Math.max(0, score))), notes };
}

export interface TradeFitOptions {
  /** Points of gain below which a deal is not worth proposing. */
  minGain?: number;
  /** Ideas kept per partner. */
  perPartner?: number;
  /** Plausibility below which an idea is dropped entirely. */
  minPlausibility?: number;
}

const DEFAULTS = { minGain: 1.5, perPartner: 2, minPlausibility: 0.25 } as const;

/**
 * Enumerate one-for-one and two-for-one deals against every partner.
 *
 * Bounded deliberately. The combinatorics of "any subset for any subset" run to
 * millions on a twelve-team league, and the deals a human will actually send
 * are small ones. Two-for-one is included in one direction only — mine for
 * theirs — because consolidating into a better player is the trade a needy team
 * proposes, and the reverse is a deal the partner would have to propose.
 */
export function findTradeFits(
  me: TradeTeam,
  partners: TradeTeam[],
  opts: TradeFitOptions = {},
): TradeIdea[] {
  const minGain = opts.minGain ?? DEFAULTS.minGain;
  const perPartner = opts.perPartner ?? DEFAULTS.perPartner;
  const minPlausibility = opts.minPlausibility ?? DEFAULTS.minPlausibility;

  const ideas: TradeIdea[] = [];

  for (const partner of partners) {
    const found: TradeIdea[] = [];

    const myGiveable = me.assets.filter((a) => a.surplus || (me.needs[a.position] ?? 'covered') === 'covered');
    const theirGiveable = partner.assets.filter(
      (a) => a.surplus || (partner.needs[a.position] ?? 'covered') === 'covered',
    );

    for (const get of theirGiveable) {
      for (const give of myGiveable) {
        if (give.position === get.position && Math.abs(give.value - get.value) < 0.5) continue;
        found.push(...consider(me, partner, [give], [get], minGain));

        // One two-for-one per pairing: a second, cheaper piece added to the
        // same ask. More than that and the list becomes permutations of the
        // same idea.
        const filler = myGiveable.find(
          (f) => f.playerId !== give.playerId && f.value < give.value && partner.needs[f.position] !== 'covered',
        );
        if (filler) found.push(...consider(me, partner, [give, filler], [get], minGain));
      }
    }

    ideas.push(
      ...found
        .filter((i) => i.plausibility >= minPlausibility)
        .sort((a, b) => b.valueToUser + b.valueToPartner - (a.valueToUser + a.valueToPartner))
        .slice(0, perPartner),
    );
  }

  return ideas.sort(
    (a, b) =>
      b.plausibility * (b.valueToUser + b.valueToPartner) - a.plausibility * (a.valueToUser + a.valueToPartner) ||
      b.valueToUser - a.valueToUser,
  );
}

function consider(
  me: TradeTeam,
  partner: TradeTeam,
  give: TradeAsset[],
  get: TradeAsset[],
  minGain: number,
): TradeIdea[] {
  const valueToUser = sideValue(me, get, give);
  const valueToPartner = sideValue(partner, give, get);

  // Both sides must gain. This is the whole point of the module and it is the
  // one condition that is not a threshold to be tuned.
  if (valueToUser < minGain || valueToPartner <= 0) return [];

  const { score, notes } = plausibilityOf({ partner, give, get, valueToPartner });

  const timing = [
    ...give.flatMap((p) => (p.timing ? tradeTimingFor(p.timing, 'mine') : [])),
    ...get.flatMap((p) => (p.timing ? tradeTimingFor(p.timing, 'theirs') : [])),
  ];

  const reasons = [
    `you gain ${valueToUser.toFixed(1)} pts of lineup, they gain ${valueToPartner.toFixed(1)}`,
    ...get.filter((p) => (me.needs[p.position] ?? 'covered') !== 'covered').map((p) => `${p.name} fills your ${p.position}`),
    ...give
      .filter((p) => (partner.needs[p.position] ?? 'covered') !== 'covered')
      .map((p) => `${p.name} fills their ${p.position}`),
  ];

  const counterpoints: string[] = [];
  if (give.some((p) => !p.surplus)) counterpoints.push('you are giving up a player you are currently starting');
  const byeClash = get.find((p) => p.byeWeek != null && give.some((g) => g.byeWeek === p.byeWeek));
  if (byeClash) counterpoints.push(`both sides of the deal are on bye in week ${byeClash.byeWeek}`);
  counterpoints.push(...notes.filter((n) => n.startsWith('it asks') || n.startsWith('no trade history')));

  return [
    {
      partner: { rosterId: partner.rosterId, displayName: partner.displayName },
      give,
      get,
      valueToUser,
      valueToPartner,
      plausibility: score,
      plausibilityNotes: notes,
      timing,
      reasons,
      counterpoints,
    },
  ];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
