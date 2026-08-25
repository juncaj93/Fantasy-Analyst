/**
 * Everything the DST planner reads, assembled once per request.
 *
 * The same job `startSitInputs.ts` does for the weekly engine, and it lives
 * beside it for the same reason: Team and Waivers both draw the defence
 * recommendation, they draw it from one response, and two assemblies would be
 * two answers to one question on two screens of the same app.
 *
 * ## What it costs, and why that is the shape it is
 *
 * Three D1 reads on top of what the waiver scan already loads, all bounded and
 * none of them a fetch:
 *
 *   1. **the coming week's fixtures** — thirty-two rows, and the reason the
 *      defence model finally has a home-field term;
 *   2. **the planner's teams over the planner's weeks** — the rostered defences
 *      and the bounded free-agent pool, across the next few weeks and the
 *      league's own playoff weeks. About a hundred rows;
 *   3. **the implied total each offence has been priced at this season** —
 *      aggregated in SQL, at most one row per team.
 *
 * No provider is called, no cron is added and nothing is backfilled. The Vegas
 * budget is untouched: every number here comes out of rows some earlier refresh
 * already paid for.
 *
 * ## The one thing it will not do
 *
 * It will not invent a line. Where the market has priced a future game the
 * planner gets the real anchor; where it has not, it gets the opponent's own
 * season average clearly marked as such, and where there is neither it gets
 * nothing. See `core/dst/outlook.ts`.
 */

import { NflScheduleRepo } from '../repos/nflSchedule.ts';
import { VegasEventsRepo } from '../repos/vegasEvents.ts';
import { evaluatePlayer, DEFENCE_POSITION, type StartSitInput } from '../../core/startsit/engine.ts';
import { assessStreaming } from '../../core/startsit/streaming.ts';
import { evaluateBench } from '../../core/roster/bench.ts';
import { buildHeldPlayers } from '../../core/roster/held.ts';
import { planDst, DST_PLAN, type DstOption, type DstPlan } from '../../core/dst/planner.ts';
import { dstOutlook, forwardWeeks, type DstOutlook, type TeamForm } from '../../core/dst/outlook.ts';
import type { LineupRecommendation } from '../../core/startsit/lineup.ts';
import type { RosterShape, ScoringProfile } from '../../core/sleeper/scoring.ts';
import { playoffEmphasis, playoffWeeks } from '../../core/league/planning.ts';
import { readFinalWeek } from './leagueStrategyService.ts';
import type { RosterRecord } from '../../core/sleeper/types.ts';
import type { ScheduleTeamWeek } from '../../core/nfl/schedule.ts';
import type { Database } from '../db.ts';

/**
 * How close a stored betting event has to be to a fixture to be that fixture.
 *
 * A schedule kickoff is built from a date and an Eastern wall-clock time; a
 * betting event's kickoff arrives with an offset on it from somebody else's
 * feed. They agree to within minutes in practice and neither is worth trusting
 * to the minute, so the match is made on the day — wide enough to survive a
 * flexed start time, narrow enough that it cannot reach the next week.
 */
const EVENT_MATCH_HOURS = 36;

export interface DstPlanRequest {
  season: string;
  week: number;
  shape: RosterShape;
  profile: ScoringProfile;
  bestBall: boolean;
  draftComplete: boolean;
  /** The user's own players, already assembled for the weekly engine. */
  rosterInputs: StartSitInput[];
  /** The bounded free-agent pool, likewise. */
  candidateInputs: StartSitInput[];
  lineup: LineupRecommendation;
  reserveIds: string[];
  playoff: { weeks: number[]; emphasis: number };
  now?: Date;
}

/**
 * Build the plan, or return null when a defence is not a question in this
 * league.
 *
 * Null before any read at all in the two suppressed cases, which is not only a
 * cost saving: a league that starts no defence should not have its schedule
 * fetched to be told so.
 */
export async function buildDstPlan(db: Database, request: DstPlanRequest): Promise<DstPlan | null> {
  const slots = request.shape.starters[DEFENCE_POSITION] ?? 0;
  if (slots === 0 || request.bestBall) {
    return planDst(emptyInput(request));
  }

  const now = request.now ?? new Date();
  const rosteredDef = request.rosterInputs.filter((i) => isDefence(i));
  const availableDef = request.candidateInputs.filter((i) => isDefence(i));
  if (rosteredDef.length === 0 && availableDef.length === 0) return planDst(emptyInput(request));

  const teams = [...new Set([...rosteredDef, ...availableDef].map((i) => (i.player.team ?? '').toUpperCase()))].filter(
    (t) => t.length > 0,
  );

  const forward = forwardWeeks(request.week, DST_PLAN.holdHorizon);
  const playoffWeeks = [...request.playoff.weeks].sort((a, b) => a - b);
  const wanted = [...new Set([request.week, ...forward, ...playoffWeeks])].sort((a, b) => a - b);

  const scheduleRepo = new NflScheduleRepo(db);
  const [thisWeekFixtures, teamSchedule, form] = await Promise.all([
    scheduleRepo.forWeek(request.season, request.week).catch(() => [] as ScheduleTeamWeek[]),
    scheduleRepo
      .forTeams(request.season, teams, { from: wanted[0] ?? request.week, to: wanted.at(-1) ?? request.week })
      .catch(() => [] as ScheduleTeamWeek[]),
    new VegasEventsRepo(db)
      .impliedTotalsByTeam(seasonStartIso(request.season), now.toISOString())
      .catch(() => new Map<string, TeamForm>()),
  ]);

  /*
   * The kickoff the advice has to be acted on before.
   *
   * The earliest fixture of the coming week, from the stored schedule. A
   * recommendation to add a defence is only actionable while the games it would
   * be played in are still ahead, and the *first* of them is the honest
   * deadline for the decision as a whole.
   */
  const nextKickoff = earliestKickoff(thisWeekFixtures, now);

  const scheduleByTeam = new Map<string, ScheduleTeamWeek[]>();
  for (const row of teamSchedule) {
    const key = row.team.toUpperCase();
    const bucket = scheduleByTeam.get(key);
    if (bucket) bucket.push(row);
    else scheduleByTeam.set(key, [row]);
  }

  /*
   * Lines for future weeks, where the market has actually reached them.
   *
   * Usually one week and often none — a book prices the coming Sunday and not
   * December — which is exactly the asymmetry `dstOutlook` was built to report
   * rather than paper over. Matched to a fixture by day so an event can never
   * be attributed to the wrong week.
   */
  const lines = futureLines(request.rosterInputs, request.candidateInputs, scheduleByTeam);

  const outlookFor = (team: string, weeks: number[]): DstOutlook | null => {
    const schedule = scheduleByTeam.get(team.toUpperCase()) ?? [];
    if (schedule.length === 0 || weeks.length === 0) return null;
    return dstOutlook({
      team,
      scoring: request.profile.dst,
      schedule,
      weeks,
      lines: lines.get(team.toUpperCase()) ?? new Map<number, number>(),
      form,
    });
  };

  /*
   * The stash window, and it is closed for most of the season.
   *
   * A playoff outlook is built only once the league's own emphasis says the
   * weeks are worth weighting — the same gate `plan` uses — so the ordinary
   * October request does none of this work and, more to the point, is never
   * offered a December recommendation it cannot act on yet.
   */
  const stashOpen = request.playoff.emphasis >= DST_PLAN.stashEmphasis && playoffWeeks.length > 0;

  const toOption = (input: StartSitInput): DstOption => {
    const evaluation = evaluatePlayer(input, request.profile);
    const team = (input.player.team ?? '').toUpperCase();
    return {
      playerId: evaluation.playerId,
      name: evaluation.name,
      team,
      thisWeek: evaluation.score,
      confidence: evaluation.confidence,
      /*
       * Unavailable is a lineup fact, not a judgement about the unit: a defence
       * on a bye has no game, one that is locked cannot be changed, and one
       * ruled out cannot be started. All three mean the same thing to a planner
       * and none of them means the defence is bad.
       */
      unavailable: evaluation.ruledOut || evaluation.lock.locked || evaluation.score == null,
      unavailableReason: unavailableReason(evaluation, input),
      locked: evaluation.lock.locked,
      opponent: evaluation.opponent,
      opponentImpliedTotal: evaluation.dst?.opponentImpliedTotal ?? null,
      forward: outlookFor(team, forward),
      playoff: stashOpen ? outlookFor(team, playoffWeeks) : null,
    };
  };

  const rostered = rosteredDef.map(toOption);
  const available = availableDef.map(toOption);

  /*
   * The wire's own level, through the module written for exactly this.
   *
   * `assessStreaming` sets replacement level at the median of the top few
   * available defences rather than at the best of them, which is the difference
   * between "somebody had a good matchup" and "the wire is this good every
   * week". The planner spends it twice: once to say a swap is not scarce, and
   * once to give a playoff stash something real to beat.
   */
  const streaming = assessStreaming({
    position: DEFENCE_POSITION,
    roster: rosteredDef,
    available: availableDef,
    shape: request.shape,
    profile: request.profile,
    now,
  });

  return planDst({
    now,
    currentWeek: request.week,
    shape: request.shape,
    bestBall: request.bestBall,
    draftComplete: request.draftComplete,
    nextKickoff,
    rostered,
    available,
    streaming,
    roster: rosterCost(request),
    playoff: { weeks: playoffWeeks, emphasis: request.playoff.emphasis },
  });
}

/**
 * What a roster spot costs, from the drop list the Bench screen already draws.
 *
 * Reused rather than re-derived: `evaluateBench` scores every held player as a
 * *slot* — what it earns against what the wire would put in it — and its worst
 * surplus is precisely the thing an add spends. A protected player (a starter,
 * somebody on IR) is never offered, which is the same rule that governs the
 * screen, enforced in the same place.
 */
function rosterCost(request: DstPlanRequest): { openSpots: number; dropCandidate: null | { playerId: string; name: string; position: string; surplus: number | null } } {
  const reserve = new Set(request.reserveIds);
  const active = request.rosterInputs.filter((i) => !reserve.has(i.player.id)).length;
  const capacity = request.shape.totalStarters + request.shape.benchSlots;
  const openSpots = Math.max(0, capacity - active);

  if (openSpots > 0) return { openSpots, dropCandidate: null };

  const bench = evaluateBench(
    buildHeldPlayers({
      rosterInputs: request.rosterInputs,
      candidateInputs: request.candidateInputs,
      lineup: request.lineup,
      profile: request.profile,
      reserveIds: request.reserveIds,
    }),
  );
  /*
   * A defence is never its own drop candidate.
   *
   * Streaming already replaces the rostered defence with the one being streamed
   * to, so counting it here would charge the same spot twice and let a swap
   * look free because the thing it displaces is the thing it replaces.
   */
  const candidate = bench.dropCandidates.find((c) => c.position.toUpperCase() !== DEFENCE_POSITION) ?? null;
  if (!candidate) return { openSpots: 0, dropCandidate: null };

  /*
   * A surplus built on nothing is not a surplus.
   *
   * `valueOfSlot` returns a number for everybody, including a player it could
   * not score at all — for whom the number is entirely the optionality and
   * bye-cover terms over a base of zero. Passing that on as a price would put a
   * confident figure on the app's own ignorance, so it is turned back into the
   * null the planner is built to handle.
   */
  const scorable = candidate.components.some((c) => c.key === 'value' && c.note !== 'no scorable value');
  return {
    openSpots: 0,
    dropCandidate: {
      playerId: candidate.playerId,
      name: candidate.name,
      position: candidate.position,
      surplus: scorable ? candidate.surplus : null,
    },
  };
}

function futureLines(
  rosterInputs: readonly StartSitInput[],
  candidateInputs: readonly StartSitInput[],
  scheduleByTeam: ReadonlyMap<string, ScheduleTeamWeek[]>,
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const input of [...rosterInputs, ...candidateInputs]) {
    if (!isDefence(input)) continue;
    const team = (input.player.team ?? '').toUpperCase();
    const game = input.game ?? null;
    if (!game || game.total == null || game.spread == null || !input.kickoff) continue;

    const fixtures = scheduleByTeam.get(team) ?? [];
    const at = new Date(input.kickoff).getTime();
    if (!Number.isFinite(at)) continue;
    const match = fixtures.find(
      (f) => f.kickoff != null && Math.abs(new Date(f.kickoff).getTime() - at) <= EVENT_MATCH_HOURS * 3_600_000,
    );
    if (!match) continue;

    const bucket = out.get(team) ?? new Map<number, number>();
    /* The same arithmetic, the same sign convention, as `dstProjection.ts`. */
    bucket.set(match.week, Math.round((game.total / 2 + game.spread / 2) * 10) / 10);
    out.set(team, bucket);
  }
  return out;
}

function earliestKickoff(fixtures: readonly ScheduleTeamWeek[], now: Date): string | null {
  let earliest: number | null = null;
  for (const row of fixtures) {
    if (!row.kickoff) continue;
    const at = new Date(row.kickoff).getTime();
    if (!Number.isFinite(at) || at <= now.getTime()) continue;
    if (earliest == null || at < earliest) earliest = at;
  }
  return earliest == null ? null : new Date(earliest).toISOString();
}

function unavailableReason(
  evaluation: { ruledOut: boolean; lock: { locked: boolean }; score: number | null; statusFlag: string | null },
  input: StartSitInput,
): string | null {
  if (evaluation.ruledOut) return `is ${(evaluation.statusFlag ?? 'out').toLowerCase()}`;
  if (evaluation.lock.locked) return 'has already kicked off';
  if (evaluation.score == null) return input.game == null ? 'is on bye' : 'cannot be scored this week';
  return null;
}

function isDefence(input: StartSitInput): boolean {
  return (input.player.position ?? '').toUpperCase() === DEFENCE_POSITION;
}

/**
 * The first of September, which is before every season opener and after every
 * previous one.
 *
 * Used only to bound the form aggregate to the season in play. A preseason game
 * inside the window is not a problem: this app has never stored a line for one.
 */
function seasonStartIso(season: string): string {
  const year = Number(season);
  return Number.isFinite(year) ? `${year}-09-01T00:00:00.000Z` : '1970-01-01T00:00:00.000Z';
}

function emptyInput(request: DstPlanRequest) {
  return {
    now: request.now ?? new Date(),
    currentWeek: request.week,
    shape: request.shape,
    bestBall: request.bestBall,
    draftComplete: request.draftComplete,
    nextKickoff: null,
    rostered: [],
    available: [],
    streaming: null,
    roster: { openSpots: 0, dropCandidate: null },
    playoff: request.playoff,
  };
}

/**
 * The league's own playoff weeks, and how much they are allowed to matter yet.
 *
 * One reader, shared by the plan endpoint and the defence planner, because two
 * screens that disagreed about when the playoffs start would disagree about
 * whether a stash is worth a bench spot — and one of them would be wrong about
 * a fact the league publishes.
 *
 * `readFinalWeek` is the canonical reader and validates the range before it
 * trusts the value: a real league was found publishing a `playoff_week_start`
 * that was not a usable week, survived a `??` default, and produced an empty
 * list of playoff weeks in production.
 */
export function playoffContextFor(opts: {
  leagueSettings: Record<string, unknown> | null | undefined;
  rosters: readonly RosterRecord[];
  mine: RosterRecord | null;
  totalRosters: number;
  currentWeek: number;
}): { weeks: number[]; emphasis: number; reason: string; startWeek: number; startWeekPublished: boolean; record: { wins: number; losses: number } | null } {
  const startWeek = readFinalWeek(opts.leagueSettings ?? {}) + 1;
  const raw = Number(opts.leagueSettings?.['playoff_week_start']);
  const startWeekPublished = Number.isFinite(raw) && raw > 1 && raw <= 19;
  const playoffTeams = Number(opts.leagueSettings?.['playoff_teams'] ?? 6);

  const settings = (opts.mine?.settings ?? null) as Record<string, unknown> | null;
  const record = {
    wins: Number(settings?.['wins'] ?? 0) || 0,
    losses: Number(settings?.['losses'] ?? 0) || 0,
  };

  const emphasis = playoffEmphasis({
    currentWeek: opts.currentWeek,
    playoffStartWeek: startWeek,
    wins: record.wins,
    losses: record.losses,
    playoffTeams,
    totalTeams: opts.rosters.length || opts.totalRosters,
  });

  return {
    weeks: playoffWeeks(startWeek),
    emphasis: emphasis.weight,
    reason: emphasis.reason,
    startWeek,
    startWeekPublished,
    record: settings ? record : null,
  };
}
