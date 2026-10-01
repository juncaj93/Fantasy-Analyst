/**
 * Who else wants this player, and can they pay for him.
 *
 * This exists to sharpen one number that the FAAB layer already asks for and
 * currently estimates bluntly. `core/faab/strategy.ts` takes `rivalsWithNeed` —
 * "rosters that plausibly want him and can pay" — and the caller in `app.ts`
 * supplies *every funded rival in the league*, with a comment saying why:
 *
 *   > A blunt count on purpose: every other funded roster in the league. A finer
 *   > one would need each rival's lineup scored against each candidate, which is
 *   > twelve times the work for a number that feeds a 0–1 demand input.
 *
 * That reasoning is right about lineup scoring and wrong about the alternative.
 * Whether a roster *needs* a running back does not require scoring anybody: it
 * requires counting the healthy backs it holds against the back slots it must
 * fill. That is a set membership test over data already in memory, it costs one
 * pass per position rather than twelve lineup optimisations, and it is the
 * difference between "eleven rivals could bid" and "two rivals cannot start the
 * position and both have $40".
 *
 * So this module computes needs and affordability, and hands the count back to
 * the pricing model that asked for it. It prices nothing itself.
 *
 * The label is also the human half of the same answer, and it fills
 * `WaiverLeagueIntel.competition` on the waiver board — the field `main` left
 * typed, documented and unpopulated for exactly this pass.
 */

import type { RosterBudget } from '../faab/budget.ts';
import type { RosterShape } from '../sleeper/scoring.ts';

export type NeedLevel = 'urgent' | 'thin' | 'covered';

/** The board's own vocabulary, which this must speak rather than invent. */
export type CompetitionLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface TeamRoster {
  rosterId: number;
  displayName: string;
  isMine: boolean;
  playerIds: string[];
}

export interface RosterPlayerMeta {
  position: string | null;
  /** True when he cannot be counted on to start this week. */
  unavailable?: boolean;
}

export interface TeamNeed {
  rosterId: number;
  displayName: string;
  level: NeedLevel;
  /** Bodies who could start there, injuries already taken out. */
  healthy: number;
  /** Dedicated starting slots for the position. */
  required: number;
  flexEligible: boolean;
}

export interface LikelyBidder {
  rosterId: number;
  displayName: string;
  need: NeedLevel;
  /** Dollars left, or null when the league has no budget or it is unknown. */
  remaining: number | null;
  /**
   * How much of a bidder his own record says he is, in [0,1]. 1 when unknown.
   *
   * From `core/waivers/bidLikelihood.ts`, which reads how often he has actually
   * claimed and how much of his budget he has touched. A hole at the position
   * and money to fill it is what makes somebody a *possible* bidder; this is
   * what separates the manager who acts on both from the one who never has.
   */
  participation: number;
}

export interface CompetitionAssessment {
  level: CompetitionLevel;
  /** The sentence the card shows. */
  label: string;
  detail: string | null;
  /** Teams with a real need, before affordability is considered. */
  needyTeams: number;
  /** Teams with a need who can also afford the going rate. */
  bidders: LikelyBidder[];
  /**
   * The bidder count with each rival weighted by how likely he is to bid at all.
   *
   * The number that should price a claim. `bidders.length` counts heads and is
   * still what the card names and lists; this counts *expected* bidders, so a
   * needy rival who has bid once in three seasons stops contributing as much
   * expected competition as one who bids weekly.
   *
   * Equal to `bidders.length` whenever no participation is known, which is the
   * case for a first-season league, a league mid-backfill, and any caller that
   * does not supply the reading — so nothing that existed before this field
   * changes behaviour by default.
   */
  effectiveBidders: number;
}

/**
 * The projection a starter has to reach before his team is covered there.
 *
 * Set by the owner on 1 October 2026: "If a team has 2 RB slots and 1 of the
 * RB slots has a player projected to score less than 8 pts then they need an
 * RB. Same with WR and TE. QB should probably be like 14, and defense should
 * be like 6." Before this, a team "needed" a position only when it had fewer
 * healthy bodies than slots, so every rival with two weak backs read as
 * covered and the board said `0 of 9 teams need RB`.
 */
export const WEAK_STARTER_POINTS: Readonly<Record<string, number>> = {
  QB: 14,
  RB: 8,
  WR: 8,
  TE: 8,
  DEF: 6,
};

/**
 * Whether each rival needs this position.
 *
 * With projections: a team needs it when a dedicated slot is empty (`urgent`)
 * or the weakest of its likely starters there, its best players by this week's
 * projection, is under {@link WEAK_STARTER_POINTS} (`thin`). A player with no
 * projection this week (a bye, no feed row) counts as zero: he scores nothing
 * for them this Sunday.
 *
 * Without projections, or for a position with no dedicated slot or no bar,
 * the older body count: fewer healthy players than slots is `urgent`, exactly
 * as many with a flex that takes the position is `thin`.
 *
 * Then the flex: a team whose named slots are covered still needs the
 * position when one of the flex spots it could fill starts somebody under 8
 * points (`thin`). See {@link weakFlex}.
 */
export function teamNeedsFor(
  position: string,
  rosters: TeamRoster[],
  meta: Map<string, RosterPlayerMeta>,
  shape: RosterShape,
  projections?: ReadonlyMap<string, number> | null,
): TeamNeed[] {
  const required = shape.starters[position] ?? 0;
  const flexEligible = shape.flex.some((f) => f.positions.includes(position));
  const bar = WEAK_STARTER_POINTS[position.toUpperCase()];
  const byProjection = projections != null && projections.size > 0 && bar != null && required > 0;

  return rosters
    .filter((r) => !r.isMine)
    .map((r) => {
      const available = r.playerIds.filter((id) => {
        const m = meta.get(id);
        return m?.position === position && !m.unavailable;
      });
      const healthy = available.length;

      let level: NeedLevel;
      if (healthy < required) {
        level = 'urgent';
      } else if (byProjection) {
        const starters = available
          .map((id) => projections!.get(id) ?? 0)
          .sort((a, b) => b - a)
          .slice(0, required);
        level = Math.min(...starters) < bar! ? 'thin' : 'covered';
      } else {
        level = flexEligible && healthy <= required ? 'thin' : 'covered';
      }
      /* Then the flex spots this position can fill: a weak flex starter is a need too. */
      if (level === 'covered' && projections != null && projections.size > 0 && weakFlex(position, r, meta, shape, projections)) {
        level = 'thin';
      }

      return { rosterId: r.rosterId, displayName: r.displayName, level, healthy, required, flexEligible };
    });
}

/**
 * Whether a team's flex starters, the spots this position could fill, include
 * one under {@link WEAK_STARTER_POINTS}' 8-point skill bar.
 *
 * Asked for on 1 October 2026, when the dedicated-slot rule alone left almost
 * every rival covered: this league starts two FLEX (RB/WR/TE) beside its named
 * slots, and a team starting a 6-point receiver there needs an RB, a WR or a
 * TE as much as one with a weak RB2. The flex starters are each team's best
 * leftover RB/WR/TE after its named slots are filled, by projection; no
 * projection counts as zero. Only flex slots made entirely of skill positions
 * are judged, so a superflex slot (QB or skill) is left alone.
 */
export function weakFlex(
  position: string,
  roster: Pick<TeamRoster, 'playerIds'>,
  meta: Map<string, RosterPlayerMeta>,
  shape: RosterShape,
  projections: ReadonlyMap<string, number>,
): boolean {
  const slots = shape.flex.filter(
    (f) => f.positions.includes(position) && f.positions.every((p) => FLEX_SKILL.has(p.toUpperCase())),
  );
  if (slots.length === 0) return false;
  const eligible = new Set(slots.flatMap((f) => f.positions));
  const pool: number[] = [];
  for (const pos of eligible) {
    const points = roster.playerIds
      .filter((id) => {
        const m = meta.get(id);
        return m?.position === pos && !m.unavailable;
      })
      .map((id) => projections.get(id) ?? 0)
      .sort((a, b) => b - a);
    pool.push(...points.slice(shape.starters[pos] ?? 0));
  }
  const flex = pool.sort((a, b) => b - a).slice(0, slots.length);
  return flex.length < slots.length || Math.min(...flex) < FLEX_BAR;
}

const FLEX_SKILL = new Set(['RB', 'WR', 'TE']);
/** The skill bar, the same 8 points a named RB, WR or TE slot is held to. */
const FLEX_BAR = 8;

/**
 * Turn needs and wallets into a count, a level and a sentence.
 *
 * The affordability test is the load-bearing part. A team with an urgent hole at
 * running back and $2 left is not a bidder, and counting them as one is how a
 * tool tells you to spend $30 beating somebody who cannot spend $3. Needs are
 * counted honestly; only the *bidder list* is filtered by money.
 *
 * Unknown budgets are kept in, not filtered out — "cannot be ruled out" is not
 * "cannot afford it", and a manager whose settings failed to sync must not
 * silently vanish from the list of people about to outbid you.
 */
export function assessCompetition(opts: {
  needs: TeamNeed[];
  /** Wallets from `core/faab/budget.ts`, keyed by roster id. */
  budgets: Map<number, RosterBudget>;
  /** Bottom of the expected range. Null when the league is unpriced. */
  expectedLow: number | null;
  /** False in a priority league, where money is not the constraint. */
  bidding: boolean;
  /**
   * The position being competed for, so the count can name it.
   *
   * `7 of 11 teams need TE` is the fact; `7 of 11 rivals need the position`
   * was the same fact asking the reader to remember which position they were
   * looking at. Optional because the phrase still works without it.
   */
  position?: string | null;
  /**
   * How much of a bidder each rival's own record says he is, in [0,1].
   *
   * Optional, and its absence is a real answer rather than a missing feature:
   * without it every rival counts whole and this function behaves exactly as it
   * did before the reading existed. Supplied, it weights
   * {@link CompetitionAssessment.effectiveBidders} and nothing else — no rival
   * is dropped from the list, renamed, or hidden, because "unlikely to bid" is
   * not "cannot bid" and the card still has to show him.
   */
  participationOf?: (rosterId: number) => number;
}): CompetitionAssessment {
  const needy = opts.needs.filter((n) => n.level !== 'covered');

  const bidders: LikelyBidder[] = [];
  for (const need of needy) {
    const remaining = opts.budgets.get(need.rosterId)?.remaining ?? null;
    if (opts.bidding && opts.expectedLow != null && remaining != null && remaining < opts.expectedLow) continue;
    bidders.push({
      rosterId: need.rosterId,
      displayName: need.displayName,
      need: need.level,
      remaining,
      participation: clamp01(opts.participationOf?.(need.rosterId) ?? 1),
    });
  }

  bidders.sort(
    (a, b) =>
      Number(b.need === 'urgent') - Number(a.need === 'urgent') ||
      (b.remaining ?? -1) - (a.remaining ?? -1) ||
      a.displayName.localeCompare(b.displayName),
  );

  const priced = needy.length - bidders.length;
  /*
   * `teams`, not `rivals`.
   *
   * They are the other managers in the league, and on a screen whose job is to
   * price a claim, what matters about them is that they are eleven teams with
   * the same hole — not that they are adversaries.
   */
  const what = opts.position ? `need ${opts.position.toUpperCase()}` : 'need the position';
  const detail =
    opts.needs.length === 0
      ? null
      : priced > 0
        ? `${needy.length} of ${opts.needs.length} teams ${what}; ${priced} cannot afford the going rate`
        : `${needy.length} of ${opts.needs.length} teams ${what}`;

  /*
   * The expected field, rather than the headcount.
   *
   * Summed and then rounded rather than rounded per rival, so three managers at
   * 0.4 come to one bidder instead of to nothing. Never rounded below 1 while
   * anybody at all is in the list: somebody has a hole at the position and the
   * money to fix it, and "0 bidders" is a claim about the world that this
   * evidence cannot support — it would also collide with the `bidders === 0`
   * branch in `bidders.ts`, which means "nobody needs him" and is a different
   * fact entirely.
   */
  const effectiveBidders =
    bidders.length === 0
      ? 0
      : Math.max(1, Math.round(bidders.reduce((sum, b) => sum + b.participation, 0)));

  return {
    /*
     * The label follows the expected field, not the headcount.
     *
     * A card reading `High demand` over four rivals who have between them
     * placed two bids in two seasons is the specific failure this pass exists
     * to fix, and leaving the label on `bidders.length` would have fixed the
     * price while leaving the sentence beside it saying the opposite.
     */
    ...levelFor(effectiveBidders),
    detail,
    needyTeams: needy.length,
    bidders,
    effectiveBidders,
  };
}

/**
 * The bands, defined once.
 *
 * `level` is the board's vocabulary and `label` is the reader's. They are
 * produced together so a card can never show a label that disagrees with the
 * level it sorted on.
 */
export function levelFor(bidders: number): { level: CompetitionLevel; label: string } {
  if (bidders === 0) return { level: 'low', label: 'Nobody else needs him' };
  if (bidders === 1) return { level: 'low', label: 'Low competition' };
  if (bidders <= 3) return { level: 'medium', label: 'Likely 2–3 bidders' };
  /*
   * `High demand`, not `High pressure`.
   *
   * Pressure is what the reader feels; demand is what the league is doing. The
   * card is describing the market for a player, and the pill beside it — with
   * `7 of 11 teams need TE` under it — is the reason the bid has to be higher.
   */
  return { level: 'high', label: 'High demand' };
}

/** Nothing is known — the honest answer when rosters or positions are missing. */
export const COMPETITION_UNKNOWN: CompetitionAssessment = {
  level: 'unknown',
  label: 'Competition not known',
  detail: null,
  needyTeams: 0,
  bidders: [],
  effectiveBidders: 0,
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}
