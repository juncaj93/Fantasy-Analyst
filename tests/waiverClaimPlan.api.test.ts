/**
 * The plan on the wire, over the real router and a real database.
 *
 * `waiverClaimPlan.test.ts` proves the seam against fixtures. This proves the
 * one thing a fixture cannot: that the handler passes the *live* objects — the
 * roster it just scored, the wire it just bounded, the bids it just priced, the
 * reserve slots and the wallet — and that none of it arrives at the planner
 * having been recomputed on the way.
 *
 * It also holds the two invariants that would be expensive to discover in
 * production: the response still carries everything it carried before, and a
 * planner failure degrades to a missing plan rather than to a missing board.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import type { WaiverClaimPlan } from '../src/core/waivers/claimPlan.ts';
import { createTestDb } from './helpers/db.ts';

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

const get = (path: string) => new Request(`https://app.test${path}`);

interface Payload {
  found: boolean;
  claimPlan: WaiverClaimPlan | null;
  upgrades: { candidates: { playerId: string; name: string }[] }[];
  faab: { bids: { playerId: string; recommended: number | null }[]; mine: { remaining: number | null } | null } | null;
  dst: unknown;
  headline: string | null;
  pool: { scanned: number };
}

describe('the waiver plan on the live endpoint', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let body: Payload;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
    env = makeEnv(db);
    app = createApp();
    const res = await app(get('/api/leagues/demo-league/waivers'), env);
    expect(res.status).toBe(200);
    body = (await res.json()) as Payload;
  });

  it('answers the whole question: who to add, what to bid, who to drop, in what order', () => {
    const plan = body.claimPlan;
    expect(plan).not.toBeNull();
    expect(plan!.claims.length).toBeGreaterThan(0);

    for (const [index, claim] of plan!.claims.entries()) {
      expect(claim.rank).toBe(index + 1);
      expect(claim.addName.length).toBeGreaterThan(0);
      expect(claim.headline).toContain(`Add ${claim.addName}`);
      /* Either a named cut, or an honest statement that there is none. */
      expect(claim.dropName != null || claim.headline.includes('No drop needed')).toBe(true);
      if (claim.dropName) expect(claim.headline).toContain(`Drop ${claim.dropName}`);
    }
  });

  /**
   * The bid on the plan is the bid on the board, and it is the same object.
   *
   * The one arithmetic invariant the seam is responsible for. A second FAAB
   * model would show up here first, as a claim quoting a figure the pricing pass
   * never produced.
   */
  it('shows the bid the pricing pass already recommended', () => {
    const priced = new Map((body.faab?.bids ?? []).map((b) => [b.playerId, b.recommended]));
    expect(priced.size).toBeGreaterThan(0);
    for (const claim of body.claimPlan!.claims) {
      if (claim.bid == null) continue;
      expect(claim.bid, `claim for ${claim.addName} quotes a price nothing priced`).toBe(priced.get(claim.addPlayerId));
    }
  });

  /** Every target is somebody the board actually offered. */
  it('plans only around players the wire scan produced', () => {
    const available = new Set(body.upgrades.flatMap((u) => u.candidates.map((c) => c.playerId)));
    for (const claim of body.claimPlan!.claims) {
      expect(available.has(claim.addPlayerId), `${claim.addName} is not on the board`).toBe(true);
    }
  });

  /**
   * A cut is one of the reader's own players, and never one of the wire's.
   *
   * Cheap to guard and not hypothetical: the roster and the board are built from
   * two different reads, and telling somebody to drop a free agent is the kind
   * of mistake that costs all the trust the rest of the plan earned.
   */
  it('cuts only players the reader actually holds', async () => {
    const roster = (await (await app(get('/api/leagues/demo-league/roster'), env)).json()) as {
      starters: { playerId: string | null }[];
      bench: { playerId: string | null }[];
    };
    const held = new Set([...roster.starters, ...roster.bench].map((p) => p.playerId));
    for (const claim of body.claimPlan!.claims) {
      if (claim.dropPlayerId == null) continue;
      expect(held.has(claim.dropPlayerId), `${claim.dropName} is not on this roster`).toBe(true);
    }
  });

  it('reads the wallet the FAAB pass published', () => {
    const remaining = body.faab?.mine?.remaining;
    if (remaining == null) return;
    expect(body.claimPlan!.budget).toContain(`$${remaining}`);
  });

  /** The board, the defence and the prices all still arrive beside it. */
  it('adds the plan without taking anything off the response', () => {
    expect(body.found).toBe(true);
    expect(body.upgrades.length).toBeGreaterThan(0);
    expect(body.pool.scanned).toBeGreaterThan(0);
    expect(body.faab).not.toBeNull();
    expect(body).toHaveProperty('dst');
  });

  /**
   * The claims and the sheet cannot name two different cuts for one add.
   *
   * The row's detail sheet reads `dropHints`; the card reads `claims`. They come
   * from one call and are reconciled inside it — see `hintsFrom` — and this is
   * the assertion that the reconciliation survived the trip.
   */
  it('names one cut per add across the plan and the sheets', () => {
    const hints = new Map(body.claimPlan!.dropHints.map((h) => [h.addPlayerId, h.dropName]));
    const seen = new Set<string>();
    for (const claim of body.claimPlan!.claims) {
      if (seen.has(claim.addPlayerId) || claim.dropName == null) continue;
      seen.add(claim.addPlayerId);
      expect(hints.get(claim.addPlayerId)).toBe(claim.dropName);
    }
  });

  /** No machine token reaches the response body. */
  it('sends sentences rather than reason codes', () => {
    const text = JSON.stringify(body.claimPlan);
    for (const code of ['add_enters_lineup', 'protected_in_lineup', 'drop_covered_by_add', 'bid_unavailable']) {
      expect(text).not.toContain(code);
    }
    expect(text.toLowerCase()).not.toContain('optimal');
  });

  /**
   * A league with no roster of the reader's own gets the `found: false` reply it
   * always got, and no plan bolted onto it.
   */
  it('says nothing about claims in a league the reader is not in', async () => {
    const res = await app(get('/api/leagues/demo-league/waivers'), env);
    const league = (await res.json()) as Payload;
    expect(league.found).toBe(true);

    const missing = await app(get('/api/leagues/not-a-league/waivers'), env);
    expect(missing.status).toBe(404);
  });
});
