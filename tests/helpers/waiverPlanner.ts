/**
 * One league, one roster, one wire — used by every waiver-planner test.
 *
 * Shared rather than rebuilt per file because the planner's whole claim is that
 * its answers change with the *roster*, and a suite where each test built its
 * own would be a suite that could not tell a model change from a fixture
 * change. Every test below varies exactly one thing against this baseline.
 *
 * Nothing is mocked. The players are real {@link candidate} fixtures whose
 * Vegas lines convert to the points named, so a test about a drop ranking is
 * also a test of the scoring engine underneath it — which is the only way the
 * numbers here mean anything.
 */

import { buildScoringProfile } from '../../src/core/sleeper/scoring.ts';
import type { RosterShape } from '../../src/core/sleeper/scoring.ts';
import type { StartSitInput } from '../../src/core/startsit/engine.ts';
import type { WaiverPlannerTarget } from '../../src/core/waivers/planner/index.ts';
import { candidate } from './startsit.ts';

export const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

/** QB, RB, RB, WR, WR, TE, FLEX — the shape most redraft leagues actually use. */
export const SHAPE: RosterShape = {
  starters: { QB: 1, RB: 2, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['RB', 'WR', 'TE'] }],
  benchSlots: 5,
  irSlots: 1,
  totalStarters: 7,
  superflex: false,
};

/** A fixed Sunday, so every lock, freshness and kickoff read is reproducible. */
export const NOW = '2025-10-05T14:00:00Z';
export const KICKOFF = '2025-10-05T17:00:00Z';

export function at(id: string, name: string, position: string, points: number | null): StartSitInput {
  return candidate(id, name, position, points, { kickoff: KICKOFF, now: NOW });
}

/**
 * Ten players: a settled starting seven and three bench spots worth arguing
 * about.
 *
 * `benchWr` is the obvious scrub, `benchRb` is a slightly better one, and
 * `te2` is the only cover at a position the league must start — which is the
 * whole point of him. Every drop test is a statement about which of those three
 * a given add makes expendable.
 */
export function roster(): StartSitInput[] {
  return [
    at('qb1', 'Anchor Quarterback', 'QB', 18),
    at('rb1', 'Feature Back', 'RB', 14),
    at('rb2', 'Second Back', 'RB', 11),
    at('wr1', 'Alpha Receiver', 'WR', 13),
    at('wr2', 'Second Receiver', 'WR', 10),
    at('te1', 'Starting Tight End', 'TE', 9),
    at('rb3', 'Flex Back', 'RB', 8),
    at('te2', 'Backup Tight End', 'TE', 4),
    at('benchRb', 'Depth Back', 'RB', 2.5),
    at('benchWr', 'Roster Filler', 'WR', 1.5),
  ];
}

/**
 * The wire.
 *
 * `wireRb` is the strongest available player and walks into the flex;
 * `wireTe` is the tight end who makes the backup tight end redundant;
 * `wireWr` is a real but smaller upgrade; and the two fillers exist so that
 * "what would replace him" is a real number rather than a zero.
 */
export function wire(): StartSitInput[] {
  return [
    at('wireRb', 'Breakout Back', 'RB', 15),
    at('wireWr', 'Emerging Receiver', 'WR', 12),
    at('wireTe', 'Streaming Tight End', 'TE', 10),
    at('fillerWr', 'Wire Receiver', 'WR', 3),
    at('fillerRb', 'Wire Back', 'RB', 2),
  ];
}

/**
 * A wire with nothing on it worth starting.
 *
 * The counterpart to {@link wire}, and it exists because the two exercise
 * genuinely different halves of the model. Against a strong wire almost every
 * bench player's option value is zero — the wire would replace him — and the
 * drop ranking is decided by the lineup and the cover charge. Against this one
 * the option term is the whole story, which is the only way to test it.
 */
export function thinWire(): StartSitInput[] {
  return [
    at('fillerWr', 'Wire Receiver', 'WR', 3),
    at('fillerRb', 'Wire Back', 'RB', 2),
    at('fillerTe', 'Wire Tight End', 'TE', 1),
  ];
}

/**
 * A roster with a hole where the tight end should be.
 *
 * Eight players and an empty starting slot, so that filling it is worth far
 * more than anything else available — which is what makes a second tight end a
 * substitute rather than an addition.
 */
export function holeRoster(): StartSitInput[] {
  return [
    at('qb1', 'Anchor Quarterback', 'QB', 18),
    at('rb1', 'Feature Back', 'RB', 14),
    at('rb2', 'Second Back', 'RB', 11),
    at('wr1', 'Alpha Receiver', 'WR', 13),
    at('wr2', 'Second Receiver', 'WR', 10),
    at('rb3', 'Flex Back', 'RB', 8),
    at('benchRb', 'Depth Back', 'RB', 2.5),
    at('benchWr', 'Roster Filler', 'WR', 1.5),
  ];
}

/** Wrap inputs as targets, optionally with the bid the pricing pass produced. */
export function targets(
  inputs: StartSitInput[],
  bids: Record<string, { recommended: number | null; doNotExceed?: number | null; headline?: string }> = {},
): WaiverPlannerTarget[] {
  return inputs.map((input, index) => {
    const bid = bids[input.player.id];
    return {
      input,
      boardRank: index + 1,
      bid: bid
        ? {
            playerId: input.player.id,
            recommended: bid.recommended,
            doNotExceed: bid.doNotExceed ?? bid.recommended,
            headline: bid.headline ?? `Recommended max $${bid.recommended}`,
          }
        : null,
    };
  });
}

/** The plan inputs every test starts from. */
export function plannerInput(overrides: Partial<Parameters<typeof identity>[0]> = {}) {
  return identity({
    roster: roster(),
    targets: targets(wire()),
    shape: SHAPE,
    profile: HALF_PPR,
    now: NOW,
    generatedAt: '2025-10-05T14:00:00.000Z',
    ...overrides,
  });
}

function identity<T>(value: T): T {
  return value;
}

/**
 * A held-player record with one signal turned up.
 *
 * The planner takes `held` as an input precisely so a caller who knows about a
 * handcuff or a bye can say so, and the only way to test that the model reads
 * those signals is to supply one.
 */
export function heldFor(
  playerId: string,
  name: string,
  position: string,
  value: number,
  extra: Partial<import('../../src/core/roster/bench.ts').HeldPlayer> = {},
): import('../../src/core/roster/bench.ts').HeldPlayer {
  return {
    playerId,
    name,
    position,
    role: 'bench',
    restOfSeasonValue: value,
    fourWeekValue: value,
    insuranceValue: 0,
    upside: 'none',
    coversBye: false,
    streamingReplacement: null,
    ...extra,
  };
}
