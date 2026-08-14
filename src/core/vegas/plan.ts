/**
 * What to fetch, in what order, and what it will cost.
 *
 * The old refresh listed every upcoming NFL game and fetched props for all of
 * them. That is the wrong shape twice over: it spends the month's allowance on
 * games nobody on the roster is playing in, and it does it on a timer, so
 * nobody has to make a mistake for it to happen.
 *
 * A plan is built the other way round. Start from the players whose week is
 * still undecided, find the games they are in, and fetch those — in priority
 * order, with a cost attached, so the budget can take the first N and drop the
 * rest without the caller having to understand any of it.
 *
 * Costs are in entities, the unit the provider actually bills: one per event
 * returned, whatever the payload. A roster spanning eight games costs eight.
 *
 * Nothing here calls a provider or reads a database. It is arithmetic over
 * what the caller already knows, which is what makes it testable.
 */

import type { FetchPriority } from './budget.ts';

/** A rostered player, as much as the planner needs to know about them. */
export interface PlannedPlayer {
  playerId: string;
  position: string;
  /** The provider event their game is, when it is known. */
  eventId: string | null;
  /** ISO kickoff. Null when the schedule has not been discovered yet. */
  kickoff: string | null;
  /** In the lineup this week, as opposed to on the bench. */
  starter: boolean;
  /** Sleeper's injury status, verbatim, e.g. `Questionable`. */
  status: string | null;
  /**
   * True when this player is one side of a start/sit call the app rates as
   * close. A close call is the only thing a fresh line can actually change.
   */
  contested: boolean;
  /** Minutes since this player's lines were last fetched; null if never. */
  ageMinutes: number | null;
}

export interface PlanOptions {
  now: number;
  /** Minutes after which a line is old enough to be worth re-fetching. */
  staleAfterMinutes?: number;
  /** Inside this many hours of kickoff, a close decision becomes critical. */
  nearKickoffHours?: number;
  /** Never plan more events than this in one pass, whatever the roster spans. */
  maxEvents?: number;
}

export const PLAN_DEFAULTS = {
  staleAfterMinutes: 360,
  nearKickoffHours: 6,
  /*
   * Wider than any single roster spans (a 16-game Sunday, and a roster cannot
   * touch more than about ten of those). It is a backstop against a bad map,
   * not a policy — the roster is what does the narrowing.
   */
  maxEvents: 12,
} as const;

export interface PlannedEvent {
  eventId: string;
  kickoff: string | null;
  /** Roster players in this game — the reason it is worth fetching. */
  playerIds: string[];
  priority: FetchPriority;
  /** 0..1, for ordering within a priority band. */
  score: number;
  /** Entities this event will cost. One, on this provider. */
  cost: number;
  /** Why it is in the plan, in the words the diagnostics print. */
  reason: string;
}

export interface FetchPlan {
  events: PlannedEvent[];
  /** Entities the whole plan would spend. */
  estimatedEntities: number;
  /** Players the plan deliberately leaves alone, and why. */
  skipped: { playerId: string; reason: string }[];
}

/**
 * Build the plan.
 *
 * Two rules do most of the work. A game that has kicked off is never fetched
 * again — the lineup is locked, so the line cannot change a decision. And a
 * player whose lines are fresh is not re-fetched just because the clock said
 * so; staleness has to be real.
 */
export function buildFetchPlan(players: PlannedPlayer[], opts: PlanOptions): FetchPlan {
  const staleAfter = opts.staleAfterMinutes ?? PLAN_DEFAULTS.staleAfterMinutes;
  const nearKickoff = opts.nearKickoffHours ?? PLAN_DEFAULTS.nearKickoffHours;
  const maxEvents = opts.maxEvents ?? PLAN_DEFAULTS.maxEvents;

  const skipped: { playerId: string; reason: string }[] = [];
  const byEvent = new Map<string, { players: PlannedPlayer[]; kickoff: string | null }>();

  for (const player of players) {
    if (!player.eventId) {
      skipped.push({ playerId: player.playerId, reason: 'no game mapped for this player yet' });
      continue;
    }
    const hoursToKickoff = hoursUntil(player.kickoff, opts.now);
    if (hoursToKickoff != null && hoursToKickoff <= 0) {
      // Locked. The whole point of tracking kickoff is to stop paying for games
      // whose lineups can no longer be changed.
      skipped.push({ playerId: player.playerId, reason: 'game has started; nothing left to decide' });
      continue;
    }
    if (player.ageMinutes != null && player.ageMinutes < staleAfter && !isUrgent(player, hoursToKickoff, nearKickoff)) {
      skipped.push({
        playerId: player.playerId,
        reason: `lines are ${Math.round(player.ageMinutes)} min old, still fresh`,
      });
      continue;
    }

    const bucket = byEvent.get(player.eventId);
    if (bucket) bucket.players.push(player);
    else byEvent.set(player.eventId, { players: [player], kickoff: player.kickoff });
  }

  const events: PlannedEvent[] = [];
  for (const [eventId, bucket] of byEvent) {
    const hoursToKickoff = hoursUntil(bucket.kickoff, opts.now);
    const scored = bucket.players.map((p) => scorePlayer(p, hoursToKickoff, { staleAfter, nearKickoff }));
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    events.push({
      eventId,
      kickoff: bucket.kickoff,
      playerIds: bucket.players.map((p) => p.playerId),
      priority: best.priority,
      score: round3(best.score),
      // One request, one event, one entity. Deduplicated by construction: two
      // rostered players in the same game are one fetch, not two.
      cost: 1,
      reason: `${bucket.players.length} roster player${bucket.players.length === 1 ? '' : 's'} — ${best.reason}`,
    });
  }

  events.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.score - a.score);

  const kept = events.slice(0, maxEvents);
  for (const dropped of events.slice(maxEvents)) {
    for (const playerId of dropped.playerIds) {
      skipped.push({ playerId, reason: `beyond the ${maxEvents}-game cap for one pass` });
    }
  }

  return {
    events: kept,
    estimatedEntities: kept.reduce((sum, e) => sum + e.cost, 0),
    skipped,
  };
}

const PRIORITY_ORDER: Record<FetchPriority, number> = { critical: 0, normal: 1, low: 2 };

/**
 * How much a fresh line is worth for this player, and how badly it is wanted.
 *
 * The ranking is deliberately about the decision rather than the player: a
 * superstar whose start is not in doubt is worth nothing to re-price, and a
 * Questionable flex in a close call is worth everything.
 */
function scorePlayer(
  player: PlannedPlayer,
  hoursToKickoff: number | null,
  cfg: { staleAfter: number; nearKickoff: number },
): { score: number; priority: FetchPriority; reason: string } {
  const questionable = isQuestionable(player.status);
  const close = player.contested;
  const near = hoursToKickoff != null && hoursToKickoff <= cfg.nearKickoff;
  const never = player.ageMinutes == null;
  const stale = never || player.ageMinutes! >= cfg.staleAfter;

  let score = 0;
  const why: string[] = [];
  if (close) {
    score += 0.45;
    why.push('a close start/sit call');
  }
  if (questionable) {
    score += 0.25;
    why.push(`status ${player.status}`);
  }
  if (player.starter) {
    score += 0.1;
    why.push('in the lineup');
  }
  if (near) {
    score += 0.15;
    why.push('kickoff is close');
  }
  if (never) {
    score += 0.2;
    why.push('never fetched');
  } else if (stale) {
    score += 0.1;
    why.push('lines are stale');
  }

  /*
   * Only a decision that is both open and urgent gets to spend the reserve.
   * "Critical" has to stay rare or the reserve is not a reserve.
   */
  const priority: FetchPriority =
    (close || questionable) && (near || never)
      ? 'critical'
      : close || questionable || player.starter || never
        ? 'normal'
        : 'low';

  return {
    score: Math.min(1, score),
    priority,
    reason: why.length > 0 ? why.join(', ') : 'bench depth, no decision pending',
  };
}

function isUrgent(player: PlannedPlayer, hoursToKickoff: number | null, nearKickoff: number): boolean {
  const near = hoursToKickoff != null && hoursToKickoff <= nearKickoff;
  return near && (player.contested || isQuestionable(player.status));
}

/** Statuses that mean the player might not play, in the words Sleeper uses. */
const UNCERTAIN = new Set(['questionable', 'doubtful', 'out', 'ir', 'pup', 'sus']);

function isQuestionable(status: string | null): boolean {
  return status != null && UNCERTAIN.has(status.trim().toLowerCase());
}

function hoursUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (t - now) / 3_600_000;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ------------------------------------------------------------------ simulator

export interface SimulationInput {
  /** Games the roster spans in a normal week. */
  rosterGames: number;
  /** Refresh checkpoints in a week that actually fetch. */
  checkpointsPerWeek: number;
  /** Events refreshed at a near-kickoff pass, which is a subset. */
  nearKickoffEvents: number;
  /** Weeks in the month. 4.3 is the honest average; 5 is the safe one. */
  weeksPerMonth: number;
  /** Entities spent per season-market refresh, times how often it runs. */
  seasonEntitiesPerRun: number;
  seasonRunsPerMonth: number;
  /** Cost of discovering the week's schedule, once per week. */
  scheduleEntitiesPerWeek: number;
}

export interface Simulation {
  weekly: number;
  monthly: number;
  limit: number;
  /** What is left after the plan, in entities and as a share. */
  headroom: number;
  fraction: number;
  safe: boolean;
  lines: string[];
}

/**
 * What a month of this strategy costs, before any of it is run.
 *
 * Deliberately deterministic and deliberately pessimistic where it is unsure:
 * the point is a number that can be checked against the allowance in a test,
 * so that a schedule which does not fit fails in CI rather than in August.
 */
export function simulateMonth(input: SimulationInput, limit: number): Simulation {
  const weeklyProps = input.rosterGames * input.checkpointsPerWeek + input.nearKickoffEvents;
  const weekly = weeklyProps + input.scheduleEntitiesPerWeek;
  const season = input.seasonEntitiesPerRun * input.seasonRunsPerMonth;
  const monthly = Math.ceil(weekly * input.weeksPerMonth + season);

  const lines = [
    `roster games: ${input.rosterGames}`,
    `scheduled refreshes: ${input.checkpointsPerWeek}/week -> ${input.rosterGames * input.checkpointsPerWeek} entities`,
    `near-kickoff top-ups: ${input.nearKickoffEvents} entities`,
    `weekly schedule discovery: ${input.scheduleEntitiesPerWeek} entities`,
    `week: ${weekly} entities`,
    `season markets: ${input.seasonEntitiesPerRun} x ${input.seasonRunsPerMonth} = ${season} entities`,
    `month (${input.weeksPerMonth} weeks): ${monthly} of ${limit}`,
  ];

  return {
    weekly,
    monthly,
    limit,
    headroom: limit - monthly,
    fraction: Math.round((monthly / limit) * 1000) / 1000,
    // "Fits" means fits under the hard stop, not under the allowance: arriving
    // at the reserve in the last week is not a plan that fits.
    safe: monthly <= limit * 0.85,
    lines,
  };
}
