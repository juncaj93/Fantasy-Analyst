/**
 * The fingerprint that stops a scoring change reading as an engine regression.
 *
 * A snapshot carries the league's *published* rules rather than the two derived
 * values every engine reads them through — `roster_positions` and
 * `scoring_settings`, because the derived scoring profile ends its
 * points-allowed table at `Infinity` and JSON writes that as `null`. The cost of
 * that choice is that a replay re-derives, and a build whose derivation has
 * moved re-derives an old file under rules it was never made under.
 *
 * `derivation.ts` closes it by fingerprinting the derivation itself. This file
 * checks the three things that has to be true of such a fingerprint: it changes
 * when the derivation changes, it does *not* change for reasons that are not the
 * derivation, and a file that never carried one still replays.
 */

import { describe, expect, it } from 'vitest';
import { checkDerivation, derivationFingerprint, fingerprintOf } from '../src/core/support/derivation.ts';
import { captureLeagueRules, rehydrateLeagueRules } from '../src/core/support/inseason.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';

const HALF_PPR = { rec: 0.5, pass_td: 4 };
const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN'];

const rules = (over: { scoringSettings?: Record<string, number>; rosterPositions?: string[] } = {}) => ({
  rosterPositions: over.rosterPositions ?? POSITIONS,
  scoringSettings: over.scoringSettings ?? HALF_PPR,
});

describe('the derivation fingerprint', () => {
  it('is the same for the same rules, every time', () => {
    expect(derivationFingerprint(rules())).toBe(derivationFingerprint(rules()));
    /* Short enough to be read out and compared by a person. */
    expect(derivationFingerprint(rules())).toMatch(/^[0-9a-f]{8}$/);
  });

  it('does not depend on the order the league published its settings in', () => {
    /*
     * Object key order is insertion order, and Sleeper does not promise one.
     * A fingerprint that moved when a league's settings arrived in a different
     * order would fire on every second capture and be turned off within a week.
     */
    const forwards = { rec: 0.5, pass_td: 4, bonus_rec_te: 0.5 };
    const backwards = { bonus_rec_te: 0.5, pass_td: 4, rec: 0.5 };
    expect(derivationFingerprint(rules({ scoringSettings: forwards }))).toBe(
      derivationFingerprint(rules({ scoringSettings: backwards })),
    );
  });

  it('changes when the league scores differently', () => {
    expect(derivationFingerprint(rules({ scoringSettings: { rec: 1, pass_td: 4 } }))).not.toBe(
      derivationFingerprint(rules()),
    );
  });

  it('changes when the league starts a different roster', () => {
    expect(derivationFingerprint(rules({ rosterPositions: [...POSITIONS, 'WR'] }))).not.toBe(
      derivationFingerprint(rules()),
    );
  });

  it('sees the end of the points-allowed table, where JSON cannot', () => {
    /*
     * The whole reason this module hashes its own text rather than
     * `JSON.stringify`.
     *
     * The top band of a defensive points-allowed table is "and above", which is
     * `to: Infinity` — and `JSON.stringify(Infinity)` is `null`, which is also
     * what an *absent* bound produces. A fingerprint taken through JSON would
     * read those two as the same derivation, and they are exactly the pair that
     * made this feature stop carrying derived profiles at all.
     *
     * So the shape is asserted to still exist, and then the two are fingerprinted
     * and required to differ.
     */
    const withTiers = { ...HALF_PPR, pts_allow_0: 10, pts_allow_14_20: 1, pts_allow_35p: -4 };
    const profile = buildScoringProfile(withTiers, POSITIONS);
    const top = profile.dst.pointsAllowed.at(-1);
    expect(top?.to, 'the top band is still open-ended').toBe(Infinity);

    /*
     * The same table with the open end closed. Through `JSON.stringify` both
     * sides read `null` and hash identically; through `stableText` they do not.
     */
    const closed = {
      ...profile,
      dst: { ...profile.dst, pointsAllowed: [...profile.dst.pointsAllowed.slice(0, -1), { ...top!, to: null }] },
    };
    expect(JSON.stringify(profile.dst.pointsAllowed)).toBe(JSON.stringify(closed.dst.pointsAllowed));
    expect(fingerprintOf(profile)).not.toBe(fingerprintOf(closed));
  });
});

describe('a replay checks the fingerprint it was given', () => {
  it('captures one, and agrees with itself', () => {
    const captured = captureLeagueRules({ rosterPositions: POSITIONS, scoringSettings: HALF_PPR });
    expect(captured.derivation).toMatch(/^[0-9a-f]{8}$/);

    const { derivation } = rehydrateLeagueRules(captured);
    expect(derivation).toEqual({ captured: captured.derivation, current: captured.derivation, matches: true });
  });

  it('disagrees when the file was written by a build that derived differently', () => {
    const captured = captureLeagueRules({ rosterPositions: POSITIONS, scoringSettings: HALF_PPR });
    const { derivation } = rehydrateLeagueRules({ ...captured, derivation: 'deadbeef' });

    expect(derivation.matches).toBe(false);
    expect(derivation.captured).toBe('deadbeef');
    expect(derivation.current).toBe(captured.derivation);
  });

  it('passes a file that never carried one, rather than refusing it', () => {
    /*
     * Every snapshot captured before this existed. An absent claim is not a
     * disagreement, and refusing old files to gain a check they could never have
     * carried would trade a real capability for a theoretical one.
     */
    const check = checkDerivation({ rosterPositions: POSITIONS, scoringSettings: HALF_PPR });
    expect(check.matches).toBe(true);
    expect(check.captured).toBeNull();
    expect(check.current).toMatch(/^[0-9a-f]{8}$/);
  });
});
