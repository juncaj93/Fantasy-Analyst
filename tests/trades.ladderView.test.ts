/**
 * The negotiation card, and the one thing it is not allowed to do.
 *
 * `core/trades/ladder.ts` and the endpoint over it have been complete and
 * tested for a while and nothing drew them — `docs/STATUS.md` has been carrying
 * the line "built but has no screen yet" about exactly this. Drawing them adds
 * no arithmetic: every number on the card is the engine's, and what this file
 * pins is the two decisions the *screen* makes.
 *
 * **The rungs.** Three of them, in the order a negotiation actually goes, with
 * the fair band drawn as a band. The response also carries a flattened `rungs`
 * array whose fair entry is its lower bound with the upper one written into a
 * sentence, so the check here is that the card reads the numeric fields and
 * cannot drift from them.
 *
 * **The manager, and silence.** This is the load-bearing half. The screen the
 * owner wants live the moment his draft ends stands in a league with no trade
 * history whatsoever, and every manager in it is *unmeasured* rather than
 * *inactive* — §10's standing principle, in the form a UI is most likely to
 * break it: by printing "rarely trades" over an empty sample. So the sample
 * gate is a pure function with a test rather than three conditionals inside a
 * component, and the cases below are the ones a real league passes through in
 * its first month: no profile at all, a profile with nothing in it, and a
 * profile with one or two trades in it.
 *
 * Nothing here renders. The rungs and the gate are functions; whether the fold
 * that draws them fetches once and stays inside a 360-point phone is
 * `e2e/trade-ladder.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_TRADE_SAMPLE,
  buildTradeProfile,
  collectTrades,
  type ManagerTradeProfile,
} from '../src/core/managers/tradeProfile.ts';
import { buildLadder, type LadderInputs, type TradeLadder } from '../src/core/trades/ladder.ts';
import { ladderRows, partnerRead } from '../src/web/components/tradeLadder.tsx';
import type { CachedManagerProfile, LadderPartner } from '../src/web/api.ts';
import type { SleeperTransaction } from '../src/core/sleeper/types.ts';

/** The one roster every profile below describes. */
const PARTNER_ROSTER = 2;

const POSITIONS: Record<string, string> = { p1: 'RB', p2: 'RB', p3: 'WR', p4: 'WR', p5: 'TE', p6: 'QB' };

/**
 * A ladder with a real spread, built by the engine rather than typed out.
 *
 * The numbers must be the engine's or the rung test is testing its own fixture.
 */
function ladder(overrides: Partial<LadderInputs> = {}): TradeLadder {
  return buildLadder({
    targetPlayerId: 'p9',
    targetName: 'Target Player',
    targetValue: 18,
    targetValueToMe: 20,
    targetCostToPartner: 8,
    offering: { value: 9, valueToReceiver: 9, playerIds: ['p1'], names: ['Spare Part'] },
    partner: null,
    ...overrides,
  });
}

/** One completed Sleeper trade, in the shape `collectTrades` reads. */
function trade(opts: { id: string; week: number; gives: string[]; gets: string[] }): SleeperTransaction {
  const adds: Record<string, number> = {};
  const drops: Record<string, number> = {};
  for (const id of opts.gets) adds[id] = PARTNER_ROSTER;
  for (const id of opts.gives) drops[id] = PARTNER_ROSTER;
  return {
    transaction_id: opts.id,
    type: 'trade',
    status: 'complete',
    created: 1_700_000_000_000 + opts.week * 86_400_000,
    leg: opts.week,
    roster_ids: [PARTNER_ROSTER, 7],
    adds,
    drops,
    settings: {},
    creator: 'owner-2',
  };
}

/**
 * A real profile, from real transactions, through the real builder.
 *
 * `count` trades split across two seasons, which is what a league that has been
 * running looks like. A `count` of zero is the league whose draft ended last
 * night: a manager who exists, has been observed, and has done nothing yet.
 */
function profileWith(count: number): ManagerTradeProfile {
  const transactions = Array.from({ length: count }, (_, i) =>
    trade({
      id: `t${i}`,
      week: i + 1,
      gives: [`p${(i % 3) + 1}`, `p${(i % 3) + 4}`],
      gets: [`p${(i % 3) + 4}`],
    }),
  );
  const half = Math.ceil(count / 2);
  const trades = [
    ...collectTrades(transactions.slice(0, half), '2025', new Map([['owner-2', PARTNER_ROSTER]])),
    ...collectTrades(transactions.slice(half), '2026', new Map([['owner-2', PARTNER_ROSTER]])),
  ];
  return buildTradeProfile({
    rosterId: PARTNER_ROSTER,
    ownerName: 'Rival',
    trades,
    positionOf: (id) => POSITIONS[id] ?? null,
    latestSeason: '2026',
  });
}

function cached(profile: ManagerTradeProfile): CachedManagerProfile<ManagerTradeProfile> {
  return {
    profile,
    sample: profile.sample,
    confident: profile.confident,
    computedAt: '2026-08-01T00:00:00.000Z',
    stale: false,
  };
}

function partnerFrom(profile: ManagerTradeProfile | null): LadderPartner {
  return {
    rosterId: PARTNER_ROSTER,
    ownerName: 'Rival',
    profile: profile ? cached(profile) : null,
  };
}

/** Every number a rendered value carries, in order. */
function figuresIn(value: string): number[] {
  return (value.match(/[\d.]+/g) ?? []).map(Number);
}

/** What the card rounds to — points, at the precision every other screen uses. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Words that describe a *person*. None of them may appear below the threshold. */
const TENDENCY_VOCABULARY = [
  'usually',
  'rarely',
  'often',
  'prefers',
  'history of',
  'has been buying',
  'has been selling',
  'willing to',
  'trades about',
];

describe('the three rungs are the engine’s own numbers', () => {
  it('draws where to open, the fair band, and where to stop — in that order', () => {
    const built = ladder();
    const rows = ladderRows(built);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.label)).toEqual(['Open at', 'Fair', 'Stop at']);

    /*
     * Each row carries the engine's own figure, to the one decimal the rest of
     * this app prints points in, and the fair row carries *both* ends of the
     * band rather than the lower one with the upper written into prose.
     */
    expect(figuresIn(rows[0]!.value)).toEqual([oneDecimal(built.opening)]);
    expect(figuresIn(rows[1]!.value)).toEqual([oneDecimal(built.fair.low), oneDecimal(built.fair.high)]);
    expect(figuresIn(rows[2]!.value)).toEqual([oneDecimal(built.doNotExceed)]);
  });

  it('names the unit on the numbers that are a single figure', () => {
    // Weekly starting-lineup points. §15: no unexplained figure on a card.
    const rows = ladderRows(ladder());
    expect(rows[0]!.value).toContain('pts');
    expect(rows[2]!.value).toContain('pts');
  });

  /**
   * The ordering the engine guarantees, restated on what the screen draws.
   *
   * `ladderIsOrdered` pins it on the response. This pins that the card did not
   * reorder or re-pair the fields on the way to the page — a fair band drawn
   * from `opening` and `doNotExceed` would still pass every check above.
   */
  it('draws them in the order the ladder is built in', () => {
    const built = ladder();
    expect(built.opening).toBeLessThanOrEqual(built.fair.low);
    expect(built.fair.low).toBeLessThanOrEqual(built.fair.high);
    expect(built.fair.high).toBeLessThanOrEqual(built.doNotExceed);

    const figures = ladderRows(built).flatMap((row) => figuresIn(row.value));
    expect(figures).toEqual([...figures].sort((a, b) => a - b));
  });

  /**
   * A blocked ladder is not a ladder of zeroes.
   *
   * `blockedLadder` returns zeros in every numeric field precisely because none
   * of them mean anything, and a card that drew them would print `Open at 0 pts`
   * over a player who is not for sale. No rows, and the caller prints the
   * sentence instead.
   */
  it('draws no rungs at all when the trade is blocked', () => {
    const blocked = ladder({ targetValueToMe: 4, targetCostToPartner: 9 });
    expect(blocked.blocked).toBeTruthy();
    expect(ladderRows(blocked)).toEqual([]);
  });
});

describe('what may be said about the manager holding him', () => {
  /**
   * The league the owner is actually in on the night his draft ends.
   *
   * Rosters are set, the ladder prices perfectly well — and there is not one
   * completed trade in the room. The card must name the manager, because that
   * is a fact, and must claim nothing whatsoever about how he deals.
   */
  it('stays silent about a manager the league has not measured yet', () => {
    const read = partnerRead(partnerFrom(profileWith(0)));

    expect(read.name).toBe('Rival');
    expect(read.confident).toBe(false);
    expect(read.headline).toBeNull();
    expect(read.notes).toEqual([]);
    expect(read.absence).toBeTruthy();
    expect(read.absence!.toLowerCase()).toContain('no completed trade');
  });

  it('says nothing at all when no profile has ever been built', () => {
    const read = partnerRead(partnerFrom(null));

    expect(read.name).toBe('Rival');
    expect(read.confident).toBe(false);
    expect(read.headline).toBeNull();
    expect(read.notes).toEqual([]);
    expect(read.absence!.toLowerCase()).toContain('no trade history has been read');
  });

  /**
   * One or two trades is one or two trades.
   *
   * The case between the two obvious ones, and the one a screen is likeliest to
   * get wrong: there *is* a profile, it *has* rows in it, and it is still not a
   * tendency. What the reader gets is the count, which is a fact about the
   * evidence rather than a claim about the person.
   */
  it('stays silent below the profile’s own threshold, and says how thin the sample is', () => {
    const thin = profileWith(MIN_TRADE_SAMPLE - 1);
    expect(thin.confident).toBe(false);

    const read = partnerRead(partnerFrom(thin));
    expect(read.confident).toBe(false);
    expect(read.headline).toBeNull();
    expect(read.notes).toEqual([]);
    expect(read.absence).toContain(String(thin.sample));
    expect(read.absence!.toLowerCase()).toContain('too few');
  });

  it('reads a manager the league has genuinely measured', () => {
    const measured = profileWith(MIN_TRADE_SAMPLE + 2);
    expect(measured.confident).toBe(true);

    const read = partnerRead(partnerFrom(measured));
    expect(read.confident).toBe(true);
    expect(read.notes).toEqual(measured.notes);
    expect(read.notes.length).toBeGreaterThan(0);
    expect(read.absence).toBeNull();
    // The rate is the profile's, and it is only ever printed when there is one.
    expect(measured.tradesPerSeason).not.toBeNull();
    expect(read.headline).toMatch(/season/);
  });

  /**
   * The two `confident` flags are written together, so a disagreement between
   * them is a bug upstream — and the failure mode of a bug upstream should be
   * silence, not a tendency nobody stands behind.
   */
  it('stays silent when the cache row and the profile disagree', () => {
    const measured = profileWith(MIN_TRADE_SAMPLE + 2);
    const row = { ...cached(measured), confident: false };
    const read = partnerRead({ rosterId: PARTNER_ROSTER, ownerName: 'Rival', profile: row });

    expect(read.confident).toBe(false);
    expect(read.notes).toEqual([]);
  });

  /**
   * The whole rule, checked as an outcome rather than field by field.
   *
   * Every sample size below the threshold, and none of them may produce a word
   * that describes a person. This is what would catch a future edit that
   * decided a "helpful" hint was worth it at three trades.
   */
  it('never prints tendency vocabulary below the threshold, at any sample size', () => {
    for (let sample = 0; sample < MIN_TRADE_SAMPLE; sample++) {
      const read = partnerRead(partnerFrom(profileWith(sample)));
      const said = [read.headline ?? '', ...read.notes, read.absence ?? ''].join(' ').toLowerCase();
      for (const word of TENDENCY_VOCABULARY) {
        expect(said, `sample ${sample} described the manager with "${word}"`).not.toContain(word);
      }
    }
  });

  /** The seat Sleeper has not named is not given a stand-in like `Roster 4`. */
  it('leaves the name null rather than inventing one', () => {
    const read = partnerRead({ rosterId: PARTNER_ROSTER, ownerName: null, profile: null });
    expect(read.name).toBeNull();
  });
});
