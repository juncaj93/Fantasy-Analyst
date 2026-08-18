/**
 * Turning a scenario's specs into the data a source needs.
 *
 * Everything here is construction, never judgement. It builds league records,
 * roster records, a snake of picks, a frozen ADP snapshot, tallies, injury
 * states and a budget — the shapes a provider and a database would have
 * produced — and then stops. Nothing in this file scores, ranks, recommends,
 * prices or explains anything; that is all downstream, in the same engines the
 * live app runs.
 */

import type {
  BoardAdpSnapshot,
  BoardAdpValue,
  BoardPlayerFlag,
  BoardRepairStatus,
} from '../../draft/boardBuilder.ts';
import type { PlayerSignal } from '../../evidence/types.ts';
import type { InjuryState } from '../../injury/model.ts';
import type { CanonicalPlayer } from '../../identity/types.ts';
import type { LeagueBudgetState, RosterBudget } from '../../faab/budget.ts';
import { buildBudgetState } from '../../faab/budget.ts';
import type { PriceSummary } from '../../faab/bids.ts';
import type { TrendingVelocity } from '../../market/trending.ts';
import type { SeasonMarketKey } from '../../vegas/types.ts';
import type {
  DraftPickRecord,
  DraftRecord,
  LeagueRecord,
  RosterRecord,
} from '../../sleeper/types.ts';
import type { NflState } from '../../sleeper/phase.ts';
import type { Clock } from '../clock.ts';
import { hoursBefore } from '../clock.ts';
import type { DemoScenario, DemoSourceFreshness } from '../types.ts';
import {
  toCanonicalPlayer,
  toInjuryState,
  toSignal,
  type DemoPlayerSpec,
} from './spec.ts';
import {
  DEMO_DRAFT_ID,
  DEMO_LEAGUE_ID,
  DEMO_LEAGUE_SETTINGS,
  DEMO_MANAGERS,
  DEMO_ROSTER_POSITIONS,
  DEMO_SCORING,
  MY_DRAFT_SLOT,
  adpOrder,
} from './world.ts';

export const DRAFT_ROUNDS = 14;
export const DRAFT_TEAMS = 12;

/**
 * Everything one scenario's sources hand out.
 *
 * A plain bag of already-shaped data. It is assembled once when a scenario is
 * chosen, held in memory, and thrown away on exit — there is nowhere in this
 * type for a write to go, which is what makes §3 (no contamination of live
 * truth) a structural property rather than a discipline.
 */
export interface ScenarioData {
  scenario: DemoScenario;
  clock: Clock;
  specs: DemoPlayerSpec[];
  players: CanonicalPlayer[];
  league: LeagueRecord;
  rosters: RosterRecord[];
  draft: (DraftRecord & { adpSnapshotId: number | null }) | null;
  picks: DraftPickRecord[];
  adpSnapshot: BoardAdpSnapshot | null;
  adpValues: Map<string, BoardAdpValue>;
  /**
   * Underdog, filed separately because it is a separate market.
   *
   * Null means no Underdog snapshot has been imported at all — one of the four
   * distinct ways DOG can be absent, and the board says which. The others are
   * expressed on the snapshot itself: a `sourceType` that is not `raw_adp`, a
   * `fetchedAt` old enough to be stale, and a snapshot that resolved to nobody.
   */
  dogSnapshot: BoardAdpSnapshot | null;
  dogValues: Map<string, BoardAdpValue>;
  signals: Map<string, PlayerSignal>;
  flags: Map<string, BoardPlayerFlag>;
  seasonMarkets: Map<string, { market: SeasonMarketKey; line: number | null }[]>;
  injuries: Map<string, InjuryState>;
  repair: BoardRepairStatus;
  nflState: NflState | null;
  freshness: DemoSourceFreshness;
  /** What the Vegas cache holds, for the freshness line every screen prints. */
  vegas: { fetchedAt: string | null; events: number };
  /** The FAAB world, or null in a league that does not bid. */
  strategy: ScenarioStrategy | null;
  /** Extra sentences the scenario wants surfaced, e.g. an outage explanation. */
  notes: string[];
}

export interface ScenarioStrategy {
  week: number;
  finalWeek: number;
  budget: LeagueBudgetState;
  prices: PriceSummary;
  trending: Map<string, TrendingVelocity>;
  trendingCapturedAt: string | null;
  losingBids: string;
  notes: string[];
}

/**
 * Apply per-scenario changes to the shared world.
 *
 * A scenario is a *time*, not a different set of people, so it says what has
 * changed since — this week's market, a designation that landed on Friday, a
 * star the user added — rather than restating everybody.
 */
export function overrideSpecs(
  base: DemoPlayerSpec[],
  overrides: Record<string, Partial<DemoPlayerSpec>>,
): DemoPlayerSpec[] {
  const unknown = Object.keys(overrides).filter((id) => !base.some((p) => p.id === id));
  if (unknown.length > 0) throw new Error(`demo fixture: overrides for unknown players: ${unknown.join(', ')}`);
  return base.map((spec) => {
    const patch = overrides[spec.id];
    return patch ? { ...spec, ...patch } : spec;
  });
}

// ------------------------------------------------------------------ league

export function makeLeague(opts: {
  season: string;
  status: string;
  name: string;
  /**
   * Written into Sleeper's own settings blob, not passed to the board.
   *
   * `detectBestBall` reads `best_ball` off the league settings exactly as it
   * does in production, so a best-ball scenario states the flag a real league
   * would carry and the blend is the conclusion rather than the input.
   */
  bestBall?: boolean;
}): LeagueRecord {
  return {
    id: DEMO_LEAGUE_ID,
    sleeperLeagueId: 'demo-sleeper-league',
    name: opts.name,
    season: opts.season,
    totalRosters: DRAFT_TEAMS,
    scoringSettings: DEMO_SCORING,
    rosterPositions: DEMO_ROSTER_POSITIONS,
    leagueSettings: opts.bestBall ? { ...DEMO_LEAGUE_SETTINGS, best_ball: 1 } : DEMO_LEAGUE_SETTINGS,
    draftId: DEMO_DRAFT_ID,
    status: opts.status,
    lastSyncedAt: '2026-08-30T22:00:00.000Z',
  };
}

/**
 * Rosters, from an assignment of players to seats.
 *
 * `starters` and `reserve` are only meaningful once a season is under way; a
 * mid-draft roster has neither, which is exactly the state `buildLiveRoster`
 * exists to reconstruct from the pick stream.
 */
export function makeRosters(opts: {
  byRosterId: Map<number, string[]>;
  starters?: string[];
  reserve?: string[];
  spentByRosterId?: Map<number, number>;
}): RosterRecord[] {
  return DEMO_MANAGERS.map((manager) => {
    const playerIds = opts.byRosterId.get(manager.rosterId) ?? [];
    const spent = opts.spentByRosterId?.get(manager.rosterId);
    return {
      leagueId: DEMO_LEAGUE_ID,
      rosterId: manager.rosterId,
      ownerId: `owner-${manager.rosterId}`,
      ownerName: manager.name,
      playerIds,
      starterIds: manager.isMine ? (opts.starters ?? []) : [],
      reserveIds: manager.isMine ? (opts.reserve ?? []) : [],
      isMine: manager.isMine,
      settings: spent == null ? {} : { waiver_budget_used: spent },
    };
  });
}

// ------------------------------------------------------------------- draft

export function makeDraft(opts: { status: string; season: string }): DraftRecord & { adpSnapshotId: number | null } {
  const slotToRosterId: Record<string, number> = {};
  for (const manager of DEMO_MANAGERS) slotToRosterId[String(manager.slot)] = manager.rosterId;
  return {
    id: DEMO_DRAFT_ID,
    sleeperDraftId: 'demo-sleeper-draft',
    leagueId: DEMO_LEAGUE_ID,
    status: opts.status,
    type: 'snake',
    season: opts.season,
    rounds: DRAFT_ROUNDS,
    teams: DRAFT_TEAMS,
    slotToRosterId,
    settings: {},
    lastSyncedAt: '2026-08-31T00:00:00.000Z',
    adpSnapshotId: null,
  };
}

/** Which seat makes pick `n` in a snake of this size. */
export function slotOfPick(pickNo: number, teams = DRAFT_TEAMS): number {
  const round = Math.ceil(pickNo / teams);
  const inRound = pickNo - (round - 1) * teams;
  return round % 2 === 1 ? inRound : teams - inRound + 1;
}

/**
 * The order the room actually took players in.
 *
 * The market's order with a few deliberate deviations, because a draft in which
 * everybody picks exactly at ADP has nothing to notice. Two of them matter:
 * the fourth-ranked player slides eight picks while the ledger is negative
 * about him, and the ledger's favourite is reached for two rounds early. Both
 * are the kind of thing a reader is supposed to see on the board.
 */
export function draftOrderIds(): string[] {
  const ids = adpOrder().map((p) => p.id);
  const move = (id: string, toIndex: number) => {
    const from = ids.indexOf(id);
    if (from < 0) return;
    ids.splice(from, 1);
    ids.splice(toIndex, 0, id);
  };
  move('p004', 10); // Villiers slides out of the first round.
  move('p009', 21); // Falade goes two rounds above his ADP.
  move('p016', 15); // The first tight end goes late, so the tier thins visibly.
  return ids;
}

export function makePicks(count: number, opts: { order?: string[] } = {}): DraftPickRecord[] {
  const order = opts.order ?? draftOrderIds();
  const bySlot = new Map(DEMO_MANAGERS.map((m) => [m.slot, m]));
  const picks: DraftPickRecord[] = [];
  for (let pickNo = 1; pickNo <= count; pickNo++) {
    const round = Math.ceil(pickNo / DRAFT_TEAMS);
    const pickInRound = pickNo - (round - 1) * DRAFT_TEAMS;
    const slot = slotOfPick(pickNo);
    const manager = bySlot.get(slot)!;
    const playerId = order[pickNo - 1] ?? null;
    picks.push({
      draftId: DEMO_DRAFT_ID,
      pickNo,
      round,
      pickInRound,
      draftSlot: slot,
      sleeperPlayerId: playerId,
      playerId,
      rosterId: manager.rosterId,
      pickedBy: `owner-${manager.rosterId}`,
      raw: '{}',
    });
  }
  return picks;
}

/** Everything my seat took in the first `count` picks. */
export function myPicks(picks: DraftPickRecord[]): string[] {
  return picks
    .filter((p) => p.draftSlot === MY_DRAFT_SLOT && p.playerId)
    .map((p) => p.playerId!);
}

/** Who holds whom, after `count` picks. */
export function rostersFromPicks(picks: DraftPickRecord[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const manager of DEMO_MANAGERS) out.set(manager.rosterId, []);
  for (const pick of picks) {
    if (!pick.playerId || pick.rosterId == null) continue;
    out.get(pick.rosterId)?.push(pick.playerId);
  }
  return out;
}

// --------------------------------------------------------------------- ADP

export function makeAdp(
  specs: DemoPlayerSpec[],
  opts: { available: boolean; label?: string; capturedAt?: string },
): { snapshot: BoardAdpSnapshot | null; values: Map<string, BoardAdpValue> } {
  if (!opts.available) return { snapshot: null, values: new Map() };
  const ranked = specs.filter((s) => s.adp != null).sort((a, b) => a.adp! - b.adp!);
  const values = new Map<string, BoardAdpValue>();
  ranked.forEach((spec, i) => values.set(spec.id, { adp: spec.adp!, rank: i + 1 }));
  const capturedAt = opts.capturedAt ?? '2026-08-24T06:00:00.000Z';
  return {
    snapshot: {
      id: SLEEPER_SNAPSHOT_ID,
      label: opts.label ?? 'Sleeper half-PPR redraft, 1QB',
      capturedAt,
      matchedCount: ranked.length,
      rowCount: ranked.length,
      importedAt: capturedAt,
      provider: 'beatadp',
      sourceType: 'raw_adp',
      snapshotAt: capturedAt,
      fetchedAt: capturedAt,
    },
    values,
  };
}

/** The two snapshot ids a scenario can hold. Distinct so a lookup cannot alias. */
export const SLEEPER_SNAPSHOT_ID = 1;
export const DOG_SNAPSHOT_ID = 2;

/**
 * The Underdog snapshot, and the several ways it can be unusable.
 *
 * Every state is expressed as *provenance on the snapshot* rather than as a
 * flag the board is told to honour, because that is how the real thing arrives:
 * the importer writes what it fetched and when, and `resolveDog` decides what
 * that is worth. A fixture that said "pretend DOG is stale" would be testing
 * the flag; this makes the board work it out from a timestamp.
 */
export function makeDog(
  specs: DemoPlayerSpec[],
  clock: Clock,
  opts: {
    available: boolean;
    /** How old the file is at the scenario's clock. Past 168h it is stale. */
    ageHours?: number;
    /** `raw_adp` is the only kind that may be shown as DOG. */
    sourceType?: string;
    /** Force the "it matched nobody" state, with the rows still counted. */
    matchesNothing?: boolean;
    provider?: string;
  },
): { snapshot: BoardAdpSnapshot | null; values: Map<string, BoardAdpValue> } {
  if (!opts.available) return { snapshot: null, values: new Map() };

  const priced = specs.filter((s) => s.dogAdp != null).sort((a, b) => a.dogAdp! - b.dogAdp!);
  const values = new Map<string, BoardAdpValue>();
  if (!opts.matchesNothing) {
    priced.forEach((spec, i) => values.set(spec.id, { adp: spec.dogAdp!, rank: i + 1 }));
  }

  const at = hoursBefore(clock, opts.ageHours ?? 6);
  return {
    snapshot: {
      id: DOG_SNAPSHOT_ID,
      label: 'Underdog Big Board',
      capturedAt: at,
      matchedCount: values.size,
      rowCount: priced.length,
      importedAt: at,
      provider: opts.provider ?? 'underdog',
      sourceType: opts.sourceType ?? 'raw_adp',
      snapshotAt: at,
      fetchedAt: at,
    },
    values,
  };
}

// -------------------------------------------------------- per-player state

export function collectPlayerState(
  specs: DemoPlayerSpec[],
  clock: Clock,
  opts: { injuriesAvailable?: boolean } = {},
): {
  players: CanonicalPlayer[];
  signals: Map<string, PlayerSignal>;
  flags: Map<string, BoardPlayerFlag>;
  seasonMarkets: Map<string, { market: SeasonMarketKey; line: number | null }[]>;
  injuries: Map<string, InjuryState>;
} {
  const players: CanonicalPlayer[] = [];
  const signals = new Map<string, PlayerSignal>();
  const flags = new Map<string, BoardPlayerFlag>();
  const seasonMarkets = new Map<string, { market: SeasonMarketKey; line: number | null }[]>();
  const injuries = new Map<string, InjuryState>();

  for (const spec of specs) {
    players.push(toCanonicalPlayer(spec));
    const signal = toSignal(spec, clock);
    if (signal) signals.set(spec.id, signal);
    if (spec.myGuy || spec.queued) {
      flags.set(spec.id, {
        level: (spec.myGuy ?? 0) as BoardPlayerFlag['level'],
        queued: spec.queued ?? false,
        // Never hand-ordered, which is what a queue looks like before anybody
        // has dragged anything: the chip lists it in board order.
        queueOrder: null,
      });
    }
    if (spec.seasonMarkets?.length) {
      seasonMarkets.set(
        spec.id,
        spec.seasonMarkets.map((m) => ({ market: m.market as SeasonMarketKey, line: m.line })),
      );
    }
    if (opts.injuriesAvailable !== false) {
      const injury = toInjuryState(spec, clock);
      if (injury) injuries.set(spec.id, injury);
    }
  }

  return { players, signals, flags, seasonMarkets, injuries };
}

// ------------------------------------------------------------------ repair

/** Nothing unresolved. The ordinary state, and the one that says nothing. */
export const CLEAN_REPAIR: BoardRepairStatus = {
  summary: { names: 0, net: 0, headline: 'Every name in the ledger is resolved.' },
};

/** Two names the matcher would not guess at, costing a real amount of tally. */
export const MESSY_REPAIR: BoardRepairStatus = {
  summary: {
    names: 2,
    net: -4,
    headline: '2 names are unresolved and are costing 4 points of tally',
  },
};

// ------------------------------------------------------------------- FAAB

/**
 * A league's budget position, built by the same reader production uses.
 *
 * The spend is written as Sleeper's own `waiver_budget_used` counter on each
 * roster, and `buildBudgetState` derives everything else — which is why a
 * scenario cannot accidentally state a remaining balance that disagrees with
 * its own spend.
 */
export function makeBudget(spentByRosterId: Map<number, number>): LeagueBudgetState {
  return buildBudgetState({
    leagueSettings: DEMO_LEAGUE_SETTINGS,
    rosters: DEMO_MANAGERS.map((m) => ({
      rosterId: m.rosterId,
      ownerName: m.name,
      isMine: m.isMine,
      settings: { waiver_budget_used: spentByRosterId.get(m.rosterId) ?? 0 },
    })),
  });
}

/** A league that does not bid at all — priority waivers. */
export function makeNoFaabBudget(): LeagueBudgetState {
  return buildBudgetState({
    leagueSettings: { waiver_type: 0 },
    rosters: DEMO_MANAGERS.map((m) => ({
      rosterId: m.rosterId,
      ownerName: m.name,
      isMine: m.isMine,
      settings: {},
    })),
  });
}

export function myBudgetLine(state: LeagueBudgetState): RosterBudget | null {
  return state.rosters.find((r) => r.isMine) ?? null;
}

export function makeTrending(
  entries: { playerId: string; rank: number; count: number; heat: number; acceleration?: number | null; entered?: boolean }[],
): Map<string, TrendingVelocity> {
  const out = new Map<string, TrendingVelocity>();
  for (const entry of entries) {
    out.set(entry.playerId, {
      playerId: entry.playerId,
      rank: entry.rank,
      count: entry.count,
      addsPerHour: Math.round((entry.count / 24) * 10) / 10,
      rankMovement: null,
      acceleration: entry.acceleration ?? null,
      entered: entry.entered ?? false,
      heat: entry.heat,
    });
  }
  return out;
}

// ------------------------------------------------------------------ Sleeper

export function makeNflState(opts: {
  season: string;
  seasonType: 'pre' | 'regular' | 'post' | 'off';
  week: number | null;
  clock: Clock;
}): NflState {
  return {
    season: opts.season,
    seasonType: opts.seasonType,
    week: opts.week,
    leg: opts.week,
    fetchedAt: hoursBefore(opts.clock, 1),
  };
}
