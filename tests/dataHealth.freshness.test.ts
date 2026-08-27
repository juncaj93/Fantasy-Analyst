/**
 * What the deployment says about its own inputs, against a real database.
 *
 * The model tests next door assert the vocabulary in the abstract. These assert
 * the part that could quietly go wrong on a Sunday: that the state on the
 * screen is derived from the rows the shipped pipelines actually write, that
 * last-attempt and last-success are read from the two columns that hold them
 * rather than from whichever one was convenient, and that the four states a
 * questionable recommendation has to be diagnosed against — current, stale,
 * missing, legitimately unpublished — each come out of a database in that
 * state.
 *
 * Nothing here fetches. Every setup below writes the same rows a real ingest
 * would have written and then asks the read-only service what it makes of them.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { DataHealthService } from '../src/server/services/dataHealthService.ts';
import { InjurySourceRepo } from '../src/server/repos/injury.ts';
import { UsageSourceRepo } from '../src/server/repos/usage.ts';
import { INJURY_SOURCE, injurySeason } from '../src/server/services/injuryService.ts';
import { USAGE_SOURCE, usageSeason } from '../src/server/services/usageService.ts';
import { FRESHNESS_HOURS } from '../src/core/injury/model.ts';
import { DAILY_ATTEMPT_STALE_MINUTES, FREQUENT_ATTEMPT_STALE_MINUTES } from '../src/core/health/policy.ts';
import { needsAttention, type DataHealthView, type SourceHealth } from '../src/core/health/model.ts';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

async function view(db: NodeSqliteDatabase): Promise<DataHealthView> {
  return new DataHealthService(db, { now: () => NOW, releaseSha: 'test-sha' }).view();
}

function find(v: DataHealthView, id: string): SourceHealth {
  const found = v.sources.find((s) => s.id === id);
  if (!found) throw new Error(`no source row for ${id}: ${v.sources.map((s) => s.id).join(', ')}`);
  return found;
}

/** Write the state an injury ingest would have left behind. */
async function injuryState(
  db: NodeSqliteDatabase,
  patch: { checkedAt: string; ingestedAt?: string | null; outcome: string; note?: string | null },
): Promise<void> {
  await new InjurySourceRepo(db).recordCheck(INJURY_SOURCE, injurySeason(NOW), {
    checkedAt: patch.checkedAt,
    ingestedAt: patch.ingestedAt ?? null,
    outcome: patch.outcome,
    note: patch.note ?? null,
  });
}

describe('a source that is current', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('reads as current inside its own window, and names the window it was measured against', async () => {
    await injuryState(db, { checkedAt: ago(2), ingestedAt: ago(60), outcome: 'ok' });
    const injuries = find(await view(db), 'injuries');
    expect(injuries.state).toBe('current');
    expect(injuries.note).toBeNull();
    // The injury layer's own freshness boundary, not a second one invented here.
    expect(injuries.freshWithinMinutes).toBe(FRESHNESS_HOURS.fresh * 60);
  });

  /**
   * The boundary, on the real pipeline's real column.
   *
   * `FRESHNESS_HOURS.fresh` is 30 hours; exactly 30 hours old is still current
   * and one minute past it is not. An exclusive boundary would make the last
   * minute of every window a lie, and this is the one place it is checked
   * end-to-end rather than on the classifier alone.
   */
  it('is still current exactly on the boundary, and stale one minute past it', async () => {
    const window = FRESHNESS_HOURS.fresh * 60;
    await injuryState(db, { checkedAt: ago(2), ingestedAt: ago(window), outcome: 'ok' });
    expect(find(await view(db), 'injuries').state).toBe('current');

    const later = await createTestDb();
    await injuryState(later, { checkedAt: ago(2), ingestedAt: ago(window + 1), outcome: 'ok' });
    const stale = find(await view(later), 'injuries');
    expect(stale.state).toBe('stale');
    // A stale row says what being stale costs, rather than only that it is old.
    expect(stale.note).toMatch(/older report|ruled-out/i);
  });
});

describe('a source that has legitimately published nothing', () => {
  /**
   * The rule the whole model is built to keep. A preseason 404 is recorded by
   * the ingest as `not_published`, and that must survive all the way to a row.
   */
  it('is waiting, not missing and not stale, and is not something to act on', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(3), ingestedAt: null, outcome: 'not_published' });
    const v = await view(db);
    const injuries = find(v, 'injuries');
    expect(injuries.state).toBe('waiting');
    expect(injuries.lastSuccessAt).toBeNull();
    expect(injuries.lastAttemptAt).toBe(ago(3));
    expect(injuries.note).toMatch(/no injury report published/i);
  });

  /**
   * The consequence that matters: it is not on the list of things to do.
   *
   * The rest of an empty test database is legitimately in trouble — nothing has
   * ever synced — so this asserts the claim about the injury row itself rather
   * than about the headline, which `dataHealth.model.test.ts` pins directly.
   */
  it('is never among the inputs a reader is asked to act on', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(3), ingestedAt: null, outcome: 'not_published' });
    const v = await view(db);
    expect(v.sources.filter(needsAttention).map((s) => s.id)).not.toContain('injuries');
  });
});

describe('last attempt and last success are different questions', () => {
  /**
   * The state a single "updated N ago" hides: the five-minute check is running
   * happily and has not managed to store anything since Tuesday.
   */
  it('a fresh check cannot vouch for old data', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(2), ingestedAt: ago(5 * 24 * 60), outcome: 'not_modified' });
    const injuries = find(await view(db), 'injuries');
    expect(injuries.lastAttemptAt).toBe(ago(2));
    expect(injuries.lastSuccessAt).toBe(ago(5 * 24 * 60));
    expect(injuries.state).toBe('stale');
  });

  /**
   * And the mirror image: data that is fine only because it was fetched before
   * the pipeline stopped. Nothing about the *data* is wrong here, so a
   * data-only reading would call this current.
   */
  it('data that is fine because the pipeline stopped is not fine', async () => {
    const db = await createTestDb();
    await injuryState(db, {
      checkedAt: ago(FREQUENT_ATTEMPT_STALE_MINUTES + 5),
      ingestedAt: ago(FREQUENT_ATTEMPT_STALE_MINUTES + 5),
      outcome: 'ok',
    });
    const injuries = find(await view(db), 'injuries');
    expect(injuries.state).toBe('degraded');
    expect(injuries.note).toMatch(/scheduled check/i);
  });

  it('a check inside its cadence is not flagged', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(FREQUENT_ATTEMPT_STALE_MINUTES), ingestedAt: ago(60), outcome: 'ok' });
    expect(find(await view(db), 'injuries').state).toBe('current');
  });
});

describe('a source whose ingests are dying', () => {
  /**
   * `consecutive_failures` is the column that exists so a fresh `checked_at`
   * cannot vouch for stale data, and it has to outrank every age reading.
   */
  it('is degraded whatever the timestamps say, and says how many', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(1), ingestedAt: ago(1), outcome: 'ok' });
    await new InjurySourceRepo(db).recordIngestFailure(INJURY_SOURCE, injurySeason(NOW), ago(120), 'parse failed');
    await new InjurySourceRepo(db).recordIngestFailure(INJURY_SOURCE, injurySeason(NOW), ago(60), 'parse failed');

    const injuries = find(await view(db), 'injuries');
    expect(injuries.state).toBe('degraded');
    expect(injuries.note).toMatch(/2 refreshes in a row/i);
    expect(injuries.technical.consecutiveFailures).toBe(2);
    expect(injuries.technical.failingSince).toBe(ago(120));
  });

  /** A critical input in trouble is a refresh problem, not a degradation. */
  it('makes the whole screen say refresh problem', async () => {
    const db = await createTestDb();
    await injuryState(db, { checkedAt: ago(1), ingestedAt: ago(1), outcome: 'ok' });
    await new InjurySourceRepo(db).recordIngestFailure(INJURY_SOURCE, injurySeason(NOW), ago(60), 'parse failed');
    expect((await view(db)).overall.state).toBe('problem');
  });
});

describe('per-source cadence', () => {
  /**
   * A daily feed and a five-minute feed cannot share a patience.
   *
   * The usage pipeline is checked once a morning; a two-hour-old check is
   * perfectly healthy for it and would be a warning for the injury report.
   */
  it('a two-hour-old daily check is healthy where a two-hour-old five-minute check is not', async () => {
    const db = await createTestDb();
    await new UsageSourceRepo(db).recordCheck(USAGE_SOURCE, usageSeason(NOW), {
      checkedAt: ago(120),
      ingestedAt: ago(3 * 24 * 60),
      outcome: 'not_modified',
      note: null,
    });
    await injuryState(db, { checkedAt: ago(120), ingestedAt: ago(30), outcome: 'ok' });

    const v = await view(db);
    expect(find(v, 'usage').state).toBe('current');
    expect(find(v, 'injuries').state).toBe('degraded');
  });

  it('measures usage by when it was asked, because a settled week never moves again', async () => {
    const db = await createTestDb();
    await new UsageSourceRepo(db).recordCheck(USAGE_SOURCE, usageSeason(NOW), {
      checkedAt: ago(60),
      ingestedAt: ago(6 * 24 * 60),
      outcome: 'not_modified',
      note: null,
    });
    const usage = find(await view(db), 'usage');
    expect(usage.measure).toBe('attempt');
    expect(usage.ageMinutes).toBe(60);
    expect(usage.lastSuccessAt).toBe(ago(6 * 24 * 60));
    expect(usage.state).toBe('current');
  });

  it('flags a daily feed nobody has asked in a day and a half', async () => {
    const db = await createTestDb();
    await new UsageSourceRepo(db).recordCheck(USAGE_SOURCE, usageSeason(NOW), {
      checkedAt: ago(DAILY_ATTEMPT_STALE_MINUTES + 1),
      ingestedAt: ago(DAILY_ATTEMPT_STALE_MINUTES + 1),
      outcome: 'ok',
      note: null,
    });
    expect(find(await view(db), 'usage').state).toBe('degraded');
  });
});

describe('an empty deployment', () => {
  /**
   * Nothing has ever run. Every answer has to be honest about that rather than
   * reporting twelve healthy sources or twelve broken ones.
   */
  it('reports missing or unknown, never current, and never claims a refresh', async () => {
    const db = await createTestDb();
    const v = await view(db);
    expect(v.sources.length).toBeGreaterThan(0);
    expect(v.sources.map((s) => s.state)).not.toContain('current');
    expect(v.overall.refreshedAt).toBeNull();
    expect(v.lastRun).toBeNull();
  });

  it('reports the running revision, which is the same string /api/health reports', async () => {
    const db = await createTestDb();
    expect((await view(db)).release.gitSha).toBe('test-sha');
  });

  it('says unknown rather than inventing a revision', async () => {
    const db = await createTestDb();
    expect((await new DataHealthService(db, { now: () => NOW }).view()).release.gitSha).toBe('unknown');
  });
});

describe('every policy source is reported', () => {
  it('and each one carries both timestamps and its own cadence', async () => {
    const db = await createTestDb();
    const v = await view(db);
    for (const source of v.sources) {
      expect(source.cadence, source.id).toBeTruthy();
      expect(source, source.id).toHaveProperty('lastSuccessAt');
      expect(source, source.id).toHaveProperty('lastAttemptAt');
    }
  });
});
