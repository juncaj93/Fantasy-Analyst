/**
 * Round 27: a player Sleeper rules inactive counts as Out in start/sit.
 *
 * Sleeper marks game-day inactives `Out`; healthy scratches carry the body part
 * "Coach's Decision" (Thomas Fidone II and Athan Kaliakmanis, Thursday
 * 12 November). Nothing new reads that: the player list stores
 * `injury_status`, the injury read turns it into a Sleeper observation beside
 * the Friday report, the worse and newer one wins, and the shared
 * `weekAvailability` rule zeroes an Out player. This file pins that path end to
 * end with Sleeper's real shape, so a later change to any link breaks a test
 * rather than a Sunday.
 *
 * Cases: inactive (Out, coach's decision), active (still Questionable), source
 * missing (no Sleeper reading at all), stale (an Out from last week).
 */

import { describe, expect, it } from 'vitest';
import { toCanonicalPlayers } from '../src/core/sleeper/transform.ts';
import type { SleeperPlayer } from '../src/core/sleeper/types.ts';
import { normalizeDesignation, resolveInjury, type InjuryObservation } from '../src/core/injury/model.ts';
import { availableWeekPoints, weekAvailability } from '../src/core/injury/weekAvailability.ts';

/** Sunday 15 November, 12:15 PM EST: the new download. */
const SUNDAY_DOWNLOAD = '2026-11-15T17:15:30Z';
/** Friday's final report, as nflverse stamps it. */
const FRIDAY_REPORT = '2026-11-13T15:18:18Z';
const NOW = new Date('2026-11-15T17:20:00Z');

function sleeperPlayer(extra: Partial<SleeperPlayer>): Record<string, SleeperPlayer> {
  return {
    '12715': {
      player_id: '12715',
      first_name: 'Thomas',
      last_name: 'Fidone II',
      full_name: 'Thomas Fidone II',
      position: 'TE',
      fantasy_positions: ['TE'],
      team: 'NYG',
      active: true,
      status: 'Active',
      ...extra,
    } as SleeperPlayer,
  };
}

/** The read side, as `InjuryService` builds it: Sleeper's stored status plus the report. */
function stateFor(storedStatus: string | null, statusAsOf: string | null, report: string | null) {
  const observations: InjuryObservation[] = [];
  const sleeper = normalizeDesignation(storedStatus);
  if (sleeper.designation !== 'unknown') {
    observations.push({ source: 'sleeper', designation: sleeper.designation, raw: sleeper.raw, observedAt: statusAsOf, asOf: statusAsOf });
  }
  if (report != null) {
    const reported = normalizeDesignation(report);
    observations.push({ source: 'nflverse', designation: reported.designation, raw: reported.raw, observedAt: FRIDAY_REPORT, bodyPart: 'Hamstring' });
  }
  return resolveInjury(observations, NOW);
}

describe('Round 27: a Sleeper inactive counts as Out', () => {
  it('inactive: Out with "Coach\'s Decision" is stored as Out and benches a Questionable starter', () => {
    const [player] = toCanonicalPlayers(sleeperPlayer({ injury_status: 'Out', injury_body_part: "Coach's Decision" }));
    expect(player!.status).toBe('Out');

    const state = stateFor(player!.status, SUNDAY_DOWNLOAD, 'Questionable');
    expect(state.designation).toBe('out');
    expect(weekAvailability(state.designation).out).toBe(true);
    expect(availableWeekPoints(14.2, state.designation)).toBe(0);
  });

  it('active: Sleeper still Questionable at 12:15 PM keeps him at full value with his chip', () => {
    // Not ruled inactive: Sleeper keeps Friday's word (George Pickens reads this way today).
    const [player] = toCanonicalPlayers(sleeperPlayer({ injury_status: 'Questionable', injury_body_part: 'Hamstring' }));
    expect(player!.status).toBe('Questionable');

    const state = stateFor(player!.status, SUNDAY_DOWNLOAD, 'Questionable');
    expect(state.designation).toBe('questionable');
    expect(weekAvailability(state.designation)).toEqual({ charge: 0, out: false, warn: true });
    expect(availableWeekPoints(14.2, state.designation)).toBe(14.2);
  });

  it('source missing: no Sleeper reading falls back to the report alone', () => {
    const state = stateFor(null, null, 'Questionable');
    expect(state.designation).toBe('questionable');
    expect(weekAvailability(state.designation).out).toBe(false);
  });

  it('stale: an Out from last week does not outrank this Friday\'s report', () => {
    // Sleeper's copy is from the previous Monday, more than a day older than the report.
    const state = stateFor('Out', '2026-11-09T09:00:40Z', 'Questionable');
    expect(state.designation).toBe('questionable');
    expect(weekAvailability(state.designation).out).toBe(false);
  });
});
