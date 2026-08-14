/**
 * The two feeds behind the expanded player card.
 *
 * Both are somebody else's data, and the failure this suite is really about is
 * the quiet one: a number that looks like a result and is not. Sleeper ranks
 * every player on its books, so a rookie who never played comes back as the
 * 1,240th receiver — printing that on a draft card is worse than printing
 * nothing, because a reader cannot tell it apart from a finish.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSeasonStatLines,
  formatPositionRank,
  type RawSeasonStatLine,
} from '../src/core/sleeper/seasonStats.ts';
import { fetchPlayerOutlook } from '../src/core/sleeper/outlook.ts';

const POSITIONS: Record<string, string> = {
  wr1: 'WR',
  wr2: 'WR',
  wr3: 'WR',
  rb1: 'RB',
  qb1: 'QB',
};
const positionOf = (id: string) => POSITIONS[id] ?? null;

function payload(rows: Record<string, RawSeasonStatLine>): Record<string, RawSeasonStatLine> {
  return rows;
}

describe('last season, from the Sleeper stats payload', () => {
  it('ranks each position on half-PPR points, best first', () => {
    const { lines } = buildSeasonStatLines(
      payload({
        wr1: { gp: 17, pts_half_ppr: 210 },
        wr2: { gp: 16, pts_half_ppr: 260 },
        wr3: { gp: 15, pts_half_ppr: 180 },
        rb1: { gp: 17, pts_half_ppr: 300 },
      }),
      positionOf,
    );
    const rank = (id: string) => lines.find((l) => l.playerId === id)?.positionRankHalfPpr;
    expect(rank('wr2')).toBe(1);
    expect(rank('wr1')).toBe(2);
    expect(rank('wr3')).toBe(3);
    // Positions are ranked against themselves, never against each other.
    expect(rank('rb1')).toBe(1);
  });

  /**
   * The bug this file exists for. A player with no points gets no finish, not
   * the last one — those are different claims and only one of them is true.
   */
  it('gives a player who did not score no finish at all', () => {
    const { lines } = buildSeasonStatLines(
      payload({
        wr1: { gp: 17, pts_half_ppr: 210 },
        // A rookie: no games, no points, and a directory position from Sleeper.
        wr2: { gp: null, pts_half_ppr: null, pos_rank_half_ppr: 1240 },
      }),
      positionOf,
    );
    const rookie = lines.find((l) => l.playerId === 'wr2')!;
    expect(rookie.positionRankHalfPpr).toBeNull();
    expect(rookie.gamesPlayed).toBeNull();
    // And nothing derived from it is printable either.
    expect(formatPositionRank('WR', rookie.positionRankHalfPpr)).toBeNull();
  });

  it('keeps zero games apart from no games', () => {
    const { lines } = buildSeasonStatLines(payload({ wr1: { gp: 0, pts_half_ppr: 0 } }), positionOf);
    expect(lines[0]!.gamesPlayed).toBe(0);
  });

  it('gives tied players the same finish, and skips the one after', () => {
    const { lines } = buildSeasonStatLines(
      payload({
        wr1: { gp: 17, pts_half_ppr: 200 },
        wr2: { gp: 17, pts_half_ppr: 200 },
        wr3: { gp: 17, pts_half_ppr: 150 },
      }),
      positionOf,
    );
    const rank = (id: string) => lines.find((l) => l.playerId === id)?.positionRankHalfPpr;
    expect(rank('wr1')).toBe(1);
    expect(rank('wr2')).toBe(1);
    expect(rank('wr3')).toBe(3);
  });

  it('drops rows that are not players this app knows, and counts them', () => {
    const { lines, diagnostics } = buildSeasonStatLines(
      // Team-level rows share the shape and are not players.
      payload({ wr1: { gp: 17, pts_half_ppr: 210 }, KC: { pts_half_ppr: 1717 } }),
      positionOf,
    );
    expect(lines.map((l) => l.playerId)).toEqual(['wr1']);
    expect(diagnostics).toMatchObject({ returned: 2, matched: 1, unmatched: 1 });
  });

  it('records where its own ordering differs from the provider’s', () => {
    const { diagnostics } = buildSeasonStatLines(
      payload({
        wr1: { gp: 17, pts_half_ppr: 210, pos_rank_half_ppr: 1 },
        // Sleeper counts the players who never scored; this does not, so the
        // second receiver is WR2 here and WR40 there.
        wr2: { gp: 16, pts_half_ppr: 190, pos_rank_half_ppr: 40 },
      }),
      positionOf,
    );
    expect(diagnostics.rankDisagreements).toBe(1);
  });

  it('formats a finish the way a card prints it', () => {
    expect(formatPositionRank('WR', 7)).toBe('WR7');
    expect(formatPositionRank('te', 12)).toBe('TE12');
    expect(formatPositionRank('WR', null)).toBeNull();
  });
});

describe('the season outlook', () => {
  const OUTLOOK = {
    data: {
      get_player_outlook: {
        player_id: '9509',
        source: 'rotowire',
        source_key: 'outlook_2026',
        metadata: { title: '2026 Season Outlook', description: 'First sentence here. Second one follows. Third one too. Fourth.' },
      },
    },
  };

  const respond = (body: unknown, ok = true) =>
    (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      }) as unknown as Response) as unknown as (url: string, init?: RequestInit) => Promise<Response>;

  it('reads the text, the heading and who wrote it', async () => {
    const outlook = await fetchPlayerOutlook('9509', '2026', { fetch: respond(OUTLOOK) });
    expect(outlook).toMatchObject({ title: '2026 Season Outlook', source: 'rotowire' });
    expect(outlook!.body).toContain('First sentence here.');
  });

  it('treats an absent outlook as an answer, not a failure', async () => {
    const none = await fetchPlayerOutlook('1', '2026', { fetch: respond({ data: { get_player_outlook: null } }) });
    expect(none).toBeNull();
  });

  /**
   * A rejected query is not "he has no outlook". Confusing the two would cache
   * a lie, and the cache is measured in weeks.
   */
  it('raises a query error rather than reporting no outlook', async () => {
    await expect(
      fetchPlayerOutlook('1', '2026', { fetch: respond({ errors: [{ message: 'nope' }] }) }),
    ).rejects.toThrow('nope');
    await expect(fetchPlayerOutlook('1', '2026', { fetch: respond({}, false) })).rejects.toThrow('500');
  });

});
