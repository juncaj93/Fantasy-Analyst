/**
 * Backfill importer for a hand-maintained running tally.
 *
 * This exists for one situation: newsletters that were read before the app
 * existed, whose original text is gone, but whose conclusions were kept as a
 * summary table. Importing that is better than starting from zero.
 *
 * What it is NOT: a second classification path. It parses no prose and applies
 * no rules. Each row is a score somebody already decided, carried across as a
 * single evidence item and labelled as a backfill so it stays distinguishable
 * from anything the parser produced — and reversible in Review.
 *
 * Honesty rules enforced here:
 *  - A row's net score covers several issues. It becomes ONE item of that
 *    magnitude, never fabricated into N separate items that were never seen.
 *  - The sign comes from the score, and a score that disagrees with the list it
 *    sits under is a contradiction, not something to resolve by preferring one.
 *  - A player listed twice is a contradiction too, and goes to review.
 *  - A name that does not resolve is reported, never guessed at.
 */

import { resolvePlayer, type PlayerIndex } from '../identity/index.ts';
import type { Polarity } from './rules.ts';
import type { IdentityReviewItem, ProposedEvidence } from './pipeline.ts';
import { stableHash } from './fingerprint.ts';

export interface TallyRow {
  name: string;
  score: number;
  drivers: string;
  /** Which list the row appeared under. */
  section: 'good' | 'bad' | 'neutral';
  lineNumber: number;
}

export interface TallyImportResult {
  evidence: ProposedEvidence[];
  /**
   * Rows whose name did not resolve, as review items.
   *
   * A row that cannot be matched is not discarded — it goes to the same queue
   * as an unresolved newsletter mention, so it stays visible and fixable
   * instead of quietly disappearing between the file and the ledger.
   */
  identityReviews: IdentityReviewItem[];
  rowsParsed: number;
  matched: number;
  /** Rows whose name resolved to more than one player. */
  ambiguous: { name: string; reason: string; candidates: string[] }[];
  /** Rows whose name matched nobody. */
  unmatched: { name: string; reason: string }[];
  /** Rows that contradict each other or their own section. */
  conflicts: string[];
  /**
   * The id every row was filed under, whether it was passed in or derived from
   * the document. The caller needs it to find what a previous import of the
   * same document left behind.
   */
  sourceMessageId: string;
  /** Human-readable summary, safe to show as-is. */
  detail: string;
}

export interface TallyImportOptions {
  /** ISO date recorded as the source date for every item. */
  sourceDate?: string;
  sourceName?: string;
  /** Stable id so re-importing the same tally does not duplicate it. */
  sourceMessageId?: string;
}

const TABLE_ROW = /^\|\s*([^|]+?)\s*\|\s*([+-]?\d+)\s*\|\s*([^|]*?)\s*\|\s*$/;
const BULLET_ROW = /^[-*]\s+(.+?)\s+[—–-]\s+(.+)$/;

/**
 * Read the tally document.
 *
 * Deliberately tolerant about layout — a hand-maintained file drifts — but
 * strict about the two things that carry meaning: the name and the number.
 */
export function parseTally(markdown: string): TallyRow[] {
  const rows: TallyRow[] = [];
  let section: TallyRow['section'] | null = null;

  markdown.split(/\r?\n/).forEach((line, i) => {
    const lineNumber = i + 1;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1]!.toLowerCase();
      if (title.includes('good')) section = 'good';
      else if (title.includes('bad')) section = 'bad';
      else if (title.includes('neutral')) section = 'neutral';
      else section = null;
      return;
    }
    if (!section) return;

    const table = TABLE_ROW.exec(line);
    if (table) {
      const name = table[1]!.trim();
      // Skip the header and its `|---|` separator.
      if (!name || /^-+$/.test(name) || name.toLowerCase() === 'player') return;
      rows.push({
        name,
        score: Number(table[2]),
        drivers: table[3]!.trim(),
        section,
        lineNumber,
      });
      return;
    }

    if (section === 'neutral') {
      const bullet = BULLET_ROW.exec(line.trim());
      if (bullet) {
        rows.push({
          name: bullet[1]!.trim(),
          score: 0,
          drivers: bullet[2]!.trim(),
          section,
          lineNumber,
        });
      }
    }
  });

  return rows;
}

export function importTally(
  markdown: string,
  index: PlayerIndex,
  opts: TallyImportOptions = {},
): TallyImportResult {
  const sourceDate = opts.sourceDate ?? new Date().toISOString();
  const sourceName = opts.sourceName ?? 'Imported tally';
  const sourceMessageId = opts.sourceMessageId ?? `tally-${stableHash(markdown)}`;

  const rows = parseTally(markdown);
  const evidence: ProposedEvidence[] = [];
  const identityReviews: IdentityReviewItem[] = [];
  const ambiguous: TallyImportResult['ambiguous'] = [];
  const unmatched: TallyImportResult['unmatched'] = [];
  const conflicts: string[] = [];

  // A player who appears twice has two different answers in one document.
  const seenNames = new Map<string, TallyRow>();
  const duplicated = new Set<string>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const previous = seenNames.get(key);
    if (previous) {
      duplicated.add(key);
      conflicts.push(
        `${row.name} is listed twice (${previous.score >= 0 ? '+' : ''}${previous.score} in the ${previous.section} list, ` +
          `${row.score >= 0 ? '+' : ''}${row.score} in the ${row.section} list) — both were sent to review rather than picking one.`,
      );
    } else {
      seenNames.set(key, row);
    }
  }

  rows.forEach((row, i) => {
    const sectionDisagrees =
      (row.section === 'good' && row.score < 0) ||
      (row.section === 'bad' && row.score > 0) ||
      (row.section === 'neutral' && row.score !== 0);
    if (sectionDisagrees) {
      conflicts.push(
        `${row.name} scores ${row.score >= 0 ? '+' : ''}${row.score} but sits in the ${row.section} list.`,
      );
    }

    const match = resolvePlayer({ name: row.name }, index);
    const polarityOf = (score: number): Polarity =>
      score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';

    if (match.status !== 'matched' || !match.playerId) {
      // Either way the row is kept as something a human can resolve.
      identityReviews.push({
        sourceMessageId,
        sourceDate,
        excerpt: row.drivers || row.name,
        matchedText: row.name,
        reason: match.reason,
        candidates: match.candidates.map((c) => ({
          playerId: c.player.id,
          name: c.player.fullName,
          team: c.player.team ?? '',
          position: c.player.position ?? '',
          detail: c.detail ?? '',
        })),
        proposedPolarity: polarityOf(row.score),
        proposedCategory: null,
        // The row's own net score, so confirming who this is recovers the score
        // the user actually wrote rather than a ±1 stand-in for it.
        proposedMagnitude: Math.abs(row.score),
      });
      if (match.status === 'ambiguous') {
        ambiguous.push({
          name: row.name,
          reason: match.reason,
          candidates: match.candidates.map((c) => `${c.player.fullName} (${c.player.position} ${c.player.team})`),
        });
      } else {
        unmatched.push({ name: row.name, reason: match.reason });
      }
      return;
    }

    const polarity = polarityOf(row.score);
    const contested = duplicated.has(row.name.toLowerCase()) || sectionDisagrees;

    evidence.push({
      // Keyed on the tally document and the row, so re-importing the same file
      // changes nothing and importing a later revision adds only what moved.
      dedupeKey: stableHash(`tally|${sourceMessageId}|${match.playerId}|${row.score}|${row.drivers}`),
      playerId: match.playerId,
      playerName: row.name,
      sourceType: 'newsletter',
      sourceName,
      sourceMessageId,
      sourceDate,
      excerpt: row.drivers || `${row.name}: ${row.score >= 0 ? '+' : ''}${row.score}`,
      contextSummary: `Carried over from a running tally covering several earlier issues (net ${row.score >= 0 ? '+' : ''}${row.score}).`,
      category: null,
      polarity,
      magnitude: Math.abs(row.score),
      // Never "high": this is somebody's summary of material the app never saw,
      // so it should not outrank a rule that read the actual sentence.
      confidence: 'medium',
      confidenceScore: 0.6,
      ruleId: 'tally-backfill',
      // A neutral row contributes nothing, so applying it automatically would
      // be applying nothing; contested rows must be looked at by a human.
      reviewStatus: contested || polarity === 'neutral' ? 'pending' : 'auto_applied',
      notes: [
        'imported-tally',
        ...(duplicated.has(row.name.toLowerCase()) ? ['listed-twice'] : []),
        ...(sectionDisagrees ? ['score-disagrees-with-section'] : []),
        ...(polarity === 'neutral' ? ['net-zero'] : []),
      ],
      blockIndex: i,
    });
  });

  const applied = evidence.filter((e) => e.reviewStatus === 'auto_applied').length;
  const review = evidence.length - applied;
  const parts = [
    `${rows.length} row(s) read.`,
    `${evidence.length} matched to a player (${applied} applied, ${review} sent for review).`,
  ];
  if (ambiguous.length) parts.push(`${ambiguous.length} name(s) matched more than one player.`);
  if (unmatched.length) parts.push(`${unmatched.length} name(s) were not recognised.`);
  if (conflicts.length) parts.push(`${conflicts.length} contradiction(s) found.`);

  return {
    evidence,
    identityReviews,
    rowsParsed: rows.length,
    matched: evidence.length,
    ambiguous,
    unmatched,
    conflicts,
    sourceMessageId,
    detail: parts.join(' '),
  };
}
