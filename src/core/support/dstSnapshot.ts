/**
 * Capturing and replaying a defence plan.
 *
 * DST is kept specialised and separate from generic player logic everywhere
 * else in this app, and it is kept separate here too: its own payload, its own
 * adapter, its own engine version. The reason is the invariant the whole module
 * exists to protect — the generic waiver scan must never be able to contradict
 * the planner — and an invariant is only checkable if the two are captured as
 * two things.
 *
 * ## A recording proxy, like Draft and Matchup
 *
 * `DstPlanSources` is three methods and none of them is a fetch: the coming
 * week's fixtures, the planner's teams over the planner's weeks, and what each
 * offence has been priced at this season. A live caller answers all three from
 * rows some earlier refresh already paid for, and a demo answers them from a
 * fixture — so recording them is recording the whole of what the planner could
 * see about the outside world.
 *
 * The rest of the request is not a source at all. The rostered defences, the
 * bounded pool, the lineup the bench cost is measured against and the league's
 * playoff weeks are values the caller already holds, and they are captured as
 * values.
 *
 * ## `impliedTotals` is a `Map`, and that is the whole reason `lossless.ts` exists
 *
 * It is the fallback anchor: what each offence has been priced at across the
 * season, used where the market has not priced a future game. `JSON.stringify`
 * would turn it into `{}` — silently — and the plan would replay with *every*
 * fallback anchor missing, which reads as a planner that suddenly refuses to
 * look past this week. So it is hoisted into entries here and put back at
 * replay, and a capture that grew a second `Map` would be refused rather than
 * quietly emptied.
 */

import { assembleDstPlan, type DstPlanRequest, type DstPlanSources } from '../dst/assemble.ts';
import { DST_ENGINE_VERSION } from '../dst/version.ts';
import { DEFENCE_POSITION } from '../startsit/engine.ts';
import type { TeamForm } from '../dst/outlook.ts';
import type { ScheduleTeamWeek } from '../nfl/schedule.ts';
import type { LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import { SnapshotAliases, REDACTION_RULES } from './redaction.ts';
import { sealSnapshot } from './emit.ts';
import { scrubAliases } from './scrub.ts';
import {
  captureLeague,
  captureLeagueRules,
  captureStartSitInputs,
  rehydrateLeagueRules,
  rehydrateStartSitInputs,
} from './inseason.ts';
import { countPositions, summariseFreshness } from './freshness.ts';
import { classifyOutcome, compareStructural, describeDifference, exact, type ReplayReport } from './contract.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type SupportSnapshot } from './schema.ts';
import type { DstPlanPayload, DstReads } from './payloads.ts';

/**
 * Wrap the three reads so that using them records them.
 *
 * `scheduleForTeams` records its arguments as well as its answer, because the
 * planner decides *which* weeks to ask for — this week, the hold horizon, and
 * the league's own playoff weeks — and a replay that answered a different range
 * with the same rows would be answering a different question.
 */
export function recordDstSources(inner: DstPlanSources): {
  sources: DstPlanSources;
  seen(): DstReads;
} {
  const seen: DstReads = { fixturesForWeek: [], scheduleForTeams: [], impliedTotals: [] };

  return {
    sources: {
      fixturesForWeek: async (season, week) => (seen.fixturesForWeek = await inner.fixturesForWeek(season, week)),
      scheduleForTeams: async (season, teams, range) => {
        const rows = await inner.scheduleForTeams(season, teams, range);
        seen.scheduleForTeams.push({ season, teams: [...teams], from: range.from, to: range.to, rows });
        return rows;
      },
      impliedTotals: async (season, now) => {
        const totals = await inner.impliedTotals(season, now);
        seen.impliedTotals = [...totals.entries()];
        return totals;
      },
    },
    seen: () => seen,
  };
}

/** Recorded reads, back in the shapes the planner asks for. */
export function snapshotDstSources(reads: DstReads): DstPlanSources {
  const totals = new Map<string, TeamForm>(reads.impliedTotals ?? []);
  return {
    fixturesForWeek: async () => reads.fixturesForWeek ?? [],
    /*
     * Answered by the range that was asked for, not by "the only one recorded".
     *
     * The planner asks once, so there is normally one entry — but matching on
     * the arguments is what makes a replay that asked for a *different* range
     * come back empty and report a difference, rather than silently receiving
     * somebody else's weeks.
     */
    scheduleForTeams: async (season, teams, range) => {
      const wanted = new Set(teams.map((team) => team.toUpperCase()));
      const entry = (reads.scheduleForTeams ?? []).find(
        (recorded) =>
          recorded.season === season &&
          recorded.from === range.from &&
          recorded.to === range.to &&
          recorded.teams.length === teams.length &&
          recorded.teams.every((team) => wanted.has(team.toUpperCase())),
      );
      return entry?.rows ?? ([] as ScheduleTeamWeek[]);
    },
    impliedTotals: async () => totals,
  };
}

export interface DstCaptureInput {
  gitSha: string;
  league: LeagueRecord;
  mine: RosterRecord;
  sources: DstPlanSources;
  request: Omit<DstPlanRequest, 'now'>;
  nflState: NflState | null;
  props: { fetchedAt: string | null; provider: string | null; events: number };
  now: Date;
}

export async function captureDstSnapshot(input: DstCaptureInput): Promise<SupportSnapshot<DstPlanPayload>> {
  const recorder = recordDstSources(input.sources);
  const rawPlan = await assembleDstPlan(recorder.sources, { ...input.request, now: input.now });
  const reads = recorder.seen();

  const aliases = new SnapshotAliases();
  const league = captureLeague(input.league, aliases);
  const capturedAt = input.now.toISOString();

  /*
   * The decision, with every identity that reached it replaced.
   *
   * The inputs are aliased above; this is the other half, and it is the half
   * that has caught this app twice. An engine that composes a league id or a
   * manager's name into a string produces an output that a verbatim copy would
   * carry straight past every alias in the file. Run after every alias has been
   * allocated, so it can only ever replace. See `scrub.ts`.
   */
  const plan = scrubAliases(rawPlan, aliases) as typeof rawPlan;
  const { rosterInputs, candidateInputs, shape, profile } = input.request;

  return sealSnapshot<DstPlanPayload>({
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt,
    release: { gitSha: input.gitSha, surface: 'dst-plan', engineVersion: DST_ENGINE_VERSION },
    redaction: {
      replaced: {
        'manager id': aliases.counts.ids,
        'manager name': aliases.counts.names,
        'league or draft id': aliases.counts.scopes,
        'league name': aliases.counts.labels,
      },
      rules: [...REDACTION_RULES],
    },
    decision: {
      kind: 'dst-plan',
      request: { leagueId: league.id, week: input.request.week, season: input.request.season },
      context: {
        league,
        season: input.request.season,
        week: input.request.week,
        scoringLabel: profile.label,
        rosterShape: shape,
        myRosterId: input.mine.rosterId,
        rosterCounts: countPositions(rosterInputs),
        defenceSlots: shape.starters[DEFENCE_POSITION] ?? 0,
        bestBall: input.request.bestBall,
        draftComplete: input.request.draftComplete,
      },
      freshness: {
        ...summariseFreshness({
          inputs: [rosterInputs, candidateInputs],
          props: input.props,
          nflState: input.nflState,
          unknownPlayers: 0,
        }),
        anchors: countAnchors(plan),
        fixturesStored: reads.fixturesForWeek.length,
        teamsWithForm: reads.impliedTotals.length,
      },
      inputs: {
        now: capturedAt,
        rules: captureLeagueRules(input.league),
        season: input.request.season,
        week: input.request.week,
        bestBall: input.request.bestBall,
        draftComplete: input.request.draftComplete,
        reserveIds: input.request.reserveIds,
        playoff: input.request.playoff,
        roster: captureStartSitInputs(rosterInputs),
        candidates: captureStartSitInputs(candidateInputs),
        lineup: input.request.lineup,
        reads,
      },
      output: plan,
      /*
       * The planner's own degraded states, lifted where they are read first.
       *
       * A plan built on fallback anchors is not a wrong plan, but it is a
       * different claim from one built on priced games — so the file says which
       * before a reader opens the arithmetic.
       */
      warnings: warningsFor(plan),
    },
  });
}

/**
 * Which anchor each planned week got, counted.
 *
 * The planner will not invent a line: a priced future game gets the real anchor,
 * an unpriced one gets the opponent's own season average clearly marked as such,
 * and a week with neither gets nothing. Telling the three apart is the whole of
 * a "why is it telling me to stream him" report, so the counts travel rather
 * than being recoverable only by walking the plan.
 */
function countAnchors(plan: Awaited<ReturnType<typeof assembleDstPlan>>): Record<string, number> {
  const counts: Record<string, number> = {};
  if (plan == null) return counts;
  const options = [plan.target, plan.stash, plan.current].filter((option) => option != null);
  for (const option of options) {
    for (const outlook of [option.forward, option.playoff]) {
      for (const week of outlook?.weeks ?? []) {
        /*
         * `basis` is the planner's own word for where the anchor came from —
         * `line` is a priced game, `form` is the opponent's season average
         * standing in for one, and `unknown` is a week it refused to value at
         * all. A bye has no anchor and is counted as neither.
         */
        counts[week.basis] = (counts[week.basis] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function warningsFor(plan: Awaited<ReturnType<typeof assembleDstPlan>>): string[] {
  if (plan == null) return ['No defence plan was produced for this league.'];
  const anchors = countAnchors(plan);
  const fromForm = anchors['form'] ?? 0;
  const unrated = anchors['unknown'] ?? 0;
  const warnings: string[] = [];
  if (fromForm > 0) {
    warnings.push(
      `${fromForm} of the planned weeks had no priced game and used the opponent's own season average as the anchor.`,
    );
  }
  if (unrated > 0) {
    warnings.push(`${unrated} of the planned weeks could not be valued at all and were left unrated rather than zeroed.`);
  }
  return warnings;
}

export async function replayDstSnapshot(snapshot: SupportSnapshot<DstPlanPayload>): Promise<ReplayReport> {
  const { inputs, output } = snapshot.decision;

  const { shape, profile } = rehydrateLeagueRules(inputs.rules);
  const replayed = await assembleDstPlan(snapshotDstSources(inputs.reads), {
    season: inputs.season,
    week: inputs.week,
    shape,
    profile,
    bestBall: inputs.bestBall,
    draftComplete: inputs.draftComplete,
    rosterInputs: rehydrateStartSitInputs(inputs.roster),
    candidateInputs: rehydrateStartSitInputs(inputs.candidates),
    lineup: inputs.lineup,
    reserveIds: inputs.reserveIds,
    playoff: inputs.playoff,
    /* The clock, pinned. The activation window is measured from it. */
    now: new Date(Date.parse(snapshot.capturedAt)),
  });

  const differences: ReplayReport['differences'] = [];
  compareStructural('output', output, replayed, differences);
  exact('decision', 'the defence', output?.decision ?? null, replayed?.decision ?? null, differences);
  exact('target', 'the defence', output?.target?.team ?? null, replayed?.target?.team ?? null, differences);
  exact('surface', 'the defence', output?.surface ?? null, replayed?.surface ?? null, differences);

  const engineMatches = snapshot.release.engineVersion === DST_ENGINE_VERSION;
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot),
    kind: 'dst-plan',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: DST_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: [
      { what: 'rostered defences', count: inputs.roster.inputs.length },
      { what: 'available defences', count: inputs.candidates.inputs.length },
      { what: 'scheduled weeks read', count: inputs.reads.scheduleForTeams.reduce((n, e) => n + e.rows.length, 0) },
    ],
    differences,
    distillation: [],
  };
}

function summarise(
  outcome: ReplayReport['outcome'],
  differences: ReplayReport['differences'],
  snapshot: SupportSnapshot<DstPlanPayload>,
): string {
  const { output, context } = snapshot.decision;
  switch (outcome) {
    case 'reproduced':
      return output == null
        ? `Reproduced: no defence plan, which is the right answer for this league — week ${context.week}, ${context.defenceSlots} DEF slot(s), best ball ${context.bestBall}.`
        : `Reproduced: the same decision (${output.decision}${output.target ? ` ${output.target.team}` : ''}) from the same anchors — week ${context.week}.`;
    case 'engine_version_mismatch':
      return `The defence engine has moved since capture (${snapshot.release.engineVersion} → ${DST_ENGINE_VERSION}) and the plan came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every planning term matched; only the age of the data behind it read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The defence plan reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
