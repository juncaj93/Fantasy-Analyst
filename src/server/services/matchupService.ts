/**
 * The Matchup screen's one request.
 *
 * ## The division of labour, which is the whole design
 *
 * **Sleeper owns the truth.** Who is playing whom, which players are in which
 * lineup slots, what everybody has actually scored. All of it comes from
 * `/league/:id/matchups/:week` and none of it is recomputed, adjusted or
 * second-guessed here. Sleeper also publishes its own projection on the same
 * payload; it is read nowhere in this file, and §33 says why: a number labelled
 * "Fantasy Analyst projected" that is actually Sleeper's would be the single
 * most misleading thing this app could show.
 *
 * **Fantasy Analyst owns the forecast.** Every projection comes from the
 * existing start/sit engine — the same components, the same Vegas expectation,
 * the same injury model, the same usage read, the same league scoring — and the
 * matchup layer turns those into distributions and simulates them. Nothing here
 * scores a player; it asks the thing that already does.
 *
 * ## Availability is passed to the mixture, not to the mean
 *
 * The one adjustment made to an engine score before it becomes a projection:
 * the availability component is subtracted out. The engine charges a
 * Questionable player points for being questionable, and this model carries the
 * same fact as a mixture over playing / playing limited / not playing. Leaving
 * both in would charge him twice, which is the double-counting the brief
 * forbids in §3. Everything else about the score is passed through untouched.
 *
 * ## What it costs
 *
 * One Sleeper request, the same indexed reads the Team screen already makes,
 * and one simulation — gated on the matchup-state fingerprint, so a poll that
 * finds nothing changed costs the Sleeper request and nothing else.
 */

import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { SleeperMatchup } from '../../core/sleeper/types.ts';
import { buildScoringProfile, FLEX_ELIGIBILITY } from '../../core/sleeper/scoring.ts';
import { evaluatePlayer, type StartSitEvaluation } from '../../core/startsit/engine.ts';
import { buildWeeklyCard, type WeeklyCard } from '../../core/startsit/weekCard.ts';
import { buildForecast, forecastFingerprint, slotKey, type MatchupForecast } from '../../core/matchup/model.ts';
import type { SlotSpec } from '../../core/matchup/decision.ts';
import type { PreviousInsightState } from '../../core/matchup/insights.ts';
import type { MatchupPlayerInput, MatchupSide } from '../../core/matchup/types.ts';
import { LeagueRepo } from '../repos/league.ts';
import { MatchupRepo } from '../repos/matchup.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { resolveSeasonContext } from '../../core/season/context.ts';
import type { NflState } from '../../core/sleeper/phase.ts';
import { startSitInputsFor } from './startSitInputs.ts';
import type { Database } from '../db.ts';

/** What the endpoint returns. The forecast, plus who and when. */
export interface MatchupResponse {
  league: { id: string; name: string; season: string; scoringLabel: string };
  week: number;
  season: string;
  /** True when this league has scheduled no matchup for this week. */
  found: boolean;
  /** Why, when it is not found. */
  reason: string | null;
  forecast: MatchupForecast | null;
  /**
   * The concise weekly card for every player in the matchup, by id.
   *
   * Built here rather than fetched on tap, because §34 asks for a player sheet
   * that opens instantly and a card that costs a request does not. It is the
   * same builder the Team screen uses, from the same evaluations, so the two
   * screens cannot describe the same player differently.
   */
  cards: Record<string, WeeklyCard>;
  /** True when the forecast was served from cache rather than recomputed. */
  cached: boolean;
}

/**
 * Forecasts, keyed by the state that produced them.
 *
 * Module state keyed by the database object rather than a global, exactly like
 * the refresh orchestrator's dedupe: two deployments (or two tests) sharing a
 * process must not be able to serve each other's matchups. A Worker isolate
 * lives long enough to absorb a burst of polling and short enough that this
 * never becomes a store.
 */
const CACHE = new WeakMap<Database, { fingerprint: string; response: MatchupResponse }>();

export class MatchupService {
  constructor(
    private readonly db: Database,
    private readonly deps: { sleeper: SleeperClient; now?: () => Date },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The current — or a named — week's matchup for the league's own roster.
   *
   * The week comes from Sleeper's `/state/nfl` unless the caller names one, and
   * it is never computed from the calendar: see `core/season/context.ts` for
   * the six copies of that arithmetic this app deleted.
   */
  async forLeague(leagueId: string, opts: { week?: number | null } = {}): Promise<MatchupResponse> {
    const now = this.now();
    const leagueRepo = new LeagueRepo(this.db);
    const league = await leagueRepo.getLeague(leagueId);
    if (!league) throw new Error('league not found');

    const state = await new SettingsRepo(this.db).get<NflState | null>(SETTING_KEYS.nflState, null);
    const context = resolveSeasonContext({ state, league: { season: league.season }, now });
    const week = resolveWeek(opts.week ?? null, context.week);

    const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
    const base = {
      league: { id: league.id, name: league.name, season: league.season, scoringLabel: profile.label },
      week,
      season: league.season,
    };

    const rosters = await leagueRepo.listRosters(league.id);
    const mine = rosters.find((r) => r.isMine) ?? null;
    if (!mine) {
      return { ...base, found: false, reason: 'Your team was not found in this league.', forecast: null, cards: {}, cached: false };
    }

    const matchups = await this.deps.sleeper.getMatchups(league.sleeperLeagueId, week).catch(() => [] as SleeperMatchup[]);
    const mineRow = matchups.find((m) => m.roster_id === mine.rosterId) ?? null;
    if (!mineRow) {
      return {
        ...base,
        found: false,
        reason:
          matchups.length === 0
            ? `Sleeper has no week ${week} matchup for this league yet.`
            : 'Your roster is not in this week’s schedule.',
        forecast: null,
        cards: {},
        cached: false,
      };
    }
    const theirsRow =
      mineRow.matchup_id == null
        ? null
        : (matchups.find((m) => m.matchup_id === mineRow.matchup_id && m.roster_id !== mine.rosterId) ?? null);
    if (!theirsRow) {
      return {
        ...base,
        found: false,
        reason: `You have no opponent in week ${week} — a bye, or the schedule is not published yet.`,
        forecast: null,
        cards: {},
        cached: false,
      };
    }

    /*
     * Every player in the matchup, evaluated once.
     *
     * Both rosters in one pass rather than two, because the start/sit assembly
     * builds the league-wide context — the slate, the opponent tendencies —
     * once per call, and asking for it twice would double the most expensive
     * part of the request to save nothing.
     */
    const allIds = [...new Set([...(mineRow.players ?? []), ...(theirsRow.players ?? [])])];
    const inputs = await startSitInputsFor(this.db, allIds);
    const evaluations = new Map<string, StartSitEvaluation>();
    for (const input of inputs) evaluations.set(input.player.id, evaluatePlayer(input, profile));

    const slots = buildSlotSpecs(league.rosterPositions);
    const players = [
      ...toPlayers(mineRow, 'mine', evaluations, slots),
      ...toPlayers(theirsRow, 'theirs', evaluations, slots),
    ];

    const forecastInput = {
      leagueId: league.id,
      season: league.season,
      week,
      matchupId: mineRow.matchup_id,
      players,
      teams: {
        mine: { rosterId: mine.rosterId, name: mine.ownerName ?? 'Your team', avatar: null, record: recordOf(mine.settings) },
        theirs: {
          rosterId: theirsRow.roster_id,
          name: rosters.find((r) => r.rosterId === theirsRow.roster_id)?.ownerName ?? 'Opponent',
          avatar: null,
          record: recordOf(rosters.find((r) => r.rosterId === theirsRow.roster_id)?.settings),
        },
      },
      actualScores: { mine: mineRow.points ?? 0, theirs: theirsRow.points ?? 0 },
      slots,
      now,
      weekSettled: isWeekSettled(context.week, week, context.seasonType),
    };

    /*
     * The cache check, before the simulation and not after it.
     *
     * The fingerprint is derived from the same state the forecast is, and
     * deriving it costs a handful of date comparisons — so a poll that finds
     * nothing changed pays for the Sleeper request, the roster reads and
     * nothing else. Checking afterwards would have been a cache that saved the
     * response object and none of the work, which is no cache at all.
     */
    const fingerprint = forecastFingerprint(forecastInput);
    const cached = CACHE.get(this.db);
    if (cached && cached.fingerprint === fingerprint) {
      return { ...cached.response, cached: true };
    }

    const previous = await this.previousState(league.id, league.season, week, mine.rosterId);
    const forecast = buildForecast({ ...forecastInput, previous });

    /*
     * The cards, from the same evaluations the forecast was built from.
     *
     * A player the engine could not score has no card, which the screen renders
     * as a row that does not open — better than a sheet that says nothing.
     */
    const cards: Record<string, WeeklyCard> = {};
    for (const player of players) {
      const evaluation = evaluations.get(player.playerId);
      if (!evaluation) continue;
      cards[player.playerId] = buildWeeklyCard(evaluation, {
        starting: player.starting,
        slot: player.slot ? labelOf(player.slot) : null,
        alreadyStarting: player.starting,
        locked: forecast.slots.some((row) => row.mine?.playerId === player.playerId && row.mine.locked),
      });
    }

    const response: MatchupResponse = { ...base, found: true, reason: null, forecast, cards, cached: false };
    CACHE.set(this.db, { fingerprint: forecast.fingerprint, response });

    // Best effort: a ledger write must never be the reason a screen fails.
    await this.record({
      leagueId: league.id,
      season: league.season,
      week,
      forecast,
      mineRosterId: mine.rosterId,
      theirsRosterId: theirsRow.roster_id,
      matchupId: mineRow.matchup_id,
      at: now.toISOString(),
    }).catch(() => undefined);

    return response;
  }

  /** What the last stored forecast said, so "changed since" is answerable. */
  private async previousState(
    leagueId: string,
    season: string,
    week: number,
    rosterId: number,
  ): Promise<PreviousInsightState | null> {
    const stored = await new MatchupRepo(this.db)
      .latest({ leagueId, season, week, rosterId })
      .catch(() => null);
    const cached = CACHE.get(this.db);
    if (cached?.response.forecast) {
      return {
        fingerprint: cached.response.forecast.fingerprint,
        winProbability: cached.response.forecast.teams.mine.winProbability ?? 0.5,
        relevantSince: Object.fromEntries(
          cached.response.forecast.insights.map((i) => [i.key, i.relevantSince]),
        ),
      };
    }
    if (!stored?.fingerprint) return null;
    return {
      fingerprint: stored.fingerprint,
      winProbability: stored.winProbability ?? 0.5,
      relevantSince: {},
    };
  }

  /**
   * Write the forecast to the calibration ledger, and close the week if it is
   * over.
   *
   * Both sides are recorded. A calibration set built only from the user's own
   * roster would be exactly half the samples available and would carry whatever
   * bias the user's own roster has; the opponent's forecast is the same model's
   * prediction and is worth just as much.
   */
  private async record(opts: {
    leagueId: string;
    season: string;
    week: number;
    forecast: MatchupForecast;
    mineRosterId: number;
    theirsRosterId: number;
    matchupId: number | null;
    at: string;
  }): Promise<void> {
    const repo = new MatchupRepo(this.db);
    const { forecast } = opts;
    const sides: { side: MatchupSide; rosterId: number; opponentRosterId: number }[] = [
      { side: 'mine', rosterId: opts.mineRosterId, opponentRosterId: opts.theirsRosterId },
      { side: 'theirs', rosterId: opts.theirsRosterId, opponentRosterId: opts.mineRosterId },
    ];

    for (const { side, rosterId, opponentRosterId } of sides) {
      const team = forecast.teams[side];
      await repo.record({
        leagueId: opts.leagueId,
        season: opts.season,
        week: opts.week,
        rosterId,
        matchupId: opts.matchupId,
        opponentRosterId,
        modelVersion: forecast.modelVersion,
        phase: forecast.phase,
        winProbability: team.winProbability,
        projectedFinal: team.projectedFinal,
        actual: team.actual,
        confidence: forecast.freshness.level,
        fingerprint: forecast.fingerprint,
        at: opts.at,
      });
    }

    if (forecast.phase !== 'final') return;
    for (const { side, rosterId } of sides) {
      const other = side === 'mine' ? 'theirs' : 'mine';
      await repo.settle({
        leagueId: opts.leagueId,
        season: opts.season,
        week: opts.week,
        rosterId,
        finalScore: forecast.teams[side].actual,
        opponentFinalScore: forecast.teams[other].actual,
        at: opts.at,
      });
    }
  }
}

/**
 * The league's starting slots, in Sleeper's own order.
 *
 * Order is load-bearing: Sleeper's `starters` array is positional against
 * `roster_positions` with the bench removed, and it is the *only* way to know
 * which slot a starter is filling. Rebuilding this from `buildRosterShape`
 * would lose the order — the shape is a count per position, deliberately — so
 * the raw list is walked here instead.
 */
export function buildSlotSpecs(rosterPositions: string[]): SlotSpec[] {
  const specs: SlotSpec[] = [];
  for (const raw of rosterPositions ?? []) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN' || slot === 'IR' || slot === 'TAXI') continue;
    const flex = FLEX_ELIGIBILITY[slot];
    specs.push({
      key: slotKey(slot, specs.length),
      slot,
      accepts: flex ? [...flex] : [slot === 'QB2' ? 'QB' : slot],
    });
  }
  return specs;
}

/** `RB#3` -> `RB`. The identity carries the index; the label never shows it. */
function labelOf(key: string): string {
  const cut = key.indexOf('#');
  return cut === -1 ? key : key.slice(0, cut);
}

/**
 * Turn one Sleeper matchup row into the model's players.
 *
 * The slot assignment is positional against the league's starting slots, and an
 * empty slot arrives from Sleeper as the literal `"0"` — which is skipped
 * rather than looked up, because there is no player id zero and treating it as
 * one produces a phantom starter with no name.
 */
function toPlayers(
  row: SleeperMatchup,
  side: MatchupSide,
  evaluations: Map<string, StartSitEvaluation>,
  slots: SlotSpec[],
): MatchupPlayerInput[] {
  const starters = row.starters ?? [];
  const points = row.players_points ?? {};
  const startingIds = new Set(starters.filter((id) => id && id !== '0'));

  const out: MatchupPlayerInput[] = [];

  starters.forEach((playerId, index) => {
    if (!playerId || playerId === '0') return;
    const slot = slots[index];
    out.push(toPlayer(playerId, side, evaluations, points[playerId] ?? 0, slot?.key ?? null, true));
  });

  for (const playerId of row.players ?? []) {
    if (startingIds.has(playerId)) continue;
    out.push(toPlayer(playerId, side, evaluations, points[playerId] ?? 0, null, false));
  }

  return out;
}

function toPlayer(
  playerId: string,
  side: MatchupSide,
  evaluations: Map<string, StartSitEvaluation>,
  actual: number,
  slot: string | null,
  starting: boolean,
): MatchupPlayerInput {
  const evaluation = evaluations.get(playerId);
  return {
    playerId,
    name: evaluation?.name ?? playerId,
    position: evaluation?.position ?? '',
    team: evaluation?.team ?? '',
    opponent: evaluation?.opponent ?? null,
    slot,
    starting,
    side,
    projection: activeProjection(evaluation),
    actual: Number.isFinite(actual) ? actual : 0,
    kickoff: evaluation?.lock.kickoff ?? null,
    roleBucket: evaluation?.roleProfile.bucket ?? 'unclassified',
    availability: evaluation?.availability.state ?? 'unknown',
    ruledOut: evaluation?.ruledOut ?? false,
  };
}

/**
 * The engine's score with the availability component taken back out.
 *
 * The one place §3's "do not double-count correlated signals" is enforced for
 * this feature. The start/sit score already prices a Questionable designation
 * as points off; the matchup model prices the same fact as a probability of not
 * playing. Both would be the same designation charged twice, and the version
 * that survives is the mixture — because a distribution with a real inactive
 * branch says something a shaved mean cannot: that his floor is zero.
 *
 * A player the engine could not score stays null. Not zero: an unscorable
 * player is a gap in coverage and a player projected zero is a prediction, and
 * the model treats them completely differently.
 */
export function activeProjection(evaluation: StartSitEvaluation | undefined): number | null {
  if (!evaluation || evaluation.score == null) return null;
  /*
   * No market expectation, no projection.
   *
   * The start/sit score is the Vegas expectation plus a handful of bounded
   * adjustments, and the engine will hand back a non-null score when *any*
   * component is known — including when the only thing known is that the player
   * is Doubtful. Subtracting that penalty back out then produces a projection of
   * about zero for somebody nobody has priced, which reads on a card as "he is
   * expected to score nothing" when the truth is "we do not know".
   *
   * The adjustments alone are worth a few points either way and are not a
   * forecast of a week. So the market's number is the thing that makes a
   * projection exist, and its absence is reported as absent — counted in the
   * freshness line, and enough of them degrade the forecast entirely.
   */
  if (evaluation.expectation.points == null) return null;
  const availability = evaluation.components.find((c) => c.key === 'status');
  const penalty = availability && !availability.unknown ? availability.value : 0;
  return Math.max(0, Math.round((evaluation.score - penalty) * 100) / 100);
}

/** `9-5`, when Sleeper's roster settings carry a record. */
function recordOf(settings: Record<string, unknown> | null | undefined): string | null {
  if (!settings) return null;
  const wins = numeric(settings['wins']);
  const losses = numeric(settings['losses']);
  if (wins == null || losses == null) return null;
  const ties = numeric(settings['ties']) ?? 0;
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Which week to show.
 *
 * Sleeper's own week, clamped into the range a matchup can exist in. Week 0 is
 * the state Sleeper reports through the preseason, and asking for matchups in
 * it returns nothing useful — so the dead zone shows week one, which is the
 * schedule a reader in August actually wants to look at.
 */
export function resolveWeek(requested: number | null, current: number | null): number {
  const asked = requested != null && Number.isFinite(requested) ? Math.floor(requested) : null;
  if (asked != null && asked >= 1 && asked <= 22) return asked;
  const now = current != null && Number.isFinite(current) ? Math.floor(current) : 1;
  return Math.min(22, Math.max(1, now));
}

/**
 * Whether a week is definitively over, whatever the schedule says.
 *
 * The escape hatch for a deployment with no odds coverage, where a player's
 * kickoff is unknown and the clock would otherwise have to be inferred forever.
 * Sleeper has moved on to a later week, so nothing in this one can still be
 * playing — which is a fact from a source rather than a guess from a calendar.
 */
export function isWeekSettled(currentWeek: number | null, week: number, seasonType: string | null): boolean {
  if (seasonType === 'post' || seasonType === 'off') return true;
  return currentWeek != null && Number.isFinite(currentWeek) && week < currentWeek;
}
