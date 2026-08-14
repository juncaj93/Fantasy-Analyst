/**
 * Checking every five minutes without paying for it every five minutes.
 *
 * The whole design is a refusal to conflate three things, and these are the
 * tests that hold them apart:
 *
 *   1. the **file** changed — a validator moved;
 *   2. a player's **row** changed — some field differs;
 *   3. a player's **state** changed — a field that alters a decision differs.
 *
 * Only the third may cost a database write. A season file republished with
 * three revised players arrives as four hundred rows; writing all four hundred
 * at a five-minute cadence would spend more than the entire daily D1 free-tier
 * budget to record three facts.
 */

import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { InjuryService, DAILY_WRITE_CEILING } from '../src/server/services/injuryService.ts';
import { InjuryRepo, InjurySourceRepo } from '../src/server/repos/injury.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { diffInjuries, looksAnomalous, type ComparableInjury } from '../src/core/injury/diff.ts';
import { fetchInjuryReport } from '../src/core/injury/nflverse.ts';
import type { Database } from '../src/server/db.ts';
import { player } from './helpers/players.ts';

const SEASON = '2026';
const HEADER =
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,' +
  'report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,' +
  'practice_secondary_injury,practice_status';

/** A file with whatever rows the test needs, in the real column order. */
function csv(rows: { name: string; week: number; status: string; injury: string; practice: string }[]): string {
  return [
    HEADER,
    ...rows.map(
      (r) =>
        `${SEASON},REG,REG,KC,${r.week},,WR,${r.name},${r.name.split(' ')[0]},${r.name.split(' ')[1]},` +
        `${r.injury},,${r.status},${r.injury},,${r.practice}`,
    ),
  ].join('\n');
}

/**
 * A fake origin that behaves like the real one — which was measured rather than
 * imagined: `scripts/probe-nflverse-conditional.mjs` confirms nflverse answers
 * `If-None-Match` with a bodiless 304 and a stale validator with the whole file.
 */
function origin(initial: { body: string; etag: string; lastModified?: string }) {
  const state = { ...initial, requests: 0, conditionalHits: 0, bodiesSent: 0 };
  const fetchLike = async (_url: string, init?: RequestInit) => {
    state.requests++;
    const sent = new Headers(init?.headers as HeadersInit);
    const ifNoneMatch = sent.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === state.etag) {
      state.conditionalHits++;
      return new Response(null, { status: 304, headers: { etag: state.etag } });
    }
    state.bodiesSent++;
    return new Response(state.body, {
      status: 200,
      headers: {
        etag: state.etag,
        'last-modified': state.lastModified ?? 'Wed, 18 Mar 2026 12:45:31 GMT',
      },
    });
  };
  return {
    fetch: fetchLike,
    state,
    /** Publish a revision: new content, new validator, as a real update would. */
    publish(body: string, etag: string) {
      state.body = body;
      state.etag = etag;
    },
  };
}

async function seedPlayers(db: Database, names: string[]): Promise<void> {
  await new PlayerRepo(db).upsertMany(
    names.map((name, i) =>
      player({ id: `p${i}`, fullName: name, position: 'WR', team: 'KC', normalizedName: name.toLowerCase() }),
    ),
  );
}

// ------------------------------------------------------------------ the diff

describe('deciding what actually changed', () => {
  const row = (over: Partial<ComparableInjury> = {}): ComparableInjury => ({
    playerId: 'p0',
    season: SEASON,
    week: 5,
    reportStatus: 'Questionable',
    primaryInjury: 'Hamstring',
    practiceStatus: 'limited',
    ...over,
  });

  it('writes nothing when every row is identical', () => {
    const incoming = [row(), row({ playerId: 'p1' })];
    const stored = new Map(incoming.map((r) => [`${r.playerId}:${r.season}:${r.week}`, { ...r }]));
    const diff = diffInjuries(incoming, stored);
    expect(diff.changed).toHaveLength(0);
    expect(diff.events).toHaveLength(0);
    expect(diff.changedPlayerIds).toHaveLength(0);
    expect(diff.unchanged).toBe(2);
  });

  it('writes only the player who moved, out of many', () => {
    const incoming = Array.from({ length: 50 }, (_, i) => row({ playerId: `p${i}` }));
    const stored = new Map(incoming.map((r) => [`${r.playerId}:${r.season}:${r.week}`, { ...r }]));
    // One player's designation worsens.
    incoming[7] = row({ playerId: 'p7', reportStatus: 'Out' });

    const diff = diffInjuries(incoming, stored);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.playerId).toBe('p7');
    expect(diff.changedPlayerIds).toEqual(['p7']);
    expect(diff.unchanged).toBe(49);
    expect(diff.events).toEqual([
      expect.objectContaining({ kind: 'designation', from: 'questionable', to: 'out' }),
    ]);
  });

  it('records a practice move and a body-part change as their own events', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row()]]);
    const diff = diffInjuries([row({ practiceStatus: 'full', primaryInjury: 'Ankle' })], stored);
    expect(diff.events.map((e) => e.kind).sort()).toEqual(['body_part', 'practice']);
  });

  /**
   * The whole point of comparing normalized values. A source that starts writing
   * `DNP` where it used to write the long form has changed nothing about the
   * player, and must not cost four hundred writes to discover that.
   */
  it('is not fooled by the source rewording itself', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row({ reportStatus: 'QUESTIONABLE' })]]);
    const diff = diffInjuries([row({ reportStatus: 'Questionable' })], stored);
    expect(diff.changed).toHaveLength(0);
  });

  /** A designation being *removed* on a Saturday is exactly the news a lineup wants. */
  it('notices a designation being cleared', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row()]]);
    const diff = diffInjuries([row({ reportStatus: null })], stored);
    expect(diff.events).toEqual([
      expect.objectContaining({ kind: 'designation', from: 'questionable', to: 'healthy' }),
    ]);
  });

  /**
   * A first sighting is not a transition. Without this, the very first ingest
   * would fire a `→ Questionable` event for every designated player on the
   * board and drown the real ones.
   */
  it('writes a new player without inventing a transition for him', () => {
    const diff = diffInjuries([row()], new Map());
    expect(diff.changed).toHaveLength(1);
    expect(diff.events).toHaveLength(0);
  });

  it('gives the same transition the same key every time', () => {
    const stored = new Map([[`p0:${SEASON}:5`, row()]]);
    const a = diffInjuries([row({ reportStatus: 'Out' })], stored);
    const b = diffInjuries([row({ reportStatus: 'Out' })], stored);
    expect(a.events[0]!.eventKey).toBe(b.events[0]!.eventKey);
    // …and it is derived from the transition, never from a clock.
    expect(a.events[0]!.eventKey).toContain('questionable>out');
  });

  /**
   * A broken parser reads every field as empty and reports that all four hundred
   * players simultaneously became healthy. That is indistinguishable from a real
   * mass update except by its size.
   */
  describe('the anomaly guard', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row({ playerId: `p${i}` }));

    it('refuses an ingest that claims nearly everybody changed', () => {
      const incoming = many(100).map((r) => ({ ...r, reportStatus: null, primaryInjury: null, practiceStatus: 'unknown' as const }));
      const stored = new Map(many(100).map((r) => [`${r.playerId}:${r.season}:${r.week}`, r]));
      const diff = diffInjuries(incoming, stored);
      expect(looksAnomalous(diff, 100)).toBe(true);
    });

    it('allows an ordinary week where a handful moved', () => {
      const stored = new Map(many(100).map((r) => [`${r.playerId}:${r.season}:${r.week}`, r]));
      const incoming = many(100);
      incoming[1] = row({ playerId: 'p1', reportStatus: 'Out' });
      incoming[2] = row({ playerId: 'p2', practiceStatus: 'dnp' });
      expect(looksAnomalous(diffInjuries(incoming, stored), 100)).toBe(false);
    });

    /** A first run legitimately changes everything, and must not be blocked. */
    it('does not fire on an empty store', () => {
      const diff = diffInjuries(many(100), new Map());
      expect(looksAnomalous(diff, 0)).toBe(false);
    });
  });
});

// ------------------------------------------------------- the conditional GET

describe('asking whether anything changed', () => {
  it('sends the stored validator and reads a 304 as "nothing to do"', async () => {
    const source = origin({ body: csv([{ name: 'Ann Ash', week: 5, status: 'Questionable', injury: 'Knee', practice: 'Limited' }]), etag: '"v1"' });
    const result = await fetchInjuryReport(SEASON, {
      fetch: source.fetch,
      fingerprint: { etag: '"v1"', lastModified: null },
    });
    expect(result.outcome).toBe('not_modified');
    expect(result.report).toBeNull();
    expect(source.state.bodiesSent).toBe(0);
  });

  it('downloads and parses when the validator no longer matches', async () => {
    const source = origin({ body: csv([{ name: 'Ann Ash', week: 5, status: 'Out', injury: 'Knee', practice: 'DNP' }]), etag: '"v2"' });
    const result = await fetchInjuryReport(SEASON, {
      fetch: source.fetch,
      fingerprint: { etag: '"v1"', lastModified: null },
    });
    expect(result.outcome).toBe('ok');
    expect(result.report!.rows).toHaveLength(1);
    expect(result.fingerprint.etag).toBe('"v2"');
  });

  it('downloads everything when it has never looked before', async () => {
    const source = origin({ body: csv([{ name: 'Ann Ash', week: 5, status: 'Out', injury: 'Knee', practice: 'DNP' }]), etag: '"v1"' });
    expect((await fetchInjuryReport(SEASON, { fetch: source.fetch })).outcome).toBe('ok');
  });

  /**
   * Sending both conditional headers lets a server that honours only the weaker
   * one answer 200 to a request the stronger one would have settled — quietly
   * turning every check back into a download.
   */
  it('sends only one conditional header, preferring the strong validator', async () => {
    const seen: Headers[] = [];
    await fetchInjuryReport(SEASON, {
      fingerprint: { etag: '"v1"', lastModified: 'Wed, 18 Mar 2026 12:45:31 GMT' },
      fetch: async (_u, init) => {
        seen.push(new Headers(init?.headers as HeadersInit));
        return new Response(null, { status: 304 });
      },
    });
    expect(seen[0]!.get('if-none-match')).toBe('"v1"');
    expect(seen[0]!.get('if-modified-since')).toBeNull();
  });

  it('falls back to the date when there is no ETag', async () => {
    const seen: Headers[] = [];
    await fetchInjuryReport(SEASON, {
      fingerprint: { etag: null, lastModified: 'Wed, 18 Mar 2026 12:45:31 GMT' },
      fetch: async (_u, init) => {
        seen.push(new Headers(init?.headers as HeadersInit));
        return new Response(null, { status: 304 });
      },
    });
    expect(seen[0]!.get('if-modified-since')).toBe('Wed, 18 Mar 2026 12:45:31 GMT');
  });

  it('keeps the old fingerprint when the source errors, rather than forgetting it', async () => {
    const result = await fetchInjuryReport(SEASON, {
      fingerprint: { etag: '"v1"', lastModified: null },
      fetch: async () => new Response('nope', { status: 503 }),
    });
    expect(result.outcome).toBe('failed');
    expect(result.fingerprint.etag).toBe('"v1"');
  });

  it('does not treat a network failure as an empty report', async () => {
    const result = await fetchInjuryReport(SEASON, {
      fetch: async () => {
        throw new Error('connection reset');
      },
    });
    expect(result.outcome).toBe('failed');
    expect(result.note).toContain('connection reset');
  });

  /**
   * Storing the fingerprint of an empty file would mark the emptiness as seen,
   * and every later check would 304 against it — leaving the app permanently
   * convinced it was up to date with nothing.
   */
  it('refuses to accept an empty file as an update', async () => {
    const result = await fetchInjuryReport(SEASON, {
      fingerprint: { etag: '"v1"', lastModified: null },
      fetch: async () => new Response(HEADER, { status: 200, headers: { etag: '"v2"' } }),
    });
    expect(result.outcome).toBe('failed');
    expect(result.fingerprint.etag).toBe('"v1"');
  });

  it('still reports a season that has not started as a fact, not a fault', async () => {
    const result = await fetchInjuryReport('2026', { fetch: async () => new Response('', { status: 404 }) });
    expect(result.outcome).toBe('not_published');
  });
});

// -------------------------------------------------------------- end to end

describe('a tick of the five-minute check', () => {
  const WEEK5 = [
    { name: 'Ann Ash', week: 5, status: 'Questionable', injury: 'Hamstring', practice: 'Limited Participation in Practice' },
    { name: 'Bob Birch', week: 5, status: '', injury: '', practice: 'Full Participation in Practice' },
    { name: 'Cal Cedar', week: 5, status: 'Out', injury: 'Knee', practice: 'Did Not Participate In Practice' },
  ];

  async function setup() {
    const db = await createTestDb();
    await seedPlayers(db, ['Ann Ash', 'Bob Birch', 'Cal Cedar']);
    return db;
  }

  it('ingests everything the first time and writes nothing the second', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });

    const first = await service.refresh(SEASON);
    expect(first.outcome).toBe('ok');
    expect(first.matchedByName).toBe(3);
    expect(await new InjuryRepo(db).coverage(SEASON)).toEqual({ players: 3, latestWeek: 5 });

    /*
     * The second tick is the one that has to be free. The source is unchanged,
     * so nothing is downloaded, nothing is parsed, and no player row is touched.
     */
    const budgetBefore = await new InjurySourceRepo(db).writesToday(new Date().toISOString().slice(0, 10));
    const second = await service.refresh(SEASON);
    expect(second.note).toBe('source unchanged');
    expect(source.state.conditionalHits).toBe(1);
    expect(source.state.bodiesSent).toBe(1);
    expect(await new InjurySourceRepo(db).writesToday(new Date().toISOString().slice(0, 10))).toBe(budgetBefore);
  });

  it('writes one player when one player changed', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    // Ann goes from Questionable to Out; nobody else moves.
    const revised = WEEK5.map((r) => (r.name === 'Ann Ash' ? { ...r, status: 'Out', practice: 'Did Not Participate In Practice' } : r));
    source.publish(csv(revised), '"v2"');

    const run = await service.refresh(SEASON);
    expect(run.outcome).toBe('ok');
    expect(run.changedPlayerIds).toEqual(['p0']);

    const events = await new InjurySourceRepo(db).recentEvents();
    expect(events.map((e) => `${e.kind}:${e.from}>${e.to}`).sort()).toEqual([
      'designation:questionable>out',
      'practice:limited>dnp',
    ]);

    // And the stored row for the untouched players is exactly as it was.
    const stored = await new InjuryRepo(db).latestFor(['p1'], SEASON);
    expect(stored.get('p1')!.reportStatus).toBeNull();
  });

  /**
   * §26 — the case that separates "the file changed" from "the data changed".
   * nflverse republishes the whole asset on any revision, so a new validator
   * carrying identical player data is the normal weekly occurrence.
   */
  it('parses but writes nothing when a republished file says the same thing', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    const day = new Date().toISOString().slice(0, 10);
    const spentAfterFirst = await new InjurySourceRepo(db).writesToday(day);

    // Same content, new validator — the file was republished.
    source.publish(csv(WEEK5), '"v2"');
    const run = await service.refresh(SEASON);

    expect(run.outcome).toBe('ok');
    expect(source.state.bodiesSent, 'it did download it').toBe(2);
    expect(run.changedPlayerIds ?? []).toHaveLength(0);
    expect(await new InjurySourceRepo(db).writesToday(day)).toBe(spentAfterFirst);
    expect(await new InjurySourceRepo(db).recentEvents()).toHaveLength(0);

    // …and the new fingerprint is stored, so the next tick 304s against it.
    const state = await new InjurySourceRepo(db).get('nflverse', SEASON);
    expect(state!.etag).toBe('"v2"');
  });

  it('keeps three timestamps apart, so nothing claims to be newer than it is', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"', lastModified: 'Wed, 18 Mar 2026 12:45:31 GMT' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);
    await service.refresh(SEASON);

    const state = await new InjurySourceRepo(db).get('nflverse', SEASON)!;
    expect(state!.sourceModifiedAt, 'when the file changed').toBe('2026-03-18T12:45:31.000Z');
    expect(state!.ingestedAt, 'when we stored it').not.toBeNull();
    expect(state!.checkedAt, 'when we last looked').not.toBeNull();
    // The check is later than the ingest, and the source is older than both.
    expect(Date.parse(state!.checkedAt!)).toBeGreaterThanOrEqual(Date.parse(state!.ingestedAt!));
    expect(Date.parse(state!.sourceModifiedAt!)).toBeLessThan(Date.parse(state!.ingestedAt!));
  });

  /** §27 — two ticks racing on a changed source. One ingests; the other declines. */
  it('lets only one invocation ingest a changed file', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    source.publish(csv(WEEK5.map((r) => ({ ...r, status: 'Out' }))), '"v2"');

    const [a, b] = await Promise.all([service.refresh(SEASON), service.refresh(SEASON)]);
    const notes = [a.note, b.note];
    expect(notes.filter((n) => n === 'another ingest is already running')).toHaveLength(1);

    // One set of events, not two.
    const events = await new InjurySourceRepo(db).recentEvents(50);
    expect(events.filter((e) => e.kind === 'designation')).toHaveLength(2); // Ann and Bob moved to Out
  });

  it('recovers after a lease is abandoned rather than deadlocking', async () => {
    const db = await setup();
    const repo = new InjurySourceRepo(db);
    const past = new Date('2026-01-01T00:00:00Z');
    expect(await repo.acquireLock('nflverse', SEASON, 'crashed', past, 60)).toBe(true);
    // A second owner cannot take it while the lease is live…
    expect(await repo.acquireLock('nflverse', SEASON, 'other', past, 60)).toBe(false);
    // …but can once it has expired, with no release ever having happened.
    const later = new Date(past.getTime() + 120_000);
    expect(await repo.acquireLock('nflverse', SEASON, 'other', later, 60)).toBe(true);
  });

  /** §28 — the source going away must cost nothing that is already stored. */
  it('preserves last-good data when the source fails', async () => {
    const db = await setup();
    const good = origin({ body: csv(WEEK5), etag: '"v1"' });
    await new InjuryService(db, { fetch: good.fetch, log: () => {} }).refresh(SEASON);

    const broken = new InjuryService(db, {
      fetch: async () => new Response('gateway', { status: 502 }),
      log: () => {},
    });
    const run = await broken.refresh(SEASON);
    expect(run.outcome).toBe('failed');

    // Everything that was there is still there.
    expect(await new InjuryRepo(db).coverage(SEASON)).toEqual({ players: 3, latestWeek: 5 });
    // And the fingerprint survived, so the next good tick can still 304.
    expect((await new InjurySourceRepo(db).get('nflverse', SEASON))!.etag).toBe('"v1"');
  });

  /** §29 — a parser or schema break must not overwrite good data with garbage. */
  it('refuses an ingest where suddenly everybody changed', async () => {
    const db = await createTestDb();
    /*
     * Distinct under normalization, which strips digits — `Pl0 Ayer` and
     * `Pl1 Ayer` both reduce to `pl ayer`, and the identity layer correctly
     * declines an ambiguous name rather than guessing between them.
     */
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const names = Array.from(
      { length: 60 },
      (_, i) => `${alphabet[i % 26]!.toUpperCase()}${alphabet[(i * 7) % 26]}${alphabet[i % 5]} Oak${alphabet[Math.floor(i / 26)]}`,
    );
    await seedPlayers(db, names);
    const healthy = names.map((name, i) => ({
      name,
      week: 5,
      status: i % 2 === 0 ? 'Questionable' : 'Out',
      injury: 'Knee',
      practice: 'Limited Participation in Practice',
    }));

    const source = origin({ body: csv(healthy), etag: '"v1"' });
    const service = new InjuryService(db, { fetch: source.fetch, log: () => {} });
    await service.refresh(SEASON);

    // The parser "breaks": every designation and injury reads as empty.
    source.publish(csv(healthy.map((r) => ({ ...r, status: '', injury: '', practice: '' }))), '"v2"');
    const run = await service.refresh(SEASON);

    expect(run.outcome).toBe('failed');
    expect(run.note).toContain('looks like a source or parser change');
    // Not one row was overwritten.
    const stored = await new InjuryRepo(db).latestFor(['p0'], SEASON);
    expect(stored.get('p0')!.reportStatus).toBe('Questionable');
  });

  it('stops writing before it can eat the day’s database budget', async () => {
    const db = await setup();
    const repo = new InjurySourceRepo(db);
    const day = new Date().toISOString().slice(0, 10);
    await repo.addWrites(day, DAILY_WRITE_CEILING, new Date().toISOString());

    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const run = await new InjuryService(db, { fetch: source.fetch, log: () => {} }).refresh(SEASON);
    expect(run.outcome).toBe('failed');
    expect(run.note).toContain('ceiling');
    expect(await new InjuryRepo(db).coverage(SEASON)).toEqual({ players: 0, latestWeek: null });
  });

  /** §18 — before the season starts there is nothing, and checking stays cheap. */
  it('keeps checking harmlessly while the season file does not exist', async () => {
    const db = await setup();
    let calls = 0;
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () => {
        calls++;
        return new Response('', { status: 404 });
      },
    });
    for (let i = 0; i < 3; i++) expect((await service.refresh(SEASON)).outcome).toBe('not_published');
    expect(calls).toBe(3);
    expect(await new InjuryRepo(db).coverage(SEASON)).toEqual({ players: 0, latestWeek: null });

    /*
     * And it stores no fingerprint, which is the part that matters.
     *
     * A missing file has no validator worth keeping. Storing one anyway would
     * make every later check send it, and a source that answered 304 to a
     * validator for a file that does not exist would leave this permanently
     * "unchanged" against nothing.
     *
     * It is also what keeps the two kinds of quiet tick apart: a stored
     * validator means the file was asked about and had not changed, and no
     * stored validator means there was nothing to ask about. Zero writes only
     * means the pipeline is cheap in the first case.
     */
    const health = await service.health(SEASON);
    expect(health.etag).toBeNull();
    expect(health.lastModified).toBeNull();
    expect(health.ingestedAt).toBeNull();
    expect(health.lastOutcome).toBe('not_published');
    expect(health.checkedAt).not.toBeNull();
    expect(health.players).toBe(0);
  });

  /** The other quiet tick: a file that exists, unchanged, keeps its validator. */
  it('holds the validator it was given once the file does exist', async () => {
    const db = await setup();
    const source = origin({ body: csv(WEEK5), etag: '"v1"' });
    const service = new InjuryService(db, { log: () => {}, fetch: source.fetch });

    expect((await service.refresh(SEASON)).outcome).toBe('ok');

    /*
     * A run reports whether the tick was healthy, so an unchanged source is a
     * successful run — `ok`, with the reason in the note. Whether the file
     * moved is a different question, and it is answered by the stored outcome.
     */
    const second = await service.refresh(SEASON);
    expect(second.outcome).toBe('ok');
    expect(second.note).toBe('source unchanged');
    // The second tick asked and was answered without a byte of the file.
    expect(source.state.bodiesSent).toBe(1);
    expect(source.state.conditionalHits).toBe(1);

    const health = await service.health(SEASON);
    expect(health.etag).toBe('"v1"');
    expect(health.ingestedAt).not.toBeNull();
    expect(health.lastOutcome).toBe('not_modified');
  });

  it('ingests automatically the moment the file first appears', async () => {
    const db = await setup();
    let published = false;
    const body = csv(WEEK5);
    const service = new InjuryService(db, {
      log: () => {},
      fetch: async () =>
        published
          ? new Response(body, { status: 200, headers: { etag: '"v1"' } })
          : new Response('', { status: 404 }),
    });

    expect((await service.refresh(SEASON)).outcome).toBe('not_published');
    published = true;
    expect((await service.refresh(SEASON)).outcome).toBe('ok');
    expect((await new InjuryRepo(db).coverage(SEASON)).players).toBe(3);
  });
});
