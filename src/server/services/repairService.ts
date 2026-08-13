/**
 * Assigning an unresolved name to a real player, and making it count.
 *
 * Resolving an identity review used to record the decision and stop there: the
 * review went green, an alias was stored, and the player's tally did not move,
 * because no evidence had ever been created for them. The user's research
 * stayed invisible, which is the exact failure this is supposed to prevent.
 *
 * Confirming a name now does the whole job:
 *
 *   1. stores the alias, so the name resolves by itself next time;
 *   2. creates evidence for every unresolved item written under that name;
 *   3. rebuilds the player's lifetime / 30-day / 7-day signals;
 *   4. marks the reviews resolved.
 *
 * One confirmation repairs every item sharing the name — the user should not
 * have to answer "who is JSN" nine times.
 */

import {
  groupUnresolved,
  polaritySign,
  repairSummary,
  suspiciousZeroBoosts,
  type UnresolvedGroup,
  type ZeroBoostSuspicion,
} from '../../core/identity/repair.ts';
import { normalizeName } from '../../core/identity/normalize.ts';
import type { Database } from '../db.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import { PlayerRepo } from '../repos/players.ts';

export interface RepairStatus {
  groups: UnresolvedGroup[];
  suspicions: ZeroBoostSuspicion[];
  summary: { names: number; items: number; net: number; headline: string };
}

export interface RepairResult {
  playerId: string;
  alias: string;
  /** Reviews that were resolved by this one confirmation. */
  resolved: number;
  /** Evidence rows created. Lower than `resolved` if some already existed. */
  created: number;
  /** The player's lifetime net after the repair. */
  net: number;
}

/** How many unresolved reviews to consider at once. Far above any real backlog. */
const MAX_REVIEWS = 500;

export class RepairService {
  private readonly newsletter: NewsletterRepo;
  private readonly evidence: EvidenceRepo;
  private readonly players: PlayerRepo;

  constructor(db: Database) {
    this.newsletter = new NewsletterRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.players = new PlayerRepo(db);
  }

  /** Everything Help My Scores needs to render. */
  async status(now = new Date().toISOString()): Promise<RepairStatus> {
    const reviews = await this.newsletter.listIdentityReviews(MAX_REVIEWS);
    const groups = groupUnresolved(reviews, now);

    // A candidate with no tally of their own is the tell-tale shape of a
    // mismatch, so the candidates' current signals are needed to spot it.
    const candidateIds = [...new Set(groups.flatMap((g) => g.candidates.map((c) => c.playerId)))];
    const signals = await this.evidence.getSignals(candidateIds);
    const netByPlayerId = new Map([...signals].map(([id, signal]) => [id, signal.raw.net]));

    return {
      groups,
      suspicions: suspiciousZeroBoosts(groups, netByPlayerId),
      summary: repairSummary(groups),
    };
  }

  /**
   * Attach every unresolved item written under `alias` to a canonical player.
   *
   * `remember` defaults to true: teaching the app the name is the point, and
   * a user-confirmed alias outranks anything the matcher would infer later.
   */
  async assign(alias: string, playerId: string, opts: { remember?: boolean; now?: string } = {}): Promise<RepairResult> {
    const player = await this.players.getById(playerId);
    if (!player) throw new Error(`player ${playerId} not found`);

    const normalized = normalizeName(alias);
    if (!normalized) throw new Error('alias is empty');

    const reviews = await this.newsletter.listIdentityReviews(MAX_REVIEWS);
    const mine = reviews.filter((r) => normalizeName(r.matchedText) === normalized);
    if (mine.length === 0) throw new Error(`no unresolved evidence under "${alias}"`);

    if (opts.remember !== false) {
      await this.players.addAlias(playerId, alias.trim(), normalized, 'user');
    }

    // The user confirmed who this is, not what the news said about them, so the
    // classifier's polarity stands and the item is `accepted` rather than
    // `auto_applied`. Neutral items are still created: they contribute nothing
    // to the tally, but throwing them away would lose the record of what the
    // newsletter actually said.
    const created = await this.evidence.insertProposed(mine.map((review) => this.evidenceFor(review, player, alias)));

    for (const review of mine) {
      await this.newsletter.resolveIdentityReview(review.id, playerId, 'resolved');
    }

    const signal = await this.evidence.refreshSignal(playerId, { now: opts.now });
    return {
      playerId,
      alias: alias.trim(),
      resolved: mine.length,
      created: created.inserted,
      net: signal.raw.net,
    };
  }

  /**
   * Evidence for one confirmed name.
   *
   * The user confirmed who this is, not what the news said about them, so the
   * classifier's polarity stands and the item is `accepted` rather than
   * `auto_applied`. Neutral items are still created: they contribute nothing to
   * the tally, but discarding them would lose the record of what was said.
   *
   * Keyed on the review id so re-running is a no-op rather than a duplicate.
   */
  private evidenceFor(
    review: {
      id: number;
      sourceMessageId: string;
      sourceDate: string;
      excerpt: string;
      proposedPolarity: string | null;
      proposedCategory: string | null;
      proposedMagnitude: number;
    },
    player: { id: string; fullName: string },
    alias: string,
  ) {
    return {
      dedupeKey: `identity:${review.id}`,
      playerId: player.id,
      playerName: player.fullName,
      sourceType: 'newsletter' as const,
      sourceName: 'newsletter',
      sourceMessageId: review.sourceMessageId,
      sourceDate: review.sourceDate,
      excerpt: review.excerpt,
      contextSummary: null,
      category: review.proposedCategory,
      polarity: (review.proposedPolarity ?? 'neutral') as 'positive' | 'negative' | 'neutral',
      // The magnitude the item was always worth. An imported tally row carries
      // its net score ("JSN +11" is worth 11, not 1); a newsletter sentence
      // carries the magnitude its rule assigned. Neutral news is worth nothing
      // either way, so it stays at 0.
      magnitude: polaritySign(review.proposedPolarity) === 0 ? 0 : Math.abs(review.proposedMagnitude),
      confidence: 'high' as const,
      confidenceScore: 1,
      ruleId: 'user_identity_repair',
      reviewStatus: 'accepted' as const,
      notes: [`assigned by the user from "${alias.trim()}"`],
      blockIndex: 0,
    };
  }

  /**
   * Recover evidence for names that were resolved before resolving created any.
   *
   * The old path recorded the decision and stopped, so a confirmed name left the
   * queue and the player's tally stayed where it was — visible nowhere. Every
   * resolved review is checked against the ledger and the missing ones are
   * written, keyed on the review id so this is safe to run repeatedly.
   */
  async backfillResolved(opts: { now?: string } = {}): Promise<{
    checked: number;
    created: number;
    players: { playerId: string; name: string; net: number; recovered: number }[];
  }> {
    const resolved = await this.newsletter.listResolvedIdentityReviews();
    const byPlayer = new Map<string, typeof resolved>();
    for (const review of resolved) {
      const list = byPlayer.get(review.resolvedPlayerId) ?? [];
      list.push(review);
      byPlayer.set(review.resolvedPlayerId, list);
    }

    let created = 0;
    const players: { playerId: string; name: string; net: number; recovered: number }[] = [];

    for (const [playerId, reviews] of byPlayer) {
      const player = await this.players.getById(playerId);
      if (!player) continue;

      const result = await this.evidence.insertProposed(
        reviews.map((review) => this.evidenceFor(review, player, review.matchedText)),
      );
      if (result.inserted === 0) continue;

      created += result.inserted;
      const signal = await this.evidence.refreshSignal(playerId, { now: opts.now });
      players.push({ playerId, name: player.fullName, net: signal.raw.net, recovered: result.inserted });
    }

    return { checked: resolved.length, created, players };
  }
}
