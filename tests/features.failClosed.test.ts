/**
 * Round 30, item 4: a failed or missing status read keeps the current screens.
 *
 * Round 29 audit (C2): one failed `/api/auth/status` read put Alex back on the
 * retired Trades and Players screens for the whole session, with no message.
 * The switch store now fails closed to the new screens; a server that answers
 * still decides, so a switch turned off on the server is still off.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function fresh() {
  vi.resetModules();
  return import('../src/web/features.ts');
}

describe('the feature switches when the status read goes wrong', () => {
  beforeEach(() => vi.resetModules());

  it('a failed read keeps the new Trades and Players screens', async () => {
    const f = await fresh();
    f.setFeatures(null); // App.tsx's catch branch
    expect(f.currentFeatures()).toMatchObject({ tradesScreens: 'new', playersInSeason: true, known: true });
  });

  it('an answer with no switches in it keeps them too', async () => {
    const f = await fresh();
    f.setFeatures(undefined); // `status.features` missing
    expect(f.currentFeatures()).toMatchObject({ tradesScreens: 'new', playersInSeason: true, known: true });
  });

  it('a failed read after a good one changes nothing', async () => {
    const f = await fresh();
    f.setFeatures({ tradesScreens: 'new', preview: null, playersInSeason: true });
    const before = f.currentFeatures();
    f.setFeatures(null);
    expect(f.currentFeatures()).toBe(before);
  });

  it('a server that says off is still obeyed', async () => {
    const f = await fresh();
    f.setFeatures({ tradesScreens: 'old', preview: null });
    expect(f.currentFeatures()).toMatchObject({ tradesScreens: 'old', playersInSeason: false, known: true });
  });

  it('a server that says on is obeyed', async () => {
    const f = await fresh();
    f.setFeatures({ tradesScreens: 'new', preview: null, playersInSeason: true });
    expect(f.currentFeatures()).toMatchObject({ tradesScreens: 'new', playersInSeason: true });
  });
});
