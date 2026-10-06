/**
 * The best legal lineup for one week, from any set of players.
 *
 * Start/Sit has a full lineup optimiser, and it is built for a different job: it
 * ranks one specific Sunday with locks, kickoffs, correlation and cover charges
 * on top. Valuing thirteen weeks of two rosters needs only the bare question
 * "given these expected points, which legal lineup scores most", asked fifty
 * times. That is an assignment problem, solved here exactly.
 *
 * ## Why not "best at each position, then flex"
 *
 * It is correct for the usual league, where every flex slot accepts a superset
 * of the positions beneath it, and wrong for the ones where two flex slots cross
 * (a WR/TE slot beside a RB/WR slot). The Hungarian method below is exact for
 * any mix, and at a dozen slots by a few dozen players it is not slow.
 *
 * A slot may stay empty at zero points. That matters for a roster that cannot
 * fill a position, and in practice it never happens in this model, because a
 * replacement-level free agent is always available (see `evaluate.ts`).
 */

import type { RosterShape } from '../sleeper/rosterShape.ts';

export interface LineupSlotSpec {
  /** `QB`, `RB`, `FLEX`... for display. */
  key: string;
  eligible: ReadonlySet<string>;
}

export interface LineupCandidate {
  id: string;
  position: string;
  /** Expected points this week. Already scaled by availability. */
  value: number;
}

export interface WeekLineup {
  total: number;
  /** One entry per slot, in slot order. Null is an empty slot. */
  picks: (LineupCandidate | null)[];
}

/** The league's starting slots, fixed positions first and flex slots after. */
export function slotsOf(shape: RosterShape): LineupSlotSpec[] {
  const slots: LineupSlotSpec[] = [];
  for (const [position, count] of Object.entries(shape.starters)) {
    for (let i = 0; i < count; i++) slots.push({ key: position, eligible: new Set([position]) });
  }
  for (const flex of shape.flex) slots.push({ key: flex.slot, eligible: new Set(flex.positions) });
  return slots;
}

const FORBIDDEN = 1e6;

/**
 * Minimum-cost assignment of every row to a distinct column, for a matrix with
 * at least as many columns as rows. The classic potentials formulation.
 */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0) assignment[p[j]! - 1] = j - 1;
  return assignment;
}

/**
 * The best lineup from these candidates. Deterministic: candidates are taken in
 * the order given, so an exact tie goes to whoever was listed first.
 */
export function bestLineup(slots: readonly LineupSlotSpec[], candidates: readonly LineupCandidate[]): WeekLineup {
  if (slots.length === 0) return { total: 0, picks: [] };

  // One empty "player" per slot, so a slot nobody can fill costs nothing and
  // the matrix always has a complete assignment.
  const columns = candidates.length + slots.length;
  const cost: number[][] = slots.map((slot) => {
    const row = new Array<number>(columns).fill(FORBIDDEN);
    candidates.forEach((c, j) => {
      if (slot.eligible.has(c.position)) row[j] = -Math.max(0, c.value);
    });
    for (let k = 0; k < slots.length; k++) row[candidates.length + k] = 0;
    return row;
  });

  const assignment = hungarian(cost);
  const picks: (LineupCandidate | null)[] = [];
  let total = 0;
  for (const column of assignment) {
    const pick = column >= 0 && column < candidates.length ? candidates[column]! : null;
    picks.push(pick);
    if (pick) total += Math.max(0, pick.value);
  }
  return { total, picks };
}
