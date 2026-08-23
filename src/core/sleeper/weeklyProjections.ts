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
 * are not the ones the published totals assume, and a null key means no
 * fallback for that player. It is deliberately exact rather than tolerant: every
 * value below is Sleeper's own default, so an ordinary league matches and a
 * customised one is declined.
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
const PUBLISHED_ASSUMPTIONS: Readonly<Record<string, number>> = {
  pointsPerRushYard: 0.1,
  pointsPerRecYard: 0.1,
  pointsPerPassYard: 0.04,
  passTd: 4,
  rushTd: 6,
  recTd: 6,
  interception: -1,
  fumbleLost: -2,
};

/** Exact within a float's tolerance — these are settings, not measurements. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Which published total this league may read for this player, or null.
 *
 * Position matters for exactly one reason: a tight-end premium adds points per
 * reception for tight ends only, so a TE-premium league is playing Rotowire's
 * game at every position except tight end. Refusing the whole league would throw
 * away three correct answers to avoid one wrong one.
 *
 * In such a league an **unknown** position is refused along with a tight end's,
 * because it might be one. A caller that cannot say who it is asking about gets
 * the conservative answer rather than a number that is wrong for one position in
 * four — which is why the matchup path, whose source bag carries no positions,
 * simply has no fallback in a premium league.
 */
export function sleeperScoringKey(
  profile: ScoringProfile | null | undefined,
  position: string | null | undefined,
): SleeperScoringKey | null {
  if (!profile) return null;

  for (const [key, expected] of Object.entries(PUBLISHED_ASSUMPTIONS)) {
    if (!same(profile[key as keyof ScoringProfile] as number, expected)) return null;
  }

  // A tight end in a premium league scores more per catch than any published
  // total knows about. Everybody else in the same league is unaffected — but
  // "we were not told" is not "he is not a tight end".
  if (profile.teBonus !== 0) {
    const pos = String(position ?? '').trim().toUpperCase();
    if (pos === '' || pos === 'TE') return null;
  }

  if (same(profile.ppr, 0)) return 'pts_std';
  if (same(profile.ppr, 0.5)) return 'pts_half_ppr';
  if (same(profile.ppr, 1)) return 'pts_ppr';
  return null;
}

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
