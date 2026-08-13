/**
 * Integration tests: real SQL against the production schema, exercising the
 * repositories and services exactly as the worker does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { toEmailMessage } from '../src/core/newsletter/source.ts';
import { SleeperClient } from '../src/core/sleeper/client.ts';
import { toCanonicalPlayers } from '../src/core/sleeper/transform.ts';
import type { SleeperPlayer } from '../src/core/sleeper/types.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { EvidenceRepo } from '../src/server/repos/evidence.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterService } from '../src/server/services/newsletterService.ts';
import { SleeperSyncService } from '../src/server/services/sleeperSync.ts';
import { createTestDb } from './helpers/db.ts';
import { TEST_PLAYERS } from './helpers/players.ts';
import { CLEAN_NEWSLETTER, SURNAME_COLLISION } from './fixtures/newsletters.ts';

const SOURCES = [
  { id: 'ff', label: 'FF Newsletter', fromPatterns: ['@ffnewsletter.example'], subjectPatterns: [], enabled: true },
];

function newsletterMessage(html = CLEAN_NEWSLETTER, messageId = 'msg-1') {
  return toEmailMessage({
    messageId,
    from: 'editor@ffnewsletter.example',
    subject: 'Training Camp Notes',
    date: '2026-08-13T12:00:00.000Z',
    html,
  });
}

describe('PlayerRepo', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('round-trips canonical players', async () => {
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    expect(await repo.count()).toBe(TEST_PLAYERS.length);
    const loaded = await repo.getById('10');
    expect(loaded?.fullName).toBe('Bijan Robinson');
    expect(loaded?.aliases).toContain('B. Rob');
  });

  it('is idempotent on re-sync and updates changed fields', async () => {
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    await repo.upsertMany(TEST_PLAYERS.map((p) => (p.id === '10' ? { ...p, team: 'SEA' } : p)));
    expect(await repo.count()).toBe(TEST_PLAYERS.length);
    expect((await repo.getById('10'))?.team).toBe('SEA');
  });

  it('builds a working index from the database', async () => {
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    const index = await repo.buildIndex();
    expect(index.byNormalizedName('puka nacua')).toHaveLength(1);
  });

  it('merges user aliases into the index without overwriting sync aliases', async () => {
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    await repo.addAlias('11', 'Puk', 'puk', 'user');
    await repo.upsertMany(TEST_PLAYERS); // re-sync must not remove it
    const index = await repo.buildIndex();
    expect(index.byAliasKey('puk')).toHaveLength(1);
  });

  it('searches by name fragment', async () => {
    const repo = new PlayerRepo(db);
    await repo.upsertMany(TEST_PLAYERS);
    expect((await repo.search('nacua')).map((p) => p.id)).toEqual(['11']);
  });
});

describe('SleeperSyncService', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  const RAW: Record<string, SleeperPlayer> = {
    '4046': { player_id: '4046', full_name: 'Patrick Mahomes', first_name: 'Patrick', last_name: 'Mahomes', team: 'KC', position: 'QB', active: true },
    '8138': { player_id: '8138', full_name: 'Puka Nacua', first_name: 'Puka', last_name: 'Nacua', team: 'LAR', position: 'WR', active: true },
  };

  function client(routes: Record<string, unknown>) {
    return new SleeperClient({
      fetch: async (url: string) => {
        const key = Object.keys(routes).find((k) => url.includes(k));
        return new Response(JSON.stringify(key ? routes[key] : null), { status: 200 });
      },
    });
  }

  it('syncs the player dictionary and logs the run', async () => {
    const service = new SleeperSyncService(db, client({ '/players/nfl': RAW }));
    const result = await service.syncPlayers();
    expect(result.written).toBe(2);
    expect(await new PlayerRepo(db).count()).toBe(2);
  });

  it('connects a user and imports their leagues', async () => {
    const service = new SleeperSyncService(
      db,
      client({
        '/user/me': { user_id: 'u1', username: 'me', display_name: 'Me' },
        '/leagues/nfl/2026': [
          { league_id: 'L1', name: 'League One', season: '2026', total_rosters: 12, roster_positions: ['QB', 'BN'], scoring_settings: { rec: 0.5 } },
        ],
      }),
    );
    await service.connectUser('me');
    expect((await service.syncLeagues('2026')).imported).toBe(1);
    expect((await new LeagueRepo(db).listLeagues())[0]?.name).toBe('League One');
  });

  it('syncs a league with rosters and identifies my team', async () => {
    const service = new SleeperSyncService(
      db,
      client({
        '/user/me': { user_id: 'u1', username: 'me', display_name: 'Me' },
        '/league/L1/rosters': [{ roster_id: 1, owner_id: 'u1', league_id: 'L1', players: ['4046'], starters: ['4046'] }],
        '/league/L1/users': [{ user_id: 'u1', username: 'me', display_name: 'Me' }],
        '/league/L1/drafts': [{ draft_id: 'D1', league_id: 'L1', status: 'pre_draft', type: 'snake', season: '2026', settings: { rounds: 15, teams: 12 } }],
        '/league/L1': { league_id: 'L1', name: 'League One', season: '2026', total_rosters: 12, roster_positions: ['QB', 'BN'], scoring_settings: {} },
      }),
    );
    await service.connectUser('me');
    const result = await service.syncLeague('L1');
    expect(result.rosters).toBe(1);
    expect(result.drafts).toBe(1);
    const rosters = await new LeagueRepo(db).listRosters('L1');
    expect(rosters[0]?.isMine).toBe(true);
  });

  it('syncs draft picks idempotently', async () => {
    const picks = [
      { draft_id: 'D1', pick_no: 1, round: 1, draft_slot: 1, player_id: '4046', roster_id: 1 },
      { draft_id: 'D1', pick_no: 2, round: 1, draft_slot: 2, player_id: '8138', roster_id: 2 },
    ];
    const service = new SleeperSyncService(
      db,
      client({
        '/draft/D1/picks': picks,
        '/draft/D1': { draft_id: 'D1', league_id: 'L1', status: 'drafting', type: 'snake', season: '2026', settings: { rounds: 15, teams: 12 } },
      }),
    );
    await new LeagueRepo(db).upsertLeague({
      id: 'L1', sleeperLeagueId: 'L1', name: 'L', season: '2026', totalRosters: 12,
      scoringSettings: {}, rosterPositions: [], leagueSettings: {}, draftId: 'D1', lastSyncedAt: '2026-01-01T00:00:00Z',
    });
    const first = await service.syncDraft('D1');
    const second = await service.syncDraft('D1');
    expect(first.picks).toBe(2);
    expect(second.picks).toBe(2);
    expect(await new LeagueRepo(db).listPicks('D1')).toHaveLength(2);
  });

  it('backs off polling once the draft is complete', () => {
    expect(SleeperSyncService.pollIntervalSeconds('drafting')).toBe(5);
    expect(SleeperSyncService.pollIntervalSeconds('pre_draft')).toBe(60);
    expect(SleeperSyncService.pollIntervalSeconds('complete')).toBe(0);
  });
});

describe('AdpRepo', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
  });

  const CSV = 'name,position,team,adp\nBijan Robinson,RB,ATL,2.4\nPuka Nacua,WR,LAR,7.8\nGhost Player,WR,SEA,99\n';

  it('persists a snapshot with its rows and match status', async () => {
    const index = await new PlayerRepo(db).buildIndex();
    const repo = new AdpRepo(db);
    const { snapshot, created } = await repo.save(importAdpSnapshot(CSV, index));
    expect(created).toBe(true);
    expect(snapshot.rowCount).toBe(3);
    expect(snapshot.matchedCount).toBe(2);
    const values = await repo.valuesByPlayer(snapshot.id);
    expect(values.get('10')?.adp).toBe(2.4);
  });

  it('does not duplicate an identical re-import (frozen snapshot)', async () => {
    const index = await new PlayerRepo(db).buildIndex();
    const repo = new AdpRepo(db);
    const first = await repo.save(importAdpSnapshot(CSV, index));
    const second = await repo.save(importAdpSnapshot(CSV, index));
    expect(second.created).toBe(false);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(await repo.list()).toHaveLength(1);
  });

  it('creates a separate snapshot for different content', async () => {
    const index = await new PlayerRepo(db).buildIndex();
    const repo = new AdpRepo(db);
    await repo.save(importAdpSnapshot(CSV, index));
    await repo.save(importAdpSnapshot(`${CSV}Jordan Love,QB,GB,120\n`, index));
    expect(await repo.list()).toHaveLength(2);
  });

  it('exposes unresolved rows and lets the user resolve them', async () => {
    const index = await new PlayerRepo(db).buildIndex();
    const repo = new AdpRepo(db);
    const { snapshot } = await repo.save(importAdpSnapshot(CSV, index));
    const unresolved = await repo.unresolvedRows(snapshot.id);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.sourcePlayerName).toBe('Ghost Player');

    await repo.resolveRow(unresolved[0]!.id, '9');
    expect((await repo.valuesByPlayer(snapshot.id)).get('9')?.adp).toBe(99);
  });
});

describe('NewsletterService', () => {
  let db: NodeSqliteDatabase;
  let service: NewsletterService;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    service = new NewsletterService(db);
    await service.setSources(SOURCES);
  });

  it('ingests a qualifying newsletter and stores evidence', async () => {
    const outcome = await service.ingest(newsletterMessage());
    expect(outcome.status).toBe('processed');
    expect(outcome.evidenceInserted).toBeGreaterThan(0);
    expect(await new EvidenceRepo(db).countAll()).toBe(outcome.evidenceInserted);
  });

  it('quarantines a non-qualifying sender without creating evidence', async () => {
    const message = toEmailMessage({ messageId: 'x', from: 'spam@elsewhere.example', subject: 'Buy now', html: CLEAN_NEWSLETTER });
    const outcome = await service.ingest(message);
    expect(outcome.status).toBe('quarantined');
    expect(await new EvidenceRepo(db).countAll()).toBe(0);
  });

  it('still logs a quarantined email so the user can see something arrived', async () => {
    await service.ingest(
      toEmailMessage({ messageId: 'x', from: 'spam@elsewhere.example', subject: 'Buy now', html: CLEAN_NEWSLETTER }),
    );
    const repo = new NewsletterRepo(db);
    const last = await repo.lastReceived();
    expect(last?.status).toBe('quarantined');
    expect(last?.fromAddress).toBe('spam@elsewhere.example');
    expect(last?.rejectReason).toContain('Unexpected sender');
    expect(await repo.lastProcessed()).toBeNull();
  });

  it('does not reprocess a quarantined message id', async () => {
    const message = toEmailMessage({ messageId: 'x', from: 'spam@elsewhere.example', subject: 'Buy now', html: CLEAN_NEWSLETTER });
    await service.ingest(message);
    expect((await service.ingest(message)).status).toBe('duplicate');
  });

  it('rejects an oversized email rather than parsing it', async () => {
    const huge = `<p>${'x'.repeat(2_000_050)}</p>`;
    const outcome = await service.ingest(
      toEmailMessage({ messageId: 'big', from: 'editor@ffnewsletter.example', subject: 'Camp', html: huge }),
    );
    expect(outcome.status).toBe('rejected');
    expect(await new EvidenceRepo(db).countAll()).toBe(0);
    expect((await new NewsletterRepo(db).lastReceived())?.status).toBe('rejected');
  });

  it('records a plain-language outcome and coverage for a processed newsletter', async () => {
    await service.ingest(newsletterMessage());
    const last = await new NewsletterRepo(db).lastProcessed();
    expect(last?.status).toBe('processed');
    expect(last?.detail).toMatch(/Found news on \d+ player/);
    expect(last?.autoAppliedCount).toBeGreaterThanOrEqual(0);
    expect(last?.coverage).toBeTruthy();
    expect(Number((last?.coverage as Record<string, number>)['sentencesWithPlayers'])).toBeGreaterThan(0);
  });

  it('processes a non-qualifying message when explicitly forced', async () => {
    const message = toEmailMessage({ messageId: 'x', from: 'me@manual.example', subject: 'pasted', html: CLEAN_NEWSLETTER });
    expect((await service.ingest(message, { force: true })).status).toBe('processed');
  });

  it('is idempotent for the same message id', async () => {
    await service.ingest(newsletterMessage());
    const before = await new EvidenceRepo(db).countAll();
    const second = await service.ingest(newsletterMessage());
    expect(second.status).toBe('duplicate');
    expect(await new EvidenceRepo(db).countAll()).toBe(before);
  });

  it('detects a resend of identical content under a new message id', async () => {
    await service.ingest(newsletterMessage());
    const second = await service.ingest(newsletterMessage(CLEAN_NEWSLETTER, 'msg-2'));
    expect(second.status).toBe('duplicate');
    expect(second.detail).toContain('already read');
  });

  it('does not duplicate evidence when reprocessing', async () => {
    await service.ingest(newsletterMessage());
    const before = await new EvidenceRepo(db).countAll();
    const result = await service.reprocess(newsletterMessage());
    expect(result.evidenceInserted).toBe(0);
    expect(await new EvidenceRepo(db).countAll()).toBe(before);
  });

  it('preserves a user override through reprocessing', async () => {
    await service.ingest(newsletterMessage());
    const repo = new EvidenceRepo(db);
    const pending = await repo.listPending();
    const target = pending[0]!;
    await repo.applyReview(Number(target.id), 'correct', { polarity: 'negative', magnitude: 3 });

    await service.reprocess(newsletterMessage());

    const after = await repo.getById(Number(target.id));
    expect(after?.userOverride).toEqual({ polarity: 'negative', magnitude: 3 });
    expect(after?.reviewStatus).toBe('corrected');
  });

  it('routes ambiguous identities to the review queue', async () => {
    await service.ingest(newsletterMessage(SURNAME_COLLISION, 'msg-collision'));
    const reviews = await new NewsletterRepo(db).listIdentityReviews();
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0]?.candidates.length).toBeGreaterThan(1);
  });

  it('does not duplicate identity reviews on re-ingestion', async () => {
    await service.ingest(newsletterMessage(SURNAME_COLLISION, 'msg-c1'));
    const first = (await new NewsletterRepo(db).listIdentityReviews()).length;
    await service.reprocess(newsletterMessage(SURNAME_COLLISION, 'msg-c1'));
    const repo = new NewsletterRepo(db);
    await repo.insertIdentityReviews([]);
    expect((await repo.listIdentityReviews()).length).toBe(first);
  });
});

describe('EvidenceRepo review flow', () => {
  let db: NodeSqliteDatabase;
  let repo: EvidenceRepo;

  beforeEach(async () => {
    db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    const service = new NewsletterService(db);
    await service.setSources(SOURCES);
    await service.ingest(newsletterMessage());
    repo = new EvidenceRepo(db);
  });

  it('accepting an item moves it out of pending and into the ledger totals', async () => {
    const target = (await repo.listPending())[0]!;
    const before = await repo.refreshSignal(target.playerId);
    expect(before.pendingCount).toBeGreaterThan(0);

    await repo.applyReview(Number(target.id), 'accept', null);

    const after = await repo.refreshSignal(target.playerId);
    expect(after.raw.items).toBe(before.raw.items + 1);
    expect(after.pendingCount).toBe(before.pendingCount - 1);
  });

  it('accepting a mixed item counts it without moving the net', async () => {
    const mixed = (await repo.listPending()).find((p) => p.polarity === 'mixed')!;
    const before = await repo.refreshSignal(mixed.playerId);
    await repo.applyReview(Number(mixed.id), 'accept', null);
    const after = await repo.refreshSignal(mixed.playerId);
    expect(after.raw.net).toBe(before.raw.net);
    expect(after.mixedCount).toBe(before.mixedCount + 1);
  });

  it('rejecting an item keeps it in the ledger but out of the tally', async () => {
    const target = (await repo.listPending())[0]!;
    await repo.applyReview(Number(target.id), 'reject', null);
    const stored = await repo.getById(Number(target.id));
    expect(stored?.reviewStatus).toBe('rejected');
    const signal = await repo.refreshSignal(target.playerId);
    expect(signal.raw.items).toBe(
      (await repo.listForPlayer(target.playerId)).filter((i) => ['auto_applied', 'accepted', 'corrected'].includes(i.reviewStatus)).length,
    );
  });

  it('records every correction in the history table', async () => {
    const target = (await repo.listPending())[0]!;
    await repo.applyReview(Number(target.id), 'correct', { polarity: 'negative', magnitude: 2 });
    const history = await db.prepare('SELECT * FROM user_reviews WHERE evidence_item_id = ?').bind(Number(target.id)).all();
    expect(history.results).toHaveLength(1);
    expect(String(history.results[0]!['action'])).toBe('correct');
  });

  it('lets a correction reassign the player and follows it in the tally', async () => {
    // Player 3 has no evidence from this newsletter, so the tally is unambiguous.
    expect((await repo.refreshSignal('3')).raw.items).toBe(0);
    const target = (await repo.listPending())[0]!;
    await repo.applyReview(Number(target.id), 'correct', { playerId: '3', polarity: 'positive', magnitude: 2 });
    expect((await repo.refreshSignal('3')).raw.net).toBe(2);
  });

  it('persists and reads back the derived signal cache', async () => {
    const target = (await repo.listPending())[0]!;
    await repo.applyReview(Number(target.id), 'accept', null);
    await repo.refreshAllSignals();
    const signals = await repo.getSignals([target.playerId]);
    expect(signals.get(target.playerId)?.raw.items).toBeGreaterThan(0);
  });

  it('returns null when reviewing a non-existent item', async () => {
    expect(await repo.applyReview(999999, 'accept', null)).toBeNull();
  });
});

describe('schema guarantees', () => {
  it('rejects duplicate evidence dedupe keys at the database level', async () => {
    const db = await createTestDb();
    await new PlayerRepo(db).upsertMany(TEST_PLAYERS);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO evidence_items (dedupe_key, player_id, source_type, source_name, source_date, excerpt, polarity, magnitude, confidence, confidence_score, review_status, created_at, updated_at)
           VALUES ('k1','10','newsletter','x','2026-01-01','e','positive',1,'high',0.9,'pending','2026-01-01','2026-01-01')`,
        )
        .run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('stores canonical players keyed by sleeper id', async () => {
    const db = await createTestDb();
    const players = toCanonicalPlayers({
      '4046': { player_id: '4046', full_name: 'Patrick Mahomes', first_name: 'P', last_name: 'M', team: 'KC', position: 'QB', active: true },
    });
    await new PlayerRepo(db).upsertMany(players);
    const row = await db.prepare('SELECT sleeper_player_id FROM players WHERE id = ?').bind('4046').first<{ sleeper_player_id: string }>();
    expect(row?.sleeper_player_id).toBe('4046');
  });
});
