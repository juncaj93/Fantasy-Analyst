/**
 * Evidence ledger persistence.
 *
 * Invariants enforced here:
 *  - inserts are idempotent on `dedupe_key`
 *  - a row carrying a `user_override` is NEVER modified by reprocessing
 *  - every correction is appended to `user_reviews` so history survives
 */

import { aggregatePlayerSignal } from '../../core/evidence/aggregate.ts';
import type { EvidenceItem, EvidenceOverride, PlayerSignal, ReviewStatus } from '../../core/evidence/types.ts';
import type { ProposedEvidence } from '../../core/newsletter/pipeline.ts';
import { MAX_BOUND_PARAMS, chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';

interface EvidenceRow {
  id: number;
  dedupe_key: string;
  player_id: string;
  source_type: string;
  source_name: string;
  source_message_id: string | null;
  source_date: string;
  excerpt: string;
  context_summary: string | null;
  category: string | null;
  polarity: string;
  magnitude: number;
  confidence: string;
  confidence_score: number;
  rule_id: string | null;
  review_status: string;
  user_override_json: string | null;
  notes_json: string;
  created_at: string;
}

function toItem(row: EvidenceRow): EvidenceItem & { numericId: number } {
  return {
    numericId: row.id,
    id: String(row.id),
    playerId: row.player_id,
    sourceType: row.source_type,
    sourceName: row.source_name,
    sourceMessageId: row.source_message_id,
    sourceDate: row.source_date,
    excerpt: row.excerpt,
    contextSummary: row.context_summary,
    category: row.category,
    polarity: row.polarity as EvidenceItem['polarity'],
    magnitude: row.magnitude,
    confidence: row.confidence,
    confidenceScore: row.confidence_score,
    ruleId: row.rule_id,
    reviewStatus: row.review_status as ReviewStatus,
    userOverride: parseJson<EvidenceOverride | null>(row.user_override_json, null),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

export class EvidenceRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert proposed evidence, skipping anything already stored.
   * Returns how many rows were new — reprocessing the same newsletter yields 0.
   */
  async insertProposed(items: ProposedEvidence[]): Promise<{ inserted: number; skipped: number }> {
    if (items.length === 0) return { inserted: 0, skipped: 0 };
    const now = nowIso();
    const before = await this.countAll();

    for (const batch of chunk(items, 100)) {
      const statements = batch.map((e) =>
        this.db
          .prepare(
            `INSERT INTO evidence_items (
               dedupe_key, player_id, source_type, source_name, source_message_id, source_date,
               excerpt, context_summary, category, polarity, magnitude, confidence, confidence_score,
               rule_id, review_status, user_override_json, notes_json, created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)
             ON CONFLICT(dedupe_key) DO NOTHING`,
          )
          .bind(
            e.dedupeKey,
            e.playerId,
            e.sourceType,
            e.sourceName,
            e.sourceMessageId,
            e.sourceDate,
            e.excerpt,
            e.contextSummary,
            e.category,
            e.polarity,
            e.magnitude,
            e.confidence,
            e.confidenceScore,
            e.ruleId,
            e.reviewStatus,
            toJson(e.notes),
            now,
            now,
          ),
      );
      await this.db.batch(statements);
    }

    const after = await this.countAll();
    const inserted = after - before;
    return { inserted, skipped: items.length - inserted };
  }

  /**
   * Look up stored evidence by dedupe key.
   *
   * Used to work out what a reprocess would actually change before it changes
   * anything. Keys absent from the result are items that do not exist yet.
   */
  async listByDedupeKeys(keys: string[]): Promise<Map<string, EvidenceItem>> {
    const unique = [...new Set(keys)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const found = new Map<string, EvidenceItem>();
    // Chunked so a large newsletter cannot exceed the bound-parameter limit.
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM evidence_items WHERE dedupe_key IN (${placeholders})`)
        .bind(...batch)
        .all<EvidenceRow>();
      for (const row of rows.results) found.set(row.dedupe_key, toItem(row));
    }
    return found;
  }

  /**
   * Live evidence carrying one source message id.
   *
   * The read-only half of `supersedeStaleImports`: it answers "what would be
   * retired?" so a preview can report it without writing anything.
   */
  async listLiveBySourceMessage(sourceMessageId: string): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM evidence_items
          WHERE source_message_id = ?
            AND review_status IN ('auto_applied','accepted','corrected','pending')`,
      )
      .bind(sourceMessageId)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  /**
   * Move specific rows out of the counted set, keeping them in the ledger.
   *
   * Used when an imported tally becomes the semantic reading of a newsletter
   * and the parser's own reading of the same player must stop counting beside
   * it. `ignored` retires a row; `pending` parks one that needs a human to say
   * whether it was ever the same claim. Neither deletes anything, so the
   * parser's finding and its provenance survive for audit.
   *
   * A row the user has ruled on is never touched, and a row already at the
   * target status is left alone so re-running changes nothing.
   */
  async setStatusForImport(
    ids: number[],
    status: 'ignored' | 'pending',
    note: string,
  ): Promise<{ changed: EvidenceItem[]; keptForUserOverride: EvidenceItem[] }> {
    const changed: EvidenceItem[] = [];
    const keptForUserOverride: EvidenceItem[] = [];
    if (ids.length === 0) return { changed, keptForUserOverride };
    const now = nowIso();

    for (const batch of chunk([...new Set(ids)], MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM evidence_items WHERE id IN (${placeholders})`)
        .bind(...batch)
        .all<EvidenceRow>();

      const ruled = await this.idsWithUserDecision(rows.results.map((r) => r.id));
      for (const row of rows.results) {
        const item = toItem(row);
        if (item.userOverride || ruled.has(row.id)) {
          keptForUserOverride.push(item);
          continue;
        }
        if (row.review_status === status) continue;
        const notes = parseJson<string[]>(row.notes_json, []);
        await this.db
          .prepare(
            `UPDATE evidence_items
                SET review_status = ?, notes_json = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(status, toJson([...notes, note]), now, row.id)
          .run();
        changed.push(item);
      }
    }

    return { changed, keptForUserOverride };
  }

  /**
   * Which of these rows a person has actually ruled on.
   *
   * Not the same question as "is it `accepted`?", and the difference is what
   * makes this a query rather than a field test. `accepted` is a review status
   * an import is also allowed to write — the identity-repair path writes it for
   * every row it recovers, because the user confirmed *who* somebody is, not
   * what the news said about them. Reading that as a verdict would freeze the
   * ±1 stand-ins that path used to leave behind, and a re-import would then
   * stack the real score on top of one it exists to replace.
   *
   * `user_reviews` is the ledger's own record that a person decided something,
   * written by `applyReview` and by nothing else. That is the thing an import
   * must never overrule, so that is what gets asked.
   */
  async idsWithUserDecision(ids: number[]): Promise<Set<number>> {
    const found = new Set<number>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return found;
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT DISTINCT evidence_item_id AS id FROM user_reviews
            WHERE evidence_item_id IN (${placeholders})`,
        )
        .bind(...batch)
        .all<{ id: number }>();
      for (const row of rows.results) found.add(Number(row.id));
    }
    return found;
  }

  async countAll(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS n FROM evidence_items').first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /**
   * Rows an earlier revision retired, that this paste is asking for again.
   *
   * Inserts are keyed on the row's own identity, so a row that was written,
   * retired by a revision, and then written again by a later revision is not an
   * insert at all — the key is already taken and `ON CONFLICT DO NOTHING` means
   * exactly that. Without this the row would stay retired while the import
   * reported it as already present, which is the worst of both: the user is
   * told their score is in the ledger and it is not counting.
   *
   * Narrow on purpose: what can be undone here is only what an import did.
   * Eligibility needs the note this mechanism writes AND no trace of a person
   * having ruled on the row. Both, because neither alone is enough — retiring
   * a row by hand leaves the same `ignored` status an import leaves, with no
   * override and no note to tell them apart, and reinstating that would be an
   * import overruling a decision. `user_reviews` is the ledger's own record
   * that somebody decided something, so it is what gets asked.
   */
  private async retiredByImport(dedupeKeys: string[], note: string): Promise<EvidenceRow[]> {
    const unique = [...new Set(dedupeKeys)].filter(Boolean);
    if (unique.length === 0) return [];
    const found: EvidenceRow[] = [];
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(
          `SELECT * FROM evidence_items
            WHERE dedupe_key IN (${placeholders})
              AND review_status = 'ignored'
              AND NOT EXISTS (
                SELECT 1 FROM user_reviews WHERE user_reviews.evidence_item_id = evidence_items.id
              )`,
        )
        .bind(...batch)
        .all<EvidenceRow>();
      for (const row of rows.results) {
        if (parseJson<EvidenceOverride | null>(row.user_override_json, null)) continue;
        if (!parseJson<string[]>(row.notes_json, []).includes(note)) continue;
        found.push(row);
      }
    }
    return found;
  }

  /** The read-only half of `reinstateRetiredImports`, for a preview to report. */
  async listRetiredImports(dedupeKeys: string[], note: string): Promise<Map<string, EvidenceItem>> {
    const found = new Map<string, EvidenceItem>();
    for (const row of await this.retiredByImport(dedupeKeys, note)) {
      found.set(row.dedupe_key, toItem(row));
    }
    return found;
  }

  /**
   * Bring those rows back into the counted set.
   *
   * Idempotent for the same reason everything else here is: a row already live
   * is not `ignored`, so a second run finds nothing to do.
   */
  async reinstateRetiredImports(
    dedupeKeys: string[],
    note: string,
    reinstateNote: string,
    status: ReviewStatus = 'auto_applied',
  ): Promise<EvidenceItem[]> {
    const rows = await this.retiredByImport(dedupeKeys, note);
    if (rows.length === 0) return [];
    const now = nowIso();
    const reinstated: EvidenceItem[] = [];
    for (const row of rows) {
      const notes = parseJson<string[]>(row.notes_json, []);
      await this.db
        .prepare(
          `UPDATE evidence_items
              SET review_status = ?, notes_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(status, toJson([...notes, reinstateNote]), now, row.id)
        .run();
      reinstated.push({ ...toItem(row), reviewStatus: status });
    }
    return reinstated;
  }

  /**
   * Retire evidence a re-import has replaced.
   *
   * A tally document owns every row that carries its message id. Re-importing it
   * recomputes that set from the file, and anything still bearing the id that is
   * no longer in it is a leftover from an earlier revision or an earlier code
   * path — most importantly the ±1 stand-ins the identity-repair path used to
   * write, which would otherwise be counted a second time alongside the real
   * aggregate row the fixed importer now produces.
   *
   * Retired rather than deleted: `ignored` stops it counting while the record of
   * what was imported, and when, stays in the ledger. A row the user has ruled
   * on is never touched — their correction outranks anything an import decides —
   * and is reported back so the caller can say so out loud.
   */
  async supersedeStaleImports(
    sourceMessageId: string,
    keepDedupeKeys: string[],
    note: string,
    opts: { ruleId?: string } = {},
  ): Promise<{ superseded: EvidenceItem[]; keptForUserOverride: EvidenceItem[] }> {
    const keep = new Set(keepDedupeKeys);
    /*
     * `ruleId` narrows the sweep to one origin, and a caller that shares a
     * message id with another origin must pass it.
     *
     * A newsletter's id is carried by whatever the deterministic parser found
     * in it AND by whatever a tally import filed against it. Re-importing the
     * tally recomputes only its own rows, so an unscoped sweep would read the
     * parser's rows as leftovers and retire evidence the import never claimed
     * to own.
     */
    const rows = await this.db
      .prepare(
        `SELECT * FROM evidence_items
          WHERE source_message_id = ?
            AND review_status IN ('auto_applied','accepted','corrected','pending')
            ${opts.ruleId ? 'AND rule_id = ?' : ''}`,
      )
      .bind(...(opts.ruleId ? [sourceMessageId, opts.ruleId] : [sourceMessageId]))
      .all<EvidenceRow>();

    const superseded: EvidenceItem[] = [];
    const keptForUserOverride: EvidenceItem[] = [];
    const now = nowIso();

    const ruled = await this.idsWithUserDecision(rows.results.map((r) => r.id));
    for (const row of rows.results) {
      if (keep.has(row.dedupe_key)) continue;
      const item = toItem(row);
      if (item.userOverride || ruled.has(row.id)) {
        keptForUserOverride.push(item);
        continue;
      }
      const notes = parseJson<string[]>(row.notes_json, []);
      await this.db
        .prepare(
          `UPDATE evidence_items
              SET review_status = 'ignored', notes_json = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(toJson([...notes, note]), now, row.id)
        .run();
      superseded.push(item);
    }

    return { superseded, keptForUserOverride };
  }

  async listForPlayer(playerId: string, limit = 100): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare('SELECT * FROM evidence_items WHERE player_id = ? ORDER BY source_date DESC, id DESC LIMIT ?')
      .bind(playerId, limit)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  async listPending(limit = 50): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM evidence_items
          WHERE review_status = 'pending'
          ORDER BY confidence_score DESC, source_date DESC, id ASC
          LIMIT ?`,
      )
      .bind(limit)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  /** Headline counts for the Settings screen. */
  async summary(): Promise<{
    total: number;
    pending: number;
    autoAppliedPositive: number;
    autoAppliedNegative: number;
  }> {
    const rows = await this.db
      .prepare('SELECT review_status, polarity, COUNT(*) AS n FROM evidence_items GROUP BY review_status, polarity')
      .all<{ review_status: string; polarity: string; n: number }>();
    let total = 0;
    let pending = 0;
    let autoAppliedPositive = 0;
    let autoAppliedNegative = 0;
    for (const row of rows.results) {
      const n = Number(row.n ?? 0);
      total += n;
      if (row.review_status === 'pending') pending += n;
      if (row.review_status === 'auto_applied') {
        if (row.polarity === 'positive') autoAppliedPositive += n;
        if (row.polarity === 'negative') autoAppliedNegative += n;
      }
    }
    return { total, pending, autoAppliedPositive, autoAppliedNegative };
  }

  /** Recently auto-applied items, so the user can inspect and undo them. */
  async listApplied(limit = 30): Promise<EvidenceItem[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM evidence_items
          WHERE review_status IN ('auto_applied','accepted','corrected')
          ORDER BY source_date DESC, id DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<EvidenceRow>();
    return rows.results.map(toItem);
  }

  async pendingCount(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_items WHERE review_status = 'pending'")
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async getById(id: number): Promise<(EvidenceItem & { numericId: number }) | null> {
    const row = await this.db.prepare('SELECT * FROM evidence_items WHERE id = ?').bind(id).first<EvidenceRow>();
    return row ? toItem(row) : null;
  }

  /**
   * Apply a user decision. The override is authoritative: it is stored on the
   * row and replayed by `effectiveEvidence` forever after.
   */
  async applyReview(
    id: number,
    action: 'accept' | 'correct' | 'reject' | 'ignore',
    override: EvidenceOverride | null,
  ): Promise<EvidenceItem | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const status: ReviewStatus =
      action === 'accept' ? 'accepted' : action === 'correct' ? 'corrected' : action === 'reject' ? 'rejected' : 'ignored';

    const mergedOverride =
      action === 'correct'
        ? { ...(existing.userOverride ?? {}), ...(override ?? {}) }
        : existing.userOverride;

    const now = nowIso();
    await this.db
      .prepare(
        `UPDATE evidence_items
            SET review_status = ?, user_override_json = ?, player_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        status,
        mergedOverride ? toJson(mergedOverride) : null,
        mergedOverride?.playerId ?? existing.playerId,
        now,
        id,
      )
      .run();

    await this.db
      .prepare(
        `INSERT INTO user_reviews (evidence_item_id, action, previous_value_json, new_value_json, changed_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(
        id,
        action,
        toJson({
          polarity: existing.polarity,
          magnitude: existing.magnitude,
          category: existing.category,
          playerId: existing.playerId,
          reviewStatus: existing.reviewStatus,
        }),
        toJson({ reviewStatus: status, override: mergedOverride }),
        now,
      )
      .run();

    return this.getById(id);
  }

  /** Recompute and persist the derived signal cache for one player. */
  async refreshSignal(playerId: string, opts: { now?: string; seasonStart?: string | null } = {}): Promise<PlayerSignal> {
    const items = await this.listForPlayer(playerId, 1000);
    const signal = aggregatePlayerSignal(playerId, items, opts);
    await this.db
      .prepare(
        `INSERT INTO player_signal_cache (
           player_id, raw_positive, raw_negative, raw_net, raw_items,
           recent7_net, recent30_net, recent30_items, season_net,
           pending_count, mixed_count, carried_over_items,
           category_breakdown_json, last_evidence_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(player_id) DO UPDATE SET
           raw_positive = excluded.raw_positive,
           raw_negative = excluded.raw_negative,
           raw_net = excluded.raw_net,
           raw_items = excluded.raw_items,
           recent7_net = excluded.recent7_net,
           recent30_net = excluded.recent30_net,
           recent30_items = excluded.recent30_items,
           season_net = excluded.season_net,
           pending_count = excluded.pending_count,
           mixed_count = excluded.mixed_count,
           carried_over_items = excluded.carried_over_items,
           category_breakdown_json = excluded.category_breakdown_json,
           last_evidence_at = excluded.last_evidence_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        playerId,
        signal.raw.positive,
        signal.raw.negative,
        signal.raw.net,
        signal.raw.items,
        signal.last7.net,
        signal.last30.net,
        signal.last30.items,
        signal.seasonToDate.net,
        signal.pendingCount,
        signal.mixedCount,
        signal.carriedOverItems,
        toJson(signal.categoryBreakdown),
        signal.lastEvidenceAt,
        signal.updatedAt,
      )
      .run();
    return signal;
  }

  /** Rebuild the cache for every player that has evidence. */
  async refreshAllSignals(opts: { now?: string; seasonStart?: string | null } = {}): Promise<number> {
    const rows = await this.db
      .prepare('SELECT DISTINCT player_id FROM evidence_items')
      .all<{ player_id: string }>();
    for (const row of rows.results) await this.refreshSignal(row.player_id, opts);
    return rows.results.length;
  }

  /** Read the derived cache for a set of players. */
  /**
   * Every player the ledger has counted evidence for.
   *
   * Trade discovery starts here rather than from the whole player list: a
   * player nobody has written about has no trade signal, and scoring three
   * thousand of them to say so is work with no reader.
   */
  async playerIdsWithEvidence(): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT player_id FROM evidence_items
          WHERE review_status IN ('auto_applied','accepted','corrected')`,
      )
      .all<Record<string, unknown>>();
    return rows.results.map((r) => String(r['player_id'])).filter(Boolean);
  }

  /**
   * The derived signal for a set of players, correct as of *now*.
   *
   * The time-independent parts — the lifetime record, the category breakdown,
   * the review counts — come from the cache, which is what a cache is for. The
   * two recency windows do not, and that is the point of this method.
   *
   * `recent7_net` and `recent30_net` are stored as numbers, but a recency
   * window is not a fact about a player: it is a fact about a player *and
   * today's date*. `refreshSignal` computes them with `now` set to the moment
   * it runs, and it only runs on ingest, import and review — so a player whose
   * evidence has not been touched since keeps whichever windows were true on
   * the day his last row landed, for as long as nothing touches him again.
   *
   * That is not a cache going slightly out of date. It is a value that was only
   * ever true for one day being served indefinitely: a tally imported on the
   * 13th was still reported as "this week" on the 22nd, on the trade board, the
   * draft board, Start/Sit and the Team roster alike, because every one of them
   * reads this method.
   *
   * So the windows are recomputed here from the ledger, off the
   * `(player_id, source_date)` index, and the stored columns are left for
   * `refreshSignal` to keep writing — they remain a true record of what was
   * true when they were written, and nothing reads them for a current answer.
   */
  async getSignals(playerIds: string[], opts: { now?: string | Date } = {}): Promise<Map<string, PlayerSignal>> {
    const out = new Map<string, PlayerSignal>();
    if (playerIds.length === 0) return out;

    for (const batch of chunk(playerIds, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const [cached, ledger] = await Promise.all([
        this.db
          .prepare(`SELECT * FROM player_signal_cache WHERE player_id IN (${placeholders})`)
          .bind(...batch)
          .all<Record<string, unknown>>(),
        this.db
          .prepare(
            `SELECT * FROM evidence_items WHERE player_id IN (${placeholders})
               AND review_status IN ('auto_applied','accepted','corrected')`,
          )
          .bind(...batch)
          .all<EvidenceRow>(),
      ]);

      const byPlayer = new Map<string, EvidenceItem[]>();
      for (const row of ledger.results) {
        const item = toItem(row);
        // An override can re-file a row under a different player, and the
        // window it lands in has to follow it.
        const pid = item.userOverride?.playerId ?? item.playerId;
        const list = byPlayer.get(pid);
        if (list) list.push(item);
        else byPlayer.set(pid, [item]);
      }

      for (const r of cached.results) {
        const playerId = String(r['player_id']);
        const recent = aggregatePlayerSignal(playerId, byPlayer.get(playerId) ?? [], { now: opts.now });
        out.set(playerId, {
          playerId,
          raw: {
            positive: Number(r['raw_positive'] ?? 0),
            negative: Number(r['raw_negative'] ?? 0),
            net: Number(r['raw_net'] ?? 0),
            items: Number(r['raw_items'] ?? 0),
          },
          /*
           * The 7-day window, current — but still without an item count.
           *
           * That zero is not an oversight and not laziness: the cache has never
           * had a `recent7_items` column, so every cache-fed caller has always
           * seen `items: 0` here, and `draft/engine.ts` reads exactly that to
           * decide whether its `news_7d` component knows anything at all. An
           * item count of zero makes the component `unknown` and worth nothing,
           * which means the draft board's 7-day news term is, and always has
           * been, inert.
           *
           * Filling it in would switch that term on and reorder the draft
           * board. That may well be the right thing to do, but it is a decision
           * about draft scoring rather than about dates, and nothing in the
           * defect being fixed here calls for it. So the count stays as the
           * board has always seen it and the change is confined to the numbers
           * that were actually wrong.
           */
          last7: { ...recent.last7, items: 0 },
          last30: recent.last30,
          seasonToDate: { positive: 0, negative: 0, net: Number(r['season_net'] ?? 0), items: 0 },
          categoryBreakdown: parseJson(r['category_breakdown_json'], {}),
          pendingCount: Number(r['pending_count'] ?? 0),
          mixedCount: Number(r['mixed_count'] ?? 0),
          carriedOverItems: recent.carriedOverItems,
          lastEvidenceAt: (r['last_evidence_at'] as string | null) ?? null,
          updatedAt: String(r['updated_at'] ?? ''),
        });
      }
    }
    return out;
  }
}
