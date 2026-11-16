/**
 * Round 33 Part A: "Check status" when the books pull a player's props near
 * kickoff (audit finding 9). The rule, the read that feeds it (no new query),
 * and the promise that it never moves a number.
 */

import { describe, expect, it } from 'vitest';
import {
  CHECK_STATUS_LABEL,
  CHECK_STATUS_WINDOW_MS,
  checkStatusFor,
  checkStatusReason,
} from '../src/core/startsit/checkStatus.ts';
import { pulledPlayers } from '../src/core/vegas/pulledProps.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { buildWeeklyCard } from '../src/core/startsit/weekCard.ts';
import { rowFigure, rowNote, NO_LINE_YET } from '../src/web/rowFigure.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { candidate } from './helpers/startsit.ts';
import { createTestDb } from './helpers/db.ts';

const KICK = '2026-11-22T21:25:00.000Z'; // Sunday 4:25 PM ET
const kick = Date.parse(KICK);
const H = 3_600_000;
const M = 60_000;
const PULLED = '2026-11-22T20:42:00.000Z'; // 3:42 PM ET

describe('the window: inside 3 hours before kickoff, until the game starts', () => {
  const at = (ms: number) => checkStatusFor({ propsPulledAt: PULLED, kickoff: KICK }, ms);
  it('shows 2 h 59 min out and 1 min out', () => {
    expect(at(kick - 179 * M)).toEqual({ pulledAt: PULLED });
    expect(at(kick - M)).toEqual({ pulledAt: PULLED });
  });
  it('not 3 h 1 min out, not at kickoff, not after', () => {
    expect(at(kick - CHECK_STATUS_WINDOW_MS - M)).toBeNull();
    expect(at(kick)).toBeNull();
    expect(at(kick + H)).toBeNull();
  });
  it('never for a player who had nothing pulled, or no kickoff', () => {
    expect(checkStatusFor({ propsPulledAt: null, kickoff: KICK }, kick - H)).toBeNull();
    expect(checkStatusFor({ propsPulledAt: PULLED, kickoff: null }, kick - H)).toBeNull();
  });
  it('not when the screen already says Out or bye', () => {
    expect(checkStatusFor({ propsPulledAt: PULLED, kickoff: KICK, ruledOut: true }, kick - H)).toBeNull();
    expect(checkStatusFor({ propsPulledAt: PULLED, kickoff: KICK, onBye: true }, kick - H)).toBeNull();
  });
  it('the tap reason is the Eastern time, 12-hour clock', () => {
    expect(checkStatusReason({ pulledAt: PULLED })).toBe('Props pulled at 3:42 PM');
  });
});

describe('who counts as pulled', () => {
  const looks = new Map([
    [
      'g1',
      [
        { fetchedAt: '2026-11-22T18:25:00.000Z', lines: 60 },
        { fetchedAt: PULLED, lines: 55 },
      ],
    ],
  ]);
  it('every line he had is gone: pulled, at the look the last one went', () => {
    const out = pulledPlayers(
      [
        { playerId: 'a', eventId: 'g1', gone: true, fetchedAt: '2026-11-22T18:25:00.000Z' },
        { playerId: 'a', eventId: 'g1', gone: true, fetchedAt: PULLED },
      ],
      looks,
    );
    expect(out.get('a')).toBe(PULLED);
  });
  it('one market gone, another still posted: not pulled', () => {
    const out = pulledPlayers(
      [
        { playerId: 'a', eventId: 'g1', gone: true, fetchedAt: PULLED },
        { playerId: 'a', eventId: 'g1', gone: false, fetchedAt: '2026-11-22T18:25:00.000Z' },
      ],
      looks,
    );
    expect(out.has('a')).toBe(false);
  });
  it('never had a line (no rows at all): not pulled', () => {
    expect(pulledPlayers([], looks).size).toBe(0);
  });
  it('a look that came back nearly empty is a feed problem, not a scratch', () => {
    const thin = new Map([
      [
        'g1',
        [
          { fetchedAt: '2026-11-22T18:25:00.000Z', lines: 60 },
          { fetchedAt: PULLED, lines: 4 },
        ],
      ],
    ]);
    expect(pulledPlayers([{ playerId: 'a', eventId: 'g1', gone: true, fetchedAt: PULLED }], thin).size).toBe(0);
    const empty = new Map([['g1', [{ fetchedAt: PULLED, lines: 0 }]]]);
    expect(pulledPlayers([{ playerId: 'a', eventId: 'g1', gone: true, fetchedAt: PULLED }], empty).size).toBe(0);
  });
});

describe('the props read reports pulled players from the rows it already reads', () => {
  async function world() {
    const db = await createTestDb();
    for (const id of ['p-a', 'p-b', 'p-c']) {
      await db
        .prepare(`INSERT INTO players (id, full_name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, '2026-11-01', '2026-11-01')`)
        .bind(id, id, id)
        .run();
    }
    const repo = new PropsRepo(db);
    const look = async (fetchedAt: string, lines: { player: string; market: string; line: number | null }[], quotes: number) => {
      await repo.put({
        provider: 'sgo',
        eventId: 'g1',
        gameStart: KICK,
        fetchedAt,
        raw: {
          provider: 'sgo',
          eventId: 'g1',
          gameStart: KICK,
          fetchedAt,
          quotes: Array.from({ length: quotes }, (_, i) => ({ playerName: `x${i}`, market: 'receptions', line: 3.5 })),
          raw: null,
          delta: true,
        } as never,
      });
      const id = (await repo.snapshotId('sgo', 'g1', fetchedAt))!;
      await repo.saveChanges(
        id,
        lines.map((l) => ({
          playerId: l.player,
          sourcePlayerName: l.player,
          market: l.market as never,
          line: l.line,
          overPrice: null,
          underPrice: null,
          bookCount: l.line == null ? 0 : 3,
          consensusMethod: (l.line == null ? 'none' : 'average') as never,
          books: [],
          impliedProbability: null,
        })),
      );
    };
    return { repo, look };
  }
  const window = { from: '2026-11-19T00:00:00.000Z', to: '2026-11-24T12:00:00.000Z' };

  it('a: all lines pulled; b: one of two pulled; c: never priced', async () => {
    const { repo, look } = await world();
    await look(
      '2026-11-22T18:25:00.000Z',
      [
        { player: 'p-a', market: 'receiving_yards', line: 55.5 },
        { player: 'p-a', market: 'receptions', line: 4.5 },
        { player: 'p-b', market: 'rush_yards', line: 60.5 },
        { player: 'p-b', market: 'receptions', line: 2.5 },
      ],
      60,
    );
    await look(
      PULLED,
      [
        { player: 'p-a', market: 'receiving_yards', line: null },
        { player: 'p-a', market: 'receptions', line: null },
        { player: 'p-b', market: 'receptions', line: null },
      ],
      56,
    );
    const { lines, pulled } = await repo.latestWithPulled(['p-a', 'p-b', 'p-c'], window);
    expect(pulled.get('p-a')).toBe(PULLED);
    expect(pulled.has('p-b')).toBe(false);
    expect(pulled.has('p-c')).toBe(false);
    // The lines a screen reads are unchanged by it.
    expect(lines.has('p-a')).toBe(false);
    expect(lines.get('p-b')?.map((p) => p.market)).toEqual(['rush_yards']);
    expect(await repo.latestForPlayers(['p-a', 'p-b'], window)).toEqual(lines);
  });
});

describe('it only warns: the number and the pick do not move', () => {
  const PROFILE = buildScoringProfile({ rec: 0.5 }, ['QB', 'RB', 'WR', 'TE', 'BN']);
  const now = new Date(kick - H).toISOString();
  it('same score, same everything, plus the chip', () => {
    const base = candidate('wr1', 'Receiver One', 'WR', 12, { kickoff: KICK, now });
    const plain = evaluatePlayer(base, PROFILE);
    const flagged = evaluatePlayer({ ...base, propsPulledAt: PULLED }, PROFILE);
    expect(flagged.checkStatus).toEqual({ pulledAt: PULLED });
    expect(plain.checkStatus).toBeUndefined();
    const { checkStatus: _drop, ...rest } = flagged;
    expect(rest).toEqual(plain);
  });

  it('the Team row says Check status where it would have said No line yet; the card says when', () => {
    const evaluation = {
      ruledOut: false,
      decision: { basis: 'published' },
      lock: { locked: false, kickoff: KICK },
      checkStatus: { pulledAt: PULLED },
    };
    const figure = rowFigure(9.4, evaluation);
    expect(rowNote(figure, evaluation, kick - H)).toBe(CHECK_STATUS_LABEL);
    expect(rowNote(figure, { ...evaluation, checkStatus: null }, kick - H)).toBe(NO_LINE_YET);
    // Past kickoff, a page left open drops it.
    expect(rowNote(figure, evaluation, kick + M)).not.toBe(CHECK_STATUS_LABEL);

    const card = buildWeeklyCard({
      playerId: 'wr1',
      name: 'Receiver One',
      position: 'WR',
      team: 'KC',
      score: 9.4,
      confidence: 'low',
      statusFlag: null,
      ruledOut: false,
      checkStatus: { pulledAt: PULLED },
    } as never, { starting: true });
    expect(card.lines[0]).toMatchObject({ key: 'check-status', label: 'Check status', value: 'Props pulled at 3:42 PM' });
  });
});
