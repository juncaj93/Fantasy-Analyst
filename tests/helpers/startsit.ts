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
  game: { spread: number; total: number; opponent?: string } | null,
  extra: {
    status?: string | null;
    team?: string;
    kickoff?: string | null;
    now?: string | Date;
    lineAsOf?: string | null;
    opponentQuarterback?: { starterOut: boolean; observedAt: string | null } | null;
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
  };
}
