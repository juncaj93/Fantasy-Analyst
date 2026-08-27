/**
 * Capturing and replaying a Matchup / Best Move decision.
 *
 * The one in-season surface that already had an interface, so this is the Draft
 * lane's design unchanged: a **recording proxy** around `MatchupSources`, and
 * the assembly itself decides what goes in the file by asking for it. A member
 * added to that interface fails to compile here and in the replay until both
 * have been taught about it.
 *
 * ## Two members the proxy does not pass through, and why
 *
 * `cached()` and `remember()` are the service's process-local memo, and a
 * capture must touch neither.
 *
 *   - **`cached()` answers null.** A capture that accepted a memoised response
 *     would record the inputs it read *now* beside a forecast computed from the
 *     state of some earlier request. The file would be internally inconsistent
 *     in exactly the way that makes a replay disagree with itself, and there
 *     would be nothing in it to say so;
 *   - **`remember()` does nothing.** Writing the capture's own recomputation
 *     into the live memo would make a diagnostic change the thing being
 *     diagnosed — the next screen load would be served a response produced by
 *     the support button. `MatchupSources` has no other writer on it, which is
 *     why this is the only one to close.
 *
 * Recomputing costs one simulation and is deterministic: `buildForecast` seeds
 * itself from the matchup-state fingerprint rather than from `Math.random`, and
 * the fingerprint is a function of the recorded inputs.
 *
 * ## The one provider read
 *
 * `matchups()` goes to Sleeper for the scoreboard, and it is the only read on
 * this path that leaves the process. It is the identical request the Matchup
 * screen makes every time it is opened — the same endpoint, the same week, no
 * write, no ingestion, no refresh, and nothing stored as a result. Sleeper owns
 * the score and this app never recomputes it, so a snapshot that invented the
 * scoreboard rather than reading it would be a snapshot of a different game.
 */

import { buildMatchupResponse, type MatchupResponse, type MatchupSources } from '../matchup/build.ts';
import { MATCHUP_ENGINE_VERSION } from '../matchup/version.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { LeagueRecord, RosterRecord, SleeperMatchup } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import { buildRosterShape, buildScoringProfile } from '../sleeper/scoring.ts';
import { SnapshotAliases, REDACTION_RULES } from './redaction.ts';
import { sealSnapshot, SnapshotUnavailable } from './emit.ts';
import { scrubAliases } from './scrub.ts';
import {
  captureLeague,
  captureRosters,
  captureStartSitInputs,
  rehydrateRosters,
  rehydrateStartSitInputs,
} from './inseason.ts';
import { countPositions, summariseFreshness } from './freshness.ts';
import { classifyOutcome, compareStructural, describeDifference, exact, type ReplayReport } from './contract.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type SupportSnapshot } from './schema.ts';
import type { MatchupPayload } from './payloads.ts';

export interface MatchupCaptureOptions {
  gitSha: string;
  leagueId: string;
  week?: number | null;
  props: { fetchedAt: string | null; provider: string | null; events: number };
}

/** Everything the assembly asked its sources for, in the shapes they answered in. */
export interface RecordedMatchupReads {
  now: Date | null;
  league: LeagueRecord | null;
  rosters: RosterRecord[];
  matchups: SleeperMatchup[];
  nflState: NflState | null;
  startSitRequested: string[];
  startSitInputs: StartSitInput[];
  published: Map<string, number>;
  publishedAvailable: boolean;
  previousForecast: Record<string, unknown> | null;
}

/**
 * Wrap sources so that using them records them.
 *
 * `now()` is remembered on first call and re-served from that instant for the
 * rest of the capture: the assembly reads the clock more than once — the season
 * context, and each starter's lock — and a capture whose readings straddled a
 * millisecond boundary would record one instant and have been built against two.
 */
export function recordMatchupSources(
  inner: MatchupSources,
  aliases: SnapshotAliases,
): {
  sources: MatchupSources;
  seen(): RecordedMatchupReads;
} {
  const seen: RecordedMatchupReads = {
    now: null,
    league: null,
    rosters: [],
    matchups: [],
    nflState: null,
    startSitRequested: [],
    startSitInputs: [],
    published: new Map(),
    publishedAvailable: inner.publishedProjections != null,
    previousForecast: null,
  };

  const sources: MatchupSources = {
    leagues: {
      /*
       * The real id, and an aliased name.
       *
       * The id has to stay real: it is hashed into the fingerprint that seeds
       * the simulation, so aliasing it here would draw a different afternoon
       * than the one the user saw. The *name* is not hashed into anything and is
       * echoed straight back in the response header, so it is replaced before
       * the assembly ever sees it.
       */
      getLeague: async (id) => {
        const league = await inner.leagues.getLeague(id);
        seen.league = league;
        if (league == null) return null;
        aliases.label(league.name, aliases.scope('league', league.id) ?? 'league-1');
        return { ...league, name: aliases.scrubIdentifiers(league.name) };
      },
      /*
       * And aliased rosters, before the assembly composes a name into anything.
       *
       * A matchup names both managers on its header and in several of its
       * insight sentences. Aliasing afterwards would mean replacing a display
       * name inside prose, which cannot be made safe — see `scrub.ts`.
       */
      listRosters: async (id) => {
        const rosters = await inner.leagues.listRosters(id);
        seen.rosters = rosters;
        return rosters.map((roster) => ({
          ...roster,
          ownerId: aliases.id(roster.ownerId),
          ownerName: aliases.name(roster.ownerName, roster.ownerId),
        }));
      },
    },
    matchups: async (league, week) => (seen.matchups = await inner.matchups(league, week)),
    nflState: async () => (seen.nflState = await inner.nflState()),
    startSitInputs: async (playerIds) => {
      seen.startSitRequested = [...playerIds];
      return (seen.startSitInputs = await inner.startSitInputs(playerIds));
    },
    previousForecast: async (opts) => {
      const previous = await inner.previousForecast(opts);
      seen.previousForecast = previous as unknown as Record<string, unknown> | null;
      return previous;
    },
    /* See the module note: null, so the forecast is the one these inputs make. */
    cached: () => null,
    /* And a no-op, so a diagnostic cannot change what the next screen is served. */
    remember: () => {},
    now: () => {
      seen.now ??= inner.now();
      return new Date(seen.now.getTime());
    },
  };

  if (inner.publishedProjections) {
    const published = inner.publishedProjections.bind(inner);
    sources.publishedProjections = async (opts) => {
      const figures = await published(opts);
      for (const [id, value] of figures) seen.published.set(id, value);
      return figures;
    };
  }

  return { sources, seen: () => seen };
}

export async function captureMatchupSnapshot(
  sources: MatchupSources,
  options: MatchupCaptureOptions,
): Promise<SupportSnapshot<MatchupPayload>> {
  const aliases = new SnapshotAliases();
  const recorder = recordMatchupSources(sources, aliases);
  const response = await buildMatchupResponse(recorder.sources, options.leagueId, {
    week: options.week ?? null,
  });
  const seen = recorder.seen();
  if (!seen.league) throw new SnapshotUnavailable('league not found', 404);
  /*
   * No matchup, no snapshot.
   *
   * `found: false` is a real and common state — a week Sleeper has not scheduled
   * yet, a roster not in this week's schedule — and the assembly says which in
   * `reason`. Capturing it anyway would emit a file with no lineups, no
   * distributions and no forecast in it: a bug report that contains nothing,
   * which somebody would send and then wait on. The sentence the screen would
   * have shown is a better answer than a file.
   */
  if (!response.found) {
    throw new SnapshotUnavailable(response.reason ?? 'There is no matchup to capture for this week.');
  }

  const league = captureLeague(seen.league, aliases);
  const rosters = captureRosters(seen.rosters, aliases, league.id);
  const capturedAt = (seen.now ?? new Date(0)).toISOString();
  const mine = seen.rosters.find((roster) => roster.isMine) ?? null;
  const profile = buildScoringProfile(seen.league.scoringSettings, seen.league.rosterPositions);

  /*
   * Which of my starters' games are over.
   *
   * A player whose game has reached `final` carries Sleeper's settled points and
   * is never re-simulated, so this count is the difference between a forecast
   * and a scoreboard — and a reader asking why the win probability "will not
   * move" is asking about this number.
   */
  /*
   * The decision, with every identity that reached it replaced.
   *
   * The inputs are aliased above; this is the other half, and it is the half
   * that has caught this app twice. An engine that composes a league id or a
   * manager's name into a string produces an output that a verbatim copy would
   * carry straight past every alias in the file. Run after every alias has been
   * allocated, so it can only ever replace. See `scrub.ts`.
   */
  const output = scrubAliases(response, aliases) as typeof response;

  const settled = output.forecast?.slots.filter((slot) => slot.mine?.phase === 'final').length ?? 0;

  return sealSnapshot<MatchupPayload>({
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt,
    release: { gitSha: options.gitSha, surface: 'matchup', engineVersion: MATCHUP_ENGINE_VERSION },
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
      kind: 'matchup',
      request: { leagueId: league.id, week: options.week ?? null },
      context: {
        league,
        season: output.season,
        week: output.week,
        scoringLabel: profile.label,
        rosterShape: buildRosterShape(seen.league.rosterPositions),
        myRosterId: mine?.rosterId ?? null,
        opponentRosterId:
          output.forecast?.teams.theirs.rosterId ?? null,
        rosterCounts: countPositions(seen.startSitInputs),
      },
      freshness: {
        ...summariseFreshness({
          inputs: [seen.startSitInputs],
          props: options.props,
          nflState: seen.nflState,
          unknownPlayers: seen.startSitRequested.length - seen.startSitInputs.length,
        }),
        degraded: output.forecast?.degraded ?? true,
        settled,
      },
      inputs: {
        now: capturedAt,
        league,
        rosters,
        matchups: seen.matchups,
        nflState: seen.nflState,
        startSit: captureStartSitInputs(seen.startSitInputs),
        startSitRequested: seen.startSitRequested,
        published: Object.fromEntries(seen.published),
        publishedAvailable: seen.publishedAvailable,
        previousForecast: seen.previousForecast,
      },
      output,
      /*
       * What the forecast said about itself.
       *
       * A degraded forecast is the single most important thing a Matchup report
       * can carry, because a degraded model must never be readable as a
       * confident `Hold your lineup` — so it is lifted here where it is read
       * first, as well as compared inside `output`.
       */
      warnings: output.forecast?.degraded
        ? ['The forecast is degraded: no distribution could be built, so only the scoreboard stands.']
        : [],
    },
  });
}

/**
 * Sources that serve one snapshot and nothing else.
 *
 * Every method is a lookup in a value. There is no fetch, no repository, no
 * database handle and no Sleeper client anywhere in the object, which is what
 * makes "replay needs no live provider access" a property of the value rather
 * than a claim about the environment.
 */
export function snapshotMatchupSources(snapshot: SupportSnapshot<MatchupPayload>): MatchupSources {
  const inputs = snapshot.decision.inputs;
  const fixedClock = Date.parse(snapshot.capturedAt);
  const startSit = rehydrateStartSitInputs(inputs.startSit);
  const byId = new Map(startSit.map((input) => [input.player.id, input]));
  const published = new Map(Object.entries(inputs.published));

  const sources: MatchupSources = {
    leagues: {
      getLeague: async (id) => (inputs.league.id === id ? (inputs.league as unknown as never) : null),
      listRosters: async (leagueId) =>
        inputs.league.id === leagueId ? (rehydrateRosters(inputs.rosters) as never) : ([] as never),
    },
    matchups: async () => inputs.matchups,
    nflState: async () => inputs.nflState,
    /*
     * Answered in the order asked for, from what the capture recorded.
     *
     * Not the recorded array verbatim: the assembly asks for a specific set of
     * ids and a source that answered with a different set — or a different
     * order — would be a different source. A player the capture could not
     * resolve is still absent here, which is what `startSitInputs` itself does.
     */
    startSitInputs: async (playerIds) =>
      playerIds.map((id) => byId.get(id)).filter((input): input is (typeof startSit)[number] => input != null),
    previousForecast: async () => inputs.previousForecast as never,
    cached: () => null,
    remember: () => {},
    now: () => new Date(fixedClock),
  };

  /*
   * Present only when the capture recorded that the live source had it.
   *
   * An optional member that always exists is not optional, and a source that
   * cannot quote a published figure produces different cards from one that
   * looked and found none.
   */
  if (inputs.publishedAvailable) {
    sources.publishedProjections = async ({ playerIds }) => {
      const out = new Map<string, number>();
      for (const id of playerIds) {
        const value = published.get(id);
        if (value != null) out.set(id, value);
      }
      return out;
    };
  }

  return sources;
}

export async function replayMatchupSnapshot(snapshot: SupportSnapshot<MatchupPayload>): Promise<ReplayReport> {
  const { request, output } = snapshot.decision;
  const replayed = await buildMatchupResponse(snapshotMatchupSources(snapshot), request.leagueId, {
    week: request.week,
    /*
     * The seed the live forecast drew with, handed back.
     *
     * The league id is hashed into the fingerprint that seeds the simulation,
     * and the snapshot replaces that id with an alias — because a Sleeper league
     * id is one public URL away from every manager's username. Without this the
     * replay would draw a different afternoon and disagree with its own capture
     * by a fraction of a point of win probability, with no way to tell that
     * apart from a regression.
     *
     * Absent in a snapshot written before the seed travelled, which replays as
     * it always did: the alias seeds it, and the difference shows up as an
     * honest `output_difference` rather than as a silent one.
     */
    ...(output.forecast?.seed === undefined ? {} : { seed: output.forecast.seed }),
  });

  const differences: ReplayReport['differences'] = [];
  compareStructural('output', output, replayed, differences);

  /*
   * The four claims the Matchup lane exists to hold, named separately.
   *
   * All four are inside `output` and all four would be caught by the walk. They
   * are called out because they are the sentences a report is about: *did it
   * still say hold, is it still the same swap, is the win probability still the
   * same number, and is a degraded forecast still admitting it*. A reader of a
   * failing replay should meet those before meeting a path.
   */
  exact('decision.verdict', 'Best Move', verdictOf(output), verdictOf(replayed), differences);
  exact('decision.swap', 'Best Move', swapOf(output), swapOf(replayed), differences);
  exact(
    'winProbability',
    'the forecast',
    output.forecast?.teams.mine.winProbability ?? null,
    replayed.forecast?.teams.mine.winProbability ?? null,
    differences,
  );
  exact(
    'degraded',
    'the forecast',
    output.forecast?.degraded ?? null,
    replayed.forecast?.degraded ?? null,
    differences,
  );
  /*
   * The seed is compared as well as supplied.
   *
   * It is what every number in the forecast was drawn from, so a replay whose
   * seed differs is not reproducing the matchup even if the draws happen to land
   * in the same place. Checking it turns "the samples matched" from a
   * coincidence into a consequence.
   */
  exact('seed', 'the simulation', output.forecast?.seed ?? null, replayed.forecast?.seed ?? null, differences);

  const engineMatches = snapshot.release.engineVersion === MATCHUP_ENGINE_VERSION;
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot),
    kind: 'matchup',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: MATCHUP_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: [
      { what: 'starting slots', count: output.forecast?.slots.length ?? 0 },
      { what: 'weekly cards', count: Object.keys(output.cards).length },
      { what: 'insights', count: output.forecast?.insights.length ?? 0 },
    ],
    differences,
    distillation: [],
  };
}

/** Whether a change is being offered, and — when it is not — exactly why not. */
function verdictOf(response: MatchupResponse): string {
  const decision = response.forecast?.decision;
  if (decision == null) return 'no-forecast';
  if (decision.best != null) return 'swap';
  /*
   * `note` is the whole of the distinction the brief asks for.
   *
   * "Hold your lineup" is one word on the screen and four different states
   * underneath it: every candidate locked, nobody legal for the slot, a legal
   * candidate that does not improve the odds, and no bench at all. The decision
   * layer writes which one into `note` — see `core/matchup/decision.ts` — and
   * comparing the note is the only way a replay can tell them apart, so it is
   * compared as part of the verdict rather than beside it.
   */
  return `hold: ${decision.note ?? 'no reason given'}`;
}

/** The swap, as ids and both win probabilities, so before/after is checkable. */
function swapOf(response: MatchupResponse): string {
  const best = response.forecast?.decision.best ?? null;
  return best == null
    ? 'none'
    : `${best.inPlayerId} into ${best.slot} over ${best.outPlayerId} (${best.winNow} → ${best.winAfter})`;
}

function summarise(
  outcome: ReplayReport['outcome'],
  differences: ReplayReport['differences'],
  snapshot: SupportSnapshot<MatchupPayload>,
): string {
  const { output, context } = snapshot.decision;
  const verdict = verdictOf(output);
  switch (outcome) {
    case 'reproduced':
      return `Reproduced: week ${context.week}, the same projected final and win probability, and the same Best Move verdict (${verdict}).`;
    case 'engine_version_mismatch':
      return `The matchup engine has moved since capture (${snapshot.release.engineVersion} → ${MATCHUP_ENGINE_VERSION}) and the forecast came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every forecast term matched; only the age of the data behind it read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The forecast reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
