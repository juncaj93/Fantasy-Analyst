/**
 * How each rival in Tony's Pizza Fantasy tends to bid, as Alex reads them.
 *
 * Priors, not facts. The bid model (`bidModel.ts`) starts every manager here
 * and then blends in what this season's claims actually show, so a seed fades
 * as the evidence grows. Matched to a Sleeper owner by display name, ignoring
 * case. A manager not named here is a last-week-score chaser until his own
 * claims say otherwise.
 *
 * Mapping, checked against the league's own user list on 8 October 2026:
 *
 * | seed          | Sleeper display name | roster | certain? |
 * | ------------- | -------------------- | ------ | -------- |
 * | ronjonathan   | RonJonathan          | 6      | yes, exact |
 * | MattyB2317    | MattyB2317           | 10     | yes, exact (not MattLee04, roster 9) |
 * | cheeseking    | cheeseking           | 8      | yes, exact |
 */

export type BidderStyle = 'savvy' | 'slightly_savvy' | 'chaser' | 'rare';

export interface ManagerSeed {
  /** Sleeper display name, matched case-insensitively. */
  displayName: string;
  style: BidderStyle;
  /** Alex's words, shown beside the name. */
  note: string;
}

export const MANAGER_SEEDS: readonly ManagerSeed[] = [
  {
    displayName: 'ronjonathan',
    style: 'savvy',
    note: 'The one clearly savvy manager: his claims follow add trends and roles',
  },
  { displayName: 'MattyB2317', style: 'slightly_savvy', note: 'Slightly savvy' },
  { displayName: 'cheeseking', style: 'rare', note: 'Rarely makes adds' },
];

/** What each style means to the model, before any history is blended in. */
export const STYLE_PRIORS: Readonly<
  Record<
    BidderStyle,
    {
      label: string;
      /** Players he bids on in a typical waiver run. */
      claimsPerRun: number;
      /** How much each signal draws him. They sum to 1. */
      weights: { points: number; trend: number; role: number };
      /** A typical bid when he does bid, in dollars. */
      typicalBid: number;
    }
  >
> = {
  savvy: { label: 'savvy', claimsPerRun: 2.5, weights: { points: 0.3, trend: 0.45, role: 0.25 }, typicalBid: 8 },
  slightly_savvy: { label: 'slightly savvy', claimsPerRun: 1.2, weights: { points: 0.5, trend: 0.3, role: 0.2 }, typicalBid: 4 },
  chaser: { label: 'chases last week’s scorers', claimsPerRun: 0.6, weights: { points: 0.85, trend: 0.1, role: 0.05 }, typicalBid: 3 },
  rare: { label: 'rarely adds', claimsPerRun: 0.1, weights: { points: 0.85, trend: 0.1, role: 0.05 }, typicalBid: 1 },
};

export function seedFor(displayName: string | null | undefined): ManagerSeed | null {
  if (!displayName) return null;
  const wanted = displayName.trim().toLowerCase();
  return MANAGER_SEEDS.find((s) => s.displayName.toLowerCase() === wanted) ?? null;
}
