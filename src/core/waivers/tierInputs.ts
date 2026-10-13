/**
 * The tier planner's inputs, from what the Waivers screen already holds.
 *
 * No new scorer. Every player's points a game is the trade-value rate
 * (`tradeValue/rate.ts`), which is the Start/Sit decision number with the
 * injury charge taken out and the injury counted as missing weeks instead.
 * Byes come from the fixture list the defence planner already reads, and the
 * replacement level from the scanned free agents, both exactly as Check a
 * trade does it.
 *
 * ## Which weeks count
 *
 * "Next week" is the first week a move made now can still change. While this
 * week's main slate has not kicked off (the median kickoff of the players in
 * hand is still ahead), that is this week, and a free agent counts in it only
 * if he can be added before his own game. After that it is next week. The two
 * weeks after it are counted too, at half weight, which is where byes show up.
 */

import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from '../startsit/engine.ts';
import { buildPlayerRate, type PlayerRate } from '../tradeValue/rate.ts';
import { replacementLevels } from '../tradeValue/evaluate.ts';
import { byeOf, LAST_NFL_WEEK } from '../tradeValue/weeks.ts';
import { bestLineup, slotsOf } from '../tradeValue/lineup.ts';
import { findHandcuffs } from './yardstick.ts';
import { dropSignal } from './signals.ts';
import { TIER_RULES, type TierCandidate, type TierPlayer, type TierProtection, type TierRequest } from './tiers.ts';
import type { PickupState } from './clearWindow.ts';
import type { ScheduleTeamWeek } from '../nfl/schedule.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { weekNumbers, type AheadNumbers } from './aheadWeeks.ts';
import { eliteBacks, eliteHandcuffs, type DropSignals } from './dropScore.ts';
import { stashVerdict, type InjuryNote, type StashVerdict } from './stash.ts';

export interface TierWindow {
  /** The window's weeks. */
  weeks: number[];
  /** True when this week is still in play and so is the window's first week. */
  thisWeekOpen: boolean;
  /** From the current week to the window's last, for availability. */
  span: number[];
}

export function tierWindow(week: number, kickoffs: readonly (string | null | undefined)[], now: Date): TierWindow {
  const times = kickoffs
    .map((k) => (k ? Date.parse(k) : Number.NaN))
    .filter((t) => Number.isFinite(t) && Math.abs(t - now.getTime()) < 8 * 86_400_000)
    .sort((a, b) => a - b);
  const median = times.length > 0 ? times[Math.floor(times.length / 2)]! : null;
  const thisWeekOpen = median == null || now.getTime() < median;
  const first = thisWeekOpen ? week : week + 1;
  const weeks = Array.from({ length: TIER_RULES.weights.length }, (_, i) => first + i).filter((w) => w <= LAST_NFL_WEEK);
  const span: number[] = [];
  for (let w = week; w <= (weeks[weeks.length - 1] ?? week); w++) span.push(w);
  return { weeks, thisWeekOpen, span };
}

export interface TierInputRequest {
  shape: RosterShape;
  profile: ScoringProfile;
  week: number;
  now: Date;
  rosterInputs: readonly StartSitInput[];
  candidateInputs: readonly StartSitInput[];
  rosteredIds: ReadonlySet<string>;
  reserveIds: readonly string[];
  published?: ReadonlyMap<string, number> | undefined;
  /** Each needy player's latest earlier week of Sleeper's projection. */
  recentPublished?: ReadonlyMap<string, { week: number; points: number }> | undefined;
  /** Fixtures for the clubs involved, over the window. */
  fixtures: readonly ScheduleTeamWeek[];
  pickup: Readonly<Record<string, PickupState>>;
  /** The market hold: rostered players with their short reason. */
  held: ReadonlyMap<string, string>;
  depth?: ReadonlyMap<string, { rank: number }> | undefined;
  trendingDrops?: ReadonlyMap<string, { heat: number; rank: number | null }> | undefined;
  /** Injured-reserve slots the league allows. */
  reserveSlots: number;
  excludedPositions: ReadonlySet<string>;
  /** Later weeks' own numbers (Vegas, then Sleeper). Absent: this week's figure for every week, as before. */
  ahead?: AheadNumbers | null | undefined;
  /**
   * Round 2: what each player has scored this season in this league's scoring,
   * week by week (`sleeper.seasonPoints`). With it the drop score, the elite
   * backs and their handcuffs are read. Absent: the drop is the lineup's
   * cheapest, and any backup to a starter is a handcuff, as before.
   */
  seasonPoints?: ReadonlyMap<string, readonly number[]> | null | undefined;
  /** Weeks the season points cover (1 to this). */
  seasonPointsThrough?: number | undefined;
  /** Positions, for "is he a running back" across the league. */
  positionOf?: ((playerId: string) => string | null) | undefined;
  /** Players on this roster added by transaction, with the week. Absent from it and drafted: held since the draft. */
  heldSince?: ReadonlyMap<string, { week: number; how: string }> | undefined;
  draftedIds?: ReadonlySet<string> | undefined;
  /** Alex's current Sleeper starting lineup. */
  currentStarterIds?: readonly string[] | undefined;
  /** Sleeper's injury body part and note per player (`sleeper.playerNotes`). */
  injuryNotes?: ReadonlyMap<string, InjuryNote> | undefined;
  /** Sleeper's own depth-chart order per player, preferred over the stored chart for handcuffs. */
  depthOrder?: ReadonlyMap<string, number> | undefined;
}

export interface TierInputs {
  request: TierRequest;
  window: TierWindow;
  rates: Map<string, PlayerRate>;
  evaluations: Map<string, StartSitEvaluation>;
}

/** The window's week weights, as the request below sets them. */
const windowWeights = (open: boolean): readonly number[] => (open ? TIER_RULES.openWeights : TIER_RULES.weights);

export function buildTierInputs(input: TierInputRequest): TierInputs {
  const window = tierWindow(
    input.week,
    [...input.rosterInputs, ...input.candidateInputs].map((i) => i.kickoff ?? null),
    input.now,
  );
  const offset = window.thisWeekOpen ? 0 : 1;
  const range = { from: input.week, to: window.span[window.span.length - 1] ?? input.week };
  const reserved = new Set(input.reserveIds);

  const evaluations = new Map<string, StartSitEvaluation>();
  const rates = new Map<string, PlayerRate>();
  const rateOf = (i: StartSitInput): PlayerRate => {
    const evaluation = evaluatePlayer(i, input.profile);
    evaluations.set(i.player.id, evaluation);
    const team = (i.player.team ?? '').toUpperCase();
    const bye = team ? byeOf(input.fixtures, team, range) : { known: false, byeWeek: null };
    const rate = buildPlayerRate({
      evaluation,
      ...(input.published ? { published: input.published } : {}),
      seasonLine: null,
      recentWeek: input.recentPublished?.get(i.player.id) ?? null,
      weeks: window.span,
      byeWeek: bye.byeWeek,
      byeKnown: bye.known,
      onReserve: reserved.has(i.player.id),
    });
    rates.set(i.player.id, rate);
    return rate;
  };

  const toTier = (rate: PlayerRate): TierPlayer => {
    const numbers = weekNumbers({
      playerId: rate.playerId,
      rate: rate.rate,
      weeks: window.weeks,
      currentWeek: input.week,
      ahead: input.ahead,
    });
    return {
      playerId: rate.playerId,
      name: rate.name,
      position: rate.position,
      team: rate.team,
      rate: rate.rate,
      weekly: rate.weekly.slice(offset, offset + window.weeks.length),
      weekValues: numbers.map((n) => n.points),
      weekSources: numbers.map((n) => n.source),
      designation: rate.designation,
      byeWeek: rate.byeWeek,
      onReserve: rate.onReserve,
    };
  };

  const roster = input.rosterInputs.map((i) => toTier(rateOf(i)));
  const candidateRates = input.candidateInputs.filter((i) => !input.rosteredIds.has(i.player.id)).map((i) => ({ i, rate: rateOf(i) }));
  const candidates: TierCandidate[] = candidateRates.map(({ i, rate }) => {
    const tier = toTier(rate);
    /* This week counts for him only if he can be in the lineup before his own kickoff. */
    if (window.thisWeekOpen && tier.weekly.length > 0 && !addableBefore(i, input.pickup[i.player.id], input.now)) {
      tier.weekly = [0, ...tier.weekly.slice(1)];
    }
    const drop = dropSignal(input.trendingDrops?.get(i.player.id));
    return { ...tier, planExcluded: drop.planExcluded };
  });

  const replacement = new Map<string, number>();
  for (const [position, level] of replacementLevels(candidateRates.map((c) => c.rate))) replacement.set(position, level.rate);

  /*
   * Handcuffs. With this season's points: only the direct backup to an elite
   * back on this roster (`dropScore.ts`). Without them, as before: a backup to
   * any starter, read against the healthy lineup, since a starter on bye this
   * week is still the starter his backup insures.
   */
  const depth = new Map<string, { rank: number }>(input.depth ?? new Map());
  for (const [id, order] of input.depthOrder ?? new Map<string, number>()) depth.set(id, { rank: order });
  const season = input.seasonPoints ?? null;
  let handcuffs: Map<string, { playerId: string; name: string }>;
  if (season) {
    const totals = new Map<string, { total: number; games: number }>();
    for (const [id, weeks] of season) totals.set(id, { total: weeks.reduce((a, b) => a + b, 0), games: weeks.filter((x) => x !== 0).length });
    const elite = eliteBacks(totals, (id) => (input.positionOf?.(id) ?? '') === 'RB');
    handcuffs = eliteHandcuffs({
      roster: roster.map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, team: p.team, rate: p.rate })),
      elite,
      depth,
    });
  } else {
    const healthy = bestLineup(
      slotsOf(input.shape),
      roster.filter((p) => p.rate != null).map((p) => ({ id: p.playerId, position: p.position, value: p.rate ?? 0 })),
    );
    const starterIds = new Set(healthy.picks.filter((p) => p != null).map((p) => p!.id));
    handcuffs = findHandcuffs({
      roster: input.rosterInputs.map((i) => ({ playerId: i.player.id, name: i.player.fullName, position: i.player.position, team: i.player.team })),
      starterIds,
      depth,
    });
  }
  const protections = new Map<string, TierProtection>();
  for (const [id, starter] of handcuffs) protections.set(id, { kind: 'handcuff', note: `backs up ${starter.name}` });
  for (const [id, note] of input.held) if (!protections.has(id)) protections.set(id, { kind: 'market_hold', note });

  /* The drop score's inputs, when this season's points are on record. */
  const dropSignals = new Map<string, DropSignals>();
  if (season) {
    const through = input.seasonPointsThrough ?? Math.max(0, ...[...season.values()].map((w) => w.length));
    const lineup = new Set(input.currentStarterIds ?? []);
    for (const p of roster) {
      if (p.rate == null) continue;
      const weeks = season.get(p.playerId) ?? [];
      const recent = [through, through - 1, through - 2].filter((w) => w >= 1).map((w) => weeks[w - 1] ?? 0);
      const ws = windowWeights(window.thisWeekOpen);
      const projection =
        ws.reduce((sum, w, k) => sum + w * (p.weekValues?.[k] ?? p.rate ?? 0) * (p.weekly[k] ?? 1), 0) / Math.max(1e-9, ws.reduce((a, b) => a + b, 0));
      const trend = rates.get(p.playerId) ? evaluations.get(p.playerId)?.role.trend : null;
      const held = input.heldSince?.get(p.playerId) ?? null;
      dropSignals.set(p.playerId, {
        playerId: p.playerId,
        name: p.name,
        position: p.position,
        seasonPoints: Math.round(weeks.reduce((a, b) => a + b, 0) * 10) / 10,
        weeksPlayed: through,
        recent,
        projection: Math.round(projection * 100) / 100,
        role: trend?.startsWith('rising') ? 'rising' : trend?.startsWith('falling') ? 'falling' : trend === 'stable' ? 'stable' : null,
        heldWeeks: held ? Math.max(0, input.week - held.week) : null,
        drafted: held == null && (input.draftedIds?.has(p.playerId) ?? false),
        handcuffOf: handcuffs.get(p.playerId)?.name ?? null,
        inLineup: lineup.has(p.playerId),
        unavailable: ['out', 'ir', 'pup', 'suspended'].includes(p.designation),
      });
    }
  }

  /* The stash verdict for each injured free agent, from Sleeper's injury note. */
  const stash = new Map<string, StashVerdict>();
  if (input.injuryNotes) {
    for (const c of candidates) {
      if (!['out', 'ir', 'pup'].includes(c.designation)) continue;
      stash.set(c.playerId, stashVerdict({ designation: c.designation, note: input.injuryNotes.get(c.playerId) ?? null, week: input.week }));
    }
  }

  const benchRoom = input.shape.totalStarters + input.shape.benchSlots;
  const openSpots = Math.max(0, benchRoom - input.rosterInputs.filter((i) => !reserved.has(i.player.id)).length);
  const openReserve = Math.max(0, input.reserveSlots - input.reserveIds.length);

  return {
    request: {
      shape: input.shape,
      weeks: window.weeks,
      weights: window.thisWeekOpen ? TIER_RULES.openWeights : TIER_RULES.weights,
      leadWeeks: window.thisWeekOpen ? 2 : 1,
      roster,
      candidates,
      openSpots,
      openReserve,
      protections,
      excludedPositions: input.excludedPositions,
      replacement,
      ...(dropSignals.size > 0 ? { dropSignals } : {}),
      ...(input.injuryNotes ? { stash } : {}),
    },
    window,
    rates,
    evaluations,
  };
}

/** Whether a free agent can be added before his own game this week. */
function addableBefore(input: StartSitInput, pickup: PickupState | undefined, now: Date): boolean {
  const kickoff = input.kickoff ? Date.parse(input.kickoff) : Number.NaN;
  if (!Number.isFinite(kickoff)) return true;
  if (kickoff <= now.getTime()) return false;
  if (!pickup || pickup.state === 'free') return true;
  const until = pickup.until ? Date.parse(pickup.until) : Number.NaN;
  return Number.isFinite(until) && until < kickoff;
}
