/**
 * The three new parsers, against the shapes the live files actually have.
 *
 * Every fixture line here is a real line from a live nflverse file, quoted
 * commas and all, rather than a tidy invention — because the tidy invention is
 * exactly the file that would have passed while the real one shifted every
 * column after index five. See `core/source/csv.ts` for the trap.
 */

import { describe, expect, it } from 'vitest';
import {
  identityCoverage,
  parseRoster,
  resolveIdentities,
  rosterUrl,
  toIdentityLinks,
} from '../src/core/nflverse/roster.ts';
import {
  DEPTH_PREFIX_BYTES,
  depthChartUrl,
  depthRoles,
  parseDepthChart,
} from '../src/core/nflverse/depthChart.ts';
import { parseSnapCounts, snapCountsUrl } from '../src/core/nflverse/snapCounts.ts';

// --------------------------------------------------------------- rosters ---

const ROSTER_HEADER =
  'season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,' +
  'birth_date,height,weight,college,gsis_id,espn_id,sportradar_id,yahoo_id,rotowire_id,pff_id,pfr_id,' +
  'fantasy_data_id,sleeper_id,years_exp,headshot_url,ngs_position,week,game_type,status_description_abbr,' +
  'football_name,esb_id,gsis_it_id,smart_id,entry_year,rookie_year,draft_club,draft_number';

/** Real rows from `roster_2026.csv`, verbatim. */
const RODGERS =
  '2026,PIT,QB,QB,8,ACT,Aaron Rodgers,Aaron,Rodgers,1983-12-02,74,225,California; Butte College,' +
  '00-0023459,8439,0ce48193-e2fa-466e-a986-33f751add206,7200,4307,2241,RodgAa00,2593,96,21,' +
  '"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/dypvakakxhccxs67tb0y",,1,REG,A01,Aaron,' +
  'ROD339293,29851,3200524f-4433-9293-a3cf-ad7758d03003,2005,2005,GB,24';

const FLACCO =
  '2026,CIN,QB,QB,16,ACT,Joe Flacco,Joseph,Flacco,1985-01-16,78,245,Delaware; Pittsburgh,' +
  '00-0026158,11252,64797df2-efd3-4b27-86ee-1d48f7edb09f,8795,5648,4332,FlacJo00,611,19,18,' +
  '"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/vbqptn8emdlbeaz1kvmx",,1,REG,A01,Joe,' +
  'FLA009602,33099,3200464c-4100-9602-96e8-665718e215c0,2008,2008,BAL,18';

/** A real tight end nflverse has no Sleeper id for. The bridge's failure case. */
const NO_SLEEPER_ID =
  '2026,DET,TE,TE,49,ACT,Joel Wilson,Joel,Wilson,2000-05-05,75,250,Central Michigan,' +
  '00-0039023,4360761,,,,,WilsJo10,,,2,,,1,REG,A01,Joel,WIL000000,55000,32005749-4c00-0000-0000-000000000000,' +
  '2023,2023,,';

/** A defensive back, which the position filter must discard before doing any work. */
const CORNERBACK =
  '2026,PIT,CB,LCB,24,ACT,Joey Porter Jr.,Joey,Porter,2000-06-15,74,193,Penn State,' +
  '00-0039063,4360799,,,,,PortJo01,,4451,3,,,1,REG,A01,Joey,POR000000,55100,' +
  '32005000-5200-0000-0000-000000000000,2023,2023,PIT,32';

function rosterFile(...rows: string[]): string {
  return [ROSTER_HEADER, ...rows].join('\n') + '\n';
}

describe('the seasonal roster, which is the identity bridge', () => {
  it('reads every identifier off one row, past a quoted comma in the headshot URL', () => {
    const parsed = parseRoster(rosterFile(RODGERS));
    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0]!;
    /*
     * `f_auto,q_auto` sits inside quotes at column 23, before `week` at 25. A
     * split on commas reads `week` as `q_auto/league/...` and every column
     * after it is wrong by one. These four assertions are the ones that fail
     * when that regresses.
     */
    expect(row.gsisId).toBe('00-0023459');
    expect(row.sleeperId).toBe('96');
    expect(row.pfrId).toBe('RodgAa00');
    expect(row.espnId).toBe('8439');
    expect(row.week).toBe(1);
    expect(row.gameType).toBe('REG');
    expect(row.position).toBe('QB');
    expect(row.status).toBe('ACT');
    expect(row.yearsExp).toBe(21);
  });

  it('discards positions this app does not carry before reading their columns', () => {
    const parsed = parseRoster(rosterFile(RODGERS, CORNERBACK, FLACCO));
    expect(parsed.rows.map((r) => r.fullName)).toEqual(['Aaron Rodgers', 'Joe Flacco']);
    // Counted, so a file that suddenly stops carrying quarterbacks is visible.
    expect(parsed.rowsInFile).toBe(3);
  });

  it('keeps a blank identifier as null rather than as an empty string', () => {
    const parsed = parseRoster(rosterFile(NO_SLEEPER_ID));
    const row = parsed.rows[0]!;
    expect(row.sleeperId).toBeNull();
    expect(row.gsisId).toBe('00-0039023');
    expect(row.pfrId).toBe('WilsJo10');
  });

  it('drops a row with no gsis_id and counts it rather than guessing', () => {
    const anonymous = RODGERS.replace('00-0023459', '');
    const parsed = parseRoster(rosterFile(anonymous, FLACCO));
    expect(parsed.rows.map((r) => r.gsisId)).toEqual(['00-0026158']);
    expect(parsed.skipped).toBe(1);
  });

  it('reads columns by name, so an inserted column shifts nothing', () => {
    const shifted = [
      'nflverse_new_column,' + ROSTER_HEADER,
      'x,' + RODGERS,
    ].join('\n');
    const parsed = parseRoster(shifted);
    expect(parsed.rows[0]?.gsisId).toBe('00-0023459');
    expect(parsed.rows[0]?.sleeperId).toBe('96');
  });

  it('returns nothing rather than throwing on an empty or headerless file', () => {
    expect(parseRoster('').rows).toEqual([]);
    expect(parseRoster('a,b,c\n1,2,3\n').rows).toEqual([]);
  });

  it('names the release asset per season', () => {
    expect(rosterUrl('2026')).toBe(
      'https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv',
    );
  });
});

// ----------------------------------------------------------- depth charts ---

const DEPTH_HEADER =
  'dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank';

/**
 * Arizona's live 2026 offensive grouping, trimmed to the receivers, the back and
 * the tight end.
 *
 * The receivers are the point: slots 1, 2 and 8 carry ranks 1, 2 and 3, and the
 * backups behind them carry 4 through 11. `pos_rank` runs across the whole
 * position on the club rather than restarting per slot, and a reader that
 * assumed otherwise would file the third receiver as a third-stringer.
 */
const ARI_NOW = [
  '2026-08-23T07:28:22Z,ARI,Marvin Harrison Jr.,4432708,00-0039849,21,3WR 1TE,1,Wide Receiver,WR,1,1',
  '2026-08-23T07:28:22Z,ARI,Michael Wilson,4361424,00-0038559,21,3WR 1TE,1,Wide Receiver,WR,2,2',
  '2026-08-23T07:28:22Z,ARI,Kendrick Bourne,3120348,00-0033408,21,3WR 1TE,1,Wide Receiver,WR,8,3',
  '2026-08-23T07:28:22Z,ARI,Xavier Weaver,4429025,00-0039901,21,3WR 1TE,1,Wide Receiver,WR,1,4',
  '2026-08-23T07:28:22Z,ARI,Trey McBride,4361307,00-0037744,21,3WR 1TE,10,Tight End,TE,10,1',
  '2026-08-23T07:28:22Z,ARI,Jeremiyah Love,4685702,00-0041027,21,3WR 1TE,11,Running Back,RB,11,1',
  '2026-08-23T07:28:22Z,ARI,James Conner,3045147,00-0033553,21,3WR 1TE,11,Running Back,RB,11,3',
];

const ARI_YESTERDAY = [
  '2026-08-22T07:26:29Z,ARI,Marvin Harrison Jr.,4432708,00-0039849,21,3WR 1TE,1,Wide Receiver,WR,1,1',
  '2026-08-22T07:26:29Z,ARI,Michael Wilson,4361424,00-0038559,21,3WR 1TE,1,Wide Receiver,WR,2,2',
  '2026-08-22T07:26:29Z,ARI,Xavier Weaver,4429025,00-0039901,21,3WR 1TE,1,Wide Receiver,WR,8,3',
  '2026-08-22T07:26:29Z,ARI,Kendrick Bourne,3120348,00-0033408,21,3WR 1TE,1,Wide Receiver,WR,1,4',
  '2026-08-22T07:26:29Z,ARI,Trey McBride,4361307,00-0037744,21,3WR 1TE,10,Tight End,TE,10,1',
];

function depthFile(...blocks: string[][]): string {
  return [DEPTH_HEADER, ...blocks.flat()].join('\n') + '\n';
}

describe('depth charts, read from the front of a 44MiB file', () => {
  it('takes the newest capture and stops at the one below it', () => {
    const snapshot = parseDepthChart(depthFile(ARI_NOW, ARI_YESTERDAY));
    expect(snapshot.schema).toBe('timestamped');
    expect(snapshot.capturedAt).toBe('2026-08-23T07:28:22Z');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.entries).toHaveLength(ARI_NOW.length);
    expect(snapshot.entries.map((e) => e.playerName)).not.toContain(undefined);
  });

  it('refuses to call a capture complete when the read ended inside it', () => {
    /*
     * The failure this guard exists for. Half a chart is not a smaller chart:
     * it reads as a club having released everybody the read did not reach, and
     * every player behind them gets reported as promoted.
     */
    const truncated = parseDepthChart(depthFile(ARI_NOW));
    expect(truncated.complete).toBe(false);
    expect(truncated.note).toMatch(/partial|not usable|did not end/i);
  });

  it('refuses outright when a newer capture appears below an older one', () => {
    const misordered = parseDepthChart(depthFile(ARI_YESTERDAY, ARI_NOW));
    expect(misordered.entries).toEqual([]);
    expect(misordered.capturedAt).toBeNull();
    expect(misordered.note).toMatch(/not newest-first/);
  });

  it('reads pos_rank as an ordering across the whole position, not per slot', () => {
    const roles = depthRoles(parseDepthChart(depthFile(ARI_NOW, ARI_YESTERDAY)));
    const bourne = roles.get('00-0033408')!;
    // Three receiver slots on this club in this grouping, so the third-ranked
    // receiver is inside the spots it fields.
    expect(bourne.rank).toBe(3);
    expect(bourne.starterSlots).toBe(3);
    expect(bourne.isStarter).toBe(true);

    const weaver = roles.get('00-0039901')!;
    expect(weaver.rank).toBe(4);
    expect(weaver.isStarter).toBe(false);
  });

  it('counts fielded spots per position rather than assuming a formation', () => {
    const roles = depthRoles(parseDepthChart(depthFile(ARI_NOW, ARI_YESTERDAY)));
    expect(roles.get('00-0037744')!.starterSlots).toBe(1); // one tight-end spot
    expect(roles.get('00-0041027')!.starterSlots).toBe(1); // one back
    expect(roles.get('00-0033553')!.isStarter).toBe(false); // Conner, rank 3 of 1
  });

  it('reads the pre-2025 weekly schema by its own semantics', () => {
    const legacy = [
      'season,club_code,week,game_type,depth_team,last_name,first_name,football_name,formation,gsis_id,' +
        'jersey_number,position,elias_id,depth_position,full_name',
      '2024,ATL,1,REG,1,London,Bijan,Bijan,Offense,00-0038542,7,RB,LON123456,RB,Bijan Robinson',
      '2024,ATL,1,REG,2,Allgeier,Tyler,Tyler,Offense,00-0037241,25,RB,ALL123456,RB,Tyler Allgeier',
      '2024,ATL,2,REG,1,Allgeier,Tyler,Tyler,Offense,00-0037241,25,RB,ALL123456,RB,Tyler Allgeier',
      '2024,ATL,2,REG,2,London,Bijan,Bijan,Offense,00-0038542,7,RB,LON123456,RB,Bijan Robinson',
    ].join('\n');
    const snapshot = parseDepthChart(legacy);
    expect(snapshot.schema).toBe('weekly');
    expect(snapshot.complete).toBe(true);
    // The latest regular-season week, not the first block in the file.
    expect(snapshot.entries.every((e) => e.week === 2)).toBe(true);
    const roles = depthRoles(snapshot);
    expect(roles.get('00-0037241')!.rank).toBe(1);
    expect(roles.get('00-0038542')!.rank).toBe(2);
  });

  it('asks for enough bytes to prove one capture ended, and names the asset', () => {
    // One live capture measured ~310KiB; the guard needs to see the next begin.
    expect(DEPTH_PREFIX_BYTES).toBeGreaterThan(310 * 1024 * 2);
    expect(depthChartUrl('2026')).toBe(
      'https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv',
    );
  });
});

// ------------------------------------------------------------ snap counts ---

const SNAP_HEADER =
  'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,' +
  'offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct';

function snapFile(...rows: string[]): string {
  return [SNAP_HEADER, ...rows].join('\n') + '\n';
}

describe('PFR snap counts', () => {
  it('reads the latest week by walking back from the end', () => {
    const parsed = parseSnapCounts(
      snapFile(
        '2025_09_ARI_NO,x,2025,REG,9,Spencer Rattler,RattSp00,QB,NO,ARI,75,1,0,0,0,0',
        '2025_10_ARI_NO,x,2025,REG,10,Spencer Rattler,RattSp00,QB,NO,ARI,60,0.85,0,0,0,0',
        '2025_10_ARI_NO,x,2025,REG,10,Chris Olave,OlavCh00,WR,NO,ARI,55,0.78,0,0,0,0',
      ),
    );
    expect(parsed.latestWeek).toBe(10);
    expect(parsed.week).toBe(10);
    expect(parsed.rows.map((r) => r.pfrId)).toEqual(['RattSp00', 'OlavCh00']);
    expect(parsed.rows[0]!.offenseShare).toBe(0.85);
  });

  it('reads an explicit earlier week without dragging in its neighbours', () => {
    const parsed = parseSnapCounts(
      snapFile(
        '2025_09_ARI_NO,x,2025,REG,9,Spencer Rattler,RattSp00,QB,NO,ARI,75,1,0,0,0,0',
        '2025_10_ARI_NO,x,2025,REG,10,Spencer Rattler,RattSp00,QB,NO,ARI,60,0.85,0,0,0,0',
      ),
      { week: 9 },
    );
    expect(parsed.week).toBe(9);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.offenseSnaps).toBe(75);
  });

  it('keeps the playoff spelling this file uses rather than the sibling file’s', () => {
    /*
     * The trap named in migration 0030: this file spells the postseason WC /
     * DIV / CON / SB where `stats_player_week` spells it POST. A read filtering
     * `!== 'POST'` would admit every playoff game into a regular-season
     * baseline, so the value is carried through verbatim for the reader to
     * test against 'REG'.
     */
    const parsed = parseSnapCounts(
      snapFile('2025_20_BUF_KC,x,2025,CON,21,Josh Allen,AlleJo02,QB,BUF,KC,70,1,0,0,0,0'),
    );
    expect(parsed.rows[0]!.gameType).toBe('CON');
    expect(parsed.rows[0]!.gameType).not.toBe('POST');
  });

  it('discards positions this app does not carry, and counts what it saw', () => {
    const parsed = parseSnapCounts(
      snapFile(
        '2025_01_ARI_NO,x,2025,REG,1,Kelvin Banks,BankKe01,T,NO,ARI,75,1,0,0,5,0.19',
        '2025_01_ARI_NO,x,2025,REG,1,Chris Olave,OlavCh00,WR,NO,ARI,68,0.91,0,0,0,0',
      ),
    );
    expect(parsed.rows.map((r) => r.position)).toEqual(['WR']);
    expect(parsed.rowsInWeek).toBe(2);
  });

  it('keeps a blank share as null rather than as zero', () => {
    const parsed = parseSnapCounts(
      snapFile('2025_01_ARI_NO,x,2025,REG,1,Chris Olave,OlavCh00,WR,NO,ARI,,,0,0,0,0'),
    );
    expect(parsed.rows[0]!.offenseShare).toBeNull();
    expect(parsed.rows[0]!.offenseSnaps).toBeNull();
  });

  it('names the asset per season', () => {
    expect(snapCountsUrl('2025')).toBe(
      'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2025.csv',
    );
  });
});

// -------------------------------------------------------------- identity ---

describe('the identity ladder', () => {
  const crosswalk = toIdentityLinks(parseRoster(rosterFile(RODGERS, FLACCO, NO_SLEEPER_ID)), 'roster', '2026-08-23T00:00:00Z');

  it('prefers the GSIS id Sleeper published itself', () => {
    const resolved = resolveIdentities([{ id: '96', externalIds: { gsis: '00-0023459' } }], crosswalk);
    const rodgers = resolved.get('96')!;
    expect(rodgers.resolution).toBe('sleeper_direct');
    expect(rodgers.gsisId).toBe('00-0023459');
    // And still picks up the PFR id, which Sleeper never publishes and which is
    // what the snap-count join needs.
    expect(rodgers.pfrId).toBe('RodgAa00');
  });

  /*
   * Flacco's `sleeper_id` is 19. The column beside it, `fantasy_data_id`, is
   * 611 — and reading the wrong one of those two adjacent integer columns is
   * exactly the mistake this whole file is arranged to catch, so it is worth
   * saying which is which where somebody will read it.
   */
  it('bridges Sleeper id -> roster sleeper_id -> gsis_id when Sleeper has none', () => {
    const resolved = resolveIdentities([{ id: '19', externalIds: {} }], crosswalk);
    const flacco = resolved.get('19')!;
    expect(flacco.resolution).toBe('roster_bridge');
    expect(flacco.gsisId).toBe('00-0026158');
    expect(flacco.pfrId).toBe('FlacJo00');
  });

  it('leaves an unresolved player explicitly unresolved rather than name-matching', () => {
    /*
     * "Joel Wilson" is in the crosswalk by name and by GSIS id, and has no
     * Sleeper id at all. A fuzzy step would find him. There is no fuzzy step:
     * a projection through the wrong body is not a smaller error than no
     * projection, it is a much larger and much quieter one.
     */
    const resolved = resolveIdentities([{ id: 'unknown-sleeper-id', externalIds: {} }], crosswalk);
    const missing = resolved.get('unknown-sleeper-id')!;
    expect(missing.resolution).toBe('unresolved');
    expect(missing.gsisId).toBeNull();
    expect(missing.pfrId).toBeNull();
  });

  it('quantifies coverage rather than reporting a boolean', () => {
    const resolved = resolveIdentities(
      [
        { id: '96', externalIds: { gsis: '00-0023459' } },
        { id: '19', externalIds: {} },
        { id: 'nobody', externalIds: {} },
      ],
      crosswalk,
    );
    expect(identityCoverage(resolved.values())).toEqual({
      players: 3,
      sleeperDirect: 1,
      rosterBridge: 1,
      unresolved: 1,
      withPfr: 2,
    });
  });

  it('does not invent a mapping from an empty crosswalk', () => {
    const resolved = resolveIdentities([{ id: '19', externalIds: {} }], []);
    expect(resolved.get('19')!.resolution).toBe('unresolved');
  });
});
