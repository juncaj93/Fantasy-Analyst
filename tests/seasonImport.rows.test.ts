/**
 * Turning a pasted table into rows the board can stand behind.
 *
 * Three rules are load-bearing and each has its own test below: nothing is
 * invented, nothing is silently dropped, and a name that does not resolve means
 * "we do not know who this is" rather than "this player has no market".
 */

import { describe, expect, it } from 'vitest';
import { PlayerIndex, type CanonicalPlayer } from '../src/core/identity/index.ts';
import { buildSnapshotImport } from '../src/core/seasonImport/import.ts';
import { lookupSeasonMarket, looksLikeWeeklyMagnitude } from '../src/core/seasonImport/markets.ts';

function player(over: Partial<CanonicalPlayer> & { id: string; fullName: string }): CanonicalPlayer {
  const [first = '', ...rest] = over.fullName.split(' ');
  return {
    sleeperPlayerId: over.id,
    firstName: first,
    lastName: rest.join(' '),
    team: 'CIN',
    position: 'WR',
    status: 'Active',
    active: true,
    normalizedName: over.fullName.toLowerCase().replace(/[^a-z ]/g, ''),
    aliases: [],
    ...over,
  } as CanonicalPlayer;
}

const INDEX = new PlayerIndex([
  player({ id: 'p-chase', fullName: "Ja'Marr Chase", team: 'CIN', position: 'WR' }),
  player({ id: 'p-bijan', fullName: 'Bijan Robinson', team: 'ATL', position: 'RB' }),
  player({ id: 'p-allen', fullName: 'Josh Allen', team: 'BUF', position: 'QB' }),
  player({ id: 'p-kelce', fullName: 'Travis Kelce', team: 'KC', position: 'TE' }),
  // Two players, one name: the case that must come back ambiguous rather than
  // resolving to whichever was indexed first.
  player({ id: 'p-smith-1', fullName: 'Chris Olave', team: 'NO', position: 'WR' }),
  player({ id: 'p-smith-2', fullName: 'Chris Olave', team: 'CAR', position: 'WR' }),
]);

const META = { season: '2026', source: 'Win With Odds', capturedAt: '2026-08-27' };

function importText(body: string) {
  return buildSnapshotImport(body, INDEX, META);
}

describe('market normalisation', () => {
  it('maps the words a table actually uses', () => {
    for (const [text, key] of [
      ['Receiving Yards', 'season_receiving_yards'],
      ['Rushing Yards', 'season_rush_yards'],
      ['Passing TDs', 'season_pass_tds'],
      ['Receptions', 'season_receptions'],
      ['Total Passing Yards', 'season_pass_yards'],
      ['season_receiving_tds', 'season_receiving_tds'],
    ] as const) {
      const out = lookupSeasonMarket(text);
      expect(out.ok && out.market, text).toBe(key);
    }
  });

  it('refuses a market it does not know, and says which text it was', () => {
    const out = lookupSeasonMarket('Punt Return Yards');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('Punt Return Yards');
  });

  it('explains a real market it deliberately does not score', () => {
    const out = lookupSeasonMarket('Rushing Attempts');
    expect(out.ok).toBe(false);
    // Different problem, different answer: nothing to fix in the source.
    if (!out.ok) expect(out.reason).toMatch(/rushing attempts/i);
  });

  it('knows a season line from a Sunday one by its size', () => {
    expect(looksLikeWeeklyMagnitude('season_receiving_yards', 64.5)).toBe(true);
    expect(looksLikeWeeklyMagnitude('season_receiving_yards', 1425.5)).toBe(false);
  });
});

describe('row validation', () => {
  it('accepts a full row across every position', () => {
    const out = importText(
      `player,team,position,market,line,over_price,under_price
Josh Allen,BUF,QB,Passing TDs,32.5,-110,-110
Bijan Robinson,ATL,RB,Rushing Yards,1250.5,-112,-108
Ja'Marr Chase,CIN,WR,Receiving Yards,1425.5,-115,-105
Travis Kelce,KC,TE,Receptions,72.5,-120,+100`,
    );
    expect(out.counts.accepted).toBe(4);
    expect(out.counts.rejected).toBe(0);
    expect(out.counts.matched).toBe(4);
    expect(out.markets).toHaveLength(4);
  });

  it('leaves absent odds null rather than zero', () => {
    const out = importText(`player,market,line\nJosh Allen,Passing TDs,32.5`);
    expect(out.rows[0]?.overPrice).toBeNull();
    expect(out.rows[0]?.underPrice).toBeNull();
    // The distinction the whole app rests on: absent is not a number.
    expect(out.rows[0]?.overPrice).not.toBe(0);
  });

  it('refuses a row with no line rather than defaulting it', () => {
    const out = importText(`player,market,line\nJosh Allen,Passing TDs,`);
    expect(out.counts.accepted).toBe(0);
    expect(out.rejected[0]?.reason).toMatch(/no line/);
  });

  it('refuses a line that is not a number', () => {
    const out = importText(`player,market,line\nJosh Allen,Passing TDs,n/a`);
    expect(out.rejected[0]?.reason).toMatch(/not a number/);
  });

  it('reads a line with a thousands separator', () => {
    const out = importText(`player,market,line\nJa'Marr Chase,Receiving Yards,"1,425.5"`);
    expect(out.rows[0]?.line).toBe(1425.5);
  });

  it('reports an unsupported market row instead of dropping it', () => {
    const out = importText(
      `player,market,line
Josh Allen,Passing TDs,32.5
Josh Allen,Punt Return Yards,12.5`,
    );
    expect(out.counts.accepted).toBe(1);
    expect(out.counts.rejected).toBe(1);
    // Reported, with enough of the row to find it in the source.
    expect(out.rejected[0]?.text).toContain('Punt Return Yards');
  });

  it('keeps every rejection addressable by row number', () => {
    const out = importText(
      `player,market,line
Josh Allen,Passing TDs,32.5
Josh Allen,Nonsense,10
Josh Allen,Receptions,`,
    );
    expect(out.rejected.map((r) => r.rowNumber)).toEqual([2, 3]);
  });
});

describe('player resolution', () => {
  it('resolves a plain name', () => {
    const out = importText(`player,market,line\nJosh Allen,Passing TDs,32.5`);
    expect(out.rows[0]?.playerId).toBe('p-allen');
    expect(out.rows[0]?.matchStatus).toBe('matched');
  });

  it('uses team and position to separate two players with one name', () => {
    const out = importText(`player,team,position,market,line\nChris Olave,NO,WR,Receiving Yards,950.5`);
    expect(out.rows[0]?.playerId).toBe('p-smith-1');
  });

  it('reports an ambiguous name as ambiguous, with candidates', () => {
    const out = importText(`player,market,line\nChris Olave,Receiving Yards,950.5`);
    expect(out.rows[0]?.matchStatus).toBe('ambiguous');
    expect(out.rows[0]?.playerId).toBeNull();
    expect(out.rows[0]?.candidates.length).toBeGreaterThan(1);
  });

  it('keeps an unresolved row rather than dropping it', () => {
    const out = importText(`player,market,line\nSome Unknown Rookie,Receiving Yards,450.5`);
    // Stored, with a null id: identity failure is not "this player has no market".
    expect(out.counts.accepted).toBe(1);
    expect(out.rows[0]?.playerId).toBeNull();
    expect(out.rows[0]?.matchStatus).toBe('unmatched');
    expect(out.counts.unmatched).toBe(1);
  });

  it('falls back to the bare name when a stale team would lose the player', () => {
    // A source captured before a trade should not turn a findable player into
    // an unknown one.
    const out = importText(`player,team,position,market,line\nJosh Allen,XXX,QB,Passing TDs,32.5`);
    expect(out.rows[0]?.playerId).toBe('p-allen');
  });
});

describe('provenance and shape', () => {
  it('requires a capture date that is a real date', () => {
    expect(() =>
      buildSnapshotImport(`player,market,line\nJosh Allen,Passing TDs,32.5`, INDEX, {
        ...META,
        capturedAt: 'last tuesday',
      }),
    ).toThrow(/calendar date/);
  });

  it('takes provenance from the canonical block when the form was left empty', () => {
    const out = buildSnapshotImport(
      `PRESEASON_VEGAS_V1
META | season=2026 | source=Win With Odds | captured=2026-08-27
Josh Allen | BUF | QB | season_pass_tds | 32.5 | -110 | -110
END_PRESEASON_VEGAS`,
      INDEX,
      { season: '', source: '', capturedAt: '' },
    );
    expect(out.source).toBe('Win With Odds');
    expect(out.capturedAt).toBe('2026-08-27');
  });

  it('warns when the numbers look like a weekly table in the wrong door', () => {
    const out = importText(
      `player,market,line
Ja'Marr Chase,Receiving Yards,84.5
Bijan Robinson,Rushing Yards,62.5
Josh Allen,Passing TDs,1.5`,
    );
    // Not rejected — a line is the market's opinion and this app does not
    // overrule it — but said out loud, because no per-row check can catch it.
    expect(out.counts.accepted).toBe(3);
    expect(out.warnings.join(' ')).toMatch(/weekly prop table/i);
  });

  it('says nothing about magnitude when the lines are season-sized', () => {
    const out = importText(
      `player,market,line
Ja'Marr Chase,Receiving Yards,1425.5
Bijan Robinson,Rushing Yards,1250.5`,
    );
    expect(out.warnings).toEqual([]);
  });
});
