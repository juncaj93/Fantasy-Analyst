/**
 * Start/sit fixtures: a player whose Vegas expectation lands on a chosen number.
 *
 * The engine is deliberately not mocked. A fixture builds real props at a line
 * that converts to the points it wants, so every test here runs through the
 * same expectation arithmetic the app runs through — which is the only way a
 * test about the lineup can also be a test about the engine underneath it.
 */

import { emptySignal } from '../../src/core/evidence/aggregate.ts';
import type { PlayerSignal } from '../../src/core/evidence/types.ts';
import type { StartSitInput } from '../../src/core/startsit/engine.ts';
import type { PlayerProp } from '../../src/core/vegas/types.ts';
import { EXPECTED_MARKETS } from '../../src/core/startsit/expectation.ts';
import { player } from './players.ts';

export function candidate(
  id: string,
  name: string,
  position: string,
  /** Null means no market at all — a bye week, or a game nobody prices. */
  points: number | null,
  extra: {
    status?: string | null;
    signal?: PlayerSignal | null;
    team?: string;
    kickoff?: string | null;
    now?: string | Date;
    /** Post his position's whole board. See {@link pricedCandidate}. */
    fullBoard?: boolean;
  } = {},
): StartSitInput {
  const props: PlayerProp[] = [];
  if (points != null) {
    // Receiving yards convert at 0.1 pts/yd; passing yards at 0.04.
    const market = position === 'QB' ? 'pass_yards' : 'receiving_yards';
    const line = position === 'QB' ? points / 0.04 : points * 10;
    props.push({
      playerId: id,
      sourcePlayerName: name,
      market,
      line,
      overPrice: -110,
      underPrice: -110,
      bookCount: 3,
      consensusMethod: 'median',
      books: ['a', 'b', 'c'],
      impliedProbability: null,
    });
    /*
     * The rest of his position's board, posted and worth nothing.
     *
     * A real priced player carries every market his position is priced on,
     * and a player carrying one of them is the partial market that
     * `marketIsComplete` refuses to print as a week. Zero lines keep the total
     * exactly `points`, so every figure a test asserts is unchanged.
     */
    for (const other of extra.fullBoard ? (EXPECTED_MARKETS[position] ?? []) : []) {
      if (other === market) continue;
      props.push({
        playerId: id,
        sourcePlayerName: name,
        market: other,
        line: other === 'anytime_td' ? null : 0,
        overPrice: -110,
        underPrice: -110,
        bookCount: 3,
        consensusMethod: 'median',
        books: ['a', 'b', 'c'],
        impliedProbability: other === 'anytime_td' ? 0 : null,
      });
    }
  }
  return {
    player: player({ id, fullName: name, position, team: extra.team ?? 'NE' }),
    props,
    signal: extra.signal ?? null,
    injuryStatus: extra.status ?? null,
    propsStale: false,
    ...(extra.kickoff === undefined ? {} : { kickoff: extra.kickoff }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
  };
}

/**
 * {@link candidate}, with every market his position is priced on posted.
 *
 * The shape a real priced player has on a Sunday. `candidate` posts a single
 * line, which since `marketIsComplete` is a *partial* market: real, and not a
 * projection. Tests about what the screens print for a priced player use this;
 * tests about ranking arithmetic keep `candidate`, whose scores they were
 * written against. The extra lines are worth nothing, so the total is still
 * exactly `points`.
 */
export function pricedCandidate(...args: Parameters<typeof candidate>): StartSitInput {
  const [id, name, position, points, extra = {}] = args;
  return candidate(id, name, position, points, { ...extra, fullBoard: true });
}

/** A tally with a chosen net, for the recent-news component. */
export function signalWithNet(net: number, items = 3): PlayerSignal {
  const s = emptySignal('x');
  s.raw = { positive: Math.max(0, net), negative: Math.max(0, -net), net, items };
  s.last30 = { ...s.raw };
  return s;
}

/**
 * A defence, which is a game line rather than a set of props.
 *
 * The counterpart to {@link candidate}, and deliberately a different shape:
 * there is no such thing as a receiving line for Seattle, so a fixture that
 * built one would be testing the defence model against inputs it never sees.
 * What a defence has is a total and a spread, and the spread is written from
 * **this defence's own team's** point of view — negative when favoured, the
 * convention `GameContext` states and `startSitInputs.ts` resolves against the
 * stored `spreadTeam`.
 *
 * Passing `game: null` is the missing-market case, which is a behaviour and not
 * an error: no line, no anchor, no number.
 */
export function defence(
  id: string,
  name: string,
  /**
   * The game, as much of it as is known.
   *
   * `null` is "this app has no fixture for him at all". A present object with
   * null lines is a different and much more common state — the fixture is
   * known and no book has quoted it — and the two produce different sentences
   * downstream, so the helper has to be able to express both.
   */
  game: { spread: number | null; total: number | null; opponent?: string } | null,
  extra: {
    status?: string | null;
    team?: string;
    kickoff?: string | null;
    now?: string | Date;
    lineAsOf?: string | null;
    opponentQuarterback?: { starterOut: boolean; observedAt: string | null } | null;
    /** True at home, false away, absent when the fixture list is unread. */
    home?: boolean | null;
  } = {},
): StartSitInput {
  return {
    player: player({ id, fullName: name, position: 'DEF', team: extra.team ?? 'SEA' }),
    props: [],
    signal: null,
    injuryStatus: extra.status ?? null,
    propsStale: false,
    game: game == null ? null : { spread: game.spread, total: game.total, opponent: game.opponent ?? null },
    ...(game?.opponent === undefined ? {} : { opponent: game.opponent }),
    ...(extra.kickoff === undefined ? {} : { kickoff: extra.kickoff }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
    ...(extra.lineAsOf === undefined ? {} : { lineAsOf: extra.lineAsOf }),
    ...(extra.opponentQuarterback === undefined ? {} : { opponentQuarterback: extra.opponentQuarterback }),
    ...(extra.home === undefined ? {} : { home: extra.home }),
  };
}
