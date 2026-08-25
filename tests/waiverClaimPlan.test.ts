/**
 * The seam between the claim planner and the product.
 *
 * `tests/waiverPlanner.*` prove the model: that the preferred cut moves with the
 * incoming player, that the A/B/C/D structure exploits Sleeper's sequential
 * processing, that a substitute is derived rather than labelled. None of that is
 * retested here. This file tests the two things the integration is responsible
 * for and the model is not:
 *
 * 1. **The planner gets the live inputs.** The board's own order, the priced bid
 *    handed through unchanged, the reserve slots, the wallet — read from the
 *    objects the endpoint already holds, and none of them recomputed.
 * 2. **A reader is told what to do in English.** No reason code reaches a
 *    sentence, the repeated lines say why they repeat, and every empty ending is
 *    named honestly rather than shown as a blank.
 *
 * Nothing here mocks the planner. Every plan below is a real one over the shared
 * fixture, which is the only way an assertion about a sentence is also an
 * assertion about the arithmetic underneath it.
 */

import { describe, expect, it } from 'vitest';
import { buildWaiverClaimPlan, describeWaiverPlan, planWaiversFor } from '../src/core/waivers/claimPlan.ts';
import { planWaiverClaims } from '../src/core/waivers/planner/index.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { DEFENCE_POSITION } from '../src/core/startsit/engine.ts';
import { DST_ROSTER_POSITIONS, DST_SCORING } from '../src/core/demo/fixtures/dst.ts';
import { defence } from './helpers/startsit.ts';
import {
  HALF_PPR,
  KICKOFF,
  NOW,
  SHAPE,
  adviceFor,
  at,
  budgetState,
  holeRoster,
  roster,
  thinWire,
  wire,
} from './helpers/waiverPlanner.ts';

/** The worked week from `waiverPlanner.example.test.ts`, through the seam. */
const PRICES = {
  wireRb: { recommended: 24, doNotExceed: 29, headline: 'Expected $18–24 · Recommended max $24' },
  wireWr: { recommended: 14, doNotExceed: 17, headline: 'Expected $11–15 · Recommended max $14' },
  wireTe: { recommended: 4, doNotExceed: 6, headline: 'Expected $2–5 · Recommended max $4' },
};

function planFor(overrides: Partial<Parameters<typeof buildWaiverClaimPlan>[0]> = {}) {
  return buildWaiverClaimPlan({
    roster: roster(),
    candidates: wire(),
    advice: adviceFor(wire(), PRICES),
    shape: SHAPE,
    profile: HALF_PPR,
    budget: budgetState(60),
    now: NOW,
    generatedAt: '2025-10-05T14:00:00.000Z',
    ...overrides,
  });
}

describe('what the planner is handed', () => {
  /**
   * The board's order becomes the planner's `boardRank`.
   *
   * Which targets are looked at at all is decided by that ranking, and the
   * ranking carries the league-intelligence pass's work — who else needs the
   * position, what the room has paid — which the planner has no access to. A
   * second ordering computed here would be a second opinion about who is worth
   * chasing, arrived at with strictly less information.
   */
  it('ranks targets in the order the reader sees them on the board', () => {
    const { plan, rows } = planWaiversFor({
      roster: roster(),
      candidates: wire(),
      advice: adviceFor(wire(), PRICES),
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
    });
    expect(rows.map((r) => r.playerId)).toEqual(['wireRb', 'wireWr', 'wireTe', 'fillerWr', 'fillerRb']);
    expect(plan?.search.targetsConsidered).toBe(5);
  });

  /**
   * The displayed bid *is* the recommended bid, and the type is what guarantees
   * it.
   *
   * `PlannerBid` is a structural subset of the object the pricing pass produced,
   * so the seam passes a reference rather than choosing fields. If this ever
   * fails, something has started copying — which is the shape a second FAAB
   * model arrives in.
   */
  it('passes the priced bid through without touching it', () => {
    const plan = planFor();
    const bids = new Map(plan.claims.map((c) => [c.addPlayerId, c.bid]));
    expect(bids.get('wireRb')).toBe(PRICES.wireRb.recommended);
    expect(bids.get('wireWr')).toBe(PRICES.wireWr.recommended);
    expect(bids.get('wireTe')).toBe(PRICES.wireTe.recommended);

    /* And the two claims for one target carry one price, not two. */
    const receiver = plan.claims.filter((c) => c.addPlayerId === 'wireWr');
    expect(receiver.length).toBe(2);
    expect(new Set(receiver.map((c) => c.bid)).size).toBe(1);
  });

  /** The pricing pass's own headline, quoted rather than paraphrased. */
  it('quotes the pricing pass rather than writing about money itself', () => {
    const claim = planFor().claims[0]!;
    expect(claim.why).toContain(PRICES.wireRb.headline);
  });

  it('reads the wallet from the league budget state', () => {
    expect(planFor().budget).toContain('$42 of the $60 you have left');
  });

  /**
   * A league that does not bid gets an order and no prices.
   *
   * The FAAB pass already withholds in a priority league, and the planner
   * refuses to print a figure whatever it was handed. What survives is the half
   * that is true in every league: who to add, who to cut, and in what order.
   */
  it('carries no prices in a league that does not bid', () => {
    const plan = planFor({ budget: budgetState(60, false) });
    expect(plan.claims.every((c) => c.bid == null)).toBe(true);
    expect(plan.claims.every((c) => !c.headline.includes('$'))).toBe(true);
    expect(plan.budget).toContain('does not bid for waivers');
  });

  /** A player on an injured-reserve slot is not a bench spot to spend. */
  it('honours the reserve slots it is given', () => {
    const plan = planFor({ reserveIds: ['benchRb'] });
    expect(plan.claims.every((c) => c.dropPlayerId !== 'benchRb')).toBe(true);
    expect(plan.protectedPlayers.join(' ')).toContain('injured-reserve slot');
  });
});

describe('the plan a reader is handed', () => {
  /**
   * A → C, B → C, B → D, in that order, said as instructions.
   *
   * The structure the whole feature exists for. Read as a list it claims one
   * player twice and one drop twice; read as a machine it is exactly right,
   * because Sleeper runs claims in order and a claim whose drop is already gone
   * does not execute.
   */
  it('says add, bid and drop on one line, in the order to enter them', () => {
    expect(planFor().claims.map((c) => `${c.rank}. ${c.headline}`)).toEqual([
      '1. Add Breakout Back · $24 · Drop Depth Back',
      '2. Add Emerging Receiver · $14 · Drop Depth Back',
      '3. Add Emerging Receiver · $14 · Drop Roster Filler',
      '4. Add Streaming Tight End · $4 · Drop Backup Tight End',
    ]);
  });

  /**
   * The repeated lines read as contingencies, not as duplicates.
   *
   * This is the one thing that cannot live behind **See Why**: a reader who
   * cannot see why the same receiver appears twice will delete one of the two
   * lines, and which one they delete decides whether they land him.
   */
  it('says why a repeated line is deliberate', () => {
    expect(planFor().claims.map((c) => c.qualifier)).toEqual([
      null,
      'Only if 1 loses',
      'Only if 2 does not land him',
      null,
    ]);
  });

  it('tells the reader the numbering is the instruction', () => {
    expect(planFor().note).toContain('Sleeper runs claims top to bottom');
  });

  /**
   * §9 of the brief: which claims still execute after an earlier success, and
   * which cannot.
   */
  it('explains what happens to each claim if an earlier one lands', () => {
    const claims = planFor().claims;
    expect(claims[1]!.why.join(' ')).toContain('Claim 1 spends Depth Back');
    expect(claims[1]!.why.join(' ')).toContain('cannot run at all');
    expect(claims[2]!.why.join(' ')).toContain('only comes up if that claim does not run');
    expect(claims[3]!.why.join(' ')).toContain('runs whether or not the claims above it land');
  });

  it('lays the branches out as reachable worlds and never as odds', () => {
    const plan = planFor();
    expect(plan.outcomes[0]).toContain('Best case');
    expect(plan.outcomes[plan.outcomes.length - 1]).toContain('nothing on your roster changes');
    for (const line of plan.outcomes) {
      expect(line, 'a branch is a contingency, never a probability').not.toMatch(/\d+\s*%|chance|likely to win|odds/);
    }
  });

  /** Why the add, why that cut, what it gains, and what Sunday does with it. */
  it('argues each claim in plain English', () => {
    const why = planFor().claims[0]!.why;
    expect(why[0]).toBe('Breakout Back starts for you this week.');
    expect(why[1]).toContain('Depth Back is not in your lineup');
    expect(why.join(' ')).toContain('better for the swap');
    expect(why.join(' ')).toContain('Your starting lineup gains');
  });

  /**
   * No reason code reaches a reader, on any surface.
   *
   * The planner's vocabulary is a closed list of machine tokens and this is the
   * only layer allowed to translate them. A code leaking through is the failure
   * this whole file exists to catch, so it is checked over every string the view
   * carries rather than over the ones a wording change happened to touch.
   */
  it('never prints a reason code', () => {
    const plan = planFor();
    const everything = JSON.stringify(plan);
    for (const code of [
      'add_enters_lineup',
      'drop_covered_by_add',
      'protected_in_lineup',
      'blocked_by_earlier_claim',
      'bid_reused_from_pricing',
      'net_gain_below_bar',
      'budget_caps_simultaneous_claims',
    ]) {
      expect(everything, `the code "${code}" reached a reader`).not.toContain(code);
    }
  });

  /**
   * The word this feature may never use.
   *
   * The plan is the best structure a bounded search can see over a wire nobody
   * chose, which is a useful thing and not an optimum. Calling it one is the
   * cheapest available way to overstate what the app knows.
   */
  it('never claims to be optimal', () => {
    expect(JSON.stringify(planFor()).toLowerCase()).not.toContain('optimal');
  });
});

describe('the drop half', () => {
  /**
   * The preferred cut moves with the incoming player.
   *
   * The claim the whole planner rests on, asserted at the seam because this is
   * where a reader meets it: the same roster names a different cut for a tight
   * end than for a running back, and no rule anywhere says so.
   */
  it('names a different cut for a different add', () => {
    const hints = new Map(planFor().dropHints.map((h) => [h.addPlayerId, h.dropName]));
    expect(hints.get('wireTe')).toBe('Backup Tight End');
    expect(hints.get('wireRb')).toBe('Depth Back');
    expect(hints.get('wireTe')).not.toBe(hints.get('wireRb'));
  });

  /**
   * The sheet and the plan can never name two cuts for one add.
   *
   * They are ordered on different things — the plan on the net gain over the
   * pair, the ranking on the cost of the cut alone — and they legitimately
   * disagree. A target the plan has spoken about is named by its claim.
   */
  it('agrees with the plan wherever the plan made a claim', () => {
    const plan = planFor();
    const hints = new Map(plan.dropHints.map((h) => [h.addPlayerId, h.dropName]));
    for (const claim of plan.claims) {
      const first = plan.claims.find((c) => c.addPlayerId === claim.addPlayerId);
      if (first !== claim) continue;
      expect(hints.get(claim.addPlayerId)).toBe(claim.dropName);
    }
  });

  /** A starter is never offered as an ordinary cut, and the sheet says why. */
  it('refuses to cut the lineup, and says so rather than ranking it last', () => {
    const plan = planFor();
    const starters = ['rb1', 'rb2', 'wr1', 'wr2', 'te1', 'qb1', 'rb3'];
    for (const claim of plan.claims) expect(starters).not.toContain(claim.dropPlayerId);
    expect(plan.protectedPlayers[0]).toContain('Starting for you');
    expect(plan.protectedPlayers[0]).toContain('Feature Back');
  });

  /**
   * A roster with nothing spare says so, and says the honest thing about it.
   *
   * Seven players for seven slots and a wire with nothing on it: every cut is a
   * starter, so there is no claim to make. It is a different fact from a quiet
   * week and it earns its own line — a trade or a bye frees a spot, and a better
   * waiver target does not.
   */
  it('names the no-safe-drop ending rather than showing a blank', () => {
    /* Seven players for seven starting slots: every cut is a starter. */
    const noBench = roster().slice(0, 7);
    const plan = planFor({
      roster: noBench,
      candidates: thinWire(),
      advice: adviceFor(thinWire()),
      budget: budgetState(null, false),
    });
    expect(plan.claims).toEqual([]);
    expect(plan.state).toBe('no_safe_drop');
    expect(plan.headline).toBe('No safe drop for this upgrade');
    expect(plan.surface).toBe(true);
    expect(plan.note).toContain('A trade or a bye week frees a spot');
  });

  /**
   * A quiet week does not surface at all.
   *
   * The board underneath already reads `Nothing available beats what you already
   * have`, and a card above it saying `No waiver move recommended` is the same
   * claim twice on one screen.
   */
  it('stays off the screen when the board is already saying it', () => {
    /* A full roster and a wire with nobody on it worth a bench spot. */
    const deadWire = [at('deadWr', 'Wire Nobody', 'WR', 0.2), at('deadRb', 'Wire Nobody Else', 'RB', 0.1)];
    const plan = planFor({ candidates: deadWire, advice: adviceFor(deadWire), budget: budgetState(null, false) });
    expect(plan.claims).toEqual([]);
    expect(plan.state).toBe('no_move');
    expect(plan.surface).toBe(false);
  });

  /**
   * §20: a roster nothing can be scored on keeps its adds and loses its cuts.
   *
   * The failure this guards against is the worst available to the feature — a
   * model that reads missing data as zero makes the player it understands least
   * the first name on every cut list.
   */
  it('keeps the adds and withholds the cut when the roster cannot be read', () => {
    const blind = roster().map((p) => at(p.player.id, p.player.fullName, p.player.position, null));
    const plan = planFor({ roster: blind });

    expect(plan.state).toBe('drop_unknown');
    expect(plan.claims.length).toBeGreaterThan(0);
    expect(plan.claims.every((c) => c.dropName == null)).toBe(true);
    /* And never the words that would read as "no cut is needed". */
    expect(plan.claims.every((c) => !c.headline.includes('No drop needed'))).toBe(true);
    expect(plan.note).toContain('leaves the cut to you');
    expect(plan.claims[0]!.bid).toBe(PRICES.wireRb.recommended);
  });
});

describe('two adds, or one', () => {
  /**
   * A substitute is not chased with a second cut.
   *
   * `holeRoster` starts nobody at tight end, so filling the slot is worth far
   * more than anything else available — and once it is filled, a second tight
   * end is worth a fraction of what he was worth alone. Nothing labels the two
   * as substitutes; the planner acquires the first and re-runs the roster
   * utility, and the sentence follows from the division.
   */
  it('says when a second target has stopped being worth a cut', () => {
    const wireTes = [at('teA', 'Good Tight End', 'TE', 9), at('teB', 'Poor Tight End', 'TE', 2)];
    const plan = planFor({
      roster: holeRoster(),
      candidates: wireTes,
      advice: adviceFor(wireTes),
      budget: budgetState(null, false),
    });

    /* One of them is acquired; the other is never a second acquisition. */
    const acquisitions = plan.claims.filter((c) => c.relation !== 'fallback').map((c) => c.addPlayerId);
    expect(acquisitions).toEqual(['teA']);
    expect(plan.relationships.join(' ')).toMatch(/worth a second cut|much less worth chasing/);
    expect(plan.relationships.join(' ')).toContain('Poor Tight End');
  });

  /**
   * And when two adds genuinely are worth two cuts, the plan holds both.
   *
   * The settled roster with the full wire: the back and the receiver improve
   * different things, and both survive to the claim list on the spine rather
   * than one being demoted to a contingency for the other.
   */
  it('keeps a second acquisition when it improves something else', () => {
    const plan = planFor();
    const spine = plan.claims.filter((c) => c.relation !== 'fallback');
    expect(new Set(spine.map((c) => c.addPlayerId)).size).toBeGreaterThan(1);
    expect(spine.map((c) => c.dropPlayerId)).toEqual([...new Set(spine.map((c) => c.dropPlayerId))]);
  });
});

describe('the defence boundary', () => {
  /**
   * A defence on the wire is not a generic target and a defence on the roster is
   * not a generic cut.
   *
   * The DST planner knows about transaction cost, how long a streamed defence
   * survives and what a playoff stash is worth, and none of that is in the claim
   * planner. Two surfaces recommending different things about the same DEF slot
   * on one screen is the failure this boundary exists to prevent — so the
   * defence is excluded from the plan, and the **See Why** sheet says which lane
   * owns it rather than filing it under "worth too much to cut".
   */
  it('never claims a defence and never cuts one', () => {
    /*
     * Asserted in the league where the boundary is actually at risk: one that
     * starts a defence, publishes rules this app can read, and therefore holds a
     * defence with a real score. An unscorable one would be excluded for the
     * wrong reason and would prove nothing.
     */
    const dstShape = buildRosterShape(DST_ROSTER_POSITIONS);
    const dstProfile = buildScoringProfile(DST_SCORING as Record<string, number>, DST_ROSTER_POSITIONS);
    const held = defence('def1', 'Held Defence', { spread: -6, total: 41, opponent: 'ARI' }, { kickoff: KICKOFF, now: NOW });
    const onTheWire = defence('def2', 'Wire Defence', { spread: -9, total: 38, opponent: 'CAR' }, { kickoff: KICKOFF, now: NOW });

    const dstRoster = [
      at('qb1', 'Anchor Quarterback', 'QB', 18),
      at('rb1', 'Feature Back', 'RB', 14),
      at('rb2', 'Second Back', 'RB', 11),
      at('wr1', 'Alpha Receiver', 'WR', 13),
      at('wr2', 'Second Receiver', 'WR', 10),
      at('wr3', 'Third Receiver', 'WR', 8),
      at('te1', 'Starting Tight End', 'TE', 9),
      at('benchWr', 'Roster Filler', 'WR', 1.5),
      held,
    ];
    const dstWire = [...wire(), onTheWire];

    const plan = planFor({
      roster: dstRoster,
      candidates: dstWire,
      advice: adviceFor(dstWire, PRICES),
      shape: dstShape,
      profile: dstProfile,
    });

    expect(plan.claims.length).toBeGreaterThan(0);
    expect(plan.claims.every((c) => c.addPosition !== DEFENCE_POSITION)).toBe(true);
    expect(plan.claims.every((c) => c.dropPlayerId !== 'def1')).toBe(true);
    expect(plan.protectedPlayers.join(' ')).toContain('belongs to the defence plan');
    expect(plan.protectedPlayers.join(' ')).toContain('Held Defence');
  });
});

describe('degenerate inputs', () => {
  /** No roster is not a plan, and it is not a crash either. */
  it('says nothing at all when there is no roster', () => {
    const plan = planFor({ roster: [] });
    expect(plan.surface).toBe(false);
    expect(plan.state).toBe('no_targets');
  });

  it('says nothing at all when the wire is empty', () => {
    const plan = planFor({ candidates: [], advice: adviceFor([]) });
    expect(plan.surface).toBe(false);
    expect(plan.claims).toEqual([]);
  });

  /** A plan the caller could not compute is not the same as no move. */
  it('reads a missing plan as no plan rather than as no move', () => {
    const view = describeWaiverPlan(null);
    expect(view.surface).toBe(false);
    expect(view.claims).toEqual([]);
  });

  /**
   * The budget trim is said out loud, and no bid is lowered to make it fit.
   *
   * A bid is the pricing pass's answer about what a player is worth; lowering
   * one so a plan fits would be this layer quietly disagreeing with it, and the
   * difference between the two figures would be a fact about claim ordering
   * rather than about football.
   */
  it('says which acquisition the wallet cost, and leaves the bids alone', () => {
    const plan = planFor({ budget: budgetState(25) });
    expect(plan.budget).toContain('gave up');
    expect(plan.budget).toContain('No bid was lowered');
    const rb = plan.claims.find((c) => c.addPlayerId === 'wireRb');
    expect(rb?.bid).toBe(PRICES.wireRb.recommended);
  });
});

describe('determinism', () => {
  /**
   * The same inputs produce the same plan, byte for byte.
   *
   * Which is what lets a future Demo Mode refresh stage the A → C, B → C, B → D
   * scenario and have it read the same way every time somebody opens it.
   */
  it('produces the same plan twice', () => {
    expect(JSON.stringify(planFor())).toBe(JSON.stringify(planFor()));
  });

  /** And the seam adds nothing the planner did not already decide. */
  it('changes none of the planner’s own answers', () => {
    const direct = planWaiverClaims({
      roster: roster(),
      targets: wire().map((input, index) => ({
        input,
        boardRank: index + 1,
        bid: (PRICES as Record<string, { recommended: number; doNotExceed: number; headline: string }>)[input.player.id]
          ? {
              playerId: input.player.id,
              ...(PRICES as Record<string, { recommended: number; doNotExceed: number; headline: string }>)[
                input.player.id
              ]!,
            }
          : null,
      })),
      shape: SHAPE,
      profile: HALF_PPR,
      budget: { remaining: 60, usesFaab: true },
      now: NOW,
      generatedAt: '2025-10-05T14:00:00.000Z',
    });

    expect(planFor().claims.map((c) => [c.addPlayerId, c.dropPlayerId, c.bid])).toEqual(
      direct.claims.map((c) => [c.addPlayerId, c.dropPlayerId, c.bid]),
    );
  });
});
