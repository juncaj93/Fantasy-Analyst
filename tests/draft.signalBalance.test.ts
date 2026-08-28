/**
 * The draft board's one preference, and the promise attached to it.
 *
 * A slider in Settings decides how loudly the owner's own research — his ♥, his
 * AVOIDs, the newsletter tally he scored — argues with the price the draft
 * market has put on a player. The feature is opt-in in the strongest sense
 * available: **at the default position the board is the board this app built
 * before the control existed**, and that is asserted here rather than argued in
 * a comment.
 *
 * Three levels, because the guarantee has to hold at each of them:
 *
 *  1. the weight table itself, which is the identity function at `balanced`;
 *  2. the ranking call, whose whole output is byte-for-byte unchanged;
 *  3. the board over HTTP with the setting stored, which is what the owner
 *     will actually be looking at on draft day — including the round trip out
 *     to a tuned position and back.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import {
  DEFAULT_WEIGHTS,
  rankAvailablePlayers,
  type AvailablePlayerInput,
  type DraftComponentWeights,
} from '../src/core/draft/engine.ts';
import {
  PERSONAL_COMPONENT_KEYS,
  SIGNAL_BALANCE_DEFAULT,
  SIGNAL_BALANCE_ORDER,
  personalScale,
  readSignalBalance,
  weightsForSignalBalance,
  type SignalBalance,
} from '../src/core/draft/signalBalance.ts';

// ------------------------------------------------------------- the weights

describe('the weight table at each position', () => {
  it('hands back the very same table at the default position', () => {
    // `toBe`, not `toEqual`: the default must be the identity function, so that
    // "nothing changed" cannot depend on two floating-point tables agreeing.
    expect(weightsForSignalBalance(SIGNAL_BALANCE_DEFAULT, DEFAULT_WEIGHTS)).toBe(DEFAULT_WEIGHTS);
    expect(SIGNAL_BALANCE_DEFAULT).toBe('balanced');
    expect(personalScale('balanced')).toBe(1);
  });

  it('moves the owner’s own components and nothing else', () => {
    const personal = new Set<string>(PERSONAL_COMPONENT_KEYS);
    for (const balance of SIGNAL_BALANCE_ORDER) {
      const scaled = weightsForSignalBalance(balance, DEFAULT_WEIGHTS);
      for (const key of Object.keys(DEFAULT_WEIGHTS) as (keyof DraftComponentWeights)[]) {
        if (personal.has(key)) {
          // Rounded to three places, like every other weight this app prints:
          // the card shows `score × weight = contribution` and invites a reader
          // to check it, which a weight of 0.26249999999999996 does not survive.
          const expected = Math.round(DEFAULT_WEIGHTS[key] * personalScale(balance) * 1000) / 1000;
          expect(scaled[key], `${key} at ${balance}`).toBe(expected);
        } else {
          expect(scaled[key], `${key} moved at ${balance}`).toBe(DEFAULT_WEIGHTS[key]);
        }
      }
    }
  });

  /**
   * The market side is the anchor and is never touched.
   *
   * `draftScore` maps a composite to a number out of 100 with constants
   * measured on a board where market value carried a weight of exactly 1, so
   * scaling it would recalibrate the score rather than express a preference.
   */
  it('never scales the market’s own two components', () => {
    for (const balance of SIGNAL_BALANCE_ORDER) {
      const scaled = weightsForSignalBalance(balance, DEFAULT_WEIGHTS);
      expect(scaled.marketValue).toBe(1);
      expect(scaled.marketExpectation).toBe(DEFAULT_WEIGHTS.marketExpectation);
    }
  });

  it('is a half at one end and half again at the other, monotonically', () => {
    expect(SIGNAL_BALANCE_ORDER.map(personalScale)).toEqual([0.5, 0.75, 1, 1.25, 1.5]);
  });

  it('never mutates the table it was handed', () => {
    const before = JSON.stringify(DEFAULT_WEIGHTS);
    for (const balance of SIGNAL_BALANCE_ORDER) weightsForSignalBalance(balance, DEFAULT_WEIGHTS);
    expect(JSON.stringify(DEFAULT_WEIGHTS)).toEqual(before);
  });

  it('reads an unknown, missing or wrongly-typed stored value as the default', () => {
    expect(readSignalBalance('personal')).toBe('personal');
    expect(readSignalBalance('lean-market')).toBe('lean-market');
    for (const junk of [null, undefined, 1, 0.75, '', 'PERSONAL', 'louder', {}, ['personal']]) {
      expect(readSignalBalance(junk), `${JSON.stringify(junk)} should fall back`).toBe('balanced');
    }
  });
});

// ------------------------------------------------------------- the ranking

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN']);

const CTX = {
  currentPick: 40,
  nextPick: 52,
  shape: SHAPE,
  profile: HALF_PPR,
  rosterCounts: { QB: 1, RB: 1, WR: 1, TE: 0 },
  totalPicks: 180,
  marketFormat: 'standard' as const,
};

/** A tally with items behind it, so the news components are real rather than unknown. */
function loudSignal(id: string) {
  const signal = emptySignal(id);
  return {
    ...signal,
    raw: { positive: 11, negative: 0, net: 11, items: 6 },
    last30: { positive: 6, negative: 0, net: 6, items: 3 },
    last7: { positive: 3, negative: 0, net: 3, items: 2 },
  };
}

function input(id: string, position: string, adp: number, extra: Partial<AvailablePlayerInput> = {}) {
  return {
    player: player({ id, fullName: `${id} Player`, position, team: 'KC' }),
    adp,
    dogAdp: null,
    adpRank: null,
    signal: null,
    myGuyLevel: 0 as const,
    seasonMarkets: [],
    preseasonPoints: null,
    nextPickSurvival: null,
    ...extra,
  } as AvailablePlayerInput;
}

/** A pool where two players carry the owner's own signal and the rest do not. */
function pool(): AvailablePlayerInput[] {
  return [
    input('wr-loud', 'WR', 44, { signal: loudSignal('wr-loud') }),
    input('wr-quiet', 'WR', 41),
    input('rb-heart', 'RB', 46, { myGuyLevel: 3 as const }),
    input('rb-quiet', 'RB', 43),
    input('te-plain', 'TE', 55),
    input('qb-plain', 'QB', 58),
  ];
}

describe('the ranking at the default position', () => {
  it('is byte-for-byte what it is with no weights argument at all', () => {
    const today = rankAvailablePlayers(pool(), CTX);
    const tuned = rankAvailablePlayers(pool(), CTX, weightsForSignalBalance('balanced', DEFAULT_WEIGHTS));
    expect(JSON.stringify(tuned)).toEqual(JSON.stringify(today));
  });
});

describe('the ranking away from the default', () => {
  it('spends more of the owner’s own signal at the personal end, and less at the market end', () => {
    const contribution = (balance: SignalBalance, id: string, key: string) => {
      const ranked = rankAvailablePlayers(pool(), CTX, weightsForSignalBalance(balance, DEFAULT_WEIGHTS));
      const rec = ranked.find((r) => r.playerId === id)!;
      return rec.components.find((c) => c.key === key)!.contribution;
    };

    const heartAtDefault = contribution('balanced', 'rb-heart', 'my_guy');
    expect(heartAtDefault).toBeGreaterThan(0);
    expect(contribution('personal', 'rb-heart', 'my_guy')).toBeCloseTo(heartAtDefault * 1.5, 3);
    expect(contribution('market', 'rb-heart', 'my_guy')).toBeCloseTo(heartAtDefault * 0.5, 3);

    const newsAtDefault = contribution('balanced', 'wr-loud', 'news_lifetime');
    expect(newsAtDefault).toBeGreaterThan(0);
    expect(contribution('personal', 'wr-loud', 'news_lifetime')).toBeCloseTo(newsAtDefault * 1.5, 3);
    expect(contribution('market', 'wr-loud', 'news_lifetime')).toBeCloseTo(newsAtDefault * 0.5, 3);
  });

  /** The market's own components are untouched on every row, at every position. */
  it('leaves every market component exactly where it was', () => {
    const at = (balance: SignalBalance) =>
      rankAvailablePlayers(pool(), CTX, weightsForSignalBalance(balance, DEFAULT_WEIGHTS));
    const marketOf = (ranked: ReturnType<typeof at>) =>
      ranked.map((rec) => ({
        id: rec.playerId,
        market: rec.components
          .filter((c) => c.key === 'market_value' || c.key === 'market_expectation')
          .map((c) => `${c.key}:${c.score}:${c.weight}:${c.contribution}`),
      }));

    const base = JSON.stringify(marketOf(at('balanced')));
    for (const balance of SIGNAL_BALANCE_ORDER) {
      expect(JSON.stringify(marketOf(at(balance))), `market moved at ${balance}`).toEqual(base);
    }
  });

  /**
   * It can reorder the board — otherwise the control would be decorative.
   *
   * The gap is chosen so the market's man wins at the default as well as at the
   * market end, and is only overtaken at the personal end. That is the whole
   * claim in one assertion: the slider changes a decision, and the default is
   * not one of the positions where it has changed it.
   */
  it('can move a favoured player past one the market prefers, and only when asked', () => {
    const order = (balance: SignalBalance) =>
      rankAvailablePlayers(
        [
          input('wr-loud', 'WR', 70, { signal: loudSignal('wr-loud'), myGuyLevel: 3 as const }),
          input('wr-quiet', 'WR', 38),
        ],
        CTX,
        weightsForSignalBalance(balance, DEFAULT_WEIGHTS),
      ).map((r) => r.playerId);

    expect(order('market')).toEqual(['wr-quiet', 'wr-loud']);
    expect(order('balanced')).toEqual(['wr-quiet', 'wr-loud']);
    expect(order('personal')).toEqual(['wr-loud', 'wr-quiet']);
  });
});

// --------------------------------------------------------------- the board

function makeEnv(db: NodeSqliteDatabase): AppEnv {
  return {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
  };
}

describe('the board the owner will actually be looking at', () => {
  let db: NodeSqliteDatabase;
  let env: AppEnv;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  const post = (path: string, body: unknown) =>
    app(
      new Request(`https://app.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
      env,
    );

  const boardRows = async (): Promise<string> => {
    const res = await app(new Request('https://app.test/api/drafts/demo-draft/board?limit=40'), env);
    const body = (await res.json()) as { recommendations: unknown[] };
    return JSON.stringify(body.recommendations);
  };

  const boardWarnings = async (): Promise<string[]> => {
    const res = await app(new Request('https://app.test/api/drafts/demo-draft/board?limit=40'), env);
    return ((await res.json()) as { warnings: string[] }).warnings;
  };

  const setBalance = (balance: string) => post('/api/setup/draft-balance', { balance });

  beforeEach(async () => {
    db = await createTestDb();
    env = makeEnv(db);
    app = createApp();
    await seedDemoData(db);
    cookie = (
      await (
        await app(
          new Request('https://app.test/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passphrase: 'correct horse battery staple' }),
          }),
          env,
        )
      ).headers.get('set-cookie')!
    ).split(';')[0]!;
  });

  /** The promise, on a real board: storing the default changes nothing at all. */
  it('is identical with nothing stored and with the default stored', async () => {
    const untouched = await boardRows();
    expect(untouched.length, 'the board is empty, so this proves nothing').toBeGreaterThan(500);

    expect((await setBalance('balanced')).status).toBe(200);
    expect(await boardRows()).toEqual(untouched);
  });

  /**
   * ...and it is still identical after a trip out to an extreme and back.
   *
   * The case a stored preference gets wrong: a value written, applied, and then
   * "cleared" to something that is nearly the original. Coming home has to mean
   * coming home.
   */
  it('returns to exactly the original board when the slider is put back', async () => {
    // A ♥♥♥ on somebody near the top, so there is personal signal to turn up.
    const before = await boardRows();
    const firstId = (JSON.parse(before) as { playerId: string }[])[0]!.playerId;
    await post(`/api/players/${firstId}/my-guy`, { level: 3 });

    const withHeart = await boardRows();
    await setBalance('personal');
    const loud = await boardRows();
    expect(loud, 'the slider did nothing').not.toEqual(withHeart);

    await setBalance('balanced');
    expect(await boardRows()).toEqual(withHeart);
  });

  /** A board built at a tuned position says so, rather than looking default. */
  it('discloses a non-default position above the board, and says nothing at the default', async () => {
    expect((await boardWarnings()).join(' ')).not.toContain('your own research is set');

    await setBalance('personal');
    expect((await boardWarnings()).join(' ')).toContain('louder than usual');

    await setBalance('market');
    expect((await boardWarnings()).join(' ')).toContain('quieter than usual');

    await setBalance('balanced');
    expect((await boardWarnings()).join(' ')).not.toContain('your own research is set');
  });

  it('reports the stored position on the Settings status', async () => {
    const read = async () => {
      const res = await app(new Request('https://app.test/api/setup/status'), env);
      return ((await res.json()) as { draftBalance: string }).draftBalance;
    };
    expect(await read()).toBe('balanced');
    await setBalance('lean-personal');
    expect(await read()).toBe('lean-personal');
  });

  it('refuses a position that is not on the control, and keeps the stored one', async () => {
    await setBalance('lean-market');
    const res = await setBalance('personal-and-then-some');
    expect(res.status).toBe(400);

    const status = await app(new Request('https://app.test/api/setup/status'), env);
    expect(((await status.json()) as { draftBalance: string }).draftBalance).toBe('lean-market');
  });

  /** It is a write, so it is behind the passphrase like every other write. */
  it('cannot be moved without the passphrase', async () => {
    const res = await app(
      new Request('https://app.test/api/setup/draft-balance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ balance: 'personal' }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
