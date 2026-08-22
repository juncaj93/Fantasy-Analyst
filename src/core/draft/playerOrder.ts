/**
 * Ordering for the Players list: Sleeper's draft rank, nudged by the tally.
 *
 * Sleeper says roughly where a player goes. The tally says what the newsletters
 * have been saying about them since. Neither alone is the answer — so the rank
 * moves by half a pick per point of tally, which is enough to lift a riser past
 * a neighbour without letting a run of good press leapfrog a genuinely better
 * player.
 *
 *     adjusted = draftRank - (TALLY_WEIGHT x net)
 *
 * A positive tally moves a player *up* (a smaller number is earlier).
 *
 * Unranked stays unranked: a player Sleeper does not rank has no position to
 * adjust, so they sort after everyone who does rather than being treated as
 * pick zero.
 *
 * ## The floor is a display floor, and only a display floor
 *
 * The formula above is unbounded below: an early pick with a big tally lands at
 * a negative number, and `Draft rank -3` is not a thing to print at anybody. So
 * the *printed* rank stops at `RANK_FLOOR`.
 *
 * That floor used to be applied to the value everything else read as well, and
 * it cost the list its opinion at exactly the top, where the list is read. Three
 * players whose true adjusted ranks were -3.2, -2.4 and -0.4 all became 0.5 —
 * one value, no order — and the alphabet then decided which of them led the
 * page. Jahmyr Gibbs was better priced (1.8 v 2.1) and better supported (+10 v
 * +5) than Bijan Robinson and still sat under him, because `Bijan` sorts before
 * `Jahmyr`.
 *
 * So the floor is now applied once, at the end, to the number that is shown.
 * Ordering and movement read `rawAdjustedRank`, which is the formula and nothing
 * else. A saturating value can be a label; it must never be a sort key.
 */

/** Picks of movement per point of tally. */
export const TALLY_WEIGHT = 0.5;

/**
 * The earliest rank that can be *printed*.
 *
 * Half a pick, so a rounded label reads `1` rather than `0`. Nothing orders by
 * this and nothing measures movement against it — see the note above.
 */
export const RANK_FLOOR = 0.5;

export interface RankablePlayer {
  id: string;
  draftRank?: number | null;
  /** Net tally: positive is good news, negative is bad. */
  net: number;
  /** Tie-break for players with identical adjusted ranks. */
  name: string;
}

export interface RankedPlayer<T extends RankablePlayer> {
  player: T;
  draftRank: number | null;
  /** Null when the player is unranked — never a fabricated position. */
  adjustedRank: number | null;
  /** How many picks the tally moved them. Positive means earlier. */
  movement: number;
}

/**
 * The formula, undamped: `draftRank - TALLY_WEIGHT x net`.
 *
 * This is the real quantity — the one that orders the list and the one movement
 * is measured from. It goes below the floor, and below zero, and that is correct:
 * "how far ahead of the first pick does this evidence put him" is a question with
 * a meaningful answer, and two players who are both ahead of it are not tied.
 */
export function rawAdjustedRank(draftRank: number | null | undefined, net: number): number | null {
  if (draftRank == null || !Number.isFinite(draftRank)) return null;
  return draftRank - TALLY_WEIGHT * net;
}

/**
 * The rank as it is printed.
 *
 * `rawAdjustedRank` with the display floor applied, and nothing else. A huge
 * tally should not invent a rank of -3 on the row; it should — and does — still
 * decide who that row sits above.
 */
export function adjustedRank(draftRank: number | null | undefined, net: number): number | null {
  return withFloor(rawAdjustedRank(draftRank, net));
}

/** The display floor, in one place, so the two callers cannot drift apart. */
function withFloor(raw: number | null): number | null {
  return raw == null ? null : Math.max(RANK_FLOOR, raw);
}

/**
 * Order players best-first.
 *
 * Ranked players come first by adjusted rank; unranked players follow, ordered
 * by tally so the list still says something useful about them.
 */
export function orderPlayers<T extends RankablePlayer>(players: T[]): RankedPlayer<T>[] {
  const ranked = players.map((player) => {
    const base = player.draftRank ?? null;
    const raw = rawAdjustedRank(base, player.net);
    return {
      player,
      draftRank: base,
      adjustedRank: withFloor(raw),
      /*
       * Measured from the formula, not from the printed rank.
       *
       * `base - raw` is `TALLY_WEIGHT x net` — the half-a-pick-per-point rule,
       * which is what this field claims to be and what `tallyInfluence.ts`
       * documents it as. Measuring it from the floored rank instead used to
       * make the nudge shrink as it got large, so a +10 tally reported less
       * movement than a +5 one.
       */
      movement: base == null || raw == null ? 0 : round1(base - raw),
      /** The sort key. Not serialised; see the sort below. */
      key: raw == null ? null : round6(raw),
    };
  });

  ranked.sort((a, b) => {
    if (a.key == null && b.key == null) {
      return b.player.net - a.player.net || a.player.name.localeCompare(b.player.name);
    }
    if (a.key == null) return 1;
    if (b.key == null) return -1;
    return a.key - b.key || a.player.name.localeCompare(b.player.name);
  });

  return ranked.map(({ key: _key, ...row }) => row);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Enough precision to keep every real difference, and not enough to keep the
 * fake ones.
 *
 * `7.6 - 0.5 x 11` is `2.0999999999999996` in binary floating point, which sorts
 * *ahead* of a player genuinely priced at `2.1` by four parts in a quadrillion.
 * Both inputs carry one decimal at most, so six is far more than the formula can
 * legitimately produce, and rounding to it makes players who tie on paper tie in
 * fact — and reach the name tie-break this function promises.
 */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
