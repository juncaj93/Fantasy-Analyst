/**
 * Round 30, item 3: the bench card says what the row says.
 *
 * Round 29 audit (A3, S1): the QB row read "Start Rhys Donnelly instead", and
 * tapping Donnelly on the bench opened a card that said "Bench this week",
 * because every bench row opened its card as a bench player. Team now opens a
 * bench card with the row decision `rowStartingFromBench` reads, and these
 * tests run that through the real row builder and the real card builder.
 */

import { describe, expect, it } from 'vitest';
import { buildLineupVerdicts, rowStartingFromBench } from '../src/core/startsit/sleeperLineup.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { candidate, defence } from './helpers/startsit.ts';
import { DST_SCORING } from '../src/core/demo/fixtures/dst.ts';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(POSITIONS);
const PROFILE = buildScoringProfile(DST_SCORING as Record<string, number>, POSITIONS);

/* Sleeper starts Halloran at QB; Donnelly, on the bench, is far better this week. */
const ROSTER = [
  candidate('halloran', 'Trey Halloran', 'QB', 12),
  candidate('rb1', 'Back One', 'RB', 14),
  candidate('rb2', 'Back Two', 'RB', 11),
  candidate('wr1', 'Catcher One', 'WR', 15),
  candidate('wr2', 'Catcher Two', 'WR', 12),
  candidate('wr3', 'Catcher Three', 'WR', 10),
  candidate('fx1', 'Flex One', 'RB', 9),
  candidate('fx2', 'Flex Two', 'WR', 8),
  defence('def1', 'Jacksonville', { spread: -7.5, total: 42.5, opponent: 'CAR' }, { team: 'JAX' }),
  candidate('donnelly', 'Rhys Donnelly', 'QB', 22),
  candidate('bn1', 'Bench One', 'WR', 4),
];
const POSITION_OF = new Map(ROSTER.map((c) => [c.player.id, c.player.position ?? null] as const));
const SLEEPER = ['halloran', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'fx1', 'fx2', 'def1'];

function rows() {
  const lineup = recommendLineup(ROSTER, SHAPE, PROFILE, { currentStarterIds: SLEEPER });
  return buildLineupVerdicts({
    rosterPositions: POSITIONS,
    starterIds: SLEEPER,
    slots: lineup.slots,
    suggestedSwaps: lineup.swaps,
    positionOf: (id) => POSITION_OF.get(id) ?? null,
  });
}

/* What Team's bench row passes to the card, as TeamScreen does it. */
function benchContext(playerId: string) {
  const row = rowStartingFromBench(rows(), playerId);
  return row ? { starting: true, slot: row.slot, alreadyStarting: false, locked: row.locked } : { starting: false };
}

const evaluation = (playerId: string, name: string, position: string) => ({
  playerId,
  name,
  position,
  team: 'XX',
  score: 20,
  confidence: 'high',
  statusFlag: null,
  ruledOut: false,
  opponent: 'MIA',
});

describe('a bench card and the row agree', () => {
  it('the QB row starts Donnelly, and his bench card says Start at QB', () => {
    const qb = rows().find((r) => r.slot === 'QB');
    expect(qb?.verdict).toBe('swap');
    expect(qb?.recommendedPlayerId).toBe('donnelly');

    const card = buildWeeklyCard(evaluation('donnelly', 'Rhys Donnelly', 'QB'), benchContext('donnelly'));
    expect(card.headline.verdict).toBe('start');
    expect(card.headline.label).toBe('Start at QB');
  });

  it('a bench player no row starts still reads Bench this week', () => {
    expect(rowStartingFromBench(rows(), 'bn1')).toBeNull();
    const card = buildWeeklyCard(evaluation('bn1', 'Bench One', 'WR'), benchContext('bn1'));
    expect(card.headline.label).toBe('Bench this week');
  });

  it('a starter a row keeps is never read as a bench start', () => {
    expect(rowStartingFromBench(rows(), 'wr1')).toBeNull();
  });
});
