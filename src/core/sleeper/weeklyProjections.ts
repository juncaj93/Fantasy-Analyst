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
  for (const key of RELEVANT[pos] ?? EVERYTHING) {
    if (!same(profile[key] as number, PUBLISHED_ASSUMPTIONS[key])) return null;
  }

  // A tight end in a premium league scores more per catch than any published
  // total knows about. Everybody else in the same league is unaffected — but
  // "we were not told" is not "he is not a tight end".
  if (profile.teBonus !== 0 && (pos === '' || pos === 'TE')) return null;

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
