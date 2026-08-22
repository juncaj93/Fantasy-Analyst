/**
 * Telling a betting market from somebody's projection model.
 *
 * A real export forced this. Win With Odds publishes a season-long *projection*
 * table whose players, stat names and magnitudes are indistinguishable from
 * season-long *market* lines at the row level. Imported, it would have appeared
 * on the draft board under "Season market" — a model's opinion wearing the
 * market's name, which is the worst thing this feature could do.
 *
 * The fixtures below are the real file's shape, down to the column order and
 * the mixture of whole numbers and half points.
 */

import { describe, expect, it } from 'vitest';
import { PlayerIndex, type CanonicalPlayer } from '../src/core/identity/index.ts';
import { buildSnapshotImport, SnapshotRejectedError } from '../src/core/seasonImport/import.ts';
import { assessColumns, assessSnapshot } from '../src/core/seasonImport/plausibility.ts';
import { parseSnapshot } from '../src/core/seasonImport/parse.ts';

function player(over: Partial<CanonicalPlayer> & { id: string; fullName: string }): CanonicalPlayer {
  const [first = '', ...rest] = over.fullName.split(' ');
  return {
    sleeperPlayerId: over.id,
    firstName: first,
    lastName: rest.join(' '),
    team: 'BUF',
    position: 'QB',
    status: 'Active',
    active: true,
    normalizedName: over.fullName.toLowerCase().replace(/[^a-z ]/g, ''),
    aliases: [],
    ...over,
  } as CanonicalPlayer;
}

const INDEX = new PlayerIndex([
  player({ id: 'p-allen', fullName: 'Josh Allen', team: 'BUF', position: 'QB' }),
  player({ id: 'p-gibbs', fullName: 'Jahmyr Gibbs', team: 'DET', position: 'RB' }),
  player({ id: 'p-nacua', fullName: 'Puka Nacua', team: 'LAR', position: 'WR' }),
]);

const META = { season: '2026', source: 'Win With Odds', capturedAt: '2026-08-22' };

/*
 * The real Win With Odds export, verbatim in shape: one row per player, one
 * column per stat, a derived `Projections` total, and no prices anywhere.
 */
const WIN_WITH_ODDS = `Rank,Name,Pos,Attempts,Comps,Pass TDs,Pass Yards,Ints,Receptions,Rec Yards,Rec TDs,Rec FD,Rush Attempts,Rush Yards,Rush TDs,Rush FD,Fumbles,Projections,7-Day Delta
0,Josh Allen,QB,474.0,313.0,24.5,3624.5,10.0,,,,,110.0,499.5,11.5,53.5,3.0,349.93,0.0
1,Jahmyr Gibbs,RB,,,,,,60.5,449.5,4.5,53.3,255.0,1199.5,12.5,125.1,1.0,327.4,0.0
2,Puka Nacua,WR,,,,,,107.0,1400.0,10.0,140.0,10.0,55.0,,5.5,1.0,312.5,0.0`;

describe('the real projection export is refused', () => {
  it('refuses it, and says it is a projection table', () => {
    let error: unknown;
    try {
      buildSnapshotImport(WIN_WITH_ODDS, INDEX, META);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SnapshotRejectedError);
    expect((error as Error).message).toMatch(/fantasy projection table/i);
    expect((error as Error).message).toMatch(/not.*betting lines/i);
  });

  it('does not send the reader hunting for a market column', () => {
    // The literal failure without the guard: "could not find a market column",
    // which is true and useless — that file was never going to have one.
    let message = '';
    try {
      buildSnapshotImport(WIN_WITH_ODDS, INDEX, META);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/could not find/i);
    expect(message).toMatch(/odds or\s+props page|sportsbook/i);
  });

  it('names the evidence it judged on', () => {
    const report = assessColumns(parseSnapshotColumns(WIN_WITH_ODDS));
    expect(report?.verdict).toBe('model');
    const detail = report!.signals.map((s) => s.detail).join(' ');
    expect(detail).toMatch(/projections/i);
    expect(detail).toMatch(/comps|attempt|fumble/i);
  });
});

/** The headers, read the way the importer reads them. */
function parseSnapshotColumns(text: string): string[] {
  try {
    return parseSnapshot(text).columns;
  } catch (err) {
    return (err as { columns?: string[] }).columns ?? [];
  }
}

describe('column headers alone', () => {
  it('say nothing about an ordinary market table', () => {
    expect(assessColumns(['player', 'team', 'position', 'market', 'line', 'over', 'under'])).toBeNull();
  });

  it('need both a points column and a model-only stat, not either alone', () => {
    // "Projections" on its own is not enough — plenty of odds pages carry the
    // word in their furniture.
    expect(assessColumns(['Player', 'Market', 'Line', 'Projections'])).toBeNull();
    // And an attempts column on its own is not enough either: a book may price
    // attempts.
    expect(assessColumns(['Player', 'Market', 'Line', 'Rush Attempts'])).toBeNull();
    // Together they decide.
    expect(assessColumns(['Name', 'Pos', 'Rush Attempts', 'Comps', 'Projections'])?.verdict).toBe('model');
  });
});

describe('a long-format model export is refused too', () => {
  // The same data reshaped into one row per market still has no prices, no
  // book, whole numbers, and a defence in it.
  const LONG_MODEL = `player,team,position,market,line
Josh Allen,BUF,QB,Passing Yards,3624
Jahmyr Gibbs,DET,RB,Rushing Yards,1199
Puka Nacua,LAR,WR,Receiving Yards,1400
LAR DEF,LAR,DEF,Receiving Yards,116
Josh Allen,BUF,QB,Fumbles,3`;

  it('refuses on the pile-up of signals', () => {
    expect(() => buildSnapshotImport(LONG_MODEL, INDEX, META)).toThrow(SnapshotRejectedError);
  });
});

describe('a real market export is accepted', () => {
  const MARKET = `player,team,position,market,line,over_price,under_price
Josh Allen,BUF,QB,Passing TDs,32.5,-110,-110
Jahmyr Gibbs,DET,RB,Rushing Yards,1250.5,-112,-108
Puka Nacua,LAR,WR,Receiving Yards,1425.5,-115,-105`;

  it('reads it as market data', () => {
    const out = buildSnapshotImport(MARKET, INDEX, META);
    expect(out.plausibility.verdict).toBe('market');
    expect(out.counts.accepted).toBe(3);
  });

  it('accepts a priced table even with a whole number and a kicker in it', () => {
    // One positive signal outweighs the shape signals: a real market export
    // with an odd row in it is still a real market export.
    const messy = `player,team,position,market,line,over_price,under_price
Josh Allen,BUF,QB,Passing Yards,4000,-110,-110
Jahmyr Gibbs,DET,RB,Rushing Yards,1250.5,-112,-108
Puka Nacua,LAR,WR,Receiving Yards,1425.5,-115,-105`;
    expect(buildSnapshotImport(messy, INDEX, META).plausibility.verdict).toBe('market');
  });

  it('accepts an unpriced consensus line when a sportsbook is named', () => {
    // The brief's own carve-out: prices are not required for their own sake.
    // What is required is being able to prove the number came from a market.
    const consensus = `player,team,position,market,line
Josh Allen,BUF,QB,Passing TDs,32.5
Jahmyr Gibbs,DET,RB,Rushing Yards,1250.5
Puka Nacua,LAR,WR,Receiving Yards,1425.5`;
    const out = buildSnapshotImport(consensus, INDEX, { ...META, book: 'DraftKings' });
    expect(out.plausibility.verdict).toBe('market');
    expect(out.book).toBe('DraftKings');
  });
});

describe('when the evidence is thin', () => {
  const UNPROVEN = `player,team,position,market,line
Josh Allen,BUF,QB,Passing TDs,32.5
Jahmyr Gibbs,DET,RB,Rushing Yards,1250.5
Puka Nacua,LAR,WR,Receiving Yards,1425.5`;

  it('stores it, but says it could not be proven to be a market', () => {
    const out = buildSnapshotImport(UNPROVEN, INDEX, META);
    expect(out.plausibility.verdict).toBe('unclear');
    expect(out.counts.accepted).toBe(3);
    expect(out.warnings.join(' ')).toMatch(/cannot be proven to be market data/i);
  });
});

describe('no single signal decides', () => {
  const row = (over: Partial<Record<string, string>> = {}) => ({
    rowNumber: 1,
    player: 'Josh Allen',
    team: 'BUF',
    position: 'QB',
    market: 'Passing TDs',
    line: '32.5',
    overPrice: null,
    underPrice: null,
    ...over,
  });

  it('does not refuse for whole numbers alone', () => {
    const report = assessSnapshot({
      rows: [row({ line: '4000' }), row({ line: '3800' }), row({ line: '3600' })] as never,
      columns: ['player', 'market', 'line'],
    });
    // Two model signals — no prices, no book — plus whole numbers is three, and
    // three is not enough.
    expect(report.verdict).not.toBe('model');
  });

  it('refuses only when the signals pile up', () => {
    const report = assessSnapshot({
      rows: [
        row({ line: '4000' }),
        row({ line: '116', position: 'DEF', player: 'LAR DEF' }),
      ] as never,
      columns: ['name', 'pos', 'comps', 'projections'],
    });
    expect(report.verdict).toBe('model');
    expect(report.modelSignals).toBeGreaterThanOrEqual(4);
  });
});
