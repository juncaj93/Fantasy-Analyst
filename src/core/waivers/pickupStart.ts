/**
 * "Pick up and start": a free agent who makes this week's best lineup better
 * than any lineup the roster can already make.
 *
 * ## Why this exists (Alex, 18 October 2026)
 *
 * Best move said `Start Ladd McConkey over Emeka Egbuka`, which was right as
 * far as it went: it only ever looked at the roster. Jaleel McLaughlin sat on
 * the wire with a Vegas number as high as McConkey's, and the usual reason a
 * free agent's number jumps on a Sunday is that his team's starter was ruled
 * Out and the books moved the yards line for the replacement. That is worth a
 * heads-up on the one line that says what to do.
 *
 * ## How the gain is measured
 *
 * Never one slot against one player. The best legal full lineup with him is
 * compared with the best legal full lineup without him, both solved by
 * `solveLineup` (the Team lineup's own assignment, a Sleeper-only number two points lower), so players
 * move between slots: a receiver slides from FLEX to WR3 and the back takes
 * FLEX. And "without him" is the best lineup the roster can already make, not
 * Sleeper's current one: a free agent who only matches a player already on the
 * bench adds nothing.
 *
 * Two numbers come out per free agent:
 *
 *  - `gain`: best lineup with him (he may or may not start) minus the best
 *    lineup without him. What the add is worth this week.
 *  - `margin`: the best lineup with him forced in, minus the same. Equal to
 *    `gain` whenever he starts; negative by however much worse he is when he
 *    would not. This is what tells a tie from a loss.
 *
 * ## The rule
 *
 *  - `gain` clearing the toss-up bar (`TOSSUP_POINTS`, two points, the same
 *    bar as Team and Compare since 4 November 2026; it was 0.5): **start**.
 *    Best move says `Pick up and start <player>`. Filling a slot nobody holds,
 *    or replacing a Doubtful starter, is a real hole and needs no bar.
 *  - Otherwise `margin` no worse than {@link PICKUP_START.tie} below zero: a
 *    **tie or small gain** (anything from a 0.05 loss up to just under the
 *    headline, so a gain of 0.2 is here too). No headline; a softer Worth
 *    considering row on Waivers and one line in the Best move sheet.
 *  - Anything else: nothing.
 *
 * Only a free agent who can be added now, before his game, with every line his
 * position is priced on and no injury designation. A player on a waiver clock
 * stays on Waivers (`notNow`), and a Sleeper-only number never headlines, the
 * same rule as `lineup@5`.
 *
 * Nothing here adds, drops or claims anybody. It returns recommendations.
 */

import { solveLineup, type SolvablePlayer, type SolvedLineup } from '../startsit/lineup.ts';
import type { DecisionBasis } from '../startsit/decisionPoints.ts';
import type { RosterShape } from '../sleeper/rosterShape.ts';
import type { PickupState } from './clearWindow.ts';
import { clearsTossUp, isRealHole, TOSSUP_POINTS } from '../startsit/tossup.ts';

/** The thresholds, in this week's lineup points. */
export const PICKUP_START = {
  /**
   * How far below the best owned lineup still reads as a tie: half a tenth,
   * so two players who print the same number at one decimal tie.
   */
  tie: 0.05,
  /** Ties shown at most. */
  maxTies: 2,
} as const;

/** One player as this test reads him. */
export interface PickupPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** This week's decision number (`decisionPoints`), or null with none. */
  points: number | null;
  /** Where it came from: `market` is a full set of Vegas lines. */
  basis: DecisionBasis | 'none';
  /** Out, IR, PUP or suspended. */
  ruledOut: boolean;
  /** His game has kicked off. */
  locked: boolean;
  /** The injury designation, `healthy` or null when there is none. */
  designation: string | null;
  /** In an injured-reserve slot. */
  onReserve?: boolean;
}

export interface PickupStartRequest {
  shape: RosterShape;
  /** Alex's players. */
  roster: readonly PickupPlayer[];
  /** The scanned wire. */
  candidates: readonly PickupPlayer[];
  /** Sleeper's lineup as set now. */
  currentStarterIds: readonly string[];
  /** Waiver clock per free agent (`clearWindow.ts`). Absent: not known, so not an instant add. */
  pickup: Readonly<Record<string, PickupState>>;
  /** Free bench spots. Zero: every add needs a drop. */
  openSpots: number;
  /** The waiver planner's drop for this add, or null when no honest drop is left. */
  dropFor?: (playerId: string) => PickupDrop | null;
  /**
   * With a full roster and no honest drop: the planner's cheapest bench
   * players to free a spot with, cheapest first, protections respected. The
   * move then says "Pick your drop" and lists them; anybody in the lineup with
   * him is left out here. Absent or empty: no call can be made.
   */
  spotChoices?: (playerId: string) => PickupSpotChoice[];
  /** A teammate starter at his position who is Out or Doubtful, or null. */
  starterOut?: (player: PickupPlayer) => { playerId: string; name: string } | null;
}

export interface PickupDrop {
  playerId: string;
  name: string;
  /** Not a cut: he moves to an open IR slot. */
  viaReserve?: boolean;
}

/** A bench player Alex could cut to make room, with the planner's short reason. */
export interface PickupSpotChoice {
  playerId: string;
  name: string;
  /** `no start in weeks 6 to 8`, `handcuff to Kenneth Walker`. */
  reason?: string | null;
}

export interface PickupStartMove {
  verdict: 'start' | 'consider';
  playerId: string;
  name: string;
  position: string;
  team: string;
  points: number;
  /** Best lineup with him minus the best lineup without him. Not rounded. */
  gain: number;
  /** Best lineup with him forced in minus the best lineup without him. Not rounded. */
  margin: number;
  /** The slot he takes in that lineup. */
  slot: string | null;
  /**
   * The player the card names, `over Jordan Love`: the same player as
   * {@link displaces}, or null when he fills a slot nobody holds. Kept as its
   * own field for the Team card; never a different player (3 November 2026).
   */
  over: { playerId: string; name: string; points: number | null } | null;
  /**
   * The player he really replaces: who leaves the best lineup the roster can
   * already make, and always someone who can play a slot he can play. A QB
   * only ever replaces a QB in a one-QB league. See {@link replacedOf}.
   */
  displaces: { playerId: string; name: string; points: number } | null;
  /** Who goes to make room, when the roster is full and the planner has an honest drop. */
  drop: PickupDrop | null;
  /**
   * Full roster, no honest drop: Alex picks. The cheapest few to free a spot
   * with, none of them in the lineup with him. Null when no drop is needed or
   * one is named in {@link drop}.
   */
  pickDrop: PickupSpotChoice[] | null;
  /** A teammate starter at his position who is Out or Doubtful. */
  starterOut: { playerId: string; name: string } | null;
}

export type PickupAuditStatus =
  | 'start'
  | 'consider'
  | 'below'
  | 'not_priced'
  | 'injured'
  | 'defence_planner'
  | 'not_now'
  | 'no_drop'
  /** A tie this week that loses over the rest of the season (Round 15): not shown. */
  | 'worse_over_season';

export interface PickupStartPlan {
  threshold: number;
  tieTolerance: number;
  /** The best lineup the roster can already make, summed. */
  bestOwned: number;
  bestOwnedSlots: { slot: string; playerId: string }[];
  /** The headline, or null: Best move behaves as before. */
  start: PickupStartMove | null;
  /** Ties: Worth considering, never a headline. */
  consider: PickupStartMove[];
  /** Would have cleared the bar, but cannot be added before his game. Shown on Waivers only. */
  notNow: { playerId: string; name: string; gain: number; why: 'waivers' | 'game_started' | 'unknown' }[];
  /** Every scanned free agent at a starting position, for the report. Not drawn. */
  audit: {
    playerId: string;
    name: string;
    position: string;
    points: number | null;
    basis: PickupPlayer['basis'];
    gain: number | null;
    margin: number | null;
    status: PickupAuditStatus;
  }[];
}

const DEFENCE_POSITIONS = new Set(['DEF', 'DST', 'D/ST']);
const HEALTHY = new Set(['', 'healthy', 'active', 'none']);

function healthy(p: PickupPlayer): boolean {
  return !p.ruledOut && HEALTHY.has((p.designation ?? '').toLowerCase());
}

function solvable(p: PickupPlayer, forced = false, locked = false): SolvablePlayer {
  return {
    playerId: p.playerId,
    name: p.name,
    position: p.position,
    points: p.points ?? 0,
    borrowed: p.basis !== 'market',
    ...(forced ? { forced: true } : {}),
    ...(locked ? { locked: true } : {}),
  };
}

export function planPickupStart(request: PickupStartRequest): PickupStartPlan {
  const current = new Set(request.currentStarterIds);
  const owned = request.roster.filter(
    (p) =>
      !p.onReserve &&
      !p.ruledOut &&
      p.points != null &&
      (p.basis === 'market' || p.basis === 'published') &&
      /* A kicked-off bench player cannot be moved in; a kicked-off starter keeps his slot. */
      (!p.locked || current.has(p.playerId)),
  );
  /*
   * A kicked-off starter is locked into his slot (round 13): the free agent
   * being tested can never take it. Live, 8 November: Baker Mayfield (Monday
   * night) "tied" Jordan Love, whose Sunday game had started, and Team and
   * Waivers both offered a pickup Sleeper would refuse.
   */
  const ownedSolvable = owned.map((p) => solvable(p, p.locked, p.locked && current.has(p.playerId)));
  const baseline = solveLineup(ownedSolvable, request.shape);
  const byId = new Map(request.roster.map((p) => [p.playerId, p] as const));

  const audit: PickupStartPlan['audit'] = [];
  const moves: PickupStartMove[] = [];
  const notNow: PickupStartPlan['notNow'] = [];

  for (const c of request.candidates) {
    const row = { playerId: c.playerId, name: c.name, position: c.position, points: c.points, basis: c.basis, gain: null as number | null, margin: null as number | null };
    /*
     * The gain is worked out for everybody with a number, before any rule
     * below says whether he may be called: the audit shows every scanned
     * free agent's gain, whatever stops him.
     */
    const full = request.openSpots <= 0;
    const drop = full ? (request.dropFor?.(c.playerId) ?? null) : null;
    const pool = ownedSolvable.filter((p) => p.playerId !== drop?.playerId);
    const withHim = c.points == null || c.ruledOut ? null : solveLineup([...pool, solvable(c)], request.shape);
    const forced = c.points == null || c.ruledOut ? null : solveLineup([...pool, solvable(c, true)], request.shape);
    if (withHim && forced) {
      /* On ranking numbers, as Team's swap (round 13): a Sleeper-only starter he replaces ranks two lower. */
      row.gain = withHim.rankedTotal - baseline.rankedTotal;
      row.margin = forced.rankedTotal - baseline.rankedTotal;
    }
    if (!withHim || !forced || c.basis !== 'market') {
      audit.push({ ...row, status: 'not_priced' });
      continue;
    }
    /*
     * A defence is the defence planner's call (Alex, 20 October 2026): it
     * decides streaming on Waivers, and two answers for one slot would
     * conflict. Said in the audit as what it is, not as an injury; the
     * gain above is still shown, and nothing else changes.
     */
    if (DEFENCE_POSITIONS.has(c.position.toUpperCase())) {
      audit.push({ ...row, status: 'defence_planner' });
      continue;
    }
    if (!healthy(c)) {
      audit.push({ ...row, status: 'injured' });
      continue;
    }
    /*
     * Full roster, no honest drop: still a call, valued as if a bench spot
     * were freed, with the planner's cheapest bench players to pick from.
     * Never a player in the lineup with him, so the gain holds whichever he
     * picks. With nobody left to offer, no call.
     */
    const pickDrop = full && drop == null
      ? (request.spotChoices?.(c.playerId) ?? []).filter((x) => !withHim.starterIds.has(x.playerId) && !forced.starterIds.has(x.playerId)).slice(0, 3)
      : null;
    if (pickDrop != null && pickDrop.length === 0) {
      audit.push({ ...row, status: 'no_drop' });
      continue;
    }
    const gain = row.gain!;
    const margin = row.margin!;

    const state = request.pickup[c.playerId];
    const instant = !c.locked && state?.state === 'free';
    /* A position no slot takes cannot be forced in, and is not a tie. */
    const seats = forced.starterIds.has(c.playerId);
    /*
     * The toss-up bar, or a real hole: he fills a slot nobody in the best
     * owned lineup held, or the man he replaces there is Doubtful. Out and IR
     * players are never in that lineup, so their hole is already in `gain`.
     */
    const beaten = [...baseline.starterIds].filter((id) => !withHim.starterIds.has(id) && id !== drop?.playerId);
    const hole =
      seats &&
      gain > 1e-9 &&
      (beaten.length === 0 || beaten.some((id) => isRealHole({ designation: byId.get(id)?.designation ?? null })));
    const verdict: 'start' | 'consider' | null = !seats
      ? null
      : clearsTossUp(gain) || hole
        ? 'start'
        : margin >= -PICKUP_START.tie - 1e-9
          ? 'consider'
          : null;
    if (!instant) {
      if (verdict === 'start') {
        notNow.push({
          playerId: c.playerId,
          name: c.name,
          gain,
          why: c.locked ? 'game_started' : state == null ? 'unknown' : state.reason === 'game_started' ? 'game_started' : 'waivers',
        });
      }
      audit.push({ ...row, status: verdict == null ? 'below' : 'not_now' });
      continue;
    }
    audit.push({ ...row, status: verdict ?? 'below' });
    if (verdict == null) continue;

    const lineup = verdict === 'start' ? withHim : forced;
    const replaced = replacedOf(baseline, lineup, byId, c, request.shape, drop);
    moves.push({
      verdict,
      playerId: c.playerId,
      name: c.name,
      position: c.position,
      team: c.team,
      points: c.points!,
      gain,
      margin,
      slot: lineup.slots.find((s) => s.playerId === c.playerId)?.slot ?? null,
      over: replaced,
      displaces: replaced,
      drop,
      pickDrop,
      starterOut: request.starterOut?.(c) ?? null,
    });
  }

  const starts = moves
    .filter((m) => m.verdict === 'start')
    .sort((a, b) => b.gain - a.gain || b.points - a.points || a.name.localeCompare(b.name));
  const start = starts[0] ?? null;
  const consider = moves
    .filter((m) => m.verdict === 'consider')
    .sort((a, b) => b.margin - a.margin || b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, PICKUP_START.maxTies);

  return {
    threshold: TOSSUP_POINTS,
    tieTolerance: PICKUP_START.tie,
    bestOwned: baseline.total,
    bestOwnedSlots: baseline.slots,
    start,
    consider,
    notNow: notNow.sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name)),
    audit: audit.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity) || a.name.localeCompare(b.name)),
  };
}

/**
 * Who the free agent really replaces: `Pick up and start StreamQB over Jordan Love`.
 *
 * Read from the best lineup the roster can already make against the best
 * lineup with him, never from Sleeper's lineup as set. Until 3 November 2026
 * the card named "anyone in Sleeper's lineup who is not in the new one, lowest
 * first", so a free-agent QB 1.1 better than Love read "over Egbuka" (a WR
 * Sleeper started over McConkey, a separate swap). Any other change Sleeper's
 * lineup needs is its own swap on the Team rows.
 *
 * Adding one player changes the best lineup by at most one player, so there is
 * normally one name to give. Two can leave when the add needs a drop who was
 * starting; then, in order:
 *
 *  1. someone who can play a slot he can play (a QB only a QB here, since a QB
 *     is not FLEX eligible; a back can replace a receiver through FLEX);
 *  2. not the drop, who leaves to make room, not because he was beaten;
 *  3. the lowest number.
 *
 * Nobody who shares a slot with him and nobody but the drop: he fills a slot
 * nobody held (Love on a bye), and the card says the slot, not a name.
 */
function replacedOf(
  baseline: SolvedLineup,
  lineup: SolvedLineup,
  byId: ReadonlyMap<string, PickupPlayer>,
  candidate: PickupPlayer,
  shape: RosterShape,
  drop: PickupDrop | null,
): PickupStartMove['displaces'] {
  const left = [...baseline.starterIds]
    .filter((id) => !lineup.starterIds.has(id))
    .map((id) => byId.get(id))
    .filter((p): p is PickupPlayer => p != null && p.points != null);
  const fits = (p: PickupPlayer) => sharesSlot(candidate.position, p.position, shape);
  const isDrop = (p: PickupPlayer) => p.playerId === drop?.playerId;
  const pool = left.some(fits) ? left.filter(fits) : left.filter((p) => !isDrop(p));
  const out = pool.sort((a, b) => Number(isDrop(a)) - Number(isDrop(b)) || a.points! - b.points! || a.name.localeCompare(b.name))[0];
  return out ? { playerId: out.playerId, name: out.name, points: out.points! } : null;
}

/** Is there a starting slot both positions may fill? QB and WR: none in a one-QB league. */
export function sharesSlot(a: string, b: string, shape: RosterShape): boolean {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  if (x === y) return (shape.starters[x] ?? 0) > 0 || shape.flex.some((f) => f.positions.includes(x));
  return shape.flex.some((f) => f.positions.includes(x) && f.positions.includes(y));
}

/**
 * Sleeper's word for a teammate who will not start: Out, Doubtful, or on a
 * reserve list. Questionable is not enough to move a yards line.
 */
const STARTER_OUT = new Set(['out', 'doubtful', 'ir', 'pup', 'sus']);

/**
 * The "Starter out" chip: a teammate at the same position, first on Sleeper's
 * depth chart, who is Out or Doubtful, while this player is behind him. Read
 * only from what Waivers already loads (Sleeper's injury notes and depth
 * order). Unknown depth or status is no chip.
 */
export function starterOutReader(opts: {
  players: readonly { id: string; fullName: string; team: string; position: string }[];
  injuryStatus: ReadonlyMap<string, string | null>;
  depthOrder: ReadonlyMap<string, number>;
}): (player: PickupPlayer) => { playerId: string; name: string } | null {
  const byClub = new Map<string, { id: string; fullName: string; position: string }[]>();
  for (const p of opts.players) {
    const key = `${(p.team ?? '').toUpperCase()}|${(p.position ?? '').toUpperCase()}`;
    (byClub.get(key) ?? byClub.set(key, []).get(key)!).push(p);
  }
  return (player) => {
    const own = opts.depthOrder.get(player.playerId);
    if (own == null || own <= 1) return null;
    const mates = byClub.get(`${player.team.toUpperCase()}|${player.position.toUpperCase()}`) ?? [];
    const hurt = mates.find(
      (m) =>
        m.id !== player.playerId &&
        opts.depthOrder.get(m.id) === 1 &&
        STARTER_OUT.has((opts.injuryStatus.get(m.id) ?? '').toLowerCase()),
    );
    return hurt ? { playerId: hurt.id, name: hurt.fullName } : null;
  };
}

/**
 * A "ties this week" pickup that is worse over the season is not shown (Alex,
 * Round 15).
 *
 * A tie is a coin flip this week, so the only thing that can make it worth a
 * roster spot is what he is worth after this week. The waiver planner already
 * values every free agent over the rest of the season (`tiers.ts`, the same
 * rest-of-season rates Trades uses), and `seasonValue` is that number for his
 * best move: the lineup points it adds over the season's weeks, with the
 * insurance credit, and before Alex's labelled preferences. Below zero, the
 * move loses over the season, and the tie is dropped from `consider`, so
 * neither Team's Best move sheet nor the Waivers "Worth considering" row shows
 * it. Zero or more, or no season reading at all (the planner failed, or the
 * season is over), the tie stays exactly as before.
 *
 * The headline (`start`) is untouched: it clears the toss-up bar this week.
 */
export function hideSeasonLosingTies(plan: PickupStartPlan, seasonValue: (playerId: string) => number | null): PickupStartPlan {
  const losing = new Set(
    plan.consider
      .filter((m) => {
        const value = seasonValue(m.playerId);
        return value != null && value < -1e-9;
      })
      .map((m) => m.playerId),
  );
  if (losing.size === 0) return plan;
  return {
    ...plan,
    consider: plan.consider.filter((m) => !losing.has(m.playerId)),
    audit: plan.audit.map((a) => (losing.has(a.playerId) ? { ...a, status: 'worse_over_season' as const } : a)),
  };
}
