/**
 * Whether anybody unrostered would actually improve the lineup.
 *
 * This is the last step of a chain, and the order is the point. The roster is
 * optimised first, by the same optimiser the Team screen draws; only then is a
 * slot allowed to be called a need; only then is the free-agent pool looked at
 * at all. **Bench before waiver**: if the answer is already sitting on the
 * bench, the answer is the bench, and an add would be churn.
 *
 * Safety, and it is not a footnote: nothing here adds, drops, claims, bids or
 * queues anything. It produces sentences. Every transaction in this app happens
 * in Sleeper, by hand, on purpose.
 *
 * Two rules are absolute and are enforced here rather than trusted to callers:
 * a player on any roster in the league is never recommended, and a slot whose
 * game has kicked off is never given advice, because the change is no longer
 * possible to make.
 */

import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import type { RoleAssessment } from './decisions.ts';
import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from './engine.ts';
import { recommendLineup, type LineupRecommendation } from './lineup.ts';

/**
 * How much better an available player has to be before he is worth mentioning.
 *
 * In fantasy points, against the player the optimiser would otherwise start.
 * Deliberately well above the optimiser's own swap threshold: moving a player
 * you already own between two of your own slots costs nothing, and adding one
 * costs a roster spot, a waiver priority and somebody's place on the bench. A
 * tenth of a point does not buy that.
 */
export const MEANINGFUL_UPGRADE_GAIN = 2.5;

/**
 * How much better an available player has to be than the man you would *drop*.
 *
 * The other question this page answers, and a different one from the threshold
 * above. `MEANINGFUL_UPGRADE_GAIN` asks whether somebody is worth displacing a
 * player you are already starting; this asks whether he is worth a roster spot
 * at all, measured against the weakest man on your bench. Half a point of
 * roster utility is a free upgrade to a bench slot that was doing nothing, and
 * what stops trivial claims being recommended is the bid rather than this.
 *
 * It is exported because `core/waivers/planner` already had this number, under
 * this reasoning, as its own `minNetGain`, and the two must not drift: the
 * planner takes its targets from the board, so a board that admitted less than
 * the planner would consider was a planner that could never use its own bar.
 * One constant, read by both.
 */
export const ROSTER_SPOT_GAIN = 0.5;

/** Free agents scored per slot before the list is cut. Keeps Team fast. */
export const DEFAULT_ALTERNATIVES = 3;

/**
 * A slot only a defence can fill.
 *
 * Read rather than assumed from the slot's name, because what a slot accepts is
 * a property of the league: a hypothetical flex that took a defence alongside a
 * receiver would not be a defence slot, and this must not treat it as one.
 */
function isDefenceOnlySlot(slot: { accepts: string[] }): boolean {
  return slot.accepts.length > 0 && slot.accepts.every((p) => p === 'DEF');
}

export interface WaiverCandidate {
  playerId: string;
  name: string;
  position: string;
  team: string;
  score: number | null;
  /** Points gained over whoever the optimiser has in the slot. */
  gain: number;
  /** Short phrases, in the order they matter. */
  reasons: string[];
  statusFlag: string | null;
  /**
   * The role assessment behind the points, carried rather than described.
   *
   * The reasons above are prose for a card, and a caller that needs to *decide*
   * something from the role — how long the opportunity lasts, how settled it is
   * — was reduced to string-matching them. That is a coupling nobody declared
   * and one rewording away from silently changing a bid. `games` is how many
   * games the trend rests on, and zero means the detector had nothing to read.
   */
  role: { trend: RoleAssessment['trend']; games: number };
}

export interface WaiverUpgrade {
  slot: string;
  accepts: string[];
  /** `unfilled` when nobody on the roster can legally start there. */
  need: 'unfilled' | 'upgrade';
  currentPlayerId: string | null;
  currentName: string | null;
  currentScore: number | null;
  /** The points gap this had to clear, so the bar is never invisible. */
  bar: number;
  /** Best first. At most `alternatives` long. */
  candidates: WaiverCandidate[];
}

/**
 * A free agent worth a roster spot who beats nobody you are starting.
 *
 * The board's second question. A reader with no hole in their lineup still has
 * a worst bench player, and somebody clearly better than him on the wire is a
 * real move — the ordinary "best available" claim that a slot-shaped scan can
 * never produce, because there is no slot for it to be an upgrade to.
 */
export interface WaiverValueAdd extends WaiverCandidate {
  /** The weakest man on the bench, whom this add is measured against. */
  overPlayerId: string | null;
  overName: string | null;
}

/**
 * A free agent nothing could be scored on.
 *
 * No market, no usage, no news and no status: `evaluatePlayer` returns a null
 * score and there is nothing to compare. He is reported rather than dropped,
 * because "the app knows nothing about him" is a fact about the app and not a
 * verdict on the player, and a reader chasing a name they saw elsewhere is
 * owed the difference. Nothing here is ranked against anybody.
 */
export interface WaiverUnknown {
  playerId: string;
  name: string;
  position: string;
  team: string;
  statusFlag: string | null;
}

export interface WaiverAdvice {
  upgrades: WaiverUpgrade[];
  /**
   * Worth a roster spot, in descending order of what they are worth.
   *
   * Never overlapping `upgrades`: a player offered as an answer to a starting
   * slot is not offered again as a bench add.
   */
  valueAdds: WaiverValueAdd[];
  /**
   * Everyone the scan could not score, named rather than silently dropped.
   *
   * Unfiltered here on purpose. Which of them is worth a reader's attention is
   * a league-intelligence question — whether the rest of Sleeper is adding him
   * — and that is answered in `core/waivers/assemble.ts`, which holds the
   * trending data this module has no business knowing about.
   */
  unknowns: WaiverUnknown[];
  /**
   * What an empty board means, said plainly. Null whenever there are rows.
   *
   * It distinguishes a wire that was read and lost from one that could not be
   * read at all, because most of a real free-agent pool has nothing to score.
   * See `emptyBoardHeadline`.
   */
  headline: string | null;
  notes: string[];
  /** How many unrostered players were actually scored. */
  considered: number;
  /**
   * How many were not — unscorable, ruled out, or already kicked off.
   *
   * A number, not a note. It used to be pushed into `notes`, which is the list
   * the Waivers screen prints, so a page whose job is to recommend two players
   * closed with the engine reporting how much work it had done. That is
   * diagnostics: true, occasionally useful, and never the reason anybody opened
   * this screen. It stays available here for whatever wants to show it.
   */
  skipped: number;
  threshold: number;
}

export function recommendWaiverUpgrades(opts: {
  /** The user's own players. */
  roster: StartSitInput[];
  /** A bounded set of unrostered players — see the note on `considered`. */
  candidates: StartSitInput[];
  shape: RosterShape;
  profile: ScoringProfile;
  /** Every player on every roster in the league. The hard exclusion. */
  rosteredPlayerIds: Iterable<string>;
  currentStarterIds?: string[];
  /** Reuse an already-computed lineup rather than optimising twice. */
  lineup?: LineupRecommendation;
  minGain?: number;
  alternatives?: number;
  /** Players held on IR or taxi, who are not the roster spot a claim frees. */
  reserveIds?: string[];
}): WaiverAdvice {
  const base = opts.minGain ?? MEANINGFUL_UPGRADE_GAIN;
  const perSlot = opts.alternatives ?? DEFAULT_ALTERNATIVES;
  const rostered = new Set(opts.rosteredPlayerIds);
  const notes: string[] = [];

  const lineup =
    opts.lineup ??
    recommendLineup(opts.roster, opts.shape, opts.profile, {
      ...(opts.currentStarterIds ? { currentStarterIds: opts.currentStarterIds } : {}),
    });

  /*
   * Anybody on a roster is not available, whatever the caller believed.
   *
   * Sleeper is the authority on who is rostered and this is the last place that
   * fact can be checked, so it is checked here: recommending a player somebody
   * else owns is the single most embarrassing thing this feature could do.
   */
  const unrostered = opts.candidates.filter((c) => !rostered.has(c.player.id));
  const dropped = opts.candidates.length - unrostered.length;
  if (dropped > 0) notes.push(`${dropped} candidate(s) are already rostered in this league and were not considered`);

  const evaluated = unrostered.map((c) => evaluatePlayer(c, opts.profile));
  /*
   * A candidate has to be scorable, playable and still movable.
   *
   * Ruled out is ruled out for a free agent exactly as it is for a roster
   * player — adding somebody who is on injured reserve to fill this week's hole
   * is not advice. And a player whose game has kicked off cannot be added into
   * this week's lineup at all, so offering him would be offering an action the
   * user cannot take.
   */
  const playable = evaluated.filter((e) => e.score != null && !e.ruledOut && !e.lock.locked);
  /*
   * The ones there was nothing to read on, counted apart from the ones ruled out.
   *
   * `skipped` below is the whole of what the scan dropped, and it mixes three
   * different facts: a player with no market, usage or news to score him on; a
   * player who is genuinely unavailable; and a player whose game has started.
   * Only the first is an admission of ignorance, and only the first may be
   * described to a reader as unknown rather than rejected. The other two were
   * correctly excluded and need no explaining. See `emptyBoardHeadline`.
   */
  const unscored = evaluated.filter((e) => e.score == null).length;

  const rosterEvaluations = new Map(opts.roster.map((i) => [i.player.id, evaluatePlayer(i, opts.profile)]));

  interface Considered {
    slot: (typeof lineup.slots)[number];
    need: 'unfilled' | 'upgrade';
    bar: number;
    current: StartSitEvaluation | null;
    ranked: { evaluation: StartSitEvaluation; gain: number; bar: number }[];
  }

  const considered: Considered[] = [];
  for (const slot of lineup.slots) {
    // A settled slot is not a decision any more, so it gets no advice.
    if (slot.locked) continue;
    const current = slot.playerId ? (rosterEvaluations.get(slot.playerId) ?? null) : null;
    const need: 'unfilled' | 'upgrade' = slot.playerId == null ? 'unfilled' : 'upgrade';

    /*
     * A defence may fill an empty slot. It may not yet replace a rostered one.
     *
     * The distinction is the whole of it, and it is a scope line rather than a
     * modelling one. Filling an empty DEF slot is the ordinary answer to an
     * ordinary hole — a reader who owns no defence in a league that starts one
     * should be told, in the same words a reader missing a tight end is told.
     *
     * Swapping one rostered defence for a better one *every week* is a
     * different product, and it has a name: streaming. It arrives free the
     * moment defences become scorable, because the gap between the best and
     * worst defence on a slate is comfortably over the upgrade bar — so a
     * reader would be told to drop and add a defence most weeks, on a card with
     * no sense of how many transactions that costs, whether the add survives to
     * next week, or what it does to a playoff plan. Those are exactly the
     * questions the streaming lane exists to answer, and `assessStreaming`
     * already exists and is deliberately not wired in.
     *
     * So the emergent version is switched off here, on purpose, and turning it
     * on is a deliberate act in the lane that models it rather than a side
     * effect of this one.
     */
    if (need === 'upgrade' && isDefenceOnlySlot(slot)) continue;
    const currentScore = current?.score ?? null;

    /*
     * The bar is per candidate, because thin data is per candidate.
     *
     * A gap measured between two well-covered players means what it says; the
     * same gap measured against somebody with no market at all is mostly an
     * artefact of the missing side, and asking more of it is the difference
     * between advice and noise. `bar` on the upgrade is the strictest one that
     * actually admitted somebody, so the card can show what was cleared.
     */
    const ranked = playable
      .filter((e) => slot.accepts.includes(e.position))
      .map((e) => ({
        evaluation: e,
        gain: round2((e.score ?? 0) - (currentScore ?? 0)),
        bar: upgradeBar(need, base, current, e),
      }))
      .filter((c) => c.gain >= c.bar && (c.evaluation.score ?? 0) > 0)
      .sort((a, b) => b.gain - a.gain || a.evaluation.name.localeCompare(b.evaluation.name));

    if (ranked.length > 0) {
      considered.push({ slot, need, bar: Math.max(...ranked.map((c) => c.bar)), current, ranked });
    }
  }

  /*
   * One player cannot fill two slots, and a flex-eligible free agent is
   * eligible for several. Biggest need first, and each candidate spent once, so
   * the same receiver is not offered as the answer to three different slots.
   */
  considered.sort((a, b) => (b.ranked[0]?.gain ?? 0) - (a.ranked[0]?.gain ?? 0) || a.slot.slot.localeCompare(b.slot.slot));

  const spent = new Set<string>();
  const upgrades: WaiverUpgrade[] = [];
  for (const entry of considered) {
    const available = entry.ranked.filter((c) => !spent.has(c.evaluation.playerId)).slice(0, perSlot);
    if (available.length === 0) continue;
    for (const c of available) spent.add(c.evaluation.playerId);
    upgrades.push({
      slot: entry.slot.slot,
      accepts: entry.slot.accepts,
      need: entry.need,
      currentPlayerId: entry.slot.playerId,
      currentName: entry.slot.name,
      currentScore: entry.current?.score ?? null,
      bar: entry.bar,
      candidates: available.map((c) => ({
        playerId: c.evaluation.playerId,
        name: c.evaluation.name,
        position: c.evaluation.position,
        team: c.evaluation.team,
        score: c.evaluation.score,
        gain: c.gain,
        reasons: upgradeReasons(c.evaluation, entry.current),
        statusFlag: c.evaluation.statusFlag,
        role: { trend: c.evaluation.role.trend, games: c.evaluation.role.games },
      })),
    });
  }

  /*
   * The second question, asked of everybody the first one did not spend.
   *
   * Measured against the weakest man on the bench rather than against a starter,
   * because that is who a claim actually costs: the add displaces the last
   * player on the roster, not the one in the slot. A candidate already offered
   * as the answer to a starting slot is not offered again here — he is one
   * decision, and the stronger framing of it has already been made.
   */
  const benchFloor = weakestBench(lineup, opts.roster, rosterEvaluations, opts.reserveIds ?? []);
  const valueAdds: WaiverValueAdd[] = (benchFloor == null ? [] : playable)
    .filter((e) => !spent.has(e.playerId))
    .map((e) => ({ evaluation: e, gain: round2((e.score ?? 0) - (benchFloor?.score ?? 0)) }))
    .filter((c) => c.gain >= ROSTER_SPOT_GAIN && (c.evaluation.score ?? 0) > 0)
    .sort((a, b) => b.gain - a.gain || a.evaluation.name.localeCompare(b.evaluation.name))
    .map(({ evaluation, gain }) => ({
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      team: evaluation.team,
      score: evaluation.score,
      gain,
      reasons: valueAddReasons(evaluation, benchFloor),
      statusFlag: evaluation.statusFlag,
      role: { trend: evaluation.role.trend, games: evaluation.role.games },
      overPlayerId: benchFloor?.playerId ?? null,
      overName: benchFloor?.name ?? null,
    }));

  /*
   * And the ones there was nothing to say about, said anyway.
   *
   * Ruled out is left out: he is unavailable on a fact, which is an answer
   * rather than an absence, and naming him under "not enough data" would
   * describe a known thing as an unknown one.
   */
  const unknowns: WaiverUnknown[] = evaluated
    .filter((e) => e.score == null && !e.ruledOut)
    .map((e) => ({
      playerId: e.playerId,
      name: e.name,
      position: e.position,
      team: e.team,
      statusFlag: e.statusFlag,
    }));

  return {
    upgrades,
    valueAdds,
    unknowns,
    headline: emptyBoardHeadline({
      upgrades: upgrades.length + valueAdds.length,
      playable: playable.length,
      unscored,
    }),
    notes,
    considered: evaluated.length,
    skipped: evaluated.length - playable.length,
    threshold: base,
  };
}

/**
 * What an empty board actually means, rather than the flattering version of it.
 *
 * This string is the whole of what the Waivers screen prints when nothing
 * cleared, so it is the page's one statement about a wire the reader cannot
 * see. It used to read `Your current options grade better than available
 * waivers.` in every empty case, including the case where most of the wire was
 * never compared at all: a free agent with no market, no usage and no news
 * scores `null` and is dropped before any slot looks at him, and on a real
 * scan that is routinely the majority of the pool. Telling a reader their
 * roster graded better than players nobody graded is the one thing the rest of
 * this codebase is built not to do, and it is worse here than a blank field
 * would be, because it sounds like a finding.
 *
 * So the three cases are said apart:
 *
 *   - nobody was scorable, so there is no comparison to report and the sentence
 *     may not imply one;
 *   - everybody was scored and nobody was better, which is the original
 *     sentence and stays word for word;
 *   - some were scored and some could not be, which is the ordinary case, and
 *     the count of the unread is the reader's cue that the wire is thin on data
 *     rather than thin on players.
 *
 * The count is of players who could not be *scored*, never of everything the
 * scan dropped: somebody on injured reserve, or somebody whose game has already
 * started, was excluded on a fact rather than on ignorance, and folding him into
 * this number would make the sentence claim the app knows less than it does.
 *
 * `unknown, not ruled out` is the phrase used deliberately: a player the app
 * could not score has not been rejected, and a reader who wants him should not
 * read this line as advice against him.
 */
function emptyBoardHeadline(counts: { upgrades: number; playable: number; unscored: number }): string | null {
  if (counts.upgrades > 0) return null;
  const { playable, unscored } = counts;

  if (playable === 0) {
    if (unscored === 0) return null;
    const verb = unscored === 1 ? 'has' : 'have';
    return `No free agent could be scored: ${freeAgents(unscored)} ${verb} no market, usage or news to read. Unknown, not ruled out.`;
  }

  if (unscored === 0) return 'Your current options grade better than available waivers.';

  return (
    `Your current options grade better than the ${freeAgents(playable)} that could be scored. ` +
    `${cap(freeAgents(unscored))} had nothing to read: unknown, not ruled out.`
  );
}

/**
 * The weakest man on the bench: who a claim would actually cost.
 *
 * Starters are excluded because displacing one of them is the *other* question,
 * already answered above. Reserve players are excluded too — an IR stash is not
 * the roster spot a Tuesday claim frees, and pricing an add against a player
 * who cannot play this week would make every add look like a bargain.
 *
 * **He also has to have a game.** This is the one that matters, and getting it
 * wrong turns the whole tier into noise. A bench player on a bye, or one the
 * market has not priced, scores near zero — not because he is worthless but
 * because there is nothing this week to score. Measured against him, every
 * healthy free agent on the wire clears the bar by nine points and the board
 * fills with "value adds" that are really *better than my bye-week receiver,
 * this Sunday only*. So the floor is drawn from bench players the market has
 * actually priced, which is the same line `upgradeBar` draws when it charges a
 * surcharge for thin data: a comparison is only worth making when both sides
 * are known.
 *
 * Null when nobody on the bench qualifies, and the caller then claims no value
 * adds at all. An empty bench is not a bench of zero-point players, and
 * treating it as one would recommend the entire wire.
 */
function weakestBench(
  lineup: LineupRecommendation,
  roster: StartSitInput[],
  evaluations: Map<string, StartSitEvaluation>,
  reserveIds: string[],
): StartSitEvaluation | null {
  const starting = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const reserved = new Set(reserveIds);
  let worst: StartSitEvaluation | null = null;
  for (const input of roster) {
    const id = input.player.id;
    if (starting.has(id) || reserved.has(id)) continue;
    const evaluation = evaluations.get(id);
    if (!evaluation || evaluation.score == null) continue;
    /*
     * A ruled-out player's score is a penalty, not a valuation.
     *
     * The engine drives somebody who cannot play deep negative on purpose, so
     * the lineup optimiser will never start him. Left in here he is always the
     * weakest man on the bench by a distance, and every free agent on the wire
     * then "beats" him by eighty points. He is also not the drop a claim
     * actually makes: cutting an injured starter is a roster decision of its
     * own, which is why `planner/dropCost.ts` protects him outright rather than
     * pricing him. Same rule, applied earlier.
     */
    if (evaluation.ruledOut) continue;
    if (evaluation.expectation.points == null) continue;
    if (worst == null || evaluation.score < (worst.score ?? 0)) worst = evaluation;
  }
  return worst;
}

/**
 * Why he is worth a roster spot, in the terms that decision is made in.
 *
 * Deliberately not `upgradeReasons`: that one opens with how he compares to the
 * man in the slot, and there is no slot here. The comparison that matters is
 * the bench, and naming the player who would go is what turns "best available"
 * into a move the reader can actually picture making.
 */
function valueAddReasons(candidate: StartSitEvaluation, floor: StartSitEvaluation | null): string[] {
  const reasons: string[] = [];
  if (floor) reasons.push(`Worth more than ${floor.name}, the last man on your bench`);

  const points = candidate.expectation.points;
  if (points != null) reasons.push(`Market priced — ${points.toFixed(1)} pts expected`);
  if (candidate.role.trend === 'rising_high' || candidate.role.trend === 'rising_moderate') {
    reasons.push('Role increasing');
  }
  if (candidate.movement.direction === 'up' && candidate.movement.headline) {
    reasons.push(candidate.movement.headline);
  }
  if (reasons.length === 0) reasons.push('Scores higher on the evidence available');
  return reasons;
}

/** `1 free agent` / `14 free agents`. */
function freeAgents(count: number): string {
  return `${count} free agent${count === 1 ? '' : 's'}`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * How much better this candidate has to be before the add is worth mentioning.
 *
 * One place, deliberately, so "meaningful" means one thing across the app.
 *
 * An empty slot has no bar at all — nobody is starting there, so any playable
 * body is an improvement and calling that noise would be pedantry.
 *
 * Everywhere else it is the standing threshold, **raised when either side's
 * data is thin**. A four-point gap between two players the market has priced is
 * four points; the same gap measured against somebody with no market at all is
 * mostly the missing side showing through, and treating the two as equally
 * convincing is how a waiver card fills up with adds nobody should make. The
 * worse of the two confidences decides, because the weaker half is what limits
 * what the subtraction can be trusted to say.
 */
export function upgradeBar(
  need: 'unfilled' | 'upgrade',
  base: number,
  current: StartSitEvaluation | null,
  candidate?: StartSitEvaluation | null,
): number {
  if (need === 'unfilled') return 0;
  const confidences = [current?.confidence, candidate?.confidence].filter(
    (c): c is 'high' | 'medium' | 'low' => c != null,
  );
  const worst = confidences.includes('low') ? 'low' : confidences.includes('medium') ? 'medium' : 'high';
  const surcharge = worst === 'low' ? 1.5 : worst === 'medium' ? 0.5 : 0;
  return round2(base + surcharge);
}

/**
 * Why this player, in the terms the decision is made in.
 *
 * Short phrases rather than sentences: the card shows them separated by dots,
 * and a paragraph would defeat the point of a compact suggestion. Every one of
 * them comes from a component that is already on the player's own breakdown, so
 * nothing said here is unavailable to check.
 */
function upgradeReasons(candidate: StartSitEvaluation, current: StartSitEvaluation | null): string[] {
  const reasons: string[] = [];

  if (current == null) {
    reasons.push('Fills a slot nobody on your roster can start');
  } else if (current.statusFlag && !candidate.statusFlag) {
    reasons.push('Healthier than the man he replaces');
  }

  /*
   * Said the way a reader would say it.
   *
   * These strings are printed on the waiver card and in its sheet, and they
   * used to read as the engine describing its own inputs: `stronger market
   * expectation (13.5 vs 9.2 pts)`, `role trending up`. The numbers behind them
   * are worth keeping — they are the whole reason to believe the sentence — so
   * the phrase leads with what it means and the figures follow it.
   */
  const mine = candidate.expectation.points;
  const theirs = current?.expectation.points ?? null;
  if (mine != null && theirs != null && mine > theirs) {
    reasons.push(`Market rising — ${mine.toFixed(1)} vs ${theirs.toFixed(1)} pts expected`);
  } else if (mine != null && theirs == null) {
    reasons.push(`Market priced — ${mine.toFixed(1)} pts expected`);
  }

  if (candidate.role.trend === 'rising_high' || candidate.role.trend === 'rising_moderate') {
    reasons.push('Role increasing');
  }

  const news = candidate.components.find((c) => c.key === 'news_recent');
  if (news && !news.unknown && news.value > 0) reasons.push(`Recent news — ${news.display}`);

  /*
   * The movement headline as it was written, rather than de-capitalised.
   *
   * It was lower-cased to sit inside a sentence-cased list of fragments. The
   * list is now a set of short statements that each begin with a capital, so
   * `Multiple markets rising` belongs beside them exactly as the movement
   * engine phrased it.
   */
  if (candidate.movement.direction === 'up' && candidate.movement.headline) {
    reasons.push(candidate.movement.headline);
  }

  if (reasons.length === 0) reasons.push('Scores higher on the evidence available');
  return reasons;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
