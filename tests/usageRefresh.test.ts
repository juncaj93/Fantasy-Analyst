/**
 * Checking a weekly file daily without paying for it daily.
 *
 * The same three things the injury pipeline refuses to conflate, refused again:
 * the *file* changing, a *row* changing, and a *number this app reads*
 * changing. Only the third may cost a write — and for usage the third stops
 * happening almost immediately, because a game's target count settles within a
 * day or two of the game and then never moves again. A pipeline that rewrote
 * ~350 rows every morning for a season that is no longer changing would spend
 * sixty thousand D1 writes to record nothing.
 *
 * And one thing the injury pipeline does not have to care about: a season that
 * has not started yet is the *normal* state for four months of the year, and it
 * must look like a fact rather than an outage.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { UsageService, DAILY_WRITE_CEILING, MINIMUM_GAMES, usageSeason } from '../src/server/services/usageService.ts';
import { UsageRepo, UsageSourceRepo } from '../src/server/repos/usage.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { diffUsage, type ComparableUsage } from '../src/core/usage/diff.ts';
import type { Database } from '../src/server/db.ts';
import { player } from './helpers/players.ts';

const SEASON = '2026';
const SOURCE = 'nflverse';

/**
 * The real column order, trimmed to the columns under test plus the two traps.
 *
 * `headshot_url` is here because it is the reason this file cannot be split on
 * commas, and a fixture without it would test a file that does not exist.
 */
const HEADER = [
  'player_id',
  'player_name',
  'player_display_name',
  'position',
  'position_group',
  'headshot_url',
  'season',
  'week',
  'season_type',
  'team',
  'attempts',
  'carries',
  'targets',
  'receptions',
  'target_share',
  'wopr',
].join(',');

interface Row {
  gsis?: string;
  name: string;
  position?: string;
  week: number;
  seasonType?: string;
  attempts?: number;
  carries?: number;
  targets?: number;
  receptions?: number;
  targetShare?: number | null;
  wopr?: number | null;
}

function csv(rows: Row[]): string {
  return [
    HEADER,
    ...rows.map((r) =>
      [
        r.gsis ?? '',
        r.name,
        r.name,
        r.position ?? 'WR',
        r.position ?? 'WR',
        // The quoted comma, exactly as the real file writes it.
        '"https://static.www.nfl.com/image/upload/f_auto,q_auto/league/abc"',
        SEASON,
        String(r.week),
        r.seasonType ?? 'REG',
        'KC',
        String(r.attempts ?? 0),
        String(r.carries ?? 0),
        String(r.targets ?? 0),
        String(r.receptions ?? 0),
        r.targetShare == null ? '' : String(r.targetShare),
        r.wopr == null ? '' : String(r.wopr),
      ].join(','),
    ),
  ].join('\n');
}

/** A fake origin that behaves like the measured one: bodiless 304s, whole file otherwise. */
function origin(initial: { body: string; etag: string; lastModified?: string }) {
  const state = { ...initial, requests: 0, conditionalHits: 0, bodiesSent: 0 };
  const fetchLike = async (_url: string, init?: RequestInit) => {
    state.requests++;
    const sent = new Headers(init?.headers as HeadersInit);
    if (sent.get('if-none-match') && sent.get('if-none-match') === state.etag) {
      state.conditionalHits++;
      return new Response(null, { status: 304, headers: { etag: state.etag } });
    }
    state.bodiesSent++;
    return new Response(state.body, {
      status: 200,
      headers: {
        etag: state.etag,
        'last-modified': state.lastModified ?? 'Tue, 15 Sep 2026 09:02:11 GMT',
      },
    });
  };
  return {
    fetch: fetchLike,
    state,
    publish(body: string, etag: string) {
      state.body = body;
      state.etag = etag;
    },
  };
}

/** A source that has published nothing for this season. */
const missing = async () => new Response('not found', { status: 404 });

async function seedPlayers(
  db: Database,
  people: { id: string; name: string; position?: string; gsis?: string }[],
): Promise<void> {
  await new PlayerRepo(db).upsertMany(
    people.map((p) =>
      player({
        id: p.id,
        fullName: p.name,
        position: p.position ?? 'WR',
        team: 'KC',
        externalIds: p.gsis ? { gsis: p.gsis } : {},
      }),
    ),
  );
}

// ------------------------------------------------------------------ the diff

describe('deciding what actually changed', () => {
  const row = (over: Partial<ComparableUsage> = {}): ComparableUsage => ({
    playerId: 'p0',
    season: SEASON,
    week: 5,
    passAttempts: 0,
    carries: 2,
    targets: 8,
    receptions: 6,
    targetShare: 0.24,
    wopr: 0.51,
    ...over,
  });

  it('writes nothing when a settled week is re-ingested', () => {
    const incoming = [row(), row({ playerId: 'p1' })];
    const stored = new Map(incoming.map((r) => [`${r.playerId}:${r.season}:${r.week}`, { ...r }]));
    const diff = diffUsage(incoming, stored);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toBe(2);
  });

  it('writes only the player whose numbers moved, out of many', () => {
    const incoming = Array.from({ length: 40 }, (_, i) => row({ playerId: `p${i}` }));
    const stored = new Map(incoming.map((r) => [`${r.playerId}:${r.season}:${r.week}`, { ...r }]));
    incoming[9] = row({ playerId: 'p9', targets: 9 });

    const diff = diffUsage(incoming, stored);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changedPlayerIds).toEqual(['p9']);
    expect(diff.unchanged).toBe(39);
  });

  it('treats a week nobody has stored as new', () => {
    const diff = diffUsage([row({ week: 6 })], new Map([[`p0:${SEASON}:5`, row()]]));
    expect(diff.changed).toHaveLength(1);
  });

  /** A float that moved in the fourteenth decimal place is not a role change. */
  it('is not fooled by the source re-rounding a rate', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row({ targetShare: 0.2400001 })]]);
    expect(diffUsage([row({ targetShare: 0.24 })], stored).changed).toHaveLength(0);
  });

  it('does tell a real share move from a rounding one', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row({ targetShare: 0.24 })]]);
    expect(diffUsage([row({ targetShare: 0.31 })], stored).changed).toHaveLength(1);
  });
});

// ------------------------------------------------------------- the lifecycle

describe('the life of the usage feed', () => {
  it('reports a season with no file as not published, and stores no validator', async () => {
    const db = await createTestDb();
    const service = new UsageService(db, { fetch: missing, log: () => {} });

    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('not_published');

    const state = await new UsageSourceRepo(db).get(SOURCE, SEASON);
    expect(state?.checkedAt).toBeTruthy();
    /*
     * The validator must stay empty. Storing one for a file that does not exist
     * would let the next check 304 against nothing and leave the app
     * permanently convinced it was up to date with a file nobody published.
     */
    expect(state?.etag).toBeNull();
    expect(state?.lastModified).toBeNull();
    expect(state?.ingestedAt).toBeNull();

    const health = await service.health(SEASON);
    expect(health.summary).toContain('has not published');
    expect(health.dataHealth).toContain('No weekly stats are published');
  });

  it('stores the validator and the rows on the first real file', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);
    const source = origin({ body: csv([{ gsis: '00-0038996', name: 'Puka Nacua', week: 4, targets: 11 }]), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });

    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('ok');
    expect(run.week).toBe(4);
    expect(run.matchedById).toBe(1);
    expect(run.rowsWritten).toBe(1);

    const stored = await new UsageRepo(db).weeksFor(['p1'], SEASON);
    expect(stored.get('p1')![0]).toMatchObject({ week: 4, targets: 11, seasonType: 'REG' });

    const state = await new UsageSourceRepo(db).get(SOURCE, SEASON);
    expect(state?.etag).toBe('v1');
    expect(state?.ingestedAt).toBeTruthy();
    expect(state?.caughtUpThrough).toBe(4);
  });

  it('downloads and parses nothing when the file has not changed', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);
    const source = origin({ body: csv([{ gsis: '00-0038996', name: 'Puka Nacua', week: 4, targets: 11 }]), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });

    await service.refresh(SEASON);
    const writesAfterFirst = await new UsageSourceRepo(db).writesToday(new Date().toISOString().slice(0, 10));

    const again = await service.refresh(SEASON);
    expect(again.outcome).toBe('ok');
    expect(again.note).toBe('source unchanged');
    expect(source.state.conditionalHits).toBe(1);
    // No body was sent the second time, so nothing was parsed and nothing written.
    expect(source.state.bodiesSent).toBe(1);
    expect(again.rowsWritten).toBe(0);
    expect(await new UsageSourceRepo(db).writesToday(new Date().toISOString().slice(0, 10))).toBe(writesAfterFirst);
  });

  it('writes only the row that moved when the file is republished', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [
      { id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' },
      { id: 'p2', name: 'Cooper Kupp', gsis: '00-0033908' },
    ]);
    const week = (targets: number) => [
      { gsis: '00-0038996', name: 'Puka Nacua', week: 4, targets: 11 },
      { gsis: '00-0033908', name: 'Cooper Kupp', week: 4, targets },
    ];
    const source = origin({ body: csv(week(6)), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    // A corrected box score: one player's targets revised, the other identical.
    source.publish(csv(week(7)), 'v2');
    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('ok');
    expect(run.rowsReturned).toBe(2);
    expect(run.rowsWritten).toBe(1);
    const stored = await new UsageRepo(db).weeksFor(['p2'], SEASON);
    expect(stored.get('p2')![0]!.targets).toBe(7);
  });

  it('refuses an ingest that would rewrite the whole week at once', async () => {
    const db = await createTestDb();
    const people = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, gsis: `00-00${i}` }));
    await seedPlayers(db, people);
    const week = (targets: number) =>
      csv(people.map((p) => ({ gsis: p.gsis, name: p.name, week: 4, targets })));

    const source = origin({ body: week(5), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    // Every player's usage changing at once is what a broken parser looks like.
    source.publish(week(0), 'v2');
    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('failed');
    expect(run.note).toContain('refused');
    const stored = await new UsageRepo(db).weeksFor(['p3'], SEASON);
    expect(stored.get('p3')![0]!.targets).toBe(5);
  });

  it('stops writing when the day\'s ceiling would be passed', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);
    const day = new Date().toISOString().slice(0, 10);
    await new UsageSourceRepo(db).addWrites(day, DAILY_WRITE_CEILING, new Date().toISOString());

    const source = origin({ body: csv([{ gsis: '00-0038996', name: 'Puka Nacua', week: 4, targets: 11 }]), etag: 'v1' });
    const run = await new UsageService(db, { fetch: source.fetch, log: () => {} }).refresh(SEASON);
    expect(run.outcome).toBe('failed');
    expect(run.note).toContain('ceiling');
    expect((await new UsageRepo(db).weeksFor(['p1'], SEASON)).size).toBe(0);
  });

  it('lets exactly one invocation ingest a changed file', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);
    const now = new Date();
    await new UsageSourceRepo(db).acquireLock(SOURCE, SEASON, 'somebody-else', now, 120);

    const source = origin({ body: csv([{ gsis: '00-0038996', name: 'Puka Nacua', week: 4, targets: 11 }]), etag: 'v1' });
    const run = await new UsageService(db, { fetch: source.fetch, now: () => now, log: () => {} }).refresh(SEASON);
    expect(run.note).toBe('another ingest is already running');
    expect((await new UsageRepo(db).weeksFor(['p1'], SEASON)).size).toBe(0);
  });

  it('counts a failed ingest so a fresh check cannot vouch for stale data', async () => {
    const db = await createTestDb();
    // Nobody in the dictionary, so nothing maps: the shape-change failure.
    const source = origin({ body: csv([{ gsis: '00-0038996', name: 'Nobody At All', week: 4 }]), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });

    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('failed');
    expect(run.unmatched).toBe(1);

    const health = await service.health(SEASON);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.dataHealth).toContain('did not complete');
  });
});

// --------------------------------------------------------------- the mapping

describe('mapping rows onto players', () => {
  it('resolves on the identifier when the name is ambiguous', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [
      { id: 'a', name: 'Chris Johnson', gsis: '00-0011111' },
      { id: 'b', name: 'Chris Johnson', gsis: '00-0022222' },
    ]);
    const source = origin({
      body: csv([{ gsis: '00-0022222', name: 'Chris Johnson', week: 2, targets: 5 }]),
      etag: 'v1',
    });
    const run = await new UsageService(db, { fetch: source.fetch, log: () => {} }).refresh(SEASON);

    expect(run.matchedById).toBe(1);
    expect(run.unmatched).toBe(0);
    const stored = await new UsageRepo(db).weeksFor(['a', 'b'], SEASON);
    expect(stored.has('b')).toBe(true);
    expect(stored.has('a')).toBe(false);
  });

  /*
   * The realistic ambiguity, which is not "the row has no id".
   *
   * Every player row in this file carries a GSIS id — that is why it was chosen
   * over snap counts. What it cannot promise is that *Sleeper* knows that id:
   * Sleeper publishes a GSIS for only about a third of its players, so an
   * ambiguous name whose identifier matches neither candidate is the case that
   * actually happens, and the only safe answer is to decline.
   */
  it('declines an ambiguous name the identifier cannot settle, and counts it', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [
      { id: 'a', name: 'Chris Johnson' },
      { id: 'b', name: 'Chris Johnson' },
    ]);
    const source = origin({
      body: csv([{ gsis: '00-0099999', name: 'Chris Johnson', week: 2, targets: 5 }]),
      etag: 'v1',
    });
    const run = await new UsageService(db, { fetch: source.fetch, log: () => {} }).refresh(SEASON);

    /*
     * Declining is the correct answer, not a shortfall. Usage attached to the
     * wrong player is worse than usage attached to nobody, and there is no
     * second identity matcher to fall back on by design.
     */
    expect(run.unmatched).toBe(1);
    expect(run.outcome).toBe('failed');
    expect((await new UsageRepo(db).weeksFor(['a', 'b'], SEASON)).size).toBe(0);
  });

  it('resolves on the name when there is only one of him', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua' }]);
    const source = origin({
      body: csv([{ gsis: '00-0038996', name: 'Puka Nacua', week: 2, targets: 9 }]),
      etag: 'v1',
    });
    const run = await new UsageService(db, { fetch: source.fetch, log: () => {} }).refresh(SEASON);
    // Matched on the name, because Sleeper holds no GSIS for him to match on.
    expect(run.matchedByName).toBe(1);
    expect(run.unmatched).toBe(0);
  });
});

// ------------------------------------------------------------------ catch-up

describe('filling a week nobody read', () => {
  it('fills the oldest gap, one week at a time, without touching the validator', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);

    const allWeeks = [1, 2, 3, 4].map((week) => ({
      gsis: '00-0038996',
      name: 'Puka Nacua',
      week,
      targets: 5 + week,
    }));
    const source = origin({ body: csv(allWeeks), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });

    // A first ingest reads only the latest week — weeks 1..3 are the hole an
    // outage would leave.
    await service.refresh(SEASON);
    expect((await new UsageRepo(db).weeksFor(['p1'], SEASON)).get('p1')!.map((w) => w.week)).toEqual([4]);

    const filled = await service.catchUpOneWeek(SEASON);
    expect(filled).toMatchObject({ week: 1, rows: 1 });
    const after = await new UsageRepo(db).weeksFor(['p1'], SEASON);
    expect(after.get('p1')!.map((w) => w.week)).toEqual([1, 4]);

    // …and it is history, so it must not make the store look more current.
    const state = await new UsageSourceRepo(db).get(SOURCE, SEASON);
    expect(state?.caughtUpThrough).toBe(4);

    await service.catchUpOneWeek(SEASON);
    await service.catchUpOneWeek(SEASON);
    const complete = await new UsageRepo(db).weeksFor(['p1'], SEASON);
    expect(complete.get('p1')!.map((w) => w.week)).toEqual([1, 2, 3, 4]);

    // Nothing left to fill: the next tick costs one indexed read and stops.
    expect(await service.catchUpOneWeek(SEASON)).toBeNull();
  });
});

// --------------------------------------------------------------- diagnostics

describe('what Setup is told', () => {
  it('separates having rows from having enough of them', async () => {
    const db = await createTestDb();
    await seedPlayers(db, [{ id: 'p1', name: 'Puka Nacua', gsis: '00-0038996' }]);
    const weeks = Array.from({ length: MINIMUM_GAMES }, (_, i) => ({
      gsis: '00-0038996',
      name: 'Puka Nacua',
      week: i + 1,
      targets: 6,
    }));
    const source = origin({ body: csv(weeks), etag: 'v1' });
    const service = new UsageService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);
    for (let i = 0; i < MINIMUM_GAMES; i++) await service.catchUpOneWeek(SEASON);

    const health = await service.health(SEASON);
    expect(health.players).toBe(1);
    expect(health.playersWithEnoughGames).toBe(1);
    expect(health.minimumGames).toBe(MINIMUM_GAMES);
    expect(health.summary).toContain(`${MINIMUM_GAMES} games`);
    expect(health.dataHealth).toContain('current');
  });

  it('knows which season it is asking about', () => {
    expect(usageSeason(new Date('2026-09-14T09:00:00Z'))).toBe('2026');
    // January belongs to the season that started the previous autumn.
    expect(usageSeason(new Date('2027-01-10T09:00:00Z'))).toBe('2026');
  });
});
