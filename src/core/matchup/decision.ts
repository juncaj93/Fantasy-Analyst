/**
 * Which legal lineup gives the best chance of winning **this** matchup.
 *
 * That is a different question from the one the Team screen answers, and the
 * difference is the whole point of this module. Team asks which lineup has the
 * highest projection; a matchup asks which lineup most often ends the afternoon
 * ahead of one specific opponent. Those two answers diverge exactly where it
 * matters most:
 *
 *   - a **big underdog** should start the volatile player over the steadier one
 *     projected half a point higher, because the steady lineup loses by twelve
 *     and the volatile one loses by twenty or wins by three;
 *   - a **strong favourite** should do the reverse, and give up projected
 *     points for a narrower distribution, because his only way to lose is a
 *     bad afternoon.
 *
 * Neither of those can be seen by a median. Both fall out of the simulation for
 * free, because every bench player was drawn alongside every starter across the
 * same afternoons — see `simulate.ts` on common random numbers.
 *
 * ## What it will not do
 *
 * Advisory, exactly like everything else in this app: it reports what a swap
 * would have been worth and there is no code path anywhere that sets a lineup.
 * It respects Sleeper's own slots and eligibility, it never proposes moving a
 * player whose game has started, and it never proposes starting a player who is
 * Out. A recommendation the user physically cannot follow is worse than
 * silence.
 */

import { winProbabilityWithSwap, type SimulationResult } from './simulate.ts';
import type { PlayerDistribution } from './distribution.ts';
import type { MatchupPlayerInput } from './types.ts';

/**
 * How much win probability a swap has to be worth before it is *offered*.
 *
 * Two points, and the number is about usefulness rather than about precision.
 * The paired comparison is far more precise than that — common random numbers
 * mean the difference between two lineups has a standard error nearer a tenth
 * of a point than a whole one — so the model can and does measure smaller
 * effects than this, and `options` at a lower threshold will report them.
 *
 * What the threshold decides is what is worth interrupting somebody for.
 * Choosing the wider distribution when you are a big underdog is genuinely
 * right and it is genuinely worth about one point of win probability in an
 * ordinary lineup; a screen that tells somebody to change their lineup for that
 * is a screen that churns lineups every Sunday. The effect stays measured, and
 * it stays off the hero card until it is worth acting on.
 */
export const MIN_WIN_PROBABILITY_GAIN = 0.02;

export interface LineupImpact {
  slot: string;
  outPlayerId: string;
  outName: string;
  inPlayerId: string;
  inName: string;
  /** Win probability if the current lineup stands. */
  winNow: number;
  /** Win probability with this one change. */
  winAfter: number;
  /** The difference, always positive — losing swaps are not offered. */
  gain: number;
  /** The projection given up (negative) or gained (positive) by making it. */
  pointsDelta: number;
  /** One sentence naming why the swap wins despite the points, when it does. */
  reason: string;
}

export interface LineupDecision {
  /** The best single change, or null when the lineup already maximises win odds. */
  best: LineupImpact | null;
  /** Every legal change worth more than the threshold, best first. */
  options: LineupImpact[];
  /** How many bench players were legal candidates at all. */
  considered: number;
  /** Why no change is offered, when none is. */
  note: string | null;
}

export interface SlotSpec {
  /**
   * Which of this league's starting slots this is, uniquely.
   *
   * A league with two running-back slots has two rows labelled `RB`, and a
   * player belongs to one of them rather than to both — so the identity is the
   * key and the label is only what gets printed. See `slotKey` in `model.ts`.
   */
  key: string;
  /** The label: `RB`, `FLEX`, `SUPER_FLEX`. */
  slot: string;
  accepts: string[];
}

/**
 * Compare every legal one-for-one change against the current lineup.
 *
 * Deliberately one-for-one rather than a search over whole lineups. A full
 * search is 2^n paired comparisons for a gain that is almost always available
 * from the single best swap, and a screen that says "make these four changes"
 * forty minutes before kickoff is not advice anybody takes. The one change with
 * the largest effect is the actionable form of the same answer.
 */
export function assessLineupDecision(opts: {
  result: SimulationResult;
  players: MatchupPlayerInput[];
  distributions: PlayerDistribution[];
  slots: SlotSpec[];
  minGain?: number;
}): LineupDecision {
  const minGain = opts.minGain ?? MIN_WIN_PROBABILITY_GAIN;
  const distributionById = new Map(opts.distributions.map((d) => [d.playerId, d]));
  const winNow = opts.result.winProbability;

  const mine = opts.players.filter((p) => p.side === 'mine');
  const starters = mine.filter((p) => p.starting);
  const bench = mine.filter((p) => !p.starting);

  /*
   * Who can still be moved, which is a different question from who is still
   * uncertain.
   *
   * The distribution's `locked` means "nothing about him can change" and is
   * true of two very different players: one whose game is over, and one who has
   * been ruled out and will score nothing. Only the first has stopped being a
   * *decision*. Reading `locked` here would have quietly suppressed the single
   * most valuable piece of advice this screen can give — that a starting slot
   * is being spent on somebody who is not playing — so movability is read off
   * the game clock instead, which is the fact it actually depends on.
   */
  const notKickedOff = (playerId: string) => distributionById.get(playerId)?.phase === 'not_started';

  const movableBench = bench.filter((p) => notKickedOff(p.playerId) && !p.ruledOut && p.projection != null);
  const movableStarters = starters.filter((p) => notKickedOff(p.playerId));

  const options: LineupImpact[] = [];
  for (const starter of movableStarters) {
    const starterDistribution = distributionById.get(starter.playerId)!;
    const slot = opts.slots.find((s) => s.key === starter.slot);
    // A slot the app does not understand is not a slot it may reassign.
    if (!slot) continue;

    for (const candidate of movableBench) {
      if (!slot.accepts.includes(candidate.position)) continue;
      const winAfter = winProbabilityWithSwap(opts.result, starter.playerId, candidate.playerId);
      const gain = winAfter - winNow;
      if (gain < minGain) continue;

      const pointsDelta = round2((candidate.projection ?? 0) - (starter.projection ?? 0));
      options.push({
        slot: slot.slot,
        outPlayerId: starter.playerId,
        outName: starter.name,
        inPlayerId: candidate.playerId,
        inName: candidate.name,
        winNow: round4(winNow),
        winAfter: round4(winAfter),
        gain: round4(gain),
        pointsDelta,
        reason: reasonFor({
          pointsDelta,
          winNow,
          outCeiling: starterDistribution.ceiling,
          inCeiling: distributionById.get(candidate.playerId)?.ceiling ?? 0,
          outFloor: starterDistribution.floor,
          inFloor: distributionById.get(candidate.playerId)?.floor ?? 0,
          inName: candidate.name,
          outName: starter.name,
        }),
      });
    }
  }

  options.sort((a, b) => b.gain - a.gain || a.inName.localeCompare(b.inName));

  return {
    best: options[0] ?? null,
    options,
    considered: movableBench.length,
    /*
     * Why there is nothing to offer, told apart properly.
     *
     * Three different situations produce an empty list and they mean entirely
     * different things to a reader: the decisions have expired, there is nobody
     * to make one with, or the lineup is already the best one. Collapsing them
     * into "already locked" would tell somebody at ten on a Sunday morning that
     * their lineup was settled when in fact their bench is two players nobody
     * can score.
     */
    note:
      options.length > 0
        ? null
        : movableStarters.length === 0
          ? 'Every remaining lineup decision is already locked.'
          : movableBench.length === 0
            ? 'Nobody on your bench could legally take a starting slot.'
            : 'No legal change improves your chance of winning this matchup.',
  };
}

/**
 * Why a swap wins, in the terms that make it make sense.
 *
 * The interesting cases are the ones where the change costs projected points,
 * and the sentence has to say so — a recommendation that quietly gives up
 * projection without mentioning it is the kind a reader stops trusting the
 * first time they notice.
 */
function reasonFor(opts: {
  pointsDelta: number;
  winNow: number;
  outCeiling: number;
  inCeiling: number;
  outFloor: number;
  inFloor: number;
  inName: string;
  outName: string;
}): string {
  if (opts.pointsDelta >= 0) {
    return `${opts.inName} projects higher and wins the matchup more often.`;
  }
  const cost = Math.abs(opts.pointsDelta).toFixed(1);
  if (opts.winNow < 0.45 && opts.inCeiling > opts.outCeiling) {
    return `You are behind, and ${opts.inName} has the wider range: ${cost} fewer projected points, more afternoons that end in front.`;
  }
  if (opts.winNow > 0.6 && opts.inFloor > opts.outFloor) {
    return `You are ahead, and ${opts.inName} is the safer half of the range: ${cost} fewer projected points, fewer afternoons that go wrong.`;
  }
  return `${cost} fewer projected points, but more of the afternoons end with you in front.`;
}

/**
 * Which question the lineup should be asked, given where the matchup stands.
 *
 * The same three modes the Team screen already offers, chosen from the win
 * probability rather than from a preference: a strong favourite wants his floor,
 * a meaningful underdog wants a ceiling, and the middle wants neither
 * especially. This is a *suggestion* and the user's own choice always wins —
 * see the Team screen, which owns the control.
 */
export function suggestedMode(winProbability: number): { mode: 'floor' | 'balanced' | 'ceiling'; why: string } {
  if (winProbability >= 0.66) {
    return { mode: 'floor', why: 'You are a clear favourite — the safest lineup is the one that wins this.' };
  }
  if (winProbability <= 0.36) {
    return { mode: 'ceiling', why: 'You are a meaningful underdog — you need the top of somebody’s range.' };
  }
  return { mode: 'balanced', why: 'This is close enough that neither safety nor upside is obviously right.' };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
