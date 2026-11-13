/**
 * The upside stash: a free agent who does nothing for you this week but has a
 * clear path to starting for you in the playoffs (weeks 15 to 17).
 *
 * Alex's third kind of waiver move (review W5, 5 November 2026). The tiers
 * already cover the first two, a starter now and cover for a bye or injury
 * (`tiers.ts`, `pickupStart.ts`), and value every player on the rest of the
 * season (`core/value/restOfSeason.ts`), so a healthy player whose value is
 * simply later in the year is already counted there. What a season average
 * cannot see is a player whose value depends on something that has not
 * happened yet. Two such paths, read only from data already stored:
 *
 *  1. **Back for the playoffs.** Out or on IR now, due back by week 16
 *     (`stash.ts`, read from Sleeper's injury note), and good enough when
 *     healthy to start for you: his healthy season number earns a place in
 *     your best season lineup.
 *  2. **Next man up.** A running back second on his club's depth chart
 *     behind a starter who is one of the league's top backs this season
 *     (`eliteBacks`, points a game) and is hurt now (any designation, from
 *     Questionable to IR). If the starter misses the playoffs, the backup
 *     inherits a role worth a start for you: the starter's points a game earn
 *     a place in your best season lineup.
 *
 * And the cost, which is what makes it a stash rather than a pickup:
 *
 *  - **A spot you are not using.** An open IR slot when the league's IR takes
 *    him, else an open bench spot, else a drop-ready bench player (he starts
 *    no week of the season and a free agent is about as good) that no other
 *    line on the screen is using. Never a player who plays: a stash never
 *    forces a worse drop.
 *  - **A small bid.** $0 to {@link STASH_UPSIDE.maxBid}, inside the $20
 *    playoff reserve. A free agent needs none.
 *
 * At most one stash a week, the strongest path first. One shared function:
 * the Waivers screen and its support snapshot both call {@link upsideStash}.
 *
 * Pure.
 */

import { bestLineup, slotsOf, type LineupCandidate } from '../tradeValue/lineup.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import type { StashVerdict } from './stash.ts';
import { eliteBacks } from './dropScore.ts';
import { smartBid } from '../faab/smartBid.ts';
import type { OpportunityLead } from './opportunity.ts';

export const STASH_UPSIDE = {
  /** The most a stash bids: a stash is a cheap bet, never a fight. */
  maxBid: 1,
  /** Only backs: a depth chart's second back inherits the job; a receiver's does not. */
  nextManUpPositions: ['RB'] as readonly string[],
} as const;

/** Sleeper's words for a starter who is hurt now. Healthy and unknown are not. */
const HURT = new Set(['questionable', 'doubtful', 'out', 'ir', 'pup', 'sus', 'suspended', 'injured reserve']);

/** One player as the stash reads him: his season number, healthy. */
export interface StashPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Points a game for the rest of the season, healthy. Null: unvalued. */
  seasonRate: number | null;
  /** The app's designation (`out`, `ir`, `questionable`, `healthy`...). */
  designation: string;
  onReserve?: boolean;
}

export interface StashCandidate extends StashPlayer {
  /** A free agent now (first come), rather than on waivers. */
  free: boolean;
  /** Does he add to your lineup in the first week a move can change? Then he is a pickup, not a stash. */
  helpsNow: boolean;
  /** Excluded from the plan for another reason (a top trending drop). */
  planExcluded?: boolean;
}

export type StashRoom =
  | { kind: 'reserve' }
  | { kind: 'open' }
  | { kind: 'drop'; playerId: string; name: string };

export interface UpsideStashRequest {
  shape: RosterShape;
  /** Your roster, on season numbers. */
  roster: readonly StashPlayer[];
  candidates: readonly StashCandidate[];
  /** Free agents already on another line: never also a stash. */
  taken: ReadonlySet<string>;
  excludedPositions: ReadonlySet<string>;
  /** The return verdict for each injured free agent (`stash.ts`). */
  verdicts: ReadonlyMap<string, StashVerdict>;
  /** Whether an open IR slot can take this player now (his designation, the league's rules). */
  reserveTakes: (designation: string) => boolean;
  /** Open IR slots, open bench spots, and drop-ready players nobody else is using. */
  room: { reserve: number; open: number; dropReady: readonly { playerId: string; name: string }[] };
  /** Next man up: every player's club, position and name (the league's player table). */
  players: readonly { id: string; fullName: string; team: string; position: string }[];
  /** Sleeper's depth-chart order per player. */
  depthOrder: ReadonlyMap<string, number>;
  /** Sleeper's injury status per player, any case. */
  injuryStatus: ReadonlyMap<string, string | null>;
  /** The league's top backs this season, with their points a game. */
  elite: ReadonlyMap<string, number>;
  /** What a bid may spend now: FAAB left less the playoff reserve. Null: unknown. */
  spendable: number | null;
  usesFaab: boolean;
  /**
   * Round 26 (`WAIVERS_LOOKAHEAD`): free agents who inherit a starter's role
   * (`opportunity.ts`), by player id. Such a player is judged on his role's
   * estimate and comes first. He is still a stash: the Round 20 stash bid,
   * $0 or $1, inside the playoff reserve. Absent: the two paths above only.
   */
  opportunities?: ReadonlyMap<string, OpportunityLead>;
}

export type StashPath =
  | { kind: 'returning'; week: number | null; label: string }
  | { kind: 'next_man_up'; starterId: string; starterName: string; starterRate: number }
  | { kind: 'opportunity'; starterId: string; starterName: string; cause: OpportunityLead['vacancy']['cause']; estimate: number; basis: OpportunityLead['basis'] };

export interface UpsideStashLine {
  playerId: string;
  name: string;
  position: string;
  team: string;
  path: StashPath;
  /** `back around week 13`, `next up behind Bijan Robinson, hurt`: the line's one reason. */
  reason: string;
  /** The season number that earns him a start for you: his own healthy one, or the starter's. Not drawn. */
  value: number;
  bid: { kind: 'free' } | { kind: 'none' } | { kind: 'claim'; low: number; high: number };
  room: StashRoom;
}

/** The one stash worth making this week, or null. */
export function upsideStash(request: UpsideStashRequest): UpsideStashLine | null {
  const bid = stashBid(request);
  const slots = slotsOf(request.shape).filter((s) => [...s.eligible].some((p) => !request.excludedPositions.has(p)));
  const pool: LineupCandidate[] = request.roster
    .filter((p) => !p.onReserve && !request.excludedPositions.has(p.position) && p.seasonRate != null)
    .map((p) => ({ id: p.playerId, position: p.position, value: Math.max(0, p.seasonRate ?? 0) }));
  /* Would a player worth `value` a game start for you over the season? */
  const startsForYou = (id: string, position: string, value: number): boolean =>
    bestLineup(slots, [...pool, { id, position, value }]).picks.some((x) => x?.id === id);

  const found: { c: StashCandidate; path: StashPath; value: number }[] = [];
  for (const c of request.candidates) {
    if (c.planExcluded || request.taken.has(c.playerId) || request.excludedPositions.has(c.position)) continue;
    /* Round 26: a role he inherits. Judged on the role, so helping this week does not hand him to the tiers. */
    const lead = request.opportunities?.get(c.playerId);
    if (lead) {
      if (startsForYou(c.playerId, c.position, lead.estimate)) {
        found.push({
          c,
          path: {
            kind: 'opportunity',
            starterId: lead.vacancy.playerId,
            starterName: lead.vacancy.name,
            cause: lead.vacancy.cause,
            estimate: lead.estimate,
            basis: lead.basis,
          },
          value: lead.estimate,
        });
      }
      continue;
    }
    if (c.helpsNow) continue;
    const path = stashPath(c, request);
    if (!path) continue;
    const value = path.kind === 'returning' ? (c.seasonRate ?? 0) : path.kind === 'next_man_up' ? path.starterRate : path.estimate;
    if (!(value > 0) || !startsForYou(c.playerId, c.position, value)) continue;
    found.push({ c, path, value });
  }
  /* A role opening now first (Round 26), then back for the playoffs (the surer path), then the most valuable role. */
  const rank = (p: StashPath) => (p.kind === 'opportunity' ? 2 : p.kind === 'returning' ? 1 : 0);
  found.sort((a, b) => rank(b.path) - rank(a.path) || b.value - a.value || a.c.name.localeCompare(b.c.name));
  for (const { c, path, value } of found) {
    const room = roomFor(c, path, request);
    if (!room || !bid) continue;
    const lead = path.kind === 'opportunity' ? request.opportunities?.get(c.playerId) : undefined;
    return {
      playerId: c.playerId,
      name: c.name,
      position: c.position,
      team: c.team,
      path,
      reason: lead ? lead.reason : path.kind === 'returning' ? path.label : `next up behind ${path.starterName}, hurt`,
      value: round2(value),
      /* Every stash, an inherited role included, bids the Round 20 stash rule: $0 or $1. */
      bid: c.free ? { kind: 'free' } : bid,
      room,
    };
  }
  return null;
}

/**
 * His path to playoff value, or null. Shared by the line above and the wire
 * scan (`stashScanIds`), so the players scanned are the players judged.
 */
export function stashPath(
  c: Pick<StashCandidate, 'playerId' | 'team' | 'position' | 'designation'>,
  request: Pick<UpsideStashRequest, 'verdicts' | 'players' | 'depthOrder' | 'injuryStatus' | 'elite'>,
): StashPath | null {
  const verdict = request.verdicts.get(c.playerId);
  if (['out', 'ir', 'pup'].includes(c.designation)) {
    /* Back by week 16 (`stash.ts`); season-ending, too late and unknown are never a stash. */
    if (verdict?.kind !== 'back_by') return null;
    return { kind: 'returning', week: verdict.week, label: verdict.label.startsWith('Out this week') ? 'Out this week, back soon' : verdict.label };
  }
  const starter = injuredStarterAhead(c, request);
  return starter ? { kind: 'next_man_up', starterId: starter.id, starterName: starter.fullName, starterRate: starter.rate } : null;
}

/** The hurt top back this player is next up behind, on Sleeper's depth chart. */
function injuredStarterAhead(
  c: Pick<StashCandidate, 'playerId' | 'team' | 'position'>,
  request: Pick<UpsideStashRequest, 'players' | 'depthOrder' | 'injuryStatus' | 'elite'>,
): { id: string; fullName: string; rate: number } | null {
  if (!STASH_UPSIDE.nextManUpPositions.includes(c.position.toUpperCase())) return null;
  if (request.depthOrder.get(c.playerId) !== 2 || !c.team) return null;
  const club = c.team.toUpperCase();
  for (const p of request.players) {
    if (p.id === c.playerId || (p.team ?? '').toUpperCase() !== club || p.position.toUpperCase() !== c.position.toUpperCase()) continue;
    if (request.depthOrder.get(p.id) !== 1) continue;
    const rate = request.elite.get(p.id);
    const hurt = HURT.has((request.injuryStatus.get(p.id) ?? '').trim().toLowerCase());
    if (rate != null && hurt) return { id: p.id, fullName: p.fullName, rate };
  }
  return null;
}

/**
 * The free agents worth scanning for a next-man-up stash: the second back
 * behind every hurt top back. Few a week (often none), so they cost only
 * their own rows in the batched reads.
 */
export function stashScanIds(opts: {
  players: readonly { id: string; fullName: string; team: string; position: string; active: boolean }[];
  rosteredIds: ReadonlySet<string>;
  exclude: ReadonlySet<string>;
  depthOrder: ReadonlyMap<string, number>;
  injuryStatus: ReadonlyMap<string, string | null>;
  elite: ReadonlyMap<string, number>;
}): string[] {
  const out: string[] = [];
  for (const p of opts.players) {
    if (!p.active || opts.rosteredIds.has(p.id) || opts.exclude.has(p.id)) continue;
    const ahead = injuredStarterAhead({ playerId: p.id, team: p.team, position: p.position }, opts);
    if (ahead) out.push(p.id);
  }
  return out.sort();
}

/**
 * The league's top backs this season and their points a game, from the
 * stored season row: the shared `eliteBacks` rule (`dropScore.ts`).
 */
export function eliteBackRates(
  seasonPoints: ReadonlyMap<string, readonly number[]>,
  isBack: (playerId: string) => boolean,
): Map<string, number> {
  const totals = new Map<string, { total: number; games: number }>();
  for (const [id, weeks] of seasonPoints) totals.set(id, { total: weeks.reduce((a, b) => a + b, 0), games: weeks.filter((x) => x !== 0).length });
  const out = new Map<string, number>();
  for (const id of eliteBacks(totals, isBack)) {
    const t = totals.get(id)!;
    out.set(id, round2(t.total / Math.max(1, t.games)));
  }
  return out;
}

function roomFor(c: StashCandidate, path: StashPath, request: UpsideStashRequest): StashRoom | null {
  if (path.kind === 'returning' && request.room.reserve > 0 && request.reserveTakes(c.designation)) return { kind: 'reserve' };
  if (request.room.open > 0) return { kind: 'open' };
  const drop = request.room.dropReady[0];
  return drop ? { kind: 'drop', playerId: drop.playerId, name: drop.name } : null;
}

/** One number, $1 at most, inside the playoff reserve: the shared bid rule (round 20). */
function stashBid(request: UpsideStashRequest): UpsideStashLine['bid'] | null {
  if (!request.usesFaab) return { kind: 'none' };
  if (request.spendable == null) return null;
  const { bid } = smartBid({ kind: 'stash', position: '', gain: null, expectedRivals: null, spendable: request.spendable });
  return { kind: 'claim', low: bid, high: bid };
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
