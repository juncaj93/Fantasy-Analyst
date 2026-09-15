/**
 * Sleeper's published weekly projection feed, and the one question worth asking
 * about it: is this league playing the game the number was computed for?
 *
 * ## What this feed is
 *
 * `GET /projections/nfl/{season}/{week}?season_type=regular` returns a row per
 * player carrying a `stats` object, and inside it three fantasy totals —
 * `pts_std`, `pts_half_ppr`, `pts_ppr`. The row also carries `company`, which on
 * every row this app has ever read says **rotowire**.
 *
 * That last fact is the reason this file is careful. The number is not Sleeper's
 * and it is emphatically not Fantasy Analyst's: it is a third-party projection
 * model, distributed by Sleeper, and anywhere it reaches a screen it has to
 * arrive wearing its own name. See `core/startsit/projection.ts`, which is the
 * only place allowed to decide when it is shown.
 *
 * ## Why a league can be refused a number that exists
 *
 * Rotowire publishes three totals, and a league that scores football differently
 * from any of the three is not being served by picking the nearest one. A
 * six-point passing touchdown is worth two extra points a game to a quarterback;
 * a tight-end premium is worth several to a busy tight end. Quoting `pts_ppr` to
 * either league is not a projection with a caveat, it is a projection of a
 * different sport — and the rule this repo already settled is that an honest
 * unknown beats a plausible wrong number.
 *
 * So {@link sleeperScoringKey} answers `null` whenever the league's own settings
 * are not the ones the published total assumes *for that player*, and a null key
 * means no fallback for him. It is exact rather than tolerant: every value below
 * is Sleeper's own default, so an ordinary league matches and a customised one
 * is declined.
 *
 * ## Why the check is per position rather than per league
 *
 * The first version of this refused a whole league on any deviation, and the
 * first real league it met scored six-point passing touchdowns and minus-two
 * interceptions. Both of those are *passing* settings. A running back's
 * projected passing line is zero, so Rotowire's published total for him is
 * exactly right under that league's rules — and refusing it to avoid one wrong
 * quarterback threw away three correct answers per wrong one.
 *
 * A published total is a single number and cannot be decomposed, so the question
 * is not "does this league match Sleeper's defaults" but "do the settings this
 * league changed touch the stat line this player is projected to produce". A
 * quarterback is priced on passing, rushing and turnovers; everybody else on
 * rushing, receiving and turnovers. Each position is therefore checked against
 * the settings that actually move it, and refused on those alone.
 *
 * ## Why a defence is not like that
 *
 * Everything above is about a published *total*, which is a single number that
 * cannot be decomposed — so the only question available is whether it was
 * computed under rules close enough to this league's. A defence's row is
 * different: the feed publishes the projected counts beside the total, so this
 * app can score Rotowire's stat line under the league's own defensive table and
 * get a number that is exactly right for the league rather than nearly right.
 * See {@link scorePublishedDefense}. No defence quotes a published total.
 *
 * **What this cannot see.** `ScoringProfile` models nine values, so a league
 * carrying bonuses outside that set — a hundred-yard rushing bonus, a
 * first-down premium — matches here and is still playing a different game. That
 * is a real limit and not a small one; it is accepted because the app's *own*
 * projections are computed from the same nine, so this is at least consistent
 * with what the rest of the codebase means by "this league's scoring". Widening
 * the profile widens this check for free.
 */

import type { ScoringProfile } from './scoring.ts';
import type { DstScoring, ScoringTier } from './dstScoring.ts';

/** Which of the three published totals a league is entitled to read. */
export type SleeperScoringKey = 'pts_std' | 'pts_half_ppr' | 'pts_ppr';

/** The publisher this feed has always named. Recorded, never assumed. */
export const SLEEPER_PROJECTION_PUBLISHER = 'rotowire';

/**
 * The positions worth asking for.
 *
 * The endpoint takes repeated `position[]` parameters and answers with every
 * player at those positions.
 *
 * `DEF` was missing until 10 September 2026, and its absence is worth recording
 * because of what it cost. The previous round built a published fallback for
 * defences end to end — the scoring, the refusal rule, the label on the screen,
 * the tests — and shipped it against a feed that was never asked for a single
 * defensive row. Jacksonville showed a dash in production the same way it had
 * before the feature existed, and every part of the feature looked correct in
 * isolation. Thirty-two rows a week; the whole of the fix is this list.
 *
 * Kickers stay out. Nothing this app draws reads a kicker's projection, so
 * fetching them would be storage spent on a column nobody looks at.
 */
export const SLEEPER_PROJECTION_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DEF'] as const;

/**
 * Sleeper's default scoring, as the published totals assume it.
 *
 * Everything except the per-reception value, which is what distinguishes the
 * three totals from each other and is therefore matched separately.
 */
const PUBLISHED_ASSUMPTIONS = {
  pointsPerRushYard: 0.1,
  pointsPerRecYard: 0.1,
  pointsPerPassYard: 0.04,
  passTd: 4,
  rushTd: 6,
  recTd: 6,
  interception: -1,
  fumbleLost: -2,
} as const satisfies Partial<Record<keyof ScoringProfile, number>>;

type AssumedSetting = keyof typeof PUBLISHED_ASSUMPTIONS;

/**
 * Which of those settings can move which player's published total.
 *
 * Turnovers and rushing are on both lists: a quarterback runs and fumbles, and
 * so does everybody else. What separates them is that passing settings reach
 * only the quarterback, and the reception value — matched separately, as the
 * thing that picks between the three totals — reaches only the pass-catchers.
 *
 * A position this app does not draw from the feed, or one it was not told,
 * is checked against everything. "We were not told" is not "it does not
 * matter", and the conservative answer costs a fallback rather than credibility.
 */
const RELEVANT: Readonly<Record<string, readonly AssumedSetting[]>> = {
  QB: ['pointsPerPassYard', 'passTd', 'interception', 'pointsPerRushYard', 'rushTd', 'fumbleLost'],
  RB: ['pointsPerRushYard', 'rushTd', 'pointsPerRecYard', 'recTd', 'fumbleLost'],
  WR: ['pointsPerRushYard', 'rushTd', 'pointsPerRecYard', 'recTd', 'fumbleLost'],
  TE: ['pointsPerRushYard', 'rushTd', 'pointsPerRecYard', 'recTd', 'fumbleLost'],
};

const EVERYTHING = Object.keys(PUBLISHED_ASSUMPTIONS) as AssumedSetting[];

/**
 * Rotowire's projected stat line for a defence, in counts rather than points.
 *
 * A defence is the one position whose published *total* this app does not quote.
 * Everybody else gets one of three totals computed under scoring close enough to
 * a real league's to stand behind; a defence gets nothing of the sort, because
 * two leagues that agree on every other rule can disagree about a defence by
 * more than a defence is worth — one pays ten for a shutout and another pays
 * five, one scores yards allowed and another does not.
 *
 * The feed publishes the components, though: expected sacks, interceptions,
 * fumble recoveries, touchdowns, points allowed, yards allowed. So the number a
 * defence is worth **in this league** is not a guess and does not need one. It
 * is this line put through the league's own table by {@link scorePublishedDefense}.
 *
 * That replaced a comparison table — a hand-written copy of what the feed was
 * assumed to pay, used to decide whether its total was safe to quote. Two of its
 * nine values had never been established and were filled in from an answer about
 * a *league* rather than about the feed, and on 10 September 2026 all 32 rows of
 * the live week were fitted against their own published totals: the feed pays 1
 * per forced fumble, not 0. Reconstructing the totals from the components under
 * Sleeper's defaults then matched to within 0.03 points a team, worst case 0.06.
 * A table that has to be right about somebody else's model is a liability when
 * the components are published beside the total.
 */
export interface PublishedDefenseLine {
  sacks: number;
  interceptions: number;
  fumbleRecoveries: number;
  forcedFumbles: number;
  /** Touchdowns the defence scores. Returns are counted separately below. */
  defensiveTds: number;
  /** Kick and punt return touchdowns, which many leagues price apart. */
  specialTeamsTds: number;
  safeties: number;
  blockedKicks: number;
  /** Expected points allowed, which the points-allowed table is read at. */
  pointsAllowed: number | null;
  /** Expected yards allowed, for the leagues that score it. */
  yardsAllowed: number | null;
}

/**
 * What this league pays for the week Rotowire has projected, or null.
 *
 * Null exactly when the league's defence scoring could not be read, which is
 * the same condition everything else downstream treats as "no opinion" — see
 * `core/sleeper/dstScoring.ts`. A supported league always gets a number, even a
 * league whose rules are nothing like Sleeper's defaults, because nothing here
 * is being compared against an assumption: the counts are Rotowire's and the
 * points-per-count are the league's own.
 *
 * Both tables are read at the *expected* value rather than summed over a
 * distribution, which is what the feed itself does — it publishes `pts_allow`
 * 15.75 alongside a single `pts_allow_14_20: 1` — so this reproduces the
 * published total for a default league rather than quietly disagreeing with it.
 */
export function scorePublishedDefense(
  line: PublishedDefenseLine,
  dst: DstScoring | null | undefined,
): number | null {
  if (!dst || !dst.supported) return null;

  let points =
    line.sacks * dst.sack +
    line.interceptions * dst.interception +
    line.fumbleRecoveries * dst.fumbleRecovery +
    line.forcedFumbles * dst.forcedFumble +
    line.defensiveTds * dst.defensiveTd +
    line.specialTeamsTds * dst.specialTeamsTd +
    line.safeties * dst.safety +
    line.blockedKicks * dst.blockedKick;

  points += tierPoints(dst.pointsAllowed, line.pointsAllowed);
  points += tierPoints(dst.yardsAllowed, line.yardsAllowed);

  return Math.round(points * 100) / 100;
}

/** The band this figure falls in, or nothing when the league has no table. */
function tierPoints(tiers: readonly ScoringTier[], value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const tier = tiers.find((t) => value >= t.from && value < t.to);
  return tier?.points ?? 0;
}

/**
 * Why this league gets no published number for a defence, or null when it does.
 *
 * One reason left, where there used to be four. A league is no longer refused
 * for scoring a defence differently from the feed — that is precisely the case
 * {@link scorePublishedDefense} handles — so the only way to have no answer is
 * to have no readable rules to score against.
 */
export function publishedDefenseRefusal(dst: DstScoring | null | undefined): string | null {
  if (!dst) return 'this league’s defense scoring could not be read';
  if (dst.supported) return null;
  return dst.unsupported.length > 0
    ? `this league scores defenses on rules this app cannot map (${dst.unsupported.join(', ')})`
    : 'this league’s defense scoring could not be read';
}

/** Exact within a float's tolerance — these are settings, not measurements. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Which published total this league may read for this player, or null.
 *
 * Position decides two things: which of the assumed settings are checked at all
 * (see {@link RELEVANT} — a six-point passing touchdown moves quarterbacks and
 * nobody else), and whether a tight-end premium applies.
 *
 * An **unknown** position is checked against every setting, and is refused a
 * premium league's fallback along with the tight ends, because it might be one.
 * A caller that cannot say who it is asking about gets the conservative answer
 * rather than a number that might be wrong — which is why the matchup path,
 * whose source bag carries no positions, is the strictest of the two callers.
 */
export function sleeperScoringKey(
  profile: ScoringProfile | null | undefined,
  position: string | null | undefined,
): SleeperScoringKey | null {
  if (!profile) return null;

  const pos = String(position ?? '').trim().toUpperCase();

  /*
   * A defence reads no published total at all, in any league.
   *
   * Not a refusal — an answer to a different question. `scorePublishedDefense`
   * computes a defence's number from Rotowire's projected counts under this
   * league's own table, which is exact where quoting a foreign total could only
   * ever be close, so there is nothing here for a defence to fall back to.
   */
  if (pos === 'DEF' || pos === 'DST') return null;

  for (const key of RELEVANT[pos] ?? EVERYTHING) {
    if (!same(profile[key] as number, PUBLISHED_ASSUMPTIONS[key])) return null;
  }

  // A tight end in a premium league scores more per catch than any published
  // total knows about. Everybody else in the same league is unaffected — but
  // "we were not told" is not "he is not a tight end".
  if (profile.teBonus !== 0 && (pos === '' || pos === 'TE')) return null;

  return scoringKeyFor(profile);
}

/** Which of the three published totals this league reads, by its reception value. */
function scoringKeyFor(profile: ScoringProfile): SleeperScoringKey | null {
  if (same(profile.ppr, 0)) return 'pts_std';
  if (same(profile.ppr, 0.5)) return 'pts_half_ppr';
  if (same(profile.ppr, 1)) return 'pts_ppr';
  return null;
}

/**
 * Why this league may not read a published total for this position, in one
 * clause a reader can act on — or null when it may.
 *
 * The silent half of {@link sleeperScoringKey} said out loud. That function
 * returns null for two quite different reasons and a screen showing a dash
 * cannot tell them apart: *nobody published a number for him*, and *a number was
 * published and this app will not quote it, because it was computed under
 * scoring this league does not use*.
 *
 * The second is the one that looks like a bug and is not. In a league scoring
 * six-point passing touchdowns, every running back, receiver and tight end gets
 * Rotowire's number and the quarterback gets a dash — correctly, because the
 * published total would understate him by roughly two points a touchdown — and
 * from the outside that is indistinguishable from the feed having skipped him.
 * Reported as exactly that on 2 September 2026: "projections show for most
 * players but not for QB Joe Burrow specifically."
 *
 * Naming the settings rather than saying "scoring differs" is deliberate. The
 * reader can check the two named values against his league in Sleeper and
 * satisfy himself in ten seconds; "differs" would send him looking through
 * thirty of them.
 */
export function publishedRefusal(
  profile: ScoringProfile | null | undefined,
  position: string | null | undefined,
): string | null {
  if (!profile) return null;
  if (sleeperScoringKey(profile, position) != null) return null;

  const pos = String(position ?? '').trim().toUpperCase();
  /* A defence is scored under this league's own rules, so the only refusal
   * left is that those rules could not be read at all. */
  if (pos === 'DEF' || pos === 'DST') return publishedDefenseRefusal(profile.dst);
  const differing = (RELEVANT[pos] ?? EVERYTHING).filter(
    (key) => !same(profile[key] as number, PUBLISHED_ASSUMPTIONS[key]),
  );

  if (profile.teBonus !== 0 && (pos === '' || pos === 'TE')) {
    differing.push('teBonus' as AssumedSetting);
  }

  if (differing.length === 0) {
    // Everything checked matches, so what disqualified the league is its
    // per-reception value — the one setting that picks between the three
    // published totals rather than being compared against a single assumption.
    return `no published projection is quoted here: this league scores ${profile.ppr} per reception, and the published feed only publishes totals for 0, 0.5 and 1.`;
  }

  const named = differing.map((key) => SETTING_WORDS[key]).join(' and ');
  return `no published projection is quoted for ${pos || 'this position'}: the feed assumes ${named}, and this league does not.`;
}

/** What each assumed setting is called in a sentence a user reads. */
const SETTING_WORDS: Record<string, string> = {
  pointsPerPassYard: '0.04 points per passing yard',
  pointsPerRushYard: '0.1 points per rushing yard',
  pointsPerRecYard: '0.1 points per receiving yard',
  passTd: '4 points per passing touchdown',
  rushTd: '6 points per rushing touchdown',
  recTd: '6 points per receiving touchdown',
  interception: '-1 per interception',
  fumbleLost: '-2 per fumble lost',
  teBonus: 'no tight-end premium',
};

/** One player's published week, as this app stores it. */
export interface SleeperWeeklyProjection {
  playerId: string;
  /** The publisher named on the row, lowercased. Null when the row omits it. */
  publisher: string | null;
  /** The three totals, each null when the row does not carry it. */
  points: Record<SleeperScoringKey, number | null>;
  /** The projected counts, on a defence's row only. Null for everybody else. */
  defense: PublishedDefenseLine | null;
}

interface RawRow {
  player_id?: unknown;
  company?: unknown;
  stats?: Record<string, unknown> | null;
  player?: { position?: unknown } | null;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn the feed into rows worth storing, and drop everything else.
 *
 * A row with no player id cannot be joined to anything, and a row whose three
 * totals are all absent is a player Rotowire has not projected — storing either
 * would put a key in the table that can only ever answer "nothing". Zero is not
 * absence and is kept: a projected zero is a real forecast about a player nobody
 * expects to play.
 */
export function parseSleeperWeeklyProjections(payload: unknown): SleeperWeeklyProjection[] {
  if (!Array.isArray(payload)) return [];
  const out: SleeperWeeklyProjection[] = [];

  for (const raw of payload as RawRow[]) {
    const playerId = raw?.player_id == null ? '' : String(raw.player_id).trim();
    if (!playerId) continue;

    const stats = (raw.stats ?? {}) as Record<string, unknown>;
    const points = {
      pts_std: finite(stats['pts_std']),
      pts_half_ppr: finite(stats['pts_half_ppr']),
      pts_ppr: finite(stats['pts_ppr']),
    } satisfies Record<SleeperScoringKey, number | null>;

    if (points.pts_std == null && points.pts_half_ppr == null && points.pts_ppr == null) continue;

    const company = raw.company == null ? '' : String(raw.company).trim().toLowerCase();
    out.push({ playerId, publisher: company || null, points, defense: defenseLine(raw, stats) });
  }

  return out;
}

/**
 * A defence's projected counts, or null when this row is not a defence.
 *
 * Identified by the position on the row rather than by which stats are present,
 * because a defence projected to do nothing at all would carry no defensive
 * stats and must still be recognised as a defence — and because a running back
 * with a return touchdown carries `st_td` without being one.
 *
 * Zero where a count is absent, which is what the feed means by omitting it: a
 * row without `safe` is a defence projected not to record a safety, not a
 * defence whose safeties are unknown. `pts_allow` and `yds_allow` are the
 * exception and stay null, because reading a missing expectation as zero would
 * put every such defence in the shutout band.
 */
function defenseLine(raw: RawRow, stats: Record<string, unknown>): PublishedDefenseLine | null {
  const position = String(raw.player?.position ?? '').trim().toUpperCase();
  if (position !== 'DEF' && position !== 'DST') return null;
  const count = (key: string): number => finite(stats[key]) ?? 0;
  return {
    sacks: count('sack'),
    interceptions: count('int'),
    fumbleRecoveries: count('fum_rec'),
    forcedFumbles: count('ff'),
    defensiveTds: count('def_td'),
    specialTeamsTds: count('st_td'),
    safeties: count('safe'),
    blockedKicks: count('blk_kick'),
    pointsAllowed: finite(stats['pts_allow']),
    yardsAllowed: finite(stats['yds_allow']),
  };
}

/**
 * The path this feed lives at, which is *not* under the client's `/v1` base.
 *
 * Written here rather than at the call site so the one caller and the one test
 * are reading the same string.
 */
export function sleeperProjectionPath(season: string, week: number): string {
  const positions = SLEEPER_PROJECTION_POSITIONS.map((p) => `position[]=${p}`).join('&');
  return `/projections/nfl/${encodeURIComponent(season)}/${week}?season_type=regular&${positions}&order_by=ppr`;
}
