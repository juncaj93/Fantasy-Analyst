/**
 * Waiver-aware lineup advice, and the four ways it becomes noise.
 *
 * It recommends somebody else's player. It recommends an add the bench already
 * covers. It recommends a fractional edge that costs a roster spot. It
 * recommends a move the clock has already made impossible. Each of those is a
 * test here, because each of them is what turns a useful suggestion into one
 * the user learns to ignore.
 *
 * Nothing in this module transacts, and nothing in these tests asserts that it
 * does — the output is sentences, and the add is made by hand in Sleeper.
 */

import { describe, expect, it } from 'vitest';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import type { StartSitEvaluation } from '../src/core/startsit/engine.ts';
import { recommendWaiverUpgrades, MEANINGFUL_UPGRADE_GAIN, upgradeBar } from '../src/core/startsit/waivers.ts';
import { candidate, signalWithNet } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile(
  { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rec_td: 6, rush_td: 6 },
  [],
);

const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN']);

/** A roster that fills every slot comfortably, so tests vary one thing. */
function healthyRoster() {
  return [
    candidate('qb1', 'Passer One', 'QB', 20),
    candidate('rb1', 'Runner One', 'RB', 15),
    candidate('rb2', 'Runner Two', 'RB', 13),
    candidate('rb3', 'Runner Three', 'RB', 11),
    candidate('wr1', 'Catcher One', 'WR', 14),
    candidate('wr2', 'Catcher Two', 'WR', 12),
    candidate('te1', 'End One', 'TE', 9),
  ];
}

const MY_IDS = ['qb1', 'rb1', 'rb2', 'rb3', 'wr1', 'wr2', 'te1'];

describe('an unfilled slot', () => {
  const roster = [
    candidate('qb1', 'Passer One', 'QB', 22, { status: 'Out' }),
    ...healthyRoster().slice(1),
  ];

  it('is what triggers a waiver evaluation at all', () => {
    const advice = recommendWaiverUpgrades({
      roster,
      candidates: [candidate('fa-qb', 'Free Passer', 'QB', 14)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
      currentStarterIds: ['qb1'],
    });

    expect(advice.upgrades).toHaveLength(1);
    const upgrade = advice.upgrades[0]!;
    expect(upgrade.slot).toBe('QB');
    expect(upgrade.need).toBe('unfilled');
    expect(upgrade.currentPlayerId).toBeNull();
    expect(upgrade.candidates[0]!.name).toBe('Free Passer');
    expect(upgrade.candidates[0]!.reasons.join(' · ')).toContain('Fills a slot nobody on your roster can start');
    // An empty slot has no bar: any playable body is an improvement on nobody.
    expect(upgrade.bar).toBe(0);
  });

  /** The decision order from the brief: roster first, pool second. */
  it('is not reached when the bench already covers it', () => {
    const advice = recommendWaiverUpgrades({
      roster: [...roster, candidate('qb2', 'Backup Passer', 'QB', 18)],
      candidates: [candidate('fa-qb', 'Free Passer', 'QB', 19)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: [...MY_IDS, 'qb2'],
      currentStarterIds: ['qb1'],
    });

    // The backup is worth ~18 and the free agent ~19 — a real difference, and
    // nowhere near worth a roster move.
    expect(advice.upgrades).toEqual([]);
    expect(advice.headline).toBe('Your current options grade better than available waivers.');
  });
});

describe('who may be recommended', () => {
  it('never recommends a player another manager owns', () => {
    const rival = candidate('rival-qb', 'Rival Passer', 'QB', 40);
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [rival, candidate('fa-qb', 'Free Passer', 'QB', 30)],
      shape: SHAPE,
      profile: HALF_PPR,
      // Sleeper's answer, and the one that wins: the rival's quarterback is on
      // a roster in this league even though the caller offered him.
      rosteredPlayerIds: [...MY_IDS, 'rival-qb'],
    });

    const names = advice.upgrades.flatMap((u) => u.candidates.map((c) => c.name));
    expect(names).not.toContain('Rival Passer');
    expect(names).toContain('Free Passer');
    expect(advice.notes.join(' ')).toContain('already rostered');
  });

  it('recommends a genuinely better available player', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('fa-te', 'Free End', 'TE', 15)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });

    const te = advice.upgrades.find((u) => u.slot === 'TE');
    expect(te).toBeDefined();
    expect(te!.currentName).toBe('End One');
    expect(te!.need).toBe('upgrade');
    expect(te!.candidates[0]!.gain).toBeGreaterThanOrEqual(MEANINGFUL_UPGRADE_GAIN);
    expect(te!.candidates[0]!.reasons.join(' ')).toContain('Market rising');
  });

  /*
   * The empty board, and the difference between losing and not being read.
   *
   * A free agent with no market, no usage and no news scores `null` and is
   * dropped before any slot compares him. On a real wire that is routinely most
   * of the pool, and the page used to close over it with `Your current options
   * grade better than available waivers.` — a verdict about players nobody
   * graded. These three tests pin the three sentences apart.
   */
  describe('the sentence an empty board closes with', () => {
    it('does not claim a verdict when nobody could be scored', () => {
      const advice = recommendWaiverUpgrades({
        roster: healthyRoster(),
        // No market, no news, no status: nothing to score him on at all.
        candidates: [candidate('fa-te', 'Unread End', 'TE', null)],
        shape: SHAPE,
        profile: HALF_PPR,
        rosteredPlayerIds: MY_IDS,
      });

      expect(advice.upgrades).toEqual([]);
      expect(advice.skipped).toBe(1);
      expect(advice.headline).not.toContain('grade better');
      expect(advice.headline).toContain('No free agent could be scored');
      // He was not rejected, and the line may not let a reader think he was.
      expect(advice.headline).toContain('Unknown, not ruled out.');
    });

    it('counts the unread beside the compared when there were both', () => {
      const advice = recommendWaiverUpgrades({
        roster: healthyRoster(),
        candidates: [
          candidate('fa-te', 'Marginal End', 'TE', 10),
          candidate('fa-te2', 'Unread End', 'TE', null),
          candidate('fa-wr', 'Unread Catcher', 'WR', null),
        ],
        shape: SHAPE,
        profile: HALF_PPR,
        rosteredPlayerIds: MY_IDS,
      });

      expect(advice.upgrades).toEqual([]);
      expect(advice.skipped).toBe(2);
      // The one that lost is claimed as a comparison; the two are not.
      expect(advice.headline).toContain('better than the 1 free agent that could be scored');
      expect(advice.headline).toContain('2 free agents had nothing to read');
    });

    it('counts only the unread, never the ruled out', () => {
      const advice = recommendWaiverUpgrades({
        roster: healthyRoster(),
        candidates: [
          candidate('fa-te', 'Marginal End', 'TE', 10),
          candidate('fa-te2', 'Unread End', 'TE', null),
          // Scorable and genuinely unavailable. Excluded on a fact, not on
          // ignorance, so the sentence may not describe him as unknown.
          candidate('fa-te3', 'Injured End', 'TE', 20, { status: 'IR' }),
        ],
        shape: SHAPE,
        profile: HALF_PPR,
        rosteredPlayerIds: MY_IDS,
      });

      expect(advice.upgrades).toEqual([]);
      // Both were dropped from the comparison...
      expect(advice.skipped).toBe(2);
      // ...but only one of them is something the app failed to read.
      expect(advice.headline).toContain('1 free agent had nothing to read');
      expect(advice.headline).not.toContain('2 free agents had nothing to read');
    });

    it('is unchanged when the whole wire was actually compared', () => {
      const advice = recommendWaiverUpgrades({
        roster: healthyRoster(),
        candidates: [candidate('fa-te', 'Marginal End', 'TE', 10)],
        shape: SHAPE,
        profile: HALF_PPR,
        rosteredPlayerIds: MY_IDS,
      });

      expect(advice.skipped).toBe(0);
      expect(advice.headline).toBe('Your current options grade better than available waivers.');
    });
  });

  it('says nothing about a trivial edge', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('fa-te', 'Marginal End', 'TE', 10)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });
    expect(advice.upgrades).toEqual([]);
    expect(advice.headline).toBe('Your current options grade better than available waivers.');
    expect(advice.considered, 'he was scored, and then rejected').toBe(1);
  });

  it('never offers the same player as the answer to two slots', () => {
    // One strong receiver, eligible for WR and for FLEX.
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('fa-wr', 'Free Catcher', 'WR', 25)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });

    const appearances = advice.upgrades.flatMap((u) => u.candidates.map((c) => c.playerId));
    expect(appearances.filter((id) => id === 'fa-wr')).toHaveLength(1);
  });

  it('shows at most the top few per slot', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [
        candidate('fa-te1', 'Free End One', 'TE', 18),
        candidate('fa-te2', 'Free End Two', 'TE', 17),
        candidate('fa-te3', 'Free End Three', 'TE', 16),
        candidate('fa-te4', 'Free End Four', 'TE', 15),
        candidate('fa-te5', 'Free End Five', 'TE', 14),
      ],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });

    const te = advice.upgrades.find((u) => u.slot === 'TE')!;
    expect(te.candidates).toHaveLength(3);
    expect(te.candidates.map((c) => c.name)).toEqual(['Free End One', 'Free End Two', 'Free End Three']);
    expect(te.candidates[0]!.gain).toBeGreaterThan(te.candidates[2]!.gain);
  });
});

describe('moves that cannot be made', () => {
  const NOW = '2026-09-13T18:00:00Z';

  it('does not offer a free agent whose game has already started', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [
        candidate('fa-te', 'Kicked Off End', 'TE', 20, { kickoff: '2026-09-13T17:00:00Z', now: NOW }),
        candidate('fa-te2', 'Later End', 'TE', 16, { kickoff: '2026-09-13T20:00:00Z', now: NOW }),
      ],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });

    const names = advice.upgrades.flatMap((u) => u.candidates.map((c) => c.name));
    expect(names).not.toContain('Kicked Off End');
    expect(names).toContain('Later End');
    /*
     * Counted, not narrated.
     *
     * This used to read the sentence the advice pushed into `notes`, which the
     * Waivers screen printed under the recommendations — engine bookkeeping on
     * a page for choosing between two players. The count is still here, as a
     * number, and it is still the thing worth asserting: somebody was left out
     * and the engine knows how many.
     */
    expect(advice.skipped).toBeGreaterThan(0);
  });

  it('gives no advice about a slot whose player is already playing', () => {
    const roster = healthyRoster().map((c) =>
      c.player.id === 'te1' ? candidate('te1', 'End One', 'TE', 9, { kickoff: '2026-09-13T17:00:00Z', now: NOW }) : c,
    );
    const advice = recommendWaiverUpgrades({
      roster,
      candidates: [candidate('fa-te', 'Free End', 'TE', 20, { kickoff: '2026-09-13T20:00:00Z', now: NOW })],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
      currentStarterIds: ['te1'],
    });

    expect(advice.upgrades.find((u) => u.slot === 'TE')).toBeUndefined();
  });

  it('does not offer somebody who is out himself', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [
        candidate('fa-te', 'Injured End', 'TE', 25, { status: 'Out' }),
        candidate('fa-te2', 'Reserve End', 'TE', 24, { status: 'IR' }),
      ],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });
    expect(advice.upgrades).toEqual([]);
  });
});

describe('the same intelligence as everywhere else', () => {
  /**
   * Vegas, availability and the tally all reach the candidate through
   * `evaluatePlayer` — the engine the head-to-head comparison and the lineup
   * both use. This checks the wiring by moving each input and watching the
   * recommendation move with it.
   */
  it('reads Vegas, injury and news through the shared engine', () => {
    const base = {
      roster: healthyRoster(),
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    };

    // Vegas alone: a bigger market expectation is a bigger gain.
    const modest = recommendWaiverUpgrades({ ...base, candidates: [candidate('fa', 'Free End', 'TE', 13)] });
    const strong = recommendWaiverUpgrades({ ...base, candidates: [candidate('fa', 'Free End', 'TE', 20)] });
    expect(strong.upgrades[0]!.candidates[0]!.gain).toBeGreaterThan(modest.upgrades[0]!.candidates[0]!.gain);

    // Availability: the same player, listed Questionable, is worth less.
    const questionable = recommendWaiverUpgrades({
      ...base,
      candidates: [candidate('fa', 'Free End', 'TE', 20, { status: 'Questionable' })],
    });
    expect(questionable.upgrades[0]!.candidates[0]!.gain).toBeLessThan(strong.upgrades[0]!.candidates[0]!.gain);
    expect(questionable.upgrades[0]!.candidates[0]!.statusFlag).toMatch(/Questionable/i);

    // The tally: positive recent news lifts him, and is named as a reason.
    const newsy = recommendWaiverUpgrades({
      ...base,
      candidates: [candidate('fa', 'Free End', 'TE', 20, { signal: signalWithNet(5) })],
    });
    expect(newsy.upgrades[0]!.candidates[0]!.gain).toBeGreaterThan(strong.upgrades[0]!.candidates[0]!.gain);
    expect(newsy.upgrades[0]!.candidates[0]!.reasons.join(' ')).toContain('Recent news');
  });

  it('reports the size of the pool it actually looked at', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('a', 'A', 'TE', 5), candidate('b', 'B', 'TE', 4)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });
    expect(advice.considered).toBe(2);
    expect(advice.threshold).toBe(MEANINGFUL_UPGRADE_GAIN);
  });
});

describe('the threshold itself', () => {
  const wellCovered = { confidence: 'high' } as StartSitEvaluation;
  const thin = { confidence: 'low' } as StartSitEvaluation;
  const partial = { confidence: 'medium' } as StartSitEvaluation;

  it('is one number, in one place', () => {
    expect(MEANINGFUL_UPGRADE_GAIN).toBe(2.5);
    expect(upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, wellCovered, wellCovered)).toBe(MEANINGFUL_UPGRADE_GAIN);
  });

  /** An empty slot is a need, not a preference: any playable body clears it. */
  it('does not apply to a slot nobody is starting in', () => {
    expect(upgradeBar('unfilled', MEANINGFUL_UPGRADE_GAIN, null, thin)).toBe(0);
  });

  /**
   * The rule that keeps the card quiet.
   *
   * A gap measured against a player the market has not priced is mostly the
   * missing side showing through, so it has to be bigger before it is worth
   * saying. Either side being thin is enough — the weaker half is what limits
   * what the subtraction can be trusted to mean.
   */
  it('asks more of a gap measured against thin data, on either side', () => {
    const solid = upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, wellCovered, wellCovered);
    expect(upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, thin, wellCovered)).toBeGreaterThan(solid);
    expect(upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, wellCovered, thin)).toBeGreaterThan(solid);
    expect(upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, partial, wellCovered)).toBeGreaterThan(solid);
    // The worse of the two decides, so one thin side is not softened by a
    // well-covered one.
    expect(upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, thin, wellCovered)).toBe(
      upgradeBar('upgrade', MEANINGFUL_UPGRADE_GAIN, thin, thin),
    );
  });

  it('suppresses an add whose apparent edge is only the missing half', () => {
    // The incumbent has a market and grades ~9; the free agent has none at all,
    // so his score comes from news and availability alone.
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('fa-te', 'Unpriced End', 'TE', null, { signal: signalWithNet(9) })],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
    });
    expect(advice.upgrades).toEqual([]);
  });

  it('can be raised or lowered by a caller without editing the engine', () => {
    const advice = recommendWaiverUpgrades({
      roster: healthyRoster(),
      candidates: [candidate('fa-te', 'Marginal End', 'TE', 10)],
      shape: SHAPE,
      profile: HALF_PPR,
      rosteredPlayerIds: MY_IDS,
      minGain: 0.5,
    });
    expect(advice.upgrades).toHaveLength(1);
    expect(advice.threshold).toBe(0.5);
  });
});
