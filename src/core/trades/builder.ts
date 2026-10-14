/**
 * Build a trade: packages from the players Alex marked, scored on both rosters.
 *
 * Alex marks the players he would sell and, on one team or all of them, the
 * players he would like. This module builds the small packages those marks
 * allow (1 for 1, 2 for 1, 1 for 2, and 2 for 2 when the marks are few), and
 * keeps only the ones that help **both** lineups.
 *
 * ## No second scorer
 *
 * Every number a package carries comes from Check a trade's own evaluation
 * (`tradeValue/evaluate.ts`): the best legal lineup, week by week, from now to
 * the end of the playoffs, on each team's real roster, with byes and injuries
 * counted as missed weeks and depth credited. This file only decides which
 * packages to ask it about and how to read the weekly answers it gives back.
 *
 * The cheap ordering pass below (`quickGain`) uses the same lineup solver on
 * one representative week, and only to decide which few packages are worth
 * the full evaluation. It never reaches the screen.
 *
 * ## How a package is read
 *
 *  - **Alex's gain** is the weekly lineup change (depth and bye cover
 *    included), counted most for the week a trade first affects, then the two
 *    after it, then the rest of the regular season, with playoff weeks weighted
 *    up; plus his stated preferences from Check a trade (no spare QB or TE,
 *    lean RB). What he gives up is already in it: the lineup is rebuilt without
 *    him.
 *  - **Their gain** is the same, on their roster, with no preferences. A
 *    package that does not help them is never shown.
 *  - **Balance** is each side's rest-of-season value over a free agent. Inside
 *    {@link BUILDER.band} it can be shown; the status says how likely a yes
 *    looks from the roster facts alone.
 *  - **Status** is Likely, Maybe or Long shot, in words. There is no
 *    percentage: Sleeper never shows turned-down offers, so there is nothing to
 *    compute one from.
 *
 * ## Roster limits
 *
 * When Alex would receive more players than he sends, the extra spot comes from
 * an open IR slot first (an IR-eligible player moves there), then from a drop
 * chosen the way the waiver planner chooses one: lowest drop score first, and
 * never a protected player (a high draft pick, a handcuff to an elite back, a
 * player in his coming-week lineup unless he is a dead spot). No safe drop, no
 * package.
 *
 * Pure. It suggests; it never sends, proposes or contacts anyone.
 */

import { isOutNow } from '../tradeValue/availability.ts';
import { evaluateTrade, type ReplacementLevels, type SideResult, type TradeEvaluation, type TradeSide } from '../tradeValue/evaluate.ts';
import { bestLineup, slotsOf, type LineupCandidate, type LineupSlotSpec } from '../tradeValue/lineup.ts';
import type { PlayerRate } from '../tradeValue/rate.ts';
import type { TradeHorizon } from '../tradeValue/weeks.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import { isDeadSpot, readDrops, type DropSignals } from '../waivers/dropScore.ts';
import { tradeExcluded } from './rosterUtility.ts';
import {
  BUILDER_ADVISORY,
  BUILDER_WILLINGNESS,
  type BuilderResult,
  type BuilderTeamResult,
  type BuiltPackage,
  type FollowUpAdd,
  type PackageMove,
  type PackagePlayer,
  type PackageStatus,
  type TradeActivity,
  rankPackages,
  topAcrossTeams,
} from './builderResponse.ts';

export const BUILDER = {
  /** Week weights for the ranking number: the first week, the two after it, other regular weeks, playoff weeks. */
  weights: { first: 3, nextTwo: 2, regular: 1, playoff: 1.5 },
  /** Weighted points either side must gain to count as helped. */
  minGain: 1,
  /**
   * Balance bands, as Alex's edge in rest-of-season value over the larger side:
   * up to `even` is Likely territory, up to `maybe` is Maybe, up to `longShot`
   * is a Long shot, and past it the package is not shown.
   */
  band: { even: 0.1, maybe: 0.25, longShot: 0.45 },
  /** Their players suggested per team when Alex marked none there. */
  suggestionsPerTeam: 4,
  /** Fewer when every team is asked at once, to keep the request bounded. */
  suggestionsAllTeams: 3,
  /** Alex's players considered when "also consider unmarked" is on. */
  givePool: 6,
  /** Full evaluations per team, and per team when all teams are asked. */
  evaluatedPerTeam: 10,
  evaluatedAllTeams: 4,
  /** Packages shown for one team, and across all teams (at most two per team there). */
  shownPerTeam: 3,
  shownAll: 5,
  perTeamInAll: 2,
  /** 2 for 2 only when both sides' lists are this short. */
  twoForTwoMax: 4,
  /** A back is elite at this Start/Sit number or better, or when drafted this early. */
  eliteRbRate: 12,
  eliteRbRound: 2,
  /** A starter this close to a free agent leaves the position thin. */
  thinMargin: 1.5,
  /** Weeks to the deadline at which the screen warns. */
  nearDeadline: 2,
} as const;

/** One team as the builder sees it. */
export interface BuilderTeam {
  rosterId: number;
  label: string;
  roster: readonly PlayerRate[];
  starterIds: readonly string[];
  activity: TradeActivity;
}

export interface BuilderInput {
  horizon: TradeHorizon;
  shape: RosterShape;
  replacement: ReplacementLevels;
  /** Every player a roster may hold, reserve slots included (Check a trade's limit). */
  rosterLimit: number;
  /** Injured-reserve slots, and which statuses they take beyond IR. */
  reserveSlots: number;
  reserveAllows?: { out: boolean; doubtful: boolean; sus: boolean };
  me: BuilderTeam & { reserveIds: readonly string[] };
  teams: readonly BuilderTeam[];
  /** Alex's Sell marks. */
  sell: readonly string[];
  /** Want marks, by roster id. */
  want: ReadonlyMap<number, readonly string[]>;
  /** One team, or every team. */
  team: number | 'all';
  /** Also offer players Alex did not mark (never his elite backs). */
  considerUnmarked: boolean;
  /** Alex's elite backs: never offered unless marked. */
  eliteRbs: ReadonlySet<string>;
  /**
   * Alex's handcuffs to elite backs: never offered unless marked, like the
   * backs themselves (Alex, 14 October: an unmarked package gave away Emmett
   * Johnson, one of his two).
   */
  handcuffs?: ReadonlySet<string>;
  /**
   * One team of an All teams sweep (the screen asks team by team, so no single
   * request is heavy): the All teams rules (only suggestions some deal could
   * bring back, no Long shots), with one team's evaluation budget.
   */
  sweep?: boolean;
  /** Protections from the waiver planner, for a forced drop: id to the note. */
  protections: ReadonlyMap<string, string>;
  /** The waiver planner's drop score inputs, when this season's points are on record. */
  dropSignals?: ReadonlyMap<string, DropSignals> | null;
}

/* -------------------------------------------------------------------------- */

interface Candidate {
  team: BuilderTeam;
  give: string[];
  get: string[];
  priority: number;
}

interface Need {
  position: string;
  label: string;
  severity: number;
}

const WORD: Record<string, string> = {
  out: 'Out',
  ir: 'on IR',
  pup: 'on PUP',
  suspended: 'suspended',
  doubtful: 'Doubtful',
  questionable: 'Questionable',
};

export function buildTradePackages(input: BuilderInput): BuilderResult {
  const { horizon } = input;
  const hidden: Record<string, number> = {};
  const hide = (reason: string) => {
    hidden[reason] = (hidden[reason] ?? 0) + 1;
  };
  const notes: string[] = [];
  const weeks = horizon.weeks.length
    ? {
        thisWeek: horizon.weeks[0]!,
        next3: horizon.weeks.slice(0, 3),
        playoffs: horizon.playoffWeeks.filter((w) => horizon.weeks.includes(w)),
        last: horizon.lastWeek,
      }
    : null;
  const deadline = deadlineOf(horizon);
  const empty = (status: BuilderResult['status'], message: string): BuilderResult => ({
    status,
    message,
    weeks,
    deadline,
    packages: [],
    teams: [],
    audit: { generated: 0, evaluated: 0, shown: 0, hidden },
    notes,
    willingness: BUILDER_WILLINGNESS,
    advisory: BUILDER_ADVISORY,
  });

  if (horizon.weeks.length === 0) return empty('closed', 'The fantasy season is over, so there is nothing left to trade for.');
  if (deadline.passed) return empty('closed', deadline.line ?? 'The trade deadline has passed.');

  const teams = input.team === 'all' ? input.teams : input.teams.filter((t) => t.rosterId === input.team);
  if (teams.length === 0) return empty('no_team', 'Pick a team to trade with.');

  const slots = slotsOf(input.shape);
  const mine = new Map(input.me.roster.map((p) => [p.playerId, p] as const));

  /* What Alex can offer: his marks, then (only when asked) his most spare others. Never an elite back he did not mark. */
  const marked = input.sell.filter((id) => mine.has(id));
  const unpricedSells = marked.filter((id) => mine.get(id)!.rate == null);
  if (unpricedSells.length > 0) {
    notes.push(`${listNames(unpricedSells.map((id) => mine.get(id)!.name))} ${unpricedSells.length === 1 ? 'has' : 'have'} no number this week, so ${unpricedSells.length === 1 ? 'he is' : 'they are'} left out.`);
  }
  const give = givePoolOf(input, slots);
  if (give.length === 0) {
    return empty(
      'no_sells',
      marked.length > 0
        ? 'None of the players you marked Sell has a number this week, so no package can be checked yet.'
        : 'Mark at least one of your players Sell, or turn on “Also consider unmarked players”.',
    );
  }

  const all = input.team === 'all';
  /* The All teams rules, whether every team is asked at once or one per request. */
  const allLike = all || input.sweep === true;
  const teamResults: BuilderTeamResult[] = [];
  const shown: BuiltPackage[] = [];
  let generated = 0;
  let evaluated = 0;
  const dropCache = new Map<string, SideResult | null>();

  for (const team of teams) {
    const needs = needsOf(team, slots, input.replacement, horizon);
    const theirs = new Map(team.roster.map((p) => [p.playerId, p] as const));
    const wanted = (input.want.get(team.rosterId) ?? []).filter((id) => theirs.has(id));
    let suggested: string[] = [];
    let get = wanted.filter((id) => tradeable(theirs.get(id)!));
    const theirBase = quickValue(slots, input.replacement, team.roster, horizon);
    const theirLoss = (out: readonly string[], inn: readonly PlayerRate[]) =>
      theirBase - quickValue(slots, input.replacement, [...team.roster.filter((p) => !out.includes(p.playerId)), ...inn], horizon);
    if (wanted.length === 0) {
      /*
       * The players who would most improve Alex's lineup, among the ones a deal
       * could actually bring back: each is paired with every Sell mark on the
       * quick pass, and a player some 1 for 1 helps both sides with comes first,
       * best pairing first. A starter they cannot spare for anything Alex
       * offers goes behind them, still ordered by what he would add.
       */
      const base = quickValue(slots, input.replacement, input.me.roster, horizon);
      suggested = team.roster
        .filter(tradeable)
        .map((p) => {
          const gain = quickValue(slots, input.replacement, [...input.me.roster, p], horizon) - base;
          let pair = -Infinity;
          for (const id of give) {
            const out = mine.get(id)!;
            const mineGain = quickValue(slots, input.replacement, [...input.me.roster.filter((q) => q.playerId !== id), p], horizon) - base;
            const theirGain = -theirLoss([p.playerId], [out]);
            if (mineGain > 0 && theirGain > 0) pair = Math.max(pair, mineGain + theirGain);
          }
          return { id: p.playerId, gain, pair };
        })
        /* Asking every team at once, only players some deal could bring back: the budget is too small for the rest. */
        .filter((x) => x.gain > 0.05 && (!allLike || x.pair > -Infinity))
        .sort((a, b) => Number(b.pair > -Infinity) - Number(a.pair > -Infinity) || (b.pair > -Infinity ? b.pair - a.pair : b.gain - a.gain) || a.id.localeCompare(b.id))
        .slice(0, all ? BUILDER.suggestionsAllTeams : BUILDER.suggestionsPerTeam)
        .map((x) => x.id);
      get = suggested;
    }
    if (get.length === 0) {
      hide('nothing_to_get');
      teamResults.push({ rosterId: team.rosterId, label: team.label, activity: team.activity, needs: needs.map((n) => n.label), suggested: [], packages: [] });
      continue;
    }

    /*
     * Every shape the marks allow, ordered by a one-week solver pass on both
     * rosters, cut to a few full evaluations. Ordering on Alex's side alone
     * spends the evaluations on packages that take their starters, which is
     * every package they would refuse. A package either side's quick pass
     * says loses is still allowed through, behind all the ones that look good
     * for both: the quick pass is one week, the full check is the season.
     */
    const myBase = quickValue(slots, input.replacement, input.me.roster, horizon);
    const candidates = shapes(give, get).map((s) => {
      const outgoing = s.give.map((id) => mine.get(id)!);
      const mineGain =
        quickValue(slots, input.replacement, [...input.me.roster.filter((p) => !s.give.includes(p.playerId)), ...s.get.map((id) => theirs.get(id)!)], horizon) - myBase;
      const theirGain = -theirLoss(s.get, outgoing);
      return { team, give: s.give, get: s.get, priority: mineGain > 0 && theirGain > 0 ? mineGain + theirGain : Math.min(mineGain, theirGain) - 100 };
    });
    generated += candidates.length;
    const cap = all ? BUILDER.evaluatedAllTeams : BUILDER.evaluatedPerTeam;
    const ordered = candidates.sort((a, b) => b.priority - a.priority || key(a).localeCompare(key(b)));
    for (let i = cap; i < ordered.length; i++) hide('pruned_by_bound');

    const built: BuiltPackage[] = [];
    for (const candidate of ordered.slice(0, cap)) {
      evaluated += 1;
      const result = evaluatePackage(candidate, needs, input, slots, dropCache);
      if ('hidden' in result) hide(result.hidden);
      else built.push(result.pkg);
    }

    /* At least Maybe, ranked by Alex's gain; a Long shot only when a named team has nothing better. */
    const ranked = rankPackages(built);
    const good = ranked.filter((p) => p.status !== 'long_shot');
    const list = distinctGets(good.length > 0 || allLike ? good : ranked).slice(0, BUILDER.shownPerTeam);
    for (const p of ranked) if (!list.includes(p)) hide(p.status === 'long_shot' ? 'long_shot' : 'below_top');
    teamResults.push({
      rosterId: team.rosterId,
      label: team.label,
      activity: team.activity,
      needs: needs.map((n) => n.label),
      suggested: suggested.map((id) => theirs.get(id)?.name ?? id),
      packages: list,
    });
    shown.push(...list);
  }

  let packages: BuiltPackage[];
  if (all) {
    packages = topAcrossTeams(shown);
  } else {
    packages = teamResults[0]?.packages ?? [];
  }

  const message =
    packages.length > 0
      ? null
      : all
        ? 'No package from your Sell marks helps both you and another team right now.'
        : `No package from these marks helps both you and ${teams[0]!.label} right now.`;
  return {
    status: 'ok',
    message,
    weeks,
    deadline,
    packages,
    teams: teamResults,
    audit: { generated, evaluated, shown: packages.length, hidden },
    notes,
    willingness: BUILDER_WILLINGNESS,
    advisory: BUILDER_ADVISORY,
  };
}

/* ------------------------------------------------------------ one package -- */

function evaluatePackage(
  candidate: Candidate,
  needs: readonly Need[],
  input: BuilderInput,
  slots: readonly LineupSlotSpec[],
  dropCache: Map<string, SideResult | null>,
): { pkg: BuiltPackage } | { hidden: string } {
  const { team } = candidate;
  const theirs = new Map(team.roster.map((p) => [p.playerId, p] as const));
  const incoming = candidate.get.map((id) => theirs.get(id)!);

  /* Room for what arrives: an open IR slot first, then a drop the waiver planner would make. */
  const room = rosterRoom(candidate, input, slots);
  if (room == null) return { hidden: 'no_safe_drop' };
  /*
   * Only a drop leaves the roster. A player moved to an open IR slot stays on
   * it (he is valued on the weeks he is back), and the roster limit already
   * counts that slot, so Check a trade sees room for him without a cut.
   */
  const removed = room.drops;
  const roster = input.me.roster.filter((p) => !removed.some((r) => r.playerId === p.playerId));

  const side = (t: BuilderTeam, list: readonly PlayerRate[], isMine: boolean): TradeSide => ({
    label: t.label,
    rosterId: t.rosterId,
    isMine,
    roster: list,
    starterIds: t.starterIds,
  });
  const evaluation = evaluateTrade({
    horizon: input.horizon,
    shape: input.shape,
    replacement: input.replacement,
    a: side(input.me, roster, true),
    b: side(team, team.roster, false),
    rosterLimit: input.rosterLimit,
    aSends: candidate.give,
    bSends: candidate.get,
  });
  if (evaluation.status !== 'ok' || !evaluation.a || !evaluation.b) return { hidden: 'thin_data' };

  /* What the roster move costs, from the same evaluation: Alex's roster without the players moved out. */
  const moveCost = removed.length === 0 ? null : costOfRemoving(removed, input, dropCache);
  if (removed.length > 0 && moveCost == null) return { hidden: 'thin_data' };

  const a = evaluation.a;
  const b = evaluation.b;
  const aWeekly = weeklyDelta(a).map((d, i) => d + (moveCost ? (weeklyDelta(moveCost)[i] ?? 0) : 0));
  const bWeekly = weeklyDelta(b);
  const weights = weekWeights(input.horizon);
  const aWeighted = round1(sumWeighted(aWeekly, weights) + a.adjustmentTotal + (moveCost?.adjustmentTotal ?? 0));
  const bWeighted = round1(sumWeighted(bWeekly, weights));

  /* Alex's preference: no spare QB or TE unless clearly better (Check a trade's own line). */
  if (a.adjustments.some((x) => x.key === 'second_qb_te')) return { hidden: 'spare_qb_te' };
  /* Both lineups must gain: weighted toward the coming weeks, and over the whole season too. */
  if (aWeighted < BUILDER.minGain || a.net + (moveCost?.net ?? 0) <= 0) return { hidden: 'no_gain_for_you' };
  if (bWeighted < BUILDER.minGain || b.net <= 0) return { hidden: 'no_gain_for_them' };

  const giveValue = round1(a.outgoing.reduce((s, p) => s + (p.rosValue ?? 0), 0));
  const getValue = round1(a.incoming.reduce((s, p) => s + (p.rosValue ?? 0), 0));
  const larger = Math.max(giveValue, getValue);
  const edge = larger > 0 ? (getValue - giveValue) / larger : 0;
  if (edge > BUILDER.band.longShot) return { hidden: 'outside_band' };

  const sends = new Set(candidate.give.map((id) => input.me.roster.find((p) => p.playerId === id)?.position ?? ''));
  const need = needs.find((n) => sends.has(n.position) || (n.position === 'FLEX' && [...sends].some((s) => ['RB', 'WR', 'TE'].includes(s)))) ?? null;
  let status = statusOf({ edge, need: need != null, alex: aWeighted, them: bWeighted });

  /*
   * A slot the package leaves with nobody to fill it (Love traded with Burrow
   * on a bye): no new scoring, only said. The numbers already assume a free
   * agent there; with none priced at that position it is a Long shot.
   */
  const after = [
    ...roster.filter((p) => !candidate.give.includes(p.playerId)),
    ...incoming,
  ];
  const followUp = followUpAdds(input.me.roster, after, slots, input.horizon, input.replacement);
  if (followUp.some((f) => f.assumes == null) && status.status !== 'long_shot') {
    const hole = followUp.find((f) => f.assumes == null)!;
    status = {
      status: 'long_shot',
      reason: `It leaves you no ${hole.position} in week ${hole.weeks[0]}, and no free agent ${hole.position} is priced to fill it.`,
      short: `No ${hole.position} wk ${hole.weeks[0]} · none on waivers`,
    };
  }

  const playoffWeeks = new Set(input.horizon.playoffWeeks);
  const sumWhere = (list: number[], keep: (week: number, i: number) => boolean) =>
    round1(list.reduce((s, d, i) => (keep(input.horizon.weeks[i]!, i) ? s + d : s), 0));
  const starter = b.incoming.filter((p) => p.startsWeeks > 0).sort((x, y) => y.startsWeeks - x.startsWeeks)[0];
  const why = need
    ? capitalise(need.label)
    : starter
      ? `${starter.name} would start ${starter.startsWeeks} of ${input.horizon.weeks.length} weeks for them`
      : `Their lineup gains about ${Math.round(Math.max(0, sumWhere(bWeekly, (_, i) => i < 3)))} pts over 3 weeks`;

  const give = candidate.give.map((id) => playerLine(input.me.roster.find((p) => p.playerId === id)!));
  const get = incoming.map(playerLine);
  const drops: PackageMove[] = room.drops.map((p) => ({ ...playerLine(p), reason: room.reasons.get(p.playerId) ?? 'the least you would miss' }));
  const irMoves: PackageMove[] = room.ir.map((p) => ({ ...playerLine(p), reason: `${WORD[p.designation] ?? 'injured'}, so an open IR slot can take him` }));

  const balanceLabel =
    Math.abs(edge) <= BUILDER.band.even ? 'about even' : edge > 0 ? 'you get more value' : 'they get more value';
  const reasons = [
    ...evaluation.reasons,
    need ? `For them: ${need.label}.` : null,
    `Rest-of-season value over a free agent: you give ${Math.round(giveValue)}, you get ${Math.round(getValue)} (${balanceLabel}).`,
  ].filter((x): x is string => x != null);
  const caveats = [
    ...evaluation.confidenceReasons,
    ...evaluation.caveats.filter((c) => !/^Replacement level/.test(c)),
  ];

  const pkg: BuiltPackage = {
    id: `${team.rosterId}:${[...candidate.give].sort().join('+')}>${[...candidate.get].sort().join('+')}`,
    partner: { rosterId: team.rosterId, label: team.label, activity: team.activity },
    give,
    get,
    drops,
    irMoves,
    alex: {
      thisWeek: round1(aWeekly[0] ?? 0),
      next3: sumWhere(aWeekly, (_, i) => i < 3),
      playoffs: sumWhere(aWeekly, (w) => playoffWeeks.has(w)),
      restOfSeason: round1(a.net + (moveCost?.net ?? 0)),
      weighted: aWeighted,
      adjustments: [...a.adjustments, ...(moveCost?.adjustments ?? [])].map((x) => ({ label: x.label, points: x.points })),
    },
    them: { next3: sumWhere(bWeekly, (_, i) => i < 3), restOfSeason: round1(b.net), weighted: bWeighted },
    need: need?.label ?? null,
    why,
    status: status.status,
    statusReason: status.reason,
    balance: { give: giveValue, get: getValue, label: balanceLabel },
    confidence: evaluation.confidence,
    reasons: dedupe(reasons),
    caveats: dedupe(caveats),
    pitch: pitchFor({ partner: team.label, need: need?.label ?? null, give: give.map((p) => p.name), get: get.map((p) => p.name) }),
    costsNow: round1(aWeekly[0] ?? 0) < 0 || sumWhere(aWeekly, (_, i) => i < 3) < 0,
    needShort: need ? shortNeed(need.label) : null,
    statusShort: status.short,
    whyShort: whyFragments(a, b, input.horizon.weeks.length, need?.label ?? null),
    basis: basisOf([...candidate.give.map((id) => input.me.roster.find((p) => p.playerId === id)!), ...incoming]),
    ...(followUp.length > 0 ? { followUp } : {}),
  };
  return { pkg };
}

/**
 * Slots that, in some week, no player on the roster after the trade can fill
 * (on a bye, out, or simply none at the position), where the roster before the
 * trade could. Counted as a matching of available players to slots, so a flex
 * is filled by whoever is left. A flex hole is named by the position whose
 * free agents are best.
 */
export function followUpAdds(
  before: readonly PlayerRate[],
  after: readonly PlayerRate[],
  slots: readonly LineupSlotSpec[],
  horizon: TradeHorizon,
  replacement: ReplacementLevels,
): FollowUpAdd[] {
  const byPosition = new Map<string, number[]>();
  horizon.weeks.forEach((week, i) => {
    const was = unfilled(before, slots, i);
    const now = unfilled(after, slots, i);
    for (const key of was) {
      const at = now.indexOf(key);
      if (at >= 0) now.splice(at, 1);
    }
    for (const key of now) {
      const slot = slots.find((s) => s.key === key)!;
      const position =
        slot.eligible.size === 1
          ? [...slot.eligible][0]!
          : ([...slot.eligible].sort((x, y) => (replacement.get(y)?.rate ?? -1) - (replacement.get(x)?.rate ?? -1))[0] ?? key);
      const weeks = byPosition.get(position) ?? [];
      if (!weeks.includes(week)) weeks.push(week);
      byPosition.set(position, weeks);
    }
  });
  return [...byPosition].map(([position, weeks]) => {
    const level = replacement.get(position);
    return { position, weeks, assumes: level ? { rate: level.rate, names: level.names } : null };
  });
}

/** The keys of the slots nobody available in week `index` can fill, after the best assignment. */
function unfilled(players: readonly PlayerRate[], slots: readonly LineupSlotSpec[], index: number): string[] {
  const available = players.filter((p) => (p.weekly[index] ?? 0) > 0);
  const holder: (number | null)[] = slots.map(() => null);
  const place = (pi: number, seen: Set<number>): boolean => {
    for (let si = 0; si < slots.length; si++) {
      if (seen.has(si) || !slots[si]!.eligible.has(available[pi]!.position)) continue;
      seen.add(si);
      if (holder[si] == null || place(holder[si]!, seen)) {
        holder[si] = pi;
        return true;
      }
    }
    return false;
  };
  available.forEach((_, pi) => place(pi, new Set()));
  return slots.filter((_, si) => holder[si] == null).map((s) => s.key);
}

/**
 * Likely, Maybe or Long shot, from roster facts alone.
 *
 * Likely: about even on value or tilted their way, and it fills a need they
 * have. Maybe: tilted Alex's way but inside the band, or even with no named
 * need. Long shot: Alex gets clearly more. A package that helps them only a
 * little next to what it does for Alex drops one level.
 */
export function statusOf(args: { edge: number; need: boolean; alex: number; them: number }): { status: PackageStatus; reason: string; short: string } {
  let status: PackageStatus = args.edge <= BUILDER.band.even ? 'likely' : args.edge <= BUILDER.band.maybe ? 'maybe' : 'long_shot';
  if (status === 'likely' && !args.need) status = 'maybe';
  if (status !== 'long_shot' && args.them < args.alex * 0.25) status = status === 'likely' ? 'maybe' : 'long_shot';
  const reason =
    status === 'likely'
      ? args.edge < -BUILDER.band.even
        ? 'You give more value, and it fills a need they have.'
        : 'About even on value, and it fills a need they have.'
      : status === 'maybe'
        ? args.edge > BUILDER.band.even
          ? 'Tilted your way on value, but it helps their lineup too.'
          : args.them < args.alex * 0.25
            ? 'Fair on value, but it helps them much less than it helps you.'
            : args.edge < -BUILDER.band.even
              ? 'You give more value, though it fills no clear need of theirs.'
              : 'About even on value, though it fills no clear need of theirs.'
        : args.edge > BUILDER.band.maybe
          ? 'You get clearly more value, so they would have to really want it.'
          : 'It helps them only a little next to what it does for you.';
  const short =
    status === 'likely'
      ? args.edge < -BUILDER.band.even
        ? 'You give more · fills their need'
        : 'Even value · fills their need'
      : status === 'maybe'
        ? args.edge > BUILDER.band.even
          ? 'Tilts your way'
          : args.them < args.alex * 0.25
            ? 'Helps them less'
            : 'No clear need of theirs'
        : args.edge > BUILDER.band.maybe
          ? 'You get much more'
          : 'Small gain for them';
  return { status, reason, short };
}

/** `their RB2 is Out` -> `RB2 Out`; `their TE is on bye in week 8` -> `TE bye wk 8`; `thin at WR` -> `Thin at WR`. */
export function shortNeed(label: string): string {
  const bye = /^their (\S+) is on bye in week (\d+)$/.exec(label);
  if (bye) return `${bye[1]} bye wk ${bye[2]}`;
  const hurt = /^their (\S+) is (.+?)(?: in week (\d+))?$/.exec(label);
  if (hurt) return `${hurt[1]} ${hurt[2]}${hurt[3] ? ` wk ${hurt[3]}` : ''}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** `Jaylen Waddle` -> `Waddle`; a defence or one-word name stays whole. */
function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const suffix = /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(parts[parts.length - 1]!) ? parts.length - 2 : parts.length - 1;
  return parts[Math.max(1, suffix)]!;
}

/** At most two fragments: who starts for Alex, and what it does for them. */
function whyFragments(a: SideResult, b: SideResult, weeks: number, need: string | null): string[] {
  const out: string[] = [];
  const mine = [...a.incoming].sort((x, y) => y.startsWeeks - x.startsWeeks)[0];
  if (mine && mine.startsWeeks > 0) out.push(`${lastName(mine.name)} starts ${mine.startsWeeks} of ${weeks} wks for you`);
  const theirs = [...b.incoming].sort((x, y) => y.startsWeeks - x.startsWeeks)[0];
  if (theirs && theirs.startsWeeks > 0) out.push(`${lastName(theirs.name)} starts ${theirs.startsWeeks} of ${weeks} wks for them`);
  else if (need) out.push(`Covers ${shortNeed(need)}`);
  return out.slice(0, 2);
}

/* --------------------------------------------------------- roster limits -- */

interface Room {
  drops: PlayerRate[];
  ir: PlayerRate[];
  reasons: Map<string, string>;
}

/**
 * The players Alex has to move to fit what arrives, or null when nobody can
 * safely go.
 *
 * Counted on the active roster: a player in an IR slot holds no bench spot.
 * IR first (an IR-eligible player moved to an open slot frees a spot and costs
 * nobody), then drops in the waiver planner's order.
 */
function rosterRoom(candidate: Candidate, input: BuilderInput, slots: readonly LineupSlotSpec[]): Room | null {
  const reasons = new Map<string, string>();
  const reserve = new Set(input.me.reserveIds);
  const active = input.me.roster.filter((p) => !reserve.has(p.playerId));
  const activeLimit = Math.max(0, input.rosterLimit - input.reserveSlots);
  const after = active.length - candidate.give.filter((id) => !reserve.has(id)).length + candidate.get.length;
  let over = after - Math.max(activeLimit, active.length);
  if (over <= 0) return { drops: [], ir: [], reasons };

  const ir: PlayerRate[] = [];
  let openIr = Math.max(0, input.reserveSlots - input.me.reserveIds.length);
  const allows = input.reserveAllows;
  const eligible = (p: PlayerRate) =>
    p.designation === 'ir' ||
    (allows != null && ((p.designation === 'out' && allows.out) || (p.designation === 'doubtful' && allows.doubtful) || (p.designation === 'suspended' && allows.sus)));
  for (const p of active) {
    if (over <= 0 || openIr <= 0) break;
    if (candidate.give.includes(p.playerId) || !eligible(p)) continue;
    ir.push(p);
    openIr -= 1;
    over -= 1;
  }
  if (over <= 0) return { drops: [], ir, reasons };

  /* The coming-week lineup, on the app's own numbers (a player out this week is not in it). */
  const kept = active.filter((p) => !candidate.give.includes(p.playerId) && !ir.includes(p));
  const lineup = comingWeekLineup(kept, slots);
  const theirs = new Map(candidate.team.roster.map((p) => [p.playerId, p] as const));
  const best = Math.max(0, ...candidate.get.map((id) => overReplacement(theirs.get(id)!, input.replacement)));
  const signals = input.dropSignals ?? null;

  const cuttable = kept.filter((p) => {
    if (p.rate == null || tradeExcluded(p.position) || p.position === 'K') return false;
    if (input.protections.has(p.playerId)) return false;
    const signal = signals?.get(p.playerId);
    if (lineup.has(p.playerId) && !(signal && isDeadSpot({ ...signal, inLineup: true }))) return false;
    /* Never cut a better player than the best one arriving. */
    return overReplacement(p, input.replacement) < best;
  });

  let ordered: PlayerRate[];
  if (signals && signals.size > 0) {
    const readings = readDrops(cuttable.map((p) => signals.get(p.playerId)).filter((s): s is DropSignals => s != null).map((s) => ({ ...s, inLineup: lineup.has(s.playerId) })));
    for (const [id, r] of readings) reasons.set(id, r.reason);
    ordered = [...cuttable].sort(
      (x, y) => (readings.get(x.playerId)?.score ?? 99) - (readings.get(y.playerId)?.score ?? 99) || x.name.localeCompare(y.name),
    );
  } else {
    ordered = [...cuttable].sort((x, y) => overReplacement(x, input.replacement) - overReplacement(y, input.replacement) || x.name.localeCompare(y.name));
    for (const p of ordered) reasons.set(p.playerId, 'the least you would miss over the rest of the season');
  }
  if (ordered.length < over) return null;
  return { drops: ordered.slice(0, over), ir, reasons };
}

/** Alex's side of removing these players, from Check a trade's evaluation against an empty partner. */
function costOfRemoving(removed: readonly PlayerRate[], input: BuilderInput, cache: Map<string, SideResult | null>): SideResult | null {
  const cacheKey = removed.map((p) => p.playerId).sort().join('+');
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const evaluation: TradeEvaluation = evaluateTrade({
    horizon: input.horizon,
    shape: input.shape,
    replacement: input.replacement,
    a: { label: input.me.label, rosterId: input.me.rosterId, isMine: true, roster: input.me.roster, starterIds: input.me.starterIds },
    b: { label: 'waivers', rosterId: null, isMine: false, roster: [] },
    rosterLimit: input.rosterLimit + removed.length,
    aSends: removed.map((p) => p.playerId),
    bSends: [],
  });
  const out = evaluation.status === 'ok' ? evaluation.a : null;
  cache.set(cacheKey, out);
  return out;
}

function comingWeekLineup(players: readonly PlayerRate[], slots: readonly LineupSlotSpec[]): Set<string> {
  const picks = bestLineup(
    slots,
    players
      .filter((p) => p.rate != null && !isOutNow(p.designation) && !p.onReserve)
      .map((p) => ({ id: p.playerId, position: p.position, value: p.rate ?? 0 })),
  ).picks;
  return new Set(picks.filter((p): p is LineupCandidate => p != null).map((p) => p.id));
}

function overReplacement(p: PlayerRate, replacement: ReplacementLevels): number {
  if (p.rate == null) return 0;
  return p.games * Math.max(0, p.rate - (replacement.get(p.position)?.rate ?? 0));
}

/* ------------------------------------------------------------ their needs -- */

/**
 * What this team is short of, strongest first, in plain words.
 *
 * Read off their own best lineup for the next three weeks against their healthy
 * one: a starter out (`their RB2 is Out`), a starter on a bye (`their TE is on
 * bye in week 8`), or a position a free agent would start at, or nearly
 * (`thin at WR`).
 */
export function needsOf(team: BuilderTeam, slots: readonly LineupSlotSpec[], replacement: ReplacementLevels, horizon: TradeHorizon): Need[] {
  const priced = team.roster.filter((p) => p.rate != null && !tradeExcluded(p.position));
  const healthy = bestLineup(slots, [...priced.map((p) => ({ id: p.playerId, position: p.position, value: p.rate ?? 0 })), ...fills(slots, replacement)]);
  const starters = healthy.picks.filter((p): p is LineupCandidate => p != null && !p.id.startsWith('replacement:'));
  const byId = new Map(priced.map((p) => [p.playerId, p] as const));
  const rankOf = (p: PlayerRate): string => {
    const same = starters.map((s) => byId.get(s.id)!).filter((q) => q.position === p.position).sort((x, y) => (y.rate ?? 0) - (x.rate ?? 0));
    const dedicated = slots.filter((s) => s.eligible.size === 1 && s.eligible.has(p.position)).length;
    if (dedicated <= 1 && same.length <= 1) return p.position;
    return `${p.position}${same.indexOf(p) + 1}`;
  };

  const out: Need[] = [];
  const seen = new Set<string>();
  for (const s of starters) {
    const p = byId.get(s.id)!;
    for (let k = 0; k < Math.min(3, horizon.weeks.length); k++) {
      const playing = p.weekly[k] ?? 1;
      if (playing >= 0.5) continue;
      const week = horizon.weeks[k]!;
      const lost = (p.rate ?? 0) * (1 - playing) - (replacement.get(p.position)?.rate ?? 0) * (1 - playing);
      const label =
        p.byeWeek === week
          ? `their ${rankOf(p)} is on bye in week ${week}`
          : `their ${rankOf(p)} is ${WORD[p.designation] ?? 'out'}${k === 0 ? '' : ` in week ${week}`}`;
      if (!seen.has(p.playerId)) out.push({ position: p.position, label, severity: Math.max(0.1, lost) + (3 - k) * 0.01 });
      seen.add(p.playerId);
      break;
    }
  }
  /* Thin: a slot a free agent fills, or a starter barely above one. */
  for (const [i, pick] of healthy.picks.entries()) {
    const slot = slots[i]!;
    const position = pick?.position ?? [...slot.eligible][0] ?? '';
    if (tradeExcluded(position)) continue;
    const level = replacement.get(position)?.rate ?? 0;
    const thin = pick == null || pick.id.startsWith('replacement:') || pick.value - level < BUILDER.thinMargin;
    const name = slot.eligible.size > 1 ? 'FLEX' : position;
    if (thin && !out.some((n) => n.label === `thin at ${name}`)) {
      out.push({ position: name, label: name === 'FLEX' ? 'thin at flex' : `thin at ${name}`, severity: Math.max(0.05, level + BUILDER.thinMargin - (pick?.value ?? 0)) * 0.5 });
    }
  }
  return out.sort((x, y) => y.severity - x.severity || x.label.localeCompare(y.label));
}

/* ------------------------------------------------------------- the shapes -- */

/** Every package the two lists allow: 1 for 1, 2 for 1, 1 for 2, and 2 for 2 when both lists are short. */
export function shapes(give: readonly string[], get: readonly string[]): { give: string[]; get: string[] }[] {
  const out: { give: string[]; get: string[] }[] = [];
  const pairs = (list: readonly string[]) => list.flatMap((x, i) => list.slice(i + 1).map((y) => [x, y]));
  for (const g of give) for (const w of get) out.push({ give: [g], get: [w] });
  for (const gg of pairs(give)) for (const w of get) out.push({ give: gg, get: [w] });
  for (const g of give) for (const ww of pairs(get)) out.push({ give: [g], get: ww });
  if (give.length <= BUILDER.twoForTwoMax && get.length <= BUILDER.twoForTwoMax) {
    for (const gg of pairs(give)) for (const ww of pairs(get)) out.push({ give: gg, get: ww });
  }
  return out;
}

/**
 * The players Alex can offer: his Sell marks, and when he asks, his most spare
 * other players (the ones whose loss costs his lineup least). Never an elite
 * back he did not mark, never a defence or kicker, never a player with no
 * number this week.
 */
export function givePoolOf(input: BuilderInput, slots: readonly LineupSlotSpec[]): string[] {
  const mine = new Map(input.me.roster.map((p) => [p.playerId, p] as const));
  const give = input.sell.filter((id) => mine.has(id) && tradeable(mine.get(id)!));
  if (!input.considerUnmarked) return give;
  const base = quickValue(slots, input.replacement, input.me.roster, input.horizon);
  const extra = input.me.roster
    .filter((p) => tradeable(p) && !give.includes(p.playerId) && !input.eliteRbs.has(p.playerId) && !(input.handcuffs?.has(p.playerId) ?? false))
    .map((p) => ({
      id: p.playerId,
      loss: base - quickValue(slots, input.replacement, input.me.roster.filter((q) => q.playerId !== p.playerId), input.horizon),
    }))
    .sort((a, b) => a.loss - b.loss || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, BUILDER.givePool - give.length))
    .map((x) => x.id);
  return [...give, ...extra];
}

function tradeable(p: PlayerRate): boolean {
  return p.rate != null && !tradeExcluded(p.position) && p.position !== 'K';
}

/* ---------------------------------------------------------------- reading -- */

function weekWeights(horizon: TradeHorizon): number[] {
  const playoff = new Set(horizon.playoffWeeks);
  return horizon.weeks.map((week, i) =>
    i === 0 ? BUILDER.weights.first : i <= 2 ? BUILDER.weights.nextTwo : playoff.has(week) ? BUILDER.weights.playoff : BUILDER.weights.regular,
  );
}

function weeklyDelta(side: SideResult): number[] {
  return (side.weekly ?? []).map((w) => w.lineupAfter - w.lineupBefore + (w.depthAfter - w.depthBefore));
}

function sumWeighted(deltas: readonly number[], weights: readonly number[]): number {
  return deltas.reduce((s, d, i) => s + d * (weights[i] ?? 1), 0);
}

/** One package per set of players received: the same target with a different filler is one idea. */
function distinctGets(list: readonly BuiltPackage[]): BuiltPackage[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = p.get.map((x) => x.playerId).sort().join('+');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * One representative week, for ordering only: each player at his rate times
 * his availability averaged with the ranking's own week weights, so a back who
 * is Out this week and back next week counts as mostly there, the way the full
 * evaluation will count him.
 */
function quickValue(slots: readonly LineupSlotSpec[], replacement: ReplacementLevels, players: readonly PlayerRate[], horizon: TradeHorizon): number {
  const weights = weekWeights(horizon);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return bestLineup(slots, [
    ...players
      .filter((p) => p.rate != null)
      .map((p) => ({ id: p.playerId, position: p.position, value: ((p.rate ?? 0) * weights.reduce((s, w, k) => s + w * (p.weekly[k] ?? 1), 0)) / total })),
    ...fills(slots, replacement),
  ]).total;
}

function fills(slots: readonly LineupSlotSpec[], replacement: ReplacementLevels): LineupCandidate[] {
  const out: LineupCandidate[] = [];
  for (const [position, level] of replacement) {
    const count = slots.filter((s) => s.eligible.has(position)).length;
    for (let i = 0; i < count; i++) out.push({ id: `replacement:${position}:${i}`, position, value: level.rate });
  }
  return out;
}

export function deadlineOf(horizon: TradeHorizon): { week: number | null; passed: boolean; weeksLeft: number | null; line: string | null } {
  const week = horizon.deadlineWeek;
  if (week == null) return { week: null, passed: false, weeksLeft: null, line: null };
  if (horizon.deadlinePassed) return { week, passed: true, weeksLeft: 0, line: `The trade deadline was after week ${week}, so trades are closed for this season.` };
  const left = horizon.weeksToDeadline ?? 0;
  const line =
    left <= 1
      ? `Last week to trade: the deadline is after week ${week}.`
      : left <= BUILDER.nearDeadline
        ? `The trade deadline is after week ${week}, ${left} weeks from now.`
        : `Trades close after week ${week}.`;
  return { week, passed: false, weeksLeft: left, line };
}

function playerLine(p: PlayerRate): PackagePlayer {
  const bits = [p.position, p.rate == null ? 'no number yet' : `${p.rate.toFixed(1)} a game`];
  if (p.designation !== 'healthy' && p.designation !== 'unknown') bits.push(WORD[p.designation] ?? p.designation);
  return { playerId: p.playerId, name: p.name, position: p.position, team: p.team, stat: bits.join(' · ') };
}

/**
 * A short, friendly opener Alex can paste into Sleeper chat or a DM.
 *
 * Written in his voice, about their roster, and it asks rather than tells. It
 * never mentions this app: the message is his, and he sends it or not.
 */
export function pitchFor(args: { partner: string; need: string | null; give: readonly string[]; get: readonly string[] }): string {
  const first = args.partner.split(/[\s_]+/)[0] ?? args.partner;
  const hook = args.need
    ? args.need.startsWith('thin at')
      ? `Looks like you're ${args.need}.`
      : `Saw ${args.need.replace(/^their /, 'your ')}.`
    : 'Had an idea that could help your lineup.';
  return `Hey ${first}, ${hook.charAt(0).toLowerCase()}${hook.slice(1)} I could send ${listNames(args.give)} for ${listNames(args.get)}. Open to it?`;
}

/** `sleeper` when most of the moved players are valued on Sleeper's projection rather than a complete Vegas week. */
function basisOf(players: readonly PlayerRate[]): 'vegas' | 'sleeper' {
  const sleeper = players.filter((p) => p.basis === 'published' || p.basis === 'recent_week').length;
  return sleeper * 2 > players.length ? 'sleeper' : 'vegas';
}

function key(c: { give: readonly string[]; get: readonly string[] }): string {
  return `${[...c.give].sort().join('+')}>${[...c.get].sort().join('+')}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dedupe(list: readonly string[]): string[] {
  return [...new Set(list)];
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
