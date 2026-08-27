/**
 * Capturing and replaying a Team / Start-Sit decision.
 *
 * Capture and replay live in one file on purpose. They are two halves of one
 * claim — *this is what the engine read, and reading it again produces this* —
 * and a file that holds only one half is a file somebody can change without
 * noticing that the other half no longer agrees.
 *
 * ## The seam is the normalised input, not a recording proxy
 *
 * The Draft lane wraps `DraftBoardSources` and records what the board asks for,
 * because the board is handed an interface. The Team screen is not: it is handed
 * a `StartSitInput[]` that `server/services/startSitInputs.ts` has already
 * assembled out of eight repositories, and then `assembleLineup` runs over it.
 * So the seam is that array, and capturing it is capturing everything the
 * decision could possibly have read — the player, the betting lines, the
 * previous lines, the kickoff, the newsletter tally, the availability state, the
 * usage series, the stored weeks, the game context, home or away, the opponent
 * tendency table and the mode.
 *
 * That is a *stronger* completeness guarantee than the Draft proxy's, not a
 * weaker one. The proxy records the calls the board happened to make on this
 * board; this records the whole value, including the fields no component read
 * today and one will read next month.
 *
 * ## Replay runs `assembleLineup`
 *
 * The same function `server/app.ts` calls and the same one Demo Mode calls —
 * which is why it was extracted from both. Nothing here re-implements a slot
 * assignment, a swap threshold or a confidence, so nothing here can drift from
 * the thing it is supposed to be describing.
 */

import { assembleLineup } from '../startsit/assemble.ts';
import { LINEUP_ENGINE_VERSION } from '../startsit/version.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { StartSitMode } from '../startsit/mode.ts';
import type { LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import { SnapshotAliases, REDACTION_RULES } from './redaction.ts';
import { sealSnapshot } from './emit.ts';
import { scrubAliases } from './scrub.ts';
import {
  captureLeague,
  captureLeagueRules,
  captureRosters,
  captureStartSitInputs,
  rehydrateLeagueRules,
  rehydrateStartSitInputs,
} from './inseason.ts';
import { countPositions, summariseFreshness } from './freshness.ts';
import {
  classifyOutcome,
  compareStructural,
  describeDifference,
  exact,
  type ReplayReport,
} from './contract.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type SupportSnapshot } from './schema.ts';
import type { LineupPayload } from './payloads.ts';

/** Everything the live route and Demo Mode already hold when they draw the screen. */
export interface LineupCaptureInput {
  /** The deployed revision, from the same plumbing `/api/health` reports. */
  gitSha: string;
  league: LeagueRecord;
  rosters: RosterRecord[];
  /** The roster the decision is on behalf of. */
  mine: RosterRecord;
  shape: RosterShape;
  profile: ScoringProfile;
  inputs: StartSitInput[];
  mode: StartSitMode;
  published: ReadonlyMap<string, number>;
  nflState: NflState | null;
  props: { fetchedAt: string | null; provider: string | null; events: number };
  /** The instant the decision is measured from. */
  now: Date;
}

export function captureLineupSnapshot(input: LineupCaptureInput): SupportSnapshot<LineupPayload> {
  /*
   * The decision, made here rather than passed in.
   *
   * A capture that received the route's already-built lineup would be recording
   * whatever the route happened to hand it, and a route that later stopped
   * passing the same inputs would produce a snapshot describing a decision
   * nobody made. Building it from the captured inputs is what makes the file
   * self-consistent: `output` is what `inputs` produces, by construction.
   */
  const decision = assembleLineup({
    inputs: input.inputs,
    shape: input.shape,
    profile: input.profile,
    currentStarterIds: input.mine.starterIds,
    mode: input.mode,
    published: input.published,
    unknownPlayers: input.mine.playerIds.length - input.inputs.length,
    now: input.now,
  });

  const aliases = new SnapshotAliases();
  const league = captureLeague(input.league, aliases);
  const rosters = captureRosters(input.rosters, aliases, league.id);
  const startSit = captureStartSitInputs(input.inputs);
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
  const output = scrubAliases(decision, aliases) as typeof decision;

  const borrowed = output.slots.filter((slot) => slot.projectionSource === 'sleeper').length;

  return sealSnapshot<LineupPayload>({
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt,
    release: { gitSha: input.gitSha, surface: 'lineup', engineVersion: LINEUP_ENGINE_VERSION },
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
      kind: 'lineup',
      request: { leagueId: league.id, mode: input.mode },
      context: {
        league,
        season: input.league.season,
        week: input.nflState?.week ?? 0,
        scoringLabel: input.profile.label,
        rosterShape: input.shape,
        myRosterId: input.mine.rosterId,
        rosterCounts: countPositions(input.inputs),
      },
      freshness: {
        ...summariseFreshness({
          inputs: [input.inputs],
          props: input.props,
          nflState: input.nflState,
          unknownPlayers: input.mine.playerIds.length - input.inputs.length,
        }),
        borrowedProjections: borrowed,
      },
      inputs: {
        now: capturedAt,
        rules: captureLeagueRules(input.league),
        currentStarterIds: input.mine.starterIds,
        mode: input.mode,
        startSit,
        published: Object.fromEntries(input.published),
        unknownPlayers: input.mine.playerIds.length - input.inputs.length,
        rosters,
      },
      output,
      /*
       * What the lineup said about itself, lifted out of `output`.
       *
       * "What was already known to be wrong" is the first thing a diagnosis
       * should read, and it is still compared inside `output` as well — so
       * lifting it is a convenience for a human and never a second source of
       * truth.
       */
      warnings: output.warnings,
    },
  });
}

export function replayLineupSnapshot(snapshot: SupportSnapshot<LineupPayload>): ReplayReport {
  const { inputs, output } = snapshot.decision;

  const { shape, profile } = rehydrateLeagueRules(inputs.rules);
  const replayed = assembleLineup({
    inputs: rehydrateStartSitInputs(inputs.startSit),
    shape,
    profile,
    currentStarterIds: inputs.currentStarterIds,
    mode: inputs.mode,
    published: new Map(Object.entries(inputs.published)),
    unknownPlayers: inputs.unknownPlayers,
    /*
     * The clock, pinned to the instant the decision was made at.
     *
     * Not decoration: the lineup reads it to decide which games have kicked off,
     * and a snapshot replayed on Monday without it would lock every slot and
     * report an empty optimisation as a difference.
     */
    now: snapshot.capturedAt,
  });

  const differences: ReplayReport['differences'] = [];
  compareStructural('output', output, replayed, differences);
  /*
   * The two claims worth naming separately, on top of the structural walk.
   *
   * Both are inside `output` and both would be caught by the walk. They are
   * called out anyway because they are the two sentences a reader of a failing
   * replay needs first — *is this still the same lineup, and is it still worth
   * the same* — and a term with its own name is a term somebody understands
   * without reading a path.
   */
  exact(
    'lineup',
    'the recommended starters',
    output.slots.map((slot) => `${slot.slot}:${slot.playerId ?? '-'}`).join(' '),
    replayed.slots.map((slot) => `${slot.slot}:${slot.playerId ?? '-'}`).join(' '),
    differences,
  );
  exact('recommendedPoints', 'the lineup total', output.recommendedPoints, replayed.recommendedPoints, differences);

  const engineMatches = snapshot.release.engineVersion === LINEUP_ENGINE_VERSION;
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot),
    kind: 'lineup',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: LINEUP_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: [
      { what: 'starting slots', count: output.slots.length },
      { what: 'players evaluated', count: inputs.startSit.inputs.length },
      { what: 'recommended changes', count: output.swaps.length },
    ],
    differences,
    distillation: [],
  };
}

function summarise(
  outcome: ReplayReport['outcome'],
  differences: ReplayReport['differences'],
  snapshot: SupportSnapshot<LineupPayload>,
): string {
  const { output, context } = snapshot.decision;
  const swaps = output.swaps.length;
  switch (outcome) {
    case 'reproduced':
      return `Reproduced: the same ${output.slots.length} starting slots at ${output.recommendedPoints} points, ${swaps === 0 ? 'with no change to the lineup already set' : `with the same ${swaps} recommended change${swaps === 1 ? '' : 's'}`} — week ${context.week}, ${output.mode}.`;
    case 'engine_version_mismatch':
      return `The weekly engine has moved since capture (${snapshot.release.engineVersion} → ${LINEUP_ENGINE_VERSION}) and the lineup came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every lineup term matched; only the age of the data behind it read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The lineup reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
