/**
 * Preview and apply a hand-imported preseason snapshot.
 *
 * One method does both, and the difference is a boolean. That is deliberate:
 * a preview computed by different code from the import it previews is a preview
 * that can be wrong, and a preview nobody can trust is worse than none, because
 * it is the thing standing between a bad paste and the draft board.
 *
 * So `preview()` and `apply()` share every step up to the write, and the write
 * is the only thing `preview()` skips.
 */

import { buildSnapshotImport, type SnapshotImport } from '../../core/seasonImport/import.ts';
import { resolveSeasonLines, summariseLineage, type LineageSummary } from '../../core/seasonImport/gapFill.ts';
import type { IdentityReviewItem } from '../../core/newsletter/pipeline.ts';
import { PlayerRepo } from '../repos/players.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import {
  PreseasonSnapshotsRepo,
  captureLabel,
  type PreseasonSnapshotMeta,
} from '../repos/preseasonSnapshots.ts';
import type { Database } from '../db.ts';

export interface ImportRequest {
  content: string;
  season: string;
  source: string;
  capturedAt: string;
  /** Which source leads when more than one has priced the same player+market. */
  primarySource?: string | null;
}

export interface ImportOutcome {
  /** False for a preview. Nothing was written when this is false. */
  committed: boolean;
  format: string;
  season: string;
  source: string;
  capturedAt: string;
  label: string;
  counts: SnapshotImport['counts'];
  markets: string[];
  rejected: SnapshotImport['rejected'];
  warnings: string[];
  /** Which unresolved names would go to Review, and what they might be. */
  needsReview: {
    name: string;
    status: 'ambiguous' | 'unmatched';
    candidates: { playerId: string; name: string; confidence: number }[];
  }[];
  /** Whether this capture already exists, and would therefore be revised. */
  replaces: PreseasonSnapshotMeta | null;
  /** The other captures held for this season, which this does not disturb. */
  otherSnapshots: PreseasonSnapshotMeta[];
  /** What the board would read after this import, across every capture. */
  resultingCoverage: LineageSummary;
  reviewsFiled: number;
}

export class PreseasonImportService {
  private readonly snapshots: PreseasonSnapshotsRepo;
  private readonly players: PlayerRepo;
  private readonly reviews: NewsletterRepo;

  constructor(db: Database) {
    this.snapshots = new PreseasonSnapshotsRepo(db);
    this.players = new PlayerRepo(db);
    this.reviews = new NewsletterRepo(db);
  }

  preview(req: ImportRequest): Promise<ImportOutcome> {
    return this.run(req, false);
  }

  apply(req: ImportRequest): Promise<ImportOutcome> {
    return this.run(req, true);
  }

  private async run(req: ImportRequest, commit: boolean): Promise<ImportOutcome> {
    const index = await this.players.buildIndex();
    const parsed = buildSnapshotImport(req.content, index, {
      season: req.season,
      source: req.source,
      capturedAt: req.capturedAt,
    });

    const existing = await this.snapshots.list(parsed.season);
    const replaces =
      existing.find(
        (s) =>
          s.source.trim().toLowerCase() === parsed.source.trim().toLowerCase() &&
          s.capturedAt === parsed.capturedAt,
      ) ?? null;

    const importedAt = new Date().toISOString();
    let reviewsFiled = 0;
    let snapshotId: number | null = null;

    if (commit) {
      snapshotId = await this.snapshots.save(
        {
          season: parsed.season,
          source: parsed.source,
          capturedAt: parsed.capturedAt,
          raw: req.content,
          format: parsed.format,
          importedAt,
        },
        parsed.rows,
      );
      reviewsFiled = await this.fileReviews(parsed, snapshotId);
    }

    /*
     * What the board would actually read afterwards.
     *
     * Computed from every capture, not from this one, because that is the
     * question being asked: not "what is in this paste" but "what will the
     * draft see". For a preview the incoming rows are folded in without being
     * written, so the number shown is the number that would result.
     */
    const stored = await this.snapshots.lines(parsed.season);
    const incoming = commit
      ? []
      : parsed.rows
          .filter((r) => r.playerId != null)
          .map((r) => ({
            playerId: r.playerId!,
            market: r.market,
            line: r.line,
            overPrice: r.overPrice,
            underPrice: r.underPrice,
            source: parsed.source,
            capturedAt: parsed.capturedAt,
            // Higher than any stored id so an unwritten capture wins a tie
            // against the snapshot it is about to replace.
            snapshotId: Number.MAX_SAFE_INTEGER,
          }));

    // A preview of a re-import must not count the rows it is replacing.
    const kept =
      !commit && replaces ? stored.filter((l) => l.snapshotId !== replaces.id) : stored;

    const resolved = resolveSeasonLines([...kept, ...incoming], {
      primarySource: req.primarySource ?? null,
    });

    return {
      committed: commit,
      format: parsed.format,
      season: parsed.season,
      source: parsed.source,
      capturedAt: parsed.capturedAt,
      label: captureLabel(parsed.source, parsed.capturedAt),
      counts: parsed.counts,
      markets: parsed.markets,
      rejected: parsed.rejected,
      warnings: parsed.warnings,
      needsReview: parsed.rows
        .filter((r) => r.matchStatus !== 'matched')
        .map((r) => ({
          name: r.sourcePlayerName,
          status: r.matchStatus as 'ambiguous' | 'unmatched',
          candidates: r.candidates.slice(0, 3).map((c) => ({
            playerId: c.playerId,
            name: c.player.fullName,
            confidence: c.confidence,
          })),
        })),
      replaces,
      otherSnapshots: existing.filter((s) => s.id !== replaces?.id),
      resultingCoverage: summariseLineage(resolved),
      reviewsFiled,
    };
  }

  /**
   * Put every unresolved name in front of a human.
   *
   * The row is already stored with a null player id, so this is not how the
   * data survives — it is how somebody finds out there is something to fix.
   * Deduped on the name within a season, so re-importing a corrected capture
   * does not file the same question twice.
   */
  private async fileReviews(parsed: SnapshotImport, snapshotId: number): Promise<number> {
    const unresolved = parsed.rows.filter((r) => r.matchStatus !== 'matched');
    if (unresolved.length === 0) return 0;

    const seen = new Set<string>();
    const items: IdentityReviewItem[] = [];
    for (const row of unresolved) {
      const key = row.sourcePlayerName.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const where = [row.sourceTeam, row.sourcePosition].filter(Boolean).join(' ');
      items.push({
        sourceMessageId: `preseason-vegas:${parsed.season}:${snapshotId}`,
        sourceDate: parsed.capturedAt,
        excerpt: `${row.sourcePlayerName}${where ? ` (${where})` : ''} — ${row.market} ${row.line}`,
        matchedText: row.sourcePlayerName,
        reason:
          row.matchStatus === 'ambiguous'
            ? `more than one player matches this name on the ${parsed.source} preseason snapshot`
            : `no player matches this name on the ${parsed.source} preseason snapshot`,
        candidates: row.candidates.slice(0, 5).map((c) => ({
          playerId: c.playerId,
          name: c.player.fullName,
          team: c.player.team,
          position: c.player.position,
          detail: c.detail,
        })),
        /*
         * A market line is not a claim about a player being good or bad, so it
         * carries none of the newsletter's polarity vocabulary. Neutral and
         * weightless: this queue entry exists to ask "who is this", and
         * answering it must not also nudge a ranking.
         */
        proposedPolarity: 'neutral',
        proposedCategory: null,
        proposedMagnitude: 0,
      });
    }
    return this.reviews.insertIdentityReviews(items);
  }
}
