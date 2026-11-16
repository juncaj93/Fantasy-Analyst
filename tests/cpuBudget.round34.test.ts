/**
 * Round 34: CPU a read spends, cut without changing what it answers.
 *
 * The free plan caps a request's CPU, and the production check (round 29,
 * finding 8) had Players cards, Data health, trade checks and two support
 * snapshots refused with "exceeded resource limits". Measured on a
 * week-10-shaped store, the work that did not need doing was:
 *
 *   - the newest lines and the lines at the previous look, read as two calls
 *     over the same rows, on every start/sit assembly (cards, Trades, Waivers,
 *     Team, the board);
 *   - a regular expression built per string per identifier when a support
 *     snapshot scrubs its ids (most of a waiver-plan snapshot's CPU);
 *   - two JSON columns parsed for every player in the remembered player list
 *     on every read of it;
 *   - an `Intl.DateTimeFormat` built on every call of the app-week and
 *     waiver-clock helpers;
 *   - each roster's value before a deal re-solved for every deal the trade
 *     finder checks, and a copy of a position list per week per deal.
 *
 * Each test counts the work (statements, patterns, parses, formatters,
 * solves), so it fails on the code before this round, and checks the answer is
 * the one the old way gave.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { countingDb } from './helpers/countingDb.ts';
import { player } from './helpers/players.ts';
import { round16League } from './helpers/round16League.ts';
import type { Database } from '../src/server/db.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { PlayerRepo, forgetPlayerReads } from '../src/server/repos/players.ts';
import { slateWindow } from '../src/core/nfl/slateWindow.ts';
import { startSitInputsFor } from '../src/server/services/startSitInputs.ts';
import { SnapshotAliases, findRedactionViolations } from '../src/core/support/redaction.ts';
import { findLossyValues } from '../src/core/support/lossless.ts';
import { rolloverAt } from '../src/core/season/appWeek.ts';
import { nextWaiverRun } from '../src/core/waivers/clearWindow.ts';
import { evaluateTrade, rosterValueMemo, type TradeSide } from '../src/core/tradeValue/evaluate.ts';
import { fastLineups } from '../src/core/trades/finder.ts';
import { bestLineup, slotsOf, type LineupCandidate } from '../src/core/tradeValue/lineup.ts';

const H = 3_600_000;
const NOW = new Date('2026-11-14T17:00:00.000Z');
const KICKOFF = '2026-11-15T18:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One game with a full look and two change-only looks; `g-p3` has every line pulled at the newest. */
async function gameWithLooks(db: Database): Promise<string[]> {
  const ids = Array.from({ length: 6 }, (_, k) => `g-p${k}`);
  await new PlayerRepo(db).upsertMany(ids.map((id, k) => player({ id, fullName: `Game Player ${k}`, team: k < 3 ? 'KC' : 'BUF', position: k % 2 ? 'WR' : 'RB' })));
  const markets = ['receiving_yards', 'receptions'];
  for (let look = 0; look < 3; look++) {
    const at = new Date(Date.parse(KICKOFF) - (3 - look) * 6 * H).toISOString();
    const raw = look === 0 ? '{"gameLines":{"total":47.5,"spread":-3.5,"spreadTeam":"KC"}}' : '{"delta":true,"gameLines":{"total":48.5,"spread":-3,"spreadTeam":"KC"}}';
    const snap = await db
      .prepare(`INSERT INTO prop_snapshots (provider, event_id, game_start, fetched_at, raw_json, scope) VALUES ('sgo','g1',?,?,?,'week') RETURNING id`)
      .bind(KICKOFF, at, raw)
      .first<{ id: number }>();
    for (const [k, id] of ids.entries()) {
      for (const market of markets) {
        if (look > 0 && (k + look) % 2 === 0 && id !== 'g-p3') continue;
        const gone = look === 2 && id === 'g-p3';
        await db
          .prepare(
            `INSERT INTO player_props (snapshot_id, player_id, source_player_name, market, line, over_price, under_price, book_count, books_json, consensus_method, scope)
             VALUES (?,?,?,?,?,-110,-110,2,?,?,'week')`,
          )
          .bind(snap!.id, id, id.toUpperCase(), market, gone ? null : 40 + k + look, '[{"book":"dk","line":41,"price":-110,"at":"2026-11-14T00:00:00Z"}]', gone ? 'none' : 'average')
          .run();
      }
    }
  }
  return ids;
}

describe('Round 34: one read of the lines per assembly', () => {
  it('a start/sit assembly reads the lines and the looks once, not once for the newest and again for the previous', async () => {
    const db = await createTestDb();
    const ids = await gameWithLooks(db);
    const counted = countingDb(db);
    const inputs = await startSitInputsFor(counted.db, ids, { now: NOW });

    expect(inputs.length).toBe(ids.length);
    expect(counted.callsMatching('SELECT pp.*, ps.event_id AS snapshot_event_id FROM player_props pp'), 'the lines, read once for both looks').toBe(1);
    expect(counted.callsMatching("FROM prop_snapshots WHERE scope = 'week' AND game_start >= ?"), 'the slate’s looks, read once').toBe(1);
    expect(inputs.some((i) => (i.previousProps?.length ?? 0) > 0), 'the previous look still reaches the inputs').toBe(true);
    expect(inputs.find((i) => i.player.id === 'g-p3')?.propsPulledAt, 'and so does a pulled player').toBeTruthy();
  });

  it('answers exactly what the two reads answered', async () => {
    const db = await createTestDb();
    const ids = await gameWithLooks(db);
    const repo = new PropsRepo(db);
    const window = slateWindow(NOW);
    const both = await repo.latestAndPrevious(ids, window);
    const latest = await repo.latestWithPulled(ids, window);
    const previous = await repo.previousForPlayers(ids, window);
    const plain = (m: Map<string, unknown>) => JSON.stringify([...m.entries()]);

    expect(plain(both.lines)).toBe(plain(latest.lines));
    expect(plain(both.pulled)).toBe(plain(latest.pulled));
    expect(plain(both.previous)).toBe(plain(previous));
    expect(both.lines.size).toBeGreaterThan(0);
    expect(both.previous.size).toBeGreaterThan(0);
    expect(both.pulled.get('g-p3')).toBeTruthy();
    expect(await repo.latestAndPrevious([], window)).toEqual({ lines: new Map(), pulled: new Map(), previous: new Map() });
  });
});

describe('Round 34: the support snapshot scrub', () => {
  /** The scrub as it was before: a fresh bounded pattern for every identifier, every string. */
  function scrubTheOldWay(text: string, sources: ReadonlyMap<string, string>[]): string {
    let out = text;
    for (const source of sources) {
      for (const [real, alias] of source) {
        const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const before = /^[\p{L}\p{N}_]/u.test(real) ? '(?<![\\p{L}\\p{N}_])' : '';
        const after = /[\p{L}\p{N}_]$/u.test(real) ? '(?![\\p{L}\\p{N}_])' : '';
        out = out.replace(new RegExp(`${before}${escaped}${after}`, 'gu'), alias);
      }
    }
    return out;
  }

  function countPatterns(): { count: () => number } {
    let built = 0;
    const Real = RegExp;
    vi.spyOn(globalThis, 'RegExp').mockImplementation(function (this: unknown, ...args: unknown[]) {
      built++;
      return new Real(...(args as [string, string]));
    } as unknown as RegExpConstructor);
    return { count: () => built };
  }

  it('builds a pattern per identifier, not per string, and replaces exactly what it did', () => {
    const aliases = new SnapshotAliases();
    aliases.id('734512998812345678');
    aliases.id('(commish)');
    aliases.scope('league', '1180000000000000000');
    aliases.label('Tony’s Pizza Fantasy', 'league-1');
    const texts = [
      ...Array.from({ length: 300 }, (_, i) => `Week ${i % 18}: start Player ${i}, 12.${i % 10} pts`),
      'slot 4 (734512998812345678): RB demand x1.2',
      'fingerprint 1180000000000000000|10|abc',
      'x734512998812345678 is a longer word and stays',
      'Tony’s Pizza Fantasy standings, $& and $1 stay literal',
      '(commish) traded with (commish)',
    ];
    const expected = texts.map((t) =>
      scrubTheOldWay(t, [
        new Map([['734512998812345678', 'manager-1'], ['(commish)', 'manager-2']]),
        new Map([['1180000000000000000', 'league-1']]),
        new Map([['Tony’s Pizza Fantasy', 'league-1']]),
      ]),
    );

    const patterns = countPatterns();
    const got = texts.map((t) => aliases.scrubIdentifiers(t));
    expect(got).toEqual(expected);
    expect(got.at(-5)).toBe('slot 4 (manager-1): RB demand x1.2');
    expect(patterns.count(), 'one per identifier at most, against 305 strings').toBeLessThanOrEqual(4);
  });

  it('reports the same paths it always did', () => {
    const value = {
      decision: {
        rows: [{ note: 'mail me at a@b.co' }, { headers: { cookie: 'x' } }],
        Map: new Map([[1, 2]]),
        top: Number.POSITIVE_INFINITY,
      },
      '734512998812345678': ['keyed'],
      list: [['nested', 'id 734512998812345678 here']],
    };
    expect(findRedactionViolations(value)).toEqual([
      { path: 'decision.rows[0].note', reason: 'looks like an email address' },
      { path: 'decision.rows[1].headers', reason: '`headers` is a forbidden field in a support snapshot' },
      { path: 'decision.rows[1].headers.cookie', reason: '`cookie` is a forbidden field in a support snapshot' },
    ]);
    expect(findRedactionViolations({ a: 'x@y.org' }, 'root')).toEqual([{ path: 'root.a', reason: 'looks like an email address' }]);
    expect(findLossyValues(value)).toEqual([
      { path: 'decision.Map', kind: 'Map' },
      { path: 'decision.top', kind: 'Infinity' },
    ]);
    const aliases = new SnapshotAliases();
    aliases.id('734512998812345678');
    expect(aliases.leaks(value)).toEqual([
      { path: '734512998812345678', reason: 'is keyed by a real Sleeper id' },
      { path: 'list[0][1]', reason: 'carries a real Sleeper id the snapshot aliased everywhere else' },
    ]);
  });
});

describe('Round 34: the remembered player list', () => {
  it('parses each row’s JSON once, and still hands every caller its own objects', async () => {
    const db = await createTestDb();
    const players = Array.from({ length: 40 }, (_, i) =>
      player({ id: `lp${i}`, fullName: `List Player ${i}`, team: 'KC', position: 'WR', aliases: [`LP${i}`], externalIds: { gsis: `00-${i}` } }),
    );
    await new PlayerRepo(db).upsertMany(players);
    forgetPlayerReads(db);
    const repo = new PlayerRepo(db);
    const first = await repo.listAll();

    const parse = vi.spyOn(JSON, 'parse');
    const second = await repo.listAll();
    const rowParses = parse.mock.calls.filter(([text]) => typeof text === 'string' && (text.includes('LP') || text.includes('gsis'))).length;
    expect(rowParses, 'the rows’ alias and id columns, parsed on the first read only').toBe(0);
    parse.mockRestore();

    expect(second).toEqual(first);
    const one = first.find((p) => p.id === 'lp7')!;
    expect(one.aliases).toContain('LP7');
    expect(one.externalIds).toEqual({ gsis: '00-7' });
    one.aliases.push('changed');
    one.externalIds!['gsis'] = 'changed';
    const third = (await repo.listAll()).find((p) => p.id === 'lp7')!;
    expect(third.aliases).not.toContain('changed');
    expect(third.externalIds).toEqual({ gsis: '00-7' });
    expect(third.aliases).not.toBe(second.find((p) => p.id === 'lp7')!.aliases);
  });
});

describe('Round 34: the clock helpers', () => {
  function countFormatters(): { count: () => number } {
    let built = 0;
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built++;
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    return { count: () => built };
  }

  it('the app week builds its Eastern formatter once, not per call', () => {
    const formatters = countFormatters();
    const kickoffs = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, 15 + i, 0, 15)).toISOString());
    const rolls = kickoffs.map((lastKickoff) => rolloverAt({ sleeperWeek: 10, seasonType: 'regular', lastKickoff }));
    expect(formatters.count()).toBeLessThanOrEqual(1);
    // Monday night 16 November 2026 (EST): the app rolls at 3 AM Eastern the next day, 08:00 UTC.
    expect(rolloverAt({ sleeperWeek: 10, seasonType: 'regular', lastKickoff: '2026-11-17T01:15:00.000Z' })).toBe(Date.parse('2026-11-17T08:00:00.000Z'));
    // Thursday 17 September 2026 (EDT): the following Tuesday, 3 AM Eastern is 07:00 UTC.
    expect(rolls[2]).toBe(Date.parse('2026-09-22T07:00:00.000Z'));
  });

  it('the waiver clock builds its Pacific formatter once, not per call', () => {
    const formatters = countFormatters();
    const runs = Array.from({ length: 30 }, (_, i) => nextWaiverRun(new Date(Date.UTC(2026, 9, 1 + i, 12)), { runDay: 2 }));
    expect(formatters.count()).toBeLessThanOrEqual(1);
    // Wednesday midnight Pacific: 07:00 UTC in October (PDT), 08:00 UTC after 1 November (PST).
    expect(runs[0]!.toISOString()).toBe('2026-10-07T07:00:00.000Z');
    expect(runs[29]!.toISOString()).toBe('2026-11-04T08:00:00.000Z');
  });
});

describe('Round 34: the trade finder’s checks', () => {
  const L = round16League(10);
  const side = (rosterId: number): TradeSide => {
    const r = L.rosters.find((x) => x.rosterId === rosterId)!;
    return { label: r.label, rosterId, isMine: r.isMine, roster: r.playerIds.map((id) => L.rates.get(id)!).filter(Boolean), starterIds: r.starterIds };
  };
  const mine = L.rosters.find((r) => r.isMine)!;
  const deals = L.rosters
    .filter((r) => !r.isMine)
    .slice(0, 4)
    .flatMap((r) =>
      [0, 1].map((i) => ({
        b: r.rosterId,
        give: [mine.playerIds.filter((id) => L.rates.get(id)?.rate != null)[i + 2]!],
        get: [r.playerIds.filter((id) => L.rates.get(id)?.rate != null)[i + 1]!],
      })),
    );

  it('solve each roster before a deal once, with the same evaluation as solving it every time', () => {
    const memo = rosterValueMemo();
    for (const deal of deals) {
      const input = { horizon: L.horizon, shape: L.shape, replacement: L.replacement, a: side(mine.rosterId), b: side(deal.b), rosterLimit: L.rosterLimit, aSends: deal.give, bSends: deal.get };
      const fresh = evaluateTrade(input);
      const kept = evaluateTrade({ ...input, memo });
      expect(JSON.stringify(kept)).toBe(JSON.stringify(fresh));
    }
    expect(memo.held.size, 'Alex and the four partners, one solve each').toBe(5);
  });

  it('a memo never answers for a roster that has changed', () => {
    const memo = rosterValueMemo();
    const deal = deals[0]!;
    const input = { horizon: L.horizon, shape: L.shape, replacement: L.replacement, a: side(mine.rosterId), b: side(deal.b), rosterLimit: L.rosterLimit, aSends: deal.give, bSends: deal.get };
    evaluateTrade({ ...input, memo });
    const dropped = input.a.roster.find((p) => !deal.give.includes(p.playerId))!;
    const smaller = { ...input.a, roster: input.a.roster.filter((p) => p !== dropped) };
    const fresh = evaluateTrade({ ...input, a: smaller });
    expect(JSON.stringify(evaluateTrade({ ...input, a: smaller, memo }))).toBe(JSON.stringify(fresh));
  });

  it('the fast lineup’s totals are bit for bit what the copy-and-splice version gave', () => {
    const slots = slotsOf(L.shape);
    const fills: LineupCandidate[] = [];
    for (const [position, level] of L.replacement) {
      const n = slots.filter((s) => s.eligible.has(position)).length;
      for (let i = 0; i < n; i++) fills.push({ id: `r:${position}:${i}`, position, value: level.rate });
    }
    const weeks = L.horizon.weeks.length;
    const fast = fastLineups({ slots, fills, rates: L.rates, weeks })!;

    /* The version before Round 34, on the same week bases. */
    const flexSlots = slots.filter((s) => s.eligible.size > 1);
    const fixed = new Map<string, number>();
    for (const s of slots) if (s.eligible.size === 1) fixed.set([...s.eligible][0]!, (fixed.get([...s.eligible][0]!) ?? 0) + 1);
    const flexEligible = flexSlots[0]?.eligible ?? new Set<string>();
    const flexCount = flexSlots.length;
    const valuesOf = (id: string) => {
      const r = L.rates.get(id);
      return !r || r.rate == null ? null : { position: r.position, values: Array.from({ length: weeks }, (_, w) => Math.max(0, r.rate! * (r.weekly[w] ?? 1))) };
    };
    const oldTotals = (base: ReturnType<typeof fast.base>, out: string[], inn: string[]): number[] => {
      const outs = out.map(valuesOf).filter((x): x is NonNullable<typeof x> => x != null);
      const ins = inn.map(valuesOf).filter((x): x is NonNullable<typeof x> => x != null);
      const touched: string[] = [];
      for (const x of [...outs, ...ins]) if (!touched.includes(x.position)) touched.push(x.position);
      return base.map((week, w) => {
        const best: number[] = [];
        const offer = (v: number) => {
          best.push(v);
          best.sort((a, b) => b - a);
          if (best.length > flexCount) best.length = flexCount;
        };
        let total = week.fixedTotal;
        const offered: number[] = [];
        for (const position of week.positions) if (!touched.includes(position)) offered.push(...week.left.get(position)!);
        for (const position of touched) {
          const list = (week.lists.get(position) ?? []).slice();
          for (const o of outs) {
            if (o.position !== position) continue;
            const at = list.indexOf(o.values[w]!);
            if (at >= 0) list.splice(at, 1);
          }
          for (const x of ins) {
            if (x.position !== position) continue;
            const v = x.values[w]!;
            let i = list.length;
            list.push(v);
            while (i > 0 && list[i - 1]! < v) {
              list[i] = list[i - 1]!;
              i--;
            }
            list[i] = v;
          }
          const n = fixed.get(position) ?? 0;
          let sum = 0;
          for (let i = 0; i < Math.min(n, list.length); i++) sum += list[i]!;
          total += sum - (week.fixedSum.get(position) ?? 0);
          if (flexEligible.has(position)) for (let i = n; i < Math.min(list.length, n + flexCount); i++) offered.push(list[i]!);
        }
        for (const v of offered) offer(v);
        for (const v of best) total += v;
        return total;
      });
    };

    let compared = 0;
    for (const a of L.rosters) {
      const base = fast.base(a.playerIds);
      for (const b of L.rosters) {
        if (a === b) continue;
        for (let i = 0; i < 4; i++) {
          const out = [a.playerIds[i]!, a.playerIds[(i + 5) % a.playerIds.length]!].slice(0, 1 + (i % 2));
          const inn = [b.playerIds[i]!, b.playerIds[(i + 3) % b.playerIds.length]!].slice(0, 1 + ((i + 1) % 2));
          expect(fast.totals(base, out, inn)).toEqual(oldTotals(base, out, inn));
          compared++;
        }
      }
      expect(fast.totals(base)).toEqual(oldTotals(base, [], []));
    }
    expect(compared).toBeGreaterThan(100);
    // And still the exact lineup, as `trades.finder.test.ts` checks.
    const a = L.rosters[0]!;
    const exact = bestLineup(slots, [...a.playerIds.map((id) => L.rates.get(id)!).filter((r) => r.rate != null).map((r) => ({ id: r.playerId, position: r.position, value: r.rate! * (r.weekly[0] ?? 1) })), ...fills]).total;
    expect(fast.totals(fast.base(a.playerIds))[0]).toBeCloseTo(exact, 6);
  });
});
