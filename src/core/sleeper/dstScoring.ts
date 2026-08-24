/**
 * What a defence is worth **in this league**, read from this league's own rules.
 *
 * Every other position in this app is scored from a handful of settings that
 * are close to universal: a reception is worth 0, 0.5 or 1, a passing touchdown
 * is worth 4 or 6, and the spread of real leagues over those is small enough
 * that a wrong guess is a rounding error. A defence is not like that. Two
 * leagues that look identical everywhere else can disagree about a defence by
 * more than a defence is worth:
 *
 *   - one pays 10 for a shutout, another pays 5, a third pays nothing at all;
 *   - one scores yards allowed as well as points allowed, doubling the weight
 *     of the same fact;
 *   - one pays 1 per sack, another 2, another 0.5;
 *   - one pays 6 for a defensive touchdown, another 6 for *any* touchdown the
 *     unit scores including returns, another separates the two.
 *
 * So there is no such thing as "standard DST scoring" to fall back on, and
 * assuming one is how a defence ends up ranked by somebody else's rules. This
 * module reads the settings Sleeper already persists for the league
 * (`leagues.scoring_settings_json`) and answers one of two ways: **here is what
 * a defensive event is worth here**, or **this league's defence scoring is not
 * something I can map, so I have no opinion**.
 *
 * ## The refusal is the feature
 *
 * {@link DstScoring.supported} is false whenever the league publishes a
 * defence-affecting setting this module does not model. Not "probably fine",
 * not "close enough" — a defence whose score is missing a category the league
 * actually pays for is wrong by an unknown amount, and an unknown amount is
 * exactly the thing a lineup screen must not print a number for. Everything
 * downstream treats `supported: false` as no score at all rather than as a
 * degraded one; see `core/startsit/dstProjection.ts`.
 *
 * ## What this module is not
 *
 * It is not a projection and it holds no football in it. It converts *counts*
 * into *points*. How many sacks a defence is expected to get, and how many
 * points it is expected to allow, are questions for the projection module,
 * which is where the market anchor lives. Keeping the two apart is what makes
 * "the league's rules" and "this week's game" separately testable, and it is
 * why a league-scoring change cannot quietly become a football claim.
 */

/**
 * One tier of a points-allowed or yards-allowed table.
 *
 * Half-open on the upper bound — `[from, to)` — so the bands tile the number
 * line without a gap or an overlap, which is what lets an expectation over them
 * be a plain weighted sum. The last band's `to` is `Infinity`.
 */
export interface ScoringTier {
  from: number;
  to: number;
  points: number;
}

/**
 * The league's defensive scoring, in points per event.
 *
 * Every field is what *this league* pays, read from its own settings. A league
 * that does not score a category carries 0 for it, which is a real answer —
 * "this league pays nothing for a sack" — and is not the same as
 * `supported: false`, which is "this league pays for something I cannot read".
 */
export interface DstScoring {
  /**
   * False when the league publishes a defence-affecting setting this module
   * does not model. Nothing may be scored for a defence in that league.
   */
  supported: boolean;
  /** The settings that caused the refusal, for the sentence the screen shows. */
  unsupported: string[];
  /** Points per sack. */
  sack: number;
  /** Points per interception the unit takes. */
  interception: number;
  /** Points per fumble recovered. */
  fumbleRecovery: number;
  /** Points per fumble forced. Scored by some leagues on top of the recovery. */
  forcedFumble: number;
  /** Points per touchdown the defence scores. */
  defensiveTd: number;
  /**
   * Points per touchdown the special teams unit scores, when the league
   * separates it from a defensive one. Leagues that pay one figure for both
   * carry the same number in each.
   */
  specialTeamsTd: number;
  /** Points per safety. */
  safety: number;
  /** Points per blocked kick. */
  blockedKick: number;
  /** Points per two-point conversion returned. */
  twoPointReturn: number;
  /** The points-allowed table, ascending. Empty when the league has none. */
  pointsAllowed: ScoringTier[];
  /** The yards-allowed table, ascending. Empty when the league has none. */
  yardsAllowed: ScoringTier[];
  /**
   * True when the league's rules contain something the opponent's implied
   * total can actually move.
   *
   * A league scoring only sacks and turnovers pays every defence the same
   * expected number under this model, because the anchor reaches a defence
   * through what it is expected to *allow*. That is a real property of the
   * league's rules and it is surfaced rather than papered over — see
   * `dstProjection.ts`, which degrades confidence and says so.
   */
  anchorSensitive: boolean;
}

/** A league whose defence scoring could not be read. Never scored. */
export const DST_SCORING_UNSUPPORTED: DstScoring = {
  supported: false,
  unsupported: [],
  sack: 0,
  interception: 0,
  fumbleRecovery: 0,
  forcedFumble: 0,
  defensiveTd: 0,
  specialTeamsTd: 0,
  safety: 0,
  blockedKick: 0,
  twoPointReturn: 0,
  pointsAllowed: [],
  yardsAllowed: [],
  anchorSensitive: false,
};

/**
 * Sleeper's per-event defence keys, and what each one means here.
 *
 * Written out rather than pattern-matched because the mapping is the claim: a
 * key this table does not name is a key nobody has decided the meaning of, and
 * the whole point of {@link DST_KEY_PATTERNS} below is that such a key stops
 * the league being scored rather than being silently dropped.
 *
 * `def_st_*` are the special-teams counterparts Sleeper publishes separately.
 * A league that scores both pays for both, and both are read.
 */
const EVENT_KEYS = {
  sack: ['sack'],
  interception: ['int'],
  fumbleRecovery: ['fum_rec', 'def_st_fum_rec', 'st_fum_rec'],
  forcedFumble: ['ff', 'def_st_ff', 'st_ff'],
  defensiveTd: ['def_td'],
  specialTeamsTd: ['def_st_td', 'st_td'],
  safety: ['safe'],
  blockedKick: ['blk_kick'],
  twoPointReturn: ['def_2pt', 'def_st_2pt'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Sleeper's points-allowed bands, as the settings name them.
 *
 * The bounds are Sleeper's, not this app's: `pts_allow_1_6` is 1 to 6 points
 * inclusive, so as a half-open band it is `[1, 7)`. Getting these off by one
 * would move every shutout into the wrong bucket, which is the single most
 * valuable band in the table.
 */
const POINTS_ALLOWED_KEYS: { key: string; from: number; to: number }[] = [
  { key: 'pts_allow_0', from: 0, to: 1 },
  { key: 'pts_allow_1_6', from: 1, to: 7 },
  { key: 'pts_allow_7_13', from: 7, to: 14 },
  { key: 'pts_allow_14_20', from: 14, to: 21 },
  { key: 'pts_allow_21_27', from: 21, to: 28 },
  { key: 'pts_allow_28_34', from: 28, to: 35 },
  { key: 'pts_allow_35p', from: 35, to: Infinity },
];

/** Sleeper's yards-allowed bands, same convention. */
const YARDS_ALLOWED_KEYS: { key: string; from: number; to: number }[] = [
  { key: 'yds_allow_0_100', from: 0, to: 100 },
  { key: 'yds_allow_100_199', from: 100, to: 200 },
  { key: 'yds_allow_200_299', from: 200, to: 300 },
  { key: 'yds_allow_300_349', from: 300, to: 350 },
  { key: 'yds_allow_350_399', from: 350, to: 400 },
  { key: 'yds_allow_400_449', from: 400, to: 450 },
  { key: 'yds_allow_450_499', from: 450, to: 500 },
  { key: 'yds_allow_500_549', from: 500, to: 550 },
  { key: 'yds_allow_550p', from: 550, to: Infinity },
];

/**
 * Which settings are a defence's business at all.
 *
 * The test that decides whether an unmodelled setting is fatal. A league
 * scoring `bonus_rec_te` has said nothing about defences and must not be
 * refused for it; a league scoring `def_forced_punts` has, and must be.
 *
 * Deliberately does **not** include the individual-defensive-player keys
 * (`tkl_solo`, `tkl_ast`, `idp_*`, `pass_def` and the rest). Those score a
 * linebacker in an IDP league, not the team unit, so they change nothing about
 * what a DST is worth — and refusing every IDP league's defence for settings
 * that do not touch it would be a refusal with no reason behind it. IDP itself
 * is out of scope for this lane either way.
 */
const DST_KEY_PATTERNS: RegExp[] = [
  /^def_/,
  /^st_/,
  /^pts_allow/,
  /^yds_allow/,
  /^sack/,
  /^blk_kick/,
  /^safe$/,
  /^int_ret/,
  /^fum_ret/,
];

/**
 * Individual-defender keys that match a pattern above but are not the unit's.
 *
 * `sack_yd` and the return-yardage keys are the awkward ones: they look like
 * team-defence settings and in an IDP league they are a player's. They are
 * listed here as *unmodelled but not fatal* only where they cannot reach a DST
 * score — and none of these can, because none of them is a category Sleeper
 * credits to the DEF slot.
 */
const NOT_THE_UNITS: ReadonlySet<string> = new Set([
  'def_pass_def',
  'def_snp',
  'def_st_snp',
  'st_snp',
  'idp_def_snp',
]);

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a league's defence scoring, or refuse to.
 *
 * The two-pass shape is deliberate. The first pass reads everything this module
 * knows how to read; the second asks what is left over, and *anything* left
 * over that a defence could be paid for takes the whole league out of scope.
 * Doing it the other way round — mapping what is recognised and shrugging at
 * the rest — is exactly the "assume standard scoring" failure this exists to
 * prevent, because the shrug is invisible in the number that comes out.
 */
export function buildDstScoring(scoringSettings: Record<string, unknown> | null | undefined): DstScoring {
  const settings = scoringSettings ?? {};

  const read = (keys: readonly string[]): number =>
    keys.reduce((total, key) => total + (finite(settings[key]) ?? 0), 0);

  const tiers = (table: { key: string; from: number; to: number }[]): ScoringTier[] => {
    const out = table
      .map((band) => ({ from: band.from, to: band.to, points: finite(settings[band.key]) ?? 0 }))
      .filter(() => true);
    // A table nobody scored is no table, not a table of zeroes: the difference
    // decides whether the market anchor has anything to reach this league
    // through, and a row of zeroes would claim it does.
    return out.some((band) => band.points !== 0) ? out : [];
  };

  const claimed = new Set<string>([
    ...Object.values(EVENT_KEYS).flat(),
    ...POINTS_ALLOWED_KEYS.map((b) => b.key),
    ...YARDS_ALLOWED_KEYS.map((b) => b.key),
    ...NOT_THE_UNITS,
  ]);

  /*
   * Everything the league pays a defence for that this module cannot read.
   *
   * Zero-valued settings are ignored on purpose. Sleeper writes a league's
   * whole scoring table including the categories it has switched off, so a
   * `def_forced_punts: 0` is the league saying it does *not* score forced
   * punts — refusing on that would refuse nearly every league for settings none
   * of them use.
   */
  const unsupported: string[] = [];
  for (const [key, raw] of Object.entries(settings)) {
    if (claimed.has(key)) continue;
    if (!DST_KEY_PATTERNS.some((pattern) => pattern.test(key))) continue;
    const value = finite(raw);
    if (value == null || value === 0) continue;
    unsupported.push(key);
  }
  unsupported.sort();

  if (unsupported.length > 0) return { ...DST_SCORING_UNSUPPORTED, unsupported };

  const pointsAllowed = tiers(POINTS_ALLOWED_KEYS);
  const yardsAllowed = tiers(YARDS_ALLOWED_KEYS);

  return {
    supported: true,
    unsupported: [],
    sack: read(EVENT_KEYS.sack),
    interception: read(EVENT_KEYS.interception),
    fumbleRecovery: read(EVENT_KEYS.fumbleRecovery),
    forcedFumble: read(EVENT_KEYS.forcedFumble),
    defensiveTd: read(EVENT_KEYS.defensiveTd),
    specialTeamsTd: read(EVENT_KEYS.specialTeamsTd),
    safety: read(EVENT_KEYS.safety),
    blockedKick: read(EVENT_KEYS.blockedKick),
    twoPointReturn: read(EVENT_KEYS.twoPointReturn),
    pointsAllowed,
    yardsAllowed,
    anchorSensitive: pointsAllowed.length > 0 || yardsAllowed.length > 0,
  };
}

/**
 * The expected points from a tier table, given a distribution over outcomes.
 *
 * `probabilityOf(from, to)` is the chance the real number lands in that band.
 * Passing the distribution in rather than computing one here is what keeps this
 * module free of football: the same weighted sum serves points allowed and
 * yards allowed, and the thing that knows what a defence is likely to give up
 * is the projection.
 */
export function expectedTierPoints(
  tiers: readonly ScoringTier[],
  probabilityOf: (from: number, to: number) => number,
): number {
  let total = 0;
  for (const tier of tiers) total += tier.points * probabilityOf(tier.from, tier.to);
  return total;
}

/** Whether this league scores defences at all — i.e. whether any setting is non-zero. */
export function scoresDefences(scoring: DstScoring): boolean {
  if (!scoring.supported) return false;
  return (
    scoring.sack !== 0 ||
    scoring.interception !== 0 ||
    scoring.fumbleRecovery !== 0 ||
    scoring.forcedFumble !== 0 ||
    scoring.defensiveTd !== 0 ||
    scoring.specialTeamsTd !== 0 ||
    scoring.safety !== 0 ||
    scoring.blockedKick !== 0 ||
    scoring.twoPointReturn !== 0 ||
    scoring.pointsAllowed.length > 0 ||
    scoring.yardsAllowed.length > 0
  );
}
