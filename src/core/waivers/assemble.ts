/**
 * The whole Waivers decision, in one call.
 *
 * Eight steps, in an order that matters, and until now they were written out
 * twice: once in `server/app.ts` and once in `core/demo/runtime/handlers.ts`,
 * where the comment beside the second copy said it mirrored the first "line for
 * line". It did, which is the problem — a pipeline that is correct because two
 * files agree is a pipeline that is one careless edit from two different waiver
 * boards in one app.
 *
 * There are now three callers and the third could not have been written any
 * other way: a support snapshot is replayed through *this* function, so the
 * claim plan an agent reproduces from a file is the claim plan the phone drew.
 *
 * ## The order, and why each step is where it is
 *
 *   1. **the lineup**, because everything downstream is measured against what
 *      the roster is already worth. Computed once and passed on rather than
 *      recomputed by each consumer;
 *   2. **the wire scan** — who would actually improve it;
 *   3. **multi-week value**, scoped to the players who made the board, because
 *      a valuation for the other forty is work nobody will read. It reorders
 *      nothing;
 *   4. **league intelligence** — who else needs him and can pay. The
 *      competition count is computed here because step 5 reads it;
 *   5. **pricing** — what to bid, given that competition;
 *   6. **the defence**, which owns the DEF row outright;
 *   7. **the board**, with competition folded on and the DEF row removed
 *      wherever the planner has an opinion, so `Stream NYJ over BUF` and
 *      `Hold BUF` can never be on screen together;
 *   8. **the claims** — who to add, what to bid, who to drop, in what order to
 *      enter them.
 *
 * ## What it does not do
 *
 * It reads nothing except through {@link WaiverAssemblyRequest.dstSources},
 * which is the same three-method interface `assembleDstPlan` already took and
 * which a live caller satisfies from stored rows and a demo from a fixture.
 * Everything else arrives as a value. No provider is touched, no player is
 * rescored, no price is recomputed and nothing is written — the whole of this
 * file is arithmetic over what the caller already holds.
 *
 * The response envelope — the league name, the freshness block, the FAAB
 * summary, the demo's own scenario notes — belongs to each caller. The decision
 * is what is here.
 */

import { DEFENCE_POSITION } from '../startsit/engine.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import {
  recommendWaiverUpgrades,
  type WaiverAdvice,
  type WaiverUnknown,
  type WaiverUpgrade,
  type WaiverValueAdd,
} from '../startsit/waivers.ts';
import { recommendLineup, type LineupRecommendation } from '../startsit/lineup.ts';
import { SEASON_GAMES, seasonOutlookFor } from './seasonOutlook.ts';
import type { SeasonMarketKey } from '../vegas/types.ts';
import { waiverMultiWeekFor } from '../contracts/integration.ts';
import { waiverLeagueIntel, withCompetition, type WaiverIntelRoster } from './intel.ts';
import { trendingHeadline, type TrendingVelocity } from '../market/trending.ts';
import { priceWaiverUpgrades, type PricedBid, type WaiverPricingContext } from './pricing.ts';
import type { WaiverClaimPlan } from './claimPlan.ts';
import { marketHoldFor } from './marketHold.ts';
import { findHandcuffs } from './yardstick.ts';
import { pickupStateFor, type PickupState, type WaiverRules } from './clearWindow.ts';
import { assembleDstPlan, type DstPlanSources } from '../dst/assemble.ts';
import { buildTierInputs } from './tierInputs.ts';
import type { AheadNumbers } from './aheadWeeks.ts';
import { planWaiverTiers } from './tiers.ts';
import { buildTiersView, tierClaimPlan, type WaiverTiersView } from './tierPlan.ts';
import { lastCompletedWeek } from '../sleeper/weekPoints.ts';
import type { ClaimRecord } from './bidModel.ts';
import type { ScheduleTeamWeek } from '../nfl/schedule.ts';
import type { DstPlan } from '../dst/planner.ts';
import type { LeagueBudgetState } from '../faab/budget.ts';
import type { BidObservation, PriceSummary } from '../faab/bids.ts';
import type { ManagerTransactionProfile, LeagueTransactionBaseline } from '../managers/transactionProfile.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';

/** What the ledger knows about the rivals, in the shape the intel pass reads. */
export interface WaiverHistoryContext {
  profiles: ReadonlyMap<number, ManagerTransactionProfile>;
  baseline: LeagueTransactionBaseline | null;
  week: number;
  finalWeek: number;
}

export interface WaiverAssemblyRequest {
  shape: RosterShape;
  profile: ScoringProfile;
  /** The user's own players, assembled for the weekly engine. */
  rosterInputs: StartSitInput[];
  /** The bounded free-agent scan, likewise. */
  candidateInputs: StartSitInput[];
  /**
   * Every player on every roster in the league. The hard exclusion.
   *
   * Passed rather than derived from `rosters` so the caller's own set is the one
   * the engine checks — it is the single mistake this feature must never make,
   * and a second construction of it here would be a second chance to get it
   * wrong.
   */
  rosteredIds: Set<string>;
  currentStarterIds: string[];
  reserveIds: string[];
  /** Every roster, for the competition read. */
  rosters: WaiverIntelRoster[];
  /** The whole player table, for resolving rivals' rosters to positions. */
  players: CanonicalPlayer[];
  week: number;
  season: string;
  /** Null in a league that does not bid, which removes pricing entirely. */
  strategy: WaiverPricingContext | null;
  /**
   * What the rest of Sleeper is adding, and how fast.
   *
   * Its own field rather than a reach into {@link strategy}, which is the
   * pricing context: attention is used to *surface* players now, not only to
   * price them, and a league that does not bid still has a wire the room is
   * chasing. Empty is the honest state for a deployment that has taken no
   * capture yet, and it costs the board its unknown tier rather than breaking it.
   */
  trending?: ReadonlyMap<string, TrendingVelocity> | undefined;
  /**
   * Each candidate's season-long market lines, for the rest-of-season read.
   *
   * Optional, and absent is a first-class state rather than a degraded one: a
   * deployment that has taken no season snapshot loses the season column and
   * keeps the board. See `waivers/seasonOutlook.ts` for why this exists beside
   * the four-week `multiWeek` column rather than instead of it — different
   * horizon, different source, and the one that can speak in week one.
   */
  seasonMarkets?: ReadonlyMap<string, { market: SeasonMarketKey; line: number | null }[]> | undefined;
  /**
   * Season totals from this league's own preseason capture, by player id.
   *
   * Reaches exactly one thing: the value of holding a bench player, which is
   * what the claim plan's drop half rests on. In September it is the only
   * durable reading that exists — a player's week-2 projection says nothing
   * about whether cutting him is a mistake — and it hands over to actual
   * production as games accumulate. See `core/roster/durableValue.ts`.
   *
   * Optional, and absent is the previous behaviour rather than a degraded one:
   * a deployment with no capture values a bench exactly as it did before.
   */
  preseasonPoints?: ReadonlyMap<string, number> | undefined;
  /**
   * Where this room's draft took each player, by player id. Smaller is earlier.
   *
   * Reaches the cut order and nothing else. The preseason capture above is the
   * better evidence about a player's *value*; this is the broader one about the
   * room's *conviction*, and it covers the board where the capture does not —
   * which on 16 September was the whole of why two well-drafted players were
   * offered as cuts. Optional, and absent is the previous behaviour.
   */
  draftRankOf?: ReadonlyMap<string, number> | undefined;
  /**
   * Sleeper's published weekly projection, for the roster and the scanned wire.
   *
   * The fallback yardstick: two players who are not both fully priced by Vegas
   * are compared on this, for both. Owner-approved for waivers on 30 September
   * 2026. Absent means no fallback, so only fully priced pairs compare.
   */
  published?: ReadonlyMap<string, number> | undefined;
  /**
   * Positions whose published projection this league may not read (its scoring
   * differs from the feed's). Only used to say why a free agent has no number.
   */
  refusedPositions?: readonly string[] | undefined;
  /**
   * Where the stored depth chart puts each rostered player at his position,
   * by player id. Read for one thing: whether a bench player is the backup to
   * one of your starters. Absent falls back to same club and position.
   */
  depth?: ReadonlyMap<string, { rank: number }> | undefined;
  /** Sleeper's trending drops, as velocity. The top ten are kept out of the plan. */
  trendingDrops?: ReadonlyMap<string, TrendingVelocity> | undefined;
  /** Players this roster dropped recently, with when. Said on the card, never hidden. */
  recentlyDropped?: ReadonlyMap<string, string> | undefined;
  /**
   * The league's waiver window: its rules, and the latest drop of each player
   * by anyone in the league. What separates a contested claim from an instant
   * add — see `waivers/clearWindow.ts`. Absent leaves every add priced, as
   * before.
   */
  waiverWindow?: { rules: WaiverRules; drops: ReadonlyMap<string, string> } | null | undefined;
  /**
   * What every player scored in the last finished week, in this league's
   * scoring, from the settings row `sleeper.weekPoints.<season>.<week>`. The
   * bid model's main pull. Absent or null: the model says it has no points on
   * record and reads every player as a middling pull.
   */
  lastWeekPoints?: { week: number; points: ReadonlyMap<string, number> } | null | undefined;
  /**
   * Each player with no number this week (a bye, nothing published), with his
   * latest earlier week of Sleeper's projection, for the tier planner's rate.
   * The same stand-in Check a trade uses. Absent: such a player is unvalued.
   */
  recentPublished?: ReadonlyMap<string, { week: number; points: number }> | undefined;
  /** Injured-reserve slots this league allows (`reserve_slots`). Absent: the roster shape's. */
  reserveSlots?: number | undefined;
  /**
   * Later weeks' own numbers for the tier planner: a complete Vegas week where
   * one is posted, else Sleeper's projection for that week in this league's
   * scoring (`core/waivers/aheadWeeks.ts`). Absent: every window week is valued
   * on this week's figure, as before.
   */
  ahead?: AheadNumbers | null | undefined;
  budgets: LeagueBudgetState | null;
  prices: PriceSummary | null;
  observations: BidObservation[];
  history?: WaiverHistoryContext | undefined;
  /**
   * The defence planner's three reads, or `null` to not plan a defence at all.
   *
   * Null is not the same as an empty plan. A league that starts no defence
   * should not have its schedule read to be told so, and `dst: null` is what
   * the DEF-row filter below reads as "the planner has no opinion" — which is
   * the state in which the generic scan is still allowed to offer a defence for
   * an empty slot.
   */
  dstSources: DstPlanSources | null;
  bestBall: boolean;
  draftComplete: boolean;
  playoff: { weeks: number[]; emphasis: number };
  now: Date;
  generatedAt?: string;
}

export interface WaiverAssembly extends WaiverAdvice {
  /** The board as drawn: competition folded on, the DEF row left to the planner. */
  upgrades: WaiverUpgrade[];
  /** Bench-value adds, with the multi-week read and any trending line attached. */
  valueAdds: WaiverValueAdd[];
  /**
   * The unscored worth naming: those Sleeper is adding, most-added first.
   *
   * Narrowed from the engine's full list — see the note beside the filter.
   */
  unknowns: (WaiverUnknown & {
    trending: string | null;
    adds: number | null;
    heat: number | null;
    leagueRank: number;
  })[];
  dst: DstPlan | null;
  /** What each recommended add should cost. Empty in a league that does not bid. */
  bids: PricedBid[];
  /**
   * The claim card: the "Do this" move from {@link tiers}, as an instruction.
   * Advisory — nothing here transacts.
   */
  claimPlan: WaiverClaimPlan | null;
  /**
   * The moves in three tiers, scored by what each adds to the best lineup over
   * the next three weeks, with a bid each and the drop-ready bench. What the
   * Waivers screen and Team's waiver line draw. See `waivers/tiers.ts`.
   */
  tiers: WaiverTiersView | null;
  /**
   * Each scanned free agent's state: still on waivers, or free to add now.
   * A record rather than a map so it survives the trip to the phone. Empty
   * when the league's window could not be read.
   */
  pickup: Record<string, PickupState>;
  /**
   * The lineup the whole board was measured against.
   *
   * Returned rather than thrown away because a snapshot has to be able to show
   * what "an upgrade" was an upgrade *over*, and because the DST planner and the
   * claim planner both read it — a caller that recomputed it could be measuring
   * against a different one.
   */
  lineup: LineupRecommendation;
}

/**
 * Sleeper's own line about a player, or nothing.
 *
 * Kept to one place so the string on a value-add row is the same string the
 * pricing pass puts on a priced bid: two different sentences about one player's
 * popularity, on one screen, would be the app disagreeing with itself.
 */
function lineFor(trending: ReadonlyMap<string, TrendingVelocity>, playerId: string): string | null {
  const v = trending.get(playerId);
  const line = v ? trendingHeadline(v, { availableInLeague: true }) : null;
  /* The rank is already on the row, from the scan. Only a velocity line adds anything. */
  return line != null && !line.startsWith('#') ? line : null;
}

/**
 * How high on Sleeper's trending adds a rostered player has to be before he is
 * not offered as a cut.
 *
 * The top ten of the published fifty. On 25 September 2026 the live plan said
 * `Drop Emanuel Wilson` while he was the #1 add in all of Sleeper — a million
 * adds in a day — because the plan knew his projection and nothing else. A
 * player the whole of Sleeper is picking up is one a rival claims the moment
 * he clears waivers, and the cut cannot be undone.
 */
export const ROOM_IS_ADDING_RANK = 10;

/** Rostered-or-not, the players at the top of Sleeper's adds list. */
export function roomIsAdding(trending: ReadonlyMap<string, TrendingVelocity>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [playerId, v] of trending) {
    if (v.rank != null && v.rank <= ROOM_IS_ADDING_RANK) out.set(playerId, v.rank);
  }
  return out;
}

/**
 * The lineup everything downstream is measured against.
 *
 * Exported because the defence planner's bench cost is measured against it and
 * the support capture has to hand the DST adapter the *same* one — a lineup
 * rebuilt at the call site from the same inputs is the same lineup right up
 * until somebody changes one of the two.
 */
export function waiverLineup(
  request: Pick<WaiverAssemblyRequest, 'rosterInputs' | 'shape' | 'profile' | 'currentStarterIds' | 'now' | 'published'>,
): LineupRecommendation {
  /*
   * With Sleeper's published week, the way the Team screen builds it, so the
   * lineup a waiver claim is measured against is the lineup the reader sees.
   */
  return recommendLineup(request.rosterInputs, request.shape, request.profile, {
    currentStarterIds: request.currentStarterIds,
    now: request.now,
    ...(request.published ? { published: request.published } : {}),
  });
}

export async function assembleWaiverPlan(request: WaiverAssemblyRequest): Promise<WaiverAssembly> {
  const { shape, profile, rosterInputs, candidateInputs, rosteredIds } = request;

  const lineup = waiverLineup(request);

  /*
   * What the rest of Sleeper is adding, read once for both of its jobs.
   *
   * It is a supplementary signal on the wire scan — a tie-break and a lift for
   * a borderline call, never a projection — and a guard on the drop side: the
   * player the whole of Sleeper is adding this week is not offered as a cut.
   */
  const trending: ReadonlyMap<string, TrendingVelocity> = request.trending ?? new Map();

  /*
   * Who the market says to hold, read once and handed to both halves: the
   * wire scan measures value adds against somebody cuttable, and the cut
   * planner refuses to name the same players. One list, so the board and the
   * plan cannot disagree about who is on the table.
   */
  const draftCapitalRank = request.rosters.length > 0 ? request.rosters.length * shape.totalStarters : undefined;
  const heldIds = new Map(
    [
      ...marketHoldFor({
        ...(request.draftRankOf === undefined ? {} : { draftRankOf: request.draftRankOf }),
        ...(draftCapitalRank === undefined ? {} : { draftCapitalRank }),
        roomIsAdding: roomIsAdding(trending),
        week: request.week,
      }),
    ].map(([id, hold]) => [
      id,
      hold.condition === 'trending' ? `#${hold.rank} add in Sleeper this week` : `drafted around pick ${Math.round(hold.rank)}`,
    ]),
  );

  /*
   * The backups to your own starters, cut only when nothing else can go.
   *
   * On 30 September 2026 the plan cut Emmett Johnson three times; he was the
   * direct backup to Kenneth Walker, the starting back on the same roster.
   */
  const starterIds = new Set(lineup.slots.map((s) => s.playerId).filter((id): id is string => id != null));
  const handcuffs = findHandcuffs({
    roster: rosterInputs.map((i) => ({
      playerId: i.player.id,
      name: i.player.fullName,
      position: i.player.position,
      team: i.player.team,
    })),
    starterIds,
    depth: request.depth ?? new Map(),
  });

  /*
   * Free spots, so a claim that needs no drop is not handed one. IR slots hold
   * their own players and are not bench spots.
   */
  const reserved = new Set(request.reserveIds);
  const openSpots = Math.max(
    0,
    shape.totalStarters + shape.benchSlots - rosterInputs.filter((i) => !reserved.has(i.player.id)).length,
  );

  const advice = recommendWaiverUpgrades({
    roster: rosterInputs,
    candidates: candidateInputs,
    shape,
    profile,
    rosteredPlayerIds: rosteredIds,
    currentStarterIds: request.currentStarterIds,
    reserveIds: request.reserveIds,
    lineup,
    calendar: { week: request.week, playoffWeeks: request.playoff.weeks },
    attention: new Map([...trending].map(([id, v]) => [id, { heat: v.heat, rank: v.rank }])),
    heldIds,
    ...(request.published === undefined ? {} : { published: request.published }),
    handcuffs,
    trendingDrops: new Map([...(request.trendingDrops ?? new Map<string, TrendingVelocity>())].map(([id, v]) => [id, { heat: v.heat, rank: v.rank }])),
    ...(request.recentlyDropped === undefined ? {} : { recentlyDropped: request.recentlyDropped }),
    openSpots,
    ...(request.refusedPositions === undefined ? {} : { refusedPositions: request.refusedPositions }),
    now: request.now,
  });

  /*
   * What each recommended add is worth past this Sunday.
   *
   * Scoped to the players who actually made the board. It changes no ordering:
   * `compareRows` sorts on strength and gain, and a level attached here is a
   * sentence on a row that had already earned its place.
   */
  const boardIds = [
    ...advice.upgrades.flatMap((upgrade) => upgrade.candidates.map((c) => c.playerId)),
    /*
     * The value adds are on the board too, so they are valued too.
     *
     * A bench add is precisely the claim a multi-week read matters most for: a
     * streamer worth one Sunday and a season-long hold look identical in this
     * week's points, and the difference is the whole decision.
     */
    ...advice.valueAdds.map((c) => c.playerId),
  ];
  const multiWeek = waiverMultiWeekFor({
    playerIds: boardIds,
    inputs: candidateInputs,
    scores: new Map([
      ...advice.upgrades.flatMap((u) => u.candidates.map((c) => [c.playerId, c.score] as const)),
      ...advice.valueAdds.map((c) => [c.playerId, c.score] as const),
    ]),
    profile,
    currentWeek: request.week,
  });
  /*
   * And the season, from the market rather than from form.
   *
   * `multiWeek` above is this week's score carried forward through role,
   * schedule and regression, so it needs stored usage and says nothing in week
   * one. Season lines are quoted before a snap is played and are already held
   * for the draft board, so the two answer the same reader's question from
   * opposite ends of the evidence. Neither is ranked on.
   */
  const seasonScores = new Map<string, number | null>([
    ...advice.upgrades.flatMap((u) => u.candidates.map((c) => [c.playerId, c.score] as const)),
    ...advice.valueAdds.map((c) => [c.playerId, c.score] as const),
  ]);
  const seasonOutlook = new Map<string, ReturnType<typeof seasonOutlookFor>>();
  if (request.seasonMarkets) {
    const gamesRemaining = Math.max(0, SEASON_GAMES - request.week + 1);
    for (const playerId of boardIds) {
      const markets = request.seasonMarkets.get(playerId);
      if (!markets || markets.length === 0) continue;
      const input = candidateInputs.find((c) => c.player.id === playerId);
      if (!input) continue;
      const outlook = seasonOutlookFor({
        position: input.player.position ?? '',
        markets,
        profile,
        thisWeekScore: seasonScores.get(playerId) ?? null,
        gamesRemaining,
      });
      /* `unknown` is not a finding, and a chip saying so on every row is noise. */
      if (outlook.level !== 'unknown') seasonOutlook.set(playerId, outlook);
    }
  }

  const upgradesWithValue = advice.upgrades.map((upgrade) => ({
    ...upgrade,
    candidates: upgrade.candidates.map((candidate) => {
      const value = multiWeek.get(candidate.playerId);
      const season = seasonOutlook.get(candidate.playerId);
      return value || season
        ? { ...candidate, ...(value ? { multiWeek: value } : {}), ...(season ? { seasonOutlook: season } : {}) }
        : candidate;
    }),
  }));

  /*
   * Who is still on waivers and who is an instant add, for every scanned free
   * agent. Read by pricing (a strong player inside the window is priced as
   * contested) and by the board and the plan (a free agent carries no bid).
   */
  const pickup: Record<string, PickupState> = {};
  if (request.waiverWindow) {
    const { rules, drops } = request.waiverWindow;
    for (const input of candidateInputs) {
      pickup[input.player.id] = pickupStateFor({
        droppedAt: drops.get(input.player.id) ?? null,
        kickoff: input.kickoff ?? null,
        hasTeam: input.player.team != null && input.player.team !== '',
        now: request.now,
        rules,
      });
    }
  }

  const intel = waiverLeagueIntel({
    /* Bench adds need a rival count too: they are priced now. */
    advice: { upgrades: advice.upgrades, valueAdds: advice.valueAdds },
    rosters: request.rosters,
    players: request.players,
    shape,
    /* Sleeper's published week, read for every rostered player: who has a weak starter. */
    projections: request.published ?? null,
    budgets: request.budgets,
    prices: request.prices,
    observations: request.observations,
    ...(request.history ? { history: request.history } : {}),
  });

  const bids = request.strategy
    ? priceWaiverUpgrades({
        advice: { upgrades: advice.upgrades, valueAdds: advice.valueAdds },
        strategy: request.strategy,
        rosteredIds,
        competition: intel.competition,
        pickup,
        heldIds,
      })
    : [];

  /*
   * The defence, decided in one place and drawn in two.
   *
   * Team and Waivers both read this response, so it is computed once here
   * rather than on each screen — which is the only way `Stream NYJ over BUF`
   * and `Hold BUF` can never be on screen at the same time in the same app.
   *
   * A failure is swallowed to null. Every other column is a complete answer to
   * a different question, and a schedule read that fell over is not a reason to
   * take the waiver board down.
   */
  const dst =
    request.dstSources == null
      ? null
      : await assembleDstPlan(request.dstSources, {
          season: request.season,
          week: request.week,
          shape,
          profile,
          bestBall: request.bestBall,
          draftComplete: request.draftComplete,
          rosterInputs,
          candidateInputs,
          lineup,
          reserveIds: request.reserveIds,
          playoff: request.playoff,
          now: request.now,
        }).catch(() => null);

  /*
   * One owner for the DEF row, and it is the planner.
   *
   * The generic scan already refuses a DEF-over-DEF swap. What it does still
   * offer is a defence for an *empty* DEF slot, and the planner can say
   * `Wait — your DEF slot is empty` about the same slot: two answers to one
   * question on one screen. The planner wins wherever it has an opinion; the
   * generic row survives only when the plan could not be computed at all.
   */
  const upgrades = withCompetition(upgradesWithValue, intel.competition, intel.bidders, intel.pressure).filter(
    (upgrade) => dst == null || !upgrade.accepts.every((p) => p === DEFENCE_POSITION),
  );

  /*
   * What the rest of Sleeper is doing, folded onto the board it belongs to.
   *
   * The wire scan above already used it as a tie-break. Below, it adds a
   * sentence to rows that earned their place and decides which unscored
   * players are worth naming at all. Nothing touches a projection or a gain.
   */
  /*
   * One owner for the defence, and it is still the planner.
   *
   * The same rule the upgrades above are filtered by, applied to the two new
   * streams for the same reason: the planner decides `Stream PHI over BUF` or
   * `Hold BUF`, and a generic `Bench value · Tennessee DEF` beside it is a second
   * answer to a question that already has one. Where the plan could not be
   * computed at all, `dst` is null and the generic rows are allowed through,
   * exactly as a generic DEF upgrade is.
   */
  const defenceIsPlanned = dst != null;
  const ownsDefence = (position: string) => defenceIsPlanned && position === DEFENCE_POSITION;

  const valueAddsWithIntel = advice.valueAdds.filter((add) => !ownsDefence(add.position)).map((add) => {
    const season = seasonOutlook.get(add.playerId);
    const value = multiWeek.get(add.playerId);
    const line = lineFor(trending, add.playerId);
    return {
      ...add,
      ...(value ? { multiWeek: value } : {}),
      ...(season ? { seasonOutlook: season } : {}),
      ...(line ? { reasons: [...add.reasons, line] } : {}),
    };
  });
  /*
   * The same competition fold the upgrades get: the rival count, the named
   * bidders when the evidence supports naming them, and the rivals' history.
   * A bench add is priced now, so the people who would bid against it belong
   * on its sheet as much as on an upgrade's.
   */
  const valueAdds = withCompetition(
    [{ candidates: valueAddsWithIntel }],
    intel.competition,
    intel.bidders,
    intel.pressure,
  )[0]!.candidates;

  /*
   * The unscored, narrowed to the ones the room is actually chasing.
   *
   * Every free agent the app could not score is a candidate here, and on a real
   * wire that is most of the pool — a page listing forty players it has nothing
   * to say about is worse than the empty page it replaced. Sleeper's own adds
   * list is the filter, and it is the right one: a player nobody is adding and
   * nothing can score is not a decision anybody is making this week, and he is
   * still counted in the sentence under the board rather than hidden. A player
   * being added ten thousand times *is* the decision, and he is exactly who the
   * old board could never show.
   *
   * Ordered by Sleeper's published rank, carried as `leagueRank` because that is
   * literally what it is: where a ranking put him. This tier has no other order
   * available, every one of these rows having no score to sort on.
   */
  const unknowns = advice.unknowns
    .filter((unknown) => !ownsDefence(unknown.position))
    .map((unknown) => {
      const v = trending.get(unknown.playerId);
      if (!v || v.rank == null) return null;
      return {
        ...unknown,
        trending: trendingHeadline(v, { availableInLeague: true }),
        adds: v.count,
        heat: v.heat,
        leagueRank: v.rank as number,
      };
    })
    .filter((u): u is NonNullable<typeof u> => u != null)
    .sort((a, b) => a.leagueRank - b.leagueRank);

  /*
   * The tiers: every scanned free agent scored by what he adds to the best
   * lineup over the next three weeks, paired with his best drop, and a bid
   * from the league's own bidding behaviour. A failure is swallowed to null,
   * like the defence above: the board underneath still stands.
   */
  const tiers = await (async (): Promise<WaiverTiersView | null> => {
    try {
      const clubs = [
        ...new Set([...rosterInputs, ...candidateInputs].map((i) => (i.player.team ?? '').toUpperCase()).filter((t) => t.length > 0)),
      ].sort();
      const fixtures: ScheduleTeamWeek[] =
        request.dstSources && clubs.length > 0
          ? await request.dstSources
              .scheduleForTeams(request.season, clubs, { from: request.week, to: request.week + 3 })
              .catch(() => [] as ScheduleTeamWeek[])
          : [];
      const inputs = buildTierInputs({
        shape,
        profile,
        week: request.week,
        now: request.now,
        rosterInputs,
        candidateInputs,
        rosteredIds,
        reserveIds: request.reserveIds,
        published: request.published,
        recentPublished: request.recentPublished,
        fixtures,
        pickup,
        held: heldIds,
        depth: request.depth,
        trendingDrops: new Map([...(request.trendingDrops ?? new Map<string, TrendingVelocity>())].map(([id, v]) => [id, { heat: v.heat, rank: v.rank }])),
        reserveSlots: request.reserveSlots ?? shape.irSlots,
        excludedPositions: new Set([DEFENCE_POSITION]),
        ahead: request.ahead ?? null,
      });
      const plan = planWaiverTiers(inputs.request);
      const claims: ClaimRecord[] = request.observations
        .filter((o) => o.playerId != null)
        .map((o) => ({
          rosterId: o.rosterId,
          playerId: o.playerId!,
          amount: o.amount,
          won: o.outcome === 'won',
          voided: o.voided === true,
          run: `week ${o.week}`,
        }));
      const lastWeek = request.lastWeekPoints ?? null;
      return buildTiersView({
        plan,
        pickup,
        rules: request.waiverWindow?.rules ?? null,
        budgets: request.budgets,
        prices: request.prices,
        claims,
        seats: request.rosters.map((r) => ({ rosterId: r.rosterId, name: r.ownerName ?? `Roster ${r.rosterId}`, isMine: r.isMine })),
        lastWeek: lastWeek
          ? { week: lastWeek.week, points: lastWeek.points }
          : {
              week: lastCompletedWeek(request.week, [...rosterInputs, ...candidateInputs].map((i) => i.kickoff ?? null), request.now),
              points: null,
            },
        trending: new Map([...trending].map(([id, v]) => [id, { heat: v.heat, rank: v.rank }])),
        held: heldIds,
        paidFor: new Set(claims.filter((c) => c.won && c.amount >= 3).map((c) => c.playerId)),
        evaluations: inputs.evaluations,
        week: request.week,
        finalWeek: request.history?.finalWeek ?? request.strategy?.finalWeek ?? 14,
      });
    } catch {
      return null;
    }
  })();

  /*
   * And the claim card, from the tiers: the "Do this" move as the instruction
   * to type into Sleeper. A failure is swallowed to an unsurfaced plan.
   */
  const claimPlan = (() => {
    try {
      return tiers ? tierClaimPlan(tiers, request.generatedAt ?? new Date().toISOString()) : null;
    } catch {
      return null;
    }
  })();

  return { ...advice, upgrades, valueAdds, unknowns, dst, bids, claimPlan, tiers, lineup, pickup };
}
