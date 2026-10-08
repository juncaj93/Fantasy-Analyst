/**
 * What a trade does to each team over the rest of the fantasy season.
 *
 * ## The unit
 *
 * Points over the rest of the season, above what a free agent would have given
 * the team anyway. Every team can always claim a replacement-level player at any
 * position, so a player is only worth the points he adds beyond that, and a
 * team that loses a player is not left with an empty slot, it is left with the
 * waiver wire's best.
 *
 * ## The primary number is a lineup, not a player value
 *
 * A generic player value (`rosValue` below) is printed on each player for
 * reading, and it is **never what a side's number is built from**. A side's
 * number is the change in its best projected lineup, week by week, from now to
 * the end of the league's playoffs:
 *
 *     for each remaining week:
 *       best legal lineup from the roster, plus replacement-level free agents,
 *       each player's points scaled by whether he plays that week (bye, injury)
 *     sum the weeks; do it again with the trade made; subtract.
 *
 * That one subtraction answers the questions a count cannot. A third quarterback
 * adds nothing because he never enters a lineup. A wide receiver upgrade is worth
 * a lot to a team whose third receiver is weak because he starts every week he
 * is there. A bye that lands on the week a team has nobody behind its starter
 * costs exactly that week.
 *
 * ## A small credit for depth
 *
 * A bench player who is better than a free agent is insurance. Each of the best
 * few bench players earns {@link TRADE_VALUE.depth.injuryRate} of the points he
 * would add over replacement, per week he sits there. It is small on purpose.
 *
 * ## Alex's preferences, on his side only, labeled
 *
 * They are line items with names and points, capped, and they are added to his
 * side's net after the lineup number so a reader can see them and subtract them.
 * Other teams get none of them: a rival is valued by the same lineup math with no
 * opinion about how he likes to build a roster.
 *
 * ## What the verdict is
 *
 * The gap between the two sides' nets, with a close-call band around zero. A gap
 * inside the band is reported as a close call, never as a winner, because the
 * rates under it are projections and projections have a noise floor.
 *
 * Nothing here proposes, sends or accepts anything.
 */

import type { RosterShape } from '../sleeper/rosterShape.ts';
import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from './lineup.ts';
import { isOutNow } from './availability.ts';
import type { PlayerRate, RateBasis } from './rate.ts';
import type { TradeHorizon } from './weeks.ts';

export const TRADE_VALUE = {
  /** How many free agents, best first, set the replacement level at a position. */
  replacementSample: 3,
  depth: {
    /**
     * The share of a week a starter is expected to miss, and so the share of a
     * bench player's edge over replacement that counts as insurance.
     */
    injuryRate: 0.1,
    /** A roster can only use so many backups; only the best few are credited. */
    creditedBench: 3,
  },
  /**
   * The close-call band, in points over the rest of the season.
   *
   * The wider of a flat floor and a share of the points changing hands, because
   * the noise in a projection grows with its size: ten points between two
   * backups is a coin flip and ten between two stars is too.
   */
  closeCall: { floor: 4, share: 0.12 },
  /** A gap this many bands wide is "favors"; between one and this is "leans". */
  edgeBands: 2.5,
  prefs: {
    /** Of the RB value moved to Alex, how much extra it is worth to him. */
    rbLean: 0.03,
    /** The ROS improvement a second QB or TE has to bring to be worth a roster spot. */
    clearUpgradePoints: 6,
    /** Charge for a second QB or TE who is not that much better. */
    spareRosterSpot: 1,
    /** All preferences together, as a share of the value moved... */
    capShare: 0.1,
    /** ...but never less than this, so they stay visible on a small trade. */
    capFloor: 1.5,
  },
} as const;

export interface ReplacementLevel {
  rate: number;
  /** The free agents that set it, best first. */
  names: string[];
  /** How many priced free agents there were to average, up to the sample size. */
  sample: number;
}

export type ReplacementLevels = Map<string, ReplacementLevel>;

/**
 * The replacement level at each position, from this league's free agents.
 *
 * The mean of the best few rather than the single best, because the best free
 * agent by one week's number is partly one good matchup, and a value measured
 * against a lucky waiver wire is too low for everyone. Free agents who are out
 * or on a bye this week are not used: they are not what a manager claims now.
 */
export function replacementLevels(freeAgents: readonly PlayerRate[]): ReplacementLevels {
  const byPosition = new Map<string, PlayerRate[]>();
  for (const fa of freeAgents) {
    if (fa.rate == null || isOutNow(fa.designation)) continue;
    const list = byPosition.get(fa.position);
    if (list) list.push(fa);
    else byPosition.set(fa.position, [fa]);
  }
  const out: ReplacementLevels = new Map();
  for (const [position, list] of byPosition) {
    const top = [...list]
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || a.name.localeCompare(b.name))
      .slice(0, TRADE_VALUE.replacementSample);
    const rate = top.reduce((sum, p) => sum + (p.rate ?? 0), 0) / top.length;
    out.set(position, { rate: round2(rate), names: top.map((p) => p.name), sample: top.length });
  }
  return out;
}

export interface TradeSide {
  /** What to call this team: an owner's name, or `Roster 4`. */
  label: string;
  rosterId: number | null;
  /** True for Alex's team, which is the only one that gets his preferences. */
  isMine: boolean;
  /** Everyone on the roster, reserve slots included. */
  roster: readonly PlayerRate[];
  /** Sleeper's current starters, used only to notice a starter with no projection. */
  starterIds?: readonly string[];
}

export interface PlayerLine {
  playerId: string;
  name: string;
  position: string;
  team: string;
  rate: number | null;
  basis: RateBasis;
  rateNote: string | null;
  games: number;
  designation: string;
  injuryNote: string | null;
  byeWeek: number | null;
  byeInside: boolean;
  /** Points over replacement for the rest of the season, floored at zero. Null with no rate. */
  rosValue: number | null;
  /** Weeks he would be in the starting lineup, on the roster that holds him. */
  startsWeeks: number;
  /** Which weeks those are. */
  startsOn?: number[];
  /** Expected availability for each week of the horizon: 1 plays, 0 bye or out. */
  weekly?: number[];
  /** What his rate is made of: the base number, and the capped nudges added to it. */
  rateParts?: { base: number; nudges: number } | null;
}

export interface Adjustment {
  key: 'spare_qb_te' | 'spare_def' | 'second_qb_te' | 'rb_lean';
  label: string;
  points: number;
}

export interface SideResult {
  label: string;
  rosterId: number | null;
  isMine: boolean;
  /** Change in the best projected lineup over the remaining weeks. */
  lineupChange: number;
  /** The same, week by week, so a total can be checked against the weeks it came from. */
  weekly?: { week: number; lineupBefore: number; lineupAfter: number; depthBefore: number; depthAfter: number }[];
  /** Change in the small depth credit. */
  depthChange: number;
  /** Alex's preferences. Empty for every other team. */
  adjustments: Adjustment[];
  adjustmentTotal: number;
  /** `lineupChange + depthChange + adjustmentTotal`. The number this side is judged on. */
  net: number;
  incoming: PlayerLine[];
  outgoing: PlayerLine[];
  /** Someone cut to make room, when the trade leaves the roster over its limit. */
  mustDrop: PlayerLine | null;
  /** How many players the trade forces out in all, `mustDrop` being the first. Zero when none. */
  cutCount?: number;
  /** Starters Sleeper has set who have no projection, so are missing from the lineup math. */
  unvaluedStarters: string[];
}

export type VerdictKind = 'close' | 'leans_a' | 'leans_b' | 'favors_a' | 'favors_b';

export interface Verdict {
  kind: VerdictKind;
  /** Side A's net minus side B's net. */
  gap: number;
  /** Half-width of the close-call band, in points. */
  band: number;
  headline: string;
}

export type TradeConfidence = 'high' | 'medium' | 'low';

export interface TradeEvaluation {
  status: 'ok' | 'insufficient';
  /** Why there is no verdict, when there is not one. */
  insufficientReason: string | null;
  weeks: { first: number; last: number; count: number };
  a: SideResult | null;
  b: SideResult | null;
  verdict: Verdict | null;
  /** One or two sentences on what drives the verdict. */
  reasons: string[];
  /** What the reader should know before trusting it. */
  caveats: string[];
  confidence: TradeConfidence;
  confidenceReasons: string[];
  replacement: { position: string; rate: number; names: string[]; sample: number }[];
}

/* -------------------------------------------------------------------------- */

interface RosterValue {
  lineup: number;
  /** Depth credit, by what is excluded. */
  depth: { neutral: number; noQbTe: number; noQbTeDef: number };
  /** For each player, the weeks he is in the lineup. */
  starts: Map<string, number[]>;
  byWeek: { week: number; lineup: number; depth: number }[];
}

function valueRoster(opts: {
  players: readonly PlayerRate[];
  slots: readonly LineupSlotSpec[];
  replacement: ReplacementLevels;
  horizon: TradeHorizon;
}): RosterValue {
  const { players, slots, replacement, horizon } = opts;
  const priced = players.filter((p) => p.rate != null);
  const starts = new Map<string, number[]>();
  const byWeek: { week: number; lineup: number; depth: number }[] = [];
  let lineup = 0;
  const depth = { neutral: 0, noQbTe: 0, noQbTeDef: 0 };
  const defPrepWeek = horizon.regularSeasonEnd;

  // Replacement-level free agents, as many as the lineup could ever call on at
  // a position. They play every week: nobody claims a bye.
  const fills: LineupCandidate[] = [];
  for (const [position, level] of replacement) {
    const count = slots.filter((s) => s.eligible.has(position)).length;
    for (let i = 0; i < count; i++) fills.push({ id: `replacement:${position}:${i}`, position, value: level.rate });
  }

  horizon.weeks.forEach((week, index) => {
    const candidates: LineupCandidate[] = [
      ...priced.map((p) => ({ id: p.playerId, position: p.position, value: (p.rate ?? 0) * (p.weekly[index] ?? 1) })),
      ...fills,
    ];
    const result = bestLineup(slots, candidates);
    lineup += result.total;

    const started = new Set<string>();
    for (const pick of result.picks) {
      if (!pick) continue;
      started.add(pick.id);
      if (!pick.id.startsWith('replacement:')) starts.set(pick.id, [...(starts.get(pick.id) ?? []), week]);
    }

    const bench = candidates
      .filter((c) => !c.id.startsWith('replacement:') && !started.has(c.id))
      .map((c) => ({ c, credit: Math.max(0, c.value - (replacement.get(c.position)?.rate ?? c.value)) }))
      .filter((x) => x.credit > 0)
      .sort((x, y) => y.credit - x.credit || x.c.id.localeCompare(y.c.id));

    const credited = (keep: (position: string) => boolean): number =>
      bench
        .filter((x) => keep(x.c.position))
        .slice(0, TRADE_VALUE.depth.creditedBench)
        .reduce((sum, x) => sum + x.credit, 0) * TRADE_VALUE.depth.injuryRate;
    const isSpare = (position: string) => position === 'QB' || position === 'TE';
    depth.neutral += credited(() => true);
    depth.noQbTe += credited((position) => !isSpare(position));
    depth.noQbTeDef += credited((position) => !isSpare(position) && (position !== 'DEF' || week >= defPrepWeek));
    byWeek.push({ week, lineup: result.total, depth: credited(() => true) });
  });

  return { lineup, depth, starts, byWeek };
}

function lineFor(
  player: PlayerRate,
  replacement: ReplacementLevels,
  starts: Map<string, number[]>,
): PlayerLine {
  const level = replacement.get(player.position);
  const rosValue =
    player.rate == null || level == null ? null : Math.max(0, round1(player.games * (player.rate - level.rate)));
  return {
    playerId: player.playerId,
    name: player.name,
    position: player.position,
    team: player.team,
    rate: player.rate,
    basis: player.basis,
    rateNote: player.rateNote,
    games: player.games,
    designation: player.designation,
    injuryNote: player.injuryNote,
    byeWeek: player.byeWeek,
    byeInside: player.byeInside,
    rosValue,
    startsWeeks: starts.get(player.playerId)?.length ?? 0,
    startsOn: starts.get(player.playerId) ?? [],
    weekly: player.weekly,
    rateParts: player.rateParts ?? null,
  };
}

/** The roster slot count a team can hold, bench and injured reserve included. */
function rosterCapacity(shape: RosterShape): number {
  return shape.totalStarters + shape.benchSlots + shape.irSlots;
}

/** Who gets cut when a trade leaves a team over its limit: the player worth least to keep. */
function pickDrop(players: readonly PlayerRate[], replacement: ReplacementLevels): PlayerRate | null {
  if (players.length === 0) return null;
  const keep = (p: PlayerRate): number => {
    if (p.rate == null) return -1;
    const level = replacement.get(p.position)?.rate ?? 0;
    return p.games * Math.max(0, p.rate - level);
  };
  return [...players].sort((x, y) => keep(x) - keep(y) || x.name.localeCompare(y.name))[0] ?? null;
}

/* -------------------------------------------------------------------------- */

export function evaluateTrade(input: {
  horizon: TradeHorizon;
  shape: RosterShape;
  replacement: ReplacementLevels;
  a: TradeSide;
  b: TradeSide;
  /**
   * How many players a roster may hold, reserve slots included.
   *
   * Taken from the league's settings by the caller, because Sleeper's slot list
   * does not always name the injured-reserve slots a league has: this league
   * publishes two in `reserve_slots` and none in `roster_positions`, which made
   * a 17-player roster look over its limit on a one-for-one swap. Absent falls
   * back to what the slot list says.
   */
  rosterLimit?: number;
  /** Players side A sends to B. */
  aSends: readonly string[];
  /** Players side B sends to A. */
  bSends: readonly string[];
}): TradeEvaluation {
  const { horizon, shape, replacement, a, b } = input;
  const weeks = { first: horizon.weeks[0] ?? horizon.currentWeek, last: horizon.lastWeek, count: horizon.weeks.length };
  const levels = [...replacement].map(([position, level]) => ({ position, ...level }));
  const empty = (reason: string): TradeEvaluation => ({
    status: 'insufficient',
    insufficientReason: reason,
    weeks,
    a: null,
    b: null,
    verdict: null,
    reasons: [],
    caveats: [],
    confidence: 'low',
    confidenceReasons: [reason],
    replacement: levels,
  });

  if (horizon.weeks.length === 0) return empty('The fantasy season is over, so a trade has no weeks left to affect.');

  const slots = slotsOf(shape);
  const startable = new Set<string>();
  for (const slot of slots) for (const position of slot.eligible) startable.add(position);

  const find = (side: TradeSide, ids: readonly string[]): PlayerRate[] =>
    ids.map((id) => side.roster.find((p) => p.playerId === id)).filter((p): p is PlayerRate => p != null);
  const aOut = find(a, input.aSends);
  const bOut = find(b, input.bSends);
  if (aOut.length !== input.aSends.length || bOut.length !== input.bSends.length) {
    return empty('A player in this trade is not on the roster that is giving him up.');
  }
  if (aOut.length === 0 && bOut.length === 0) return empty('Pick at least one player to move.');

  const moved = [...aOut, ...bOut];
  const unpriced = moved.filter((p) => p.rate == null);
  if (unpriced.length > 0) {
    return empty(
      `No number can be put on ${listNames(unpriced.map((p) => p.name))}: ${unpriced[0]!.rateNote ?? 'nothing prices him'}. ` +
        `A verdict needs a real projection for every player moved.` +
        // Lines go up through the week, so a gap that is about the market is a gap that closes.
        (unpriced.some((p) => !/ruled out/.test(p.rateNote ?? ''))
          ? ' Betting lines fill in through the week, so check again Thursday or later.'
          : ''),
    );
  }
  const lacking = [...new Set(moved.filter((p) => startable.has(p.position) && !replacement.has(p.position)).map((p) => p.position))];
  if (lacking.length > 0) {
    return empty(
      `There are no priced free agents at ${lacking.join(', ')} to measure against, so a player there cannot be valued over replacement.`,
    );
  }

  const sideResult = (side: TradeSide, out: PlayerRate[], inn: PlayerRate[]): SideResult => {
    const afterIds = new Set(side.roster.map((p) => p.playerId));
    for (const p of out) afterIds.delete(p.playerId);
    let after = [...side.roster.filter((p) => afterIds.has(p.playerId)), ...inn];

    let mustDrop: PlayerRate | null = null;
    let cutCount = 0;
    /*
     * Only a trade that makes a roster bigger can force a cut, and only down to
     * where the roster already was or the limit, whichever is higher. A roster
     * already over its limit (a stale sync, a league that allows it) is not this
     * trade's doing, and a one-for-one swap never changes the count. As many are
     * cut as it takes, least valuable first.
     */
    const target = Math.max(input.rosterLimit ?? rosterCapacity(shape), side.roster.length);
    while (after.length > target) {
      const cut = pickDrop(after, replacement);
      if (!cut) break;
      mustDrop ??= cut;
      cutCount += 1;
      after = after.filter((p) => p.playerId !== cut.playerId);
    }

    const before = valueRoster({ players: side.roster, slots, replacement, horizon });
    const post = valueRoster({ players: after, slots, replacement, horizon });

    const lineupChange = post.lineup - before.lineup;
    const depthChange = post.depth.neutral - before.depth.neutral;

    const adjustments: Adjustment[] = [];
    if (side.isMine) {
      const qbTe = post.depth.noQbTe - before.depth.noQbTe - depthChange;
      if (Math.abs(qbTe) >= 0.05) {
        adjustments.push({
          key: 'spare_qb_te',
          label: 'You don’t carry a spare QB or TE, so no depth credit for one',
          points: round1(qbTe),
        });
      }
      const def = post.depth.noQbTeDef - before.depth.noQbTeDef - (post.depth.noQbTe - before.depth.noQbTe);
      if (Math.abs(def) >= 0.05) {
        adjustments.push({
          key: 'spare_def',
          label: 'You don’t carry a second defense before the playoffs, so no depth credit for one',
          points: round1(def),
        });
      }
      for (const position of ['QB', 'TE'] as const) {
        const incoming = inn.filter((p) => p.position === position);
        const kept = after.filter((p) => p.position === position && p.rate != null);
        if (incoming.length === 0 || kept.length < 2) continue;
        const bestBefore = Math.max(0, ...side.roster.filter((p) => p.position === position).map((p) => p.rate ?? 0));
        const bestAfter = Math.max(0, ...kept.map((p) => p.rate ?? 0));
        const improvement = (bestAfter - bestBefore) * horizon.weeks.length;
        if (improvement < TRADE_VALUE.prefs.clearUpgradePoints) {
          adjustments.push({
            key: 'second_qb_te',
            label: `A second ${position} you would not roster unless he was clearly better than what you have`,
            points: -TRADE_VALUE.prefs.spareRosterSpot,
          });
        }
      }
      const rbIn = inn.filter((p) => p.position === 'RB').reduce((s, p) => s + (lineFor(p, replacement, post.starts).rosValue ?? 0), 0);
      const rbOut = out.filter((p) => p.position === 'RB').reduce((s, p) => s + (lineFor(p, replacement, before.starts).rosValue ?? 0), 0);
      const lean = TRADE_VALUE.prefs.rbLean * (rbIn - rbOut);
      if (Math.abs(lean) >= 0.05) {
        adjustments.push({ key: 'rb_lean', label: 'You lean RB-heavy when value is close', points: round1(lean) });
      }
    }

    // Held to a small share of what moved, and always shown.
    const gross = Math.max(
      inn.reduce((s, p) => s + (lineFor(p, replacement, post.starts).rosValue ?? 0), 0),
      out.reduce((s, p) => s + (lineFor(p, replacement, before.starts).rosValue ?? 0), 0),
    );
    const cap = Math.max(TRADE_VALUE.prefs.capFloor, TRADE_VALUE.prefs.capShare * gross);
    const rawTotal = adjustments.reduce((s, x) => s + x.points, 0);
    if (Math.abs(rawTotal) > cap) {
      const scale = cap / Math.abs(rawTotal);
      for (const adj of adjustments) adj.points = round1(adj.points * scale);
    }
    const adjustmentTotal = round1(adjustments.reduce((s, x) => s + x.points, 0));

    /*
     * A starter with no projection only matters to a trade that could put
     * somebody into his slot. A missing quarterback says nothing about a swap of
     * receivers, and printing it there is a caution about nothing.
     */
    const relevant = new Set<string>();
    for (const p of [...out, ...inn]) {
      relevant.add(p.position);
      for (const slot of slots) if (slot.eligible.has(p.position)) for (const q of slot.eligible) relevant.add(q);
    }
    const unvaluedStarters = (side.starterIds ?? [])
      .map((id) => side.roster.find((p) => p.playerId === id))
      .filter((p): p is PlayerRate => p != null && p.rate == null && relevant.has(p.position))
      .map((p) => p.name);

    return {
      label: side.label,
      rosterId: side.rosterId,
      isMine: side.isMine,
      lineupChange: round1(lineupChange),
      weekly: before.byWeek.map((w, i) => ({
        week: w.week,
        lineupBefore: round1(w.lineup),
        lineupAfter: round1(post.byWeek[i]?.lineup ?? w.lineup),
        depthBefore: round1(w.depth),
        depthAfter: round1(post.byWeek[i]?.depth ?? w.depth),
      })),
      depthChange: round1(depthChange),
      adjustments,
      adjustmentTotal,
      net: round1(lineupChange + depthChange + adjustmentTotal),
      incoming: inn.map((p) => lineFor(p, replacement, post.starts)),
      outgoing: out.map((p) => lineFor(p, replacement, before.starts)),
      mustDrop: mustDrop ? lineFor(mustDrop, replacement, before.starts) : null,
      cutCount,
      unvaluedStarters,
    };
  };

  const ra = sideResult(a, aOut, bOut);
  const rb = sideResult(b, bOut, aOut);

  const gross = Math.max(sumValue(ra.incoming), sumValue(rb.incoming));
  const band = round1(Math.max(TRADE_VALUE.closeCall.floor, TRADE_VALUE.closeCall.share * gross));
  const gap = round1(ra.net - rb.net);
  const verdict = verdictFor(ra, rb, gap, band);

  const reasons = reasonsFor(ra, rb, weeks.count);
  const { confidence, confidenceReasons } = confidenceFor(ra, rb, moved, levels);
  const caveats = caveatsFor(ra, rb, horizon, levels);

  return { status: 'ok', insufficientReason: null, weeks, a: ra, b: rb, verdict, reasons, caveats, confidence, confidenceReasons, replacement: levels };
}

/* -------------------------------------------------------------------------- */

function sumValue(lines: readonly PlayerLine[]): number {
  return lines.reduce((s, l) => s + (l.rosValue ?? 0), 0);
}

/** `you` for Alex's team, the team's own name for anybody else's. */
function who(side: SideResult): string {
  return side.isMine ? 'you' : side.label;
}

function verdictFor(a: SideResult, b: SideResult, gap: number, band: number): Verdict {
  const size = Math.abs(gap);
  const winner = gap >= 0 ? a : b;
  const kindSuffix = gap >= 0 ? 'a' : 'b';
  const pts = Math.round(size);
  if (size <= band) {
    return {
      kind: 'close',
      gap,
      band,
      headline: `Close call. Within about ${Math.round(band)} pts, which is more than this model can separate.`,
    };
  }
  const strong = size > band * TRADE_VALUE.edgeBands;
  const name = who(winner);
  /*
   * The gap is one side's change minus the other's, so a swap where one team
   * gains 59 and the other loses 59 reads 118. That is the honest head-to-head
   * difference and it is also double what either team experiences, so the two
   * changes ride beside it and the larger number never appears alone.
   */
  const both = `${who(a)} ${signedPts(a.net)}, ${who(b)} ${signedPts(b.net)}`;
  return {
    kind: `${strong ? 'favors' : 'leans'}_${kindSuffix}` as VerdictKind,
    gap,
    band,
    headline: strong
      ? `Favors ${name} by about ${pts} pts over the rest of the season (${both}).`
      : `Leans toward ${name}, about ${pts} pts over the rest of the season (${both}).`,
  };
}

function reasonsFor(a: SideResult, b: SideResult, weeks: number): string[] {
  const candidates: { weight: number; text: string }[] = [];

  const lineupReason = (side: SideResult) => {
    const you = side.isMine;
    const subject = you ? 'You' : side.label;
    const starters = side.incoming.filter((p) => p.startsWeeks > 0).sort((x, y) => y.startsWeeks - x.startsWeeks);
    if (side.lineupChange >= 2 && starters.length > 0) {
      const top = starters[0]!;
      candidates.push({
        weight: side.lineupChange,
        text: `${subject} would start ${top.name} (${top.position}) in ${top.startsWeeks} of ${weeks} weeks, which lifts the lineup by about ${Math.round(side.lineupChange)} pts.`,
      });
    } else if (side.lineupChange <= -2) {
      const lost = [...side.outgoing].sort((x, y) => y.startsWeeks - x.startsWeeks)[0];
      candidates.push({
        weight: Math.abs(side.lineupChange),
        text: `${subject} ${you ? 'lose' : 'loses'} ${lost?.name ?? 'a starter'}${lost && lost.startsWeeks > 0 ? ` who starts ${lost.startsWeeks} of ${weeks} weeks` : ''}, costing about ${Math.round(Math.abs(side.lineupChange))} pts of lineup.`,
      });
    } else if (side.incoming.length > 0 && side.incoming.every((p) => p.startsWeeks === 0)) {
      const names = listNames(side.incoming.map((p) => p.name));
      candidates.push({
        weight: 1.5,
        text: `${names} would sit on ${you ? 'your' : `${side.label}’s`} bench, so ${you ? 'your' : 'their'} lineup barely changes.`,
      });
    }
    for (const p of side.incoming) {
      if (p.byeInside && p.byeWeek != null && p.startsWeeks > 0) {
        candidates.push({ weight: 0.5, text: `${p.name} is on a bye in week ${p.byeWeek}, which is already counted.` });
      }
    }
  };
  lineupReason(a);
  lineupReason(b);

  if (a.net <= 0 && b.net <= 0) {
    candidates.push({ weight: 3, text: 'Neither lineup gets better from this deal.' });
  }

  return candidates
    .sort((x, y) => y.weight - x.weight)
    .slice(0, 2)
    .map((c) => c.text);
}

function confidenceFor(
  a: SideResult,
  b: SideResult,
  moved: readonly PlayerRate[],
  levels: readonly { sample: number; position: string }[],
): { confidence: TradeConfidence; confidenceReasons: string[] } {
  const reasons: string[] = [];
  let level: TradeConfidence = 'high';
  const lower = (to: TradeConfidence) => {
    const order: TradeConfidence[] = ['high', 'medium', 'low'];
    if (order.indexOf(to) > order.indexOf(level)) level = to;
  };

  const weak = moved.filter((p) => p.basis === 'season_line');
  if (weak.length > 0) {
    lower('low');
    reasons.push(`${listNames(weak.map((p) => p.name))} ${weak.length === 1 ? 'is' : 'are'} valued on the season line, not a current week.`);
  }
  const earlier = moved.filter((p) => p.basis === 'recent_week');
  if (earlier.length > 0) {
    lower('medium');
    reasons.push(
      `${listNames(earlier.map((p) => p.name))} ${earlier.length === 1 ? 'has' : 'have'} no number this week, so ${earlier.length === 1 ? 'he is' : 'they are'} valued on an earlier week’s Sleeper projection.`,
    );
  }
  const published = moved.filter((p) => p.basis === 'published');
  if (published.length > 0) {
    lower('medium');
    reasons.push(`${listNames(published.map((p) => p.name))} ${published.length === 1 ? 'rests' : 'rest'} on Sleeper’s projection, with no complete Vegas week.`);
  }
  const unknownBye = moved.filter((p) => !p.byeKnown && p.position !== 'DEF');
  if (unknownBye.length > 0) {
    lower('medium');
    reasons.push(`The bye week is unknown for ${listNames(unknownBye.map((p) => p.name))}, so none is counted.`);
  }
  const thin = levels.filter((l) => l.sample < TRADE_VALUE.replacementSample && moved.some((p) => p.position === l.position));
  if (thin.length > 0) {
    lower('medium');
    reasons.push(`Few free agents are priced at ${thin.map((t) => t.position).join(', ')}, so replacement level there is rough.`);
  }
  for (const side of [a, b]) {
    if (side.unvaluedStarters.length > 0) {
      lower('medium');
      reasons.push(
        `${side.isMine ? 'Your' : `${side.label}’s`} lineup includes ${listNames(side.unvaluedStarters)} with no projection, so ${side.isMine ? 'your' : 'their'} gain may be overstated.`,
      );
    }
  }
  return { confidence: level, confidenceReasons: reasons };
}

function caveatsFor(
  a: SideResult,
  b: SideResult,
  horizon: TradeHorizon,
  levels: readonly { position: string; rate: number; names: string[] }[],
): string[] {
  const out: string[] = [];
  const lines = [...a.incoming, ...b.incoming];
  for (const p of lines) if (p.rateNote) out.push(`${p.name}: ${p.rateNote}.`);
  for (const p of lines) if (p.injuryNote) out.push(`${p.name}: ${p.injuryNote}.`);
  for (const side of [a, b]) {
    if (side.mustDrop) {
      const more = (side.cutCount ?? 1) - 1;
      out.push(
        `${side.isMine ? 'You' : side.label} would be over the roster limit and cut ${side.mustDrop.name}` +
          `${more > 0 ? ` and ${more} more` : ''}.`,
      );
    }
  }
  if (horizon.deadlinePassed) {
    out.push(`The trade deadline was week ${horizon.deadlineWeek}, so this trade can no longer be made.`);
  } else if (horizon.deadlineWeek != null) {
    out.push(`Trades close after week ${horizon.deadlineWeek}.`);
  }
  const involved = new Set([...lines.map((p) => p.position), ...[...a.outgoing, ...b.outgoing].map((p) => p.position)]);
  const level = levels
    .filter((l) => involved.has(l.position))
    .map((l) => `${l.position} ${l.rate.toFixed(1)}`)
    .join(', ');
  if (level) out.push(`Replacement level (a free agent): ${level} pts a game.`);
  return out;
}

function signedPts(value: number): string {
  const n = Math.round(Math.abs(value));
  return value > 0 ? `+${n}` : value < 0 ? `\u2212${n}` : '0';
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
