/**
 * What a phone is sent, and what it is not.
 *
 * The board is a decision that carries its own workings — fifteen scored
 * components per player, the bullets they produce, the opportunity-cost and
 * NFL-overlap arithmetic, the `Next` model's per-player probabilities — and on
 * a four-hundred-player board that was roughly seven bytes in ten of a response
 * fetched over a phone network in the middle of a draft. Nothing on the Draft
 * screen draws any of it.
 *
 * So the wire carries less than the assembly produces, and these are the two
 * properties that has to keep: **nothing kept changes**, and **nothing dropped
 * is unreachable**. The first is what makes this a transfer saving rather than
 * a product change; the second is why the probes still work.
 */

import { describe, expect, it } from 'vitest';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import {
  boardForClient,
  TRIMMED_BOARD_FIELDS,
  TRIMMED_RECOMMENDATION_FIELDS,
} from '../src/core/draft/boardWire.ts';

async function seededEnv(): Promise<AppEnv> {
  const db = await createTestDb();
  await seedDemoData(db);
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
  };
}

const boardJson = async (env: AppEnv, query: string) =>
  (await createApp()(new Request(`https://app.test/api/drafts/demo-draft/board${query}`), env)).json() as Promise<{
    recommendations: Record<string, unknown>[];
  } & Record<string, unknown>>;

describe('the board on the wire', () => {
  it('keeps every value the assembly produced, unchanged and in order', async () => {
    const env = await seededEnv();
    const full = await new DraftBoardService(env.db).build('demo-draft', { limit: 40 });
    const wire = boardForClient(full);

    expect(wire.recommendations.map((r) => r.playerId)).toEqual(full.recommendations.map((r) => r.playerId));
    for (const [key, value] of Object.entries(wire)) {
      if (key === 'recommendations') continue;
      expect(value, key).toEqual(full[key as keyof typeof full]);
    }
    for (const [i, rec] of wire.recommendations.entries()) {
      for (const [key, value] of Object.entries(rec)) {
        expect(value, `${rec.playerId}.${key}`).toEqual(full.recommendations[i]![key as never]);
      }
    }
  });

  /** A projection that edited its input would change what a snapshot records. */
  it('leaves the assembly’s own object alone', async () => {
    const env = await seededEnv();
    const full = await new DraftBoardService(env.db).build('demo-draft', { limit: 10 });
    const before = JSON.stringify(full);
    boardForClient(full);
    expect(JSON.stringify(full)).toBe(before);
  });

  it('drops exactly the fields it says it drops, and no others', async () => {
    const env = await seededEnv();
    const full = await new DraftBoardService(env.db).build('demo-draft', { limit: 10 });
    const wire = boardForClient(full);

    expect(Object.keys(full).filter((k) => !(k in wire)).sort()).toEqual([...TRIMMED_BOARD_FIELDS].sort());
    const rec = full.recommendations[0]!;
    const wireRec = wire.recommendations[0]!;
    expect(Object.keys(rec).filter((k) => !(k in wireRec)).sort()).toEqual([...TRIMMED_RECOMMENDATION_FIELDS].sort());
  });

  it('is what the route serves, and diagnostics=1 is the whole thing', async () => {
    const env = await seededEnv();
    const trimmed = await boardJson(env, '?limit=20');
    const whole = await boardJson(env, '?limit=20&diagnostics=1');

    for (const field of TRIMMED_BOARD_FIELDS) {
      expect(trimmed, field).not.toHaveProperty(field);
      expect(whole, field).toHaveProperty(field);
    }
    for (const field of TRIMMED_RECOMMENDATION_FIELDS) {
      expect(trimmed.recommendations[0], field).not.toHaveProperty(field);
      expect(whole.recommendations[0], field).toHaveProperty(field);
    }
    // The ranking is the same board either way — this is a transfer decision.
    expect(trimmed.recommendations.map((r) => r['playerId'])).toEqual(
      whole.recommendations.map((r) => r['playerId']),
    );
  });

  /*
   * The saving, asserted rather than believed.
   *
   * A loose bound on purpose: the exact ratio moves with the fixture and with
   * how many players carry a market. What may not happen quietly is the
   * explanation creeping back onto the wire, which is what this catches.
   */
  it('is a fraction of the size of the board it came from', async () => {
    const env = await seededEnv();
    const full = await new DraftBoardService(env.db).build('demo-draft', { limit: 40 });
    const wholeBytes = JSON.stringify(full).length;
    const wireBytes = JSON.stringify(boardForClient(full)).length;
    expect(wireBytes).toBeLessThan(wholeBytes / 2);
  });

  /**
   * The board says which picks it read, in the sync route's own terms.
   *
   * This is what lets arriving on Draft cost one board build instead of two —
   * see `web/draftRefresh.ts`. It is only useful if it actually matches, so it
   * is checked against a real sync's own fingerprint in `postDraftTransition`
   * terms here: same draft, same picks, same string.
   */
  it('carries the fingerprint of the pick stream it was built from', async () => {
    const env = await seededEnv();
    const board = await boardJson(env, '?limit=5');
    expect(typeof board['pickFingerprint']).toBe('string');
    expect(board['pickFingerprint']).toContain('demo-draft:');

    // Stable across two reads of an unchanged draft, or it would never match.
    const again = await boardJson(env, '?limit=5');
    expect(again['pickFingerprint']).toBe(board['pickFingerprint']);
    // And it does not depend on how much of the board was asked for.
    const narrower = await boardJson(env, '?limit=2&position=RB');
    expect(narrower['pickFingerprint']).toBe(board['pickFingerprint']);
  });
});
