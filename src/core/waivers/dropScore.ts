/**
 * Who to cut: a drop score for every player on the bench, lowest first.
 *
 * ## Why the lineup cost alone was not enough
 *
 * Until October 2026 the drop was whichever bench player cost the three-week
 * lineup least. On 13 October that named Braelon Allen, whom Alex had just
 * started, who scored, and whom he meant to start again: the solver had him
 * behind Bijan Robinson and Kenneth Walker on paper, so cutting him "cost"
 * nothing. A drop is a judgement about a player, not only about three weeks.
 *
 * ## The score, in points a game
 *
 *     score = 0.25 × season average (season total ÷ weeks played so far)
 *           + 0.35 × recent average (last three weeks, newest counted 3, 2, 1)
 *           + 0.40 × projection (the Start/Sit number over the window,
 *                    with byes and injuries counted as missed weeks)
 *           + role: +0.5 rising, −0.5 falling (snaps and touches trend)
 *           + held: +0.75 drafted, +0.5 held four weeks or more, 0 just added
 *           + handcuff to one of your elite backs: +3
 *
 * Every number is one the app already has: last week's points store
 * (`sleeper.weekPoints`), the Start/Sit number through the trade-value rate
 * (which is also what Check a trade values him at, so trade value is counted
 * once, not twice), the usage trend, and Sleeper's draft and transactions for
 * how long he has been on the roster. League-wide rostered percentage is not
 * in Sleeper's public API and is not used.
 *
 * ## Protections, before any score
 *
 * - **Your Sleeper lineup.** A player in Alex's current starting lineup is
 *   not offered as a drop unless the add plays the same position and is
 *   clearly better ({@link DROP_RULES.clearlyBetter} points a game). A starter
 *   marked Out or on IR is not protected: his slot is stale.
 * - **Handcuffs to elite backs.** A bench back who is the direct depth-chart
 *   backup to an elite back on this roster gets the +3 and the label
 *   `handcuff`, and is cut only when nobody else can be. Elite is measured:
 *   top {@link ELITE_RB.rank} backs league-wide by points a game this season
 *   (at least {@link ELITE_RB.minGames} games), and his Start/Sit number now
 *   is at least {@link ELITE_RB.minRate}. A backup to anyone else gets nothing.
 */

export const DROP_WEIGHTS = { season: 0.25, recent: 0.35, projection: 0.4 } as const;

export const DROP_BONUS = {
  rising: 0.5,
  falling: -0.5,
  drafted: 0.75,
  heldLong: 0.5,
  /** Weeks on the roster that count as "held a while". */
  heldLongWeeks: 4,
  handcuff: 3,
} as const;

export const DROP_RULES = {
  /** An add this many points a game better, at the same position, may displace a lineup player. */
  clearlyBetter: 3,
  /** A drop whose move gains within this many points of the move's best drop is "as good" for the lineup. */
  gainSlack: 1,
} as const;

export const ELITE_RB = { rank: 12, minGames: 2, minRate: 12 } as const;

export interface DropSignals {
  playerId: string;
  name: string;
  position: string;
  /** Season total in league scoring, and the weeks it covers. Null: not on record. */
  seasonPoints: number | null;
  weeksPlayed: number;
  /** The last three finished weeks, newest first. Missing weeks are 0. */
  recent: number[];
  /** Start/Sit number over the window, availability counted. */
  projection: number;
  role: 'rising' | 'falling' | 'stable' | null;
  /** Weeks on this roster; null when unknown. `drafted` when he came from the draft. */
  heldWeeks: number | null;
  drafted: boolean;
  /** The elite back he backs up, when he is that back's direct handcuff. */
  handcuffOf: string | null;
  /** In Alex's current Sleeper starting lineup. */
  inLineup: boolean;
  /** Out, IR, PUP or suspended: a lineup slot he holds is stale. */
  unavailable: boolean;
}

export interface DropReading {
  playerId: string;
  score: number;
  parts: { season: number; recent: number; projection: number; role: number; held: number; handcuff: number };
  /** `lowest season points on your bench (17.3), held 2 weeks`. */
  reason: string;
}

export function recentAverage(recent: readonly number[]): number {
  const w = [3, 2, 1];
  let num = 0;
  let den = 0;
  recent.slice(0, 3).forEach((p, i) => {
    num += w[i]! * p;
    den += w[i]!;
  });
  return den > 0 ? num / den : 0;
}

export function dropScore(s: DropSignals): DropReading {
  const season = s.seasonPoints != null && s.weeksPlayed > 0 ? s.seasonPoints / s.weeksPlayed : 0;
  const recent = recentAverage(s.recent);
  const role = s.role === 'rising' ? DROP_BONUS.rising : s.role === 'falling' ? DROP_BONUS.falling : 0;
  const held = s.drafted ? DROP_BONUS.drafted : s.heldWeeks != null && s.heldWeeks >= DROP_BONUS.heldLongWeeks ? DROP_BONUS.heldLong : 0;
  const handcuff = s.handcuffOf ? DROP_BONUS.handcuff : 0;
  const parts = {
    season: round2(DROP_WEIGHTS.season * season),
    recent: round2(DROP_WEIGHTS.recent * recent),
    projection: round2(DROP_WEIGHTS.projection * s.projection),
    role,
    held,
    handcuff,
  };
  const score = round2(parts.season + parts.recent + parts.projection + role + held + handcuff);
  return { playerId: s.playerId, score, parts, reason: '' };
}

/**
 * Score every candidate and write each one's plain reason, comparing him with
 * the rest of the bench: `lowest season points on your bench (17.3), held 2 weeks`.
 */
export function readDrops(bench: readonly DropSignals[]): Map<string, DropReading> {
  const out = new Map<string, DropReading>();
  const totals = bench.map((b) => b.seasonPoints ?? 0);
  const lowest = totals.length > 0 ? Math.min(...totals) : 0;
  const recents = bench.map((b) => recentAverage(b.recent));
  const lowestRecent = recents.length > 0 ? Math.min(...recents) : 0;
  for (const s of bench) {
    const reading = dropScore(s);
    const bits: string[] = [];
    const total = s.seasonPoints ?? 0;
    if (s.unavailable) bits.push('out now');
    if (bench.length > 1 && total === lowest) bits.push(`lowest season points on your bench (${total.toFixed(1)})`);
    else if (bench.length > 1 && recentAverage(s.recent) === lowestRecent) bits.push(`least points lately on your bench (${recentAverage(s.recent).toFixed(1)} a week)`);
    else bits.push(`${total.toFixed(1)} pts this season`);
    bits.push(heldWords(s));
    if (s.handcuffOf) bits.push(`handcuff to ${s.handcuffOf}`);
    out.set(s.playerId, { ...reading, reason: bits.filter(Boolean).join(', ') });
  }
  return out;
}

function heldWords(s: DropSignals): string {
  if (s.drafted) return 'drafted';
  if (s.heldWeeks == null) return '';
  if (s.heldWeeks <= 0) return 'added this week';
  return `held ${s.heldWeeks} week${s.heldWeeks === 1 ? '' : 's'}`;
}

/**
 * Elite backs league-wide: the top {@link ELITE_RB.rank} by points a game this
 * season, among backs with at least {@link ELITE_RB.minGames} games.
 */
export function eliteBacks(
  seasonPoints: ReadonlyMap<string, { total: number; games: number }>,
  isBack: (playerId: string) => boolean,
): Set<string> {
  const ranked = [...seasonPoints.entries()]
    .filter(([id, p]) => isBack(id) && p.games >= ELITE_RB.minGames)
    .sort((a, b) => b[1].total / b[1].games - a[1].total / a[1].games);
  return new Set(ranked.slice(0, ELITE_RB.rank).map(([id]) => id));
}

/**
 * Bench backs who are the direct depth-chart backup to an elite back on this
 * roster. Same club, the starter ranked 1 and the backup 2 where the depth
 * chart says; with no depth chart for either, the only other back of that
 * club on the roster.
 */
export function eliteHandcuffs(opts: {
  roster: readonly { playerId: string; name: string; position: string; team: string; rate: number | null }[];
  elite: ReadonlySet<string>;
  depth: ReadonlyMap<string, { rank: number }>;
}): Map<string, { playerId: string; name: string }> {
  const out = new Map<string, { playerId: string; name: string }>();
  const backs = opts.roster.filter((p) => p.position === 'RB' && p.team);
  for (const star of backs) {
    if (!opts.elite.has(star.playerId) || (star.rate ?? 0) < ELITE_RB.minRate) continue;
    for (const p of backs) {
      if (p.playerId === star.playerId || p.team !== star.team) continue;
      const mine = opts.depth.get(p.playerId)?.rank ?? null;
      const theirs = opts.depth.get(star.playerId)?.rank ?? null;
      const direct = mine != null ? mine === 2 && (theirs == null || theirs === 1) : true;
      if (direct) out.set(p.playerId, { playerId: star.playerId, name: star.name });
    }
  }
  return out;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
