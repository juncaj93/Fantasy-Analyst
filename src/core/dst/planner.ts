/**
 * Whether a defence is worth a roster spot — this week, over the next few
 * weeks, and in December.
 *
 * The product this app deliberately withheld when defences became scorable.
 * Making a DST scorable makes "somebody better is available" true almost every
 * week, because the gap between the best and worst defence on a slate is
 * comfortably over any upgrade bar. That fact is not advice. It is the reason
 * this module exists: the useful question is never *is there a better defence*,
 * it is **is the better defence worth what taking him costs** — a transaction,
 * a bench spot, and whatever that bench spot was going to become.
 *
 * ## The manager this is written for
 *
 * One who often drafts no defence at all, spends the last bench slot on a
 * skill-position flier, adds a DST in the week before the season, streams
 * through the year, holds a good one through a soft run, occasionally carries a
 * second into the playoffs, and never trades for one. Every state below exists
 * because that manager needs it, and `wait` is first among them: **there is no
 * assumption anywhere here that a defence must be rostered at all times.**
 *
 * ## What stops it recommending a swap every week
 *
 * Three things, and they compose:
 *
 *   1. **Replacement level, not the best free agent.** The comparison runs
 *      through {@link assessStreaming}, which sets the wire's level at the
 *      *median of the top few* rather than at its best week. A defence that
 *      only beats the single best free agent has not beaten the wire.
 *   2. **A churn bar.** {@link DST_PLAN.churnGain} points, the same bar
 *      `MEANINGFUL_UPGRADE_GAIN` sets for spending a roster move anywhere else
 *      in this app, and a wider one when either side of the comparison is
 *      thinly known.
 *   3. **The roster spot's own price.** `netGain = points gained − points the
 *      slot was already earning`, in the same weekly points, from the same
 *      `bench.ts` valuation the drop list is built from. A +3.5 defence is not
 *      worth a bench player earning +4.
 *
 * ## What it never does
 *
 * It never adds, drops, claims or bids: every state here is a sentence, and the
 * transaction happens in Sleeper by hand. It never recommends a defence in a
 * league that starts none, or in a best-ball league where there is no weekly
 * decision to make. It never carries a second defence by default. And it never
 * invents a future line — see `outlook.ts` for what it uses instead, and for
 * how loudly that says it is not a line.
 */

import { assessStreaming, type StreamingAssessment } from '../startsit/streaming.ts';
import { MEANINGFUL_UPGRADE_GAIN } from '../startsit/waivers.ts';
import { DEFENCE_POSITION } from '../startsit/engine.ts';
import type { RosterShape } from '../sleeper/scoring.ts';
import type { DstOutlook } from './outlook.ts';
import { DST_OUTLOOK } from './outlook.ts';

export { assessStreaming };

/**
 * The seven things this planner is allowed to say.
 *
 * Deliberately compact and deliberately including `wait` and `unknown`: a
 * planner whose vocabulary is only actions will always find one.
 */
export type DstDecision = 'wait' | 'add' | 'hold' | 'stream' | 'stash' | 'stream_and_stash' | 'unknown';

/**
 * Why the planner is or is not speaking.
 *
 * Reported rather than inferred from silence, because "no advice" and "advice
 * suppressed because this is a best-ball league" are different states and a
 * screen that cannot tell them apart will eventually draw the wrong one.
 */
export type DstActivation =
  /** The league starts no defence. Nothing about a DST belongs on any screen. */
  | 'no_def_slot'
  /** Best ball: there are no weekly decisions, so there is no weekly advice. */
  | 'best_ball'
  /** No draft has finished. Nobody needs a defence for a season not yet begun. */
  | 'pre_draft'
  /** Drafted, but the next kickoff is far enough away that nothing is urgent. */
  | 'outside_window'
  /** Inside the action window, or acting early on something that needs it. */
  | 'active';

export const DST_PLAN = {
  /**
   * How close the next kickoff has to be before weekly advice activates.
   *
   * Seventy-two hours, and a duration rather than a date: an arbitrary calendar
   * cut-off is wrong in every league whose draft is late, whose first game is a
   * Thursday, or whose reader opens the app on a Tuesday. Three days is the
   * window in which a waiver run resolves and a lineup is set, which is when a
   * defence is actually acquirable.
   */
  actionWindowHours: 72,
  /**
   * Points a swap has to gain before it is worth making.
   *
   * The same {@link MEANINGFUL_UPGRADE_GAIN} every other add in this app has to
   * clear, for the same reason: a transaction costs a roster move, a waiver
   * priority and somebody's bench spot, and a tenth of a point does not buy it.
   */
  churnGain: MEANINGFUL_UPGRADE_GAIN,
  /**
   * ...and when either side of the comparison is thinly known.
   *
   * A four-point gap measured between two well-priced defences means what it
   * says; the same gap where one side rests on a league that scores no points
   * allowed is mostly an artefact of the missing side. Four points is roughly
   * half a defensive week — big enough that a thin read has to be obviously
   * right rather than merely arithmetically ahead.
   */
  lowConfidenceChurnGain: 4,
  /**
   * ...and when the bench player an add would cost cannot be scored at all.
   *
   * A bar, never a price. The app does not know what an unscorable flier is
   * worth and will not put a number on him; what it can do is refuse to trade
   * him for a marginal defence, which is what a wider bar is.
   */
  unscorableDropGain: 4,
  /** Weeks of forward view behind a hold. */
  holdHorizon: DST_OUTLOOK.horizon,
  /**
   * Per-week points a second defence must clear its slot cost by.
   *
   * Measured *against the wire*, not against zero: a stash only earns its slot
   * if it beats what could have been streamed in that week anyway, which is the
   * whole reason most stashes are not worth making.
   */
  stashMargin: 1.5,
  /**
   * What a bench slot given to a second defence is charged, as a multiple.
   *
   * Higher than a like-for-like add because the slot is occupied for the whole
   * carry and pays only in the playoff weeks — the amortisation is done
   * explicitly below, and this is the premium on top of it for holding a player
   * you are not starting.
   */
  secondSlotMultiplier: 1.5,
  /** Playoff emphasis at or above which a stash is worth planning at all. */
  stashEmphasis: 0.5,
  /**
   * How far ahead a bye is acted on.
   *
   * Two weeks. `BYE_LOOKAHEAD_WEEKS` is four for a roster-wide plan, which is
   * the right window for "add cover before it is urgent"; a defence needs less,
   * because the cover is a two-dollar add that will still be there next week and
   * a four-week warning about one is noise.
   */
  byeLookahead: 2,
} as const;

/** A defence, as this planner needs to see one. */
export interface DstOption {
  playerId: string;
  name: string;
  team: string;
  /** This week's score, through the shipped engine. Null when unscorable. */
  thisWeek: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** Cannot be started this week — on bye, ruled out, or already kicked off. */
  unavailable: boolean;
  /** Why not, when so. */
  unavailableReason: string | null;
  /**
   * The game has started, which is a different unavailability from the rest.
   *
   * A defence on a bye leaves a hole somebody has to fill; a defence whose game
   * has kicked off leaves a slot that is *settled*. The first is a decision and
   * the second is a fact, and advising on the second would be offering an
   * action the reader cannot take — the rule every lock state in this app is
   * held to.
   */
  locked: boolean;
  opponent: string | null;
  opponentImpliedTotal: number | null;
  /** The next few weeks. Null when the schedule has not reached this app. */
  forward: DstOutlook | null;
  /** The league's own playoff weeks. Null outside a stash window. */
  playoff: DstOutlook | null;
}

/** The bench player an add would displace, priced the way the drop list prices one. */
export interface DstDropCandidate {
  playerId: string;
  name: string;
  position: string;
  /**
   * Weekly points the slot earns above what the wire would put in it.
   *
   * `bench.ts`'s `surplus`, unchanged. Null when he could not be scored, which
   * is a real and common state in September and is never turned into a zero:
   * zero would read as "this slot is earning nothing", which is a finding, and
   * what is actually true is that the app does not know.
   */
  surplus: number | null;
}

export interface DstRosterCost {
  /** Spots free right now. An add into one of these displaces nobody. */
  openSpots: number;
  needsDrop: boolean;
  dropCandidate: DstDropCandidate | null;
  /** Weekly points sacrificed. Null whenever it could not be scored. */
  points: number | null;
  /** Always said in words, whether or not there is a number. */
  label: string;
}

export interface DstEvidence {
  key: string;
  label: string;
  value: string;
}

export interface DstPlan {
  decision: DstDecision;
  activation: DstActivation;
  /** Whether a screen should draw anything at all. */
  surface: boolean;
  /** The compact line. Empty string only when `surface` is false. */
  headline: string;
  /** Tap: why. Two or three sentences at most. */
  why: string[];
  /** Deeper tap: what it was decided on. */
  evidence: DstEvidence[];
  /** The defence to add or stream to. */
  target: DstOption | null;
  /** The defence to carry for the playoffs. */
  stash: DstOption | null;
  /** The rostered defence this was decided against. */
  current: DstOption | null;
  /** Points this week over what is rostered. Null when there is no comparison. */
  gain: number | null;
  /** The bar that gain had to clear, so it is never invisible. */
  bar: number | null;
  cost: DstRosterCost;
  /** True when the recommendation covers one week rather than replacing anybody. */
  temporary: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** The league's own playoff weeks, never a hard-coded 15–17. */
  playoffWeeks: number[];
  notes: string[];
}

export interface DstPlanInput {
  now: string | Date;
  currentWeek: number;
  shape: RosterShape;
  /** Best ball, as Sleeper states it. Unstated is not best ball. */
  bestBall: boolean;
  /** Whether a draft has actually finished — never a calendar date. */
  draftComplete: boolean;
  /** The kickoff this advice would have to be acted on before. */
  nextKickoff: string | null;
  /** Rostered defences. More than one means a stash is already being carried. */
  rostered: DstOption[];
  /** Unrostered defences, bounded by the caller. */
  available: DstOption[];
  /** The wire's own level, from the shared streaming read. */
  streaming: StreamingAssessment | null;
  roster: { openSpots: number; dropCandidate: DstDropCandidate | null };
  playoff: { weeks: number[]; emphasis: number };
}

const NO_COST: DstRosterCost = {
  openSpots: 0,
  needsDrop: false,
  dropCandidate: null,
  points: 0,
  label: 'no roster spot needed',
};

export function planDst(input: DstPlanInput): DstPlan {
  const slots = input.shape.starters[DEFENCE_POSITION] ?? 0;
  const playoffWeeks = [...input.playoff.weeks].sort((a, b) => a - b);

  /* Nothing about a defence belongs anywhere in a league that starts none. */
  if (slots === 0) {
    return silent('no_def_slot', playoffWeeks, ['this league does not start a defence']);
  }
  /*
   * Best ball has no weekly decision, so it gets no weekly advice.
   *
   * There is no lineup to set, no waiver run to win and no bench spot being
   * chosen between — the whole apparatus above is about acting in a week, and a
   * format that removes the acting removes the advice rather than restating it
   * quietly.
   */
  if (input.bestBall) {
    return silent('best_ball', playoffWeeks, ['best ball: there is no weekly add, drop or start to advise on']);
  }
  if (!input.draftComplete) {
    return silent('pre_draft', playoffWeeks, ['no draft has finished, so there is no weekly acquisition pressure yet']);
  }

  const rostered = [...input.rostered].sort(byScoreDescending);
  const current = rostered[0] ?? null;
  const available = [...input.available].sort(byScoreDescending);
  const cost = priceCost(input.roster);

  /*
   * A league that starts two defences is a different game, played honestly.
   *
   * One-defence streaming philosophy applied to a two-defence league would tell
   * a manager to carry one and stream the other slot weekly, which is not a
   * strategy, it is a lineup with a hole in it. The requirement is read off the
   * shape and met: below it, fill it; at it, hold. `RosterShape` is an
   * objective property of the league and this is not a league-name exception.
   */
  if (slots > 1) return multiDefence({ slots, rostered, available, cost, playoffWeeks, input });

  const window = activationWindow(input, current);
  const streamable = available.filter((o) => o.thisWeek != null && !o.unavailable);
  const best = streamable[0] ?? null;

  /* ------------------------------------------------------------- no defence */

  if (!current) {
    if (!window.active) {
      return {
        ...base(playoffWeeks),
        decision: 'wait',
        activation: window.activation,
        surface: true,
        headline: 'Wait — no DST needed yet',
        why: [
          window.reason,
          'A defence is a two-dollar add in the week it is needed, and the bench spot is worth more until then.',
        ],
        cost,
      };
    }
    if (!best) {
      return unavailablePlan(playoffWeeks, cost, 'no available defence can be scored this week');
    }

    /*
     * An empty starting slot is a guaranteed zero, so the whole projection is
     * the gain.
     *
     * Not a comparison against replacement level — there is nobody in the slot
     * to compare with — and the only question left is whether the spot it takes
     * was earning more than the slot it fills, which is what the bar below is.
     */
    const bar = cost.needsDrop ? barFor(best, cost) : 0;
    const gain = round2(best.thisWeek ?? 0);
    if (gain < bar) {
      return {
        ...base(playoffWeeks),
        decision: 'wait',
        activation: window.activation,
        surface: true,
        headline: 'Wait — no DST worth the bench spot',
        why: [
          `The best available defence projects ${gain.toFixed(1)} pts, and filling the slot would cost ${cost.label}.`,
        ],
        evidence: evidenceFor({ target: best, current: null, cost, gain, bar }),
        target: best,
        gain,
        bar,
        cost,
        confidence: best.confidence,
      };
    }

    const stash = considerStash({ input, current: null, target: best, available, cost, playoffWeeks });
    return {
      ...base(playoffWeeks),
      decision: stash ? 'stream_and_stash' : 'add',
      activation: window.activation,
      surface: true,
      headline: stash
        ? `Add ${best.team} now · stash ${stash.option.team} for playoffs`
        : `Week ${input.currentWeek} · Add ${best.team}`,
      why: [
        `Nothing is in the DEF slot, and ${best.name} is the best defence available at ${gain.toFixed(1)} pts.`,
        ...(cost.needsDrop ? [`It costs ${cost.label}.`] : ['There is room for him without dropping anybody.']),
        ...(stash ? [stash.why] : []),
      ],
      evidence: evidenceFor({ target: best, current: null, cost, gain, bar, stash: stash?.option ?? null }),
      target: best,
      stash: stash?.option ?? null,
      gain,
      bar,
      cost,
      confidence: best.confidence,
      notes: stash ? stash.notes : [],
    };
  }

  /* ------------------------------------------------- a defence is rostered */

  if (!window.active) {
    return {
      ...base(playoffWeeks),
      decision: 'hold',
      activation: window.activation,
      /* Nothing to do, and nothing to say about having nothing to do. */
      surface: false,
      headline: '',
      why: [window.reason],
      current,
      cost,
      confidence: current.confidence,
    };
  }

  if (current.thisWeek == null && !current.unavailable) {
    return { ...unavailablePlan(playoffWeeks, cost, `${current.name} cannot be scored this week`), current };
  }

  /*
   * A settled slot is not a decision any more, so it gets no advice.
   *
   * The rule `waivers.ts` states for every other slot, applied here: once this
   * defence's game has started the swap is not available to make, and a card
   * offering one is offering an action the reader cannot take. Quiet rather
   * than wrong — next week's decision arrives with next week's lines.
   */
  if (current.locked) {
    return {
      ...base(playoffWeeks),
      decision: 'hold',
      activation: window.activation,
      surface: false,
      headline: '',
      why: [`${current.name} has already kicked off, so the DEF slot is settled for this week.`],
      current,
      cost,
      confidence: current.confidence,
      notes: ['the defence in the lineup has played — this week\u2019s DEF decision is closed'],
    };
  }

  /*
   * A bye is a week without a defence, not evidence the defence is bad.
   *
   * Handled before the streaming comparison and reported as what it is: a
   * one-week fill, with the incumbent still the incumbent. Treating it as an
   * upgrade would drop a defence held all season over a week off.
   */
  if (current.unavailable) {
    if (!best) return { ...unavailablePlan(playoffWeeks, cost, `${current.name} is out this week and nobody available can be scored`), current };
    const gain = round2((best.thisWeek ?? 0) - 0);
    return {
      ...base(playoffWeeks),
      decision: 'stream',
      activation: window.activation,
      surface: true,
      headline: `Stream ${best.team} — ${current.team} ${current.unavailableReason ?? 'unavailable'}`,
      why: [
        `${current.name} ${current.unavailableReason ?? 'cannot play'} this week, so the slot needs a body for one week.`,
        `${best.name} is the best available at ${gain.toFixed(1)} pts.`,
        'This is a one-week fill, not a replacement — the hold decision comes back next week.',
      ],
      evidence: evidenceFor({ target: best, current, cost, gain, bar: 0 }),
      target: best,
      current,
      gain,
      bar: 0,
      cost,
      temporary: true,
      confidence: best.confidence,
      notes: [`${current.name} returns after the bye and is still the rostered defence`],
    };
  }

  const byeAhead = upcomingBye(current, input.currentWeek);
  const byeNote = byeAhead == null ? [] : [`${current.team} is on bye in week ${byeAhead} — a one-week fill will be needed`];

  if (!best) {
    return {
      ...base(playoffWeeks),
      decision: 'hold',
      activation: window.activation,
      surface: byeAhead != null,
      headline: byeAhead != null ? `Hold ${current.team} · bye week ${byeAhead}` : `Hold ${current.team}`,
      why: ['Nobody available at DEF can be scored this week, so there is nothing to stream to.'],
      current,
      cost,
      confidence: current.confidence,
      notes: byeNote,
    };
  }

  /*
   * The comparison, against the wire rather than against one good week.
   *
   * `assessStreaming` sets replacement level at the median of the top few
   * available defences, which is what the wire will still look like next week.
   * The single best free agent is one defence's favourable afternoon, and
   * building a swap on it is how a roster churns every Tuesday for nothing.
   */
  const replacement = input.streaming?.replacementLevel ?? null;
  const gain = round2((best.thisWeek ?? 0) - (current.thisWeek ?? 0));
  const bar = barFor(best, cost, current);

  const forwardEdge = forwardDifference(best, current);
  const stash = considerStash({ input, current, target: null, available, cost, playoffWeeks });

  /*
   * Multi-week: a defence can be worth holding while somebody is better today.
   *
   * Two conditions rather than one blended number, because they are measured
   * over different lengths of time and adding them would let a three-week total
   * quietly outvote a bar written for one week:
   *
   *   - the **weekly gain** still has to clear the churn bar, or there is no
   *     swap to argue about;
   *   - and the **horizon** — this week's gain plus what each defence is worth
   *     across the next few — must not be a net loss. Streaming means giving up
   *     the incumbent's schedule as well as taking the challenger's, and a
   *     half-point edge on Sunday that costs two points a week for a month is
   *     the trade every weekly comparison in fantasy football makes.
   *
   * With no outlook on either side `forwardEdge` is null and this cannot fire:
   * a hold is never argued from a schedule this app has not read.
   */
  const netOverHorizon = forwardEdge == null ? gain : round2(gain + forwardEdge);
  const holdsForFuture = gain >= bar && forwardEdge != null && netOverHorizon < 0;

  if (gain < bar || holdsForFuture) {
    const headline = holdsForFuture
      ? `Hold ${current.team} — next ${current.forward?.playable ?? DST_PLAN.holdHorizon} favourable`
      : byeAhead != null
        ? `Hold ${current.team} · bye week ${byeAhead}`
        : 'No clear upgrade';
    return {
      ...base(playoffWeeks),
      decision: stash ? 'stash' : 'hold',
      activation: window.activation,
      surface: true,
      headline: stash ? `Hold ${current.team} · stash ${stash.option.team} for ${weekRange(playoffWeeks)}` : headline,
      why: [
        holdsForFuture
          ? `${best.name} is ${gain.toFixed(1)} pts better this week, but ${current.name} is worth more over the next ${current.forward?.playable ?? DST_PLAN.holdHorizon} weeks.`
          : `${best.name} is ${gain.toFixed(1)} pts better this week, which does not clear the ${bar.toFixed(1)} pt bar for spending a move.`,
        ...(replacement != null
          ? [`The wire's level at DEF is ${replacement.toFixed(1)} pts, so this is not a scarce upgrade.`]
          : []),
        ...(stash ? [stash.why] : []),
      ],
      evidence: evidenceFor({ target: best, current, cost, gain, bar, replacement, stash: stash?.option ?? null }),
      target: null,
      stash: stash?.option ?? null,
      current,
      gain,
      bar,
      cost,
      confidence: weakest(current.confidence, best.confidence),
      notes: [...byeNote, ...(stash ? stash.notes : [])],
    };
  }

  return {
    ...base(playoffWeeks),
    decision: stash ? 'stream_and_stash' : 'stream',
    activation: window.activation,
    surface: true,
    headline: stash
      ? `Stream ${best.team} this week · stash ${stash.option.team} for ${weekRange(playoffWeeks)}`
      : `Stream ${best.team} over ${current.team} · +${gain.toFixed(1)}`,
    why: [
      `${best.name} projects ${gain.toFixed(1)} pts better than ${current.name} this week, clearing the ${bar.toFixed(1)} pt bar.`,
      ...(forwardEdge != null && forwardEdge >= 0
        ? ['The next few weeks point the same way.']
        : forwardEdge != null
          ? ['The gain is this week; the two are closer over the next few.']
          : []),
      ...(cost.needsDrop ? [`It costs ${cost.label}.`] : []),
      ...(stash ? [stash.why] : []),
    ],
    evidence: evidenceFor({ target: best, current, cost, gain, bar, replacement, stash: stash?.option ?? null }),
    target: best,
    stash: stash?.option ?? null,
    current,
    gain,
    bar,
    cost,
    confidence: weakest(current.confidence, best.confidence),
    notes: [...byeNote, ...(stash ? stash.notes : [])],
  };
}

/* ------------------------------------------------------------------ pieces */

/**
 * Whether it is time to say anything, decided on game state rather than a date.
 *
 * A calendar cut-off is wrong in every league whose draft ran late. What is
 * always right is that a defence is worth acquiring when the game it would play
 * in is close enough to act on — and that a schedule change the reader has to
 * act on early overrides the window, because a bye you find out about on
 * Saturday is a bye you cannot cover.
 */
function activationWindow(
  input: DstPlanInput,
  current: DstOption | null,
): { active: boolean; activation: DstActivation; reason: string } {
  const now = new Date(input.now).getTime();
  const kickoff = input.nextKickoff == null ? null : new Date(input.nextKickoff).getTime();

  if (kickoff != null && Number.isFinite(kickoff)) {
    const hours = (kickoff - now) / 3_600_000;
    if (hours <= DST_PLAN.actionWindowHours) {
      return { active: true, activation: 'active', reason: `kickoff is ${Math.max(0, Math.round(hours))} hours away` };
    }
    /*
     * Outside the window, but a bye that has to be covered is acted on anyway.
     *
     * This is the "meaningful schedule change" exception, in the only form the
     * app can actually verify: the rostered defence has no game in a week close
     * enough to matter, and that is worth saying before the window opens.
     */
    if (current && upcomingBye(current, input.currentWeek) != null) {
      return { active: true, activation: 'active', reason: 'a bye is close enough to need covering' };
    }
    return {
      active: false,
      activation: 'outside_window',
      reason: `the next kickoff is ${Math.round(hours)} hours away, which is too early to spend a move on a defence`,
    };
  }

  /*
   * No kickoff known.
   *
   * Treated as outside the window rather than inside it: with the schedule
   * unread, "act now" is a claim about a game this app cannot see, and the cost
   * of being quiet a day too long is far below the cost of telling somebody to
   * spend a waiver claim on a week that has already kicked off.
   */
  return {
    active: false,
    activation: 'outside_window',
    reason: 'no kickoff is known for the coming week, so nothing here is urgent yet',
  };
}

/**
 * The bar a gain has to clear: the churn threshold, plus what the spot costs.
 *
 * Two independent widenings, and they add rather than compete. A thin read
 * widens it because the gap itself is less trustworthy; a bench player who
 * cannot be scored widens it because the app does not know what it is spending.
 */
function barFor(target: DstOption, cost: DstRosterCost, current?: DstOption | null): number {
  const thin = target.confidence === 'low' || current?.confidence === 'low';
  const base = thin ? DST_PLAN.lowConfidenceChurnGain : DST_PLAN.churnGain;
  if (!cost.needsDrop) return round2(base);
  if (cost.points == null) return round2(Math.max(base, DST_PLAN.unscorableDropGain));
  return round2(base + Math.max(0, cost.points));
}

/** What a roster spot costs, in the drop list's own currency or in words. */
function priceCost(roster: DstPlanInput['roster']): DstRosterCost {
  if (roster.openSpots > 0) {
    return {
      openSpots: roster.openSpots,
      needsDrop: false,
      dropCandidate: null,
      points: 0,
      label: `an open roster spot (${roster.openSpots} free)`,
    };
  }
  const candidate = roster.dropCandidate;
  if (!candidate) {
    return {
      openSpots: 0,
      needsDrop: true,
      dropCandidate: null,
      points: null,
      label: 'a bench spot — nobody on the bench could be scored to price it',
    };
  }
  if (candidate.surplus == null) {
    /*
     * Named, and deliberately not numbered.
     *
     * A flier with no market and no usage history is exactly the player this
     * manager keeps the last bench spot for, and putting a confident zero on
     * him would make every marginal defence look free. The bar widens instead.
     */
    return {
      openSpots: 0,
      needsDrop: true,
      dropCandidate: candidate,
      points: null,
      label: `a bench spot — ${candidate.name} cannot be scored, so what it costs is unknown`,
    };
  }
  return {
    openSpots: 0,
    needsDrop: true,
    dropCandidate: candidate,
    points: round2(Math.max(0, candidate.surplus)),
    label: `dropping ${candidate.name} (${candidate.surplus.toFixed(1)} pts a week over the wire)`,
  };
}

/**
 * Whether a second defence earns the slot it would occupy until December.
 *
 * The arithmetic is stated rather than assumed, because "roster a defence for
 * the playoffs" is folklore that costs a bench spot for two months:
 *
 *     per-week gain  = the stash's playoff value − what the wire will offer then
 *     amortised      = per-week gain × playoff weeks played ÷ weeks carried
 *     net            = amortised − the bench spot's own weekly value
 *
 * The wire is in there because the alternative to stashing is *not* fielding
 * nothing in week 15 — it is streaming whatever is free that week, which is
 * usually fine. A stash has to beat that, not beat zero.
 */
function considerStash(args: {
  input: DstPlanInput;
  current: DstOption | null;
  target: DstOption | null;
  available: DstOption[];
  cost: DstRosterCost;
  playoffWeeks: number[];
}): { option: DstOption; why: string; notes: string[] } | null {
  const { input, playoffWeeks } = args;
  if (playoffWeeks.length === 0) return null;
  /*
   * The gate is the app's existing one, not a new opinion about December.
   *
   * `playoffEmphasis` is zero for most of the year and zero for a team not
   * heading there, which is exactly the behaviour a stash needs: a roster spot
   * spent in October on a week-15 matchup is a roster spot spent by a team that
   * may not play in week 15.
   */
  if (input.playoff.emphasis < DST_PLAN.stashEmphasis) return null;
  if (input.currentWeek >= (playoffWeeks[0] ?? 0)) return null;

  const replacement = input.streaming?.replacementLevel ?? null;
  /*
   * With no read on the wire there is no floor to beat, and a stash cannot be
   * justified against an unknown alternative.
   */
  if (replacement == null) return null;

  const held = new Set([args.current?.playerId, args.target?.playerId].filter(Boolean) as string[]);
  const candidates = args.available
    .filter((o) => !held.has(o.playerId))
    .filter((o) => o.playoff?.perWeek != null && o.playoff.playable > 0);
  if (candidates.length === 0) return null;

  const carryWeeks = Math.max(1, (playoffWeeks.at(-1) ?? input.currentWeek) - input.currentWeek + 1);
  const margin =
    args.cost.points == null
      ? DST_PLAN.stashMargin + DST_PLAN.unscorableDropGain / carryWeeks
      : DST_PLAN.stashMargin + args.cost.points * DST_PLAN.secondSlotMultiplier;

  let bestNet = -Infinity;
  let chosen: DstOption | null = null;
  let chosenAmortised = 0;
  for (const option of candidates) {
    const perWeekGain = (option.playoff!.perWeek ?? 0) - replacement;
    const amortised = round2((perWeekGain * option.playoff!.playable) / carryWeeks);
    if (amortised > bestNet) {
      bestNet = amortised;
      chosen = option;
      chosenAmortised = amortised;
    }
  }
  if (!chosen || chosenAmortised < margin) return null;

  const weeks = weekRange(playoffWeeks);
  return {
    option: chosen,
    why: `${chosen.name} is worth ${(chosen.playoff!.perWeek ?? 0).toFixed(1)} pts a week in ${weeks} against a wire level of ${replacement.toFixed(1)}, which clears what the bench spot costs over ${carryWeeks} weeks.`,
    notes: [
      ...(chosen.playoff?.notes ?? []),
      `the stash is judged on ${weeks}, which is this league's own playoff schedule`,
    ],
  };
}

/**
 * What the challenger's next weeks are worth over the incumbent's, in total.
 *
 * Positive means the swap keeps paying after Sunday; negative means the
 * incumbent's schedule is the better one to own. Measured over the weeks *both*
 * defences can be valued for, so a three-week read is never compared against a
 * one-week one. Null whenever either side has no outlook at all.
 */
function forwardDifference(target: DstOption, current: DstOption): number | null {
  const challenger = target.forward?.perWeek ?? null;
  const incumbent = current.forward?.perWeek ?? null;
  if (challenger == null || incumbent == null) return null;
  const weeks = Math.min(target.forward?.playable ?? 0, current.forward?.playable ?? 0);
  if (weeks === 0) return null;
  return round2((challenger - incumbent) * weeks);
}

/** The week a defence's bye falls in, when it is close enough to matter. */
function upcomingBye(option: DstOption, currentWeek: number): number | null {
  const byes = option.forward?.byes ?? [];
  for (const week of byes) {
    if (week > currentWeek && week <= currentWeek + DST_PLAN.byeLookahead) return week;
  }
  return null;
}

/**
 * A league that starts two or more defences, answered on its own terms.
 *
 * No streaming and no stash: with two slots to fill the question is whether
 * they are filled, and the one-defence philosophy — carry none, add late,
 * churn weekly — would leave a slot empty most Sundays.
 */
function multiDefence(args: {
  slots: number;
  rostered: DstOption[];
  available: DstOption[];
  cost: DstRosterCost;
  playoffWeeks: number[];
  input: DstPlanInput;
}): DstPlan {
  const { slots, rostered, available, cost, playoffWeeks } = args;
  const startable = rostered.filter((o) => o.thisWeek != null).length;
  const best = available.find((o) => o.thisWeek != null && !o.unavailable) ?? null;
  const notes = [`this league starts ${slots} defences, so streaming one slot is not the question`];

  if (startable >= slots) {
    return {
      ...base(playoffWeeks),
      decision: 'hold',
      activation: 'active',
      surface: false,
      headline: '',
      why: [`Both DEF slots are filled, which is what a ${slots}-defence league asks for.`],
      current: rostered[0] ?? null,
      cost,
      notes,
    };
  }
  if (!best) return { ...unavailablePlan(playoffWeeks, cost, 'no available defence can be scored'), notes };

  return {
    ...base(playoffWeeks),
    decision: 'add',
    activation: 'active',
    surface: true,
    headline: `Add ${best.team} — ${slots - startable} DEF slot${slots - startable === 1 ? '' : 's'} unfilled`,
    why: [`This league starts ${slots} defences and ${startable} of those slots can be filled from the roster.`],
    evidence: evidenceFor({ target: best, current: null, cost, gain: round2(best.thisWeek ?? 0), bar: 0 }),
    target: best,
    gain: round2(best.thisWeek ?? 0),
    bar: 0,
    cost,
    confidence: best.confidence,
    notes,
  };
}

/* ---------------------------------------------------------------- plumbing */

function base(playoffWeeks: number[]): DstPlan {
  return {
    decision: 'unknown',
    activation: 'active',
    surface: false,
    headline: '',
    why: [],
    evidence: [],
    target: null,
    stash: null,
    current: null,
    gain: null,
    bar: null,
    cost: NO_COST,
    temporary: false,
    confidence: 'low',
    playoffWeeks,
    notes: [],
  };
}

function silent(activation: DstActivation, playoffWeeks: number[], notes: string[]): DstPlan {
  return { ...base(playoffWeeks), activation, surface: false, notes };
}

function unavailablePlan(playoffWeeks: number[], cost: DstRosterCost, reason: string): DstPlan {
  return {
    ...base(playoffWeeks),
    decision: 'unknown',
    surface: true,
    headline: 'DST outlook unavailable',
    why: [capitalise(reason) + '.'],
    cost,
    notes: [reason],
  };
}

function evidenceFor(args: {
  target: DstOption | null;
  current: DstOption | null;
  cost: DstRosterCost;
  gain: number | null;
  bar: number | null;
  replacement?: number | null;
  stash?: DstOption | null;
}): DstEvidence[] {
  const out: DstEvidence[] = [];
  const { target, current } = args;
  if (args.gain != null) out.push({ key: 'gain', label: 'Projected gain', value: `${args.gain >= 0 ? '+' : ''}${args.gain.toFixed(1)} pts` });
  if (args.bar != null) out.push({ key: 'bar', label: 'Bar it had to clear', value: `${args.bar.toFixed(1)} pts` });
  if (target?.opponent) out.push({ key: 'opponent', label: 'Opponent', value: target.opponent });
  if (target?.opponentImpliedTotal != null) {
    out.push({ key: 'implied', label: 'Opponent implied total', value: `${target.opponentImpliedTotal}` });
  }
  if (target?.forward?.weeks.length) {
    out.push({ key: 'next', label: 'Next weeks', value: describeWeeks(target.forward) });
  }
  if (current?.forward?.weeks.length) {
    out.push({ key: 'current_next', label: `${current.team} next weeks`, value: describeWeeks(current.forward) });
  }
  const bye = [current, target].find((o) => o?.forward?.byes.length);
  if (bye?.forward?.byes.length) out.push({ key: 'bye', label: `${bye.team} bye`, value: `week ${bye.forward.byes.join(', ')}` });
  if (args.replacement != null) out.push({ key: 'wire', label: 'Wire level at DEF', value: `${args.replacement.toFixed(1)} pts` });
  if (args.stash?.playoff?.perWeek != null) {
    out.push({ key: 'playoff', label: `${args.stash.team} in the playoffs`, value: `${args.stash.playoff.perWeek.toFixed(1)} pts a week` });
  }
  out.push({ key: 'cost', label: 'Roster cost', value: args.cost.label });
  return out;
}

function describeWeeks(outlook: DstOutlook): string {
  return outlook.weeks
    .map((w) => (w.bye ? `wk${w.week} bye` : `wk${w.week} ${w.opponent ?? '?'}${w.points == null ? '' : ` ${w.points.toFixed(1)}`}`))
    .join(' · ');
}

/** `Weeks 15–17`, from the league's own list and never from a constant. */
export function weekRange(weeks: number[]): string {
  if (weeks.length === 0) return 'the playoffs';
  if (weeks.length === 1) return `Week ${weeks[0]}`;
  return `Weeks ${weeks[0]}–${weeks.at(-1)}`;
}

function byScoreDescending(a: DstOption, b: DstOption): number {
  return (b.thisWeek ?? -Infinity) - (a.thisWeek ?? -Infinity) || a.name.localeCompare(b.name);
}

function weakest(a: 'high' | 'medium' | 'low', b: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  const order = { low: 0, medium: 1, high: 2 } as const;
  return order[a] <= order[b] ? a : b;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
