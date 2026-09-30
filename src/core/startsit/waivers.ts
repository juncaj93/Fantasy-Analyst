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
import {
  basisLabel,
  buildCutPool,
  planMoves,
  compareOnYardstick,
  readYardstick,
  standingOf,
  type MoveCandidate,
  type WaiverMoveGroup,
  type YardstickBasis,
  type YardstickReading,
} from '../waivers/yardstick.ts';
import { dropSignal, mostAddedLine, propsEdge, recentDropNote, type PropsEdge } from '../waivers/signals.ts';

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
  /**
   * Who a claim for him would drop: the plan's own choice, from
   * `core/waivers/yardstick.ts`. Null when nothing on the roster can go.
   */
  cut?: { playerId: string; name: string } | null;
  /** Short lines the card shows under the numbers: warnings and colour. */
  notes?: string[];
  /** Set when he is kept out of the plan, with the reason his card shows. */
  planExcluded?: string | null;
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
  /**
   * Which yardstick the comparison used: `market` when both players are fully
   * priced, `sleeper` (Sleeper's published projection for both) otherwise.
   * Absent on an older payload.
   */
  yardstick?: YardstickBasis;
  /** The Vegas props comparison against your bench at his position, when one fired. */
  props?: { verdict: PropsEdge['verdict']; line: string; nudge: number } | null;
  /** Sleeper's trending drops, when he is on the list. */
  dropped?: { rank: number; nudge: number } | null;
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
  /**
   * The claims, grouped by the drop each would make. Read by the claim plan;
   * the same object every card's `Better than` name came from.
   */
  moveGroups: WaiverMoveGroup[];
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
   * Rostered players the market says to hold — the market hold in
   * `core/waivers/planner/rosterState.ts` — each with its short reason. A claim
   * cuts one only when nobody else can go.
   */
  heldIds?: ReadonlySet<string> | ReadonlyMap<string, string>;
  /**
   * Sleeper's published weekly projection, by player id: the fallback
   * yardstick when a pair is not both fully priced. Owner-approved for waivers
   * on 30 September 2026 and labelled `Sleeper projection` wherever it shows.
   * Absent means no fallback, so only fully priced pairs can be compared.
   */
  published?: ReadonlyMap<string, number>;
  /** Bench players who back up one of your starters, and whom. Cut last. */
  handcuffs?: ReadonlyMap<string, { playerId: string; name: string }>;
  /** Sleeper trending drops. The top ten are kept out of the plan. */
  trendingDrops?: WaiverAttention;
  /** Free agents this roster dropped, with when. Said on the card, never hidden. */
  recentlyDropped?: ReadonlyMap<string, string>;
  /** Free roster spots, bench included and IR excluded. */
  openSpots?: number;
  now?: Date;
}): WaiverAdvice {
  const base = opts.minGain ?? MEANINGFUL_UPGRADE_GAIN;
  const perSlot = opts.alternatives ?? DEFAULT_ALTERNATIVES;
  const rostered = new Set(opts.rosteredPlayerIds);
  const notes: string[] = [];
  const now = opts.now ?? new Date();
  const published = opts.published ?? new Map<string, number>();

  const lineup =
    opts.lineup ??
    recommendLineup(opts.roster, opts.shape, opts.profile, {
      ...(opts.currentStarterIds ? { currentStarterIds: opts.currentStarterIds } : {}),
      ...(opts.published ? { published: opts.published } : {}),
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

  const propsOf = new Map([...opts.roster, ...unrostered].map((i) => [i.player.id, i.props ?? []] as const));
  const evaluated = unrostered.map((c) => evaluatePlayer(c, opts.profile));
  const rosterEvaluations = new Map(opts.roster.map((i) => [i.player.id, evaluatePlayer(i, opts.profile)]));
  const readings = new Map<string, YardstickReading>();
  const readingOf = (e: StartSitEvaluation): YardstickReading => {
    const hit = readings.get(e.playerId);
    if (hit) return hit;
    const reading = readYardstick(e, propsOf.get(e.playerId) ?? [], published.get(e.playerId));
    readings.set(e.playerId, reading);
    return reading;
  };

  /*
   * A candidate has to be readable, playable and still movable.
   *
   * Readable now includes Sleeper's published projection: a free agent no book
   * has priced and no news has touched is still comparable on the published
   * figure, and on 30 September 2026 that was most of the wire. Ruled out is
   * ruled out, and a player whose game has kicked off cannot be added into this
   * week's lineup at all.
   */
  const readable = (e: StartSitEvaluation) => {
    const r = readingOf(e);
    return r.market != null || r.sleeper != null;
  };
  const playable = evaluated.filter((e) => readable(e) && !e.ruledOut && !e.lock.locked);
  /*
   * The ones there was nothing to read on, counted apart from the ones ruled out.
   * Only these may be described to a reader as unknown. See `emptyBoardHeadline`.
   */
  const unscored = evaluated.filter((e) => !readable(e)).length;

  const reserved = new Set(opts.reserveIds ?? []);
  const heldNotes: ReadonlyMap<string, string> =
    opts.heldIds instanceof Map
      ? opts.heldIds
      : new Map([...(opts.heldIds ?? new Set<string>())].map((id) => [id, 'the market still rates him'] as const));
  const starterIds = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));

  /*
   * Everyone a claim could drop, weakest first, on one scale.
   *
   * Built once, here, and read by every comparison below — the starter
   * upgrades, the bench adds and the plan's grouping — so the card and the
   * plan cannot name two different cuts.
   */
  const pool = buildCutPool({
    roster: opts.roster.map((i) => readingOf(rosterEvaluations.get(i.player.id)!)),
    starterIds,
    reserveIds: reserved,
    ruledOutIds: new Set([...rosterEvaluations.values()].filter((e) => e.ruledOut).map((e) => e.playerId)),
    held: heldNotes,
    handcuffs: opts.handcuffs ?? new Map(),
    excludedPositions: new Set([DEFENCE_POSITION]),
  });

  interface Considered {
    slot: (typeof lineup.slots)[number];
    need: 'unfilled' | 'upgrade';
    bar: number;
    current: StartSitEvaluation | null;
    ranked: { evaluation: StartSitEvaluation; gain: number; bar: number; basis: YardstickBasis | null }[];
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
     * Swapping one rostered defence for a better one every week is streaming,
     * which is the defence planner's decision, so the emergent version is
     * switched off here on purpose.
     */
    if (need === 'upgrade' && isDefenceOnlySlot(slot)) continue;

    /*
     * The starter comparison, on the same yardstick as every other one.
     *
     * An empty slot has no bar: anybody readable beats nobody, ranked on his
     * own projection. Otherwise the candidate is measured against the man in
     * the slot with {@link compareOnYardstick} — market against market when
     * both are fully priced, Sleeper against Sleeper when not — and has to
     * clear the starter bar, half a point higher on a borrowed number.
     */
    const ranked = playable
      .filter((e) => slot.accepts.includes(e.position))
      .map((e) => {
        if (current == null) {
          return { evaluation: e, gain: standingOf(readingOf(e)) ?? 0, bar: 0, basis: null };
        }
        const comparison = compareOnYardstick(readingOf(e), readingOf(current));
        if (!comparison) return null;
        const bar = round2(base + (comparison.basis === 'sleeper' ? 0.5 : 0));
        return { evaluation: e, gain: comparison.gap, bar, basis: comparison.basis };
      })
      .filter((c): c is NonNullable<typeof c> => c != null && c.gain >= c.bar && c.gain > 0)
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
  const upgradeEntries: { entry: Considered; picked: Considered['ranked'] }[] = [];
  for (const entry of considered) {
    const available = entry.ranked.filter((c) => !spent.has(c.evaluation.playerId)).slice(0, perSlot);
    if (available.length === 0) continue;
    for (const c of available) spent.add(c.evaluation.playerId);
    upgradeEntries.push({ entry, picked: available });
  }

  /*
   * The second question, asked of everybody the first one did not spend:
   * worth a roster spot, measured against the player a claim would drop.
   */
  const depthContext = {
    shape: opts.shape,
    week: opts.calendar?.week ?? 1,
    playoffWeeks: opts.calendar?.playoffWeeks ?? [],
  };
  const attention = opts.attention ?? new Map();
  const drops = opts.trendingDrops ?? new Map();

  const slotsFor = (position: string) => lineup.slots.filter((s) => s.accepts.includes(position));
  const competesWith = (position: string) => {
    const slots = slotsFor(position);
    return (other: string) => slots.some((s) => s.accepts.includes(other));
  };

  interface Extra {
    evaluation: StartSitEvaluation;
    atPosition: number;
    cap: number | null;
    heat: { heat: number; rank: number | null } | undefined;
    lift: number;
    lean: number;
    props: PropsEdge | null;
    dropped: ReturnType<typeof dropSignal>;
    dropRank: number | null;
    recent: string | null;
  }
  const extras = new Map<string, Extra>();
  const moveCandidates: MoveCandidate[] = [];

  const benchFor = (position: string) =>
    pool.candidates
      .filter((c) => !c.starting && c.reading.position === position)
      .map((c) => ({ playerId: c.reading.playerId, name: c.reading.name, position, props: propsOf.get(c.reading.playerId) ?? [] }));

  const extraFor = (e: StartSitEvaluation, atPosition: number, cap: number | null): Extra => {
    const heat = attention.get(e.playerId);
    const dropEntry = drops.get(e.playerId);
    const props = propsEdge(
      { playerId: e.playerId, name: e.name, position: e.position, props: propsOf.get(e.playerId) ?? [] },
      benchFor(e.position),
    );
    const extra: Extra = {
      evaluation: e,
      atPosition,
      cap,
      heat,
      lift: heat ? round2(ATTENTION_WEIGHT * Math.max(0, Math.min(1, heat.heat))) : 0,
      lean: depthLean(e.position),
      props,
      dropped: dropSignal(dropEntry),
      dropRank: dropEntry?.rank ?? null,
      recent: recentDropNote(opts.recentlyDropped?.get(e.playerId), now),
    };
    extras.set(e.playerId, extra);
    return extra;
  };

  /* The starter upgrades join the plan too: an upgrade still needs a drop. */
  for (const { entry, picked } of upgradeEntries) {
    for (const c of picked) {
      const extra = extraFor(c.evaluation, 0, null);
      moveCandidates.push({
        reading: readingOf(c.evaluation),
        tier: 'upgrade',
        competes: competesWith(c.evaluation.position),
        overCap: false,
        nudges: { lift: 0, order: 0 },
        planExcluded: extra.dropped.planExcluded,
        cleared: true,
        slot: entry.slot.slot,
      });
    }
  }

  for (const e of playable) {
    if (spent.has(e.playerId)) continue;
    /*
     * The positional depth policy, first, because it decides which comparison
     * is the right one. See `core/waivers/depthPolicy.ts`. A position already
     * at its cap is not asking for a spare body: the add would replace somebody
     * at his own position and has to clear the starter-upgrade bar to count.
     */
    const cap = depthCap(e.position, depthContext);
    const atPosition = heldAt(e.position, opts.roster, rosterEvaluations, reserved);
    const overCap = cap != null && atPosition.length >= cap;
    /* Except a defence: replacing the one you hold is the defence planner's call. */
    if (overCap && e.position === DEFENCE_POSITION) continue;
    if (e.position === DEFENCE_POSITION) continue;
    if (slotsFor(e.position).length === 0) continue;

    const extra = extraFor(e, atPosition.length, cap);
    moveCandidates.push({
      reading: readingOf(e),
      tier: 'value',
      competes: competesWith(e.position),
      overCap,
      ...(overCap ? { minBar: MEANINGFUL_UPGRADE_GAIN } : {}),
      nudges: {
        /*
         * Sleeper's trending adds, exactly as far as they went before: a lift
         * of up to three-quarters of a point, and only onto a gap the
         * yardstick already says is positive.
         */
        lift: extra.lift,
        /* Order only, never admission: the lean, Vegas props, and trending drops. */
        order: round2(extra.lean + (extra.props?.nudge ?? 0) + extra.dropped.nudge),
      },
      planExcluded: extra.dropped.planExcluded,
    });
  }

  const plan = planMoves({
    candidates: moveCandidates,
    pool,
    ...(opts.openSpots === undefined ? {} : { openSpots: opts.openSpots }),
  });

  const noteLines = (extra: Extra | undefined): string[] => {
    if (!extra) return [];
    const lines: string[] = [];
    if (extra.dropped.note) lines.push(extra.dropped.note);
    if (extra.recent) lines.push(extra.recent);
    if (extra.props) lines.push(extra.props.line);
    return lines;
  };

  const upgrades: WaiverUpgrade[] = upgradeEntries.map(({ entry, picked }) => ({
    slot: entry.slot.slot,
    accepts: entry.slot.accepts,
    need: entry.need,
    currentPlayerId: entry.slot.playerId,
    currentName: entry.slot.name,
    currentScore: entry.current?.score ?? null,
    bar: entry.bar,
    candidates: picked.map((c) => {
      const move = plan.moves.get(c.evaluation.playerId);
      const extra = extras.get(c.evaluation.playerId);
      return {
        playerId: c.evaluation.playerId,
        name: c.evaluation.name,
        position: c.evaluation.position,
        team: c.evaluation.team,
        score: c.evaluation.score,
        gain: c.gain,
        reasons: yardstickReasons(readingOf(c.evaluation), entry.current ? readingOf(entry.current) : null, c.basis, extra),
        statusFlag: c.evaluation.statusFlag,
        role: { trend: c.evaluation.role.trend, games: c.evaluation.role.games },
        cut: move?.cut ? { playerId: move.cut.reading.playerId, name: move.cut.reading.name } : null,
        notes: noteLines(extra),
        planExcluded: move?.planExcluded ?? null,
      };
    }),
  }));

  const valueAdds: WaiverValueAdd[] = [];
  const valueMoves = [...plan.moves.values()]
    .filter((m) => m.tier === 'value' && m.clears && m.cut && m.comparison)
    .sort((a, b) => b.priority - a.priority || a.playerId.localeCompare(b.playerId));
  /*
   * At most one over-cap suggestion per position: the best one. Four tight
   * ends that each beat the tight end you hold are one decision.
   */
  const cappedSeen = new Set<string>();
  for (const move of valueMoves) {
    const extra = extras.get(move.playerId);
    if (!extra) continue;
    const evaluation = extra.evaluation;
    const cut = move.cut!;
    const comparison = move.comparison!;
    const overCap = extra.cap != null && extra.atPosition >= extra.cap;
    if (overCap) {
      if (cappedSeen.has(evaluation.position)) continue;
      cappedSeen.add(evaluation.position);
    }
    const basis: WaiverAddBasis = {
      comparedTo: overCap ? 'position' : 'bench',
      bar: comparison.bar,
      projection: comparison.addPoints,
      overProjection: comparison.dropPoints,
      projectionGap: comparison.projectionGap,
      depth: { position: evaluation.position, held: extra.atPosition, cap: extra.cap },
      attention: extra.heat ? { rank: extra.heat.rank, heat: extra.heat.heat, nudge: extra.lift } : null,
      lean: extra.lean,
      yardstick: comparison.basis,
      props: extra.props ? { verdict: extra.props.verdict, line: extra.props.line, nudge: extra.props.nudge } : null,
      dropped: extra.dropRank != null ? { rank: extra.dropRank, nudge: extra.dropped.nudge } : null,
    };
    valueAdds.push({
      playerId: evaluation.playerId,
      name: evaluation.name,
      position: evaluation.position,
      team: evaluation.team,
      score: evaluation.score,
      gain: comparison.gap,
      reasons: valueAddReasons(readingOf(evaluation), cut.reading, basis, overCap, extra),
      statusFlag: evaluation.statusFlag,
      role: { trend: evaluation.role.trend, games: evaluation.role.games },
      overPlayerId: cut.reading.playerId,
      overName: cut.reading.name,
      priority: move.priority,
      basis,
      cut: { playerId: cut.reading.playerId, name: cut.reading.name },
      notes: noteLines(extra),
      planExcluded: move.planExcluded,
    });
  }

  /*
   * The plan's groups, trimmed to the players who survived onto the board —
   * the over-cap rule above can drop a claim the grouping had taken.
   */
  const onBoard = new Set([...upgrades.flatMap((u) => u.candidates.map((c) => c.playerId)), ...valueAdds.map((a) => a.playerId)]);
  const moveGroups = plan.groups
    .map((g) => ({ ...g, addIds: g.addIds.filter((id) => onBoard.has(id)) }))
    .filter((g) => g.addIds.length > 0);

  /*
   * And the ones there was nothing to say about, said anyway. Ruled out is
   * left out: he is unavailable on a fact, which is an answer rather than an
   * absence.
   */
  const unknowns: WaiverUnknown[] = evaluated
    .filter((e) => !readable(e) && !e.ruledOut)
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
    moveGroups,
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

/** `1 free agent` / `14 free agents`. */
function freeAgents(count: number): string {
  return `${count} free agent${count === 1 ? '' : 's'}`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The comparison, said the way the card and the plan say it.
 *
 * `Projects 7.0 pts to Jaylen Wright's 3.5 (Sleeper projection for both)`, then
 * what the availability charge is about, then Sleeper's attention as a rank.
 * The yardstick is always named: a reader should never have to guess whether
 * two numbers were the same kind of number.
 */
function comparisonLines(
  add: YardstickReading,
  over: YardstickReading | null,
  basis: YardstickBasis | null,
  extra: { heat?: { rank: number | null } | undefined; evaluation?: StartSitEvaluation } | undefined,
): string[] {
  const lines: string[] = [];
  const mine = basis === 'market' ? add.market : basis === 'sleeper' ? add.sleeper : (add.sleeper ?? add.market);
  const theirs = over && basis ? (basis === 'market' ? over.market : over.sleeper) : null;
  if (mine != null && over && theirs != null && basis) {
    lines.push(`Projects ${mine.toFixed(1)} pts to ${possessive(over.name)} ${theirs.toFixed(1)} (${basisLabel(basis)})`);
  } else if (mine != null) {
    lines.push(`Projects ${mine.toFixed(1)} pts (${add.market != null ? 'Vegas lines' : 'Sleeper projection'})`);
  }
  if (over?.availabilityNote) lines.push(`${over.name}: ${over.availabilityNote}`);
  if (add.availabilityNote) lines.push(add.availabilityNote);
  else if (add.practiceNote) lines.push(capitalise(add.practiceNote));
  const rank = extra?.heat?.rank ?? null;
  if (rank != null) lines.push(mostAddedLine(rank));
  const trend = extra?.evaluation?.role.trend;
  if (trend === 'rising_high' || trend === 'rising_moderate') lines.push('Role increasing');
  return lines;
}

function yardstickReasons(
  add: YardstickReading,
  current: YardstickReading | null,
  basis: YardstickBasis | null,
  extra: { heat?: { rank: number | null } | undefined; evaluation?: StartSitEvaluation } | undefined,
): string[] {
  const lines = current == null ? ['Fills a slot nobody on your roster can start'] : [];
  lines.push(...comparisonLines(add, current, basis, extra));
  return lines.length > 0 ? lines : ['Scores higher on the evidence available'];
}

function valueAddReasons(
  add: YardstickReading,
  cut: YardstickReading,
  basis: WaiverAddBasis,
  overCap: boolean,
  extra: { heat?: { rank: number | null } | undefined; evaluation?: StartSitEvaluation } | undefined,
): string[] {
  const lead = overCap
    ? `Clear upgrade on ${cut.name}, the weaker ${cut.position} you hold`
    : cut.position === add.position
      ? `Worth more than ${cut.name}, your weakest ${cut.position} option on the bench`
      : `Worth more than ${cut.name}, your weakest flex option on the bench`;
  return [lead, ...comparisonLines(add, cut, basis.yardstick ?? null, extra)];
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
