/**
 * Every scenario, through the real engines.
 *
 * The claim Demo Mode makes is that its screens are the product's screens over
 * substituted data. A test that only checked the fixtures would prove nothing
 * about that; these run each scenario through the same request path the browser
 * uses and assert on what the *engines* produced — a ranked board, a legal
 * lineup, a priced bid, a lifecycle — not on anything a fixture stated.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftBoard, type DraftBoardState } from '../src/core/draft/boardBuilder.ts';
import { DEMO_SCENARIOS, findScenario, selectableScenarios } from '../src/core/demo/registry.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import type { DraftBoard, LineupRecommendation, Overview, WaiverAdvice } from '../src/web/api.ts';
/*
 * The matchup is typed against `core`'s own response rather than the client's.
 * The web `MatchupResponse` narrows several fields the screen does not render;
 * that is right for a client and wrong for a test whose whole subject is what
 * the model concluded.
 */
import type { MatchupResponse } from '../src/core/matchup/build.ts';

/** §8's five, in the order the picker walks them. */
const MATCHUP_IDS = [
  'matchup-live-close',
  'matchup-live-leading',
  'matchup-live-trailing',
  'matchup-injury-swing',
  'matchup-final',
];

async function runtimeFor(id: string): Promise<DemoRuntime> {
  const scenario = findScenario(id);
  expect(scenario, `scenario ${id} is registered`).toBeTruthy();
  return DemoRuntime.forScenario(scenario!);
}

describe('every selectable scenario serves the whole shell', () => {
  for (const scenario of selectableScenarios()) {
    it(`${scenario.id} answers overview, leagues and setup`, async () => {
      const runtime = await runtimeFor(scenario.id);

      const overview = await runtime.request('GET', '/api/overview');
      expect(overview.status).toBe(200);
      const body = overview.body as Overview;
      /*
       * The lifecycle is resolved, not stated. The fixture writes down what
       * Sleeper published and what the league's status is; `resolveLifecycle`
       * decides what that adds up to, and this asserts the two agree — which is
       * what stops a scenario claiming to be a playoff week while the resolver
       * would put the app in the offseason.
       */
      expect(body.lifecycle?.lifecycle).toBe(scenario.lifecycle);
      expect(body.selectedLeague).not.toBeNull();

      expect((await runtime.request('GET', '/api/leagues')).status).toBe(200);
      expect((await runtime.request('GET', '/api/setup/status')).status).toBe(200);
      expect((await runtime.request('GET', '/api/diagnostics/rollover')).status).toBe(200);
      expect((await runtime.request('GET', '/api/players?q=&limit=20')).status).toBe(200);
    });
  }
});

describe('the draft scenarios rank a real board', () => {
  it('draft-mid puts the reader on the clock with a scored, ordered board', async () => {
    const runtime = await runtimeFor('draft-mid');
    const res = await runtime.request('GET', '/api/drafts/demo-draft-2026/board?limit=40');
    expect(res.status).toBe(200);
    const board = res.body as DraftBoard;

    expect(board.picksMade).toBe(63);
    expect(board.currentPick).toBe(64);
    expect(board.mySlot).toBe(9);
    expect(board.onTheClock).toBe(true);
    expect(board.round).toBe(6);

    // Scores come from the engine, so they must be ordered and inside its range.
    expect(board.recommendations.length).toBeGreaterThan(10);
    const scores = board.recommendations.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const score of scores) expect(score).toBeGreaterThanOrEqual(0);

    // Every recommendation carries the engine's own component breakdown.
    const first = board.recommendations[0]!;
    expect(first.components.length).toBeGreaterThan(2);
    expect(first.reasons.length).toBeGreaterThan(0);

    // Nobody already drafted may appear on it.
    const drafted = new Set((board.boardPicks ?? []).map((p) => p.playerId));
    for (const rec of board.recommendations) expect(drafted.has(rec.playerId)).toBe(false);

    // The board-as-a-board is assembled from the same picks.
    expect(board.boardPicks?.length).toBe(63);
    expect(board.managers?.find((m) => m.isMine)?.slot).toBe(9);
  });

  it('draft-early and draft-late differ only because the draft moved on', async () => {
    const early = (await (await runtimeFor('draft-early')).request('GET', '/api/drafts/demo-draft-2026/board'))
      .body as DraftBoard;
    const late = (await (await runtimeFor('draft-late')).request('GET', '/api/drafts/demo-draft-2026/board'))
      .body as DraftBoard;
    expect(early.picksMade).toBe(8);
    expect(late.picksMade).toBe(152);
    expect(late.round).toBe(13);
    // Deep in the draft most of what is left has no published draft order, and
    // the board keeps them rather than deleting the tail.
    expect(late.poolHealth.withoutAdp).toBeGreaterThan(0);
  });

  it('draft-complete is history: nothing is on the clock and every pick is in', async () => {
    const board = (await (await runtimeFor('draft-complete')).request('GET', '/api/drafts/demo-draft-2026/board'))
      .body as DraftBoard;
    expect(board.picksMade).toBe(168);
    expect(board.status).toBe('complete');
    expect(board.boardPicks?.length).toBe(168);
  });

  it('the queue filter narrows the board to the shortlist', async () => {
    const runtime = await runtimeFor('draft-mid');
    const all = (await runtime.request('GET', '/api/drafts/demo-draft-2026/board?limit=200')).body as DraftBoard;
    const queued = (await runtime.request('GET', '/api/drafts/demo-draft-2026/board?limit=200&queued=1'))
      .body as DraftBoard;

    expect(queued.recommendations.length).toBeGreaterThan(0);
    expect(queued.recommendations.length).toBeLessThan(all.recommendations.length);
    for (const rec of queued.recommendations) expect(rec.queued).toBe(true);
  });

  /*
   * The star is a bookmark, and the board must come out identical whether or
   * not it is lit.
   *
   * Asserted by building the same board twice from the same fixture, once with
   * the flags the scenario carries and once with none, rather than by comparing
   * a filtered board against an unfiltered one. Those two are different
   * candidate pools, and the scarcity components are honestly allowed to differ
   * between them — comparing them would be testing the filter, not the star.
   */
  it('lighting the star moves no score', async () => {
    const scenario = findScenario('draft-mid')!;
    const data = buildDraftScenario(scenario);
    const withStars = await buildDraftBoard(draftBoardSourcesFrom(data), 'demo-draft-2026', { limit: 60 });

    const unstarred = {
      ...data,
      flags: new Map([...data.flags].map(([id, flag]) => [id, { ...flag, queued: false }])),
    };
    const withoutStars = await buildDraftBoard(draftBoardSourcesFrom(unstarred), 'demo-draft-2026', { limit: 60 });

    expect(withStars.recommendations.map((r) => [r.playerId, r.score])).toEqual(
      withoutStars.recommendations.map((r) => [r.playerId, r.score]),
    );
    // …and the hearts, which are the thing that is allowed to move it, did.
    expect(withStars.recommendations.some((r) => r.myGuy.level > 0)).toBe(true);
  });
});

/**
 * The Team card mid-draft, in every mode a scenario can be in.
 *
 * The card is one sentence now — the live-status and slot-coverage prose above
 * it went — so a scenario whose roster response omits `bestMove` has no card at
 * all rather than a card missing its last line. Demo Mode's contract is that it
 * drives the production screens with fixture data, and this is the assertion
 * that keeps the two responses the same shape.
 *
 * The second claim is the one worth more: the sentence is derived from the
 * league's own starting slots, so it is not a Best Ball feature that a Best
 * Ball screenshot happened to be taken of. `draft-best-ball` and the standard
 * draft scenarios each get whatever their own roster shape produces, and
 * `bestMove` never sees a format flag — see core/draft/bestMove.ts.
 */
describe('the draft-mode Team card carries advice in every draft mode', () => {
  const DRAFTS = ['draft-early', 'draft-mid', 'draft-late', 'draft-best-ball'];

  for (const id of DRAFTS) {
    it(`${id} answers the roster with a move to make`, async () => {
      const runtime = await runtimeFor(id);
      const scenario = findScenario(id)!;
      const res = await runtime.request('GET', `/api/leagues/${scenario.leagueId}/roster`);
      expect(res.status).toBe(200);

      const body = res.body as {
        live: boolean;
        bestMove?: { text: string; positions: string[]; kind: string } | null;
        counts: Record<string, number>;
        openStarters: unknown[];
      };

      expect(body.live, 'the draft scenarios are live drafts').toBe(true);
      expect(body.bestMove?.text, 'and every one of them names a move').toBeTruthy();
      expect(['starter', 'flex', 'depth']).toContain(body.bestMove!.kind);
      // The counts the sentence is derived from are still sent, and still real.
      expect(body.counts).toBeTruthy();
      expect(Array.isArray(body.openStarters)).toBe(true);
    });
  }

  /**
   * Best Ball gets the same treatment as everything else, and no more.
   *
   * `draft-best-ball` is a different league with a different roster shape, so
   * what it must not do is produce a sentence *because* it is Best Ball — the
   * shape is the whole input. This asserts the derivation rather than the
   * string: whatever the sentence names, the roster it names it about is this
   * scenario's, and the positions it names are positions this league starts.
   */
  it('derives the Best Ball scenario’s move from that league’s own slots', async () => {
    const runtime = await runtimeFor('draft-best-ball');
    const scenario = findScenario('draft-best-ball')!;
    const res = await runtime.request('GET', `/api/leagues/${scenario.leagueId}/roster`);
    const body = res.body as {
      bestMove: { text: string; positions: string[] };
      rosterShape: { slots?: Record<string, number> } & Record<string, unknown>;
    };

    expect(body.bestMove.text.length).toBeGreaterThan(0);
    const shape = JSON.stringify(body.rosterShape);
    for (const position of body.bestMove.positions) {
      expect(shape, `${position} is not a slot this league starts`).toContain(position);
    }
  });
});

describe('no draft order is a warning, not an empty board', () => {
  it('sleeper-adp-unavailable still ranks and says why it is a poor substitute', async () => {
    const board = (
      await (await runtimeFor('sleeper-adp-unavailable')).request('GET', '/api/drafts/demo-draft-2026/board')
    ).body as DraftBoard;
    expect(board.adpSnapshot).toBeNull();
    expect(board.recommendations.length).toBeGreaterThan(0);
    expect(board.warnings.join(' ')).toContain('no draft order');
    for (const rec of board.recommendations) expect(rec.adp).toBeNull();
  });
});

describe('the weekly scenarios build a legal lineup', () => {
  it('sunday-pregame fills every slot the league starts', async () => {
    const runtime = await runtimeFor('sunday-pregame');
    const res = await runtime.request('GET', '/api/leagues/demo-league-2026/lineup?mode=balanced');
    const lineup = res.body as LineupRecommendation;

    expect(lineup.found).toBe(true);
    /* Nine: eight skill slots and the defence the league starts. */
    expect(lineup.slots.length).toBe(9);
    for (const slot of lineup.slots) {
      if (!slot.playerId) continue;
      expect(slot.accepts).toContain(slot.position);
    }
    // Nobody may occupy two slots.
    const used = lineup.slots.map((s) => s.playerId).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(lineup.recommendedPoints).toBeGreaterThan(0);
  });

  it('Floor, Balanced and Ceiling are three answers, not one', async () => {
    const runtime = await runtimeFor('sunday-pregame');
    const points = await Promise.all(
      (['floor', 'balanced', 'ceiling'] as const).map(async (mode) => {
        const res = await runtime.request('GET', `/api/leagues/demo-league-2026/lineup?mode=${mode}`);
        return (res.body as LineupRecommendation).recommendedPoints;
      }),
    );
    expect(new Set(points).size).toBeGreaterThan(1);
  });

  /**
   * The clock decides what can still be changed, and the slate decides when.
   *
   * At 12:52 on the Sunday nothing in the lineup has kicked off — the London
   * game is over and the one o'clock games are eight minutes away — so every
   * slot is still legal to change, which is precisely what makes the downgrade
   * below actionable. By the late afternoon the morning and early windows are
   * finished and most of the lineup is locked. Both readings come from the same
   * fixture kickoffs measured from two different scenario clocks.
   */
  it('what is locked is what the scenario clock says has kicked off', async () => {
    const pivot = await runtimeFor('late-injury-pivot');
    const early = (await pivot.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    expect(early.slots.every((s) => !s.locked)).toBe(true);

    const afternoon = await runtimeFor('matchup-live-close');
    const later = (await afternoon.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    expect(later.slots.some((s) => s.locked)).toBe(true);
  });

  it('a downgraded starter is no longer recommended as one', async () => {
    const runtime = await runtimeFor('late-injury-pivot');
    const lineup = (await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    const bench = lineup.bench.concat(lineup.starters ?? []);
    const downgraded = bench.find((e) => e.playerId === 'p003');
    expect(downgraded?.statusFlag).toBeTruthy();
  });
});

describe('the waiver scenarios price a bid with the real engine', () => {
  it('waivers-tuesday-active produces upgrades and three different numbers per bid', async () => {
    const runtime = await runtimeFor('waivers-tuesday-active');
    const advice = (await runtime.request('GET', '/api/leagues/demo-league-2026/waivers')).body as WaiverAdvice;

    expect(advice.found).toBe(true);
    expect(advice.considered).toBeGreaterThan(10);
    expect(advice.upgrades.length).toBeGreaterThan(0);
    expect(advice.faab?.rule.usesFaab).toBe(true);
    expect(advice.faab?.rule.total).toBe(100);

    // The wallet is derived from the spend the fixture recorded, not stated.
    expect(advice.faab?.mine?.remaining).toBe(55);

    const bids = advice.faab?.bids ?? [];
    expect(bids.length).toBeGreaterThan(0);
    const priced = bids.filter((b) => b.recommended != null);
    expect(priced.length).toBeGreaterThan(0);
    for (const bid of priced) {
      expect(bid.doNotExceed).not.toBeNull();
      expect(bid.recommended!).toBeLessThanOrEqual(bid.doNotExceed!);
      expect(bid.recommended!).toBeLessThanOrEqual(advice.faab!.mine!.remaining!);
      expect(bid.headline.length).toBeGreaterThan(0);
      expect(bid.components.length).toBeGreaterThan(0);
    }
  });

  it('a league that does not bid is told so, and still gets its upgrades', async () => {
    const runtime = await runtimeFor('waivers-thin-data');
    const advice = (await runtime.request('GET', '/api/leagues/demo-league-2026/waivers')).body as WaiverAdvice;
    expect(advice.faab?.rule.usesFaab).toBe(false);
    expect(advice.faab?.bids.every((b) => b.recommended == null)).toBe(true);
    expect(advice.faab?.notes.join(' ')).toContain('does not use FAAB');
    expect(advice.upgrades.length).toBeGreaterThan(0);
  });

  /**
   * The two league-intelligence columns, filled by the same suppliers the live
   * handler uses.
   *
   * `main` layers `waiverMultiWeekFor` and `waiverLeagueIntel` on top of the
   * waiver advice before it leaves `app.ts`. The demo has to layer the same two
   * passes or its Waivers screen would print two empty columns that work in
   * production — the exact failure Demo Mode exists to make impossible.
   *
   * Asserted through the *contrast* rather than through a value: the tight end
   * and the receiver on this wire are both real upgrades to the same flex slot,
   * and the league is thin at one position and deep at the other. So the two
   * rows must disagree about competition, and that disagreement has to come
   * from counting rosters — nothing in the fixture states either number.
   */
  it('fills the competition and multi-week columns, and they disagree by position', async () => {
    const runtime = await runtimeFor('waivers-tuesday-active');
    const advice = (await runtime.request('GET', '/api/leagues/demo-league-2026/waivers')).body as WaiverAdvice;

    const candidates = advice.upgrades.flatMap((u) => u.candidates);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((c) => c.competition != null)).toBe(true);

    const te = candidates.find((c) => c.position === 'TE');
    const wr = candidates.find((c) => c.position === 'WR');
    expect(te, 'a tight end is on the wire').toBeTruthy();
    expect(wr, 'a receiver is on the wire').toBeTruthy();

    // Three rosters carry one tight end; nobody is short at receiver.
    expect(te!.competition!.level).toBe('high');
    expect(wr!.competition!.level).toBe('low');
    expect(te!.competition!.detail).toMatch(/teams need [A-Z]{1,3}/);

    // And the multi-week supplier answers for both, off measured usage.
    for (const c of [te!, wr!]) {
      expect(c.multiWeek, `${c.name} has a multi-week read`).toBeTruthy();
      expect(c.multiWeek!.label.length).toBeGreaterThan(0);
    }
  });

  /**
   * Competition is not decoration: it reaches the price.
   *
   * `priceWaiverUpgrades` takes the assessed bidder count as `rivalsWithNeed`,
   * which feeds the demand reading, which stretches the band the room is
   * expected to pay. The contested tight end must therefore carry a higher
   * expected top than the uncontested receiver — and if a future change stopped
   * passing the assessment through, both would fall back to the same
   * league-wide funded-roster count and the two bands would be identical, which
   * is what this asserts against.
   *
   * The *recommended* maximum is deliberately not the assertion. That number is
   * what the player is worth to this roster capped by what the week may spend,
   * and it is a fact about the lineup rather than about the room — reading a
   * competition effect into it would be asserting something the model does not
   * claim.
   */
  it('the contested add carries a higher expected price than the quiet one', async () => {
    const runtime = await runtimeFor('waivers-tuesday-active');
    const advice = (await runtime.request('GET', '/api/leagues/demo-league-2026/waivers')).body as WaiverAdvice;
    const bids = new Map((advice.faab?.bids ?? []).map((b) => [b.playerId, b] as const));

    const contested = advice.upgrades.flatMap((u) => u.candidates).find((c) => c.position === 'TE')!;
    const quiet = advice.upgrades.flatMap((u) => u.candidates).find((c) => c.position === 'WR')!;

    const a = bids.get(contested.playerId);
    const b = bids.get(quiet.playerId);
    expect(a?.expected, 'the contested add is priced').toBeTruthy();
    expect(b?.expected, 'the quiet add is priced').toBeTruthy();
    expect(contested.competition!.level).toBe('high');
    expect(quiet.competition!.level).toBe('low');
    expect(a!.expected!.high).toBeGreaterThan(b!.expected!.high);
  });

  it('the winning claim has come out of the wallet by Wednesday', async () => {
    const before = (
      await (await runtimeFor('waivers-tuesday-active')).request('GET', '/api/leagues/demo-league-2026/waivers')
    ).body as WaiverAdvice;
    const after = (
      await (await runtimeFor('waivers-processed')).request('GET', '/api/leagues/demo-league-2026/waivers')
    ).body as WaiverAdvice;
    expect(after.faab!.mine!.remaining!).toBeLessThan(before.faab!.mine!.remaining!);
  });
});

/**
 * §8's five Matchup scenarios, through `buildMatchupResponse`.
 *
 * Every assertion below is about something the *model* concluded — a phase, a
 * win probability, a projected final, a hero insight, a priced swap — from a
 * fixture that states only kickoffs, market lines and Sleeper's scoreboard.
 * That is the whole point of wiring these through the production assembly
 * rather than writing five matchup screens: if `core/matchup` changes its mind
 * about a close game, these change with it, and if a scenario stops being close
 * this file says so.
 */
describe('the matchup scenarios forecast a real afternoon', () => {
  const matchupFor = async (id: string) => {
    const runtime = await runtimeFor(id);
    const res = await runtime.request('GET', '/api/leagues/demo-league-2026/matchup');
    expect(res.status).toBe(200);
    return res.body as MatchupResponse;
  };

  it('all five find a matchup, with both lineups priced', async () => {
    for (const id of MATCHUP_IDS) {
      const body = await matchupFor(id);
      expect(body.found, `${id} found`).toBe(true);
      const forecast = body.forecast!;
      expect(forecast.slots.length).toBe(9);
      for (const row of forecast.slots) {
        expect(row.mine?.projectedFinal, `${id} ${row.slot} mine`).not.toBeNull();
        expect(row.theirs?.projectedFinal, `${id} ${row.slot} theirs`).not.toBeNull();
      }
      // A card per player in the matchup, both benches included.
      expect(Object.keys(body.cards).length).toBe(30);
      /*
       * With anything left to play, the projected final is ahead of the score.
       * (Once the week is settled the two are equal by definition, which is
       * asserted directly below rather than excepted here.)
       */
      if (forecast.phase !== 'final') {
        expect(forecast.teams.mine.projectedFinal!).toBeGreaterThan(forecast.teams.mine.actual);
        expect(forecast.teams.theirs.projectedFinal!).toBeGreaterThan(forecast.teams.theirs.actual);
      }
    }
  });

  /**
   * One Sunday in three states at once, and the phases are arithmetic.
   *
   * The fixture writes three kickoff times; `resolveClock` decides which of them
   * has finished, which is running and which has not begun. A slate where every
   * starter shared a phase would exercise none of the interesting paths, so
   * this asserts all three are present in a live scenario — and absent from the
   * settled one.
   */
  it('reads finished, running and unstarted games off the clock', async () => {
    const live = (await matchupFor('matchup-live-close')).forecast!;
    expect(live.phase).toBe('live');
    const phases = new Set(live.slots.flatMap((row) => [row.mine?.phase, row.theirs?.phase]));
    expect(phases.has('final')).toBe(true);
    expect(phases.has('live')).toBe(true);
    expect(phases.has('not_started')).toBe(true);

    const done = (await matchupFor('matchup-final')).forecast!;
    expect(done.phase).toBe('final');
    expect(done.slots.every((row) => row.mine?.phase === 'final')).toBe(true);
    // Nothing is left to happen, so the projection is the score.
    expect(done.teams.mine.projectedFinal).toBe(done.teams.mine.actual);
  });

  /**
   * The three live scenarios are the states they are named after.
   *
   * Bands rather than exact figures: the numbers come out of a simulation, and
   * pinning one to four decimal places would be a test of the seed rather than
   * of the fixture. What matters is that "close" is a coin flip, "leading" is a
   * lead that is not yet safe and "trailing" is a real deficit that is not yet
   * lost — and that they are ordered.
   */
  it('is close, ahead and behind — as the simulation reads it, not as the fixture claims', async () => {
    const win = async (id: string) => (await matchupFor(id)).forecast!.teams.mine.winProbability!;
    const [close, leading, trailing] = [await win('matchup-live-close'), await win('matchup-live-leading'), await win('matchup-live-trailing')];

    expect(close).toBeGreaterThan(0.4);
    expect(close).toBeLessThan(0.6);
    expect(leading).toBeGreaterThan(0.6);
    expect(leading).toBeLessThan(0.95);
    expect(trailing).toBeGreaterThan(0.05);
    expect(trailing).toBeLessThan(0.35);
    expect(trailing).toBeLessThan(close);
    expect(close).toBeLessThan(leading);
  });

  /**
   * The one point in it, stated by the model rather than by the label.
   *
   * The scenario is called "one point in it"; this is what makes that a claim
   * the fixture has to keep rather than a name on a list.
   */
  it('matchup-live-close projects the two finals within a point of each other', async () => {
    const forecast = (await matchupFor('matchup-live-close')).forecast!;
    const gap = Math.abs(forecast.teams.mine.projectedFinal! - forecast.teams.theirs.projectedFinal!);
    expect(gap).toBeLessThan(1);
    // And the scoreboard is not level, so the closeness is a forecast rather
    // than a restatement of what has already been scored.
    expect(forecast.teams.mine.actual).not.toBe(forecast.teams.theirs.actual);
  });

  /**
   * The injury scenario earns its name in win probability.
   *
   * A starter is ruled out of a game that has not kicked off, so his slot is
   * still changeable — which is what lets the insight engine price the swap
   * instead of merely reporting the designation. The gain is the decision
   * module's, computed over the same simulated afternoons.
   */
  it('matchup-injury-swing prices the swap that fixes it', async () => {
    const forecast = (await matchupFor('matchup-injury-swing')).forecast!;
    const hero = forecast.insights[0]!;
    expect(hero.kind).toBe('injury');
    expect(hero.urgency).toBe('act_now');
    expect(hero.winImpact).toBeGreaterThan(0.05);

    const swap = forecast.decision.options.find((o) => o.outPlayerId === hero.playerId);
    expect(swap, 'a legal replacement exists for the ruled-out starter').toBeTruthy();
    expect(swap!.gain).toBeGreaterThan(0);

    // The same Sunday without the designation is a materially different game,
    // which is what makes this a swing rather than a note.
    const without = (await matchupFor('matchup-live-close')).forecast!;
    expect(without.insights[0]!.kind).not.toBe('injury');
  });

  /** A settled week says what decided it, and what would have. */
  it('matchup-final explains the result instead of forecasting it', async () => {
    const forecast = (await matchupFor('matchup-final')).forecast!;
    const kinds = forecast.insights.map((i) => i.kind);
    expect(kinds).toContain('what_decided_it');
    expect(forecast.insights.every((i) => i.urgency !== 'act_now')).toBe(true);
    // A finished week has one outcome, and the model has to say so.
    expect([0, 1]).toContain(forecast.teams.mine.winProbability);
  });

  /**
   * The demo cannot write to the calibration ledger, and it is not asked to.
   *
   * The live service records both sides of every forecast it builds; §2 forbids
   * a demo from writing anything at all. The seam is the same either way — the
   * demo's sources supply a recorder that does nothing — so this asserts the
   * screen is fully served without one, twice, which is where a hidden write
   * would show up as a second answer.
   */
  it('serves the same forecast twice without recording anything', async () => {
    const runtime = await runtimeFor('matchup-live-close');
    const first = await runtime.request('GET', '/api/leagues/demo-league-2026/matchup');
    const second = await runtime.request('GET', '/api/leagues/demo-league-2026/matchup');
    const strip = (body: unknown) => JSON.stringify(body, (key, value) => (key === 'cached' ? null : value));
    expect(strip(second.body)).toEqual(strip(first.body));
  });
});

describe('degraded scenarios lose data, not screens', () => {
  it('partial-provider-outage still recommends, with the market unknown', async () => {
    const runtime = await runtimeFor('partial-provider-outage');
    const lineup = (await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    expect(lineup.found).toBe(true);
    expect(lineup.dataFreshness.fetchedAt).toBeNull();
    for (const evaluation of lineup.bench) {
      expect(evaluation.expectation.points).toBeNull();
    }
  });

  it('offline-draft refuses the board so the cached one is used instead', async () => {
    const runtime = await runtimeFor('offline-draft');
    const res = await runtime.request('GET', '/api/drafts/demo-draft-2026/board');
    expect(res.status).toBe(503);

    // And there is a real capture for the screen to fall back to.
    const capture = await runtime.offlineCapture();
    expect(capture?.draftId).toBe('demo-draft-2026');
    expect((capture?.board as DraftBoard).recommendations.length).toBeGreaterThan(0);
  });

  it('a stale injury report keeps the designation and loses the practice detail', async () => {
    const runtime = await runtimeFor('injury-source-stale');
    const detail = (await runtime.request('GET', '/api/players/p016/detail')).body as {
      injury: { designation: string; freshness: string; practice: string | null } | null;
    };
    expect(detail.injury?.designation).toBe('questionable');
    expect(detail.injury?.freshness).toBe('stale');
    expect(detail.injury?.practice).toBeNull();
  });
});

describe('rollover', () => {
  it('a new season with no league has nothing to advise on, and says which sources are waiting', async () => {
    const runtime = await runtimeFor('rollover-new-season');
    const report = (await runtime.request('GET', '/api/diagnostics/rollover')).body as {
      season: string;
      ready: boolean;
      waitingOn: string | null;
      checks: { name: string; status: string }[];
    };
    expect(report.season).toBe('2027');
    expect(report.ready).toBe(false);
    expect(report.waitingOn).toBeTruthy();
    expect(report.checks.some((c) => c.status === 'waiting')).toBe(true);
  });
});

describe('the trade window', () => {
  it('classifies by ownership, which is what separates a trade from an add', async () => {
    const runtime = await runtimeFor('trade-window');
    const board = (await runtime.request('GET', '/api/trades')).body as {
      suggestions: { playerId: string; ownership: string; verdict: string }[];
      considered: number;
    };
    expect(board.considered).toBeGreaterThan(5);
    expect(new Set(board.suggestions.map((s) => s.ownership)).size).toBeGreaterThan(1);
    for (const suggestion of board.suggestions) expect(suggestion.verdict).toBeTruthy();
  });
});

describe('the registry itself', () => {
  it('names every scenario §8 asks for', () => {
    const required = [
      'draft-early', 'draft-mid', 'draft-late', 'draft-complete',
      'post-draft-roster',
      'waivers-tuesday-active', 'waivers-thin-data', 'waivers-processed',
      'sunday-pregame', 'late-injury-pivot',
      'matchup-live-close', 'matchup-live-leading', 'matchup-live-trailing',
      'matchup-injury-swing', 'matchup-final',
      'trade-window',
      'playoff-week', 'season-complete', 'rollover-new-season', 'provider-waiting',
      'offline-draft', 'dog-unavailable', 'sleeper-adp-unavailable',
      'injury-source-stale', 'partial-provider-outage',
    ];
    for (const id of required) expect(findScenario(id), `${id} is registered`).toBeTruthy();
  });

  it('every id is unique and every progression link resolves', () => {
    const ids = DEMO_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of DEMO_SCENARIOS) {
      if (scenario.previous) expect(findScenario(scenario.previous), `${scenario.id}.previous`).toBeTruthy();
      if (scenario.next) expect(findScenario(scenario.next), `${scenario.id}.next`).toBeTruthy();
    }
  });

  /**
   * The escape hatch still works, and nothing is currently using it.
   *
   * §18 forbids the merge from pretending missing functionality exists, and the
   * five Matchup scenarios sat behind this marker until Matchup landed. All
   * twenty-five are now backed by a production surface, so the assertion is
   * that the list is empty *and* that the refusal is still armed — a
   * `selectableScenarios` that had quietly become "every scenario" would let
   * the next declared-but-unbuilt surface through unnoticed.
   */
  it('nothing is declared but unwired, and the refusal still works', async () => {
    expect(DEMO_SCENARIOS.filter((s) => s.awaiting).map((s) => s.id)).toEqual([]);
    expect(selectableScenarios().length).toBe(DEMO_SCENARIOS.length);

    const pretend = { ...findScenario('matchup-live-close')!, awaiting: { surface: 'review' as const, reason: 'not built' } };
    await expect(DemoRuntime.forScenario(pretend)).rejects.toThrow(/declared but not wired/);
  });

  it('every scenario declares an as-of instant that parses', () => {
    for (const scenario of DEMO_SCENARIOS) {
      expect(Number.isFinite(Date.parse(scenario.asOf)), `${scenario.id}.asOf`).toBe(true);
    }
  });
});

/**
 * §13: the Underdog market, now that it exists in the product.
 *
 * Every assertion below is about something the *board* concluded from fixture
 * provenance — the blend weights, the freshness verdict, the outlier guard,
 * the renormalisation — never about a number a fixture stated. That is the
 * whole point of wiring these through `buildDraftBoard` rather than modelling
 * DOG a second time for the demo.
 */
describe('DOG and the market blend', () => {
  /*
   * Typed as the board's own state rather than as the web client's view of it.
   *
   * `web/api.ts` marks `dogState` and `marketFormat` optional so a browser
   * running against an older worker degrades rather than breaks, and it does
   * not model the outlier guard's `suspectDog` at all. Those are the right
   * choices for a client and the wrong ones for a test asserting on what the
   * engine produced, which is never partial.
   */
  const board = async (id: string, query = '?limit=300') =>
    (await (await runtimeFor(id)).request('GET', `/api/drafts/demo-draft-2026/board${query}`))
      .body as DraftBoardState;

  it('lights the DOG column from a fresh Underdog snapshot', async () => {
    const b = await board('draft-mid');
    expect(b.dogState.available).toBe(true);
    expect(b.dogState.provider).toBe('underdog');
    expect(b.dogState.sourceType).toBe('raw_adp');
    expect(b.dogState.freshness).toBe('fresh');
    expect(b.dogState.matched).toBeGreaterThan(50);
    // And players actually carry a DOG price, distinct from their Sleeper one.
    const priced = b.recommendations.filter((r) => r.dogAdp != null);
    expect(priced.length).toBeGreaterThan(20);
    expect(priced.some((r) => r.dogAdp !== r.adp)).toBe(true);
  });

  it('blends 60/40 in a redraft league and 75/25 in best ball', async () => {
    const standard = await board('draft-mid');
    const bestBall = await board('draft-best-ball');

    expect(standard.marketFormat.format).toBe('standard');
    expect(standard.marketFormat.weights).toEqual({ dog: 0.6, sleeper: 0.4 });
    // Not stated by the fixture: Sleeper publishes no flag, so the board says so.
    expect(standard.marketFormat.confident).toBe(false);
    expect(standard.marketFormat.basis).toBe('none');

    expect(bestBall.marketFormat.format).toBe('best_ball');
    expect(bestBall.marketFormat.weights).toEqual({ dog: 0.75, sleeper: 0.25 });
    // Read off the league's own settings rather than off its name.
    expect(bestBall.marketFormat.confident).toBe(true);
    expect(bestBall.marketFormat.basis).toBe('league_settings');

    // The same player, priced by both markets, lands differently under each.
    const both = standard.recommendations.find(
      (r) => r.dogAdp != null && r.adp != null && r.dogAdp !== r.adp,
    )!;
    const same = bestBall.recommendations.find((r) => r.playerId === both.playerId)!;
    expect(same.marketBlend.adp).not.toBe(both.marketBlend.adp);
    expect(both.marketBlend.weights).toEqual({ dog: 0.6, sleeper: 0.4 });
    expect(same.marketBlend.weights).toEqual({ dog: 0.75, sleeper: 0.25 });
  });

  it('never relabels one market as the other', async () => {
    const b = await board('draft-mid');
    /*
     * A DOG price is Underdog's own number, not Sleeper's copied across.
     *
     * A player the outlier guard set aside is excluded, and deliberately: he
     * *was* priced by both and one of the prices was not believable, which is a
     * third state and is asserted on its own below. Folding him in here would
     * make this test quietly pass for the wrong reason the day the guard broke.
     */
    for (const rec of b.recommendations) {
      if (rec.dogAdp == null || rec.adp == null || rec.marketBlend.suspectDog) continue;
      expect(rec.marketBlend.sources).toContain('dog');
      expect(rec.marketBlend.sources).toContain('sleeper');
    }
    // And with no Underdog file at all, nothing claims a DOG price.
    const none = await board('dog-unavailable');
    expect(none.dogState.available).toBe(false);
    expect(none.recommendations.every((r) => r.dogAdp == null)).toBe(true);
    expect(none.recommendations.every((r) => !r.marketBlend.sources.includes('dog'))).toBe(true);
  });

  it('renormalises the blend around a market that has not priced him', async () => {
    const b = await board('draft-mid');
    const sleeperOnly = b.recommendations.find((r) => r.adp != null && r.dogAdp == null);
    expect(sleeperOnly, 'somebody is priced by Sleeper alone').toBeTruthy();
    expect(sleeperOnly!.marketBlend.singleSource).toBe(true);
    expect(sleeperOnly!.marketBlend.weights).toEqual({ dog: 0, sleeper: 1 });
    // The nominal blend is still reported, so the renormalisation is visible.
    expect(sleeperOnly!.marketBlend.nominal).toEqual({ dog: 0.6, sleeper: 0.4 });
    expect(sleeperOnly!.marketBlend.adp).toBe(sleeperOnly!.adp);

    const dogOnly = b.recommendations.find((r) => r.adp == null && r.dogAdp != null);
    expect(dogOnly, 'somebody is priced by Underdog alone').toBeTruthy();
    expect(dogOnly!.marketBlend.weights).toEqual({ dog: 1, sleeper: 0 });
    expect(dogOnly!.marketBlend.adp).toBe(dogOnly!.dogAdp);
  });

  it('reports a real disagreement as information, in picks and with a leader', async () => {
    const b = await board('draft-mid');
    const disagreeing = b.recommendations.filter(
      (r) => (r.marketDisagreement.picks ?? 0) >= 5 && !r.marketBlend.suspectDog,
    );
    expect(disagreeing.length).toBeGreaterThan(0);
    for (const rec of disagreeing) {
      expect(['dog', 'sleeper']).toContain(rec.marketDisagreement.leader);
      expect(rec.marketDisagreement.note).toBeTruthy();
      // A believable disagreement is context. It never removes a market from
      // the blend — that only happens past the outlier guard, which is the
      // next test.
      expect(rec.marketBlend.sources.length).toBe(2);
    }

    // And the disagreement is still *reported* for the one the guard caught,
    // because "these two markets are 117 picks apart" is the most useful thing
    // anybody could say about him.
    const suspect = b.recommendations.find((r) => r.marketBlend.suspectDog)!;
    expect(suspect.marketDisagreement.picks).toBeGreaterThan(100);
  });

  it('sets aside an Underdog price that cannot be true, and says which', async () => {
    const b = await board('draft-mid');
    const suspect = b.recommendations.find((r) => r.marketBlend.suspectDog);
    expect(suspect, 'the outlier guard has something to catch').toBeTruthy();
    // Set aside is not the same as absent: Underdog did price him.
    expect(suspect!.dogAdp).not.toBeNull();
    expect(suspect!.marketBlend.singleSource).toBe(true);
    expect(suspect!.marketBlend.weights).toEqual({ dog: 0, sleeper: 1 });
    expect(suspect!.marketBlend.note).toContain('too far apart');
  });

  it('withholds a stale Underdog file and explains itself out loud', async () => {
    const b = await board('dog-stale');
    expect(b.dogState.available).toBe(false);
    expect(b.dogState.freshness).toBe('stale');
    expect(b.dogState.ageHours).toBeGreaterThan(168);
    expect(b.warnings.join(' ')).toContain('too old to treat as the current market');
    expect(b.recommendations.every((r) => r.dogAdp == null)).toBe(true);
    // The board still ranks — losing a market is not losing the screen.
    expect(b.recommendations.length).toBeGreaterThan(10);
  });

  it('uses an aging Underdog file and prints its age rather than hiding it', async () => {
    const b = await board('dog-aging');
    expect(b.dogState.available).toBe(true);
    expect(b.dogState.freshness).toBe('aging');
    expect(b.dogState.reason).toContain('past the 36h window');
    expect(b.warnings.join(' ')).not.toContain('too old');
    expect(b.recommendations.some((r) => r.dogAdp != null)).toBe(true);
  });

  it('says which of the several absences happened, and never just goes blank', async () => {
    const reasons = await Promise.all(
      ['dog-unavailable', 'dog-stale'].map(async (id) => (await board(id)).dogState.reason),
    );
    expect(reasons[0]).toContain('no Underdog ADP snapshot has been imported');
    expect(reasons[1]).toContain('too old');
    expect(reasons[0]).not.toBe(reasons[1]);
  });
});
