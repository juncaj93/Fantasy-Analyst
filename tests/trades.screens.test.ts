/**
 * The rebuilt Trades screens' routes (Round 19) and the preview league behind
 * them. Live, they read what the older trade routes read; on the preview
 * upload (`PREVIEW = "trades"`) they answer from the made-up league and read
 * nothing at all. The switch is reported by `/api/auth/status`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppEnv } from '../src/server/app.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';
import { PREVIEW_NAMES, previewLeague } from '../src/core/trades/previewLeague.ts';
import { findTrades } from '../src/core/trades/finder.ts';
import type { ScreensOffers, ScreensTeams, ScreensVerdict } from '../src/core/trades/screensWire.ts';

/** A database that refuses every statement: the preview must never reach one. */
const NO_DB = new Proxy({} as AppEnv['db'], {
  get: () => () => {
    throw new Error('the Trades preview must not read the database');
  },
});

describe('the preview league', () => {
  it('uses the same small set of made-up names every time', () => {
    expect(PREVIEW_NAMES.length).toBeLessThanOrEqual(50);
    expect(new Set(PREVIEW_NAMES).size).toBe(PREVIEW_NAMES.length);
    expect(PREVIEW_NAMES).toContain('Marcus Vance');
    expect(previewLeague().rosters.flatMap((r) => r.playerIds).every((id) => previewLeague().rates.has(id))).toBe(true);
  });

  it('has fair offers in a normal week and only labelled close ones in a quiet week', () => {
    const run = (week: 'normal' | 'quiet') => {
      const L = previewLeague(week);
      return findTrades({ horizon: L.horizon, shape: L.shape, replacement: L.replacement, rates: L.rates, rosters: L.rosters, rosterLimit: L.rosterLimit });
    };
    const normal = run('normal');
    expect(normal.status).toBe('fair');
    expect(normal.offers.length).toBe(3);
    const quiet = run('quiet');
    expect(quiet.status).toBe('close');
    expect(quiet.offers.length).toBeGreaterThan(0);
    for (const o of quiet.offers) expect(o.label).toMatch(/^Close: /);
  });
});

describe('the preview upload', () => {
  const env = (): AppEnv => ({ ...envFor(NO_DB, forbiddenSleeper().client), preview: 'trades', tradesScreens: 'new' });

  it('answers offers, rosters and a verdict from the made-up league, reading nothing', async () => {
    const app = createApp();
    const offers = (await (await app(new Request('http://x/api/trades/screens/offers'), env())).json()) as ScreensOffers;
    expect(offers.league?.name).toBe('Preview League');
    expect(offers.offers.length).toBe(3);
    const quiet = (await (await app(new Request('http://x/api/trades/screens/offers?week=quiet'), env())).json()) as ScreensOffers;
    expect(quiet.status).toBe('close');
    const teams = (await (await app(new Request('http://x/api/trades/screens/teams'), env())).json()) as ScreensTeams;
    expect(teams.teams.map((t) => t.label)).toEqual(['You', 'Dermot', 'Kim', 'Sam']);
    const top = offers.offers[0]!;
    const q = `b=${top.partner.rosterId}&give=${top.give.map((p) => p.playerId).join(',')}&get=${top.get.map((p) => p.playerId).join(',')}`;
    const verdict = (await (await app(new Request(`http://x/api/trades/screens/verdict?${q}`), env())).json()) as ScreensVerdict;
    expect(verdict.summary?.word).toBe('Fair');
    expect(verdict.summary?.edgePercent).toBe(top.edgePercent);
    expect(verdict.summary?.positions.you.better.length).toBeGreaterThan(0);
  });

  it('answers Build a trade’s one question: offers around one player only', async () => {
    const app = createApp();
    const sell = (await (await app(new Request('http://x/api/trades/screens/offers?sell=p05'), env())).json()) as ScreensOffers;
    for (const o of sell.offers) expect(o.give.map((p) => p.playerId)).toContain('p05');
    const get = (await (await app(new Request('http://x/api/trades/screens/offers?get=p28'), env())).json()) as ScreensOffers;
    expect(get.offers.length).toBeGreaterThan(0);
    for (const o of get.offers) expect(o.get.map((p) => p.playerId)).toContain('p28');
  });

  it('reports the switch and the preview to the screens', async () => {
    const status = (await (await createApp()(new Request('http://x/api/auth/status'), env())).json()) as { features: { tradesScreens: string; preview: string | null } };
    expect(status.features).toEqual({ tradesScreens: 'new', preview: 'trades' });
  });
});

describe('the live site', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = (await createTestDb()) as NodeSqliteDatabase;
    await seed(db, { fairDeal: true });
  });

  it('keeps today’s screens unless the switch says otherwise', async () => {
    const status = (await (await createApp()(new Request('http://x/api/auth/status'), envFor(db, forbiddenSleeper().client))).json()) as {
      features: { tradesScreens: string; preview: string | null };
    };
    expect(status.features).toEqual({ tradesScreens: 'old', preview: null });
  });

  it('answers the new screens from the real league, with no Sleeper request, and ignores the preview week', async () => {
    const { client, calls } = forbiddenSleeper();
    const app = createApp();
    const offers = (await (await app(new Request('http://x/api/trades/screens/offers?week=quiet'), envFor(db, client))).json()) as ScreensOffers;
    expect(offers.league?.id).toBe('tony');
    expect(offers.offers.length).toBeGreaterThan(0);
    const teams = (await (await app(new Request('http://x/api/trades/screens/teams'), envFor(db, client))).json()) as ScreensTeams;
    expect(teams.teams.some((t) => t.isMine)).toBe(true);
    const top = offers.offers[0]!;
    const q = `b=${top.partner.rosterId}&give=${top.give.map((p) => p.playerId).join(',')}&get=${top.get.map((p) => p.playerId).join(',')}`;
    const verdict = (await (await app(new Request(`http://x/api/trades/screens/verdict?${q}`), envFor(db, client))).json()) as ScreensVerdict;
    expect(['Good for you', 'Fair', 'Bad for you']).toContain(verdict.summary?.word);
    expect(verdict.summary?.verdict).toBe(top.verdict);
    expect(calls).toEqual([]);
  });

  it('refuses a verdict request with no team', async () => {
    const res = await createApp()(new Request('http://x/api/trades/screens/verdict?give=a'), envFor(db, forbiddenSleeper().client));
    expect(res.status).toBe(400);
  });
});
