/**
 * The four-season history policy, and the cycle guard it did not replace.
 *
 * Sleeper keeps every season a league has ever played, and the planner used to
 * walk all of them: `MAX_CHAIN_DEPTH` is a cycle guard set at twenty, which is
 * longer than fantasy football has had Sleeper, so in practice nothing stopped
 * a league founded in 2016 from queueing ten seasons of drafts and a hundred
 * and eighty transaction weeks. Against a budget of a couple of dozen requests
 * a day that is a fortnight of backfill, and the derivation weights the far end
 * of it at `0.6 ** age` — thirteen per cent by the fifth season, three by the
 * ninth. The requests were real and the signal was not.
 *
 * So there are two bounds now and they answer different questions:
 *
 *   - {@link MAX_HISTORY_SEASONS} is the product policy. Newest four, counting
 *     the current season as the first, moving with it.
 *   - {@link MAX_CHAIN_DEPTH} is still the cycle guard, and this file asserts it
 *     independently — because the argument that the policy stops the walk rests
 *     on each link being a year older than the last, which is exactly what a
 *     cycle in Sleeper's data does not do.
 */

import { describe, expect, it } from 'vitest';
import {
  enumerateWork,
  MAX_CHAIN_DEPTH,
  MAX_HISTORY_SEASONS,
  oldestSeasonInPolicy,
  unresolvedChainLink,
  withinHistoryPolicy,
  type BackfillState,
  type SeasonState,
} from '../src/core/managers/backfillPlan.ts';
import { SEASON_DECAY } from '../src/core/managers/tradeProfile.ts';

/** A season with everything known, so only the policy decides whether it is planned. */
function season(year: string, over: Partial<SeasonState> = {}): SeasonState {
  return {
    sleeperLeagueId: `L${year}`,
    season: year,
    status: 'complete',
    previousLeagueId: `L${Number(year) - 1}`,
    resolved: true,
    identityKnown: false,
    drafts: { indexFresh: false, pendingDraftIds: [], completed: false },
    transactions: { settledWeeks: [], throughWeek: 18, completed: false },
    ...over,
  };
}

/** Ten seasons, 2026 back to 2017 — the league this policy exists for. */
function tenSeasons(): BackfillState {
  return {
    currentSeason: '2026',
    seasons: Array.from({ length: 10 }, (_, i) => season(String(2026 - i))),
  };
}

function seasonsPlanned(state: BackfillState): string[] {
  const seen = new Set<string>();
  for (const unit of enumerateWork(state)) {
    if (unit.season) seen.add(unit.season);
  }
  return [...seen].sort();
}

describe('the history policy plans the newest four seasons and no others', () => {
  it('plans four of a ten-season chain', () => {
    expect(seasonsPlanned(tenSeasons())).toEqual(['2023', '2024', '2025', '2026']);
  });

  it('counts the current season as the first of the four', () => {
    /*
     * The interpretation, chosen to match the decay rather than to round a
     * number. `tradeProfile` weights a season by `SEASON_DECAY ** age` against
     * the newest on record, so including the current season gives the four in
     * policy weights 1, 0.6, 0.36 and 0.216 — and excluding it would admit a
     * fifth at 0.13, an eighth of a vote for a season's worth of requests.
     */
    const weights = Array.from({ length: MAX_HISTORY_SEASONS }, (_, age) => SEASON_DECAY ** age);
    expect(weights[MAX_HISTORY_SEASONS - 1]).toBeGreaterThan(0.2);
    expect(SEASON_DECAY ** MAX_HISTORY_SEASONS).toBeLessThan(0.15);

    expect(oldestSeasonInPolicy('2026')).toBe(2026 - (MAX_HISTORY_SEASONS - 1));
    expect(withinHistoryPolicy('2023', '2026')).toBe(true);
    expect(withinHistoryPolicy('2022', '2026')).toBe(false);
  });

  it('is a rolling window, not a fixed floor', () => {
    // The same chain, a year later. It gives up its oldest season and takes none.
    const nextYear: BackfillState = { ...tenSeasons(), currentSeason: '2027' };
    expect(seasonsPlanned(nextYear)).toEqual(['2024', '2025', '2026']);
  });

  it('plans everything in a chain shorter than the policy', () => {
    const state: BackfillState = {
      currentSeason: '2026',
      seasons: [season('2026'), season('2025', { previousLeagueId: null })],
    };
    expect(seasonsPlanned(state)).toEqual(['2025', '2026']);
  });

  it('refuses to spend a request extending the chain past the window', () => {
    /*
     * The oldest season in policy names a previous league nobody has read. That
     * link is left unread: discovering it would cost a request to learn the
     * name of a year nothing may then fetch.
     */
    const state: BackfillState = {
      currentSeason: '2026',
      seasons: [season('2026'), season('2025'), season('2024'), season('2023')],
    };
    expect(unresolvedChainLink(state)).toBeNull();
    expect(enumerateWork(state).some((u) => u.kind === 'discover')).toBe(false);
  });

  it('still extends the chain while the window has room', () => {
    const state: BackfillState = {
      currentSeason: '2026',
      seasons: [season('2026'), season('2025')],
    };
    const link = unresolvedChainLink(state);
    expect(link).toEqual({ kind: 'discover', sleeperLeagueId: 'L2024', season: '2024' });
  });

  it('never asks for a season outside the window, whatever the dataset', () => {
    /*
     * The filter is applied once, to the season list, so no dataset can be
     * exempt from it — an identity read for 2019 is as much a spent request as
     * a transaction week is.
     */
    const units = enumerateWork(tenSeasons());
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      if (!unit.season) continue;
      expect(Number(unit.season), `${unit.kind} ${unit.season} is outside the window`).toBeGreaterThanOrEqual(2023);
    }
  });

  it('leaves history already stored alone', () => {
    /*
     * Policy governs fetching, not the ledger. A league that filled six seasons
     * before the cap existed keeps all six — this only stops the seventh, and
     * stops re-reading anything past the window.
     */
    const state: BackfillState = {
      currentSeason: '2026',
      seasons: [
        // The chain itself is fully walked, so only the policy is in play here.
        season('2026', { previousLeagueId: null }),
        season('2021', {
          previousLeagueId: null,
          identityKnown: true,
          transactions: { settledWeeks: [1, 2, 3], throughWeek: 18, completed: false },
        }),
      ],
    };
    expect(seasonsPlanned(state)).toEqual(['2026']);
  });
});

describe('the cycle guard is independent of the history policy', () => {
  it('stops a chain that never gets older', () => {
    /*
     * The pathological case, and the reason the depth guard cannot be deleted
     * now that a policy exists: every one of these is the *current* season, so
     * every one is inside the window and the policy has no opinion at all. Only
     * `MAX_CHAIN_DEPTH` ends it.
     */
    const cyclic: BackfillState = {
      currentSeason: '2026',
      seasons: Array.from({ length: MAX_CHAIN_DEPTH }, (_, i) => ({
        ...season('2026'),
        sleeperLeagueId: `LOOP${i}`,
        previousLeagueId: `LOOP${(i + 1) % MAX_CHAIN_DEPTH}`,
        resolved: i > 0,
      })),
    };

    // Every season is in policy...
    for (const s of cyclic.seasons) expect(withinHistoryPolicy(s.season, cyclic.currentSeason)).toBe(true);
    // ...and the walk still ends.
    expect(unresolvedChainLink(cyclic)).toBeNull();
  });

  it('is checked before the policy, so one short of the depth still walks', () => {
    const nearly: BackfillState = {
      currentSeason: '2026',
      seasons: Array.from({ length: MAX_CHAIN_DEPTH - 1 }, (_, i) => ({
        ...season('2026'),
        sleeperLeagueId: `LOOP${i}`,
        previousLeagueId: 'LOOP-UNSEEN',
        resolved: true,
      })),
    };
    expect(unresolvedChainLink(nearly)).not.toBeNull();
  });
});
