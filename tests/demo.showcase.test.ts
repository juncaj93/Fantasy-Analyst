/**
 * The launch showcase, asserted.
 *
 * `demo.scenarios.test.ts` proves every scenario reaches its production surface
 * and that the numbers on it were computed rather than stated. This file is
 * narrower and more specific: it is the set of things the demo has to be able
 * to *show* — the waiver contingency, the defence decision, the one lineup
 * change worth making, a real trade offer, a focused player — because those are
 * the demonstrations the demo exists for, and a fixture drifts out from under a
 * demonstration far more quietly than it breaks an engine.
 *
 * Every assertion below is about something an engine concluded. Where a number
 * appears it is a *relationship* between numbers on the same response — a bid
 * against a wallet, a claim against a drop — rather than a value, because a
 * value asserted here is a fixture restated and it would pass with the engine
 * removed.
 */

import { describe, expect, it } from 'vitest';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { DEMO_LEAGUE_ID, DEMO_ROSTER_POSITIONS } from '../src/core/demo/fixtures/world.ts';
import { playerHeadshotUrl } from '../src/core/players/headshot.ts';

const LEAGUE = `/api/leagues/${DEMO_LEAGUE_ID}`;

async function runtimeFor(id: string): Promise<DemoRuntime> {
  const scenario = findScenario(id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  return DemoRuntime.forScenario(scenario);
}

async function get<T>(id: string, path: string): Promise<T> {
  const runtime = await runtimeFor(id);
  const res = await runtime.request('GET', path);
  expect(res.status, `${id} ${path}`).toBe(200);
  return res.body as T;
}

interface ClaimLine {
  rank: number;
  addPlayerId: string;
  addName: string;
  dropPlayerId: string | null;
  dropName: string | null;
  bid: number | null;
  headline: string;
  qualifier: string | null;
  relation: string;
  why: string[];
}

interface WaiverBody {
  found: boolean;
  upgrades: {
    slot: string;
    accepts: string[];
    candidates: { playerId: string; name: string; position: string; score: number | null }[];
  }[];
  claimPlan: {
    surface: boolean;
    state: string;
    headline: string;
    instruction: string | null;
    mechanics: string | null;
    claims: ClaimLine[];
    outcomes: string[];
    budget: string | null;
  } | null;
  dst: {
    surface: boolean;
    decision: string;
    headline: string;
    why: string[];
    current: { team: string; playerId: string } | null;
    target: { team: string; playerId: string } | null;
    cost: { needsDrop: boolean; dropCandidate: { position: string } | null } | null;
  } | null;
  faab: { mine: { remaining: number | null } | null; bids: { playerId: string; recommended: number | null }[] } | null;
}

describe('the waiver showcase runs the real claim planner', () => {
  it('produces an ordered multi-claim contingency, not a list of adds', async () => {
    const body = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);
    const plan = body.claimPlan!;

    expect(plan.surface).toBe(true);
    expect(plan.state).toBe('plan');
    /* Three claims over two players: the shape §5 asks Demo Mode to show. */
    expect(plan.claims.length).toBeGreaterThanOrEqual(3);
    expect(new Set(plan.claims.map((c) => c.addPlayerId)).size).toBeLessThan(plan.claims.length);

    const [first, second, third] = plan.claims;
    expect(first!.rank).toBe(1);
    expect(first!.qualifier, 'the preferred claim carries no qualifier').toBeNull();

    /*
     * The second claim is the fallback: the same drop as the first, so it can
     * only run in the world where the first one lost — which is exactly what
     * its qualifier has to say, or the list reads as a duplicate.
     */
    expect(second!.dropPlayerId).toBe(first!.dropPlayerId);
    expect(second!.qualifier).toMatch(/only if 1/i);
    expect(second!.relation).toBe('fallback');

    /*
     * The third repeats the second's target on a *different* drop, which is the
     * claim that is still worth entering if the first one lands.
     */
    expect(third!.addPlayerId).toBe(second!.addPlayerId);
    expect(third!.dropPlayerId).not.toBe(second!.dropPlayerId);
    expect(third!.qualifier).toMatch(/only if 2/i);

    /* And the order is the instruction, with the mechanic one tap away. */
    expect(plan.instruction).toBe('Enter in this order');
    expect(plan.mechanics).toBeTruthy();
  });

  it('is internally consistent: every add, bid and drop agrees with the rest of the response', async () => {
    const body = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);
    const plan = body.claimPlan!;
    const board = new Map(body.upgrades.flatMap((u) => u.candidates).map((c) => [c.playerId, c]));
    const bids = new Map((body.faab?.bids ?? []).map((b) => [b.playerId, b]));
    const remaining = body.faab!.mine!.remaining!;

    for (const claim of plan.claims) {
      /* Every add is a player the waiver engine actually put on the board. */
      expect(board.get(claim.addPlayerId), `${claim.addName} is on the board`).toBeTruthy();
      expect(claim.addName).toBe(board.get(claim.addPlayerId)!.name);
      /* Every bid is the pricing pass's own number, not the plan's. */
      expect(claim.bid).toBe(bids.get(claim.addPlayerId)?.recommended ?? null);
      expect(claim.bid!).toBeLessThanOrEqual(remaining);
      /* A drop is a name, and the headline says all three things. */
      expect(claim.dropName).toBeTruthy();
      expect(claim.headline).toContain(claim.addName);
      expect(claim.headline).toContain(`$${claim.bid}`);
      expect(claim.headline).toContain(claim.dropName!);
    }

    /*
     * And the claims that can land together cost what the wallet can cover.
     *
     * The two independent claims are the first and the compatible third; the
     * fallback costs nothing extra because it only runs where the first lost.
     */
    const independent = plan.claims.filter((c) => c.relation !== 'fallback');
    const total = independent.reduce((sum, c) => sum + (c.bid ?? 0), 0);
    expect(total).toBeLessThanOrEqual(remaining);
    expect(plan.budget).toContain(`$${total}`);
  });

  it('See why goes deeper than the line it explains', async () => {
    const body = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);
    for (const claim of body.claimPlan!.claims) {
      /* Several sentences, none of them the headline repeated. */
      expect(claim.why.length).toBeGreaterThan(3);
      expect(claim.why).not.toContain(claim.headline);
      /* Including what the swap is worth and what the room will pay. */
      expect(claim.why.join(' ')).toMatch(/pts/);
      expect(claim.why.join(' ')).toMatch(/\$\d+/);
    }
    /* And the whole plan carries the outcomes, in order of preference. */
    expect(body.claimPlan!.outcomes.length).toBeGreaterThan(2);
    expect(body.claimPlan!.outcomes.at(-1)).toMatch(/nothing on your roster changes/i);
  });
});

describe('the defence showcase', () => {
  it('the demo league starts a defence, and the reader has one', async () => {
    expect(DEMO_ROSTER_POSITIONS.filter((slot) => slot === 'DEF')).toHaveLength(1);
    const lineup = await get<{ slots: { slot: string; playerId: string | null }[] }>(
      'sunday-pregame',
      `${LEAGUE}/lineup`,
    );
    const def = lineup.slots.find((s) => s.slot === 'DEF');
    expect(def, 'the lineup has a DEF slot').toBeTruthy();
    expect(def!.playerId, 'and somebody in it').toBeTruthy();
  });

  it('the planner owns the DEF row, and the generic scan does not offer one', async () => {
    const body = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);

    expect(body.dst, 'a defence plan is on the response').toBeTruthy();
    expect(body.dst!.surface).toBe(true);
    /*
     * Whatever it decides, no generic waiver upgrade may be a defence: two
     * answers to one question on one screen is the failure this filter exists
     * to prevent.
     */
    for (const upgrade of body.upgrades) {
      expect(upgrade.accepts.every((p) => p === 'DEF')).toBe(false);
      for (const candidate of upgrade.candidates) expect(candidate.position).not.toBe('DEF');
    }
    /* And no claim in the plan cuts the defence to make room for a skill player. */
    for (const claim of body.claimPlan!.claims) expect(claim.dropPlayerId).not.toMatch(/^d\d/);
  });

  it('streams on the week the schedule turns, and holds on the week it does not', async () => {
    const tuesday = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);
    expect(tuesday.dst!.decision).toBe('stream');
    expect(tuesday.dst!.target, 'a defence to stream to').toBeTruthy();
    expect(tuesday.dst!.headline).toContain(tuesday.dst!.target!.team);
    expect(tuesday.dst!.headline).toContain(tuesday.dst!.current!.team);
    /* The reason names the bar it cleared rather than asserting a verdict. */
    expect(tuesday.dst!.why.join(' ')).toMatch(/pts better than .* this week/);
    /* A defence is never its own drop candidate. */
    expect(tuesday.dst!.cost?.dropCandidate?.position).not.toBe('DEF');

    const sunday = await get<WaiverBody>('sunday-pregame', `${LEAGUE}/waivers`);
    expect(sunday.dst!.decision).toBe('hold');
    expect(sunday.dst!.target).toBeFalsy();
    expect(sunday.dst!.why.join(' ')).toMatch(/does not clear/);
  });
});

interface MatchupBody {
  found: boolean;
  forecast: {
    phase: string;
    degraded: boolean;
    slots: { slot: string }[];
    decision: {
      best: {
        slot: string;
        outPlayerId: string;
        inPlayerId: string;
        winNow: number;
        winAfter: number;
        gain: number;
        reason: string;
      } | null;
    };
  } | null;
}

describe('the matchup showcase', () => {
  it('offers one legal, unlocked, material move — and prices it in win probability', async () => {
    const body = await get<MatchupBody>('matchup-injury-swing', `${LEAGUE}/matchup`);
    const best = body.forecast!.decision.best;
    expect(best, 'a best move').toBeTruthy();

    /* Materiality is the model's threshold, not this test's opinion. */
    expect(best!.gain).toBeGreaterThan(0.02);
    expect(best!.winAfter).toBeGreaterThan(best!.winNow);
    expect(best!.reason.length).toBeGreaterThan(0);

    /* The player leaving the lineup is the one the report ruled out. */
    const cards = await get<{ cards: Record<string, { headline: { verdict: string; detail: string } }> }>(
      'matchup-injury-swing',
      `${LEAGUE}/matchup`,
    );
    const card = cards.cards[best!.outPlayerId];
    expect(card?.headline.verdict).toBe('not_playable');
    expect(card?.headline.detail).toMatch(/out/i);
  });

  it('and says hold when there is nothing worth doing', async () => {
    /*
     * The no-change path, on a scenario read before anything has kicked off —
     * which is when a lineup change is worth the most and therefore the
     * strongest place to demonstrate that the answer can still be "nothing".
     */
    const body = await get<MatchupBody>('sunday-pregame', `${LEAGUE}/matchup`);
    expect(body.found).toBe(true);
    expect(body.forecast!.phase).toBe('pregame');
    expect(body.forecast!.degraded).toBe(false);
    expect(body.forecast!.decision.best, 'nothing clears the bar').toBeNull();
  });

  it('prices both defences, because the league starts one', async () => {
    const body = await get<MatchupBody>('matchup-live-close', `${LEAGUE}/matchup`);
    expect(body.forecast!.slots.map((s) => s.slot)).toContain('DEF');
    expect(body.forecast!.slots).toHaveLength(DEMO_ROSTER_POSITIONS.filter((s) => s !== 'BN' && s !== 'IR').length);
  });
});

interface SmartTradesBody {
  found: boolean;
  offers: {
    partner: { displayName: string; userId: string | null };
    give: { playerId: string; name: string; position: string }[];
    get: { playerId: string; name: string; position: string }[];
    fairness: { label: string };
    headline: string;
    reasons: string[];
    managerFit: { label: string; evidence: { sample: number; seasonsObserved: number } } | null;
  }[];
  history: { profiles: number; seasonsComplete: string[]; complete: boolean };
}

describe('the trade showcase', () => {
  it('leads with a real bilateral offer, from the real engine', async () => {
    const body = await get<SmartTradesBody>('trade-window', '/api/trades/smart');
    expect(body.found).toBe(true);
    expect(body.offers.length).toBeGreaterThan(0);

    const offer = body.offers[0]!;
    expect(offer.give.length).toBeGreaterThan(0);
    expect(offer.get.length).toBeGreaterThan(0);
    expect(offer.partner.displayName.length).toBeGreaterThan(0);
    expect(offer.fairness.label.length).toBeGreaterThan(0);
    /* A sentence about what it does for the reader, and one for the partner. */
    expect(offer.headline.length).toBeGreaterThan(0);
    expect(offer.reasons.length).toBeGreaterThan(1);
    /* Nothing anywhere is a probability of acceptance. */
    expect(JSON.stringify(offer)).not.toMatch(/acceptanceProbability|likelyToAccept/);
  });

  it('carries the partner’s own record, read from the league ledger', async () => {
    const body = await get<SmartTradesBody>('trade-window', '/api/trades/smart');
    expect(body.history.complete).toBe(true);
    expect(body.history.profiles).toBeGreaterThan(0);
    expect(body.history.seasonsComplete.length).toBeGreaterThan(1);

    const fit = body.offers[0]!.managerFit;
    expect(fit, 'the surfaced offer says what is known about the partner').toBeTruthy();
    expect(fit!.evidence.sample).toBeGreaterThan(0);
    expect(fit!.evidence.seasonsObserved).toBeGreaterThan(0);
    expect(fit!.label.length).toBeGreaterThan(0);
  });

  it('keeps the market inventory separate from the offers', async () => {
    const market = await get<{ suggestions: unknown[]; sections: unknown }>('trade-window', '/api/trades');
    /* The wider board still exists — it is what `Explore the market` opens. */
    expect(market.suggestions.length).toBeGreaterThan(10);
  });

  /**
   * And what the player an offer is chasing would actually cost.
   *
   * The ladder is a second request behind a fold on the offer's own sheet, and
   * Demo Mode answers it through the same two functions the deployment calls —
   * four lineup passes and then `buildLadder`. What is asserted is the
   * relationship the engine guarantees, not a figure: a fixture restated is a
   * test that passes with the engine removed.
   */
  it('prices the player an offer is chasing, through the real ladder', async () => {
    const board = await get<SmartTradesBody>('trade-window', '/api/trades/smart');
    const target = board.offers[0]!.get[0]!;
    const body = await get<LadderBody>('trade-window', `${LEAGUE}/trades/ladder?playerId=${target.playerId}`);

    expect(body.found).toBe(true);
    expect(body.target.playerId).toBe(target.playerId);
    expect(body.partner.rosterId).toBeGreaterThan(0);
    expect(body.ladder.advisory).toBe('never auto-sent');
    if (!body.ladder.blocked) {
      expect(body.ladder.opening).toBeLessThanOrEqual(body.ladder.fair.low);
      expect(body.ladder.fair.low).toBeLessThanOrEqual(body.ladder.fair.high);
      expect(body.ladder.fair.high).toBeLessThanOrEqual(body.ladder.doNotExceed);
    }
  });

  /**
   * And it claims nothing about the partner it cannot back.
   *
   * `profile` here is the *roster-keyed cached profile* a nightly backfill
   * writes; a demo runs no backfill and stores nothing, so it is null — the same
   * answer, for the same reason, that `/api/leagues/:id/managers` already gives.
   * The card above it prints the manager's name and says the sample is missing,
   * rather than describing a manager nobody has measured.
   */
  it('offers no cached tendency for a manager no backfill has read', async () => {
    const board = await get<SmartTradesBody>('trade-window', '/api/trades/smart');
    const target = board.offers[0]!.get[0]!;
    const body = await get<LadderBody>('trade-window', `${LEAGUE}/trades/ladder?playerId=${target.playerId}`);
    expect(body.partner.profile).toBeNull();
  });

  /** A player nobody rosters is an add, and saying so beats a 404. */
  it('calls an unrostered player an add rather than failing the request', async () => {
    const body = await get<LadderBody>('trade-window', `${LEAGUE}/trades/ladder?playerId=nobody-holds-him`);
    expect(body.found).toBe(false);
    expect(body.reason).toContain('an add, not a trade');
  });
});

interface LadderBody {
  found: boolean;
  reason?: string;
  partner: { rosterId: number; ownerName: string | null; profile: unknown };
  target: { playerId: string; name: string };
  ladder: {
    opening: number;
    fair: { low: number; high: number };
    doNotExceed: number;
    blocked: string | null;
    advisory: string;
  };
}

describe('the player showcase', () => {
  it('asks for no portrait anywhere in a demo, and falls back deterministically', async () => {
    const list = await get<{ players: { id: string; position: string }[] }>(
      'sunday-pregame',
      '/api/players?limit=40',
    );
    /*
     * A fixture id is not a Sleeper id, so no portrait exists to request — the
     * dense rows and the focused view alike draw initials. That is the whole of
     * Demo Mode's independence from `sleepercdn`: not a blocked request, but a
     * request that is never made.
     */
    for (const player of list.players) {
      expect(playerHeadshotUrl(player.id, player.position)).toBeNull();
    }
    /* And a defence never has one, whatever its id looks like. */
    expect(playerHeadshotUrl('4046', 'DEF')).toBeNull();
    /* The rule is about the id, not about Demo Mode: a real one still resolves. */
    expect(playerHeadshotUrl('4046', 'RB')).toContain('4046.jpg');
  });

  it('shows a tally that moves a ranking, in both directions, and a real designation', async () => {
    const list = await get<{
      players: { id: string; name: string; status: string | null; draftRank: number | null; adjustedRank: number | null }[];
    }>('sunday-pregame', '/api/players?limit=20');

    const moved = list.players.filter((p) => p.draftRank != null && p.adjustedRank != null && p.draftRank !== p.adjustedRank);
    expect(moved.some((p) => p.adjustedRank! < p.draftRank!), 'somebody moves up').toBe(true);
    expect(moved.some((p) => p.adjustedRank! > p.draftRank!), 'somebody moves down').toBe(true);
    expect(list.players.some((p) => p.status), 'a status is on the list').toBe(true);

    const detail = await get<{ injury: { line: string; practice: string | null; provenance: string } | null }>(
      'sunday-pregame',
      '/api/players/p016/detail',
    );
    expect(detail.injury, 'the focused view carries the designation').toBeTruthy();
    expect(detail.injury!.practice, 'and the practice week behind it').toBeTruthy();
  });
});

describe('the draft showcase keeps its columns', () => {
  it('every row can print DOG and PTS', async () => {
    const board = await get<{
      recommendations: { name: string; position: string; adp: number | null; dogAdp: number | null; preseasonPoints: number | null }[];
      dogState: { freshness: string; available: boolean } | null;
    }>('draft-mid', '/api/drafts/demo-draft-2026/board?limit=20');

    expect(board.recommendations.length).toBeGreaterThan(5);
    /* DOG is a second market and it is lit. */
    expect(board.dogState?.available).toBe(true);
    expect(board.dogState?.freshness).toBe('fresh');
    expect(board.recommendations.some((r) => r.dogAdp != null)).toBe(true);
    /* PTS comes from a pasted projection, and the column has coverage. */
    const withPoints = board.recommendations.filter((r) => r.preseasonPoints != null);
    expect(withPoints.length).toBeGreaterThan(board.recommendations.length / 2);

    /*
     * And the projection is not the market wearing a different hat: at least
     * one player is projected well away from where he is being drafted.
     */
    const ordered = [...withPoints].sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
    const byPoints = [...withPoints].sort((a, b) => (b.preseasonPoints ?? 0) - (a.preseasonPoints ?? 0));
    expect(ordered.map((r) => r.name)).not.toEqual(byPoints.map((r) => r.name));
  });

  it('the defence slot reaches the draft, and is not urged early', async () => {
    const board = await get<{
      openStarters: { slot: string }[];
      rosterAlerts: { message: string; positions?: string[] }[];
    }>('draft-mid', '/api/drafts/demo-draft-2026/board?limit=10');

    expect(board.openStarters.map((s) => s.slot)).toContain('DEF');
    /* Round six is not when a defence is taken, and no alert says otherwise. */
    for (const alert of board.rosterAlerts) expect(alert.positions ?? []).not.toContain('DEF');
  });
});

describe('the season the demo shows is one season', () => {
  it('the plan on Tuesday is the claim that landed on Wednesday', async () => {
    const tuesday = await get<WaiverBody>('waivers-tuesday-active', `${LEAGUE}/waivers`);
    const claim = tuesday.claimPlan!.claims[0]!;
    const before = tuesday.faab!.mine!.remaining!;

    const roster = await get<{ bench: { playerId: string; name: string }[] }>(
      'waivers-processed',
      `${LEAGUE}/roster`,
    );
    const after = await get<WaiverBody>('waivers-processed', `${LEAGUE}/waivers`);

    /* The player the plan named is on the roster the morning after. */
    expect(roster.bench.map((p) => p.playerId)).toContain(claim.addPlayerId);
    /* The player it named as the cut is not. */
    expect(roster.bench.map((p) => p.playerId)).not.toContain(claim.dropPlayerId);
    /* And the wallet moved by exactly what the plan said it would cost. */
    expect(after.faab!.mine!.remaining!).toBe(before - claim.bid!);
  });
});
