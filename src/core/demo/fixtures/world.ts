/**
 * The world every scenario is played in.
 *
 * One league, one set of managers, one player universe. Scenarios differ in
 * *when* they are and what has happened, not in who exists — which is what lets
 * a reader step from a draft to the morning after to a Tuesday waiver run and
 * recognise the same team.
 *
 * Every name here is invented. Nothing in this file corresponds to a real
 * player, a real manager or a real league, and nothing in it is ever written
 * anywhere: fixtures are read into memory, used, and discarded.
 *
 * The headline players are hand-written, because the interesting cases are the
 * point — a receiver the market loves and the ledger does not, a back whose
 * role is rising while his touchdowns dry up, a tight end nobody has priced.
 * The depth behind them is generated from an index, deterministically, because
 * a hundred and forty names typed out by hand would make this file unreadable
 * without making any scenario better.
 */

import type { DemoPlayerSpec, DemoPosition } from './spec.ts';

export const DEMO_LEAGUE_ID = 'demo-league-2026';
export const DEMO_DRAFT_ID = 'demo-draft-2026';
export const DEMO_SEASON = '2026';

/** Half PPR, one quarterback, a single W/R/T flex. The ordinary shape. */
export const DEMO_SCORING: Record<string, number> = {
  rec: 0.5,
  rec_yd: 0.1,
  rush_yd: 0.1,
  pass_yd: 0.04,
  pass_td: 4,
  rush_td: 6,
  rec_td: 6,
  pass_int: -1,
  fum_lost: -2,
};

export const DEMO_ROSTER_POSITIONS = [
  'QB',
  'RB',
  'RB',
  'WR',
  'WR',
  'WR',
  'TE',
  'FLEX',
  'BN',
  'BN',
  'BN',
  'BN',
  'BN',
  'BN',
  'IR',
];

/** `waiver_type: 2` is FAAB; the budget is what the pricing engine reads. */
export const DEMO_LEAGUE_SETTINGS: Record<string, unknown> = {
  waiver_type: 2,
  waiver_budget: 100,
  type: 0,
  playoff_week_start: 15,
  num_teams: 12,
};

/**
 * The room.
 *
 * Twelve managers with names, because a draft board of `Team 4` columns tells a
 * reader nothing about the room they are drafting against, and half of what the
 * trade and waiver features say is about specific people.
 */
export const DEMO_MANAGERS: { rosterId: number; slot: number; name: string; isMine: boolean }[] = [
  { rosterId: 1, slot: 1, name: 'Priya', isMine: false },
  { rosterId: 2, slot: 2, name: 'Dermot', isMine: false },
  { rosterId: 3, slot: 3, name: 'The Nurse', isMine: false },
  { rosterId: 4, slot: 4, name: 'Kofi', isMine: false },
  { rosterId: 5, slot: 5, name: 'Hanna', isMine: false },
  { rosterId: 6, slot: 6, name: 'Rui', isMine: false },
  { rosterId: 7, slot: 7, name: 'Marchetti', isMine: false },
  { rosterId: 8, slot: 8, name: 'Bex', isMine: false },
  { rosterId: 9, slot: 9, name: 'You', isMine: true },
  { rosterId: 10, slot: 10, name: 'Ola', isMine: false },
  { rosterId: 11, slot: 11, name: 'Tomasz', isMine: false },
  { rosterId: 12, slot: 12, name: 'Sunday Scaries', isMine: false },
];

export const MY_ROSTER_ID = 9;
export const MY_DRAFT_SLOT = 9;

const TEAMS = [
  'KC', 'BUF', 'CIN', 'SF', 'PHI', 'DAL', 'MIA', 'DET', 'BAL', 'GB',
  'LAR', 'HOU', 'MIN', 'SEA', 'NYJ', 'ATL', 'CHI', 'TB', 'PIT', 'CLE',
  'IND', 'JAX', 'LAC', 'DEN', 'NO', 'ARI', 'WAS', 'TEN', 'NE', 'NYG',
  'LV', 'CAR',
];

/**
 * The players a scenario is actually about.
 *
 * Written top-down in draft order, with the tensions §9 asks for placed
 * deliberately rather than sprinkled:
 *
 *   - **market/ledger disagreement** — `Roshan Villiers` is the fourth pick off
 *     the board and the newsletter has been negative about him all summer;
 *     `Emeka Falade` is the reverse.
 *   - **scarcity** — the tight ends fall off a cliff after four, which is what
 *     makes a tier warning mean something.
 *   - **conflicting evidence** — `Silas Brandt` carries a large mixed count, so
 *     his tally is flagged conflicted rather than confident.
 *   - **missing data** — several backs and every defence have no season market
 *     at all, and the last twenty players have no ADP, so `unknown` is on
 *     screen in its own right rather than as an error.
 */
const HEADLINE: DemoPlayerSpec[] = [
  // ------------------------------------------------------------------ tier 1
  { id: 'p001', name: 'Marcus Vance', position: 'RB', team: 'KC', adp: 1.6, dogAdp: 1.4, searchRank: 1,
    news: { net: 6, items: 11, net30: 3, net7: 1 },
    seasonMarkets: [
      { market: 'season_rush_yards', line: 1285 },
      { market: 'season_receptions', line: 54 },
      { market: 'season_rush_tds', line: 11.5 },
    ] },
  { id: 'p002', name: 'Devin Okafor', position: 'WR', team: 'CIN', adp: 2.8, dogAdp: 3.6, searchRank: 2,
    news: { net: 5, items: 9, net30: 2 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 1340 },
      { market: 'season_receptions', line: 98 },
      { market: 'season_receiving_tds', line: 8.5 },
    ] },
  { id: 'p003', name: 'Kai Brennan', position: 'WR', team: 'BUF', adp: 3.4, dogAdp: 2.9, searchRank: 3,
    news: { net: 3, items: 7 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 1210 },
      { market: 'season_receptions', line: 92 },
      { market: 'season_receiving_tds', line: 7.5 },
    ] },
  /* The market's fourth-best player, and the ledger has hated him since July. */
  { id: 'p004', name: 'Roshan Villiers', position: 'RB', team: 'PHI', adp: 4.9, dogAdp: 9.8, searchRank: 5,
    news: { net: -7, items: 12, net30: -5, net7: -3, lastItemHoursAgo: 14 },
    seasonMarkets: [
      { market: 'season_rush_yards', line: 1105 },
      { market: 'season_rush_tds', line: 9.5 },
    ] },
  { id: 'p005', name: 'Owen Fitzgerald', position: 'WR', team: 'SF', adp: 6.2, dogAdp: 5.1, searchRank: 4,
    news: { net: 2, items: 6 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 1155 },
      { market: 'season_receptions', line: 88 },
    ] },
  { id: 'p006', name: 'Silas Mbeki', position: 'RB', team: 'GB', adp: 7.1, dogAdp: 8.4, searchRank: 8,
    news: { net: 1, items: 5 },
    seasonMarkets: [{ market: 'season_rush_yards', line: 1040 }, { market: 'season_rush_tds', line: 8.5 }] },
  { id: 'p007', name: 'Julian Reyes', position: 'RB', team: 'MIA', adp: 8.8, dogAdp: 13.2, searchRank: 6,
    status: 'Questionable',
    news: { net: -2, items: 8, net30: -2 },
    seasonMarkets: [{ market: 'season_rush_yards', line: 980 }] },
  /* Conflicting evidence: the classifier could not call half of what it read. */
  { id: 'p008', name: 'Silas Brandt', position: 'WR', team: 'DET', adp: 10.4, dogAdp: 10.9, searchRank: 9,
    news: { net: 1, items: 14, mixed: 6, net30: -1 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 1075 },
      { market: 'season_receptions', line: 84 },
    ] },
  /* The ledger's favourite, thirty picks below where it would put him. */
  { id: 'p009', name: 'Emeka Falade', position: 'WR', team: 'HOU', adp: 41.2, dogAdp: 12.0, searchRank: 34,
    news: { net: 9, items: 13, net30: 7, net7: 4, lastItemHoursAgo: 9 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 985 },
      { market: 'season_receptions', line: 76 },
    ] },

  // ---------------------------------------------------------- quarterbacks
  { id: 'p010', name: 'Trey Halloran', position: 'QB', team: 'BAL', adp: 24.5, dogAdp: 31.0, searchRank: 12,
    news: { net: 4, items: 8 },
    seasonMarkets: [{ market: 'season_pass_yards', line: 4380 }, { market: 'season_pass_tds', line: 31.5 }] },
  { id: 'p011', name: 'Emil Draeger', position: 'QB', team: 'MIN', adp: 27.0, dogAdp: 25.8, searchRank: 15,
    news: { net: 1, items: 4 },
    seasonMarkets: [{ market: 'season_pass_yards', line: 4200 }, { market: 'season_pass_tds', line: 28.5 }] },
  { id: 'p012', name: 'Jonah Priestley', position: 'QB', team: 'TB', adp: 29.4, dogAdp: 33.1, searchRank: 19,
    news: { net: 0, items: 3 },
    seasonMarkets: [{ market: 'season_pass_yards', line: 4055 }] },
  { id: 'p013', name: 'Casey Lindqvist', position: 'QB', team: 'DEN', adp: 31.1, dogAdp: 29.4, searchRank: 22,
    news: { net: -1, items: 5 } },
  /* Then a twenty-pick hole. Four in a tier is not a shortage; this is. */
  { id: 'p014', name: 'Ruben Castellanos', position: 'QB', team: 'PIT', adp: 61.8, dogAdp: 58.2, searchRank: 40,
    news: { net: 2, items: 4 } },
  { id: 'p015', name: 'Wes Ihejirika', position: 'QB', team: 'CLE', adp: 74.2, searchRank: 56 },

  // ------------------------------------------------------------ tight ends
  { id: 'p016', name: 'Andre Sotelo', position: 'TE', team: 'DAL', adp: 21.7, dogAdp: 18.4, searchRank: 11,
    status: 'Questionable',
    news: { net: 3, items: 7, net30: 3 },
    seasonMarkets: [
      { market: 'season_receiving_yards', line: 905 },
      { market: 'season_receptions', line: 78 },
      { market: 'season_receiving_tds', line: 6.5 },
    ] },
  { id: 'p017', name: 'Miles Barrowman', position: 'TE', team: 'ATL', adp: 25.9, dogAdp: 27.6, searchRank: 20,
    news: { net: 2, items: 5 },
    seasonMarkets: [{ market: 'season_receiving_yards', line: 790 }, { market: 'season_receptions', line: 68 }] },
  /* Two, then a twenty-eight-pick hole — the shape a tier warning is for. */
  /* Priced by Sleeper and not by Underdog — the blend renormalises and says so. */
  { id: 'p018', name: 'Teo Ferreira', position: 'TE', team: 'SEA', adp: 54.3, searchRank: 44,
    news: { net: -3, items: 6, net30: -3 } },
  { id: 'p019', name: 'Grant Aldous', position: 'TE', team: 'WAS', adp: 58.0, dogAdp: 61.5, searchRank: 49 },
  { id: 'p020', name: 'Nate Kowalski', position: 'TE', team: 'CHI', adp: 88.4, dogAdp: 84.0, searchRank: 72, status: 'IR',
    news: { net: -4, items: 5, net30: -4, lastItemHoursAgo: 40 } },

  // --------------------------------------------------- the middle rounds
  { id: 'p021', name: 'Bo Ashworth', position: 'RB', team: 'LAR', adp: 12.6, dogAdp: 14.1, searchRank: 10,
    news: { net: 0, items: 4 },
    seasonMarkets: [{ market: 'season_rush_yards', line: 920 }] },
  { id: 'p022', name: 'Cal Whitfield', position: 'WR', team: 'NYJ', adp: 14.1, dogAdp: 16.9, searchRank: 13,
    status: 'Doubtful',
    news: { net: -5, items: 9, net30: -4, net7: -2 } },
  { id: 'p023', name: 'Ike Sandoval', position: 'RB', team: 'MIN', adp: 16.8, dogAdp: 15.2, searchRank: 17,
    news: { net: 2, items: 6 },
    seasonMarkets: [{ market: 'season_rush_yards', line: 860 }, { market: 'season_receptions', line: 48 }] },
  { id: 'p024', name: 'Dax Merriweather', position: 'WR', team: 'LAC', adp: 18.2, dogAdp: 20.3, searchRank: 16,
    news: { net: 1, items: 5 } },
  { id: 'p025', name: 'Yusuf Adeyemi', position: 'WR', team: 'TB', adp: 19.5, dogAdp: 17.8, searchRank: 18,
    news: { net: 4, items: 7, net7: 2 } },
  { id: 'p026', name: 'Corbin Ledoux', position: 'RB', team: 'NO', adp: 22.9, dogAdp: 24.4, searchRank: 21,
    news: { net: -1, items: 4 } },
  { id: 'p027', name: 'Anton Brekke', position: 'WR', team: 'ARI', adp: 26.4, dogAdp: 28.9, searchRank: 24,
    news: { net: 0, items: 3 } },
  { id: 'p028', name: 'Rey Villanueva', position: 'RB', team: 'IND', adp: 30.2, dogAdp: 26.1, searchRank: 26,
    news: { net: 3, items: 6, net7: 2, lastItemHoursAgo: 20 } },
  { id: 'p029', name: 'Ollie Trant', position: 'WR', team: 'JAX', adp: 33.7, dogAdp: 36.2, searchRank: 29 },
  { id: 'p030', name: 'Femi Adebayo', position: 'RB', team: 'CHI', adp: 35.1, dogAdp: 38.7, searchRank: 31,
    news: { net: -2, items: 5 } },
  { id: 'p031', name: 'Karl Ostrowski', position: 'WR', team: 'PIT', adp: 37.8, dogAdp: 34.5, searchRank: 33 },
  { id: 'p032', name: 'Dane Kirkbride', position: 'RB', team: 'TEN', adp: 39.4, dogAdp: 42.8, searchRank: 36,
    news: { net: 1, items: 3 } },
  { id: 'p033', name: 'Vasco Pinheiro', position: 'WR', team: 'NE', adp: 43.6, dogAdp: 40.1, searchRank: 38 },
  { id: 'p034', name: 'Otis Kramarik', position: 'RB', team: 'NYG', adp: 46.0, dogAdp: 49.6, searchRank: 41 },
  { id: 'p035', name: 'Jae-won Sohn', position: 'WR', team: 'LV', adp: 48.5, dogAdp: 45.3, searchRank: 43,
    news: { net: 2, items: 4 } },
  { id: 'p036', name: 'Bruno Tessaro', position: 'RB', team: 'CAR', adp: 51.2, dogAdp: 48.6, searchRank: 46 },
  { id: 'p037', name: 'Kwame Boateng', position: 'WR', team: 'BAL', adp: 53.0, dogAdp: 44.0, searchRank: 47,
    news: { net: 5, items: 6, net7: 3, lastItemHoursAgo: 11 } },
  { id: 'p038', name: 'Lorne Whitaker', position: 'RB', team: 'GB', adp: 56.4, dogAdp: 60.2, searchRank: 51 },
  { id: 'p039', name: 'Idris Manso', position: 'WR', team: 'MIA', adp: 59.8, dogAdp: 52.7, searchRank: 53 },
  { id: 'p040', name: 'Ephraim Doss', position: 'RB', team: 'DEN', adp: 63.3, dogAdp: 66.9, searchRank: 58,
    news: { net: -1, items: 3 } },
];

/**
 * Depth, generated so the board has a real tail.
 *
 * Deterministic by construction: every value is a function of the index, so
 * this produces byte-identical output on every machine and in every run, which
 * is what §10 requires of a fixture. Nothing here is random and nothing is
 * dated.
 *
 * The last stretch deliberately has no ADP at all. The published ranking covers
 * about two hundred players and the league holds far more, so "no draft order
 * for this player" is the ordinary state in the eleventh round — and the board
 * is supposed to say `ADP —` and rank him on what is known, rather than delete
 * him.
 */
function depthPool(): DemoPlayerSpec[] {
  const FIRST = ['Aldo', 'Bram', 'Ciaran', 'Dov', 'Enzo', 'Frey', 'Gus', 'Hakim', 'Ivo', 'Jarrah',
    'Kester', 'Lubo', 'Milo', 'Nils', 'Oren', 'Piet', 'Quill', 'Rafe', 'Soren', 'Tarek',
    'Ugo', 'Vidar', 'Wynn', 'Xavi', 'Yannick', 'Zoltan'];
  const LAST = ['Achterberg', 'Bergqvist', 'Castellan', 'Dunkerley', 'Eskildsen', 'Farrow', 'Gundersen',
    'Halloway', 'Ilyushin', 'Jankowski', 'Kalmar', 'Lindegaard', 'Moravec', 'Nyquist',
    'Oyelaran', 'Pashkov', 'Quintero', 'Rasmussen', 'Stavros', 'Toivonen', 'Urquhart',
    'Vasilyev', 'Wieczorek', 'Xanthos', 'Ylitalo', 'Zabala'];
  const CYCLE: DemoPosition[] = ['WR', 'RB', 'WR', 'TE', 'RB', 'WR', 'QB', 'RB'];

  const out: DemoPlayerSpec[] = [];
  /*
   * Enough that the wire is a real wire.
   *
   * Twelve teams hold 168 players. A universe of two hundred would leave a
   * waiver scan with thirty names, which is not what a waiver wire looks like
   * and would make every "nobody available beats what you have" answer a
   * property of the fixture rather than of the roster.
   */
  for (let i = 0; i < 220; i++) {
    const n = i + 41;
    const position = CYCLE[i % CYCLE.length]!;
    // ADP runs out at 200 and the rest of the pool has none, which is the truth
    // about every published ranking this project has ever imported.
    const adp = i < 88 ? Math.round((66 + i * 1.52) * 10) / 10 : undefined;
    /*
     * Underdog's own board, which is not Sleeper's.
     *
     * Offset by a few picks either way so the two markets disagree the way two
     * real markets do, and deliberately absent in two stretches: `i` in the
     * 60s is priced by Sleeper alone, and `i` in the low 90s is priced by
     * Underdog alone — a player past the end of the Sleeper file whom Underdog
     * still ranks. Both are ordinary states and both have to render.
     */
    const dogAdp =
      i >= 60 && i < 70
        ? undefined
        : i < 96
          ? Math.round((62 + i * 1.55 + ((i % 7) - 3) * 2.4) * 10) / 10
          : undefined;
    out.push({
      id: `p${String(n).padStart(3, '0')}`,
      name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`,
      position,
      team: TEAMS[(i * 5 + 2) % TEAMS.length]!,
      searchRank: 60 + i,
      ...(adp == null ? {} : { adp }),
      ...(dogAdp == null ? {} : { dogAdp }),
      // A quiet ledger for most of them, which is what a ledger is really like.
      ...(i % 9 === 0 ? { news: { net: (i % 3) - 1, items: 2 } } : {}),
    });
  }
  return out;
}

/**
 * Cases that have to land on a *named* player rather than wherever a formula
 * puts one.
 *
 * `p076` carries an Underdog price that cannot be true: Sleeper has him at 119
 * and the Underdog file says 2.4. Nobody thinks the hundred-and-nineteenth
 * player off the board is the second, and blended at 60/40 that would price him
 * around 48 with complete confidence — the exact failure
 * `isImplausibleDisagreement` exists to catch. He is chosen because he is
 * *still available* in the sixth round, which is the only way a reader ever
 * sees the guard do its work. The fixture states the bad number; the guard is
 * what decides it is bad.
 */
const DEPTH_OVERRIDES: Record<string, Partial<DemoPlayerSpec>> = {
  p076: { dogAdp: 2.4 },
};

export const WORLD_PLAYERS: DemoPlayerSpec[] = [...HEADLINE, ...depthPool()].map((spec) => {
  const patch = DEPTH_OVERRIDES[spec.id];
  return patch ? { ...spec, ...patch } : spec;
});

const BY_ID = new Map(WORLD_PLAYERS.map((p) => [p.id, p]));

export function worldPlayer(id: string): DemoPlayerSpec {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`demo fixture: no player ${id} in the world`);
  return found;
}

/** Players in the order the frozen ADP snapshot puts them. Unranked last. */
export function adpOrder(): DemoPlayerSpec[] {
  return [...WORLD_PLAYERS].sort(
    (a, b) =>
      (a.adp ?? Infinity) - (b.adp ?? Infinity) ||
      (a.searchRank ?? Infinity) - (b.searchRank ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
}
