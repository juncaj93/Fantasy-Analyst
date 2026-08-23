/**
 * Preview and apply a StartWho preseason projection snapshot.
 *
 * One method does both and the difference is a boolean, so the preview cannot
 * disagree with the import it previews — it is the only thing standing between
 * a bad paste and the draft board.
 */

import { buildProjectionImport, type ProjectionImport } from '../../core/startWho/import.ts';
import { projectionScoringFrom, scoringKey } from '../../core/startWho/scoring.ts';
import type { ScoringProfile } from '../../core/sleeper/scoring.ts';
import type { IdentityReviewItem } from '../../core/newsletter/pipeline.ts';
import { PlayerRepo } from '../repos/players.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import {
  PreseasonProjectionsRepo,
  projectionLabel,
  type ProjectionSnapshotMeta,
} from '../repos/preseasonProjections.ts';
import type { Database } from '../db.ts';

export interface ProjectionImportRequest {
  content: string;
  season: string;
  /** The league whose rules the snapshot was captured under. Authoritative. */
  profile: ScoringProfile;
  /** Only used when the paste carries no "Last updated" line. */
  capturedAt?: string | null;
}

export interface ProjectionImportOutcome {
  committed: boolean;
  source: string;
  season: string;
  capturedAt: string;
  capturedFrom: 'paste' | 'declared';
  lastUpdated: string | null;
  scoringKey: string;
  scoringLabel: string;
  label: string;
  counts: ProjectionImport['counts'];
  rejected: ProjectionImport['rejected'];
  warnings: string[];
  needsReview: {
    name: string;
    status: 'ambiguous' | 'unmatched';
    candidates: { playerId: string; name: string; confidence: number }[];
  }[];
  /** The capture this would revise, when one already exists. */
  replaces: ProjectionSnapshotMeta | null;
  /** Other captures for this season, which this does not disturb. */
  otherSnapshots: ProjectionSnapshotMeta[];
  /** A handful of resolved players, so the numbers can be eyeballed. */
  sample: { name: string; position: string | null; team: string | null; points: number }[];
  reviewsFiled: number;
}

export class PreseasonProjectionService {
  private readonly snapshots: PreseasonProjectionsRepo;
  private readonly players: PlayerRepo;
  private readonly reviews: NewsletterRepo;

  constructor(db: Database) {
    this.snapshots = new PreseasonProjectionsRepo(db);
    this.players = new PlayerRepo(db);
    this.reviews = new NewsletterRepo(db);
  }

  preview(req: ProjectionImportRequest): Promise<ProjectionImportOutcome> {
    return this.run(req, false);
  }

  apply(req: ProjectionImportRequest): Promise<ProjectionImportOutcome> {
    return this.run(req, true);
  }

  private async run(req: ProjectionImportRequest, commit: boolean): Promise<ProjectionImportOutcome> {
    const index = await this.players.buildIndex();
    const scoring = projectionScoringFrom(req.profile);
    const parsed = buildProjectionImport(req.content, index, {
      season: req.season,
      scoring,
      capturedAt: req.capturedAt ?? null,
    });

    const existing = await this.snapshots.list(parsed.season);
    const replaces =
      existing.find(
        (s) => s.capturedAt === parsed.capturedAt && s.scoringKey === parsed.scoringKey,
      ) ?? null;

    let reviewsFiled = 0;
    if (commit) {
      const snapshotId = await this.snapshots.save(
        {
          season: parsed.season,
          source: parsed.source,
          capturedAt: parsed.capturedAt,
          scoring: parsed.scoring,
          scoringKey: parsed.scoringKey,
          scoringLabel: parsed.scoringLabel,
          lastUpdated: parsed.lastUpdated,
          raw: req.content,
          importedAt: new Date().toISOString(),
        },
        parsed.rows,
      );
      reviewsFiled = await this.fileReviews(parsed, snapshotId);
    }

    /*
     * A few recognisable players, resolved, so the numbers can be checked
     * against the page they came from before anything is committed. Taken from
     * the top of the source's own order because that is where the names a
     * person will recognise are.
     */
    const sample = parsed.rows
      .filter((r) => r.matchStatus === 'matched')
      .sort((a, b) => (a.sourceRank ?? Infinity) - (b.sourceRank ?? Infinity))
      .slice(0, 8)
      .map((r) => ({
        name: r.sourcePlayerName,
        position: r.position,
        team: r.teamCode,
        points: r.points,
      }));

    return {
      committed: commit,
      source: parsed.source,
      season: parsed.season,
      capturedAt: parsed.capturedAt,
      capturedFrom: parsed.capturedFrom,
      lastUpdated: parsed.lastUpdated,
      scoringKey: parsed.scoringKey,
      scoringLabel: parsed.scoringLabel,
      label: projectionLabel(parsed.source, parsed.capturedAt),
      counts: parsed.counts,
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
      sample,
      reviewsFiled,
    };
  }

  /** The newest capture that matches a league's own scoring, or null. */
  latestFor(season: string, profile: ScoringProfile): Promise<ProjectionSnapshotMeta | null> {
    return this.snapshots.latest(season, scoringKey(projectionScoringFrom(profile)));
  }

  /**
   * Put every unresolved name in front of a human.
   *
   * The row is already stored with a null player id, so this is not how the
   * data survives — it is how somebody learns there is something to fix.
   */
  private async fileReviews(parsed: ProjectionImport, snapshotId: number): Promise<number> {
    const unresolved = parsed.rows.filter((r) => r.matchStatus !== 'matched');
    if (unresolved.length === 0) return 0;

    const seen = new Set<string>();
    const items: IdentityReviewItem[] = [];
    for (const row of unresolved) {
      const key = row.sourcePlayerName.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const where = [row.teamCode ?? row.sourceTeam, row.position].filter(Boolean).join(' ');
      items.push({
        sourceMessageId: `preseason-projection:${parsed.season}:${snapshotId}`,
        sourceDate: parsed.capturedAt,
        excerpt: `${row.sourcePlayerName}${where ? ` (${where})` : ''} — ${row.points} projected points`,
        matchedText: row.sourcePlayerName,
        reason:
          row.matchStatus === 'ambiguous'
            ? `more than one player matches this name on the ${parsed.source} preseason projection`
            : `no player matches this name on the ${parsed.source} preseason projection`,
        candidates: row.candidates.slice(0, 5).map((c) => ({
          playerId: c.playerId,
          name: c.player.fullName,
          team: c.player.team,
          position: c.player.position,
          detail: c.detail,
        })),
        /*
         * A projection is not a claim about a player being good or bad news, so
         * it carries none of the newsletter's polarity vocabulary. This queue
         * entry asks "who is this", and answering it must not also nudge a
         * ranking.
         */
        proposedPolarity: 'neutral',
        proposedCategory: null,
        proposedMagnitude: 0,
      });
    }
    return this.reviews.insertIdentityReviews(items);
  }
}
