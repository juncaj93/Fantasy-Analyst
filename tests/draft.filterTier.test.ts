/**
 * A tier is a fact about the draft, not about the chip the reader tapped.
 *
 * The reported symptom: filter the board — by position, by FLX, by the ★ queue
 * — and the tier a player shows stops matching the tier the same player shows
 * on the unfiltered board. It is the worst kind of wrong number, because both
 * screens look authoritative and the reader is choosing between them with a
 * clock running.
 *
 * The cause was one line of plumbing. `rankAvailablePlayers` builds a ladder
 * per position from the array it is handed, and the board handed it
 * `candidates` — what survived the *filter*. So the ★ queue with three backs in
 * it produced a three-player running-back position: the best of them alone at
 * the top of a tier with nothing below him, no boundary, no cliff, and the
 * 8-pick hole underneath him — the one thing worth knowing at that moment —
 * simply absent. Filtering to a position did the same thing more quietly: the
 * cap is applied after the filter, so a QB board reaches deeper into the
 * quarterbacks than the whole-board cut does, and the extra rungs moved the
 * groups above them.
 *
 * The fix names the pool a ladder belongs to (`marketPool`) separately from the
 * rows being scored, and the assertion here is the strongest one available: for
 * every player who appears on both boards, the *whole* tier assessment is
 * identical, field for field. Not the tier index, not the severity — the
 * object, including the message the chip prints.
 *
 * A weaker test would have passed against the bug. On a small pool the filtered
 * and unfiltered ladders often agree by luck, so the fixture is deliberately
 * deeper than the candidate cap: 500 priced players, so that a
 * position-filtered board really does see rungs the unfiltered board never
 * reaches.
 */

import { describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { DraftQueueRepo } from '../src/server/repos/draftQueue.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { DraftBoardService, MAX_CANDIDATES, UNDERDOG_SOURCE_KEY } from '../src/server/services/draftBoard.ts';
import type { BoardRecommendation } from '../src/server/services/draftBoard.ts';
import type { Database } from '../src/server/db.ts';

/** Deeper than the cap, so a one-position board outruns the whole-board cut. */
const PRICED = 500;
/** Players Sleeper knows and no ranking has priced, as in a real pool. */
const UNPRICED = 60;

function positionFor(i: number): string {
  const cycle = i % 10;
  if (cycle < 1) return 'QB';
  if (cycle < 4) return 'RB';
  if (cycle < 8) return 'WR';
  return 'TE';
}

async function fixture(): Promise<Database> {
  const db = await createTestDb();
  const players = new PlayerRepo(db);
  const leagues = new LeagueRepo(db);

  const priced: string[] = [];
  const rows: ReturnType<typeof player>[] = [];
  for (let i = 0; i < PRICED; i++) {
    const name = `Priced Player${String(i).padStart(3, '0')}`;
    priced.push(name);
    rows.push(player({ id: `p${i}`, fullName: name, position: positionFor(i), team: 'KC', searchRank: i + 1 }));
  }
  for (let i = 0; i < UNPRICED; i++) {
    rows.push(
      player({
        id: `u${i}`,
        fullName: `Unpriced Player${String(i).padStart(3, '0')}`,
        position: positionFor(i),
        team: 'SF',
        searchRank: 900 + i,
      }),
    );
  }
  /*
   * Defences, priced by both markets and priced *differently* by them.
   *
   * They are here for a trap the repair could have walked into. A defence is
   * ranked with its second market stripped, so his row is looked up by
   * Sleeper's own number — and a ladder built from the blend would then have no
   * rung at that number and quietly report no tier at all. Underdog therefore
   * has to disagree with Sleeper about them, or the two ladders coincide and
   * the test proves nothing.
   */
  const defences = ['Denver', 'Baltimore', 'Cleveland', 'Jacksonville', 'Tennessee', 'Seattle'];
  defences.forEach((name, i) => {
    rows.push(player({ id: `d${i}`, fullName: `${name} Defence`, position: 'DEF', team: 'KC', searchRank: 600 + i }));
  });
  await players.upsertMany(rows);

  await leagues.upsertLeague({
    id: 'filtered',
    sleeperLeagueId: 'filtered',
    name: 'Filtered',
    season: '2026',
    totalRosters: 12,
    scoringSettings: { rec: 0.5 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN', 'BN', 'BN'],
    leagueSettings: {},
    draftId: 'filtered-draft',
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.selectLeague('filtered');
  await leagues.upsertDraft({
    id: 'filtered-draft',
    sleeperDraftId: 'filtered-draft',
    leagueId: 'filtered',
    status: 'drafting',
    type: 'snake',
    season: '2026',
    rounds: 16,
    teams: 12,
    slotToRosterId: {},
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });

  /*
   * ADP 1..500, one per player, with a deliberate hole after every third back:
   * a ladder with no gaps in it has no tiers to disagree about, so a fixture
   * without one could not fail however broken the plumbing was.
   */
  const csv = [
    'Player,Position,Team,ADP',
    ...priced.map((name, i) => `${name},${positionFor(i)},KC,${i + 1 + Math.floor(i / 30) * 6}`),
    ...defences.map((name, i) => `${name} Defence,DEF,KC,${150 + i * 9}`),
  ].join('\n');
  const index = await players.buildIndex();
  const adp = new AdpRepo(db);
  const { snapshot } = await adp.save(
    importAdpSnapshot(csv, index, { label: 'deep ranking', source: 'test' }),
    '2026',
  );
  await leagues.setDraftSnapshot('filtered-draft', snapshot.id);

  // The second market, which prices the same players a few picks apart.
  const dogCsv = [
    'Player,Position,Team,ADP',
    ...priced.map((name, i) => `${name},${positionFor(i)},KC,${i + 3 + Math.floor(i / 30) * 6}`),
    ...defences.map((name, i) => `${name} Defence,DEF,KC,${141 + i * 9}`),
  ].join('\n');
  await adp.save(importAdpSnapshot(dogCsv, index, { label: 'underdog', source: UNDERDOG_SOURCE_KEY }), '2026');
  return db;
}

const board = (db: Database, opts: { position?: string; queuedOnly?: boolean } = {}) =>
  new DraftBoardService(db).build('filtered-draft', { limit: 400, ...opts });

/**
 * Every player the two boards share, with both readings of him.
 *
 * Returns the pairs rather than asserting inside the loop so a failure names
 * how many players disagreed and not merely the first.
 */
function shared(
  full: { recommendations: BoardRecommendation[] },
  filtered: { recommendations: BoardRecommendation[] },
): { unfiltered: BoardRecommendation; filtered: BoardRecommendation }[] {
  const byId = new Map(full.recommendations.map((rec) => [rec.playerId, rec]));
  return filtered.recommendations.flatMap((rec) => {
    const match = byId.get(rec.playerId);
    return match ? [{ unfiltered: match, filtered: rec }] : [];
  });
}

function tierDisagreements(pairs: ReturnType<typeof shared>): string[] {
  return pairs
    .filter((pair) => JSON.stringify(pair.unfiltered.tierCliff) !== JSON.stringify(pair.filtered.tierCliff))
    .map(
      (pair) =>
        `${pair.filtered.name}: unfiltered ${JSON.stringify(pair.unfiltered.tierCliff)} vs filtered ${JSON.stringify(pair.filtered.tierCliff)}`,
    );
}

describe('the tier a player shows does not depend on the filter', () => {
  it('reads the same under a position filter', async () => {
    const db = await fixture();
    const full = await board(db);
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      const only = await board(db, { position });
      const pairs = shared(full, only);
      // A filter that shares nothing with the whole board would pass every
      // assertion below without testing anything.
      expect(pairs.length, `${position} shared no players with the board`).toBeGreaterThan(5);
      expect(tierDisagreements(pairs), `${position} disagreed with the whole board`).toEqual([]);
    }
  });

  /**
   * A defence is looked up by Sleeper's number alone, so his rung must be
   * built from it.
   *
   * Filtered or not, and on either board: he keeps a real tier. The assertion
   * that bites is the second one — a ladder built from the blend has no rung at
   * the number the row is queried with, so every defence would come back with
   * no tier at all rather than with a wrong one.
   */
  it('keeps a defence on his own rung, where the two markets disagree', async () => {
    const db = await fixture();
    const full = await board(db);
    const only = await board(db, { position: 'DEF' });

    const defences = full.recommendations.filter((rec) => rec.position === 'DEF');
    expect(defences.length).toBeGreaterThan(3);
    for (const rec of defences) {
      expect(rec.dogAdp, `${rec.name} carried a second market`).toBeNull();
      expect(rec.tierCliff.tierIndex, `${rec.name} landed on no rung`).not.toBeNull();
    }
    expect(tierDisagreements(shared(full, only))).toEqual([]);
  });

  /** The one chip that spans positions, and so mixes several ladders at once. */
  it('reads the same under the FLX filter', async () => {
    const db = await fixture();
    const full = await board(db);
    const flx = await board(db, { position: 'FLX' });
    const pairs = shared(full, flx);
    expect(new Set(pairs.map((p) => p.filtered.position))).toEqual(new Set(['RB', 'WR', 'TE']));
    expect(tierDisagreements(pairs)).toEqual([]);
  });

  /**
   * The ★ queue, which is the sharpest version of the bug: a handful of players
   * became a whole position, and the cliff under the best of them vanished.
   */
  it('reads the same under the ★ queue filter', async () => {
    const db = await fixture();
    const full = await board(db);
    const queue = new DraftQueueRepo(db);
    const starred = [
      ...full.recommendations.filter((r) => r.position === 'RB').slice(0, 3),
      ...full.recommendations.filter((r) => r.position === 'WR').slice(0, 2),
      ...full.recommendations.filter((r) => r.position === 'QB').slice(0, 1),
    ];
    for (const rec of starred) await queue.setQueued('filtered-draft', rec.playerId, true);

    const queued = await board(db, { queuedOnly: true });
    expect(queued.recommendations.length).toBe(starred.length);
    expect(tierDisagreements(shared(full, queued))).toEqual([]);

    // The claim with teeth: at least one of those players is in a tier with
    // other players in it, which a board built from the queue alone could not
    // have said — it only ever saw the six.
    const sizes = queued.recommendations.map((rec) => rec.tierCliff.tierSize);
    expect(Math.max(...sizes)).toBeGreaterThan(starred.length);
  });

  /**
   * The unfiltered board is untouched by the repair.
   *
   * Filtering now reads the pool the whole board reads, and unfiltered those
   * are the same array — so this is a statement about the fix's blast radius:
   * it changes what a *filtered* board says and nothing else. Two builds of the
   * same board are compared field for field, which also pins the determinism
   * the poll depends on.
   */
  it('leaves the unfiltered board exactly as it was', async () => {
    const db = await fixture();
    const [a, b] = await Promise.all([board(db), board(db)]);
    expect(a.recommendations.length).toBe(Math.min(PRICED + UNPRICED, MAX_CANDIDATES));
    expect(b.recommendations.map((rec) => rec.tierCliff)).toEqual(a.recommendations.map((rec) => rec.tierCliff));
  });
});
