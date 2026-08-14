import { describe, expect, it } from 'vitest';
import { SleeperClient, SleeperError } from '../src/core/sleeper/client.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import {
  nextPickForSlot,
  pickNumbersForSlot,
  slotForRoster,
  toCanonicalPlayers,
  toDraftPickRecords,
  toDraftRecord,
  toLeagueRecord,
  toRosterRecords,
  waitHorizonForSlot,
} from '../src/core/sleeper/transform.ts';
import type { SleeperPlayer } from '../src/core/sleeper/types.ts';

const RAW_PLAYERS: Record<string, SleeperPlayer> = {
  '4046': { player_id: '4046', first_name: 'Patrick', last_name: 'Mahomes', full_name: 'Patrick Mahomes', team: 'KC', position: 'QB', active: true, gsis_id: '00-0033873' },
  '8138': { player_id: '8138', first_name: 'Puka', last_name: 'Nacua', full_name: 'Puka Nacua', team: 'LAR', position: 'WR', active: true, injury_status: 'Questionable' },
  '9999': { player_id: '9999', first_name: 'Deep', last_name: 'Snapper', full_name: 'Deep Snapper', team: 'NYJ', position: 'LS', active: true },
  '8888': { player_id: '8888', first_name: 'Retired', last_name: 'Guy', full_name: 'Retired Guy', team: null, position: 'RB', active: false },
  '7777': { player_id: '7777', first_name: 'Flex', last_name: 'Back', full_name: 'Flex Back', team: 'JAC', position: 'FB', fantasy_positions: ['RB'], active: true },
};

describe('toCanonicalPlayers', () => {
  const players = toCanonicalPlayers(RAW_PLAYERS);

  it('keeps only fantasy-relevant positions', () => {
    expect(players.map((p) => p.fullName)).not.toContain('Deep Snapper');
  });

  it('drops inactive players by default but can keep them', () => {
    expect(players.map((p) => p.fullName)).not.toContain('Retired Guy');
    expect(toCanonicalPlayers(RAW_PLAYERS, { keepInactive: true }).map((p) => p.fullName)).toContain('Retired Guy');
  });

  it('uses the Sleeper id as the canonical id', () => {
    const mahomes = players.find((p) => p.fullName === 'Patrick Mahomes')!;
    expect(mahomes.id).toBe('4046');
    expect(mahomes.sleeperPlayerId).toBe('4046');
  });

  it('carries external ids through for cross-source matching', () => {
    expect(players.find((p) => p.id === '4046')!.externalIds!['gsis']).toBe('00-0033873');
  });

  /**
   * Sleeper serves a large share of GSIS ids with a leading space — a live
   * sample returns `' 00-0035229'`. Stored as received, every one of those
   * fails an equality join against the same id written normally by anybody
   * else, which is the only thing the field is for.
   */
  it('trims external ids, because the source does not', () => {
    const [padded] = toCanonicalPlayers({
      '9997': {
        player_id: '9997',
        first_name: 'Spacey',
        last_name: 'Identifier',
        full_name: 'Spacey Identifier',
        team: 'BAL',
        position: 'WR',
        active: true,
        gsis_id: ' 00-0035229',
      },
    });
    expect(padded!.externalIds!['gsis']).toBe('00-0035229');
  });

  it('drops an external id that was only whitespace', () => {
    const [blank] = toCanonicalPlayers({
      '9998': {
        player_id: '9998',
        first_name: 'No',
        last_name: 'Identifier',
        full_name: 'No Identifier',
        team: 'BAL',
        position: 'WR',
        active: true,
        gsis_id: '   ',
      },
    });
    expect(blank!.externalIds!['gsis']).toBeUndefined();
  });

  it('normalizes team codes', () => {
    expect(players.find((p) => p.id === '7777')!.team).toBe('JAX');
  });

  it('falls back to a fantasy position when the primary is not fantasy-relevant', () => {
    expect(players.find((p) => p.id === '7777')!.position).toBe('RB');
  });

  it('stores the normalized name and default aliases', () => {
    const nacua = players.find((p) => p.id === '8138')!;
    expect(nacua.normalizedName).toBe('puka nacua');
    expect(nacua.aliases).toContain('P. Nacua');
  });

  it('prefers injury status over roster status', () => {
    expect(players.find((p) => p.id === '8138')!.status).toBe('Questionable');
  });

  it('is deterministic and ordered by id', () => {
    expect(JSON.stringify(toCanonicalPlayers(RAW_PLAYERS))).toBe(JSON.stringify(players));
  });

  it('tolerates a malformed dump', () => {
    expect(() => toCanonicalPlayers({ x: null as never })).not.toThrow();
  });
});

describe('league and roster transforms', () => {
  it('normalizes a league payload', () => {
    const league = toLeagueRecord(
      {
        league_id: 'L1',
        name: 'Test League',
        season: '2026',
        total_rosters: 12,
        scoring_settings: { rec: 0.5 },
        roster_positions: ['QB', 'RB', 'BN'],
        settings: { playoff_teams: 6 },
        draft_id: 'D1',
      },
      '2026-08-13T00:00:00Z',
    );
    expect(league.id).toBe('L1');
    expect(league.scoringSettings['rec']).toBe(0.5);
    expect(league.draftId).toBe('D1');
  });

  it('marks the connected user roster as mine and resolves owner names', () => {
    const rosters = toRosterRecords(
      'L1',
      [
        { roster_id: 1, owner_id: 'u1', league_id: 'L1', players: ['4046', '8138'], starters: ['4046', '0'] },
        { roster_id: 2, owner_id: 'u2', league_id: 'L1', players: [], starters: null },
      ],
      [
        { user_id: 'u1', username: 'me', display_name: 'Me', avatar: null },
        { user_id: 'u2', username: 'them', display_name: null, avatar: null },
      ],
      'u1',
    );
    expect(rosters[0]!.isMine).toBe(true);
    expect(rosters[0]!.ownerName).toBe('Me');
    expect(rosters[0]!.starterIds).toEqual(['4046']); // the "0" placeholder is dropped
    expect(rosters[1]!.isMine).toBe(false);
    expect(rosters[1]!.ownerName).toBe('them');
  });
});

describe('draft transforms', () => {
  const draft = toDraftRecord(
    {
      draft_id: 'D1',
      league_id: 'L1',
      status: 'drafting',
      type: 'snake',
      season: '2026',
      slot_to_roster_id: { '1': 5, '2': 7 },
      settings: { rounds: 15, teams: 12 },
    },
    '2026-08-13T00:00:00Z',
  );

  it('extracts rounds and teams from settings', () => {
    expect(draft.rounds).toBe(15);
    expect(draft.teams).toBe(12);
  });

  it('maps draft slots to roster ids', () => {
    expect(slotForRoster(draft.slotToRosterId, 7)).toBe(2);
    expect(slotForRoster(draft.slotToRosterId, 99)).toBeNull();
  });

  it('normalizes picks and preserves the raw payload', () => {
    const picks = toDraftPickRecords(
      'D1',
      [
        { draft_id: 'D1', pick_no: 13, round: 2, draft_slot: 12, player_id: '4046', roster_id: 5 },
        { draft_id: 'D1', pick_no: 1, round: 1, draft_slot: 1, player_id: '8138', roster_id: 7 },
      ],
      12,
    );
    expect(picks.map((p) => p.pickNo)).toEqual([1, 13]);
    expect(picks[1]!.pickInRound).toBe(1);
    expect(JSON.parse(picks[1]!.raw).player_id).toBe('4046');
  });

  it('skips picks with no pick number', () => {
    expect(toDraftPickRecords('D1', [{ draft_id: 'D1', pick_no: NaN, round: 1, draft_slot: 1, player_id: null }], 12)).toHaveLength(0);
  });
});

describe('snake draft pick maths', () => {
  it('computes snake pick numbers for a slot', () => {
    // 12-team snake, slot 3: 3, 22, 27, 46...
    expect(pickNumbersForSlot(3, 12, 4, 'snake')).toEqual([3, 22, 27, 46]);
  });

  it('computes linear pick numbers', () => {
    expect(pickNumbersForSlot(3, 12, 3, 'linear')).toEqual([3, 15, 27]);
  });

  it('finds the next pick and the distance to it', () => {
    expect(nextPickForSlot(3, 12, 4, 'snake', 10)).toEqual({ pickNo: 22, picksUntil: 12 });
  });

  it('reports zero distance when you are on the clock', () => {
    expect(nextPickForSlot(3, 12, 4, 'snake', 22)).toEqual({ pickNo: 22, picksUntil: 0 });
  });

  it('returns null once the slot has no picks left', () => {
    expect(nextPickForSlot(3, 12, 4, 'snake', 200)).toBeNull();
  });

  /**
   * The pick a player has to survive to if you pass on him — which is not the
   * pick you are making.
   *
   * The bug: on the clock, survival was measured against the selection being
   * made right now, so every available player came back "100% to reach your
   * next pick". True, useless, and shown at the one moment the number is
   * actually being used to choose somebody.
   */
  describe('the wait horizon', () => {
    it('agrees with your next turn while you are waiting for it', () => {
      expect(waitHorizonForSlot(3, 12, 4, 'snake', 10)).toEqual({ pickNo: 22, picksUntil: 12 });
      expect(waitHorizonForSlot(3, 12, 4, 'snake', 10)).toEqual(nextPickForSlot(3, 12, 4, 'snake', 10));
    });

    it('skips past the pick on the clock to the one after it', () => {
      // Slot 3 in a 12-team snake picks at 3, 22, 27, 46. On the clock at 22,
      // the question is whether he lasts to 27 — not whether he lasts to 22.
      expect(nextPickForSlot(3, 12, 4, 'snake', 22)).toEqual({ pickNo: 22, picksUntil: 0 });
      expect(waitHorizonForSlot(3, 12, 4, 'snake', 22)).toEqual({ pickNo: 27, picksUntil: 5 });
    });

    it('measures the turn correctly, where the wait is shortest', () => {
      // 22 and 27 are back to back at the turn; 27 to 46 is the long wait.
      expect(waitHorizonForSlot(3, 12, 4, 'snake', 27)).toEqual({ pickNo: 46, picksUntil: 19 });
    });

    it('is null on your last selection, because there is nothing after it', () => {
      expect(nextPickForSlot(3, 12, 4, 'snake', 46)).toEqual({ pickNo: 46, picksUntil: 0 });
      expect(waitHorizonForSlot(3, 12, 4, 'snake', 46)).toBeNull();
    });

    it('works the same way in a linear draft', () => {
      expect(waitHorizonForSlot(3, 12, 3, 'linear', 15)).toEqual({ pickNo: 27, picksUntil: 12 });
      expect(waitHorizonForSlot(3, 12, 3, 'linear', 27)).toBeNull();
    });
  });

  it('handles nonsense input without throwing', () => {
    expect(pickNumbersForSlot(0, 12, 4, 'snake')).toEqual([]);
  });
});

describe('scoring profile and roster shape', () => {
  it('labels PPR variants', () => {
    expect(buildScoringProfile({ rec: 1 }, []).label).toBe('Full PPR');
    expect(buildScoringProfile({ rec: 0.5 }, []).label).toBe('Half PPR');
    expect(buildScoringProfile({}, []).label).toBe('Standard');
  });

  it('detects superflex and TE premium', () => {
    expect(buildScoringProfile({ rec: 1 }, ['QB', 'SUPER_FLEX']).superflex).toBe(true);
    expect(buildScoringProfile({ rec: 1, bonus_rec_te: 0.5 }, []).tePremium).toBe(true);
  });

  it('counts starters, flex, bench and IR slots', () => {
    const shape = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'BN', 'BN', 'IR']);
    expect(shape.starters).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1 });
    expect(shape.flex).toHaveLength(2);
    expect(shape.benchSlots).toBe(2);
    expect(shape.irSlots).toBe(1);
    expect(shape.totalStarters).toBe(8);
    expect(shape.superflex).toBe(true);
  });

  it('records which positions each flex slot accepts', () => {
    const shape = buildRosterShape(['FLEX', 'REC_FLEX']);
    expect(shape.flex[0]!.positions).toEqual(['RB', 'WR', 'TE']);
    expect(shape.flex[1]!.positions).toEqual(['WR', 'TE']);
  });
});

// ------------------------------------------------------------- client ------
function stubFetch(handler: (url: string) => { status: number; body: string }) {
  return async (url: string) => {
    const { status, body } = handler(url);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
}

describe('SleeperClient', () => {
  it('fetches and parses a user', async () => {
    const client = new SleeperClient({
      fetch: stubFetch(() => ({ status: 200, body: JSON.stringify({ user_id: 'u1', username: 'me', display_name: 'Me', avatar: null }) })),
    });
    expect((await client.getUserByName('me'))?.user_id).toBe('u1');
  });

  it('returns null for a 404 rather than throwing', async () => {
    const client = new SleeperClient({ fetch: stubFetch(() => ({ status: 404, body: 'not found' })) });
    expect(await client.getUserByName('nobody')).toBeNull();
  });

  it('treats a literal null body as no data', async () => {
    const client = new SleeperClient({ fetch: stubFetch(() => ({ status: 200, body: 'null' })) });
    expect(await client.getLeague('L1')).toBeNull();
  });

  it('returns an empty array for list endpoints with no data', async () => {
    const client = new SleeperClient({ fetch: stubFetch(() => ({ status: 200, body: 'null' })) });
    expect(await client.getDraftPicks('D1')).toEqual([]);
  });

  it('retries a 5xx and then succeeds', async () => {
    let calls = 0;
    const client = new SleeperClient({
      retries: 2,
      fetch: async (_url: string) => {
        calls++;
        if (calls < 3) return new Response('boom', { status: 503 });
        return new Response(JSON.stringify([{ league_id: 'L1', name: 'x', season: '2026' }]), { status: 200 });
      },
    });
    expect(await client.getLeaguesForUser('u1', '2026')).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('does not retry a 4xx', async () => {
    let calls = 0;
    const client = new SleeperClient({
      fetch: async () => {
        calls++;
        return new Response('bad', { status: 400 });
      },
    });
    await expect(client.getLeague('L1')).rejects.toBeInstanceOf(SleeperError);
    expect(calls).toBe(1);
  });
});
