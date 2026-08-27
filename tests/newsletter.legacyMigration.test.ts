/**
 * The one-time reconciliation, run against the shape production is actually in.
 *
 * Migration 0034 has to do something delicate: stop the retired classifier's
 * rows counting, without touching a single thing a person decided and without
 * touching a single thing that arrived by any other route. "Probably fine" is
 * not an answer for a migration that runs once against a live ledger, so the
 * database is built the way the deployed one was — every migration up to 0033,
 * then the rows the old world left behind — and 0034 is applied to it and
 * inspected.
 *
 * The scenario is the real one: an issue arrived under the old path and
 * produced three automatic signals, one of which the user has since ruled on,
 * beside a hand-imported running tally carrying a lifetime `+11`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

function migrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

const THE_LANE = '0034_newsletter_awaits_a_tally.sql';

interface Row {
  id: number;
  rule_id: string | null;
  review_status: string;
  notes_json: string;
  player_id: string;
}

describe('migration 0034, against the world it is going to meet', () => {
  let db: NodeSqliteDatabase;

  /** Everything before the lane's own migration. */
  const applyBefore = async () => {
    for (const m of migrations()) {
      if (m.name === THE_LANE) break;
      await db.exec(m.sql);
    }
  };

  const applyLane = async () => {
    await db.exec(migrations().find((m) => m.name === THE_LANE)!.sql);
  };

  const rows = async (): Promise<Row[]> =>
    (await db.prepare('SELECT * FROM evidence_items ORDER BY id').all<Row>()).results;

  const byRule = async (ruleId: string): Promise<Row> =>
    (await rows()).find((r) => r.rule_id === ruleId)!;

  beforeEach(async () => {
    db = new NodeSqliteDatabase(':memory:');
    await applyBefore();

    const now = '2026-08-20T12:00:00.000Z';
    for (const id of ['jsn', 'love', 'nacua']) {
      await db
        .prepare(
          `INSERT INTO players (id, full_name, normalized_name, external_ids_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(id, id, id, '{}', now, now)
        .run();
    }

    // The issue that arrived under the old path, still stored with its body.
    await db
      .prepare(
        `INSERT INTO newsletter_messages
           (message_id, source_id, from_address, subject, received_at, fingerprint,
            evidence_count, pending_count, processed_at, status, body_html)
         VALUES ('legacy-issue','ff','editor@x.example','Camp Report',?, 'fp1', 3, 1, ?, 'processed', '<p>hi</p>')`,
      )
      .bind(now, now)
      .run();

    // ...and one that was quarantined, which nobody can tally.
    await db
      .prepare(
        `INSERT INTO newsletter_messages
           (message_id, source_id, from_address, subject, received_at, fingerprint,
            evidence_count, pending_count, processed_at, status)
         VALUES ('junk','unknown','spam@x.example','Buy now',?, 'fp2', 0, 0, ?, 'quarantined')`,
      )
      .bind(now, now)
      .run();

    const evidence = (
      dedupe: string,
      playerId: string,
      ruleId: string | null,
      status: string,
      override: string | null,
      messageId: string,
    ) =>
      db
        .prepare(
          `INSERT INTO evidence_items
             (dedupe_key, player_id, source_type, source_name, source_message_id, source_date,
              excerpt, polarity, magnitude, confidence, confidence_score, rule_id, review_status,
              user_override_json, notes_json, created_at, updated_at)
           VALUES (?,?, 'newsletter','FF Newsletter', ?, ?, 'excerpt', 'positive', 1, 'high', 0.9, ?, ?, ?, '[]', ?, ?)`,
        )
        .bind(dedupe, playerId, messageId, now, ruleId, status, override, now, now)
        .run();

    // The three the classifier wrote for that issue...
    await evidence('c1', 'jsn', 'role-change', 'auto_applied', null, 'legacy-issue');
    await evidence('c2', 'love', 'practice-report', 'pending', null, 'legacy-issue');
    // ...one of which the user has ruled on, in the way that leaves no override.
    await evidence('c3', 'nacua', 'role-change', 'accepted', null, 'legacy-issue');
    await db
      .prepare(
        `INSERT INTO user_reviews (evidence_item_id, action, changed_at)
         VALUES ((SELECT id FROM evidence_items WHERE dedupe_key = 'c3'), 'accept', ?)`,
      )
      .bind(now)
      .run();

    // The hand-imported running tally, filed against its own document.
    await evidence('t1', 'jsn', 'tally-backfill', 'auto_applied', null, 'tally-doc');
    // And an approved ChatGPT tally on a different issue that is already done.
    await evidence('a1', 'love', 'ai-tally-import', 'auto_applied', null, 'scored-issue');
    await db
      .prepare(
        `INSERT INTO newsletter_messages
           (message_id, source_id, from_address, subject, received_at, fingerprint,
            evidence_count, pending_count, processed_at, status, body_html)
         VALUES ('scored-issue','ff','editor@x.example','Older issue',?, 'fp3', 1, 0, ?, 'processed', '<p>hi</p>')`,
      )
      .bind(now, now)
      .run();

    // A name the classifier could not pin down, from the issue awaiting a tally.
    await db
      .prepare(
        `INSERT INTO identity_reviews
           (dedupe_key, source_message_id, source_date, excerpt, matched_text, reason,
            candidates_json, proposed_magnitude, status, created_at)
         VALUES ('i1','legacy-issue',?, 'excerpt', 'JSN', 'ambiguous', '[]', 1, 'pending', ?)`,
      )
      .bind(now, now)
      .run();
  });

  it('marks the stored issue as awaiting, and the one already scored as done', async () => {
    await applyLane();
    const states = new Map(
      (
        await db
          .prepare('SELECT message_id, tally_state, tallied_at FROM newsletter_messages')
          .all<{ message_id: string; tally_state: string; tallied_at: string | null }>()
      ).results.map((r) => [r.message_id, r]),
    );

    expect(states.get('legacy-issue')?.tally_state).toBe('awaiting');
    expect(states.get('legacy-issue')?.tallied_at).toBeNull();
    expect(states.get('scored-issue')?.tally_state).toBe('applied');
    expect(states.get('scored-issue')?.tallied_at).toBeTruthy();
    // Quarantined mail was never a candidate: there is no body to hand over.
    expect(states.get('junk')?.tally_state).toBe('not_applicable');
  });

  it('stops the classifier rows counting, and says so on the row', async () => {
    await applyLane();

    const classified = await byRule('role-change');
    expect(classified.review_status).toBe('ignored');
    expect(JSON.parse(classified.notes_json)).toContain('retired-legacy-newsletter-classifier');

    // A queued one too: `pending` is not counting, but it is an item in Review
    // that the retired workflow put there and that nobody should be asked to
    // work through.
    const queued = await byRule('practice-report');
    expect(queued.review_status).toBe('ignored');
  });

  it('never touches a row a person ruled on', async () => {
    await applyLane();
    const ruled = (await rows()).find((r) => r.player_id === 'nacua')!;
    expect(ruled.review_status).toBe('accepted');
    expect(JSON.parse(ruled.notes_json)).toEqual([]);
  });

  /**
   * The lifetime `+11` is the thing most easily lost here, and it must not be.
   *
   * It came from the hand-maintained running tally, which is a person's own
   * work imported once — the opposite of an automatic signal — and it is filed
   * against its own document rather than against a newsletter.
   */
  it('never touches the hand-imported tally or an approved ChatGPT one', async () => {
    await applyLane();
    expect((await byRule('tally-backfill')).review_status).toBe('auto_applied');
    expect((await byRule('ai-tally-import')).review_status).toBe('auto_applied');
  });

  it('retires the classifier’s unresolved names instead of leaving them queued', async () => {
    await applyLane();
    const review = await db
      .prepare("SELECT status FROM identity_reviews WHERE dedupe_key = 'i1'")
      .first<{ status: string }>();
    // `obsolete`, not `dismissed`: a person dismissing a name is a decision and
    // this is not one, and keeping them apart is what lets the difference still
    // be read a year from now.
    expect(review?.status).toBe('obsolete');
  });

  /**
   * The derived cache is not corrected by the migration, and must not be.
   *
   * `player_signal_cache` is derived from the ledger and is rewritten whenever a
   * player's evidence changes — which covers everything the app does, and not a
   * change made underneath it. Recomputing it in SQL would mean a second copy of
   * the aggregation rules living in a migration, and the day the two disagreed
   * would be the day nobody could say which was right.
   *
   * So the migration moves the ledger and leaves the derived numbers to
   * `POST /api/maintenance/refresh-signals`, which rebuilds them from it. This
   * pins the boundary rather than the outcome: the rows stopped counting, and
   * the cache still says what it said, which is what makes that call a required
   * step of the release rather than an optional tidy-up.
   */
  it('leaves the derived cache to be rebuilt rather than recomputing it in SQL', async () => {
    const now = '2026-08-20T12:00:00.000Z';
    await db
      .prepare(
        `INSERT INTO player_signal_cache
           (player_id, raw_positive, raw_negative, raw_net, raw_items,
            recent7_net, recent30_net, recent30_items, season_net,
            pending_count, mixed_count, category_breakdown_json, last_evidence_at, updated_at)
         VALUES ('jsn', 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, '{}', ?, ?)`,
      )
      .bind(now, now)
      .run();

    await applyLane();

    const cached = await db
      .prepare("SELECT raw_net FROM player_signal_cache WHERE player_id = 'jsn'")
      .first<{ raw_net: number }>();
    expect(cached?.raw_net).toBe(1);

    const { EvidenceRepo } = await import('../src/server/repos/evidence.ts');
    await new EvidenceRepo(db).refreshAllSignals();
    const rebuilt = await db
      .prepare("SELECT raw_net FROM player_signal_cache WHERE player_id = 'jsn'")
      .first<{ raw_net: number }>();
    // The classifier's +1 is gone; the hand-imported tally's row is not.
    expect(rebuilt?.raw_net).toBe(1);
    const counted = (await rows()).filter(
      (r) => r.player_id === 'jsn' && r.review_status === 'auto_applied',
    );
    expect(counted.map((r) => r.rule_id)).toEqual(['tally-backfill']);
  });

  /**
   * The reconciliation is safe to run again, which is what §17 asks for.
   *
   * D1 records which migrations it has applied and never re-applies one, so the
   * `ALTER TABLE`s at the top of the file are run-once by construction. What has
   * to survive a second run is the part that touches somebody's ledger — and it
   * has to change *nothing*, not merely avoid crashing, so that an operator who
   * is unsure whether it landed can simply run it again.
   *
   * The statements are lifted out of the migration file rather than restated
   * here, because a copy of them would be a second version that could drift.
   */
  it('reconciles idempotently when the ledger part is run again', async () => {
    await applyLane();
    const first = await rows();

    const reconciliation = migrations()
      .find((m) => m.name === THE_LANE)!
      .sql.split(';')
      // Each chunk carries the comment block that explains it; the statement is
      // what is left once those lines are dropped.
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((statement) => /^UPDATE\s+(evidence_items|identity_reviews)\b/i.test(statement));
    expect(reconciliation).toHaveLength(2);

    for (const statement of reconciliation) await db.exec(`${statement};`);

    expect(await rows()).toEqual(first);
    const review = await db
      .prepare("SELECT status FROM identity_reviews WHERE dedupe_key = 'i1'")
      .first<{ status: string }>();
    expect(review?.status).toBe('obsolete');
  });
});
