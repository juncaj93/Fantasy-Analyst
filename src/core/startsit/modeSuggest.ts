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
 * **outside numbers per player and nothing else**: a market line, Rotowire's
 * published total, and points already on the board. There is no field on its
 * input that a Start/Sit score could be passed through, so the circular version
 * cannot be written by accident. Every one of those three is mode-free by
 * construction — two are other people's models and the third is a fact — and
 * none is computed after any weight in `mode.ts` is applied.
 *
 * ## Reading a week that has already started
 *
 * A mode chosen from pregame projections is answering last Thursday's question
 * on Sunday afternoon. If the opponent's back has already gone for 30, a
 * comfortable favourite is not comfortable any more and the lineup should stop
 * protecting a lead it no longer has.
 *
 * So a side is estimated as **what it has banked plus what is left of its
 * games** — see {@link expectedPoints}, which mixes the two in the proportion
 * of each player's game still to be played. The arithmetic collapses to the old
 * behaviour before kickoff and to the actual scoreline at the final whistle,
 * which is why there is no separate live path to keep in step with this one.
 *
 * ## What it refuses to do
 *
 * Half a roster with no projection is not an opinion about a matchup. Below
 * {@link MODE_SUGGESTION.minCoverage} of the starting slots carrying a number
 * on either side, the answer is `unknown`, the mode stays Balanced, and the
 * reason is stated — rather than an underdog reading manufactured out of a bye
 * week and a missing sportsbook.
 *
 * The published fallback is what lets it clear that bar at all. This app prices
 * the reader's roster and no other, by the owner's decision of 9 September 2026
 * (`docs/VEGAS.md`), so on market alone the opponent's coverage is one or two
 * slots in nine and this module answered `unknown` every week. Rotowire's week
 * is already in the database for every player in the NFL, so borrowing it costs
 * nothing and is reported rather than hidden — {@link SideProjection.slotsBorrowed}.
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
  /**
   * Rotowire's published total for him, used only where the market is silent.
   *
   * Not a second opinion and never preferred: {@link expectedPoints} reads it
   * only when `marketPoints` is null. It is here because of a measured
   * asymmetry — this app prices the reader's own roster and, by the owner's
   * decision of 9 September 2026, does not price anybody else's (see
   * `docs/VEGAS.md`). Without a fallback the opponent's side is one or two
   * priced slots out of nine, coverage sits under the threshold, and this
   * module answers `unknown` every week of the season. It was doing exactly
   * that.
   *
   * The published week is already in the database for every player in the
   * league — one feed, fetched daily by cron for the whole of the NFL — so
   * reading it for the opponent costs no request and no new spend. That is the
   * whole reason it is the fallback and Vegas is not.
   *
   * It is still weaker evidence, and {@link SideProjection.slotsBorrowed} says
   * how much of a side leaned on it so a screen can hedge accordingly.
   */
  publishedPoints?: number | null;
  /** Out, IR, PUP or suspended. He is not in anybody's estimated lineup. */
  ruledOut?: boolean;
  /**
   * What he has actually banked this week, if his game has started.
   *
   * A fact, not a projection, which is what makes it safe here: the circularity
   * guard in this module's header is about never reading a Start/Sit *score*,
   * and points already on the board are not anybody's model output. Null before
   * kickoff.
   */
  actualPoints?: number | null;
  /**
   * How much of his game is still to be played, 0..1.
   *
   * 1 before kickoff, 0 once he is final. The caller owns the clock — this
   * module has no idea what time it is and should not learn.
   */
  gameRemaining?: number;
}

export interface SideProjection {
  /** Total expected points across the slots that could be filled and priced. */
  total: number;
  slotsFilled: number;
  /**
   * Slots carrying a number at all — market or published.
   *
   * The coverage test is about whether a side can be *estimated*, and a slot
   * estimated from Rotowire is estimated. How much of it leaned on the weaker
   * source is {@link slotsBorrowed}, reported separately rather than folded in,
   * so a caller can say "this reading borrows half its opponent" instead of
   * discovering it from a total.
   */
  slotsPriced: number;
  /** Of {@link slotsPriced}, how many had no market and used the published week. */
  slotsBorrowed: number;
  slotsTotal: number;
  coverage: number;
  /** Points already banked by this side's starters. 0 before the first kickoff. */
  banked: number;
  /** True once any starter's game has begun, which is what makes this a live read. */
  live: boolean;
  starters: { playerId: string; slot: string; marketPoints: number | null; points: number | null }[];
}

export interface ModeSuggestion {
  mode: StartSitMode;
  /** False when nothing could be read and Balanced is a default, not a choice. */
  auto: boolean;
  state: FavouriteState;
  /** Mine minus theirs, in expected points. Null when it could not be computed. */
  margin: number | null;
  mine: SideProjection | null;
  opponent: SideProjection | null;
  /**
   * True once either side has a game under way, so the reading is of a week in
   * progress rather than a forecast of one.
   *
   * Worth its own field because it changes what the number *means*, not how
   * confident it is: a 20-point pregame margin is an expectation, and a
   * 20-point margin with six of eighteen starters finished is partly a fact.
   */
  live: boolean;
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
  live: false,
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
/**
 * What one player is expected to be worth by the end of the week.
 *
 * Three facts, in one number, and the order they are combined in is the whole
 * of the live behaviour:
 *
 *   what he has already banked  +  what is left of his game × his rate
 *
 * Before kickoff `gameRemaining` is 1 and `actualPoints` is null, so this is
 * his projection and nothing has changed. At the final whistle `gameRemaining`
 * is 0 and the projection is gone entirely, leaving what he actually did. In
 * between, the two are mixed in the proportion of the game that is left, which
 * is the honest reading: a receiver who has 4 points at half time is not on
 * course for his projected 14, and he is not stuck on 4 either.
 *
 * This is what makes the mode adapt to a week in progress, which is what the
 * control could never do — it is the same arithmetic whether the opponent's
 * back has gone for 30 by Sunday teatime or has been held to nothing.
 *
 * The estimate is market-first and published-only-as-fallback. Both are outside
 * models: neither is a Start/Sit score, so the circularity guard in the header
 * holds exactly as it did.
 */
export function expectedPoints(player: SidePlayer): { points: number | null; borrowed: boolean } {
  const projection = player.marketPoints ?? player.publishedPoints ?? null;
  const borrowed = player.marketPoints == null && player.publishedPoints != null;
  const banked = player.actualPoints ?? null;
  const remaining = clamp01(player.gameRemaining ?? 1);

  // No model for him at all. What he has scored is still a fact about the week,
  // and a player who is done is fully described by it.
  if (projection == null) return banked == null ? { points: null, borrowed: false } : { points: round2(banked), borrowed: false };

  /*
   * `actualPoints` absent means no live reading, not a player on zero.
   *
   * Sleeper reports 0 for a man who has played and not scored, so null is the
   * pregame state — and scaling a projection down against an unknown scoreline
   * would invent a bad afternoon for somebody who has not kicked off. He keeps
   * his whole projection until there is a number to put beside it.
   */
  if (banked == null) return { points: round2(projection), borrowed };

  return { points: round2(banked + projection * remaining), borrowed };
}

export function projectSide(players: SidePlayer[], shape: RosterShape): SideProjection {
  /*
   * Ordered by what each man is now expected to finish on, not by his pregame
   * line. Mid-week those are different orderings, and this function's job is to
   * estimate what a side puts on the board — so a back who has already scored
   * twice belongs in the flex ahead of one who is yet to play for less.
   */
  const pool = players
    .filter((p) => !p.ruledOut)
    .map((p) => ({ ...p, position: p.position.toUpperCase(), estimate: expectedPoints(p) }))
    .sort((a, b) => (b.estimate.points ?? -1) - (a.estimate.points ?? -1));
  const used = new Set<string>();
  const starters: {
    playerId: string;
    slot: string;
    marketPoints: number | null;
    points: number | null;
    borrowed: boolean;
    banked: number;
    started: boolean;
  }[] = [];

  const take = (slot: string, accepts: string[]) => {
    const pick = pool.find((p) => !used.has(p.playerId) && accepts.includes(p.position));
    if (!pick) return;
    used.add(pick.playerId);
    starters.push({
      playerId: pick.playerId,
      slot,
      marketPoints: pick.marketPoints,
      points: pick.estimate.points,
      borrowed: pick.estimate.borrowed,
      banked: pick.actualPoints ?? 0,
      started: (pick.gameRemaining ?? 1) < 1 || pick.actualPoints != null,
    });
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

  const priced = starters.filter((s) => s.points != null);
  return {
    total: round2(priced.reduce((a, s) => a + (s.points ?? 0), 0)),
    slotsFilled: starters.length,
    slotsPriced: priced.length,
    slotsBorrowed: starters.filter((s) => s.borrowed).length,
    slotsTotal,
    coverage: slotsTotal === 0 ? 0 : round3(priced.length / slotsTotal),
    banked: round2(starters.reduce((a, s) => a + s.banked, 0)),
    live: starters.some((s) => s.started),
    starters: starters.map((s) => ({
      playerId: s.playerId,
      slot: s.slot,
      marketPoints: s.marketPoints,
      points: s.points,
    })),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
  const live = mine.live || opponent.live;

  if (covered < MODE_SUGGESTION.minCoverage) {
    return {
      ...BALANCED_BY_DEFAULT,
      mine,
      opponent,
      live,
      detail: `Balanced — only ${Math.round(covered * 100)}% of the starting slots carry a projection, which is not enough to call the matchup.`,
      reasons: ['projection coverage below the threshold this suggestion needs'],
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

  const borrowed = mine.slotsBorrowed + opponent.slotsBorrowed;
  return {
    mode,
    auto: true,
    state,
    margin,
    mine,
    opponent,
    live,
    detail: DETAIL[state](Math.abs(margin), live),
    reasons: [
      `${live ? 'expected finals' : 'market expectation'} across the starting slots: ${mine.total.toFixed(1)} against ${opponent.total.toFixed(1)}`,
      ...(live ? [`${mine.banked.toFixed(1)} against ${opponent.banked.toFixed(1)} already on the board`] : []),
      ...(covered < 0.85 ? [`${Math.round(covered * 100)}% of slots carry a projection — the margin is approximate`] : []),
      /*
       * Said out loud, because it is the difference between a reading this app
       * priced and one it borrowed. The opponent is the side that leans on it,
       * by design — see `SidePlayer.publishedPoints`.
       */
      ...(borrowed > 0
        ? [`${borrowed} slot${borrowed === 1 ? '' : 's'} read from Rotowire's published week rather than a betting market`]
        : []),
    ],
  };
}

/**
 * The sentence, and why it changes tense once the week starts.
 *
 * Pregame it is a forecast and says so — "the market has you ahead". Live it is
 * partly a scoreline, so it reads "you are ahead": the reader can see the games
 * and a screen still talking about expectations at four o'clock on Sunday
 * sounds like it has not noticed.
 */
const DETAIL: Record<FavouriteState, (margin: number, live: boolean) => string> = {
  substantial_favourite: (m, live) =>
    live
      ? `Floor — you are about ${m.toFixed(0)} points ahead on expected finals, so the way to lose this is a starter who does not play.`
      : `Floor — the market has you about ${m.toFixed(0)} points ahead, so the way to lose this is a starter who does not play.`,
  substantial_underdog: (m, live) =>
    live
      ? `Ceiling — you are about ${m.toFixed(0)} points behind on expected finals, and a safe lineup loses that by less rather than winning it.`
      : `Ceiling — the market has you about ${m.toFixed(0)} points behind, and a safe lineup loses that by less rather than winning it.`,
  close: (m, live) =>
    live
      ? `Balanced — about ${m.toFixed(0)} points separate these lineups on expected finals, which is still a coin flip.`
      : `Balanced — the market separates these lineups by about ${m.toFixed(0)} points, which is a coin flip.`,
  unknown: () => 'Balanced — the matchup could not be read.',
};

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
