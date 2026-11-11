/**
 * The preview league (Round 19): a small league with made-up names, for the
 * preview of the new Trades screens. Never on the live site: it answers only
 * when the Worker is uploaded with `PREVIEW = "trades"`.
 *
 * The same names every time, the same numbers every time, so a screenshot
 * today and one next week show the same players. It runs through the real
 * engines (the trade finder and Check a trade's evaluation), so the screens
 * are the real screens on fake data, with no database read at all.
 *
 * Two weeks to look at: `normal`, where fair offers exist, and `quiet`, where
 * none is fully fair and the closest are shown, labelled.
 *
 * Pure.
 */

import { buildRosterShape } from '../sleeper/rosterShape.ts';
import { tradeHorizon } from '../tradeValue/weeks.ts';
import { weeklyAvailability } from '../tradeValue/availability.ts';
import type { PlayerRate } from '../tradeValue/rate.ts';
import type { ReplacementLevels } from '../tradeValue/evaluate.ts';
import type { Designation } from '../injury/model.ts';
import type { FinderRoster } from './finder.ts';
import type { ActivityClass } from './activity.ts';

export type PreviewWeek = 'normal' | 'quiet';

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SETTINGS = { playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0, trade_deadline: 11, reserve_slots: 2 };

type Row = [id: string, name: string, position: string, team: string, rate: number, bye?: number, designation?: Designation];

/** You: deep at back (one good back on the bench), a weak tight end. */
const YOU: Row[] = [
  ['p01', 'Trey Halloran', 'QB', 'SF', 21.4],
  ['p02', 'Marcus Vance', 'RB', 'KC', 17.8],
  ['p03', 'Silas Mbeki', 'RB', 'GB', 15.2, 12],
  ['p04', 'Wes Okonkwo', 'RB', 'LV', 14.0],
  ['p05', 'Bo Ashworth', 'RB', 'SEA', 13.4, 13],
  ['p12', 'Jory Kessler', 'RB', 'HOU', 12.6, 14],
  ['p06', 'Devin Okafor', 'WR', 'CIN', 16.9],
  ['p07', 'Owen Fitzgerald', 'WR', 'PHI', 13.1, 11],
  ['p08', 'Dane Petrossian', 'WR', 'ARI', 11.2],
  ['p09', 'Kai Brennan', 'WR', 'BUF', 9.4],
  ['p10', 'Teo Ferreira', 'TE', 'HOU', 7.9, 12],
  ['p11', 'Rhys Donnelly', 'QB', 'LAR', 15.0, 14],
];

/** Dermot: two good tight ends, thin at back. Trades often. */
const DERMOT: Row[] = [
  ['p21', 'Emil Draeger', 'QB', 'MIN', 20.6, 13],
  ['p22', 'Julian Reyes', 'RB', 'MIA', 13.4],
  ['p23', 'Hollis Marchetti', 'RB', 'NYJ', 8.6, 12],
  ['p24', 'Cal Whitfield', 'WR', 'NYJ', 15.8],
  ['p25', 'Nico Saldana', 'WR', 'DEN', 14.3, 14],
  ['p26', 'Rafe Lindgren', 'WR', 'NO', 12.7],
  ['p27', 'Ari Castell', 'WR', 'TEN', 10.1],
  ['p28', 'Andre Sotelo', 'TE', 'DAL', 12.8],
  ['p29', 'Miles Barrowman', 'TE', 'CLE', 10.9, 13],
  ['p30', 'Jonah Priestley', 'QB', 'TB', 16.2],
];

/** Kim: deep at receiver, short a starting back. Trades sometimes. */
const KIM: Row[] = [
  ['p41', 'Casey Lindqvist', 'QB', 'DEN', 20.1],
  ['p42', 'Gideon Rauch', 'RB', 'ATL', 14.9, 12],
  ['p43', 'Tobin Achebe', 'RB', 'CAR', 7.8],
  ['p44', 'Lennox Yarrow', 'RB', 'IND', 7.3],
  ['p45', 'Pax Holloway', 'WR', 'LAC', 18.2],
  ['p46', 'Soren Vale', 'WR', 'PIT', 15.6, 13],
  ['p47', 'Idris Kemble', 'WR', 'JAX', 14.8],
  ['p48', 'Ruben Castellanos', 'WR', 'PIT', 13.9, 11],
  ['p49', 'Grant Aldous', 'TE', 'WAS', 9.6],
];

/** Sam: a new manager with an even roster. Nothing on record yet. */
const SAM: Row[] = [
  ['p61', 'Beau Lockhart', 'QB', 'BAL', 22.3, 14],
  ['p62', 'Quill Ferraro', 'RB', 'DET', 16.1],
  ['p63', 'Dex Morrow', 'RB', 'CHI', 10.4],
  ['p64', 'Harlan Brisco', 'WR', 'NE', 14.1],
  ['p65', 'Ezra Quintero', 'WR', 'SEA', 12.2],
  ['p66', 'Milo Strand', 'WR', 'NYG', 9.9, 11],
  ['p67', 'Nate Kowalski', 'TE', 'DET', 11.4, 12, 'questionable'],
];

/** Free agents: who you could pick up instead. They set the replacement level. */
const FREE: Row[] = [
  ['f01', 'Colt Ambrose', 'QB', 'NO', 15.1],
  ['f02', 'Ivo Brandt', 'RB', 'NYG', 7.1],
  ['f03', 'Lars Penhall', 'WR', 'CLE', 7.6],
  ['f04', 'Rocco Bianchi', 'TE', 'MIA', 6.2],
];

const TEAMS: { rosterId: number; label: string; isMine: boolean; rows: Row[]; activity: ActivityClass; trades: number; withYou: number }[] = [
  { rosterId: 1, label: 'You', isMine: true, rows: YOU, activity: 'active', trades: 4, withYou: 0 },
  { rosterId: 2, label: 'Dermot', isMine: false, rows: DERMOT, activity: 'active', trades: 6, withYou: 2 },
  { rosterId: 3, label: 'Kim', isMine: false, rows: KIM, activity: 'selective', trades: 3, withYou: 0 },
  { rosterId: 4, label: 'Sam', isMine: false, rows: SAM, activity: 'unknown', trades: 0, withYou: 0 },
];

const ACTIVITY_LINE: Record<ActivityClass, (n: number) => string> = {
  active: (n) => `Has made ${n} trades this season`,
  selective: (n) => `Has made ${n} trades this season`,
  unknown: () => 'No trades this season',
  low_activity: () => 'Trades seldom',
  effectively_inactive: () => 'No trades on record',
};

export interface PreviewLeague {
  league: { id: string; name: string };
  horizon: ReturnType<typeof tradeHorizon>;
  shape: ReturnType<typeof buildRosterShape>;
  replacement: ReplacementLevels;
  rates: Map<string, PlayerRate>;
  rosters: (FinderRoster & { reserveIds: string[] })[];
  rosterLimit: number;
}

/**
 * The preview league for a week. `quiet` takes Dermot's second tight end and
 * your spare back off the market (traded elsewhere, say), which leaves no deal
 * fully fair, so the screens show the closest, labelled.
 */
export function previewLeague(week: PreviewWeek = 'normal'): PreviewLeague {
  const horizon = tradeHorizon({ leagueSettings: SETTINGS, currentWeek: 10 });
  const shape = buildRosterShape(POSITIONS);
  const rates = new Map<string, PlayerRate>();
  const rateOf = ([id, name, position, team, rate, bye, designation]: Row): PlayerRate => {
    const d: Designation = designation ?? 'healthy';
    const availability = weeklyAvailability({ designation: d, onReserve: false, weeks: horizon.weeks, byeWeek: bye ?? null, rate });
    return {
      playerId: id,
      name,
      position,
      team,
      rate,
      basis: 'market',
      weekRate: bye === horizon.currentWeek ? null : rate,
      blend: { rate, projection: rate, projectionWeeks: 4, production: rate, games: 9, productionShare: 0.25 },
      rateNote: null,
      designation: d,
      games: availability.games,
      weekly: availability.weekly,
      injuryNote: availability.note,
      byeWeek: bye ?? null,
      byeKnown: true,
      byeInside: availability.byeInside,
      onReserve: false,
    };
  };
  const removed = week === 'quiet' ? new Set(['p29', 'p12']) : new Set<string>();
  const rosters = TEAMS.map((t) => {
    const rows = t.rows.filter((r) => !removed.has(r[0]));
    for (const r of rows) rates.set(r[0], rateOf(r));
    return {
      rosterId: t.rosterId,
      label: t.label,
      isMine: t.isMine,
      playerIds: rows.map((r) => r[0]),
      starterIds: [],
      reserveIds: [],
      activity: { class: t.activity, thisSeason: t.trades, withYou: t.withYou, line: ACTIVITY_LINE[t.activity](t.trades) },
    };
  });
  const replacement: ReplacementLevels = new Map();
  for (const r of FREE) replacement.set(r[2], { rate: r[4], names: [r[1]], sample: 3 });
  return {
    league: { id: 'preview-league', name: 'Preview League' },
    horizon,
    shape,
    replacement,
    rates,
    rosters,
    rosterLimit: shape.totalStarters + shape.benchSlots + 2,
  };
}

/** Every made-up name the preview uses, for a test that holds the set fixed. */
export const PREVIEW_NAMES: readonly string[] = [...YOU, ...DERMOT, ...KIM, ...SAM, ...FREE].map((r) => r[1]);
