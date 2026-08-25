/**
 * A scenario, in the shapes the production code already asks for.
 *
 * This is the whole of the substitution. The draft board wants a
 * `DraftBoardSources`; the start/sit engine wants `StartSitInput[]`; the trade
 * engine wants `TradeCandidate[]`. All three are interfaces the server fills
 * from D1, and all three are filled here from a fixture instead — with the same
 * types, the same shapes and the same absences.
 *
 * Nothing here decides anything. There is no scoring, no ranking, no
 * recommendation and no sentence in this file: it hands over inputs, and the
 * production engines do the rest.
 */

import { UNDERDOG_SOURCE_KEY, type DraftBoardSources } from '../../draft/boardBuilder.ts';
import type { MatchupResponse, MatchupSources } from '../../matchup/build.ts';
import type { StartSitInput } from '../../startsit/engine.ts';
import { toRoleMetrics } from '../../usage/role.ts';
import type { TradeCandidate, Ownership } from '../../trades/engine.ts';
import type { DefenseTendencyIndex } from '../../startsit/defense.ts';
import type { StartSitMode } from '../../startsit/mode.ts';
import { hoursAfter } from '../clock.ts';
import type { DstPlanSources } from '../../dst/assemble.ts';
import type { ScenarioData } from '../fixtures/index.ts';
import { toProps, toUsageWeeks } from '../fixtures/spec.ts';
import { scheduleRows, teamForm } from '../fixtures/slate.ts';
import { preseasonPoints } from '../fixtures/world.ts';

/**
 * The board's sources.
 *
 * Every method returns from memory, and every one of them is a read — there is
 * no write to satisfy, because `DraftBoardSources` has none.
 */
export function draftBoardSourcesFrom(data: ScenarioData): DraftBoardSources {
  return {
    leagues: {
      getDraft: async (id) => (data.draft && data.draft.id === id ? data.draft : null),
      getLeague: async (id) => (data.league.id === id ? data.league : null),
      listRosters: async (leagueId) => (data.league.id === leagueId ? data.rosters : []),
      listPicks: async (draftId) => (data.draft?.id === draftId ? data.picks : []),
    },
    players: { listAll: async () => data.players },
    /*
     * Two markets, kept apart.
     *
     * The board asks for them by name — the platform snapshot for Sleeper, the
     * `underdog` source for DOG — and gets exactly the one it asked for. They
     * are keyed on distinct snapshot ids so `valuesByPlayer` can never hand one
     * market's numbers back for the other's id, which is the single worst thing
     * that could happen here: a Sleeper column silently labelled DOG.
     */
    adp: {
      get: async (id) => {
        if (data.adpSnapshot?.id === id) return data.adpSnapshot;
        if (data.dogSnapshot?.id === id) return data.dogSnapshot;
        return null;
      },
      latestPlatformSnapshot: async () => data.adpSnapshot,
      latestForSource: async (source) => (source === UNDERDOG_SOURCE_KEY ? data.dogSnapshot : null),
      valuesByPlayer: async (snapshotId) => {
        if (snapshotId === data.dogSnapshot?.id) return data.dogValues;
        if (snapshotId === data.adpSnapshot?.id) return data.adpValues;
        return new Map();
      },
    },
    evidence: {
      getSignals: async (ids) => {
        const out = new Map<string, NonNullable<ReturnType<(typeof data.signals)['get']>>>();
        for (const id of ids) {
          const signal = data.signals.get(id);
          if (signal) out.set(id, signal);
        }
        return out;
      },
    },
    /*
     * A demo's stars are fixture data and belong to the demo's own draft.
     *
     * The draft id is ignored because a scenario has exactly one draft, and it
     * is a fixture in memory: there is no table here for a live queue to reach
     * and no route that could write one — Demo Mode refuses every non-GET. The
     * isolation is structural in both directions.
     */
    flags: async () => data.flags,
    /*
     * The projection somebody pasted in August, for the board's `PTS` column.
     *
     * A separate source from the draft market beside it, and it used to be
     * empty here — so `PTS —` was on every row of every demo board while the
     * column worked in production, which is the one thing Demo Mode exists to
     * make impossible. See `preseasonPoints` in `fixtures/world.ts` for why the
     * numbers deliberately disagree with ADP, and for why no defence has one.
     */
    preseasonPoints: async (playerIds) => {
      const out = new Map<string, number>();
      const wanted = new Set(playerIds);
      for (const spec of data.specs) {
        if (!wanted.has(spec.id)) continue;
        const points = preseasonPoints(spec);
        if (points != null) out.set(spec.id, points);
      }
      return out;
    },
    seasonMarkets: async (ids) => {
      const out: typeof data.seasonMarkets = new Map();
      for (const id of ids) {
        const lines = data.seasonMarkets.get(id);
        if (lines) out.set(id, lines);
      }
      return out;
    },
    /*
     * The demo world's markets have a provider and a time like any other, so
     * the expanded card's provenance section renders in a rehearsal exactly as
     * it does in production rather than being the one thing only real data can
     * show.
     */
    marketSnapshot: async () => ({
      provider: 'demo',
      season: String(data.clock.now().getUTCFullYear()),
      fetchedAt: data.clock.now().toISOString(),
    }),
    repairStatus: async () => data.repair,
    injuryStates: async (players) => {
      const out = new Map<string, NonNullable<ReturnType<(typeof data.injuries)['get']>>>();
      for (const { playerId } of players) {
        const state = data.injuries.get(playerId);
        if (state) out.set(playerId, state);
      }
      return out;
    },
    /*
     * The scenario's clock, which is what makes a stale-DOG scenario stay
     * stale. Measured from here, an Underdog file authored as nine days old is
     * nine days old in March 2027 and in August 2026 alike.
     */
    now: () => data.clock.now(),
  };
}

/**
 * Everything the start/sit engine knows about a set of players.
 *
 * The fixture equivalent of the server's `startSitInputsFor`: same output type,
 * same fields, same "absent means unknown" rules. The one thing it does that
 * the server's version does not is pass the scenario's clock as `now`, which is
 * how a lock state, a freshness reading and a kickoff distance all end up
 * measured from Sunday 11:40 rather than from whenever the demo is being looked
 * at.
 */
export function startSitInputsFrom(
  data: ScenarioData,
  playerIds: string[],
  opts: { mode?: StartSitMode } = {},
): StartSitInput[] {
  const bySpecId = new Map(data.specs.map((s) => [s.id, s]));
  const byPlayerId = new Map(data.players.map((p) => [p.id, p]));
  const defense: DefenseTendencyIndex = new Map();

  const inputs: StartSitInput[] = [];
  for (const id of playerIds) {
    const spec = bySpecId.get(id);
    const player = byPlayerId.get(id);
    if (!spec || !player) continue;
    const week = spec.week;
    const usageWeeks = toUsageWeeks(spec);

    inputs.push({
      player,
      props: toProps(spec, week?.points ?? null),
      previousProps: week?.previousPoints == null ? [] : toProps(spec, week.previousPoints),
      kickoff: week?.kickoffInHours == null ? null : hoursAfter(data.clock, week.kickoffInHours),
      signal: data.signals.get(id) ?? null,
      injuryStatus: player.status,
      injury: data.injuries.get(id) ?? null,
      usage: usageWeeks.length > 0 ? toRoleMetrics(spec.position, usageWeeks) : undefined,
      usageWeeks: usageWeeks.length > 0 ? usageWeeks : undefined,
      game:
        week?.opponent == null
          ? null
          : { spread: week.spread ?? null, total: week.total ?? null, opponent: week.opponent },
      opponent: week?.opponent ?? null,
      /*
       * At home or on the road, for the one model that reads it.
       *
       * Set from the slate exactly as the live assembly sets it from the stored
       * fixture list, so a defence worth 8.4 on Team and 8.1 on Waivers is not
       * a rounding difference — it is two answers to one question, and it
       * cannot happen because both screens read this.
       */
      ...(week?.home == null ? {} : { home: week.home }),
      defenseTendencies: defense,
      mode: opts.mode ?? 'balanced',
      propsStale: data.freshness.vegas === 'stale',
      // The scenario's clock, not the device's. This is §6 in one line.
      now: data.clock.now(),
    });
  }
  return inputs;
}

/**
 * The defence planner's three reads, from the slate.
 *
 * `DstPlanSources` is the same interface `server/services/dstPlanService.ts`
 * satisfies out of the schedule and betting repositories — the assembly itself
 * is `core/dst/assemble.ts` and is shared, so a streamed defence in Demo Mode
 * was chosen by the code that would choose one for a real league.
 *
 * The fixture answers exactly what a deployment answers, including the shape of
 * what it does *not* know: `impliedTotals` is a season average per club and the
 * generated weeks carry no line at all, which is what sends the outlook down
 * its honest fallback path instead of down an invented one.
 */
export function dstPlanSourcesFrom(data: ScenarioData): DstPlanSources {
  const season = data.league.season;
  const week = data.nflState?.week ?? 1;
  return {
    fixturesForWeek: async (_season, forWeek) => scheduleRows(season, [forWeek]),
    scheduleForTeams: async (_season, teams, range) => {
      const wanted = new Set(teams.map((t) => t.toUpperCase()));
      const weeks: number[] = [];
      for (let w = range.from; w <= range.to; w++) weeks.push(w);
      return scheduleRows(season, weeks).filter((row) => wanted.has(row.team.toUpperCase()));
    },
    impliedTotals: async () => teamForm(week),
  };
}

/**
 * The trade board's candidates.
 *
 * Assembled exactly as `TradeService` assembles them — only players the ledger
 * has said something about, with ownership from the rosters and availability
 * from the injury layer — and then handed to `rankTrades`, which is the part
 * that decides anything.
 */
export function tradeCandidatesFrom(data: ScenarioData): TradeCandidate[] {
  const mine = new Set(data.rosters.find((r) => r.isMine)?.playerIds ?? []);
  const owned = new Set(data.rosters.flatMap((r) => r.playerIds));
  const byId = new Map(data.players.map((p) => [p.id, p]));

  const out: TradeCandidate[] = [];
  for (const [playerId, signal] of data.signals) {
    const player = byId.get(playerId);
    if (!player || !player.active) continue;
    const ownership: Ownership = mine.has(playerId) ? 'mine' : owned.has(playerId) ? 'other' : 'free';
    out.push({
      player,
      signal,
      ownership,
      injury: data.injuries.get(playerId) ?? null,
      outlook: null,
    });
  }
  return out;
}

/**
 * The matchup's sources.
 *
 * The same interface `MatchupService` satisfies over D1 and Sleeper, satisfied
 * here from the scenario instead — so the win probability, the hero insight and
 * the lineup counterfactual on a demo screen were produced by
 * `buildMatchupResponse` and not by anything resembling it.
 *
 * Two of the methods are worth naming. `matchups` hands back Sleeper's own
 * rows verbatim, because the scoreboard is Sleeper's on a demo Sunday exactly
 * as it is on a real one. `previousForecast` answers null: a scenario is a
 * single instant with no history behind it, and inventing "what it said an hour
 * ago" would be the fixture asserting a change the reader never saw happen.
 *
 * There used to be a third — `record`, satisfied with a function that returned
 * immediately, because the calibration ledger was a write and §2 says a demo
 * does not get to make one. `MatchupSources` no longer carries a write for
 * anybody to no-op: the ledger is a separate argument to
 * `buildMatchupResponse`, the demo passes three arguments, and a demo write is
 * now a thing this file has no way to express rather than a thing it declines
 * to do.
 *
 * The cache is per-runtime rather than module state, so two scenarios open at
 * once cannot serve each other's afternoon.
 */
export function matchupSourcesFrom(data: ScenarioData): MatchupSources {
  let memo: { fingerprint: string; response: MatchupResponse } | null = null;
  return {
    leagues: {
      getLeague: async (id) => (data.league.id === id ? data.league : null),
      listRosters: async (leagueId) => (data.league.id === leagueId ? data.rosters : []),
    },
    matchups: async (league, _week) => (league.id === data.league.id ? (data.matchups ?? []) : []),
    nflState: async () => data.nflState,
    startSitInputs: async (playerIds) => startSitInputsFrom(data, playerIds),
    previousForecast: async () => null,
    cached: () => memo,
    remember: (entry) => {
      memo = entry;
    },
    now: () => data.clock.now(),
  };
}
