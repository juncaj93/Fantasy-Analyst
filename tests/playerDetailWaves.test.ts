/**
 * What one card open costs, counted rather than hoped for.
 *
 * The defect this suite exists for was not a slow query. Every statement behind
 * `/api/players/:id/detail` was small and indexed; there were simply seventeen
 * of them, each waiting for the one before it because each was written on the
 * line after it, and four of them asked for the same player row. On D1 a
 * statement is a network round trip, so the shape of the code *was* the latency
 * — and nothing in the repository would have failed if it had become thirty.
 *
 * So the assertions here are about shape:
 *
 *   - how deep the chain is (`waves` — statements issued together share one),
 *   - how many times the same row is read,
 *   - and whether anything on the request path reaches Sleeper.
 *
 * The counter is the one `scripts/measure-api-budgets.ts` uses for the budget
 * in `perf-budgets.json`, deliberately: a test and a budget that disagreed
 * about what they were counting would be worse than either alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countingDatabase, type CountingDatabase } from '../scripts/measure-api-budgets.ts';
import { createTestDb } from './helpers/db.ts';
import { seedDemoData } from '../src/devserver/seed.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';

/** A player the demo league drafted, so provenance has something to find. */
const DRAFTED = '1001';

const app = createApp();

let db: CountingDatabase;
let deferred: Promise<unknown>[];
let env: AppEnv;
let outlookCalls: number;
let previousFetch: typeof globalThis.fetch;
/**
 * A hand on the outlook request, so a test can hold it open.
 *
 * This is how "off the critical path" is asserted rather than asserted about:
 * the fetch is held unresolved, and the card has to arrive anyway. Counting
 * calls could not show that — the request is *started* during the response, and
 * always was; what changed is that nothing waits for it.
 */
let outlookHeld: Promise<void>;

function stubSleeperOutlook(): typeof fetch {
  return (async () => {
    outlookCalls++;
    await outlookHeld;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          get_player_outlook: {
            player_id: DRAFTED,
            source: 'rotowire',
            metadata: { title: 'Season Outlook', description: 'He caught ninety balls last year. He is the number one target.' },
          },
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  const raw = await createTestDb();
  await seedDemoData(raw);
  db = countingDatabase(raw);
  deferred = [];
  outlookCalls = 0;
  outlookHeld = Promise.resolve();
  previousFetch = globalThis.fetch;
  globalThis.fetch = stubSleeperOutlook();
  env = {
    db,
    sleeper: new SleeperClient({ fetch: stubSleeperOutlook() as never }),
    vegas: new MockVegasProvider([]),
    disableAuth: true,
    waitUntil: (task) => {
      deferred.push(task);
    },
  };
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  // Settle anything the last response deferred, so it cannot run into the next
  // test's database.
  await Promise.allSettled(deferred);
});

async function open(path = `/api/players/${DRAFTED}/detail`): Promise<{ status: number; body: Record<string, unknown> }> {
  db.reset();
  const res = await app(new Request(`https://waves.test${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Everything the background was handed, run to completion. */
async function settleBackground(): Promise<void> {
  while (deferred.length > 0) await Promise.allSettled(deferred.splice(0, deferred.length));
}

/**
 * Forget what the seed knows about his outlook.
 *
 * The demo dataset records a miss for every player nobody wrote about, which is
 * what keeps the rest of the suite off the network — and it is therefore also
 * what hides the cold path this deferral is about. Cleared here, deliberately
 * and per test, so "nothing cached, nothing checked" is a state these
 * assertions can actually see.
 */
async function forgetOutlook(playerId: string): Promise<void> {
  await db.prepare('DELETE FROM player_outlooks WHERE player_id = ?').bind(playerId).run();
  await db.prepare('DELETE FROM player_outlook_misses WHERE player_id = ?').bind(playerId).run();
}

describe('the expanded card, counted in round trips', () => {
  it('assembles the whole card in three waves', async () => {
    const { status } = await open();
    expect(status).toBe(200);

    const { waves, statements, sql } = db.counts();
    /*
     * Three, and what each one is for:
     *
     *   1. the route's own `players WHERE id = ?`, which decides 404 and is
     *      then handed to the service rather than repeated;
     *   2. everything that depends on nothing — stats, both outlook cache
     *      reads, the injury reports, the evidence ledger, the league;
     *   3. everything that depends on wave 2 — injury state and usage (the
     *      player row), the newest projection snapshot (the league's scoring).
     *
     * A fourth appears legitimately when a projection snapshot exists for this
     * league's scoring, because this player's points then have to be read out
     * of a snapshot id wave 3 produced. The demo dataset has none, which is why
     * this asserts three; if that changes, four is the number to expect and the
     * budget in perf-budgets.json allows for five.
     */
    expect(waves, `the card took ${waves} serialized waves:\n${sql.join('\n')}`).toBe(3);
    expect(statements).toBeLessThanOrEqual(12);
  });

  it('reads the player row once, not four times', async () => {
    await open();
    const reads = db.counts().sql.filter((s) => /^SELECT .* FROM players WHERE id = \?$/.test(s));
    expect(reads).toHaveLength(1);
  });

  it('answers while Sleeper is still thinking about it', async () => {
    await forgetOutlook(DRAFTED);

    // Sleeper, hanging. Before this change the card hung with it.
    let release = (): void => {};
    outlookHeld = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { status, body } = await open();
    expect(status).toBe(200);
    expect(outlookCalls, 'the refresh was never started').toBe(1);
    // And the card says so honestly: it has not got the text yet, which is not
    // the same claim as nobody having written one.
    expect(body['outlook']).toBeNull();
    expect(String(body['outlookNote'])).toMatch(/Fetching/);

    release();
    await settleBackground();
  });

  it('has the outlook on the next open, fetched behind the last one', async () => {
    await forgetOutlook(DRAFTED);
    await open();
    await settleBackground();
    expect(outlookCalls, 'the background refresh never ran').toBe(1);

    const { body } = await open();
    const outlook = body['outlook'] as { text: string; source: string | null } | null;
    expect(outlook?.source).toBe('rotowire');
    expect(outlook?.text).toContain('ninety balls');
    expect(body['outlookNote']).toBeNull();
    // Cached, so the second open starts nothing.
    await settleBackground();
    expect(outlookCalls).toBe(1);
    // And it is still three waves with a hit in the cache.
    expect(db.counts().waves).toBe(3);
  });
});

describe('the draft provenance, once it is actually asked for', () => {
  /**
   * The deferral is a timing change, not a removal. Four statements — the
   * league, the draft, its picks and its rosters — used to run on every card
   * open for a line behind a further tap; they now run when that tap happens,
   * and they still answer.
   */
  it('is not on the card that nobody asked for it on', async () => {
    const { body } = await open();
    expect(body['draft']).toBeUndefined();
  });

  it('answers with the pick and the manager on its own route', async () => {
    const res = await app(new Request(`https://waves.test/api/players/${DRAFTED}/draft`), env);
    const body = (await res.json()) as { playerId: string; draft: { pick: string; managerName: string | null; line: string } | null };
    expect(res.status).toBe(200);
    expect(body.playerId).toBe(DRAFTED);
    expect(body.draft?.pick).toBe('1.01');
    expect(body.draft?.line).toContain('1.01');
  });

  it('still comes back on the card for a caller that asks for it', async () => {
    const { body } = await open(`/api/players/${DRAFTED}/detail?draft=1`);
    const draft = body['draft'] as { pick: string } | null;
    expect(draft?.pick).toBe('1.01');
  });

  it('is null rather than absent for a player nobody drafted', async () => {
    // 1005 is in the dictionary and was never picked: a free agent, not a typo.
    const res = await app(new Request('https://waves.test/api/players/1005/draft'), env);
    const body = (await res.json()) as { draft: unknown };
    expect(res.status).toBe(200);
    expect(body.draft).toBeNull();
  });

  it('is a 404 for a player who does not exist', async () => {
    const res = await app(new Request('https://waves.test/api/players/nobody/draft'), env);
    expect(res.status).toBe(404);
  });
});
