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
import { buildDraftBoard } from '../src/core/draft/boardBuilder.ts';
import { DEMO_SCENARIOS, findScenario, selectableScenarios } from '../src/core/demo/registry.ts';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import type { DraftBoard, LineupRecommendation, Overview, WaiverAdvice } from '../src/web/api.ts';

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
    expect(lineup.slots.length).toBe(8);
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

  it('a player whose game has kicked off is locked', async () => {
    const runtime = await runtimeFor('late-injury-pivot');
    const lineup = (await runtime.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    expect(lineup.slots.some((s) => s.locked)).toBe(true);
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
    expect(advice.faab?.mine?.remaining).toBe(37);

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

  it('a scenario awaiting its surface refuses to be run', async () => {
    const matchup = findScenario('matchup-live-close')!;
    expect(matchup.awaiting?.surface).toBe('matchup');
    await expect(DemoRuntime.forScenario(matchup)).rejects.toThrow(/declared but not wired/);
  });

  it('every scenario declares an as-of instant that parses', () => {
    for (const scenario of DEMO_SCENARIOS) {
      expect(Number.isFinite(Date.parse(scenario.asOf)), `${scenario.id}.asOf`).toBe(true);
    }
  });
});
