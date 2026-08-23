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
import type { ScenarioData } from '../fixtures/index.ts';
import { toProps, toUsageWeeks } from '../fixtures/spec.ts';

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
     * The demo world imports no preseason projection snapshot, so the board it
     * builds has none — which is the honest rehearsal of a league that has not
     * pasted one, and leaves the market component reading the demo's own season
     * lines exactly as it did before.
     */
    preseasonPoints: async () => new Map<string, number>(),
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
 * Three of the methods are worth naming. `matchups` hands back Sleeper's own
 * rows verbatim, because the scoreboard is Sleeper's on a demo Sunday exactly
 * as it is on a real one. `previousForecast` answers null: a scenario is a
 * single instant with no history behind it, and inventing "what it said an hour
 * ago" would be the fixture asserting a change the reader never saw happen.
 * And `record` does nothing at all — the calibration ledger is a write, and §2
 * says a demo does not get to make one.
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
    record: async () => undefined,
    now: () => data.clock.now(),
  };
}
