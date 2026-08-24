/**
 * The board declines to move a defence on roster need. The alerts above it now
 * decline to argue for one.
 *
 * `draft.defence.test.ts` settled the ranking: a defence is ordered on Sleeper
 * ADP and nothing else, because no news rule reads one, no published draft
 * order covers one, no Vegas market prices one and no preseason projection
 * includes one. `DEFENCE_WEIGHTS` carries a zero for `need` specifically.
 *
 * What that change did not reach was the roster alerts, and the result was a
 * screen arguing with itself: `Still need a starting DEF` in warn-red above a
 * ranking that had explicitly refused to act on the same fact, followed a few
 * rounds later by `9 WRs already — DEF depth is becoming more important`. Both
 * were pressure the board underneath them would not honour, and pressure a
 * reader cannot act on is worse than silence — which is what this lane replaces
 * it with.
 *
 * **The exception is objective.** A league that starts two defences has made one
 * a genuine roster requirement, and a reader there is owed the same warning as
 * anybody else. That is a property of `RosterShape`, not a league-name special
 * case, and it is the last block below.
 */

import { describe, expect, it } from 'vitest';
import { rosterAlerts, quietPositions, DECISION_THRESHOLDS } from '../src/core/draft/decisions.ts';
import { computeNeed } from '../src/core/draft/need.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import type { RosterCounts } from '../src/core/draft/need.ts';

const ONE_DEFENCE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN']);
const TWO_DEFENCES = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'DEF', 'BN', 'BN', 'BN', 'BN']);
const NO_DEFENCE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN']);

function alertsFor(shape: typeof ONE_DEFENCE, counts: RosterCounts, round: number, totalRounds = 14) {
  return rosterAlerts({ shape, counts, needs: computeNeed(shape, counts), round, totalRounds });
}

function messages(alerts: { message: string; detail: string }[]): string {
  return alerts.map((a) => `${a.message} ${a.detail}`).join(' | ');
}

/** Everything filled except the defence, which is the ordinary late-draft state. */
const ALL_BUT_DEFENCE: RosterCounts = { QB: 1, RB: 3, WR: 4, TE: 1, DEF: 0 };

describe('an empty DEF slot creates no pressure in a one-defence league', () => {
  it('never says "Still need a starting DEF", at any round', () => {
    // Swept across the whole draft rather than asserted at one round, because
    // the severity of these alerts is a function of the round — and the round
    // this used to fire loudest at is the last one.
    for (let round = 1; round <= 14; round++) {
      const alerts = alertsFor(ONE_DEFENCE, ALL_BUT_DEFENCE, round);
      expect(messages(alerts)).not.toContain('DEF');
      expect(alerts.some((a) => a.positions.includes('DEF'))).toBe(false);
    }
  });

  it('never says it in the last rounds, where it used to be urgent', () => {
    const { startersCriticalFromRound } = DECISION_THRESHOLDS.rosterAlerts;
    const alerts = alertsFor(ONE_DEFENCE, ALL_BUT_DEFENCE, startersCriticalFromRound + 1);

    expect(alerts.some((a) => a.severity === 'urgent')).toBe(false);
    expect(messages(alerts)).not.toContain('DEF');
  });

  it('never argues that DEF depth is becoming more important', () => {
    /*
     * The lopsided alert names the *thinnest* position and argues for it, and
     * an empty defence slot is the reliable minimum for eleven rounds of any
     * draft — so left in, it would reintroduce the same sentence in different
     * words and with a depth argument behind it. Nine receivers is well past
     * the gap that fires this.
     */
    const receiverPile: RosterCounts = { QB: 1, RB: 2, WR: 9, TE: 1, DEF: 0 };
    const alerts = alertsFor(ONE_DEFENCE, receiverPile, 12);

    expect(messages(alerts)).not.toContain('DEF');
    // And the alert still fires — it names a position a reader can act on
    // rather than being suppressed along with the defence.
    expect(alerts.some((a) => a.key.startsWith('lopsided:'))).toBe(true);
  });

  it('does not count the defence among the open slots in the early note', () => {
    const empty: RosterCounts = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0 };
    const alerts = alertsFor(ONE_DEFENCE, empty, 2);
    const early = alerts.find((a) => a.key === 'starters:early');

    // Seven skill slots, not eight: QB, RB×2, WR×3, TE. The flex is not a
    // dedicated slot and never was.
    expect(early?.message).toBe('7 starting slots still open');
    expect(early?.positions).not.toContain('DEF');
  });

  it('stays silent rather than claiming a lineup is covered while DEF is empty', () => {
    /*
     * The tempting wrong fix. "Starting lineup is covered" is a claim about
     * *every* slot, and firing it off a list the defence has been removed from
     * would tell a reader with an empty DEF slot that every dedicated slot has
     * somebody in it. A false reassurance is worse than the pressure this whole
     * section removes — so the quiet buys silence, not a claim.
     */
    const alerts = alertsFor(ONE_DEFENCE, ALL_BUT_DEFENCE, 12);
    expect(alerts.some((a) => a.key === 'starters:covered')).toBe(false);
  });

  it('says the lineup is covered once the defence is actually in it', () => {
    const complete: RosterCounts = { QB: 1, RB: 3, WR: 4, TE: 1, DEF: 1 };
    const alerts = alertsFor(ONE_DEFENCE, complete, 12);

    expect(alerts.some((a) => a.key === 'starters:covered')).toBe(true);
  });
});

describe('every other position is untouched', () => {
  it('still presses for a missing tight end', () => {
    const noTe: RosterCounts = { QB: 1, RB: 3, WR: 4, TE: 0, DEF: 1 };
    const alerts = alertsFor(ONE_DEFENCE, noTe, 12);

    expect(messages(alerts)).toContain('Still need a starting TE');
    expect(alerts.find((a) => a.key === 'starter:TE')?.severity).toBe('urgent');
  });

  it('produces exactly the alerts the same league without a DEF slot produces', () => {
    /*
     * The paranoid check. A one-defence league with its defence slot filled
     * must behave identically to a league that has no defence slot at all —
     * asserted as a whole-object comparison across the draft, so a severity, a
     * detail sentence or a position list moving would fail here rather than
     * being noticed in production.
     */
    const withDefence: RosterCounts = { QB: 1, RB: 2, WR: 3, TE: 0, DEF: 1 };
    const without: RosterCounts = { QB: 1, RB: 2, WR: 3, TE: 0 };

    for (let round = 1; round <= 14; round++) {
      expect(alertsFor(ONE_DEFENCE, withDefence, round)).toEqual(alertsFor(NO_DEFENCE, without, round));
    }
  });
});

describe('a league that starts two defences is the objective exception', () => {
  it('is not quiet about DEF', () => {
    expect([...quietPositions(ONE_DEFENCE)]).toEqual(['DEF']);
    expect([...quietPositions(TWO_DEFENCES)]).toEqual([]);
    expect([...quietPositions(NO_DEFENCE)]).toEqual([]);
  });

  it('presses for the defences it genuinely cannot field a lineup without', () => {
    const alerts = alertsFor(TWO_DEFENCES, ALL_BUT_DEFENCE, 12);

    expect(messages(alerts)).toContain('Still need a starting DEF (2)');
    expect(alerts.find((a) => a.key === 'starter:DEF')?.severity).toBe('urgent');
  });

  it('and says the lineup is covered once both are in it', () => {
    const complete: RosterCounts = { QB: 1, RB: 3, WR: 4, TE: 1, DEF: 2 };
    expect(alertsFor(TWO_DEFENCES, complete, 12).some((a) => a.key === 'starters:covered')).toBe(true);
  });
});
