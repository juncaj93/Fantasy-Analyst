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

import type { DraftBoardSources } from '../../draft/boardBuilder.ts';
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
    adp: {
      get: async (id) => (data.adpSnapshot?.id === id ? data.adpSnapshot : null),
      latest: async () => data.adpSnapshot,
      valuesByPlayer: async () => data.adpValues,
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
    flags: async () => data.flags,
    seasonMarkets: async (ids) => {
      const out: typeof data.seasonMarkets = new Map();
      for (const id of ids) {
        const lines = data.seasonMarkets.get(id);
        if (lines) out.set(id, lines);
      }
      return out;
    },
    repairStatus: async () => data.repair,
    injuryStates: async (players) => {
      const out = new Map<string, NonNullable<ReturnType<(typeof data.injuries)['get']>>>();
      for (const { playerId } of players) {
        const state = data.injuries.get(playerId);
        if (state) out.set(playerId, state);
      }
      return out;
    },
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
