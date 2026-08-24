/**
 * Deterministic usage and role features, with their denominators kept.
 *
 * The handoff is explicit about the shape this must take: "Keep numerators +
 * denominators. Do not collapse everything into a mysterious 'usage score'
 * without preserving underlying components." So every rate here is a
 * {@link Rate} — a value, the numerator it came from, the denominator it was
 * divided by, and the number of games behind both — and nothing downstream is
 * allowed to see a bare number whose provenance has been thrown away.
 *
 * ## What is in here and what is deliberately not
 *
 * §6 of the handoff lists five feature blocks. Four are built:
 *
 *   - **snap role** — offensive snaps, snap share, snap-share stability;
 *   - **receiving role** — targets, team targets, target share, receptions,
 *     receiving yards, air yards, air-yard share;
 *   - **rushing role** — carries, team carries, carry share, rushing yards;
 *   - **QB volume** — pass attempts and carries.
 *
 * The fifth — **scoring opportunity**: red-zone and goal-line targets and
 * carries — is **not built, and cannot be on this data path**. Those splits
 * exist only in nflfastR play-by-play, whose 2025 season file is **93MiB**
 * (measured, `Content-Length: 97,951,481`). A Workers invocation gets 10ms of
 * CPU; the 8.3MiB weekly-stats file costs 4ms to read one week out of, and the
 * play-by-play file is eleven times that before a single play is parsed. There
 * is no ranged read that helps, because red-zone usage is a season-long
 * aggregate rather than a block at one end of the file. `core/xfp/model.ts`
 * already states this limitation in the app's own voice — "no red-zone or
 * goal-line data is published free on this id space, so a carry from the two
 * counts as a carry" — and this module inherits it rather than pretending
 * otherwise. It is the single largest gap in Projection v2 and it is named in
 * the closeout rather than hidden in a constant.
 *
 * The **QB scramble / designed-rush split** is unavailable for the same reason:
 * separating a scramble from a designed run needs the play's own `qb_scramble`
 * flag. What is available is the total, and it is carried as the total with the
 * split flagged missing rather than estimated — a designed-run share invented
 * from a season total would be exactly the opaque bonus §4 forbids.
 *
 * ## The window, and why it matches the rest of the app
 *
 * Eight regular-season games, recency-weighted with `RECENCY_WEIGHTS` from
 * `core/startsit/usageTrend.ts` — the newest two games at weight 4, the two
 * before them at 2, everything older at 1. Reused rather than re-chosen so that
 * the opportunity figure on a Team card and the opportunity figure inside a
 * Projection v2 estimate are the same reading of the same games. Two modules
 * describing one player with two different windows is how a screen ends up
 * disagreeing with itself.
 *
 * ## Blank is never zero
 *
 * Inherited from the ingest and enforced again here. A player with no row for a
 * week did not play; a null field is a field the source left blank. Neither is a
 * zero, and a mean that treats them as one manufactures the strongest possible
 * evidence of a collapsed role out of a bye week.
 */

import type { UsageWeek } from '../usage/role.ts';
import { RECENCY_WEIGHTS } from '../startsit/usageTrend.ts';

/** How many regular-season games the features look back over. */
export const FEATURE_WINDOW_GAMES = 8;

/** Games below which a share is reported but marked too thin to lean on. */
export const THIN_SAMPLE_GAMES = 4;

/**
 * A rate with its arithmetic still attached.
 *
 * `value` is `numerator / denominator` where both are known, or the source's own
 * published share where it publishes one and the denominator is not
 * reconstructable. `games` is how many games contributed, which is the number
 * that decides whether the rate is worth anything at all.
 */
export interface Rate {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  games: number;
}

const NO_RATE: Rate = { value: null, numerator: null, denominator: null, games: 0 };

/** A per-game figure, recency-weighted, with the games behind it. */
export interface PerGame {
  value: number | null;
  games: number;
  /** The plain arithmetic mean, so the effect of the weighting stays visible. */
  unweighted: number | null;
}

const NO_PER_GAME: PerGame = { value: null, games: 0, unweighted: null };

/** One week of snap counts for one player, as the store holds it. */
export interface SnapWeek {
  week: number;
  gameType: string;
  offenseSnaps: number | null;
  offenseShare: number | null;
}

/** A club's totals for one week, summed from the players stored at carried positions. */
export interface TeamWeekTotals {
  team: string;
  week: number;
  targets: number;
  carries: number;
  passAttempts: number;
  receivingAirYards: number;
  /** How many players contributed. A denominator built from three rows is not one. */
  players: number;
}

/**
 * Club totals per week, summed from stored player-weeks.
 *
 * **The denominator this produces is "carries by players at carried positions",
 * not "the club's carries".** The ingest stores QB, RB, WR and TE only, so a
 * carry by a lineman on a fumble recovery or a punter on a fake is not in it.
 * That is a rounding error against a club's ~27 carries a game and it is stated
 * rather than papered over, because a share whose denominator nobody has
 * described is a share nobody can check.
 *
 * Targets have no such gap — a target to a non-carried position is vanishingly
 * rare — and nflverse publishes `target_share` and `air_yards_share` directly,
 * so those are preferred over anything reconstructed here. What this exists for
 * is **carry share**, which the source does not publish at all.
 */
export function teamWeekTotals(weeks: (UsageWeek & { team?: string | null; week: number })[]): Map<string, TeamWeekTotals> {
  const out = new Map<string, TeamWeekTotals>();
  for (const week of weeks) {
    if (week.seasonType.toUpperCase() !== 'REG') continue;
    const team = (week.team ?? '').toUpperCase();
    if (!team) continue;
    const key = `${team}|${week.week}`;
    let totals = out.get(key);
    if (!totals) {
      totals = { team, week: week.week, targets: 0, carries: 0, passAttempts: 0, receivingAirYards: 0, players: 0 };
      out.set(key, totals);
    }
    totals.players++;
    totals.targets += week.targets ?? 0;
    totals.carries += week.carries ?? 0;
    totals.passAttempts += week.passAttempts ?? 0;
    totals.receivingAirYards += week.receivingAirYards ?? 0;
  }
  return out;
}

/** Everything the projection layer reads about one player's usage. */
export interface UsageFeatures {
  position: string;
  /** Regular-season games inside the window with a stored row. */
  games: number;
  /** The weeks those games were, newest first — so freshness is checkable. */
  weeks: number[];
  /** True below {@link THIN_SAMPLE_GAMES}; every consumer must widen for it. */
  thinSample: boolean;

  snapsPerGame: PerGame;
  snapShare: Rate;
  /** Population standard deviation of snap share over the window. */
  snapShareStability: number | null;

  targetsPerGame: PerGame;
  targetShare: Rate;
  receptionsPerGame: PerGame;
  receivingYardsPerGame: PerGame;
  airYardsPerGame: PerGame;
  airYardShare: Rate;
  targetShareStability: number | null;
  /** Air yards per target — depth of target, which the xFP rates key off. */
  averageDepthOfTarget: number | null;

  carriesPerGame: PerGame;
  carryShare: Rate;
  rushingYardsPerGame: PerGame;
  carryShareStability: number | null;

  passAttemptsPerGame: PerGame;
  passingYardsPerGame: PerGame;
  /**
   * QB carries. The scramble/designed split is not derivable here; see the note
   * at the top of the file. Null `designedRushShare` means unknown, never zero.
   */
  qbCarriesPerGame: PerGame;
  designedRushShare: null;

  /** Touchdowns per game over the window, for the TD-dependence read. */
  touchdownsPerGame: PerGame;
}

export const NO_FEATURES: UsageFeatures = {
  position: '',
  games: 0,
  weeks: [],
  thinSample: true,
  snapsPerGame: NO_PER_GAME,
  snapShare: NO_RATE,
  snapShareStability: null,
  targetsPerGame: NO_PER_GAME,
  targetShare: NO_RATE,
  receptionsPerGame: NO_PER_GAME,
  receivingYardsPerGame: NO_PER_GAME,
  airYardsPerGame: NO_PER_GAME,
  airYardShare: NO_RATE,
  targetShareStability: null,
  averageDepthOfTarget: null,
  carriesPerGame: NO_PER_GAME,
  carryShare: NO_RATE,
  rushingYardsPerGame: NO_PER_GAME,
  carryShareStability: null,
  passAttemptsPerGame: NO_PER_GAME,
  passingYardsPerGame: NO_PER_GAME,
  qbCarriesPerGame: NO_PER_GAME,
  designedRushShare: null,
  touchdownsPerGame: NO_PER_GAME,
};

/**
 * Build one player's features.
 *
 * `snaps` and `teamTotals` are both optional and their absence costs exactly the
 * features that need them: no snap file means `snapShare` is null and the
 * uncertainty model widens for it, and no club totals mean `carryShare` is null
 * while `targetShare` — which the source publishes directly — is unaffected.
 * Nothing here fails a player for a missing input.
 */
export function buildFeatures(
  position: string,
  /*
   * `team` is optional on the row because `UsageWeek` — the shape the role
   * detector reads — does not carry it, while the stored row does. Where the
   * caller passes rows that have it, a club that changed mid-window is handled
   * per game; where it does not, `opts.team` names one club for the window.
   */
  weeks: (UsageWeek & { team?: string | null })[],
  opts: {
    snaps?: SnapWeek[];
    teamTotals?: Map<string, TeamWeekTotals>;
    team?: string | null;
    window?: number;
  } = {},
): UsageFeatures {
  const pos = position.toUpperCase();
  const window = opts.window ?? FEATURE_WINDOW_GAMES;
  const games = weeks
    .filter((w) => w.seasonType.toUpperCase() === 'REG')
    .sort((a, b) => a.week - b.week)
    .slice(-window);
  if (games.length === 0) return { ...NO_FEATURES, position: pos };

  // Newest first, which is the order `RECENCY_WEIGHTS` is written in.
  const newestFirst = [...games].reverse();
  const weekNumbers = newestFirst.map((g) => g.week);

  const snapByWeek = new Map<number, SnapWeek>();
  for (const snap of opts.snaps ?? []) {
    if (snap.gameType.toUpperCase() !== 'REG') continue;
    snapByWeek.set(snap.week, snap);
  }
  const snapSeries = newestFirst.map((g) => snapByWeek.get(g.week) ?? null);

  const team = (opts.team ?? games[games.length - 1]?.team ?? '').toString().toUpperCase();
  const teamTotals = opts.teamTotals;
  const teamAt = (week: number): TeamWeekTotals | null =>
    teamTotals && team ? (teamTotals.get(`${team}|${week}`) ?? null) : null;

  return {
    position: pos,
    games: games.length,
    weeks: weekNumbers,
    thinSample: games.length < THIN_SAMPLE_GAMES,

    snapsPerGame: perGame(snapSeries.map((s) => s?.offenseSnaps ?? null)),
    snapShare: rateOf(
      snapSeries.map((s) => s?.offenseShare ?? null),
      snapSeries.map((s) => s?.offenseSnaps ?? null),
      /*
       * The club's snap total is `snaps / share`, which is the one place a
       * denominator is reconstructed by division rather than summed. It is done
       * per game and then summed, never the other way round: summing shares and
       * dividing would weight a 20-snap game the same as an 70-snap one.
       */
      snapSeries.map((s) =>
        s?.offenseSnaps != null && s.offenseShare != null && s.offenseShare > 0
          ? s.offenseSnaps / s.offenseShare
          : null,
      ),
    ),
    snapShareStability: stability(snapSeries.map((s) => s?.offenseShare ?? null)),

    targetsPerGame: perGame(newestFirst.map((g) => g.targets)),
    targetShare: rateOf(
      newestFirst.map((g) => g.targetShare),
      newestFirst.map((g) => g.targets),
      newestFirst.map((g) => teamAt(g.week)?.targets ?? null),
    ),
    receptionsPerGame: perGame(newestFirst.map((g) => g.receptions)),
    receivingYardsPerGame: perGame(newestFirst.map((g) => g.recYards ?? null)),
    airYardsPerGame: perGame(newestFirst.map((g) => g.receivingAirYards ?? null)),
    airYardShare: rateOf(
      newestFirst.map((g) => g.airYardsShare ?? null),
      newestFirst.map((g) => g.receivingAirYards ?? null),
      newestFirst.map((g) => teamAt(g.week)?.receivingAirYards ?? null),
    ),
    targetShareStability: stability(newestFirst.map((g) => g.targetShare)),
    averageDepthOfTarget: ratio(
      sumOf(newestFirst.map((g) => g.receivingAirYards ?? null)),
      sumOf(newestFirst.map((g) => g.targets)),
    ),

    carriesPerGame: perGame(newestFirst.map((g) => g.carries)),
    carryShare: rateOf(
      // The source publishes no carry share, so there is nothing to prefer over
      // the reconstruction and the first argument is empty by design.
      newestFirst.map(() => null),
      newestFirst.map((g) => g.carries),
      newestFirst.map((g) => teamAt(g.week)?.carries ?? null),
    ),
    rushingYardsPerGame: perGame(newestFirst.map((g) => g.rushYards ?? null)),
    carryShareStability: stability(
      newestFirst.map((g) => {
        const total = teamAt(g.week)?.carries ?? null;
        return g.carries != null && total != null && total > 0 ? g.carries / total : null;
      }),
    ),

    passAttemptsPerGame: perGame(newestFirst.map((g) => g.passAttempts)),
    passingYardsPerGame: perGame(newestFirst.map((g) => g.passYards ?? null)),
    qbCarriesPerGame: pos === 'QB' ? perGame(newestFirst.map((g) => g.carries)) : NO_PER_GAME,
    designedRushShare: null,

    touchdownsPerGame: perGame(
      newestFirst.map((g) => {
        const parts = [g.passTds, g.rushTds, g.recTds].filter((t): t is number => t != null);
        return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
      }),
    ),
  };
}

/**
 * Recency-weighted mean over the games that actually carry the value.
 *
 * A null drops that game from *this* figure and no other, so a player whose
 * air-yard rows are blank still has a target count. The weights are indexed by
 * position in the original newest-first order rather than by position among the
 * surviving values: dropping game two must not promote game three to the
 * newest game's weight.
 */
function perGame(newestFirst: (number | null)[]): PerGame {
  let total = 0;
  let weight = 0;
  let plain = 0;
  let count = 0;
  for (let i = 0; i < newestFirst.length; i++) {
    const value = newestFirst[i];
    if (value == null || !Number.isFinite(value)) continue;
    const w = RECENCY_WEIGHTS[i] ?? 1;
    total += value * w;
    weight += w;
    plain += value;
    count++;
  }
  if (count === 0) return NO_PER_GAME;
  return { value: round3(total / weight), games: count, unweighted: round3(plain / count) };
}

/**
 * A share, preferring the source's own published figure over a reconstruction.
 *
 * `published` wins where it exists because nflverse computes it against the
 * club's true totals rather than against the subset of positions this app
 * stores. Where it does not, the share is `sum(numerator) / sum(denominator)`
 * across the window — summed then divided, so a game with two targets does not
 * count as much as a game with twelve.
 */
function rateOf(
  published: (number | null)[],
  numerators: (number | null)[],
  denominators: (number | null)[],
): Rate {
  const numerator = sumOf(numerators);
  const denominator = sumOf(denominators);
  const reconstructed = ratio(numerator, denominator);

  const publishedMean = perGame(published);
  const games = Math.max(publishedMean.games, numerators.filter((n) => n != null).length);
  if (publishedMean.value != null) {
    return { value: publishedMean.value, numerator, denominator, games };
  }
  if (reconstructed == null) return NO_RATE;
  return { value: reconstructed, numerator, denominator, games };
}

/**
 * How steady a share has been, as a population standard deviation.
 *
 * Lower is steadier. Null below two games, because one game has no spread and
 * reporting 0 for it would say "perfectly stable" about the least evidence
 * there is — which is the exact inversion the uncertainty model must never make.
 */
function stability(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length < 2) return null;
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const variance = present.reduce((a, b) => a + (b - mean) ** 2, 0) / present.length;
  return round3(Math.sqrt(variance));
}

function sumOf(values: (number | null)[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? round3(total) : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return round3(numerator / denominator);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
