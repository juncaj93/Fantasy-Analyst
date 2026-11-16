/**
 * Team's lineup rows and weekly card, as one piece both Team and Matchup read
 * (Round 31, "one number per player").
 *
 * Team built its card from the lineup's own evaluations and its rows' verdicts;
 * Matchup built a second card on the server from Sleeper's lineup, so the same
 * quarterback read "Start at QB" on Matchup while Team benched him (Round 29
 * audit, finding 7). Both screens now call these, so a player of Alex's opens
 * the same card, with the same number and the same pick, wherever he is tapped.
 */

import type { LineupRecommendation, RosterPlayer, StartSitEvaluation } from './api.ts';
import { buildWeeklyCard, type WeeklyCard, type WeeklyContext } from '../core/startsit/weekCard.ts';
import { buildLineupVerdicts, weeklyContextFor, type LineupVerdictRow } from '../core/startsit/sleeperLineup.ts';

export interface OpenSlot {
  slot: string;
  count: number;
  accepts: string[];
}

export interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  /**
   * The league's starting slots in Sleeper's own order, and who is in each.
   *
   * `starters` below is the same lineup as a set and is what the older parts of
   * Team read. These two are what let the lineup be drawn as slots with
   * a verdict on each — the order the reader sees in Sleeper, and the player
   * he has in each one.
   *
   * `starterSlotIds` is absent on a roster synced before migration 0039, which
   * is read as "the order is not known" rather than as an empty lineup: the
   * same starters are then placed by eligibility. Both are optional so an older
   * server degrades to the set-based view instead of drawing a blank lineup.
   */
  rosterPositions?: string[];
  starterSlotIds?: (string | null)[];
  starters: RosterPlayer[];
  bench: RosterPlayer[];
  /** True while the draft is running: `drafted` is the current truth, not `starters`. */
  live: boolean;
  drafted: (RosterPlayer & { pickNo: number | null })[];
  counts: Record<string, number>;
  filled: number;
  remaining: number;
  openStarters: OpenSlot[];
  picksMade: number;
  /** One line of draft advice, derived server-side from roster need. */
  bestMove?: { text: string; positions: string[]; kind: string } | null;
  found: boolean;
}

/** Every player on the roster, however Sleeper currently has them arranged. */
export function rosterById(roster: RosterResponse | null | undefined): Map<string, RosterPlayer> {
  const map = new Map<string, RosterPlayer>();
  for (const p of roster?.starters ?? []) map.set(p.playerId, p);
  for (const p of roster?.bench ?? []) map.set(p.playerId, p);
  return map;
}

/** Team's lineup rows: the app's lineup laid against the one Sleeper holds. */
export function teamVerdicts(
  roster: RosterResponse | null | undefined,
  lineup: LineupRecommendation | null | undefined,
  byId: ReadonlyMap<string, RosterPlayer> = rosterById(roster),
): LineupVerdictRow[] {
  if (!roster || !lineup?.slots?.length) return [];
  return buildLineupVerdicts({
    rosterPositions: roster.rosterPositions ?? [],
    starterIds: (roster.starters ?? []).map((p) => p.playerId),
    ...(roster.starterSlotIds ? { starterSlotIds: roster.starterSlotIds } : {}),
    slots: lineup.slots,
    /*
     * The changes the optimiser would actually stand behind, and only those.
     * Without this the rows would propose swaps the card above them declines
     * to make — one screen answering to two rules.
     */
    suggestedSwaps: lineup.swaps ?? [],
    positionOf: (id) => byId.get(id)?.position ?? null,
  });
}

/** Every evaluation the lineup already computed, by player. */
export function lineupEvaluations(lineup: LineupRecommendation | null | undefined): Map<string, StartSitEvaluation> {
  const map = new Map<string, StartSitEvaluation>();
  for (const e of [...(lineup?.starters ?? []), ...(lineup?.bench ?? []), ...(lineup?.undecidable ?? [])]) {
    map.set(e.playerId, e);
  }
  return map;
}

/**
 * One of Alex's players' weekly card, from the lineup's own evaluation.
 *
 * The sheet is handed the same published figure the row was: where the server
 * said `sleeper`, the number goes straight back as the published figure. The
 * card's number itself is the evaluation's decision number (`weekCard.ts`).
 */
export function teamWeeklyCard(evaluation: StartSitEvaluation | null | undefined, context: WeeklyContext): WeeklyCard | null {
  if (!evaluation) return null;
  const published = evaluation.projectionSource === 'sleeper' ? (evaluation.projection ?? null) : null;
  return buildWeeklyCard(evaluation, { ...context, published });
}

/**
 * Matchup's card for one of Alex's own players: exactly Team's card, with the
 * headline the Team rows give him. Null when Team's lineup has no evaluation
 * for him, so the caller keeps its own card.
 */
export function teamCardFor(
  roster: RosterResponse | null | undefined,
  lineup: LineupRecommendation | null | undefined,
  playerId: string,
): WeeklyCard | null {
  const evaluation = lineupEvaluations(lineup).get(playerId);
  if (!evaluation) return null;
  return teamWeeklyCard(evaluation, weeklyContextFor(teamVerdicts(roster, lineup), playerId));
}
