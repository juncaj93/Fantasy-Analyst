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

/** Free agents scored per slot before the list is cut. Keeps Team fast. */
export const DEFAULT_ALTERNATIVES = 3;

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

export interface WaiverAdvice {
  upgrades: WaiverUpgrade[];
  /** Said plainly when nothing available beats what the roster already has. */
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

  return {
    upgrades,
    headline:
      upgrades.length === 0 && evaluated.length > 0
        ? 'Your current options grade better than available waivers.'
        : null,
    notes,
    considered: evaluated.length,
    skipped: evaluated.length - playable.length,
    threshold: base,
  };
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
