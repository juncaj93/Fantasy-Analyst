/**
 * A spread is only usable if the team it belongs to can be named.
 *
 * `vegas/types.ts` states the rule this file enforces: "Nothing outside
 * `src/core/vegas/` may reference a vendor-specific field name. Adapters
 * translate their vendor's vocabulary into these types." `GameLines.spreadTeam`
 * is the one field where that translation was missed, and the miss is invisible
 * — it produces no error, no empty response and no failed request. It produces
 * a `null` spread, forever, and every reader treats a null spread as "the
 * market has not priced this game", which is a sentence the app is designed to
 * say and therefore looks entirely correct.
 *
 * The mechanics, end to end:
 *
 *  - `vegas_events.home_team` / `away_team` are filled from `rosterTeams()`, so
 *    they are **Sleeper** ids: `KC`, `SF`, `JAX`.
 *  - `vegas_events.spread_team` was filled from the adapter's `spreadTeam`,
 *    which on SportsGameOdds is `side.teamID` — `KANSAS_CITY_CHIEFS_NFL`.
 *  - `buildStartSitContext` resolves the sign with
 *    `sides.includes(spreadTeam)`, deliberately refusing a handicap whose team
 *    it cannot place, because a game-script model fed a spread with the wrong
 *    sign is worse than one fed nothing.
 *
 * Those three are individually correct and jointly always false. The result is
 * that **every** stored spread was discarded on read.
 *
 * It surfaced with the defence model, which is why it is fixed here: a defence
 * is anchored on the opponent's implied total, that needs a total *and* a
 * spread, and a permanently null spread means a permanently null projection for
 * every defence in the league. The same fix revives the game-script component
 * for skill positions, which had been silently contributing nothing.
 */

import { describe, expect, it } from 'vitest';
import { appTeamId, providerTeamId } from '../src/core/vegas/sportsGameOddsProvider.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { VegasEventsRepo } from '../src/server/repos/vegasEvents.ts';
import { buildStartSitContext } from '../src/server/services/startSitInputs.ts';
import { createTestDb } from './helpers/db.ts';

describe('the adapters speak the app’s vocabulary on the way out', () => {
  it('maps a provider team id back to the Sleeper one', () => {
    expect(appTeamId('KANSAS_CITY_CHIEFS_NFL')).toBe('KC');
    expect(appTeamId('SAN_FRANCISCO_49ERS_NFL')).toBe('SF');
    expect(appTeamId('JACKSONVILLE_JAGUARS_NFL')).toBe('JAX');
  });

  it('is the exact inverse of the outbound map, for every team', () => {
    // Asserted over the whole league rather than a sample: one team missing
    // from the inverse is one team whose spread is silently dropped, and it
    // would be the hardest kind of bug to notice from a screen.
    for (const team of ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']) {
      const provider = providerTeamId(team);
      expect(provider, `no provider id for ${team}`).not.toBeNull();
      expect(appTeamId(provider), `${team} does not round-trip`).toBe(team);
    }
  });

  it('passes an app id through untouched, so it is safe to apply twice', () => {
    expect(appTeamId('KC')).toBe('KC');
    expect(appTeamId('kc')).toBe('KC');
  });

  it('returns null rather than guessing at something it cannot place', () => {
    expect(appTeamId(null)).toBeNull();
    expect(appTeamId('')).toBeNull();
    expect(appTeamId('LONDON_MONARCHS_NFL')).toBeNull();
  });

  it('the mock provider names the spread’s team the way the app does', () => {
    const provider = new MockVegasProvider([
      {
        eventId: 'g1',
        startTime: '2026-09-13T17:00:00.000Z',
        homeTeam: 'KC',
        awayTeam: 'CAR',
        players: [{ name: 'Somebody', position: 'WR', team: 'KC' }],
      },
    ]);
    return provider.getPlayerProps('g1').then((set) => {
      expect(set.gameLines?.spreadTeam).toBe('KC');
    });
  });
});

describe('and the spread therefore survives the round trip', () => {
  /** Exactly what discovery writes: Sleeper ids in the team columns. */
  async function store(spreadTeam: string) {
    const db = await createTestDb();
    await new VegasEventsRepo(db).upsertMany([
      {
        eventId: 'e1',
        provider: 'sportsgameodds',
        kickoff: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        homeTeam: 'KC',
        awayTeam: 'CAR',
        total: 41.5,
        spread: -9.5,
        spreadTeam,
      },
    ]);
    return (await buildStartSitContext(db)).schedule;
  }

  it('resolves to both sides, with the sign flipped for the other one', async () => {
    const schedule = await store('KC');

    expect(schedule.get('KC')).toMatchObject({ opponent: 'CAR', spread: -9.5, total: 41.5 });
    expect(schedule.get('CAR')).toMatchObject({ opponent: 'KC', spread: 9.5, total: 41.5 });
  });

  it('is the defect this file exists for: a provider id resolves to nothing', async () => {
    /*
     * Kept as a test rather than deleted with the bug, because it is the thing
     * that must not come back. A spread whose team cannot be placed is dropped
     * on purpose — that refusal is correct and stays — so the only defence
     * against this is that the value reaching it is in the right vocabulary.
     */
    const schedule = await store('KANSAS_CITY_CHIEFS_NFL');

    expect(schedule.get('KC')?.spread).toBeNull();
    expect(schedule.get('CAR')?.spread).toBeNull();
    // The total is unaffected: it belongs to the game rather than to a side.
    expect(schedule.get('KC')?.total).toBe(41.5);
  });
});
