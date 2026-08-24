/**
 * A league that starts a defence, and the defences in it.
 *
 * ## Why this is a fixture of its own
 *
 * Everything else in `fixtures/` describes one world: one league, one set of
 * managers, one player universe, differing only in *when* it is. That is what
 * lets a reader step from a draft to the morning after and recognise the same
 * team, and it is the reason this file does not simply add a `DEF` slot to
 * `DEMO_ROSTER_POSITIONS`. Doing that would change the starting shape of every
 * scenario in the app at once — a lineup that was eight slots is nine, every
 * demo roster is suddenly one starter short, and every screen that draws them
 * moves. The defence work would then be indistinguishable, in any failing test,
 * from a regression in the thing it was standing next to.
 *
 * So this is additive. A separate league shape, a separate scoring table and a
 * separate cast, all in the same idiom and all usable from a test or a seed in
 * one call. Nothing here is imported by the three existing scenarios and none
 * of their behaviour changes.
 *
 * ## What it is built to exercise
 *
 * The five paths the DST lane touches, each reachable from {@link dstWorld}:
 *
 *  - **DST scoring** — {@link DST_SCORING} is a real Sleeper defence table,
 *    written as a league publishes one, so `buildDstScoring` has something to
 *    read that is neither empty nor invented at the call site.
 *  - **Team** — my roster has a defence, it has a game with a line on it, and
 *    the league has a `DEF` slot for it to sit in. That is the whole of the
 *    phantom-DEF defect in one fixture.
 *  - **Smart Trades** — the shape the invariant is actually at risk in: I have
 *    *no* defence, my partner has a good one, and every other position on both
 *    rosters is adequate. A trade engine with no exclusion would find that and
 *    offer it, which is why the fixture is built this way round.
 *  - **Draft and Waivers** — a defence is left unrostered, so a board has one
 *    to rank and a wire has one to find.
 *  - **The market's absence** — one defence is deliberately unpriced, because
 *    "no line, no number" is a behaviour and not an error state.
 *
 * As everywhere else here: **a fixture states inputs, never outputs.** No score,
 * no projection, no recommendation and no sentence. Every conclusion drawn from
 * this file is computed by the same code production runs.
 *
 * Every name is invented. No team abbreviation here belongs to a real club's
 * defence in any sense that matters — they are the same synthetic league the
 * rest of `fixtures/` plays in.
 */

import type { DemoPlayerSpec } from './spec.ts';

/**
 * The ordinary shape, plus a defence.
 *
 * One `DEF` slot, which is the shape this app has an opinion about: drafted
 * last, streamed weekly, never traded. A two-defence league is a real edge case
 * and is deliberately *not* the default fixture — it is the exception the draft
 * alerts test states for itself, because building the common case around an
 * uncommon shape is how an exception becomes the thing that is actually tested.
 */
export const DST_ROSTER_POSITIONS = [
  'QB',
  'RB',
  'RB',
  'WR',
  'WR',
  'WR',
  'TE',
  'FLEX',
  'DEF',
  'BN',
  'BN',
  'BN',
  'BN',
  'BN',
  'IR',
];

/**
 * Half PPR, and a defence table a real league publishes.
 *
 * The defensive half is Sleeper's own default table written out in full,
 * including the bands the league scores nothing for — which is how Sleeper
 * actually stores a league's scoring, and is the case `buildDstScoring` has to
 * read correctly: a `pts_allow_35p` of −4 is a real rule, and a category left at
 * zero is a league saying it does not score that, not a gap.
 *
 * The offensive half is `DEMO_SCORING` unchanged, so a defence-capable league
 * scores a receiver exactly as the ordinary demo league does and nothing about
 * the skill positions is a second variable.
 */
export const DST_SCORING: Record<string, number> = {
  rec: 0.5,
  rec_yd: 0.1,
  rush_yd: 0.1,
  pass_yd: 0.04,
  pass_td: 4,
  rush_td: 6,
  rec_td: 6,
  pass_int: -1,
  fum_lost: -2,

  sack: 1,
  int: 2,
  fum_rec: 2,
  ff: 1,
  def_td: 6,
  def_st_td: 6,
  safe: 2,
  blk_kick: 2,
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
};

/**
 * A league whose defence rules this app cannot read.
 *
 * `def_forced_punts` is the shape of the real problem: a setting that is
 * unmistakably a defence's, carries a non-zero value, and has no place in the
 * model — so the honest answer is no number at all rather than a number missing
 * a category the league pays for. Used by the tests that assert the degrade;
 * the point of stating it here is that the *fixture* is a plausible league and
 * the *refusal* is the code's conclusion.
 */
export const DST_SCORING_CUSTOM: Record<string, number> = {
  ...DST_SCORING,
  def_forced_punts: 1,
  def_3_and_out: 1.5,
};

/**
 * The defences.
 *
 * Six, which is more than a twelve-team league needs and is the point: some are
 * rostered, one is on my rival's roster to be tempting, and the rest are on the
 * wire where a board and a waiver scan can find them. Each carries a week with
 * a spread and a total, because a defence's whole projection is those two
 * numbers — with one exception, stated below.
 *
 * The spreads are written from **the defence's own team's** point of view,
 * negative when favoured, matching `GameContext` and therefore matching what
 * `startSitInputs.ts` resolves out of the stored `spreadTeam`. A fixture that
 * wrote them the other way round would test the model against a slate it does
 * not describe, and would do it silently.
 *
 * `week.points` is null on every one of them, and deliberately: that field
 * drives the *player prop* expander, which has no shape for a defence and must
 * not invent one. A defence's number comes from the game line, which is the
 * whole claim of `dstProjection.ts`.
 */
export const DST_PLAYERS: DemoPlayerSpec[] = [
  /*
   * The best defence on the board: a big favourite against a weak offence, so
   * the opponent's implied total is low and the points-allowed bands pay.
   */
  {
    id: 'd01',
    name: 'Kansas City',
    position: 'DEF',
    team: 'KC',
    adp: 132.5,
    searchRank: 210,
    week: { points: null, opponent: 'CAR', spread: -9.5, total: 41.5, kickoffInHours: 54 },
  },
  /* Comfortably favoured in a middling game. The one my rival holds. */
  {
    id: 'd02',
    name: 'Baltimore',
    position: 'DEF',
    team: 'BAL',
    adp: 139.0,
    searchRank: 214,
    week: { points: null, opponent: 'CLE', spread: -6.5, total: 43, kickoffInHours: 54 },
  },
  /* An ordinary week: near pick'em in a game the market has at the mean. */
  {
    id: 'd03',
    name: 'Pittsburgh',
    position: 'DEF',
    team: 'PIT',
    adp: 145.2,
    searchRank: 219,
    week: { points: null, opponent: 'CIN', spread: -1, total: 45, kickoffInHours: 54 },
  },
  /* A road underdog in a shootout — the low end of the same curve. */
  {
    id: 'd04',
    name: 'Carolina',
    position: 'DEF',
    team: 'CAR',
    adp: 168.4,
    searchRank: 226,
    week: { points: null, opponent: 'KC', spread: 9.5, total: 41.5, kickoffInHours: 54 },
  },
  /* A heavy underdog in a high-total game: the worst start on the slate. */
  {
    id: 'd05',
    name: 'Cleveland',
    position: 'DEF',
    team: 'CLE',
    adp: 175.0,
    searchRank: 231,
    week: { points: null, opponent: 'BAL', spread: 6.5, total: 43, kickoffInHours: 54 },
  },
  /*
   * Nobody has priced this game, and that is what he is for.
   *
   * "No total, no spread, no projection" is a behaviour with a screen state
   * behind it, and a fixture in which every defence has a line would never
   * reach it. Left with no `week` at all rather than with a null spread,
   * because the absent case is the ordinary one: a bye, a game the book has not
   * put up yet, or a provider that answered without game lines.
   */
  { id: 'd06', name: 'Tennessee', position: 'DEF', team: 'TEN', adp: 181.6, searchRank: 238 },
];

/** The defence on my roster, for the Team path. */
export const MY_DEFENCE = 'd01';
/** The defence my trade partner holds, for the Smart Trades path. */
export const PARTNER_DEFENCE = 'd02';
/** Defences nobody owns, for the Draft and Waivers paths. */
export const AVAILABLE_DEFENCES = ['d03', 'd04', 'd05', 'd06'];

/**
 * The three roster shapes the Smart Trades invariant is at risk in.
 *
 * Written down rather than derived, because the arrangement *is* the test: the
 * invariant only has teeth in a league where a trade for a defence would
 * otherwise look like a good idea. So my roster is short exactly one thing — a
 * defence — and my partner has a spare one and needs nothing I can give them
 * except at the positions we are both fine at.
 *
 * Ids are the world's ordinary skill-position ids, so this composes with
 * `world.ts` rather than duplicating a player universe.
 */
export const DST_ROSTERS = {
  /** No defence, everything else covered. The roster the exclusion protects. */
  mine: ['p010', 'p001', 'p023', 'p003', 'p009', 'p008', 'p016', 'p025', 'p028', 'p031'],
  /** A defence, and adequate everywhere else. The tempting partner. */
  partner: ['p011', 'p006', 'p021', 'p002', 'p005', 'p022', 'p017', 'p024', 'p026', PARTNER_DEFENCE],
  /** A third roster, so the need benchmark has a league to be measured against. */
  other: ['p012', 'p007', 'p030', 'p027', 'p029', 'p033', 'p018', 'p032', 'p034', 'p035'],
} as const;

/**
 * Everything a caller needs to stand this league up, in one object.
 *
 * A function rather than a constant so a caller cannot mutate the shared cast
 * from under another test — the arrays are rebuilt on every call, which costs
 * nothing at this size and removes a whole class of order-dependent failure
 * from a suite that runs files in parallel.
 */
export function dstWorld(): {
  rosterPositions: string[];
  scoring: Record<string, number>;
  defences: DemoPlayerSpec[];
  rosters: { mine: string[]; partner: string[]; other: string[] };
} {
  return {
    rosterPositions: [...DST_ROSTER_POSITIONS],
    scoring: { ...DST_SCORING },
    defences: DST_PLAYERS.map((spec) => ({ ...spec, week: spec.week ? { ...spec.week } : undefined })),
    rosters: {
      mine: [...DST_ROSTERS.mine],
      partner: [...DST_ROSTERS.partner],
      other: [...DST_ROSTERS.other],
    },
  };
}
