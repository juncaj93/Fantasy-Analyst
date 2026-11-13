/**
 * The free-agent pool: who counts as "on the wire" for Waivers and for Trades.
 *
 * ## Why one function (Alex, Round 15)
 *
 * Both screens measure a player against the best free agents at his position
 * (the average of the best three, `replacementLevels` in
 * `tradeValue/evaluate.ts`). Until Round 15 they chose those free agents
 * differently. Waivers scanned the draft-order top 12 per position plus five
 * extra slices below; Trades took the top 10 by Sleeper's search rank alone,
 * so a backup whose week just jumped, or last week's breakout, set Waivers'
 * level and not Trades'. The two screens then answered "what is a free agent
 * worth" with different numbers (Round 13 finding).
 *
 * Now both build the pool here (`seasonPool` below), in this order:
 *
 *  1. the draft-order slice (`boundedFreeAgentIds`, 12 per position, every
 *     defence);
 *  2. anybody this league dropped in the last week;
 *  3. the best 4 per position by this week's published number;
 *  4. Sleeper's 10 most-added;
 *  5. last week's top 3 scorers per position;
 *  6. the back behind every hurt top back;
 *  7. with `WAIVERS_LOOKAHEAD` on (Round 26), the free agent who inherits a
 *     starter's role: out for the season, on IR, traded or benched.
 *
 * Pure: every input is something the caller has already read.
 */

import type { CanonicalPlayer } from '../identity/types.ts';
import {
  boundedFreeAgentIds,
  lastWeekScorerIds,
  publishedFreeAgentIds,
  trendingFreeAgentIds,
} from './freeAgents.ts';
import { eliteBackRates, stashScanIds } from '../waivers/upsideStash.ts';
import { opportunityScanIds } from '../waivers/opportunity.ts';
import type { InjuryNote } from '../waivers/stash.ts';

export interface WirePoolInputs {
  players: CanonicalPlayer[];
  rosteredIds: Set<string>;
  /** Positions the league starts. Empty: every position. */
  startable: Set<string>;
  /** Draft order, when a ranking has been imported. */
  ranks: Map<string, { adp: number | null }>;
  /** Players any manager dropped inside the waiver window. */
  leagueDrops: Iterable<string>;
  /** This week's published number by player, or null when the week is not stored. */
  published: ReadonlyMap<string, number> | null;
  /** Sleeper's trending adds: player to rank. */
  trending: ReadonlyMap<string, { rank: number | null }>;
  /** This season's league points by week, and the last week they cover. Null: not stored yet. */
  season: {
    points: Readonly<Record<string, readonly number[]>>;
    through: number;
    depthOrder: Readonly<Record<string, number>>;
    injuryStatus: Readonly<Record<string, string | null>>;
  } | null;
  /**
   * Round 26 (`WAIVERS_LOOKAHEAD`): also scan the free agents who inherit a
   * starter's role (`waivers/opportunity.ts`), slice 7. Absent: six slices, as before.
   */
  opportunity?: {
    week: number;
    injuryNotes: Readonly<Record<string, InjuryNote>>;
    moved?: Readonly<Record<string, { from: string; to: string; week?: number }>>;
  } | null;
}

/**
 * The scan, and the season pool inside it.
 *
 * `ids` is everybody Waivers scans for a pickup. `seasonPool` is the pool built
 * as if slice 3 (this week's published number) did not exist: that slice exists to catch
 * a one-week jump, a backup starting while the starter is out, which is a
 * pickup for this week and not what a free agent is worth over a season. The
 * season pool is the one both screens average for "the best free agents"
 * (Waivers' season replacement level and Trades' replacement level), and it
 * needs no read of the stored week, so Trades pays only for the stored rows
 * it already had and the league's own (drops, trending, season points).
 */
export function wirePool(input: WirePoolInputs): {
  ids: string[];
  seasonPool: string[];
  lastWeekIds: string[];
  stashIds: string[];
} {
  const { players, rosteredIds, startable } = input;
  const scanned = boundedFreeAgentIds(players, { rosteredIds, startable, ranks: input.ranks });
  const scannedSet = new Set(scanned);
  const byId = new Map(players.map((p) => [p.id, p] as const));
  const inWindow = [...input.leagueDrops].filter((id) => {
    if (rosteredIds.has(id) || scannedSet.has(id)) return false;
    const p = byId.get(id);
    return p != null && p.active && (startable.size === 0 || startable.has(p.position));
  });
  const byWeek = input.published
    ? publishedFreeAgentIds(players, {
        rosteredIds,
        startable,
        published: input.published,
        exclude: new Set([...scanned, ...inWindow]),
      })
    : [];
  /*
   * Slices 4 to 6, each leaving out who an earlier slice already took. Run
   * twice: once after this week's published slice (the scan, as before) and
   * once without it (the season pool). Running them once and removing slice 3
   * afterwards was the Round 15 probe's finding: a player in slice 3 then
   * pushed somebody else out of the trending top 10 on Waivers but not on
   * Trades (90 players against 93 on Alex's league, 9 November 2026). The
   * season pool is always inside the scan: leaving fewer players out only moves
   * a player up a slice, never off it.
   */
  const season = input.season;
  const positionOf = new Map(players.map((p) => [p.id, p.position ?? null] as const));
  const later = (taken: readonly string[]) => {
    const trendingIds = trendingFreeAgentIds(players, {
      rosteredIds,
      startable,
      trending: input.trending,
      exclude: new Set(taken),
    });
    const lastWeekIds = season
      ? lastWeekScorerIds(players, {
          rosteredIds,
          startable,
          seasonPoints: season.points,
          week: season.through,
          exclude: new Set([...taken, ...trendingIds]),
        })
      : [];
    const stashIds = season
      ? stashScanIds({
          players,
          rosteredIds,
          exclude: new Set([...taken, ...trendingIds, ...lastWeekIds]),
          depthOrder: new Map(Object.entries(season.depthOrder)),
          injuryStatus: new Map(Object.entries(season.injuryStatus)),
          elite: eliteBackRates(new Map(Object.entries(season.points)), (id) => positionOf.get(id) === 'RB'),
        })
      : [];
    const opportunityIds =
      season && input.opportunity
        ? opportunityScanIds(
            {
              week: input.opportunity.week,
              players,
              rosteredIds,
              depthOrder: new Map(Object.entries(season.depthOrder)),
              injuryNotes: new Map(Object.entries(input.opportunity.injuryNotes)),
              seasonPoints: new Map(Object.entries(season.points)),
              through: season.through,
              moved: new Map(Object.entries(input.opportunity.moved ?? {})),
            },
            new Set([...taken, ...trendingIds, ...lastWeekIds, ...stashIds]),
          )
        : [];
    return { trendingIds, lastWeekIds, stashIds, opportunityIds };
  };
  const scan = later([...scanned, ...inWindow, ...byWeek]);
  const pool = byWeek.length === 0 ? scan : later([...scanned, ...inWindow]);
  return {
    ids: [...scanned, ...inWindow, ...byWeek, ...scan.trendingIds, ...scan.lastWeekIds, ...scan.stashIds, ...scan.opportunityIds],
    /* Slice 7 stays out of the season pool: an inherited role is not what a free agent is worth, so replacement levels do not move. */
    seasonPool: [...scanned, ...inWindow, ...pool.trendingIds, ...pool.lastWeekIds, ...pool.stashIds],
    lastWeekIds: scan.lastWeekIds,
    stashIds: scan.stashIds,
  };
}
