/**
 * A support snapshot of a rehearsed decision.
 *
 * Demo Mode's answer to the same route the deployment serves, and it is the same
 * five capture adapters over the same five gatherers the demo screens read. So
 * the file a scenario produces is the file the live app produces — same schema,
 * same redaction, same losslessness check, same replay — and somebody learning
 * the support workflow can run it end to end without a league of their own.
 *
 * There is no fake support logic anywhere in here. What a demo contributes is a
 * `ScenarioData` instead of a database, which is what Demo Mode contributes to
 * every other answer in this app.
 *
 * ## Two things it says differently, on purpose
 *
 * `gitSha` is `demo` rather than a deployed revision: a snapshot of a rehearsal
 * must never be mistakable for a snapshot of production, and a fixture built
 * from one must not claim a revision it does not describe.
 *
 * And the clock is the scenario's, not the device's. That is what lets a demo be
 * on a Tuesday in week 7 — and it is what makes a demo snapshot replay, because
 * the clock in the file is the clock the decision was made under.
 *
 * ## Statically imported, and that is measured rather than assumed
 *
 * The obvious refinement is a dynamic import, so a scenario open does not fetch
 * five capture adapters for a button most readers never press. It was tried and
 * it costs more than it saves: the demo budget is a *total* over every
 * `demo-*.js` chunk — deliberately, so that splitting one file into three cannot
 * quietly pass three budgets — and the extra chunk's overhead is larger than the
 * deferral is worth. Static, with 4kB of headroom left, is the better trade.
 */

import { captureLineupSnapshot } from '../../support/lineupSnapshot.ts';
import { captureMatchupSnapshot } from '../../support/matchupSnapshot.ts';
import { captureWaiverSnapshot } from '../../support/waiverSnapshot.ts';
import { captureDstSnapshot } from '../../support/dstSnapshot.ts';
import { captureTradeSnapshot } from '../../support/tradeSnapshot.ts';
import { SnapshotUnavailable } from '../../support/emit.ts';
import { waiverLineup } from '../../waivers/assemble.ts';
import { normalizeMode } from '../../startsit/mode.ts';
import { DEFENCE_POSITION } from '../../startsit/engine.ts';
import { demoLeagueContext, demoLineupInputs, demoTradeRequest, demoWaiverRequest } from './decisions.ts';
import { matchupSourcesFrom } from './sources.ts';
import { buildDemoDataHealth } from './health.ts';
import { toSnapshotHealth } from '../../health/snapshot.ts';
import type { InSeasonKind } from '../../support/contexts.ts';
import type { ScenarioData } from '../fixtures/index.ts';

interface DemoResponse {
  status: number;
  body: unknown;
}

/** The market's own age, in the shape the freshness block wants it. */
function props(data: ScenarioData): { fetchedAt: string | null; provider: string | null; events: number } {
  return {
    fetchedAt: data.vegas.fetchedAt,
    provider: data.vegas.fetchedAt ? 'demo fixtures' : null,
    events: data.vegas.events,
  };
}

export async function captureDemoSnapshot(
  data: ScenarioData,
  context: InSeasonKind,
  params: URLSearchParams,
): Promise<DemoResponse> {
  try {
    return await capture(data, context, params);
  } catch (err) {
    /*
     * "There is nothing to capture" is an answer, not a failure.
     *
     * A scenario with no matchup this week, or a league that starts no defence,
     * has no decision for the file to be about — and the sentence the screen
     * would have shown is a better response than a stack trace or an empty file.
     */
    if (err instanceof SnapshotUnavailable) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

async function capture(
  data: ScenarioData,
  context: InSeasonKind,
  params: URLSearchParams,
): Promise<DemoResponse> {
  const { mine, shape } = demoLeagueContext(data);
  const now = data.clock.now();
  const gitSha = 'demo';
  /*
   * And the same health section a live capture carries.
   *
   * From the same reducer over the scenario's own view, so a support file
   * produced in a rehearsal is the file the live app produces — health block
   * included. That is what makes the support workflow learnable end to end
   * without a live league behind it.
   */
  const dataHealth = toSnapshotHealth(buildDemoDataHealth(data));

  if (!mine) throw new SnapshotUnavailable('Your team was not found in this scenario.');

  switch (context) {
    case 'lineup': {
      const mode = normalizeMode(params.get('mode'));
      const gathered = demoLineupInputs(data, mine, mode);
      return {
        status: 200,
        body: captureLineupSnapshot({
          gitSha,
          dataHealth,
          league: data.league,
          rosters: data.rosters,
          mine,
          shape: gathered.shape,
          profile: gathered.profile,
          inputs: gathered.inputs,
          mode,
          /* A scenario has no Rotowire fallback, which is a real and honest state. */
          published: new Map(),
          nflState: data.nflState ?? null,
          props: props(data),
          now,
        }),
      };
    }

    case 'matchup': {
      return {
        status: 200,
        body: await captureMatchupSnapshot(matchupSourcesFrom(data), {
          gitSha,
          dataHealth,
          leagueId: data.league.id,
          week: params.get('week') == null ? null : Number(params.get('week')),
          props: props(data),
        }),
      };
    }

    case 'waiver-plan': {
      const gathered = demoWaiverRequest(data, mine);
      return {
        status: 200,
        body: await captureWaiverSnapshot({
          gitSha,
          dataHealth,
          league: data.league,
          mine,
          rosters: data.rosters,
          players: data.players,
          request: gathered.request,
          pool: gathered.pool,
          nflState: data.nflState ?? null,
          props: props(data),
          /* A scenario's ledger covers the weeks the fixture generated. */
          weeksRead: null,
          now,
        }),
      };
    }

    case 'dst-plan': {
      const gathered = demoWaiverRequest(data, mine);
      const { request } = gathered;
      if (request.dstSources == null || (shape.starters[DEFENCE_POSITION] ?? 0) === 0) {
        throw new SnapshotUnavailable(
          `This league starts no ${DEFENCE_POSITION}, so there is no defence decision to capture.`,
        );
      }
      return {
        status: 200,
        body: await captureDstSnapshot({
          gitSha,
          dataHealth,
          league: data.league,
          mine,
          sources: request.dstSources,
          request: {
            season: request.season,
            week: request.week,
            shape: request.shape,
            profile: request.profile,
            bestBall: request.bestBall,
            draftComplete: request.draftComplete,
            rosterInputs: request.rosterInputs,
            candidateInputs: request.candidateInputs,
            /*
             * The lineup the bench cost is measured against, from the waiver
             * assembly's own function rather than a second call that looks like
             * it. Same inputs, same starters, same clock, and the same code.
             */
            lineup: waiverLineup({ ...request, now }),
            reserveIds: request.reserveIds,
            playoff: request.playoff,
          },
          nflState: data.nflState ?? null,
          props: props(data),
          now,
        }),
      };
    }

    case 'trade-offer': {
      const request = demoTradeRequest(data);
      return {
        status: 200,
        body: captureTradeSnapshot({
          gitSha,
          dataHealth,
          league: data.league,
          rosters: data.rosters,
          request: {
            profile: request.profile,
            shape: request.shape,
            inputs: request.inputs,
            history: request.history,
            limit: params.get('limit') == null ? undefined : Number(params.get('limit')),
          },
          nflState: data.nflState ?? null,
          props: props(data),
          week: data.nflState?.week ?? 0,
          now,
        }),
      };
    }
  }
}
