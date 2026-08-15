/**
 * What kind of player this is, from what he has actually been asked to do.
 *
 * The matchup layer wants to ask a sharper question than "how does this defence
 * do against receivers". A defence that smothers outside receivers and leaks
 * underneath is two different matchups depending on which receiver you own, and
 * treating them as one is most of why generic defence-versus-position rankings
 * are so weak.
 *
 * ## The honest limit, stated once and enforced in the types
 *
 * **This app cannot see alignment.** Slot and outside are not in any free
 * source it ingests: nflverse's weekly player file has no alignment column, and
 * the one release that does carry snap detail (`snap_counts`) is keyed by
 * `pfr_player_id`, an id space this project has deliberately never taken on —
 * see the note at the top of `core/usage/nflverse.ts`.
 *
 * So this module does not produce `slot` or `outside`, and there is no code
 * path anywhere that can. What it produces instead is a **depth-of-target**
 * profile, which is derivable from columns the file does publish, and which
 * answers a related and genuinely useful question: does this receiver work
 * downfield or underneath? A defence's tendency is then measured against the
 * same buckets, so both sides of the matchup are described in a vocabulary the
 * data actually supports.
 *
 * Where even that is unavailable the answer is `unclassified`, which every
 * consumer treats as neutral. Nothing here guesses a role from a position, a
 * name, or a depth chart.
 */

import type { UsageWeek } from '../usage/role.ts';

/**
 * The buckets, one closed vocabulary shared by players and by defences.
 *
 * Named for what was measured rather than for where a player lines up, which is
 * the distinction the paragraph above is about.
 */
export type RoleBucket =
  // Receivers and tight ends, by average depth of target.
  | 'deep_receiver'
  | 'intermediate_receiver'
  | 'underneath_receiver'
  // Backs, by what the touches are.
  | 'rushing_back'
  | 'dual_threat_back'
  | 'receiving_back'
  // Quarterbacks, by whether the legs are part of the job.
  | 'rushing_quarterback'
  | 'pocket_quarterback'
  | 'unclassified';

export const ROLE_LABEL: Record<RoleBucket, string> = {
  deep_receiver: 'Downfield role',
  intermediate_receiver: 'Intermediate role',
  underneath_receiver: 'Underneath role',
  rushing_back: 'Rushing back',
  dual_threat_back: 'Dual-threat back',
  receiving_back: 'Receiving back',
  rushing_quarterback: 'Rushing quarterback',
  pocket_quarterback: 'Pocket quarterback',
  unclassified: 'Role not classified',
};

/**
 * Where the lines are drawn, and why these numbers.
 *
 * Average depth of target is a well-behaved statistic with a stable
 * distribution: league-wide it sits near 8 yards for receivers, with deep
 * specialists in the mid-teens and possession receivers around 6. Tight ends
 * run three to four yards shallower than receivers at the same role, which is
 * why they get their own pair of thresholds rather than being called
 * "underneath" as a group.
 *
 * Tunable. They are stated here, in one place, rather than spread through the
 * classifier, precisely so they can be moved when a season's data says so.
 */
export const ROLE_THRESHOLDS = {
  receiver: { deep: 12.5, underneath: 7.5 },
  tightEnd: { deep: 10, underneath: 5.5 },
  /** Share of a back's touches that are targets before he is "receiving". */
  back: { receiving: 0.42, rushing: 0.18 },
  /** Rushing attempts per game before a quarterback's legs are part of the job. */
  quarterback: { rushing: 4.5 },
  /** Games of usable data below which nothing is claimed. */
  minGames: 3,
  /** Targets in the window below which depth of target is noise. */
  minTargets: 12,
} as const;

export interface RoleProfile {
  bucket: RoleBucket;
  label: string;
  /** Average depth of target, when it could be computed. */
  adot: number | null;
  /** Share of the team's air yards, averaged over the window. */
  airYardsShare: number | null;
  /** Targets as a share of a back's touches. */
  targetShareOfTouches: number | null;
  /** Rushing attempts per game, for quarterbacks. */
  carriesPerGame: number | null;
  /** Games the classification rests on. */
  games: number;
  confidence: 'high' | 'medium' | 'low';
  /** One clause for a card, or null when there is nothing worth saying. */
  detail: string | null;
}

export const UNCLASSIFIED: RoleProfile = {
  bucket: 'unclassified',
  label: ROLE_LABEL.unclassified,
  adot: null,
  airYardsShare: null,
  targetShareOfTouches: null,
  carriesPerGame: null,
  games: 0,
  confidence: 'low',
  detail: null,
};

/**
 * Classify from a window of stored weeks.
 *
 * Regular season only, and a missing field drops that game from that statistic
 * rather than counting as a zero — the same two rules `toRoleMetrics` follows,
 * for the same reason.
 */
export function classifyRole(position: string, weeks: UsageWeek[], window = 8): RoleProfile {
  const games = weeks
    .filter((w) => (w.seasonType ?? 'REG').toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-window);
  if (games.length < ROLE_THRESHOLDS.minGames) return { ...UNCLASSIFIED, games: games.length };

  const pos = position.toUpperCase();
  const targets = sum(games.map((g) => g.targets));
  const carries = sum(games.map((g) => g.carries));
  const airYards = sum(games.map((g) => g.receivingAirYards));
  const airShare = mean(games.map((g) => g.airYardsShare));
  const adot = targets != null && targets > 0 && airYards != null ? round1(airYards / targets) : null;

  if (pos === 'QB') {
    const perGame = carries == null ? null : round1(carries / games.length);
    if (perGame == null) return { ...UNCLASSIFIED, games: games.length };
    const bucket: RoleBucket =
      perGame >= ROLE_THRESHOLDS.quarterback.rushing ? 'rushing_quarterback' : 'pocket_quarterback';
    return {
      bucket,
      label: ROLE_LABEL[bucket],
      adot: null,
      airYardsShare: null,
      targetShareOfTouches: null,
      carriesPerGame: perGame,
      games: games.length,
      confidence: games.length >= 5 ? 'high' : 'medium',
      detail: `${perGame} rushing attempts per game`,
    };
  }

  if (pos === 'RB') {
    const touches = (targets ?? 0) + (carries ?? 0);
    if (touches < 15) return { ...UNCLASSIFIED, games: games.length };
    const share = round2((targets ?? 0) / touches);
    const bucket: RoleBucket =
      share >= ROLE_THRESHOLDS.back.receiving
        ? 'receiving_back'
        : share >= ROLE_THRESHOLDS.back.rushing
          ? 'dual_threat_back'
          : 'rushing_back';
    return {
      bucket,
      label: ROLE_LABEL[bucket],
      adot,
      airYardsShare: airShare,
      targetShareOfTouches: share,
      carriesPerGame: carries == null ? null : round1(carries / games.length),
      games: games.length,
      confidence: games.length >= 5 ? 'high' : 'medium',
      detail: `${Math.round(share * 100)}% of his touches are targets`,
    };
  }

  if (pos !== 'WR' && pos !== 'TE') return { ...UNCLASSIFIED, games: games.length };

  /*
   * Depth of target, and the sample it needs.
   *
   * Air yards are charged on the throw, so one deep incompletion moves a small
   * sample a long way. Twelve targets is a low bar and it is the right kind of
   * low: below it the honest answer is that the role is not classified, and
   * above it the statistic is stable enough to bucket even if it is not precise
   * enough to rank.
   */
  if (adot == null || (targets ?? 0) < ROLE_THRESHOLDS.minTargets) {
    return { ...UNCLASSIFIED, games: games.length, adot, airYardsShare: airShare };
  }

  const lines = pos === 'TE' ? ROLE_THRESHOLDS.tightEnd : ROLE_THRESHOLDS.receiver;
  const bucket: RoleBucket =
    adot >= lines.deep ? 'deep_receiver' : adot <= lines.underneath ? 'underneath_receiver' : 'intermediate_receiver';

  return {
    bucket,
    label: ROLE_LABEL[bucket],
    adot,
    airYardsShare: airShare,
    targetShareOfTouches: null,
    carriesPerGame: null,
    games: games.length,
    confidence: (targets ?? 0) >= 25 && games.length >= 5 ? 'high' : 'medium',
    detail: `${adot} yards average depth of target`,
  };
}

/**
 * The bucket a defence's tendency is looked up under, given a position.
 *
 * A defence is measured against the same vocabulary, so an unclassified player
 * falls back to the position itself and gets the generic answer — which is
 * weaker, and is the honest thing to give somebody the data cannot describe.
 */
export function tendencyKey(position: string, bucket: RoleBucket): string {
  return bucket === 'unclassified' ? `${position.toUpperCase()}:any` : `${position.toUpperCase()}:${bucket}`;
}

function sum(values: (number | null | undefined)[]): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  return usable.length === 0 ? null : usable.reduce((a, b) => a + b, 0);
}

function mean(values: (number | null | undefined)[]): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  return usable.length === 0 ? null : round3(usable.reduce((a, b) => a + b, 0) / usable.length);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
