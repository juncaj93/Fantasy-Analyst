/**
 * The Matchup screen's one request, assembled from injected sources.
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
 *
 * ## Why the sources are injected
 *
 * This assembly lives in `core` and reaches nothing: no database, no HTTP
 * client, no repository. Everything it needs arrives through {@link
 * MatchupSources}, which the server satisfies over D1 and Sleeper and which
 * Demo Mode satisfies from fixtures in memory. That is the difference between
 * a rehearsal of this screen and a second implementation of it — the win
 * probability a demo prints was produced by the function above, not by
 * something that resembles it.
 */

import type { SleeperMatchup, LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import { buildRosterShape, buildScoringProfile, FLEX_ELIGIBILITY } from '../sleeper/scoring.ts';
import { evaluatePlayer, type StartSitEvaluation, type StartSitInput } from '../startsit/engine.ts';
import { buildWeeklyCard, type WeeklyCard } from '../startsit/weekCard.ts';
import { suggestMode, type SidePlayer } from '../startsit/modeSuggest.ts';
import { weeklyProjection } from '../startsit/projection.ts';
import { advancedLines } from '../contracts/integration.ts';
import { assessXfp } from '../xfp/model.ts';
import { buildForecast, forecastFingerprint, slotKey, type MatchupForecast } from './model.ts';
import type { SlotSpec } from './decision.ts';
import type { PreviousInsightState } from './insights.ts';
import type { MatchupPlayerInput, MatchupSide } from './types.ts';
import { resolveSeasonContext } from '../season/context.ts';
import type { NflState } from '../sleeper/phase.ts';

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
   * same builder the Team screen uses, from the same evaluations and carrying
   * the same expected-points line, so the two screens cannot describe the same
   * player differently.
   */
  cards: Record<string, WeeklyCard>;
  /** True when the forecast was served from cache rather than recomputed. */
  cached: boolean;
}
/**
 * Everything the assembly needs, and nothing that can reach live truth.
 *
 * Deliberately all reads bar one. `record` is the single outward call, and it
 * exists because a probability model that never writes down what it said can
 * never be graded — the live service writes both sides to the calibration
 * ledger, and Demo Mode supplies a recorder that returns immediately. No
 * method here can change a lineup, a roster or a league.
 */
export interface MatchupSources {
  leagues: {
    getLeague(id: string): Promise<LeagueRecord | null>;
    listRosters(leagueId: string): Promise<RosterRecord[]>;
  };
  /** Sleeper's own matchup rows for the week. The scoreboard, never recomputed. */
  matchups(league: LeagueRecord, week: number): Promise<SleeperMatchup[]>;
  nflState(): Promise<NflState | null>;
  startSitInputs(playerIds: string[]): Promise<StartSitInput[]>;
  /** What the last forecast said, so "changed since you looked" is answerable. */
  previousForecast(opts: {
    leagueId: string;
    season: string;
    week: number;
    rosterId: number;
  }): Promise<PreviousInsightState | null>;
  /** The caller's memo of its own last response, for the fingerprint short-circuit. */
  cached(): { fingerprint: string; response: MatchupResponse } | null;
  remember(entry: { fingerprint: string; response: MatchupResponse }): void;
  record(opts: {
    leagueId: string;
    season: string;
    week: number;
    forecast: MatchupForecast;
    mineRosterId: number;
    theirsRosterId: number;
    matchupId: number | null;
    at: string;
  }): Promise<void>;
  now(): Date;
}

/**
 * The current — or a named — week's matchup for the league's own roster.
 *
 * The week comes from Sleeper's `/state/nfl` unless the caller names one, and
 * it is never computed from the calendar: see `core/season/context.ts` for
 * the six copies of that arithmetic this app deleted.
 */
export async function buildMatchupResponse(
  sources: MatchupSources,
  leagueId: string,
  opts: { week?: number | null } = {},
): Promise<MatchupResponse> {
  const now = sources.now();
  const league = await sources.leagues.getLeague(leagueId);
  if (!league) throw new Error('league not found');

  const state = await sources.nflState();
  const context = resolveSeasonContext({ state, league: { season: league.season }, now });
  const week = resolveWeek(opts.week ?? null, context.week, context.seasonType);

  const profile = buildScoringProfile(league.scoringSettings, league.rosterPositions);
  const base = {
    league: { id: league.id, name: league.name, season: league.season, scoringLabel: profile.label },
    week,
    season: league.season,
  };

  const rosters = await sources.leagues.listRosters(league.id);
  const mine = rosters.find((r) => r.isMine) ?? null;
  if (!mine) {
    return { ...base, found: false, reason: 'Your team was not found in this league.', forecast: null, cards: {}, cached: false };
  }

  const matchups = await sources.matchups(league, week).catch(() => [] as SleeperMatchup[]);
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
  const inputs = await sources.startSitInputs(allIds);
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
    /*
     * The mode suggestion is `suggestMode`'s, not this feature's.
     *
     * The Team screen already preselects Floor, Balanced or Ceiling from the
     * week's market margin, and a second reading of the same question — off
     * the simulated win probability, say — would be two modules disagreeing
     * on one screen about which lineup the user should be looking at. So the
     * matchup carries the existing answer through rather than forming its
     * own, which also keeps `modeSuggest.ts`'s circularity guard intact: it
     * is fed market points here, exactly as it is on the Team screen, and
     * never the forecast this call is about to produce.
     */
    modeSuggestion: suggestMode({
      mine: modeSidePlayers(mineRow, evaluations),
      opponent: modeSidePlayers(theirsRow, evaluations),
      shape: buildRosterShape(league.rosterPositions),
    }),
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
  const cached = sources.cached();
  if (cached && cached.fingerprint === fingerprint) {
    return { ...cached.response, cached: true };
  }

  const previous = await sources.previousForecast({
    leagueId: league.id,
    season: league.season,
    week,
    rosterId: mine.rosterId,
  });
  const forecast = buildForecast({ ...forecastInput, previous });

  /*
   * The cards, from the same evaluations the forecast was built from.
   *
   * A player the engine could not score has no card, which the screen renders
   * as a row that does not open — better than a sheet that says nothing.
   */
  const cards: Record<string, WeeklyCard> = {};
  const inputById = new Map(inputs.map((input) => [input.player.id, input]));
  for (const player of players) {
    const evaluation = evaluations.get(player.playerId);
    if (!evaluation) continue;
    /*
     * The expected-points line, from the module that owns it.
     *
     * The Team screen's cards get this through `weeklyIntelligence`, and a
     * card that carried it on one screen and not the other would be the app
     * describing the same player two ways depending on how you reached him.
     * The xFP half is per-player arithmetic over usage the request already
     * loaded, so it costs nothing here.
     *
     * `whatWouldChange` is deliberately not carried across. It is a bisection
     * of one lineup's close calls and needs the optimiser's recommendation,
     * which this request does not build — and the Matchup screen answers the
     * same question better anyway, in win probability rather than in points.
     */
    const usageWeeks = inputById.get(player.playerId)?.usageWeeks ?? [];
    const advanced =
      usageWeeks.length === 0 ? [] : advancedLines(assessXfp(evaluation.position, usageWeeks, profile));
    cards[player.playerId] = buildWeeklyCard(advanced.length > 0 ? { ...evaluation, advanced } : evaluation, {
      starting: player.starting,
      slot: player.slot ? labelOf(player.slot) : null,
      alreadyStarting: player.starting,
      locked: forecast.slots.some((row) => row.mine?.playerId === player.playerId && row.mine.locked),
    });
  }

  const response: MatchupResponse = { ...base, found: true, reason: null, forecast, cards, cached: false };
  sources.remember({ fingerprint: forecast.fingerprint, response });

  /*
   * The forecast is offered to whoever asked for it, and they decide.
   *
   * Live, the service writes both sides to the calibration ledger — best
   * effort, so a ledger write is never the reason a screen fails. Demo Mode
   * supplies a recorder that does nothing, which is not a special case in this
   * file: it is the same seam, satisfied by a caller that has nothing to write
   * to.
   */
  await sources
    .record({
      leagueId: league.id,
      season: league.season,
      week,
      forecast,
      mineRosterId: mine.rosterId,
      theirsRosterId: theirsRow.roster_id,
      matchupId: mineRow.matchup_id,
      at: now.toISOString(),
    })
    .catch(() => undefined);

  return response;
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

/**
 * One roster as `suggestMode` is allowed to see it: market points and nothing else.
 *
 * The whole roster rather than the starters, because that module fills the
 * slots itself — it is estimating what each side will put on the board, not
 * reading what somebody has already set. `marketPoints` is the raw Vegas
 * expectation, deliberately not {@link activeProjection}: the availability
 * penalty belongs to the start/sit score, and a ruled-out player is expressed
 * to that module as `ruledOut` instead.
 */
function modeSidePlayers(
  row: { players?: string[] | null },
  evaluations: Map<string, StartSitEvaluation>,
): SidePlayer[] {
  return (row.players ?? [])
    .filter((playerId) => playerId !== '0')
    .map((playerId) => {
      const evaluation = evaluations.get(playerId);
      return {
        playerId,
        position: evaluation?.position ?? '',
        marketPoints: evaluation?.expectation.points ?? null,
        ruledOut: evaluation?.ruledOut ?? false,
      };
    });
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
    projection: weeklyProjection(evaluation),
    actual: Number.isFinite(actual) ? actual : 0,
    kickoff: evaluation?.lock.kickoff ?? null,
    roleBucket: evaluation?.roleProfile.bucket ?? 'unclassified',
    availability: evaluation?.availability.state ?? 'unknown',
    ruledOut: evaluation?.ruledOut ?? false,
  };
}

/**
 * The projection, under the name this module has always exported it by.
 *
 * The definition moved to `core/startsit/projection.ts` when the Team screen
 * turned out to need exactly the same rule and was reading the raw start/sit
 * score instead — printing a projection built entirely of adjustments for
 * players nobody had priced. One definition, one number, both screens.
 */
export { weeklyProjection as activeProjection };

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
 * Season types in which `/state/nfl`'s week is not a fantasy week at all.
 *
 * **Sleeper's `week` counts within the season type, and only `regular` counts
 * the weeks a fantasy schedule is made of.** Through August it is the
 * *preseason* week — `season_type: "pre", week: 2` on 22 August 2026 — and
 * that number is not week two of anything a league plays. Reading it as one is
 * the mistake both functions below used to make, and it is a category error
 * rather than an off-by-one: the two counters happen to share a range, so the
 * result is a plausible wrong week rather than a visible failure.
 *
 * `post` is deliberately absent. Sleeper keeps counting fantasy weeks through
 * the NFL postseason and this app has no production evidence that it does
 * otherwise, so that case is left exactly as it was.
 */
const NO_REGULAR_WEEK = new Set(['pre', 'off']);

/**
 * Which week to show.
 *
 * Sleeper's own week, clamped into the range a matchup can exist in — but only
 * when Sleeper's own week is a regular-season week. Before the season starts
 * there is no current week to show, and the honest answer is week one: the
 * first week that will ever be played, and the schedule a reader in August is
 * actually asking about.
 *
 * This used to lean on a `Math.max(1, …)` clamp and a belief that Sleeper
 * reports week 0 throughout the preseason. It does not — it reports the
 * preseason week — so the clamp caught only the days before the first preseason
 * game, and from then until kickoff the app showed a real matchup from the
 * wrong week, against an opponent the user does not play first.
 */
export function resolveWeek(requested: number | null, current: number | null, seasonType: string | null): number {
  const asked = requested != null && Number.isFinite(requested) ? Math.floor(requested) : null;
  if (asked != null && asked >= 1 && asked <= 22) return asked;
  if (NO_REGULAR_WEEK.has(String(seasonType ?? '').trim().toLowerCase())) return 1;
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
 *
 * The comparison is only meaningful between two regular-season weeks, for the
 * reason {@link NO_REGULAR_WEEK} gives. In the preseason nothing has been
 * played, so nothing is settled — without this, preseason week two would rule
 * week one finished and the screen would show a real fixture as a final score
 * of nil-nil.
 */
export function isWeekSettled(currentWeek: number | null, week: number, seasonType: string | null): boolean {
  const type = String(seasonType ?? '').trim().toLowerCase();
  if (type === 'post' || type === 'off') return true;
  if (type === 'pre') return false;
  return currentWeek != null && Number.isFinite(currentWeek) && week < currentWeek;
}