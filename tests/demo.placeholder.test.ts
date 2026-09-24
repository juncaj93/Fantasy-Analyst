/**
 * Demo Mode as it ships: one placeholder week, from captured responses.
 *
 * What has to stay true now that no engine runs behind it: every screen the
 * placeholder claims to show gets an answer, everything else says plainly that
 * it is not in the demo, nothing but a read passes, and the Draft screen is
 * never drawn — which is what keeps its code out of a demo browser too.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOWCASE_ID, DEMO_SHOWCASES, findShowcase } from '../src/core/demo/placeholder/index.ts';
import { DemoRuntime, DemoWriteBlockedError } from '../src/core/demo/placeholder/runtime.ts';
import type { LineupRecommendation, Overview } from '../src/web/api.ts';

/** The two halves of the Team screen's roster read; the full type is private to that screen. */
type RosterResponse = { starters: { playerId: string }[]; bench: { playerId: string }[] };

const runtime = () => DemoRuntime.forScenario(findShowcase(DEFAULT_SHOWCASE_ID)!);

describe('the placeholder scenario', () => {
  it('exists, and the default is one of them', () => {
    expect(DEMO_SHOWCASES.length).toBeGreaterThan(0);
    expect(findShowcase(DEFAULT_SHOWCASE_ID)).not.toBeNull();
    expect(findShowcase('draft-mid'), 'the draft-board demo is gone').toBeNull();
  });

  it('answers the shell and every screen it shows', async () => {
    const rt = await runtime();
    const overview = (await rt.request('GET', '/api/overview')).body as Overview;
    const league = overview.selectedLeague!.id;
    for (const path of [
      '/api/health',
      '/api/auth/status',
      '/api/leagues',
      '/api/setup/status',
      '/api/data-health',
      `/api/leagues/${league}/roster`,
      `/api/leagues/${league}/lineup`,
      `/api/leagues/${league}/waivers`,
      `/api/leagues/${league}/matchup`,
      `/api/players?q=&leagueId=${league}&limit=100&offset=0`,
    ]) {
      expect((await rt.request('GET', path)).status, path).toBe(200);
    }
  });

  it('is in season, so the Draft screen is never drawn and its code never fetched', async () => {
    const overview = (await (await runtime()).request('GET', '/api/overview')).body as Overview;
    expect(overview.season?.draftVisible).toBe(false);
    expect(overview.lifecycle?.matchupVisible).toBe(true);
  });

  it('says the draft board and trades are not part of the demo', async () => {
    const rt = await runtime();
    for (const path of ['/api/drafts/demo-draft-2026/board', '/api/trades/smart']) {
      const res = await rt.request('GET', path);
      expect(res.status, path).toBe(404);
      expect((res.body as { error: string }).error).toMatch(/not in the demo/);
    }
  });

  it('serves a roster and a lineup that agree about who is on the team', async () => {
    const rt = await runtime();
    const roster = (await rt.request('GET', '/api/leagues/demo-league-2026/roster')).body as RosterResponse;
    const lineup = (await rt.request('GET', '/api/leagues/demo-league-2026/lineup')).body as LineupRecommendation;
    expect(roster.starters.length + roster.bench.length).toBeGreaterThan(0);
    expect(lineup.found).toBe(true);
  });

  it('has a player card for everybody on the roster', async () => {
    const rt = await runtime();
    const roster = (await rt.request('GET', '/api/leagues/demo-league-2026/roster')).body as RosterResponse;
    for (const row of [...roster.starters, ...roster.bench]) {
      const id = row.playerId;
      expect((await rt.request('GET', `/api/players/${id}/detail`)).status, id).toBe(200);
    }
  });

  it('narrows the Players list by search and position', async () => {
    const rt = await runtime();
    type Page = { players: { name: string; position: string }[]; total: number };
    const all = (await rt.request('GET', '/api/players?q=&limit=100&offset=0')).body as Page;
    const qbs = (await rt.request('GET', '/api/players?q=&position=QB&limit=100&offset=0')).body as Page;
    expect(qbs.total).toBeGreaterThan(0);
    expect(qbs.total).toBeLessThan(all.total);
    expect(qbs.players.every((p) => p.position === 'QB')).toBe(true);

    const first = all.players[0]!.name;
    const found = (await rt.request('GET', `/api/players?q=${encodeURIComponent(first.slice(0, 5))}&limit=100&offset=0`))
      .body as Page;
    expect(found.players.map((p) => p.name)).toContain(first);
  });

  it('refuses anything that is not a read, before any route is looked up', async () => {
    const rt = await runtime();
    for (const [method, path] of [
      ['POST', '/api/leagues/demo-league-2026/select'],
      ['POST', '/api/drafts/demo-draft-2026/picks'],
      ['DELETE', '/api/players/p001'],
      ['POST', '/api/somewhere-that-does-not-exist'],
    ] as const) {
      await expect(rt.request(method, path), `${method} ${path}`).rejects.toBeInstanceOf(DemoWriteBlockedError);
    }
  });
});
