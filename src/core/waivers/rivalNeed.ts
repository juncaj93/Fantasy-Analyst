/**
 * How badly each other manager needs a position over the next two weeks.
 *
 * Read from his real roster: the players he could start at the position in
 * each week (healthy, not on bye, not Out or on IR), against the slots he must
 * fill there. A real hole (nobody to start) makes him a likely bidder; a
 * surplus (three quarterbacks in a one-QB league) makes him an unlikely one,
 * and possibly a seller.
 *
 * ## Where the multipliers come from
 *
 * Measured on this league's own waiver history, 2024 to 2026: for every player
 * somebody bid on, did each other manager bid too, given what his roster held
 * at that position going into the run? 2,394 manager-and-player pairs, Alex's
 * own excluded. The base rate is about 11%. A manager with nobody to start bid
 * 23% (DEF) to 50% (QB) of the time; a QB owner who already had a backup bid
 * 4%. The table below rounds those and keeps the order sensible where a cell
 * had only a handful of cases (two bids from twelve managers holding three
 * quarterbacks are not evidence that a third backup raises interest).
 *
 * Nothing here reads a player's value beyond "could he start": the bid model
 * decides how much this player draws a manager, and this decides how much the
 * manager needs anyone at the position.
 */

/** The need multiplier by state and position. 1 is the league's typical bidder. */
export const NEED_FACTORS = {
  QB: { hole: 3, thin: 1.1, backup: 0.4, surplus: 0.25 },
  TE: { hole: 3, thin: 1, backup: 1, surplus: 0.5 },
  DEF: { hole: 2, thin: 0.8, backup: 0.7, surplus: 0.7 },
  RB: { hole: 1.5, thin: 1.3, backup: 0.75, surplus: 1 },
  WR: { hole: 2.5, thin: 1.2, backup: 1.2, surplus: 0.9 },
} as const;

/**
 * A rostered player whose projection this week is under this is not counted
 * as a full starter at his position (a backup quarterback, a third-string
 * back). Absent projection: counted, because unknown is not weak.
 */
export const STARTABLE_FLOOR: Readonly<Record<string, number>> = { QB: 12, RB: 6, WR: 6, TE: 5 };

/** Designations that keep a player out of a week. */
const OUT = new Set(['out', 'ir', 'pup', 'sus', 'suspended', 'na', 'nfi', 'doubtful', 'inactive', 'cov']);

export type NeedState = 'hole' | 'thin' | 'backup' | 'surplus';

export interface NeedRosterPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Sleeper's injury status or designation, any case. */
  status: string | null;
  /** In an injured-reserve slot. */
  onReserve?: boolean;
  /** This week's projection in league scoring, when known. */
  projection?: number | null;
}

export interface PositionNeed {
  position: string;
  state: NeedState;
  factor: number;
  /** Startable bodies each week, against `slots`. */
  startable: number[];
  slots: number;
  /** Plain words: `QB on bye in week 6, no backup`, `has 3 QBs`. */
  reason: string;
}

export interface NeedRequest {
  /** Dedicated starting slots by position, e.g. `{ QB: 1, RB: 2, WR: 3, TE: 1, DEF: 1 }`. */
  starters: Readonly<Record<string, number>>;
  /** The two weeks that matter, the coming one first. */
  weeks: readonly number[];
  roster: readonly NeedRosterPlayer[];
  /** True when the club is on bye that week; null when the schedule does not say. */
  onBye: (team: string, week: number) => boolean | null;
}

/** One rival's need at one position. */
export function positionNeed(request: NeedRequest, position: string): PositionNeed {
  const pos = position.toUpperCase();
  const slots = request.starters[pos] ?? 0;
  const table = NEED_FACTORS[pos as keyof typeof NEED_FACTORS] ?? { hole: 1.5, thin: 1, backup: 1, surplus: 0.8 };
  const players = request.roster.filter((p) => p.position.toUpperCase() === pos && !p.onReserve);
  const floor = STARTABLE_FLOOR[pos];
  const healthy = (p: NeedRosterPlayer) => !OUT.has((p.status ?? '').toLowerCase());
  const weight = (p: NeedRosterPlayer) => (floor != null && p.projection != null && p.projection < floor ? 0.5 : 1);

  const startable = request.weeks.map((week) =>
    players.reduce((s, p) => s + (healthy(p) && request.onBye(p.team, week) !== true ? weight(p) : 0), 0),
  );
  const fewest = startable.length > 0 ? Math.min(...startable) : players.length;
  const spare = fewest - slots;
  const holeWeek = request.weeks[startable.findIndex((n) => n < slots)] ?? null;

  let state: NeedState;
  if (slots > 0 && spare < 0) state = 'hole';
  else if (spare < 1) state = 'thin';
  else if (spare < 2 || (pos !== 'QB' && pos !== 'TE' && pos !== 'DEF' && spare < 4)) state = 'backup';
  else state = 'surplus';
  /* Receivers and backs: depth is normal, so "backup" covers one to three spares. */

  const factor = table[state];
  return { position: pos, state, factor, startable, slots, reason: needReason(pos, state, factor, players, request, holeWeek) };
}

function needReason(
  pos: string,
  state: NeedState,
  factor: number,
  players: readonly NeedRosterPlayer[],
  request: NeedRequest,
  holeWeek: number | null,
): string {
  const count = players.length;
  if (state === 'hole') {
    if (count === 0) return `no ${pos} on his roster`;
    const byes = holeWeek == null ? [] : players.filter((p) => request.onBye(p.team, holeWeek) === true);
    const hurt = players.filter((p) => OUT.has((p.status ?? '').toLowerCase()));
    if (byes.length > 0 && hurt.length + byes.length >= count) {
      return `${pos} on bye in week ${holeWeek}, no ${count > 1 ? 'healthy ' : ''}backup`;
    }
    if (hurt.length > 0) return `${pos} hurt, no healthy backup`;
    return `no ${pos} to start in week ${holeWeek}`;
  }
  if (state === 'surplus') return factor <= 0.5 ? `has ${count} ${pos}s, unlikely` : `deep at ${pos}`;
  if (state === 'backup') return pos === 'QB' || pos === 'TE' ? `has a backup ${pos}` : `deep at ${pos}`;
  return `no spare ${pos}`;
}
