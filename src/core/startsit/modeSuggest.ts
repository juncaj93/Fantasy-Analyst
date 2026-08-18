/**
 * Which question the week is actually asking: Floor, Balanced or Ceiling.
 *
 * The mode control has always been there and has always started on Balanced,
 * which is the right default and the wrong answer roughly two weeks in three. A
 * substantial favourite does not need upside — he needs the variance turned
 * down, because the only way he loses is a starter going for four. A
 * substantial underdog does not need a safe floor; a safe floor is how an
 * underdog loses by eleven instead of by twenty.
 *
 * So the week is read once, at the top, and the control is preselected. The
 * user can move it, and the suggestion says why it landed where it did.
 *
 * ## The circularity this must not have
 *
 * The obvious implementation is to total the recommended lineup and compare it
 * with the opponent's. That is a loop: the recommended lineup depends on the
 * mode, the mode would depend on the lineup total, and the answer would depend
 * on which one ran first. Two weeks of that and the control would be choosing
 * itself.
 *
 * The guard is structural rather than a comment. {@link suggestMode} accepts
 * **market points per player and nothing else** — there is no field on its input
 * that a Start/Sit score could be passed through, so the circular version
 * cannot be written by accident. Market expectation is mode-free by
 * construction: it is the sportsbook's number converted with the league's
 * scoring, computed before any weight in `mode.ts` is applied.
 *
 * ## What it refuses to do
 *
 * Half a roster with no market is not an opinion about a matchup. Below
 * {@link MODE_SUGGESTION.minCoverage} of the starting slots priced on either
 * side, the answer is `unknown`, the mode stays Balanced, and the reason is
 * stated — rather than an underdog reading manufactured out of a bye week and a
 * missing sportsbook.
 */

import type { RosterShape } from '../sleeper/scoring.ts';
import type { StartSitMode } from './mode.ts';

export const MODE_SUGGESTION = {
  /** Points of projected margin at which a matchup is materially decided. */
  substantialMargin: 10,
  /** Share of starting slots that must carry a market before this will speak. */
  minCoverage: 0.6,
} as const;

export type FavouriteState = 'substantial_favourite' | 'close' | 'substantial_underdog' | 'unknown';

/**
 * One player, as this module is allowed to see him.
 *
 * `marketPoints` is the Vegas expectation — `VegasExpectation.points` — and the
 * absence of any other numeric field is the circularity guard described above.
 */
export interface SidePlayer {
  playerId: string;
  position: string;
  marketPoints: number | null;
  /** Out, IR, PUP or suspended. He is not in anybody's estimated lineup. */
  ruledOut?: boolean;
}

export interface SideProjection {
  /** Total market points across the slots that could be filled and priced. */
  total: number;
  slotsFilled: number;
  slotsPriced: number;
  slotsTotal: number;
  coverage: number;
  starters: { playerId: string; slot: string; marketPoints: number | null }[];
}

export interface ModeSuggestion {
  mode: StartSitMode;
  /** False when nothing could be read and Balanced is a default, not a choice. */
  auto: boolean;
  state: FavouriteState;
  /** Mine minus theirs, in market points. Null when it could not be computed. */
  margin: number | null;
  mine: SideProjection | null;
  opponent: SideProjection | null;
  detail: string;
  reasons: string[];
}

export const BALANCED_BY_DEFAULT: ModeSuggestion = {
  mode: 'balanced',
  auto: false,
  state: 'unknown',
  margin: null,
  mine: null,
  opponent: null,
  detail: 'Balanced — there is not enough priced to tell whether this is a good matchup.',
  reasons: [],
};

/**
 * Fill a roster's starting slots greedily, by market points.
 *
 * Deliberately **not** the lineup optimiser. The optimiser answers "who should
 * I start", which is a decision that has to respect availability, lock times,
 * usage and a dozen other things; this answers "roughly how many points is each
 * side going to put on the board", which is a magnitude. Using the optimiser
 * here would also drag the mode back into the circle the header describes,
 * because the optimiser takes a mode.
 *
 * Fixed slots are filled before flex slots, and flex takes the best of whoever
 * is left, which is what a manager does and is close enough for a magnitude.
 */
export function projectSide(players: SidePlayer[], shape: RosterShape): SideProjection {
  const pool = players
    .filter((p) => !p.ruledOut)
    .map((p) => ({ ...p, position: p.position.toUpperCase() }))
    .sort((a, b) => (b.marketPoints ?? -1) - (a.marketPoints ?? -1));
  const used = new Set<string>();
  const starters: { playerId: string; slot: string; marketPoints: number | null }[] = [];

  const take = (slot: string, accepts: string[]) => {
    const pick = pool.find((p) => !used.has(p.playerId) && accepts.includes(p.position));
    if (!pick) return;
    used.add(pick.playerId);
    starters.push({ playerId: pick.playerId, slot, marketPoints: pick.marketPoints });
  };

  let slotsTotal = 0;
  for (const [position, count] of Object.entries(shape.starters)) {
    for (let i = 0; i < count; i += 1) {
      slotsTotal += 1;
      take(position, [position.toUpperCase()]);
    }
  }
  for (const flex of shape.flex) {
    slotsTotal += 1;
    take(flex.slot, flex.positions.map((p) => p.toUpperCase()));
  }

  const priced = starters.filter((s) => s.marketPoints != null);
  return {
    total: round2(priced.reduce((a, s) => a + (s.marketPoints ?? 0), 0)),
    slotsFilled: starters.length,
    slotsPriced: priced.length,
    slotsTotal,
    coverage: slotsTotal === 0 ? 0 : round3(priced.length / slotsTotal),
    starters,
  };
}

/**
 * Read the week, and preselect the control.
 *
 * The mapping is the brief's: substantial favourite to Floor, substantial
 * underdog to Ceiling, everything between to Balanced. What the code adds is
 * the refusal — an unknown opponent, a thin market or a league whose roster
 * shape could not be read all end at Balanced with `auto: false`, so a screen
 * can tell "we chose this" from "we defaulted to this".
 */
export function suggestMode(opts: {
  mine: SidePlayer[];
  /** The opponent's roster. Empty when the matchup is not known yet. */
  opponent: SidePlayer[];
  shape: RosterShape;
}): ModeSuggestion {
  if (opts.shape.totalStarters === 0 || opts.opponent.length === 0) {
    return {
      ...BALANCED_BY_DEFAULT,
      detail:
        opts.opponent.length === 0
          ? 'Balanced — no opponent lineup is known for this week yet.'
          : 'Balanced — this league has no starting slots the app understands.',
    };
  }

  const mine = projectSide(opts.mine, opts.shape);
  const opponent = projectSide(opts.opponent, opts.shape);
  const covered = Math.min(mine.coverage, opponent.coverage);

  if (covered < MODE_SUGGESTION.minCoverage) {
    return {
      ...BALANCED_BY_DEFAULT,
      mine,
      opponent,
      detail: `Balanced — only ${Math.round(covered * 100)}% of the starting slots carry a market, which is not enough to call the matchup.`,
      reasons: ['market coverage below the threshold this suggestion needs'],
    };
  }

  /*
   * Compared per priced slot, not as two totals.
   *
   * A roster with eight priced slots against one with six would otherwise read
   * as a blowout because it has more players in the sum. Scaling both to the
   * same number of slots is what makes the margin mean "per lineup" rather than
   * "per row of data that happened to exist".
   */
  const perSlot = (side: SideProjection) => (side.slotsPriced === 0 ? 0 : side.total / side.slotsPriced);
  const margin = round2((perSlot(mine) - perSlot(opponent)) * Math.max(mine.slotsTotal, opponent.slotsTotal));

  const state: FavouriteState =
    margin >= MODE_SUGGESTION.substantialMargin
      ? 'substantial_favourite'
      : margin <= -MODE_SUGGESTION.substantialMargin
        ? 'substantial_underdog'
        : 'close';

  const mode: StartSitMode =
    state === 'substantial_favourite' ? 'floor' : state === 'substantial_underdog' ? 'ceiling' : 'balanced';

  return {
    mode,
    auto: true,
    state,
    margin,
    mine,
    opponent,
    detail: DETAIL[state](Math.abs(margin)),
    reasons: [
      `market expectation across the starting slots: ${mine.total.toFixed(1)} against ${opponent.total.toFixed(1)}`,
      ...(covered < 0.85 ? [`${Math.round(covered * 100)}% of slots priced — the margin is approximate`] : []),
    ],
  };
}

const DETAIL: Record<FavouriteState, (margin: number) => string> = {
  substantial_favourite: (m) =>
    `Floor — the market has you about ${m.toFixed(0)} points ahead, so the way to lose this is a starter who does not play.`,
  substantial_underdog: (m) =>
    `Ceiling — the market has you about ${m.toFixed(0)} points behind, and a safe lineup loses that by less rather than winning it.`,
  close: (m) => `Balanced — the market separates these lineups by about ${m.toFixed(0)} points, which is a coin flip.`,
  unknown: () => 'Balanced — the matchup could not be read.',
};

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
