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
import { DEFENCE_POSITION, evaluatePlayer, type StartSitEvaluation, type StartSitInput } from './engine.ts';
import { recommendLineup, type LineupRecommendation } from './lineup.ts';
import { depthCap, depthLean } from '../waivers/depthPolicy.ts';

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

/**
 * The most the rest of Sleeper's attention can move a waiver call, in points.
 *
 * Trending adds measure attention, not quality — see `core/market/trending.ts`
 * — so they never touch a projection and never invent a recommendation. What
 * they may do is what a manager does with them: break a near-tie, and lift a
 * call the projection already favours over a bar it only just misses. The #1
 * add of the week is worth three-quarters of a point on the ordering and on
 * the bar; the bottom of the published list is worth almost nothing.
 *
 * Only ever applied to a candidate whose own projection already beats the man
 * he is measured against. A trending surge on a player the numbers say is
 * worse moves nothing.
 */
export const ATTENTION_WEIGHT = 0.75;

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
  /**
   * The order the board draws value adds in: gain, plus the attention nudge,
   * plus the positional lean. Never a points claim, which is `gain`.
   */
  priority: number;
  /** Every factor behind the call, carried so **See why** can say them. */
  basis: WaiverAddBasis;
}

/**
 * Why a value add is on the board, as data rather than prose.
 *
 * The reasons list is for the card. This is for the sheet that has to explain
 * the call — which comparison was made, what bar it had to clear, and which of
 * the supplementary signals moved it — and a sheet that re-derived these from
 * the reason strings would be string-matching its own output.
 */
export interface WaiverAddBasis {
  /**
   * `bench`: measured against the weakest bench player who competes for his
   * slots, the ordinary value-add question. `position`: his position is already
   * at its cap, so he was measured against the weakest player *at his position*
   * and had to be a real upgrade.
   */
  comparedTo: 'bench' | 'position';
  /** The gap he had to clear, in points. */
  bar: number;
  /** This week's market expectation, when there is one. */
  projection: number | null;
  /** The market expectation of the man he is measured against. */
  overProjection: number | null;
  /**
   * The number the screen shows: his projection minus the other man's, and
   * nothing else. Null when either side has no market line.
   *
   * Deliberately not `gain`. The gain is the risk-adjusted grade gap — status,
   * thin data, usage — and it is the right number to *decide* with, because
   * those penalties are real reasons to prefer one player. It is the wrong
   * number to *print as points*: on 25 September 2026 a bench back the market
   * priced at 0.35 pts graded −1.97, and every add on the board looked two
   * points better than any projection said. The call stays on the gain; the
   * card says what the projections say.
   */
  projectionGap: number | null;
  /** Held at his position (healthy, off reserve) and the cap, when capped. */
  depth: { position: string; held: number; cap: number | null };
  /** Sleeper's trending adds, when he is on the list. */
  attention: { rank: number | null; heat: number; nudge: number } | null;
  /** The positional ordering lean applied, in points. Zero for most. */
  lean: number;
}

/** What the rest of Sleeper is adding. Heat is 0–1, rank is 1-based. */
export type WaiverAttention = ReadonlyMap<string, { heat: number; rank: number | null }>;

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
  /**
   * The week and the league's playoff weeks, for the positional depth policy.
   * Absent means week 1 and no playoff window, which only matters to defence.
   */
  calendar?: { week: number; playoffWeeks: readonly number[] };
  /** Sleeper trending adds. Absent or empty moves nothing. */
  attention?: WaiverAttention;
  /**
   * Rostered players the plan will not cut — the market hold in
   * `core/waivers/planner/rosterState.ts`. A value add is never measured
   * against one of them while somebody cuttable is available, because a bar
   * set by a player nobody can drop describes a move nobody can make.
   */
  heldIds?: ReadonlySet<string>;
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
   * Measured against the bench rather than against a starter, because that is
   * who a claim actually costs: the add displaces the last player on the
   * roster, not the one in the slot. A candidate already offered as the answer
   * to a starting slot is not offered again here — he is one decision, and the
   * stronger framing of it has already been made.
   *
   * The bench it is measured against is **his own**, per candidate, and that is
   * load-bearing rather than a refinement: one floor for the whole wire ranked
   * positions against each other instead of players. See `replacementFor`.
   */
  const reserved = new Set(opts.reserveIds ?? []);
  const held = opts.heldIds ?? new Set<string>();
  const depthContext = {
    shape: opts.shape,
    week: opts.calendar?.week ?? 1,
    playoffWeeks: opts.calendar?.playoffWeeks ?? [],
  };
  const attention = opts.attention ?? new Map();

  interface ValueCall {
    evaluation: StartSitEvaluation;
    floor: StartSitEvaluation;
    gain: number;
    priority: number;
    basis: WaiverAddBasis;
  }

  const calls: ValueCall[] = [];
  for (const e of playable) {
    if (spent.has(e.playerId)) continue;
    if ((e.score ?? 0) <= 0) continue;

    /*
     * The positional depth policy, first, because it decides which comparison
     * is the right one. See `core/waivers/depthPolicy.ts`.
     *
     * A position already at its cap is not asking for a spare body. The add
     * would replace somebody at his own position, so that is who he is
     * measured against, and the bar is the starter-upgrade one rather than the
     * half point a free bench spot costs.
     */
    const cap = depthCap(e.position, depthContext);
    const atPosition = heldAt(e.position, opts.roster, rosterEvaluations, reserved);
    const overCap = cap != null && atPosition.length >= cap;
    /*
     * Except a defence. Replacing the one you hold is streaming, which belongs
     * to the defence planner for the reasons given at the upgrade tier above,
     * and the positional comparison must not bring it back in by another door.
     */
    if (overCap && e.position === DEFENCE_POSITION) continue;

    const floor = overCap
      ? weakestScored(cuttableFirst(atPosition, held))
      : replacementFor(e, lineup, opts.roster, rosterEvaluations, opts.reserveIds ?? [], held);
    if (floor == null) continue;

    const gain = round2((e.score ?? 0) - (floor.score ?? 0));
    const bar = overCap ? upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, floor, e) : ROSTER_SPOT_GAIN;

    /*
     * The supplementary signal, and exactly as far as it may go.
     *
     * The projection has to say he is better already — a positive gain — or
     * attention moves nothing at all. Past that, it can lift a call that falls
     * just short of the bar and it can reorder calls that are close.
     */
    const heat = attention.get(e.playerId);
    const nudge = heat && gain > 0 ? round2(ATTENTION_WEIGHT * Math.max(0, Math.min(1, heat.heat))) : 0;
    if (gain <= 0 || gain + nudge < bar) continue;

    const lean = depthLean(e.position);
    calls.push({
      evaluation: e,
      floor,
      gain,
      priority: round2(gain + nudge + lean),
      basis: {
        comparedTo: overCap ? 'position' : 'bench',
        bar,
        projection: e.expectation.points,
        overProjection: floor.expectation.points,
        projectionGap:
          e.expectation.points == null || floor.expectation.points == null
            ? null
            : round2(e.expectation.points - floor.expectation.points),
        depth: { position: e.position, held: atPosition.length, cap },
        attention: heat ? { rank: heat.rank, heat: heat.heat, nudge } : null,
        lean,
      },
    });
  }

  /*
   * At most one over-cap suggestion per position: the best one.
   *
   * Four tight ends that each beat the tight end you hold are one decision —
   * which tight end, if any — and printing all four crowds out the positions
   * that actually need help.
   */
  calls.sort((a, b) => b.priority - a.priority || a.evaluation.name.localeCompare(b.evaluation.name));
  const cappedSeen = new Set<string>();
  const valueAdds: WaiverValueAdd[] = [];
  for (const { evaluation, floor, gain, priority, basis } of calls) {
    if (basis.comparedTo === 'position') {
      if (cappedSeen.has(evaluation.position)) continue;
      cappedSeen.add(evaluation.position);
    }
    valueAdds.push({
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      team: evaluation.team,
      score: evaluation.score,
      gain,
      reasons: valueAddReasons(evaluation, floor, basis),
      statusFlag: evaluation.statusFlag,
      role: { trend: evaluation.role.trend, games: evaluation.role.games },
      overPlayerId: floor.playerId,
      overName: floor.name,
      priority,
      basis,
    });
  }

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
 * The player a candidate actually has to be better than, at his own position.
 *
 * This used to be one number for the whole wire: the weakest scorable man on
 * the bench, whoever he was and whatever he played. That is a comparison
 * between two different scales, and fantasy scoring makes the two scales very
 * far apart — a starting quarterback is a twenty-point week and a fourth
 * receiver is a five-point one, in a league that starts one quarterback. So
 * every startable quarterback on the wire "beat" the last man on the bench by
 * ten or more points, cleared a half-point bar without noticing it was there,
 * and sorted to the top of the board by the size of the artefact. The reported
 * symptom was a page that would not stop recommending backup quarterbacks; the
 * cause was that it was ranking positions against each other rather than
 * players.
 *
 * The bar is therefore drawn from the players who compete for the **same
 * slots** he does. For a quarterback in a one-quarterback league that is the
 * quarterbacks, and nobody else; for a running back in a league with two flexes
 * it is every back, receiver and tight end, because they genuinely contest the
 * same spots and comparing them is the comparison a manager makes. What a slot
 * accepts is read off the league's own shape rather than assumed from a name.
 *
 * Among those players the bar is the weakest one **not already starting** —
 * genuine depth at the position, and what a claim would actually displace. When
 * every one of them is starting there is no depth, and the answer is null
 * rather than the weakest starter: the only argument left for that player is
 * that he would start, which is the upgrade tier's question and carries the
 * upgrade tier's much higher bar. Asking it here would price displacing a
 * starter at the cost of a spare bench body, which is how a free agent a point
 * better than the quarterback you are already playing became a recommendation.
 *
 * The three exclusions the bench floor already had are kept, for the reasons it
 * had them. Reserve players are not the spot a Tuesday claim frees. A ruled-out
 * player's score is a penalty rather than a valuation, and left in he is the
 * weakest man by a distance and every free agent "beats" him. And a player the
 * market has not priced scores near zero for want of anything to read rather
 * than for want of ability — measured against him the whole wire looks like a
 * bargain, which is the same mistake in a different costume.
 *
 * Null when nobody qualifies, and the caller then offers no value add for him
 * at all. A position with nothing behind it is an empty slot, and an empty slot
 * is the upgrade tier's question, already asked and answered above.
 */
function replacementFor(
  candidate: StartSitEvaluation,
  lineup: LineupRecommendation,
  roster: StartSitInput[],
  evaluations: Map<string, StartSitEvaluation>,
  reserveIds: string[],
  heldIds: ReadonlySet<string> = new Set(),
): StartSitEvaluation | null {
  const slots = lineup.slots.filter((s) => s.accepts.includes(candidate.position));
  if (slots.length === 0) return null;

  const starting = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const reserved = new Set(reserveIds);

  const usable: StartSitEvaluation[] = [];
  for (const input of roster) {
    const evaluation = evaluations.get(input.player.id);
    if (!evaluation || reserved.has(evaluation.playerId)) continue;
    if (evaluation.score == null || evaluation.ruledOut) continue;
    if (evaluation.expectation.points == null) continue;
    if (!slots.some((s) => s.accepts.includes(evaluation.position))) continue;
    usable.push(evaluation);
  }
  if (usable.length === 0) return null;

  const benched = cuttableFirst(
    usable.filter((e) => !starting.has(e.playerId)),
    heldIds,
  );
  if (benched.length === 0) return null;
  return benched.reduce((worst, e) => ((e.score ?? 0) < (worst.score ?? 0) ? e : worst));
}

/**
 * The players a claim could actually cut, or everyone when nobody can be.
 *
 * The market hold keeps well-drafted and heavily-added players off the cut
 * list, and the bar a value add is measured against has to come from the same
 * list, or the board says `Better than RJ Harvey` beside a plan that refuses to
 * cut him. When every candidate is held the hold yields, exactly as the cut
 * planner's does, and the weakest of them is the bar again.
 */
function cuttableFirst(players: StartSitEvaluation[], heldIds: ReadonlySet<string>): StartSitEvaluation[] {
  const cuttable = players.filter((e) => !heldIds.has(e.playerId));
  return cuttable.length > 0 ? cuttable : players;
}

/**
 * Everybody the roster holds at one position who could actually play.
 *
 * Off reserve and not ruled out: a tight end on injured reserve is not the
 * tight end a claim is measured against, and counting him toward the cap would
 * tell a roster with its only healthy tight end hurt that it is full.
 */
function heldAt(
  position: string,
  roster: StartSitInput[],
  evaluations: Map<string, StartSitEvaluation>,
  reserved: ReadonlySet<string>,
): StartSitEvaluation[] {
  const out: StartSitEvaluation[] = [];
  for (const input of roster) {
    const evaluation = evaluations.get(input.player.id);
    if (!evaluation || evaluation.position !== position) continue;
    if (reserved.has(evaluation.playerId) || evaluation.ruledOut) continue;
    out.push(evaluation);
  }
  return out;
}

/**
 * The weakest of them who can be compared at all.
 *
 * A player with no market is left out for the reason `replacementFor` leaves
 * him out: his near-zero score is an absence of data, and measured against it
 * every free agent at the position looks like a bargain.
 */
function weakestScored(held: StartSitEvaluation[]): StartSitEvaluation | null {
  const scored = held.filter((e) => e.score != null && e.expectation.points != null);
  if (scored.length === 0) return null;
  return scored.reduce((worst, e) => ((e.score ?? 0) < (worst.score ?? 0) ? e : worst));
}

/**
 * Why he is worth a roster spot, in the terms that decision is made in.
 *
 * Deliberately not `upgradeReasons`: that one opens with how he compares to the
 * man in the slot, and there is no slot here. The comparison that matters is
 * the bench, and naming the player who would go is what turns "best available"
 * into a move the reader can actually picture making.
 */
function valueAddReasons(candidate: StartSitEvaluation, floor: StartSitEvaluation, basis: WaiverAddBasis): string[] {
  /*
   * Which comparison was made, said in the words it was made in.
   *
   * The bench comparison is against the weakest man who competes for his
   * slots, which for a flex-eligible player is often a different position — so
   * the sentence names it as a flex option rather than calling a running back
   * "your weakest tight end". The positional comparison names the position,
   * because that is the whole of what changed.
   */
  const reasons: string[] =
    basis.comparedTo === 'position'
      ? [`Clear upgrade on ${floor.name}, the weaker ${floor.position} you hold`]
      : floor.position === candidate.position
        ? [`Worth more than ${floor.name}, your weakest ${floor.position} option on the bench`]
        : [`Worth more than ${floor.name}, your weakest flex option on the bench`];

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
