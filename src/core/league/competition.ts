/**
 * Who else wants this player, and can they pay for him.
 *
 * Competition is not a property of the player. It is a property of the eleven
 * other rosters: how many of them have a hole he fills, which of those have
 * money left, and which of those have ever spent money like this. So the work
 * here is mostly about the *other* teams, and the player only decides which
 * position's needs to read.
 *
 * The output is deliberately a label and a named list rather than a
 * probability. "Likely 2–3 bidders, and both of them have $40+" is a sentence
 * the user can act on; "0.62 competition index" is not.
 *
 * A need is measured against the league's own starting slots, never against a
 * fixed idea of a football team, so a superflex league correctly reports every
 * team as quarterback-needy and a tight-end-premium league does not.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { ManagerProfile } from './managers.ts';

export type NeedLevel = 'urgent' | 'thin' | 'covered';

export type CompetitionLabel = 'Low competition' | 'Likely 2–3 bidders' | 'High pressure';

export interface TeamRoster {
  rosterId: number;
  userId: string | null;
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
  userId: string | null;
  displayName: string;
  level: NeedLevel;
  /** Bodies who could start there, injuries already taken out. */
  healthy: number;
  /** Dedicated starting slots for the position. */
  required: number;
  /** True when a flex slot could also take one. */
  flexEligible: boolean;
}

export interface LikelyBidder {
  rosterId: number;
  displayName: string;
  need: NeedLevel;
  /** Dollars left, or null when the league has no budget or it is unknown. */
  remainingFaab: number | null;
  /** Why they are on this list. One short phrase. */
  reason: string;
}

export interface CompetitionAssessment {
  label: CompetitionLabel;
  /** Teams with a real need, before affordability is considered. */
  needyTeams: number;
  /** Teams with a need who can also afford the going rate. */
  bidders: LikelyBidder[];
  reasons: string[];
}

/**
 * How many of a position this team can actually start, and how many it needs.
 *
 * Flex is counted as eligibility rather than as a required slot. A team with
 * two backs, two receivers and one flex does not *need* a third back; it can
 * *use* one, which is the difference between urgent and thin, and collapsing
 * the two is how every team in the league ends up looking desperate for
 * everything.
 */
export function teamNeedsFor(
  position: string,
  rosters: TeamRoster[],
  meta: Map<string, RosterPlayerMeta>,
  shape: RosterShape,
): TeamNeed[] {
  const required = shape.starters[position] ?? 0;
  const flexEligible = shape.flex.some((f) => f.positions.includes(position));

  return rosters
    .filter((r) => !r.isMine)
    .map((r) => {
      const healthy = r.playerIds.filter((id) => {
        const m = meta.get(id);
        return m?.position === position && !m.unavailable;
      }).length;

      const level: NeedLevel =
        healthy < required ? 'urgent' : flexEligible && healthy <= required ? 'thin' : 'covered';

      return {
        rosterId: r.rosterId,
        userId: r.userId,
        displayName: r.displayName,
        level,
        healthy,
        required,
        flexEligible,
      };
    });
}

/**
 * Turn needs, wallets and profiles into one label.
 *
 * The affordability test is the load-bearing part. A team with an urgent hole
 * at running back and $2 left is not a bidder, and counting them as one is how
 * the app would tell the user to spend $30 to beat somebody who cannot spend
 * $3. Needs are counted honestly; only the *bidder list* is filtered by money.
 */
export function assessCompetition(opts: {
  needs: TeamNeed[];
  /** Profiles by user id, for aggression and remaining budget. */
  profiles: Map<string, ManagerProfile>;
  /** Bottom of the expected range, in dollars. Null when unpriced. */
  expectedLow: number | null;
  /** True when the league genuinely spends FAAB. */
  faabLeague: boolean;
}): CompetitionAssessment {
  const needy = opts.needs.filter((n) => n.level !== 'covered');
  const reasons: string[] = [];

  const bidders: LikelyBidder[] = [];
  for (const need of needy) {
    const profile = need.userId ? opts.profiles.get(need.userId) : undefined;
    const remaining = profile?.remainingFaab ?? null;

    /*
     * Affordability is only decidable when there is both a price and a wallet.
     * Unknown means "cannot be ruled out", not "cannot afford it" — a manager
     * whose budget failed to sync must not silently vanish from the list of
     * people about to outbid you.
     */
    if (opts.faabLeague && opts.expectedLow != null && remaining != null && remaining < opts.expectedLow) {
      continue;
    }

    const aggressive = profile?.aggression.sufficient === true && (profile.aggression.value ?? 0) >= 0.12;
    bidders.push({
      rosterId: need.rosterId,
      displayName: need.displayName,
      need: need.level,
      remainingFaab: remaining,
      reason:
        need.level === 'urgent'
          ? aggressive
            ? 'cannot start the position, and bids big'
            : 'cannot start the position'
          : aggressive
            ? 'could use one, and bids big'
            : 'could use one',
    });
  }

  bidders.sort(
    (a, b) =>
      Number(b.need === 'urgent') - Number(a.need === 'urgent') ||
      (b.remainingFaab ?? -1) - (a.remainingFaab ?? -1) ||
      a.displayName.localeCompare(b.displayName),
  );

  const priced = opts.needs.length - needy.length;
  if (needy.length === 0) reasons.push('nobody else has a hole at the position');
  else reasons.push(`${needy.length} of ${opts.needs.length} other teams have a need at the position`);

  const excluded = needy.length - bidders.length;
  if (excluded > 0) reasons.push(`${excluded} of them cannot afford the going rate`);
  if (priced === opts.needs.length && opts.needs.length > 0) reasons.push('every other roster is already covered here');

  return {
    label: labelFor(bidders.length),
    needyTeams: needy.length,
    bidders,
    reasons,
  };
}

/**
 * The three bands, defined once.
 *
 * Named exactly as the brief specifies them, because these strings are the
 * interface: a screen that renders "High pressure" must be able to match on it.
 */
export function labelFor(bidders: number): CompetitionLabel {
  if (bidders <= 1) return 'Low competition';
  if (bidders <= 3) return 'Likely 2–3 bidders';
  return 'High pressure';
}
