/**
 * Is this a best-ball league? Ask Sleeper, or say you do not know.
 *
 * The answer decides how far Underdog's ADP leads Sleeper's inside the market
 * baseline — 75/25 instead of 60/40 — so getting it wrong quietly reweights
 * every player on the board. There are three tempting ways to guess it and all
 * three are banned here:
 *
 *  - **The league name.** "Motown Best Ball Dynasty" is a string somebody typed.
 *    So is "Best Friends League", which is not a best-ball league, and so is
 *    "The Guys", which might be.
 *  - **Anything the user typed.** A setting the user sets is a setting the user
 *    forgets to change next season.
 *  - **The date.** Best ball is not a season of the year.
 *
 * What is left is Sleeper's own settings, which is the only place the fact
 * actually lives. Sleeper marks it as `settings.best_ball = 1` on the league,
 * and mirrors it on the draft's metadata in some drafts. Either is authority.
 * Neither present means the honest answer is "not stated", and the caller falls
 * back to the ordinary blend rather than to a coin flip — see the brief: an
 * unconfident detection uses 60/40 and says so.
 */

export type BestBallBasis = 'league_settings' | 'draft_settings' | 'league_metadata' | 'none';

export interface BestBallDetection {
  /** What the blend should use. False whenever it is not positively stated. */
  bestBall: boolean;
  /**
   * Whether Sleeper actually stated it.
   *
   * `bestBall: false, confident: false` is the degraded case — a league that
   * may or may not be best ball, priced as if it is not, and reported as such.
   */
  confident: boolean;
  basis: BestBallBasis;
  /** Said plainly, for the board's diagnostics. */
  reason: string;
}

/** The keys Sleeper is known to spell it under, in the order they are trusted. */
const KEYS = ['best_ball', 'bestBall', 'bestball'] as const;

export interface BestBallInput {
  /** `league.settings` as Sleeper published it. */
  leagueSettings?: Record<string, unknown> | null;
  /** `draft.settings` / `draft.metadata`, when a draft is loaded. */
  draftSettings?: Record<string, unknown> | null;
  /** `league.metadata`, which some leagues carry it on instead. */
  leagueMetadata?: Record<string, unknown> | null;
}

/**
 * Read the format. Deterministic: same settings in, same answer out, always.
 *
 * The league's own settings win over the draft's when both state it — a draft
 * belongs to a league, and the league is where the format is configured.
 */
export function detectBestBall(input: BestBallInput): BestBallDetection {
  const fromLeague = readFlag(input.leagueSettings);
  if (fromLeague != null) {
    return {
      bestBall: fromLeague,
      confident: true,
      basis: 'league_settings',
      reason: `Sleeper's league settings say best_ball = ${fromLeague ? 1 : 0}`,
    };
  }

  const fromDraft = readFlag(input.draftSettings);
  if (fromDraft != null) {
    return {
      bestBall: fromDraft,
      confident: true,
      basis: 'draft_settings',
      reason: `Sleeper's draft settings say best_ball = ${fromDraft ? 1 : 0}`,
    };
  }

  const fromMetadata = readFlag(input.leagueMetadata);
  if (fromMetadata != null) {
    return {
      bestBall: fromMetadata,
      confident: true,
      basis: 'league_metadata',
      reason: `Sleeper's league metadata says best_ball = ${fromMetadata ? 1 : 0}`,
    };
  }

  return {
    bestBall: false,
    confident: false,
    basis: 'none',
    reason:
      'Sleeper has not published a best-ball flag for this league, so the market baseline uses the ordinary 60/40 blend',
  };
}

/**
 * One settings object, read for the flag.
 *
 * Sleeper sends it as a number in the league settings and as the *string*
 * `"1"` in draft metadata, so both are read — but only exact, unambiguous
 * values. Anything else is "not stated", which is a different answer from
 * "false" and is why this returns null rather than a boolean.
 */
function readFlag(settings: Record<string, unknown> | null | undefined): boolean | null {
  if (!settings || typeof settings !== 'object') return null;
  for (const key of KEYS) {
    const raw = settings[key];
    if (raw === 1 || raw === true || raw === '1' || raw === 'true') return true;
    if (raw === 0 || raw === false || raw === '0' || raw === 'false') return false;
  }
  return null;
}

/** The blend format this detection implies. */
export function marketFormatOf(detection: BestBallDetection): 'standard' | 'best_ball' {
  return detection.bestBall ? 'best_ball' : 'standard';
}
