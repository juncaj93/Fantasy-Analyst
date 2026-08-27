/**
 * Capturing and replaying a waiver claim plan.
 *
 * The largest of the six, because a claim plan is the most composed decision the
 * app makes: what the roster is worth now, what each add would be worth, who
 * else needs him and can pay, what that means he should cost, which defence the
 * planner has already claimed the DEF row for, and in what order Sleeper will
 * run the claims. Eight steps, and a report about any of them is a report about
 * all of them — so the snapshot carries the whole pipeline's inputs and the
 * whole pipeline's output, and replay runs `assembleWaiverPlan`.
 *
 * ## Two distillations, both counted
 *
 * **The player table.** `waiverLeagueIntel` reads three fields — id, position
 * and status — and only for players somebody in this league holds, because what
 * it answers is "who else is short here, and is he ruled out". The Sleeper
 * dictionary is around 2,500 rows; a twelve-team league holds two hundred. So
 * the capture keeps the rostered players and the scanned wire, and
 * `playerCensus` records what was dropped and why.
 *
 * **The wire itself was already bounded** before this lane saw it, by
 * `boundedFreeAgents`. That bound is the product's, not the snapshot's, and it
 * is captured as the input it is: `context.pool` says how many were scanned and
 * how many per position, so a thin board is never a mystery.
 *
 * ## The `Map` that would have gone quiet
 *
 * `history.profiles` is keyed by roster id and is a `Map` — what the ledger
 * knows about each rival's transaction habits. Through `JSON.stringify` it is
 * `{}`, and the pressure column would replay as "not known" for a league that
 * knows perfectly well. It is hoisted to entries here, put back at replay, and
 * `lossless.ts` refuses a capture that grows another one.
 *
 * ## The invariant this lane exists to protect
 *
 * The generic waiver scan must never contradict the defence planner. Both are in
 * `output` — the board under `upgrades`, the plan under `dst` — so a snapshot
 * where the two disagreed would be a snapshot of the bug, which is exactly what
 * is wanted. `tests/support.waiver.test.ts` asserts the invariant on replay
 * rather than trusting the filter that enforces it.
 */

import { assembleWaiverPlan, type WaiverAssemblyRequest } from '../waivers/assemble.ts';
import { WAIVER_ENGINE_VERSION } from '../waivers/version.ts';
import type { DstPlanSources } from '../dst/assemble.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import { SnapshotAliases, REDACTION_RULES } from './redaction.ts';
import { sealSnapshot } from './emit.ts';
import { captureLeague, captureRosters, captureStartSitInputs, rehydrateStartSitInputs } from './inseason.ts';
import { capturePlayer, rehydratePlayer } from './players.ts';
import { countPositions, summariseFreshness } from './freshness.ts';
import { recordDstSources, snapshotDstSources } from './dstSnapshot.ts';
import { classifyOutcome, compareStructural, describeDifference, exact, type ReplayReport } from './contract.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type SupportSnapshot } from './schema.ts';
import type { WaiverPlanPayload } from './payloads.ts';

export interface WaiverCaptureInput {
  gitSha: string;
  league: LeagueRecord;
  mine: RosterRecord;
  rosters: RosterRecord[];
  /** The whole player table, before distillation. */
  players: CanonicalPlayer[];
  /** Everything `assembleWaiverPlan` is about to be handed, minus the clock. */
  request: Omit<WaiverAssemblyRequest, 'now' | 'generatedAt' | 'players'>;
  /** How the wire was bounded, for the sentence that explains a thin board. */
  pool: { scanned: number; perPosition: number };
  nflState: NflState | null;
  props: { fetchedAt: string | null; provider: string | null; events: number };
  /** Weeks of transaction history read, for the freshness block. Null if unknown. */
  weeksRead: number | null;
  now: Date;
}

export async function captureWaiverSnapshot(
  input: WaiverCaptureInput,
): Promise<SupportSnapshot<WaiverPlanPayload>> {
  const recorder = input.request.dstSources == null ? null : recordDstSources(input.request.dstSources);
  const players = distilPlayers(input.players, input.request);

  /*
   * Built with the *whole* player table, not the distilled one.
   *
   * The file records the reduced list, because that is all the competition read
   * can reach — but the decision in `output` has to be the decision production
   * made, and production had every row. Capturing the reduced answer would make
   * the snapshot agree with its own replay by construction and prove nothing.
   *
   * So the two are allowed to disagree, and `tests/support.waiver.test.ts`
   * asserts that they do not: a capture whose distillation moved the board is a
   * replay that reports an `output_difference`, loudly, rather than a bound that
   * quietly passed as a match.
   */
  const decision = await assembleWaiverPlan({
    ...input.request,
    players: [...input.players],
    dstSources: recorder?.sources ?? null,
    now: input.now,
    generatedAt: input.now.toISOString(),
  });

  const aliases = new SnapshotAliases();
  const league = captureLeague(input.league, aliases);
  const rosters = captureRosters(input.rosters, aliases, league.id);
  const capturedAt = input.now.toISOString();

  return sealSnapshot<WaiverPlanPayload>({
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt,
    release: { gitSha: input.gitSha, surface: 'waiver-plan', engineVersion: WAIVER_ENGINE_VERSION },
    redaction: {
      replaced: {
        'manager id': aliases.counts.ids,
        'manager name': aliases.counts.names,
        'league or draft id': aliases.counts.scopes,
      },
      rules: [...REDACTION_RULES],
    },
    decision: {
      kind: 'waiver-plan',
      request: { leagueId: league.id, week: input.request.week },
      context: {
        league,
        season: input.request.season,
        week: input.request.week,
        scoringLabel: input.request.profile.label,
        rosterShape: input.request.shape,
        myRosterId: input.mine.rosterId,
        rosterCounts: countPositions(input.request.rosterInputs),
        pool: input.pool,
      },
      freshness: {
        ...summariseFreshness({
          inputs: [input.request.rosterInputs, input.request.candidateInputs],
          props: input.props,
          nflState: input.nflState,
          unknownPlayers: input.mine.playerIds.length - input.request.rosterInputs.length,
        }),
        faab: {
          rule: input.request.budgets?.rule.usesFaab === true ? 'faab' : (input.request.budgets ? 'priority' : null),
          bidsObserved: input.request.observations.length,
          weeksRead: input.weeksRead,
        },
        managerProfiles: input.request.history?.profiles.size ?? 0,
      },
      inputs: {
        now: capturedAt,
        generatedAt: capturedAt,
        shape: input.request.shape,
        profile: input.request.profile,
        season: input.request.season,
        week: input.request.week,
        roster: captureStartSitInputs(input.request.rosterInputs),
        candidates: captureStartSitInputs(input.request.candidateInputs),
        rosteredIds: [...input.request.rosteredIds],
        currentStarterIds: input.request.currentStarterIds,
        reserveIds: input.request.reserveIds,
        rosters,
        players: players.kept.map(capturePlayer),
        playerCensus: players.census,
        strategy: input.request.strategy,
        budgets: input.request.budgets,
        prices: input.request.prices,
        observations: input.request.observations,
        history:
          input.request.history == null
            ? null
            : {
                profiles: [...input.request.history.profiles.entries()],
                baseline: input.request.history.baseline,
                week: input.request.history.week,
                finalWeek: input.request.history.finalWeek,
              },
        dst: recorder?.seen() ?? null,
        bestBall: input.request.bestBall,
        draftComplete: input.request.draftComplete,
        playoff: input.request.playoff,
      },
      output: decision,
      warnings: decision.notes,
    },
  });
}

/**
 * The players the competition read can reach, and a count of the rest.
 *
 * Kept: everybody on any roster in the league (the whole of what
 * `waiverLeagueIntel` resolves), and everybody the wire scan scored (so a
 * candidate on the board always resolves to a name). Everything else is a row in
 * the Sleeper dictionary that nothing on this path reads.
 */
function distilPlayers(
  players: readonly CanonicalPlayer[],
  request: Pick<WaiverAssemblyRequest, 'rosteredIds' | 'candidateInputs'>,
): { kept: CanonicalPlayer[]; census: { listed: number; captured: number; keptBecause: Record<string, number> } } {
  const candidates = new Set(request.candidateInputs.map((input) => input.player.id));
  const keptBecause: Record<string, number> = { rostered: 0, scanned: 0 };
  const kept: CanonicalPlayer[] = [];

  for (const player of players) {
    if (request.rosteredIds.has(player.id)) {
      keptBecause['rostered'] = (keptBecause['rostered'] ?? 0) + 1;
      kept.push(player);
    } else if (candidates.has(player.id)) {
      keptBecause['scanned'] = (keptBecause['scanned'] ?? 0) + 1;
      kept.push(player);
    }
  }

  return { kept, census: { listed: players.length, captured: kept.length, keptBecause } };
}

export async function replayWaiverSnapshot(
  snapshot: SupportSnapshot<WaiverPlanPayload>,
): Promise<ReplayReport> {
  const { inputs, output } = snapshot.decision;
  const dstSources: DstPlanSources | null = inputs.dst == null ? null : snapshotDstSources(inputs.dst);

  const roster: StartSitInput[] = rehydrateStartSitInputs(inputs.roster);
  const candidates: StartSitInput[] = rehydrateStartSitInputs(inputs.candidates);

  const replayed = await assembleWaiverPlan({
    shape: inputs.shape,
    profile: inputs.profile,
    rosterInputs: roster,
    candidateInputs: candidates,
    rosteredIds: new Set(inputs.rosteredIds),
    currentStarterIds: inputs.currentStarterIds,
    reserveIds: inputs.reserveIds,
    rosters: inputs.rosters,
    players: inputs.players.map(rehydratePlayer),
    week: inputs.week,
    season: inputs.season,
    strategy: inputs.strategy,
    budgets: inputs.budgets,
    prices: inputs.prices,
    observations: inputs.observations,
    ...(inputs.history == null
      ? {}
      : {
          history: {
            profiles: new Map(inputs.history.profiles),
            baseline: inputs.history.baseline,
            week: inputs.history.week,
            finalWeek: inputs.history.finalWeek,
          },
        }),
    dstSources,
    bestBall: inputs.bestBall,
    draftComplete: inputs.draftComplete,
    playoff: inputs.playoff,
    /* The clock, pinned. Kickoffs, the activation window and the plan's own
       generation stamp are all measured from it. */
    now: new Date(Date.parse(snapshot.capturedAt)),
    generatedAt: inputs.generatedAt,
  });

  const differences: ReplayReport['differences'] = [];
  compareStructural('output', output, replayed, differences);

  /*
   * The claims, named as claims.
   *
   * The structural walk already compares every field of every line. This says
   * the same thing in the unit the reader is complaining in — *add him, bid
   * that, drop him, in that order* — so a failing replay opens with the claim
   * that moved rather than with a path into an array.
   */
  exact(
    'claimPlan.state',
    'the plan',
    output.claimPlan?.state ?? 'none',
    replayed.claimPlan?.state ?? 'none',
    differences,
  );
  exact('claimPlan.claims', 'the plan', claimLines(output), claimLines(replayed), differences);
  exact(
    'dst.decision',
    'the defence',
    output.dst?.decision ?? null,
    replayed.dst?.decision ?? null,
    differences,
  );

  const engineMatches = snapshot.release.engineVersion === WAIVER_ENGINE_VERSION;
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot),
    kind: 'waiver-plan',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: WAIVER_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: [
      { what: 'claims', count: output.claimPlan?.claims.length ?? 0 },
      { what: 'board rows', count: output.upgrades.length },
      { what: 'wire players scanned', count: inputs.candidates.inputs.length },
    ],
    differences,
    distillation: [
      {
        term: 'players.listed',
        at: 'the snapshot keeps the players this league holds and scanned, not the whole dictionary',
        captured: inputs.playerCensus.listed,
        replayed: inputs.playerCensus.captured,
      },
    ],
  };
}

/**
 * The plan as the reader would type it into Sleeper.
 *
 * `rank · add · bid · drop`, in order, and nothing else. The order is part of
 * the claim: Sleeper runs them top to bottom, so two plans with the same claims
 * in a different order are two different instructions.
 */
function claimLines(assembly: { claimPlan: { claims: { rank: number; addPlayerId: string; bid: number | null; dropPlayerId: string | null }[] } | null }): string {
  return (assembly.claimPlan?.claims ?? [])
    .map((claim) => `${claim.rank}:${claim.addPlayerId}@${claim.bid ?? '-'}/${claim.dropPlayerId ?? '-'}`)
    .join(' ');
}

function summarise(
  outcome: ReplayReport['outcome'],
  differences: ReplayReport['differences'],
  snapshot: SupportSnapshot<WaiverPlanPayload>,
): string {
  const { output, context } = snapshot.decision;
  const claims = output.claimPlan?.claims.length ?? 0;
  switch (outcome) {
    case 'reproduced':
      return `Reproduced: the same ${claims === 0 ? 'empty plan' : `${claims} claim${claims === 1 ? '' : 's'}, in the same order, with the same bids and drops`} over the same ${context.pool.scanned}-player wire — week ${context.week}.`;
    case 'engine_version_mismatch':
      return `The waiver engine has moved since capture (${snapshot.release.engineVersion} → ${WAIVER_ENGINE_VERSION}) and the plan came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every claim term matched; only the age of the data behind it read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The claim plan reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
