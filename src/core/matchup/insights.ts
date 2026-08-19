/**
 * The one card that says what matters right now.
 *
 * This is the part of Matchup that is not a scoreboard. Everything above it —
 * the score, the projection, the odds — is state; this is the sentence that
 * tells somebody what to *do* with it, and it is the difference between a
 * prettier Sleeper and a tool worth opening.
 *
 * ## It does not rotate facts
 *
 * A carousel of true statements is noise. Every candidate below is generated
 * from the simulation, is filtered against a materiality threshold, and is then
 * ranked by a fixed ladder that says, in order:
 *
 *  1. **can the reader still act on it?** A lineup change that is still legal
 *     outranks any amount of commentary, because it expires.
 *  2. **how much of the outcome does it move?** In win probability, not points.
 *  3. **how severe is the game-state or injury event behind it?**
 *  4. **how much has it changed since the last state that mattered?**
 *  5. **how close is it to a threshold that flips something?**
 *  6. **is it about the reader's own side?**
 *
 * The first axis is a *tier*, not a weight, which is what makes "an injury
 * alert outranks a minor projection movement" a property of the code rather
 * than of the numbers on a particular Sunday.
 *
 * ## It does not fabricate drama
 *
 * When nothing material is happening the answer is one calm card stating where
 * the matchup stands, and that is a success state rather than a fallback. The
 * temptation in a feature like this is to always have something breathless to
 * say; a screen that manufactures urgency is one whose urgency stops meaning
 * anything the first Sunday nothing happens.
 *
 * ## Every message is generated from current truth
 *
 * An insight carries the fingerprint of the state it was computed from and the
 * moment it became relevant. A card whose fingerprint is not the current one is
 * superseded by construction — there is no path by which yesterday's sentence
 * survives on today's screen.
 */

import type { LineupDecision } from './decision.ts';
import { vsExpectation, type PlayerDistribution } from './distribution.ts';
import type { ClinchState, NeedThreshold, PlayerLeverage } from './needs.ts';
import { MATERIAL_SWING, thresholdFor } from './needs.ts';
import type { SimulationResult } from './simulate.ts';
import type { MatchupPlayerInput, MatchupSide } from './types.ts';

/** Where the matchup as a whole is. Not the same as one player's game phase. */
export type MatchupPhase = 'pregame' | 'live' | 'final';

export type InsightKind =
  | 'injury'
  | 'lineup_leverage'
  | 'clinch'
  | 'near_clinch'
  | 'need'
  | 'opponent_need'
  | 'swing_positive'
  | 'swing_negative'
  | 'bench_swing'
  | 'variance_concentration'
  | 'what_decided_it'
  | 'calm'
  | 'degraded';

/**
 * How urgently a card wants the reader's attention.
 *
 * A tier rather than a score: nothing in the `informational` tier can outrank
 * anything in `act_now`, however large its win-probability effect, because a
 * decision that expires at kickoff is categorically more useful than a fact
 * that will still be true in an hour.
 */
export type InsightUrgency = 'act_now' | 'material' | 'informational' | 'calm';

const URGENCY_RANK: Record<InsightUrgency, number> = {
  act_now: 3,
  material: 2,
  informational: 1,
  calm: 0,
};

export interface HeroInsight {
  /** Stable across renders for the same underlying event. Dedupes on this. */
  key: string;
  kind: InsightKind;
  urgency: InsightUrgency;
  /** The sentence. Already written, already short. */
  headline: string;
  /** The half-sentence under it, when there is one worth the room. */
  detail: string | null;
  playerId: string | null;
  side: MatchupSide | null;
  /** How much win probability this is about, 0..1. Zero for a calm card. */
  winImpact: number;
  /** The computed rank. Higher first. Exposed so a test can assert ordering. */
  priority: number;
  /** When this became true, carried forward across renders while it stays true. */
  relevantSince: string;
  /** The matchup state it was generated from. */
  sourceFingerprint: string;
  generatedAt: string;
}

/** What the previous render knew, so "changed since" is answerable. */
export interface PreviousInsightState {
  fingerprint: string;
  winProbability: number;
  /** `key` -> when it first became relevant. */
  relevantSince: Record<string, string>;
}

export interface InsightInput {
  result: SimulationResult;
  players: MatchupPlayerInput[];
  distributions: PlayerDistribution[];
  leverage: PlayerLeverage[];
  clinch: ClinchState;
  decision: LineupDecision;
  phase: MatchupPhase;
  fingerprint: string;
  now: string;
  /** Short names, resolved for the whole matchup at once. */
  names: Map<string, string>;
  previous?: PreviousInsightState | null;
  /** True when Fantasy Analyst could not produce a forecast at all. */
  degraded?: boolean;
}

/** How many cards the carousel may hold. Beyond three nobody swipes. */
export const MAX_INSIGHTS = 3;

/** A projection miss has to be this many points before it is worth a card. */
export const MATERIAL_POINT_SWING = 6;

/**
 * The win-probability targets a "what you need" card aims at.
 *
 * Two thirds when behind — the point at which a matchup stops being a coin
 * flip — and simply level when the target would otherwise be below where things
 * already stand. Named rather than inlined because the number appears in the
 * sentence the reader sees.
 */
export const NEED_TARGET = 0.72;

/**
 * How far behind the reader has to be before "what you need" is worth a card.
 *
 * A matchup at even money does not have a thing you *need*; it has seven
 * players who all matter, and a card naming one of them would be false single-
 * variable certainty of exactly the kind §14 forbids. Below this the question
 * has an answer and the answer is useful, which is the whole distinction
 * between this card and the calm one.
 */
export const NEED_TRIGGER = 0.45;

export function buildInsights(input: InsightInput): HeroInsight[] {
  const candidates: Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'>[] = [];
  const name = (id: string) => input.names.get(id) ?? id;
  const winNow = input.result.winProbability;

  if (input.degraded) {
    candidates.push({
      key: 'degraded',
      kind: 'degraded',
      urgency: 'informational',
      headline: 'Fantasy Analyst forecast temporarily unavailable',
      detail: 'The scoreboard above is Sleeper’s and is unaffected.',
      playerId: null,
      side: null,
      winImpact: 0,
    });
    return finalise(candidates, input);
  }

  const distributionById = new Map(input.distributions.map((d) => [d.playerId, d]));
  const playerById = new Map(input.players.map((p) => [p.playerId, p]));
  const liveVariables = input.distributions.filter((d) => d.starting && !d.locked && d.remainingMean > 0).length;

  /* ------------------------------------------------------------- postgame */
  if (input.phase === 'final') {
    const decided = whatDecidedIt(input, name);
    if (decided) candidates.push(decided);
    for (const swing of benchSwings(input, name).slice(0, 1)) candidates.push(swing);
    if (candidates.length === 0) {
      candidates.push({
        key: 'final-calm',
        kind: 'calm',
        urgency: 'calm',
        headline: winNow >= 0.5 ? 'You won this one' : 'This one got away',
        detail: 'Every game is final.',
        playerId: null,
        side: null,
        winImpact: 0,
      });
    }
    return finalise(candidates, input);
  }

  /* -------------------------------------------------- availability alerts */

  /*
   * A starter who has been ruled out and has not kicked off.
   *
   * The most actionable sentence this screen has, and the one that would be
   * easiest to lose: a ruled-out player carries no distribution, so every
   * leverage-based path skips him — he holds none of the outcome precisely
   * because he is going to score nothing. What he holds is a *slot*, and that
   * is the alert. Only for the reader's own side: the opponent starting
   * somebody who is out is good news, not a task.
   */
  for (const player of input.players) {
    if (!player.starting || player.side !== 'mine' || !player.ruledOut) continue;
    if (distributionById.get(player.playerId)?.phase !== 'not_started') continue;

    const replacement = input.decision.options.find((o) => o.outPlayerId === player.playerId) ?? null;
    candidates.push({
      key: `ruled-out:${player.playerId}`,
      kind: 'injury',
      urgency: 'act_now',
      headline: `${name(player.playerId)} is OUT and still starting`,
      detail: replacement
        ? `${name(replacement.inPlayerId)} takes the slot and adds ${points(replacement.gain)} to your win odds.`
        : 'Nobody on your bench can legally take the slot.',
      playerId: player.playerId,
      side: 'mine',
      // A starting slot scoring nothing is material whether or not there is
      // anybody to put in it; a replacement that exists prices it exactly.
      winImpact: replacement ? replacement.gain : 0.15,
    });
  }

  for (const player of input.players) {
    if (!player.starting) continue;
    const distribution = distributionById.get(player.playerId);
    if (!distribution || distribution.locked) continue;
    if (player.availability !== 'uncertain' && player.availability !== 'likely_inactive') {
      continue;
    }
    /*
     * What his availability is worth, in the only currency this screen uses.
     *
     * The difference between the matchup as it stands and the matchup with him
     * certain to play — which is exactly what the reader wants to know and is
     * not visible from the designation alone. An availability question about a
     * player with no leverage is not an alert; it is a fact, and it stays off
     * the card.
     */
    const grip = input.leverage.find((l) => l.playerId === player.playerId);
    const impact = grip ? grip.swing * (distribution.mixture.inactive + distribution.mixture.limited * 0.5) : 0;
    if (impact < MATERIAL_SWING / 2) continue;

    const mine = player.side === 'mine';
    candidates.push({
      key: `injury:${player.playerId}:${player.availability}`,
      kind: 'injury',
      urgency: 'act_now',
      headline: `${name(player.playerId)} injury swings ${points(impact)}`,
      detail: mine
        ? `About ${points(impact)} of your win odds are riding on whether he plays.`
        : `Their ${name(player.playerId)} is unresolved — worth about ${points(impact)} either way.`,
      playerId: player.playerId,
      side: player.side,
      winImpact: round4(impact),
    });
  }

  /* ------------------------------------------------------ lineup leverage */
  if (input.decision.best) {
    const best = input.decision.best;
    candidates.push({
      key: `lineup:${best.outPlayerId}:${best.inPlayerId}`,
      kind: 'lineup_leverage',
      urgency: 'act_now',
      headline: `Start ${name(best.inPlayerId)} over ${name(best.outPlayerId)}: +${points(best.gain)}`,
      detail: best.reason,
      playerId: best.inPlayerId,
      side: 'mine',
      winImpact: best.gain,
    });
  }

  /* -------------------------------------------------------------- clinch */
  if (input.clinch.mathematical && input.clinch.leader) {
    candidates.push({
      key: 'clinch',
      kind: 'clinch',
      urgency: 'material',
      headline: input.clinch.leader === 'mine' ? 'You have won this' : 'This one is decided',
      detail: 'Nobody has any points left to score.',
      playerId: null,
      side: input.clinch.leader,
      winImpact: 1,
    });
  } else if (input.clinch.nearClinch && input.clinch.leader) {
    const confidence = input.clinch.leader === 'mine' ? winNow : 1 - winNow;
    candidates.push({
      key: 'near-clinch',
      kind: 'near_clinch',
      urgency: 'material',
      headline:
        input.clinch.leader === 'mine'
          ? `You’re effectively safe · ${percent(confidence)}`
          : `Effectively gone · ${percent(1 - confidence)} left`,
      detail:
        input.clinch.maxRemainingForTrailer > 0
          ? `They would need about ${input.clinch.maxRemainingForTrailer.toFixed(1)} from what is left.`
          : null,
      playerId: null,
      side: input.clinch.leader,
      winImpact: round4(Math.abs(confidence - 0.5) * 2),
    });
  }

  /* ------------------------------------------------- what each side needs */
  const mineLeverage = input.leverage.filter((l) => l.side === 'mine');
  const theirsLeverage = input.leverage.filter((l) => l.side === 'theirs');

  const need = winNow < NEED_TRIGGER ? bestNeed(input.result, mineLeverage, liveVariables) : null;
  if (need && !need.outOfReach && need.moreNeeded > 0.5) {
    candidates.push({
      key: `need:${need.playerId}`,
      kind: 'need',
      urgency: 'material',
      headline: `Need ${need.soleVariable ? '' : '~'}${need.moreNeeded.toFixed(1)} pts from ${name(need.playerId)}`,
      detail: needDetail(need, input, name),
      playerId: need.playerId,
      side: 'mine',
      winImpact: round4(Math.abs(need.winAtTarget - need.winNow)),
    });
  }

  /*
   * What the opponent needs to flip it.
   *
   * Only when the user is ahead: telling somebody who is losing what their
   * opponent needs to *keep* winning is a fact about a matchup that is already
   * going badly, and it is the least actionable sentence on the list.
   */
  if (winNow > 0.5) {
    const flip = flipThreshold(input.result, theirsLeverage, liveVariables);
    if (flip && !flip.outOfReach && flip.moreNeeded > 0.5) {
      candidates.push({
        key: `opponent-need:${flip.playerId}`,
        kind: 'opponent_need',
        urgency: 'informational',
        headline: `Opponent needs ${flip.soleVariable ? '' : '~'}${flip.moreNeeded.toFixed(1)} pts from ${name(flip.playerId)} to flip it`,
        detail: `He is on ${flip.target.toFixed(1)} at that point — projected ${(input.leverage.find((l) => l.playerId === flip.playerId)?.projected ?? 0).toFixed(1)}.`,
        playerId: flip.playerId,
        side: 'theirs',
        winImpact: round4(Math.abs(winNow - 0.5)),
      });
    }
  }

  /* -------------------------------------------- outperformance and misses */
  for (const distribution of input.distributions) {
    if (!distribution.starting) continue;
    if (distribution.phase === 'not_started') continue;
    const player = playerById.get(distribution.playerId);
    if (!player || player.projection == null) continue;

    /*
     * Measured against what he was projected to have by *now*, not against his
     * whole-game projection — see `vsExpectation`, which owns that correction
     * and is also what colours the player rows, so a card and a row can never
     * disagree about whether somebody is having a bad afternoon.
     */
    const delta = vsExpectation(distribution, player.projection);
    if (delta == null || Math.abs(delta) < MATERIAL_POINT_SWING) continue;

    const grip = input.leverage.find((l) => l.playerId === distribution.playerId);
    const impact = grip?.swing ?? Math.min(0.3, Math.abs(delta) / 40);
    const good = delta > 0 === (distribution.side === 'mine');
    candidates.push({
      key: `${delta > 0 ? 'over' : 'under'}:${distribution.playerId}`,
      kind: good ? 'swing_positive' : 'swing_negative',
      urgency: 'informational',
      headline: `Biggest swing: ${name(distribution.playerId)} ${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs expectation`,
      detail: good ? 'The matchup moved toward you.' : 'The matchup moved away from you.',
      playerId: distribution.playerId,
      side: distribution.side,
      winImpact: round4(impact * 0.6),
    });
  }

  /* ------------------------------------------- late-game concentration */
  const concentrated = input.leverage.find((l) => l.varianceShare >= 0.35 && l.swing >= MATERIAL_SWING);
  if (concentrated && liveVariables <= 4 && liveVariables > 0) {
    candidates.push({
      key: `concentration:${concentrated.playerId}`,
      kind: 'variance_concentration',
      urgency: 'informational',
      headline: `${name(concentrated.playerId)} decides ${percent(concentrated.varianceShare)} of what is left`,
      detail: `Between ${concentrated.floor.toFixed(1)} and ${concentrated.ceiling.toFixed(1)}, your odds move ${points(concentrated.swing)}.`,
      playerId: concentrated.playerId,
      side: concentrated.side,
      winImpact: concentrated.swing,
    });
  }

  /* ---------------------------------------------------- the calm fallback */
  if (candidates.length === 0) {
    candidates.push(calmCard(input, winNow));
  }

  return finalise(candidates, input);
}

/**
 * Rank, dedupe, stamp and cut.
 *
 * The one place an insight becomes a card. Everything above generates
 * candidates without knowing what else exists; the ordering, the collapse of
 * two cards about the same player and the carrying-forward of when something
 * became relevant all happen here, once.
 */
function finalise(
  candidates: Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'>[],
  input: InsightInput,
): HeroInsight[] {
  const previousSince = input.previous?.relevantSince ?? {};
  const winMoved = input.previous ? Math.abs(input.result.winProbability - input.previous.winProbability) : 0;

  const scored: HeroInsight[] = candidates.map((candidate) => ({
    ...candidate,
    priority: priorityOf(candidate, winMoved, input),
    // Carried forward while the same event is still true, so a card does not
    // claim to be new every thirty seconds. A key that was not in the previous
    // state is new now, which is the only honest reading.
    relevantSince: previousSince[candidate.key] ?? input.now,
    sourceFingerprint: input.fingerprint,
    generatedAt: input.now,
  }));

  /*
   * One card per player, and one per kind.
   *
   * A questionable receiver who is also the biggest swing generates two
   * candidates about the same fact; §11 calls that a duplicated message and it
   * is right. The higher-priority one survives, which is the injury — the
   * sentence that mentions the thing the reader can do something about.
   */
  const seenKeys = new Set<string>();
  const seenPlayers = new Set<string>();
  const deduped: HeroInsight[] = [];
  for (const insight of scored.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))) {
    if (seenKeys.has(insight.key)) continue;
    if (insight.playerId && seenPlayers.has(insight.playerId)) continue;
    seenKeys.add(insight.key);
    if (insight.playerId) seenPlayers.add(insight.playerId);
    deduped.push(insight);
  }

  /*
   * A calm card is a *fallback*, not a companion.
   *
   * If anything material survived the ranking, the calm restatement of the odds
   * is redundant with the score card six millimetres above it.
   */
  const material = deduped.filter((i) => i.kind !== 'calm');
  return (material.length > 0 ? material : deduped).slice(0, MAX_INSIGHTS);
}

/**
 * The rank, as one number, from the six axes §11 lists.
 *
 * Urgency is multiplied by a factor larger than everything below it can sum to,
 * which is what makes the tier a tier: no amount of win-probability impact can
 * lift an informational card above an actionable one.
 */
function priorityOf(
  candidate: Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'>,
  winMoved: number,
  input: InsightInput,
): number {
  const urgency = URGENCY_RANK[candidate.urgency] * 100;
  // Impact on win probability, the second axis, and the largest of the rest.
  const impact = candidate.winImpact * 40;
  // Injury and game-state severity, the third.
  const severity = candidate.kind === 'injury' ? 12 : candidate.kind === 'clinch' || candidate.kind === 'near_clinch' ? 8 : 0;
  // Change since the last meaningful state, the fourth.
  const movement = Math.min(winMoved * 30, 10);
  // Closeness to a threshold that flips something, the fifth: a matchup at 51%
  // makes every card about it more useful than the same card at 88%.
  const closeness = (1 - Math.abs(input.result.winProbability - 0.5) * 2) * 6;
  // The reader's own side, the sixth and smallest.
  const relevance = candidate.side === 'mine' ? 3 : 0;
  return round4(urgency + impact + severity + movement + closeness + relevance);
}

/** The neutral state, said plainly, without inventing a reason to worry. */
function calmCard(
  input: InsightInput,
  winNow: number,
): Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'> {
  const favourite = winNow >= 0.5;
  const margin = Math.abs(winNow - 0.5);
  const strength = margin < 0.07 ? 'a coin flip' : margin < 0.18 ? 'a slight' : margin < 0.32 ? 'a clear' : 'a strong';
  return {
    key: 'calm',
    kind: 'calm',
    urgency: 'calm',
    headline:
      strength === 'a coin flip'
        ? `This is a coin flip · ${percent(winNow)} win odds`
        : `You remain ${strength} ${favourite ? 'favourite' : 'underdog'} · ${percent(winNow)} win odds`,
    detail:
      input.phase === 'pregame'
        ? 'Nothing has kicked off yet.'
        : 'Nothing material has changed since the last look.',
    playerId: null,
    side: null,
    winImpact: 0,
  };
}

/**
 * What decided a finished matchup.
 *
 * The largest contribution to the margin, measured as points over or under this
 * app's own projection — which is what makes it a statement about the week
 * rather than about who scored most. A recap that names the highest scorer is a
 * box score; one that names the player who beat his projection by eighteen is
 * an explanation.
 */
function whatDecidedIt(
  input: InsightInput,
  name: (id: string) => string,
): Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'> | null {
  const playerById = new Map(input.players.map((p) => [p.playerId, p]));
  const scored = input.distributions
    .filter((d) => d.starting)
    .map((d) => {
      const player = playerById.get(d.playerId);
      const projection = player?.projection ?? null;
      return {
        playerId: d.playerId,
        side: d.side,
        delta: projection == null ? null : round2(d.settled - projection),
      };
    })
    .filter((row): row is { playerId: string; side: MatchupSide; delta: number } => row.delta != null);

  if (scored.length === 0) return null;
  // The margin swings toward whoever the surprise favoured: a big game for the
  // opponent counts against you exactly as much as one for you counts for you.
  const ranked = scored
    .map((row) => ({ ...row, effect: row.side === 'mine' ? row.delta : -row.delta }))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const top = ranked[0]!;
  if (Math.abs(top.delta) < MATERIAL_POINT_SWING / 2) return null;

  const margin = round2(input.result.projectedMine - input.result.projectedTheirs);
  const won = margin > 0;
  return {
    key: `decided:${top.playerId}`,
    kind: 'what_decided_it',
    urgency: 'material',
    headline: 'What decided it',
    detail:
      `${name(top.playerId)} finished ${top.delta > 0 ? '+' : ''}${top.delta.toFixed(1)} vs expectation` +
      `${Math.abs(top.effect) >= Math.abs(margin) ? `, which was more than the ${Math.abs(margin).toFixed(1)}-point margin` : ''}` +
      `. You ${won ? 'won' : 'lost'} by ${Math.abs(margin).toFixed(1)}.`,
    playerId: top.playerId,
    side: top.side,
    winImpact: round4(Math.min(1, Math.abs(top.effect) / Math.max(Math.abs(margin), 1) / 3)),
  };
}

/**
 * A bench player who outscored the starter he could have replaced.
 *
 * §22's rule is the whole reason this is written carefully: the card states
 * what happened and refuses to imply it was foreseeable. Where the pregame
 * model preferred the starter, it says the outcome went against the
 * recommendation — which is a fact about variance, not a verdict on a decision.
 */
function benchSwings(
  input: InsightInput,
  name: (id: string) => string,
): Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'>[] {
  const mine = input.players.filter((p) => p.side === 'mine');
  const starters = mine.filter((p) => p.starting);
  const bench = mine.filter((p) => !p.starting);
  const distributionById = new Map(input.distributions.map((d) => [d.playerId, d]));

  const out: Omit<HeroInsight, 'priority' | 'relevantSince' | 'sourceFingerprint' | 'generatedAt'>[] = [];
  for (const benched of bench) {
    const benchedPoints = distributionById.get(benched.playerId)?.settled ?? 0;
    for (const starter of starters) {
      // Only where the swap would have been legal: a receiver who outscored a
      // quarterback is not a lineup decision anybody had.
      if (starter.position !== benched.position) continue;
      const starterPoints = distributionById.get(starter.playerId)?.settled ?? 0;
      const gap = round2(benchedPoints - starterPoints);
      if (gap < MATERIAL_POINT_SWING) continue;
      const modelPreferredStarter = (starter.projection ?? 0) >= (benched.projection ?? 0);
      out.push({
        key: `bench-swing:${benched.playerId}:${starter.playerId}`,
        kind: 'bench_swing',
        urgency: 'informational',
        headline: `Bench swing: ${name(benched.playerId)} outscored ${name(starter.playerId)} by ${gap.toFixed(1)}`,
        detail: modelPreferredStarter
          ? 'The outcome swung against the pregame recommendation.'
          : 'The pregame projection had preferred him too.',
        playerId: benched.playerId,
        side: 'mine',
        winImpact: round4(Math.min(0.4, gap / 30)),
      });
    }
  }
  return out.sort((a, b) => b.winImpact - a.winImpact);
}

/**
 * The best *reachable* threshold on the user's own side.
 *
 * The target is chosen per player rather than fixed, and that is what keeps the
 * sentence honest. Aiming at a flat 72% produces "you need forty-one points
 * from your tight end" for anybody whose ceiling cannot get there — true, and
 * not a path anybody is on. So the aim is the best odds that player can
 * actually deliver, capped at {@link NEED_TARGET}: a card that says 58% when
 * 58% is what is available is worth more than one that says 72% and cannot be
 * acted on.
 *
 * A player whose best game would not move the matchup meaningfully is skipped
 * entirely, and if nobody qualifies there is no card — which is the calm state,
 * correctly reached.
 */
function bestNeed(
  result: SimulationResult,
  leverage: PlayerLeverage[],
  liveVariables: number,
): NeedThreshold | null {
  const winNow = result.winProbability;
  for (const player of leverage) {
    if (player.swing < MATERIAL_SWING) continue;
    const reachable = Math.max(player.winAtFloor, player.winAtCeiling);
    const target = Math.min(NEED_TARGET, reachable - 0.02);
    // He has to be worth at least eight points of win probability, or the card
    // is asking for a big game in exchange for nothing.
    if (target < winNow + 0.08) continue;
    const threshold = thresholdFor(result, player, target, { liveVariables });
    if (threshold && !threshold.outOfReach) return threshold;
  }
  return null;
}

/** The point at which one of the opponent's players flips the matchup. */
function flipThreshold(
  result: SimulationResult,
  leverage: PlayerLeverage[],
  liveVariables: number,
): NeedThreshold | null {
  for (const player of leverage) {
    if (player.swing < MATERIAL_SWING) continue;
    const threshold = thresholdFor(result, player, 0.5, { liveVariables });
    if (threshold && !threshold.outOfReach) return threshold;
  }
  return null;
}

/**
 * The two facts the shortened headline no longer carries.
 *
 * `Need ~24.7 pts from S. Brandt` says the thing worth acting on and stops. What
 * it drops is *what that buys* — the win odds at that number — and that is the
 * half a reader needs before deciding whether the number is worth hoping for, so
 * it leads here.
 *
 * The projected margin used to lead this line and no longer appears at all: both
 * projected finals are printed in the score card directly above, and a card this
 * small cannot afford to spend a clause repeating the element above it.
 */
function needDetail(need: NeedThreshold, input: InsightInput, name: (id: string) => string): string {
  const grip = input.leverage.find((l) => l.playerId === need.playerId);
  const projected = grip?.projected ?? 0;
  return `Takes you to ${percent(need.winAtTarget)} · ${name(need.playerId)} is projected ${projected.toFixed(1)}, needs ${need.target.toFixed(1)}.`;
}

/** A win probability, as a level: "61%". */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * A *change* in win probability, as points rather than a percentage.
 *
 * "Adds 8%" and "adds 8 pts" are different claims, and only the second one is
 * this number: going from 40% to 48% is eight points and a twenty-percent
 * increase, and the card that says "8%" invites the reader to pick whichever
 * reading flatters the suggestion. Levels keep {@link percent}; deltas get this.
 */
function points(value: number): string {
  return `${Math.round(value * 100)} pts`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
