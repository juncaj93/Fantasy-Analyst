/**
 * Tony's Pizza Fantasy at the start of a week, rebuilt from the Round 16
 * backtest file (`docs/backtest/round16-data.json`) with no database and no
 * network. For the trade finder's tests (Round 19): the real league's rosters,
 * names, byes, injuries and numbers, priced the way `TradeValueService.prepare`
 * prices them, so a test can ask what the finder says about Alex's real week.
 *
 * The rates follow `scripts/probe-round16-score.ts` (`playerRate`): this
 * week's number as the screens read it, Sleeper's next three weeks, and his
 * league points per game played, through `restOfSeasonBlend` (75/25). Week 10
 * has no stored number yet, so a player's latest earlier projection stands in,
 * as the app's own `recent_week` rung does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { productionGames, restOfSeasonBlend } from '../../src/core/value/restOfSeason.ts';
import { buildRosterShape, type RosterShape } from '../../src/core/sleeper/rosterShape.ts';
import { tradeHorizon, type TradeHorizon } from '../../src/core/tradeValue/weeks.ts';
import { weeklyAvailability } from '../../src/core/tradeValue/availability.ts';
import { replacementLevels, type ReplacementLevels } from '../../src/core/tradeValue/evaluate.ts';
import type { PlayerRate } from '../../src/core/tradeValue/rate.ts';
import type { Designation } from '../../src/core/injury/model.ts';

interface Data {
  meta: { currentWeek: number; lastPlayed: number; myRosterId: number | null; rosterPositions: string[]; settings: Record<string, unknown> };
  players: Record<string, [string, string, string]>;
  actual: Record<string, Record<string, number>>;
  proj: Record<string, Record<string, number>>;
  numbers: Record<string, Record<string, [number, 'm' | 'p']>>;
  played: Record<string, number[]>;
  clubs: Record<string, [number, string][]>;
  byes: Record<string, number[]>;
  injuries: Record<string, Record<string, string>>;
  rosters: Record<string, Record<string, string[]>>;
  starters: Record<string, Record<string, string[]>>;
  transactions: { week: number; type: string; adds: [string, number][]; drops: [string, number][] }[];
}

const FILE = fileURLToPath(new URL('../../docs/backtest/round16-data.json', import.meta.url));
let cached: Data | null = null;
function data(): Data {
  cached ??= JSON.parse(readFileSync(FILE, 'utf8')) as Data;
  return cached;
}

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

export interface Round16Roster {
  rosterId: number;
  label: string;
  isMine: boolean;
  playerIds: string[];
  reserveIds: string[];
  starterIds: string[];
}

export interface Round16League {
  week: number;
  horizon: TradeHorizon;
  shape: RosterShape;
  settings: Record<string, unknown>;
  rosters: Round16Roster[];
  rates: Map<string, PlayerRate>;
  replacement: ReplacementLevels;
  rosterLimit: number;
  /** Completed trades this season before `week`, by roster. */
  tradesBefore: Map<number, number>;
  /** Completed trades with Alex this season before `week`, by roster. */
  tradesWithMe: Map<number, number>;
  nameOf: (id: string) => string;
}

/**
 * The league as the app would have priced it at the start of week `W`
 * (week W's matchup rosters, or week W-1's). Skill positions only: a defence is
 * never a trade piece.
 */
export function round16League(W = 10): Round16League {
  const D = data();
  const settings = D.meta.settings;
  const shape = buildRosterShape(D.meta.rosterPositions);
  const horizon = tradeHorizon({ leagueSettings: settings, currentWeek: W });
  const me = D.meta.myRosterId;

  const posOf = (id: string): string => D.players[id]?.[1] ?? '';
  const nameOf = (id: string): string => D.players[id]?.[0] ?? id;
  const pts = (id: string, w: number): number => D.actual[String(w)]?.[id] ?? 0;
  const playedSet = new Map(Object.entries(D.played).map(([id, ws]) => [id, new Set(ws)]));
  const clubAt = (id: string, w: number): string => {
    const rows = (D.clubs[id] ?? []).filter(([week]) => week <= w).sort((a, b) => b[0] - a[0]);
    return rows[0]?.[1] ?? D.players[id]?.[2] ?? '';
  };
  const byeIn = (id: string, from: number, to: number): number | null => {
    const club = clubAt(id, from - 1 >= 1 ? from - 1 : from);
    return (D.byes[club] ?? []).find((w) => w >= from && w <= to) ?? null;
  };
  const designationAt = (id: string, w: number): Designation => {
    const s = (D.injuries[String(w - 1)]?.[id] ?? '').toLowerCase();
    if (s === 'out') return 'out';
    if (s === 'doubtful') return 'doubtful';
    if (s === 'questionable') return 'questionable';
    return 'healthy';
  };

  const rateOf = (id: string, reserve: ReadonlySet<string>): PlayerRate => {
    const byeWeek = byeIn(id, W, horizon.lastWeek);
    const n = D.numbers[String(W)]?.[id] ?? null;
    let thisWeek: { rate: number | null; fromThisWeek: boolean } = { rate: n ? n[0] : null, fromThisWeek: n != null };
    let borrowed = !n || n[1] === 'p';
    if (!n) {
      for (let w = W - 1; w >= Math.max(1, W - 3); w--) {
        const p = D.proj[String(w)]?.[id];
        if (p != null && p >= 1) {
          thisWeek = { rate: p, fromThisWeek: false };
          break;
        }
      }
      borrowed = true;
    }
    const ahead = new Map<number, number>();
    for (let w = W + 1; w <= W + 3; w++) {
      const p = D.proj[String(w)]?.[id];
      if (p != null) ahead.set(w, p);
    }
    const leaguePoints = Array.from({ length: W - 1 }, (_, i) => pts(id, i + 1));
    const playedWeeks = new Set([...(playedSet.get(id) ?? [])].filter((w) => w < W));
    const production = productionGames({ leaguePoints, through: W - 1, playedWeeks });
    const { blend } = restOfSeasonBlend({ thisWeek, ahead, production, weeks: horizon.weeks, byeWeek, floor: 1 });
    const designation = designationAt(id, W);
    const rate = blend.rate;
    const availability = weeklyAvailability({ designation, onReserve: reserve.has(id), weeks: horizon.weeks, byeWeek, rate });
    return {
      playerId: id,
      name: nameOf(id),
      position: posOf(id),
      team: clubAt(id, W - 1),
      rate,
      basis: borrowed ? 'published' : 'market',
      weekRate: thisWeek.fromThisWeek ? thisWeek.rate : null,
      blend,
      rateNote: null,
      designation,
      games: availability.games,
      weekly: availability.weekly,
      injuryNote: availability.note,
      byeWeek,
      byeKnown: true,
      byeInside: availability.byeInside,
      onReserve: reserve.has(id),
    };
  };

  const active = shape.totalStarters + shape.benchSlots;
  const reserveOf = (roster: readonly string[]): Set<string> => {
    const extra = roster.length - active;
    if (extra <= 0) return new Set();
    const plain = (id: string) => rateOf(id, new Set()).rate ?? 0;
    const out = roster
      .filter((id) => SKILL.has(posOf(id)))
      .sort((a, b) => Number(designationAt(b, W) === 'out') - Number(designationAt(a, W) === 'out') || plain(a) - plain(b));
    return new Set(out.slice(0, extra));
  };

  const rates = new Map<string, PlayerRate>();
  /* Week W's own matchup rosters when the file has them (week 10: as they stood on 10 November), else the week before. */
  const rosterWeek = D.rosters[String(W)] ? W : W - 1;
  const rosterRows = D.rosters[String(rosterWeek)] ?? {};
  const rosters: Round16Roster[] = Object.entries(rosterRows).map(([rid, ids]) => {
    const rosterId = Number(rid);
    const reserve = reserveOf(ids);
    const skill = ids.filter((id) => SKILL.has(posOf(id)));
    for (const id of skill) rates.set(id, rateOf(id, reserve));
    return {
      rosterId,
      label: rosterId === me ? 'Alex' : `Team ${rosterId}`,
      isMine: rosterId === me,
      playerIds: skill,
      reserveIds: [...reserve],
      starterIds: (D.starters[String(rosterWeek)]?.[rid] ?? []).filter((id) => SKILL.has(posOf(id))),
    };
  });

  const rostered = new Set(rosters.flatMap((r) => r.playerIds));
  const freeIds = [...new Set([...Object.keys(D.numbers[String(W)] ?? {}), ...Object.keys(D.proj[String(W - 1)] ?? {})])].filter(
    (id) => SKILL.has(posOf(id)) && !rostered.has(id) && !Object.values(rosterRows).some((ids) => ids.includes(id)),
  );
  const replacement = replacementLevels(freeIds.map((id) => rateOf(id, new Set())));

  const tradesBefore = new Map<number, number>();
  const tradesWithMe = new Map<number, number>();
  for (const t of D.transactions) {
    if (t.type !== 'trade' || t.week >= W) continue;
    const sides = [...new Set(t.adds.map(([, r]) => r))];
    for (const r of sides) tradesBefore.set(r, (tradesBefore.get(r) ?? 0) + 1);
    if (me != null && sides.includes(me)) for (const r of sides) if (r !== me) tradesWithMe.set(r, (tradesWithMe.get(r) ?? 0) + 1);
  }

  const reserveSlots = Math.max(shape.irSlots, Number(settings['reserve_slots'] ?? 0));
  return {
    week: W,
    horizon,
    shape,
    settings,
    rosters,
    rates,
    replacement,
    rosterLimit: active + reserveSlots,
    tradesBefore,
    tradesWithMe,
    nameOf,
  };
}
