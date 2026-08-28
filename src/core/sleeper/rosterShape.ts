/**
 * What a league's roster slots are, and nothing about what they score.
 *
 * Split out of `scoring.ts`, and the reason is measured rather than aesthetic —
 * the same reason `core/dst/weeks.ts` exists. The Team and Players screens read
 * a roster's *shape*: which slots there are, and therefore which positions are
 * worth showing at all. They have no use for what the league pays for a
 * reception. But `scoring.ts` also holds `buildScoringProfile`, which calls
 * `buildDstScoring`, and the moment Demo Mode began building a real profile,
 * that whole defence scoring table was retained — and a module reachable from
 * the entry belongs to the entry, so the bundler put it in the render path.
 * Four kilobytes of defence scoring on every page load, so a filter row could
 * know a league starts a tight end.
 *
 * So the shape the screens read is separate from the scoring the engines read.
 * This module imports nothing, which is the property that matters: there is no
 * tree behind it to drag anywhere. `scoring.ts` re-exports all of it, so
 * everything that reasonably wants both still gets both from one place.
 */

export interface RosterShape {
  /** Fixed starting slots by position, e.g. `{ QB: 1, RB: 2, WR: 3, TE: 1 }`. */
  starters: Record<string, number>;
  /** Flex slots keyed by slot name with the positions they accept. */
  flex: { slot: string; positions: string[] }[];
  benchSlots: number;
  irSlots: number;
  totalStarters: number;
  superflex: boolean;
}

/** Which real positions each Sleeper roster slot accepts. */
export const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

/**
 * Slots that never get a recommendation.
 *
 * `K` sits here for the same reason kickers are not synced: the app has no
 * opinion about them, so treating a kicker slot as a starting slot would
 * produce a lineup row it could never fill and a warning it could never clear.
 */
const NON_PLAYING_SLOTS = new Set(['BN', 'IR', 'TAXI', 'K']);

/**
 * Every position this league can actually start.
 *
 * The draft board and player list are filtered by this rather than by a fixed
 * list, because "which positions matter" is a property of the league, not of
 * football. A league with no kicker slot should never be offered a kicker, and
 * one that starts a defence should see defences.
 */
export function startablePositions(shape: RosterShape): Set<string> {
  const out = new Set<string>(Object.keys(shape.starters));
  for (const flex of shape.flex) for (const p of flex.positions) out.add(p);
  return out;
}

export function buildRosterShape(rosterPositions: string[]): RosterShape {
  const starters: Record<string, number> = {};
  const flex: { slot: string; positions: string[] }[] = [];
  let benchSlots = 0;
  let irSlots = 0;

  for (const raw of rosterPositions ?? []) {
    const slot = String(raw).toUpperCase();
    if (slot === 'BN') {
      benchSlots++;
      continue;
    }
    if (slot === 'IR' || slot === 'TAXI') {
      irSlots++;
      continue;
    }
    const eligible = FLEX_ELIGIBILITY[slot];
    if (eligible) {
      flex.push({ slot, positions: [...eligible] });
      continue;
    }
    if (NON_PLAYING_SLOTS.has(slot)) continue;
    const pos = slot === 'QB2' ? 'QB' : slot;
    starters[pos] = (starters[pos] ?? 0) + 1;
  }

  const totalStarters = Object.values(starters).reduce((a, b) => a + b, 0) + flex.length;
  return {
    starters,
    flex,
    benchSlots,
    irSlots,
    totalStarters,
    superflex: (rosterPositions ?? []).some((p) => p === 'SUPER_FLEX' || p === 'QB2'),
  };
}
