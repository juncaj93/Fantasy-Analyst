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
 * **What this cannot see.** `ScoringProfile` models nine values, so a league
 * carrying bonuses outside that set — a hundred-yard rushing bonus, a
 * first-down premium — matches here and is still playing a different game. That
 * is a real limit and not a small one; it is accepted because the app's *own*
 * projections are computed from the same nine, so this is at least consistent
 * with what the rest of the codebase means by "this league's scoring". Widening
 * the profile widens this check for free.
 */

import type { ScoringProfile } from './scoring.ts';
import { buildDstScoring, type DstScoring, type ScoringTier } from './dstScoring.ts';

/** Which of the three published totals a league is entitled to read. */
export type SleeperScoringKey = 'pts_std' | 'pts_half_ppr' | 'pts_ppr';

/** The publisher this feed has always named. Recorded, never assumed. */
export const SLEEPER_PROJECTION_PUBLISHER = 'rotowire';

/**
 * The positions worth asking for.
 *
 * The endpoint takes repeated `position[]` parameters and answers with every
 * player at those positions. Kickers and defences are omitted because Rotowire's
 * numbers for them are near-noise and this app does not draw them on the screens
 * that read this feed; adding them later is one entry in this list.
 */
export const SLEEPER_PROJECTION_POSITIONS = ['QB', 'RB', 'WR', 'TE'] as const;

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
 * What the published feed assumes a defence is paid, category by category.
 *
 * A defence is the one position whose published total shares *no* setting with
 * the table above. Rotowire's number for Cincinnati does not move if a league
 * pays six points for a passing touchdown; it moves if the league pays two
 * points for a sack instead of one, or shifts the points-allowed bands.
 *
 * That mismatch used to cost the fallback entirely. `DEF` had no entry in
 * {@link RELEVANT}, so it fell through to `EVERYTHING` and was checked against
 * eight offensive settings — none of which can move it. In a league that pays
 * six-point passing touchdowns, every defence was refused a published total
 * because of a rule about quarterbacks. That is the same defect reported on 2
 * September about Joe Burrow, arriving from the opposite direction: there the
 * refusal was right and looked wrong, here it was simply wrong.
 *
 * These are the categories a defence's published total is actually built from,
 * at the values a default Sleeper league pays. A league that differs on any of
 * them is refused, for the same reason a six-point-passing-touchdown league is
 * refused a quarterback: the number exists, and quoting it would understate or
 * overstate a real amount.
 *
 * **Two categories are deliberately not compared**, and the omission is the
 * honest part of this table rather than a gap in it. `forcedFumble` and
 * `twoPointReturn` are settings this app cannot establish a published
 * assumption for — nothing reachable from here states what the feed paid for
 * them, and this repository's own sample of a real league table
 * (`demo/fixtures/dst.ts`) pays a forced fumble where a bare default would not.
 * Guessing a value in order to compare against it would be inventing the very
 * assumption the comparison exists to check. Both are worth a fraction of a
 * point a week against a points-allowed band worth up to ten, so the trade is
 * a slightly loose refusal rather than a confidently wrong number.
 *
 * If somebody later reads the assumption off a real payload, they belong here
 * with the rest — the shape is already right for them.
 */
const PUBLISHED_DST_ASSUMPTIONS = {
  sack: 1,
  interception: 2,
  fumbleRecovery: 2,
  defensiveTd: 6,
  specialTeamsTd: 6,
  safety: 2,
  blockedKick: 2,
} as const;

/**
 * Sleeper's default points-allowed bands, in a league's own settings keys.
 *
 * The standard table every default Sleeper league starts with. A league that
 * has retuned it is scoring a shutout differently from the feed, and that is
 * the single largest term in a defence's projection.
 *
 * Written as *settings* and run through `buildDstScoring` below rather than
 * hand-written as tiers, because the tier shape is half-open — `pts_allow_0`
 * becomes `{ from: 0, to: 1 }`, not `{ from: 0, to: 0 }` — and a reference
 * table transcribed into the wrong convention would refuse every league in the
 * world while looking exactly right. Building it through the same function the
 * league's own table is built by makes the comparison like-for-like by
 * construction.
 */
const PUBLISHED_DST_SETTINGS = {
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
} as const;

let publishedDstTiers: readonly ScoringTier[] | null = null;
function publishedPointsAllowed(): readonly ScoringTier[] {
  publishedDstTiers ??= buildDstScoring(PUBLISHED_DST_SETTINGS).pointsAllowed;
  return publishedDstTiers;
}

/**
 * Whether this league's defence scoring is the one the feed assumed.
 *
 * Returns the clause explaining a refusal, or null when the published total may
 * be quoted. Deliberately strict: an unreadable rule set (`supported: false`)
 * is refused, a differing category is refused, and a league that has touched
 * the points-allowed or yards-allowed tables at all is refused, because those
 * tables are where most of a defence's expected points actually come from.
 */
export function publishedDstRefusal(dst: DstScoring | null | undefined): string | null {
  if (!dst) return 'this league’s defense scoring could not be read';
  if (!dst.supported) {
    return dst.unsupported.length > 0
      ? `this league scores defenses on rules this app cannot map (${dst.unsupported.join(', ')})`
      : 'this league’s defense scoring could not be read';
  }

  const differing = (Object.keys(PUBLISHED_DST_ASSUMPTIONS) as (keyof typeof PUBLISHED_DST_ASSUMPTIONS)[]).filter(
    (key) => !same(dst[key], PUBLISHED_DST_ASSUMPTIONS[key]),
  );
  if (differing.length > 0) {
    return `this league pays a defense differently from the published feed (${differing.join(', ')})`;
  }

  if (dst.yardsAllowed.length > 0) {
    return 'this league scores yards allowed, which the published feed does not';
  }
  if (!sameTiers(dst.pointsAllowed, publishedPointsAllowed())) {
    return 'this league’s points-allowed bands differ from the published feed’s';
  }
  return null;
}

function sameTiers(a: readonly ScoringTier[], b: readonly ScoringTier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tier, i) => {
    const other = b[i]!;
    return bound(tier.from, other.from) && bound(tier.to, other.to) && same(tier.points, other.points);
  });
}

/**
 * Two band edges, one of which is routinely `Infinity`.
 *
 * `same` is a tolerance comparison, and `Math.abs(Infinity - Infinity)` is NaN,
 * so every comparison against the open-ended top band came back false — which
 * refused every league on earth over a table identical to the one it was being
 * compared with. Caught by the test that asserts a default league *may* read
 * the fallback; without that direction of the assertion this would have looked
 * like a strict rule working perfectly.
 */
function bound(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return same(a, b);
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
   * A defence is judged on defence scoring, and on nothing else.
   *
   * Every setting in `PUBLISHED_ASSUMPTIONS` is an offensive one, so running a
   * defence through them answers a question about somebody else's position.
   * See `publishedDstRefusal` for what is actually checked, and for why this
   * used to refuse Cincinnati over a rule about quarterbacks.
   */
  if (pos === 'DEF' || pos === 'DST') {
    return publishedDstRefusal(profile.dst) == null ? scoringKeyFor(profile) : null;
  }

  for (const key of RELEVANT[pos] ?? EVERYTHING) {
    if (!same(profile[key] as number, PUBLISHED_ASSUMPTIONS[key])) return null;
  }

  // A tight end in a premium league scores more per catch than any published
  // total knows about. Everybody else in the same league is unaffected — but
  // "we were not told" is not "he is not a tight end".
  if (profile.teBonus !== 0 && (pos === '' || pos === 'TE')) return null;

  return scoringKeyFor(profile);
}

/**
 * Which of the three published totals this league reads, by its reception value.
 *
 * A defence takes the same column as everybody else — the feed publishes one
 * `pts_half_ppr` per player and a defence catches no passes, so the three are
 * the same number for it. Reading the league's own column keeps one rule for
 * which total is quoted rather than a second one for defences.
 */
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
  /* The same split as above: a defence's refusal names defence settings. */
  if (pos === 'DEF' || pos === 'DST') {
    return publishedDstRefusal(profile.dst) ?? 'this league reads no published total for a defense';
  }
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
}

interface RawRow {
  player_id?: unknown;
  company?: unknown;
  stats?: Record<string, unknown> | null;
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
    out.push({ playerId, publisher: company || null, points });
  }

  return out;
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
