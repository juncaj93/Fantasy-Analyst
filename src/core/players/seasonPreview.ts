/**
 * The in-season Players tab on the made-up preview league (Round 24). Never on
 * the live site: it answers only when the Worker is uploaded with
 * `PREVIEW = "players"`.
 *
 * The same names as the Trades preview (`core/trades/previewLeague.ts`), and
 * no new ones. Three of them are marked hurt so the Injured filter has
 * something to show. Every number runs through the same functions the live
 * board uses; only the draft numbers, the 7-day and 30-day moves and the past
 * games are made up, the same every time.
 *
 * Pure. No database.
 */

import type { Designation } from '../injury/model.ts';
import type { PlayerRate } from '../tradeValue/rate.ts';
import { weeklyAvailability } from '../tradeValue/availability.ts';
import { previewLeague } from '../trades/previewLeague.ts';
import { injuryRead, lastGames, nextWeeks, seasonValue, tradeTargets, type BoardRoster } from './inseason.ts';
import type { SeasonBoard, SeasonCard, SeasonRow } from './seasonWire.ts';

/** Who is hurt in the preview, by existing preview id. */
const HURT: Record<string, Designation> = {
  p10: 'doubtful', // Teo Ferreira, yours
  p23: 'ir', // Hollis Marchetti, Dermot's
  p43: 'out', // Tobin Achebe, Kim's
};

const TEAM_WORD: Partial<Record<Designation, string>> = { doubtful: 'Doubtful', ir: 'IR', out: 'Out', questionable: 'Questionable' };

/** A small fixed number from an id, so the made-up numbers never change. */
function fixed(id: string, spread: number): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return (h % (2 * spread + 1)) - spread;
}

function pickLabel(index: number, teams: number): string {
  return `${Math.floor(index / teams) + 1}.${String((index % teams) + 1).padStart(2, '0')}`;
}

interface PreviewData {
  board: SeasonBoard;
  rates: Map<string, PlayerRate>;
  weeks: number[];
}

function build(): PreviewData {
  const L = previewLeague('normal');
  const rates = new Map<string, PlayerRate>();
  for (const [id, rate] of L.rates) {
    const designation = HURT[id];
    if (!designation) {
      rates.set(id, rate);
      continue;
    }
    const availability = weeklyAvailability({ designation, weeks: L.horizon.weeks, byeWeek: rate.byeWeek, rate: rate.rate });
    rates.set(id, { ...rate, designation, weekly: availability.weekly, games: availability.games, injuryNote: availability.note, weekRate: null });
  }
  /* The free agents the preview league prices its replacement level on, as free agents on the list. */
  for (const [position, level] of L.replacement) {
    const name = level.names[0];
    if (!name) continue;
    const id = `f-${position.toLowerCase()}`;
    const availability = weeklyAvailability({ designation: 'healthy', weeks: L.horizon.weeks, byeWeek: null, rate: level.rate });
    rates.set(id, {
      playerId: id,
      name,
      position,
      team: '',
      rate: level.rate,
      basis: 'published',
      weekRate: level.rate,
      blend: { rate: level.rate, projection: level.rate, projectionWeeks: 4, production: level.rate, games: 9, productionShare: 0.25 },
      rateNote: null,
      designation: 'healthy',
      games: availability.games,
      weekly: availability.weekly,
      injuryNote: null,
      byeWeek: null,
      byeKnown: true,
      byeInside: false,
      onReserve: false,
    });
  }

  const rosters: BoardRoster[] = L.rosters.map((r) => ({
    rosterId: r.rosterId,
    isMine: r.isMine,
    playerIds: r.playerIds,
    activity: r.activity?.class ?? 'unknown',
    tradedWithYou: r.activity?.withYou ?? 0,
  }));
  const owner = new Map<string, number>();
  for (const r of rosters) for (const id of r.playerIds) owner.set(id, r.rosterId);
  const targets = tradeTargets({ horizon: L.horizon, shape: L.shape, rates, rosters });

  const ordered = [...rates.values()].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || a.name.localeCompare(b.name));
  const rows: SeasonRow[] = ordered.map((rate, i) => ({
    id: rate.playerId,
    name: rate.name,
    position: rate.position,
    team: rate.team,
    status: TEAM_WORD[rate.designation] ?? null,
    ownerRosterId: owner.get(rate.playerId) ?? null,
    value: seasonValue(rate, L.horizon),
    injury: injuryRead(rate, L.horizon),
    trade: targets.get(rate.playerId) ?? null,
    draftRank: i + 1,
    adjustedRank: i + 1,
    draftPick: owner.has(rate.playerId) ? pickLabel(i, L.rosters.length) : null,
    last7: fixed(rate.playerId, 2),
    last30: fixed(`${rate.playerId}.30`, 4),
    lifetime: fixed(`${rate.playerId}.life`, 6),
  }));
  rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.name.localeCompare(b.name));

  return {
    rates,
    weeks: L.horizon.weeks,
    board: {
      league: L.league,
      week: L.horizon.currentWeek,
      tradeOpen: !L.horizon.deadlinePassed,
      teams: L.rosters.map((r) => ({ rosterId: r.rosterId, ownerName: r.label, isMine: r.isMine })),
      rows,
    },
  };
}

/** The preview board. */
export function previewSeasonBoard(): SeasonBoard {
  return build().board;
}

/** One preview player's card, or null for an id the preview does not have. */
export function previewSeasonCard(playerId: string): SeasonCard | null {
  const { rates, weeks } = build();
  const rate = rates.get(playerId);
  if (!rate) return null;
  const out = HURT[playerId] != null && HURT[playerId] !== 'questionable';
  const thisWeek = { points: out || rate.weekRate == null ? null : Math.round(rate.weekRate * 10) / 10, sleeper: rate.basis === 'published', out };
  const ahead = new Map<number, number>();
  weeks.slice(1).forEach((week, i) => {
    if ((rate.weekly[i + 1] ?? 0) > 0 && rate.rate != null) ahead.set(week, rate.rate + fixed(`${playerId}.${week}`, 2) / 2);
  });
  const first = weeks[0] ?? 1;
  const base = rate.blend?.production ?? rate.rate ?? 0;
  const pattern = [3.1, -4.2, 1.4, -0.8, 2.6, -1.9, 0.7];
  const points = Array.from({ length: first - 1 }, (_, i) => (i + 1 === rate.byeWeek ? 0 : Math.max(0, base + pattern[i % pattern.length]!)));
  return {
    playerId,
    week: first,
    thisWeek,
    next: nextWeeks({ weeks, byeWeek: rate.byeWeek, thisWeek, ahead }),
    last: lastGames({ leaguePoints: points, through: first - 1, playedWeeks: new Set() }),
  };
}
