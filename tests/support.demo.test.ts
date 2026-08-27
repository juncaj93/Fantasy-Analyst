/**
 * The capture route inside Demo Mode.
 *
 * A demo satisfies `DraftBoardSources` from fixtures, so the same capture that
 * runs against D1 runs against a scenario — which is what lets somebody learn
 * the support workflow end to end without a live draft, and what lets a
 * screenshot of the affordance be taken from a rehearsed board.
 *
 * Two things have to be true of that, and neither is obvious:
 *
 *   1. **a demo snapshot must not be mistakable for a production one.** Its
 *      `gitSha` is `demo` rather than the deployment's revision, so a fixture
 *      built from a rehearsal cannot claim to describe a revision it does not;
 *   2. **a scenario with no draft must refuse rather than emit an empty file.**
 *      A snapshot of no board looks exactly like a bug report and contains
 *      nothing, and somebody would send it and wait.
 *
 * The demo also runs this in the *browser* — which is why the capture is in
 * Demo Mode's lazy chunk and the replay is in no browser chunk at all. The
 * split is asserted by the page-weight budget, not here.
 */

import { describe, expect, it } from 'vitest';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import { findScenario, selectableScenarios } from '../src/core/demo/registry.ts';
import { replayDraftSnapshot } from '../src/core/support/replay.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { SUPPORT_SNAPSHOT_SCHEMA } from '../src/core/support/schema.ts';
import { IN_SEASON_KINDS } from '../src/core/support/contexts.ts';
import { findRedactionViolations } from '../src/core/support/redaction.ts';
import { findLossyValues } from '../src/core/support/lossless.ts';
import type { SupportSnapshot, DraftBoardPayload } from '../src/core/support/schema.ts';

const runtimeFor = async (id: string) => DemoRuntime.forScenario(findScenario(id)!);

/** The draft the demo league is playing, whatever the scenario calls it. */
async function draftIdFor(runtime: DemoRuntime): Promise<string | null> {
  const leagues = (await runtime.request('GET', '/api/leagues')).body as {
    leagues: { draftId: string | null }[];
  };
  return leagues.leagues[0]?.draftId ?? null;
}

describe('a rehearsed board captures like a live one', () => {
  it('serves a snapshot that replays exactly', async () => {
    const runtime = await runtimeFor('draft-mid');
    const draftId = await draftIdFor(runtime);
    expect(draftId).toBeTruthy();

    const response = await runtime.request('GET', `/api/drafts/${draftId}/support-snapshot`);
    expect(response.status).toBe(200);

    const snapshot = readSnapshot(JSON.parse(JSON.stringify(response.body)));
    expect(snapshot.schema).toBe(SUPPORT_SNAPSHOT_SCHEMA);

    const report = await replayDraftSnapshot(snapshot);
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });

  it('says `demo`, so a rehearsal cannot be mistaken for a deployment', async () => {
    const runtime = await runtimeFor('draft-early');
    const draftId = await draftIdFor(runtime);
    const body = (await runtime.request('GET', `/api/drafts/${draftId}/support-snapshot`))
      .body as SupportSnapshot<DraftBoardPayload>;

    /*
     * Not the deployment's revision, and deliberately not `unknown` either — a
     * fixture built from a rehearsal would otherwise claim to describe a
     * revision, or claim to describe none, when what it actually describes is a
     * versioned set of fixtures.
     */
    expect(body.release.gitSha).toBe('demo');
    expect(body.release.surface).toBe('draft-board');
  });

  it('refuses a scenario with no draft rather than emitting an empty file', async () => {
    /*
     * Found by asking the scenarios rather than by naming one.
     *
     * "Has no draft" is a property of the fixture data, not of the registry
     * entry — a scenario can leave `draft` out of its surfaces and still carry
     * one — so the honest way to find the case is to ask each scenario what
     * league it is serving and take the first that reports no draft. A renamed
     * or reordered scenario then cannot turn this into a test that quietly
     * stops running, and the assertion below fires if the case disappears
     * entirely.
     */
    let refused = 0;
    for (const scenario of selectableScenarios()) {
      const runtime = await DemoRuntime.forScenario(scenario);
      const draftId = await draftIdFor(runtime);
      if (draftId != null) continue;

      refused++;
      const response = await runtime.request('GET', '/api/drafts/whatever/support-snapshot');
      expect(response.status, `${scenario.id} emitted a snapshot of no draft`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).not.toContain(SUPPORT_SNAPSHOT_SCHEMA);
    }
    expect(refused, 'no scenario without a draft is registered, so nothing was tested').toBeGreaterThan(0);
  });

  it('cannot be asked for as a write at all', async () => {
    const runtime = await runtimeFor('draft-mid');
    const draftId = await draftIdFor(runtime);
    /*
     * Refused above the handler, not by it.
     *
     * Demo Mode's guard rejects any non-GET before routing, so there is no
     * `POST /support-snapshot` for the demo to answer — which is stronger than
     * the route declining one, and is the same refusal every other write in a
     * demo meets. It throws rather than returning a status, because a write
     * inside a demo is a programming error and not a request outcome.
     */
    await expect(runtime.request('POST', `/api/drafts/${draftId}/support-snapshot`)).rejects.toThrow(
      /read-only/i,
    );
  });
});

/**
 * And the same for the five in-season decisions.
 *
 * Demo Mode serves the identical route over the identical capture adapters, from
 * the identical gatherers its own screens read — so the file a scenario produces
 * is the file the live app produces, and somebody learning the support workflow
 * can run it end to end without a league of their own.
 *
 * Two scenarios rather than one, because no single scenario has every decision
 * live at once and pretending otherwise would mean testing four lanes and
 * skipping the fifth: `waivers-tuesday-active` is a Tuesday, with a wire worth
 * claiming from and a ledger two seasons deep and no game being played; and
 * `sunday-pregame` is a Sunday with a matchup on it.
 */
describe('a rehearsed in-season decision captures like a live one', () => {
  const SCENARIO = 'waivers-tuesday-active';
  const scenarioFor = (context: string) => (context === 'matchup' ? 'sunday-pregame' : SCENARIO);

  it.each(IN_SEASON_KINDS)('%s replays exactly, with no network anywhere', async (context) => {
    const runtime = await runtimeFor(scenarioFor(context));
    const leagues = (await runtime.request('GET', '/api/leagues')).body as { leagues: { id: string }[] };
    const leagueId = leagues.leagues[0]!.id;

    const response = await runtime.request('GET', `/api/leagues/${leagueId}/support-snapshot?context=${context}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const snapshot = readSnapshot(JSON.parse(JSON.stringify(response.body)));
    expect(snapshot.decision.kind).toBe(context);
    expect(snapshot.release.gitSha, 'a rehearsal must not claim a revision').toBe('demo');
    expect(findRedactionViolations(snapshot)).toEqual([]);
    expect(findLossyValues(snapshot)).toEqual([]);

    const report = await replaySnapshot(snapshot);
    expect(report.outcome, report.summary).toBe('reproduced');
  });

  it('refuses a context it does not know, and says which it does', async () => {
    const runtime = await runtimeFor(SCENARIO);
    const leagues = (await runtime.request('GET', '/api/leagues')).body as { leagues: { id: string }[] };
    const response = await runtime.request(
      'GET',
      `/api/leagues/${leagues.leagues[0]!.id}/support-snapshot?context=roster-move`,
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('waiver-plan');
  });

  it('cannot be asked for as a write at all', async () => {
    const runtime = await runtimeFor(SCENARIO);
    const leagues = (await runtime.request('GET', '/api/leagues')).body as { leagues: { id: string }[] };
    await expect(
      runtime.request('POST', `/api/leagues/${leagues.leagues[0]!.id}/support-snapshot?context=lineup`),
    ).rejects.toThrow(/read-only/i);
  });
});

/**
 * And "there is nothing to capture" is an answer, not a failure.
 *
 * A Tuesday has no matchup on it, and the honest response is the sentence the
 * Matchup screen itself would have shown — not a file with no lineups and no
 * forecast in it, which somebody would send and then wait on.
 */
describe('a decision that is not being made refuses rather than emitting nothing', () => {
  it('says why there is no matchup, rather than capturing an empty one', async () => {
    const runtime = await runtimeFor('waivers-tuesday-active');
    const leagues = (await runtime.request('GET', '/api/leagues')).body as { leagues: { id: string }[] };
    const response = await runtime.request(
      'GET',
      `/api/leagues/${leagues.leagues[0]!.id}/support-snapshot?context=matchup`,
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/matchup/i);
    expect(JSON.stringify(response.body)).not.toContain(SUPPORT_SNAPSHOT_SCHEMA);
  });
});
