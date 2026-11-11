/**
 * The trade finder through the real router (Round 19): today's Trades screen
 * (`/api/trades/smart`) and the new screens (`/api/trades/offers`) read one
 * run, every offer carries its label and exact edge, the probe's route says
 * what each step removed, and none of it asks Sleeper for anything.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper, seed } from './helpers/tradeLeague.ts';

describe('the trade finder routes', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = (await createTestDb()) as NodeSqliteDatabase;
    await seed(db, { fairDeal: true });
  });

  it('answers today’s screen with at most three labelled offers and no Sleeper request', async () => {
    const { client, calls } = forbiddenSleeper();
    const res = await createApp()(new Request('http://x/api/trades/smart'), envFor(db, client));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    const board = (await res.json()) as {
      status: string;
      offers: { pick?: { label: string; kind: string; edgePercent: number }; seasonCheck?: { kind: string | null } }[];
      notes: string[];
    };
    expect(['fair', 'close', 'none']).toContain(board.status);
    expect(board.offers.length).toBeLessThanOrEqual(3);
    if (board.status === 'none') expect(board.notes.length).toBeGreaterThan(0);
    else expect(board.offers.length).toBeGreaterThan(0);
    for (const offer of board.offers) {
      expect(offer.pick, 'every offer carries its label').toBeDefined();
      expect(Number.isInteger(offer.pick!.edgePercent)).toBe(true);
      if (offer.pick!.kind === 'close') expect(offer.pick!.label).toMatch(/^Close: /);
      else expect(['Fair', 'Good for you']).toContain(offer.pick!.label);
      expect(['leans_b', 'favors_b']).not.toContain(offer.seasonCheck?.kind);
    }
  });

  it('gives the new screens the same offers, in plain numbers', async () => {
    const { client } = forbiddenSleeper();
    const app = createApp();
    const env = envFor(db, client);
    const smart = (await (await app(new Request('http://x/api/trades/smart'), env)).json()) as { offers: { id: string }[] };
    const res = await app(new Request('http://x/api/trades/offers'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; offers: { id: string; label: string; you: { thisWeek: number; restOfSeason: number } }[]; funnel?: unknown };
    expect(body.offers.map((o) => o.id)).toEqual(smart.offers.map((o) => o.id));
    expect(body.funnel).toBeUndefined();
  });

  it('gives Check a trade one plain line on the top offer: the verdict, both gains, the edge, who gets better where', async () => {
    const { client } = forbiddenSleeper();
    const app = createApp();
    const env = envFor(db, client);
    const body = (await (await app(new Request('http://x/api/trades/offers'), env)).json()) as {
      offers: { partner: { rosterId: number }; give: { playerId: string }[]; get: { playerId: string }[]; label: string; verdict: string; edgePercent: number }[];
    };
    const top = body.offers[0];
    if (!top) return;
    const teams = (await (await app(new Request('http://x/api/leagues/tony/trades/check/teams'), env)).json()) as { teams: { rosterId: number; isMine: boolean }[] };
    const mine = teams.teams.find((t) => t.isMine)!;
    const q = `a=${mine.rosterId}&b=${top.partner.rosterId}&give=${top.give.map((p) => p.playerId).join(',')}&get=${top.get.map((p) => p.playerId).join(',')}`;
    const check = (await (await app(new Request(`http://x/api/leagues/tony/trades/check?${q}`), env)).json()) as {
      summary: { verdict: string; word: string; edgePercent: number; you: { thisWeek: number; restOfSeason: number }; them: { restOfSeason: number }; positions: { you: { better: string[] } } };
    };
    expect(['Good for you', 'Fair', 'Bad for you']).toContain(check.summary.word);
    expect(check.summary.verdict).toBe(top.verdict);
    expect(check.summary.edgePercent).toBe(top.edgePercent);
    expect(Array.isArray(check.summary.positions.you.better)).toBe(true);
  });

  it('tells the probe what each step removed, and what it read', async () => {
    const { client } = forbiddenSleeper();
    const res = await createApp()(new Request('http://x/api/diagnostics/trade-finder?cost=1'), envFor(db, client));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { funnel: { generated: number; removed: Record<string, number> }; cost: { rowsReturned: number } };
    expect(body.funnel.generated).toBeGreaterThan(0);
    expect(body.cost.rowsReturned).toBeGreaterThan(0);
  });
});
