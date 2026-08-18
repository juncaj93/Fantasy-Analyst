/**
 * One sentence saying *why* the tally says what it says.
 *
 * `Drake Maye +4` is a direction and a magnitude. It is not a reason, and a
 * reader who wants the reason currently has to open the evidence timeline and
 * read eleven excerpts. The takeaway is the single most decision-relevant thing
 * the ledger actually supports, lifted to the top of the expanded card.
 *
 * Everything about this module is a constraint against the obvious ways it could
 * go wrong:
 *
 *   - **it never writes a new claim.** The sentence is selected from evidence
 *     that already exists, or assembled by fixed templates from fields that
 *     already exist. There is no generation step, no paraphrase and no model.
 *     If nothing supports a sentence, the answer is `null`, and `null` is a
 *     perfectly good answer that the card is built to show nothing for;
 *   - **it never strengthens what the source said.** A source saying a player
 *     "looked sharp" does not become "elite"; a source saying "#1 in completion
 *     rate over the cited span" keeps the span. Superlatives survive only when
 *     they are in the source, and are carried verbatim when they are;
 *   - **it changes no number.** Not the tally, not Draft Score, not Start/Sit,
 *     not the waiver ranking, not trade value. The evidence it draws on has
 *     already been counted once by the tally; counting it again as a "headline
 *     bonus" would be double-counting the same sentence, which is precisely the
 *     failure mode this project's whole evidence model exists to prevent. The
 *     returned object carries `scoreDelta: 0` so that this is a fact about the
 *     type rather than a promise in a comment;
 *   - **it is deterministic.** The same ledger produces the same sentence, on
 *     any machine, with no clock dependence beyond the recency comparison it is
 *     explicitly given.
 */

import type { EvidenceItem } from './types.ts';
import { effectiveEvidence } from './aggregate.ts';

export interface TakeawayCandidate {
  itemId: string;
  text: string;
  sourceName: string;
  sourceDate: string;
  score: number;
  /** How the wording was produced, which the provenance view shows verbatim. */
  derivation: 'extracted' | 'templated';
}

export interface NewsletterTakeaway {
  /** The sentence. Never generated, never strengthened. */
  text: string;
  /** Every evidence item that supports it — usually one, more when corroborated. */
  evidenceItemIds: string[];
  sourceName: string;
  sourceDate: string;
  derivation: 'extracted' | 'templated';
  /** How many independent items said the same thing. 1 is normal. */
  corroboration: number;
  /** Always 0. The takeaway explains the tally; it does not add to it. */
  scoreDelta: 0;
  /** Runners-up, kept for the deeper evidence view rather than the card. */
  alternatives: TakeawayCandidate[];
}

/** Review states whose evidence may be quoted. Mirrors the tally's own set. */
const QUOTABLE = new Set(['auto_applied', 'accepted', 'corrected']);

/**
 * Categories, ranked by how much they change a fantasy decision.
 *
 * This ordering is the module's single most opinionated line, and it is
 * defensible: a role change alters every week from now on, an injury alters
 * whether he plays at all, and a coach's compliment alters nothing. Performance
 * sits mid-table deliberately — a big game is the most quoted fact in any
 * newsletter and among the least predictive.
 */
const CATEGORY_WEIGHT: Record<string, number> = {
  role: 5,
  depth_chart: 5,
  usage: 4.5,
  injury: 4,
  health: 3.5,
  transaction: 3,
  suspension: 3,
  competition: 2.5,
  practice: 2,
  performance: 2,
  coach_comment: 0.5,
  other: 0.5,
};

/** Days after which evidence is stale enough to lose to a fresher rival. */
export const RECENCY_HALF_LIFE_DAYS = 21;

/**
 * Facts a fantasy manager can act on, as opposed to praise.
 *
 * Specificity is the thing being detected: a number, a rank, a snap count, a
 * named role. "Looked explosive" and "leads the league in targets" are both
 * positive and only one of them is a fact.
 */
const SPECIFICITY_PATTERNS: { pattern: RegExp; points: number }[] = [
  /*
   * A ranking with a number attached — the most decision-relevant shape there
   * is. Note the boundary: `\b#` can never match, because `#` is not a word
   * character and the space before it is not a word character either, so the
   * alternation puts `\b` only where a word actually starts.
   */
  { pattern: /(?:\bno\.?|#)\s?\d+\b|\b\d+(?:st|nd|rd|th)\s+(?:in|among|most)\b/i, points: 3 },
  // Percentages and explicit shares: snap share, target share, route share.
  { pattern: /\b\d{1,3}(?:\.\d+)?\s?%/, points: 2.5 },
  { pattern: /\b(?:snap|target|route|carry|touch|red[- ]zone)\s+share\b/i, points: 2.5 },
  // Counted opportunity.
  { pattern: /\b\d{1,3}\s+(?:targets?|carries|touches|snaps?|receptions?|attempts?)\b/i, points: 2 },
  // A named role.
  { pattern: /\b(?:RB1|RB2|WR1|WR2|WR3|TE1|QB1|starter|three[- ]down|bell[- ]cow|lead back|slot|X|Z)\b/, points: 1.5 },
  // A timeframe makes any claim checkable.
  { pattern: /\b(?:over the (?:last|past)|since week|through week|in the last)\b/i, points: 1 },
];

/** Praise with nothing behind it. Loses to anything specific. */
const GENERIC_PATTERNS: RegExp[] = [
  /^\s*(?:he|they)?\s*(?:looked|looks|has looked)\s+\w+\.?\s*$/i,
  /\b(?:sleeper|breakout candidate|buy low|sell high|value pick)\b/i,
  /\b(?:impressive|solid|nice|good|great|strong)\s+(?:camp|showing|performance|game)\b/i,
];

export interface TakeawayOptions {
  /** The instant "recent" is measured against. Injected, so this stays pure. */
  now: Date;
  /** How many runners-up to keep for the provenance view. */
  alternatives?: number;
  /** Minimum score before anything is shown at all. */
  minScore?: number;
  /**
   * Whose card this is.
   *
   * Supplied whenever the caller has it, because a reassignment lives in
   * `userOverride.playerId` rather than in the row's own column: an item filed
   * under one player and corrected to another is still returned by a naive
   * "evidence for this player" query, and quoting it here would put another
   * player's sentence on this card. Omit only when the list is already known to
   * be one player's effective evidence.
   */
  playerId?: string;
}

/**
 * The bar below which no sentence is worth the top of a card.
 *
 * A takeaway that says less than the tally already said is worse than no
 * takeaway: it costs a line and buys a shrug.
 */
export const MIN_TAKEAWAY_SCORE = 3;

/**
 * Choose the sentence.
 *
 * The order of operations is the brief's, and each step throws work away rather
 * than blending it: gather, deduplicate, weight by recency and category and
 * specificity, take the best, and return null if the best is not good enough.
 * Nothing is ever averaged into a compound claim, because an average of two
 * sentences is a third sentence nobody wrote.
 */
export function selectTakeaway(items: EvidenceItem[], opts: TakeawayOptions): NewsletterTakeaway | null {
  const minScore = opts.minScore ?? MIN_TAKEAWAY_SCORE;

  const usable = items.filter((item) => {
    if (!QUOTABLE.has(item.reviewStatus)) return false;
    const effective = effectiveEvidence(item);
    if (opts.playerId != null && effective.playerId !== opts.playerId) return false;
    /*
     * A neutral or mixed item contributes nothing to the tally and must not be
     * allowed to explain it. It is real information and it lives in the
     * timeline; it is not the reason the number is what it is.
     */
    if (effective.polarity === 'neutral' || effective.polarity === 'mixed') return false;
    return sentenceOf(item) != null;
  });

  if (usable.length === 0) return null;

  /*
   * Deduplicate on the sentence itself, not on the item id.
   *
   * The same newsletter line reaches the ledger more than once legitimately —
   * two issues repeating a fact, a reprocess after a correction — and a naive
   * "most corroborated" reading would then be a measure of how often something
   * was reprinted. Identical text collapses to one candidate that *remembers*
   * how many items it came from, so genuine corroboration still counts and
   * republication does not.
   */
  const groups = new Map<string, { items: EvidenceItem[]; text: string }>();
  for (const item of usable) {
    const text = sentenceOf(item) as string;
    const key = normalise(text);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { items: [item], text });
  }

  const candidates = [...groups.values()]
    .map((group) => {
      /*
       * Corroboration counts *distinct sources or dates*, not rows. Two items
       * from the same message id saying the same thing is one observation that
       * happened to be stored twice.
       */
      const distinct = new Set(group.items.map((i) => `${i.sourceName}|${i.sourceDate}`)).size;
      const newest = group.items.reduce((a, b) => (a.sourceDate >= b.sourceDate ? a : b));
      const score = scoreCandidate(group.text, newest, distinct, opts.now);
      return {
        itemId: newest.id,
        itemIds: group.items.map((i) => i.id),
        text: group.text,
        sourceName: newest.sourceName,
        sourceDate: newest.sourceDate,
        score,
        corroboration: distinct,
        derivation: (newest.contextSummary && newest.contextSummary === group.text ? 'templated' : 'extracted') as
          | 'extracted'
          | 'templated',
      };
    })
    /*
     * Ties break on date then on id, never on iteration order. A takeaway that
     * changes when the same ledger is read twice is not deterministic, and this
     * is the line that makes it so.
     */
    .sort((a, b) => b.score - a.score || b.sourceDate.localeCompare(a.sourceDate) || a.itemId.localeCompare(b.itemId));

  const best = candidates[0];
  if (!best || best.score < minScore) return null;

  return {
    text: best.text,
    evidenceItemIds: best.itemIds,
    sourceName: best.sourceName,
    sourceDate: best.sourceDate,
    derivation: best.derivation,
    corroboration: best.corroboration,
    scoreDelta: 0,
    alternatives: candidates.slice(1, 1 + (opts.alternatives ?? 2)).map((c) => ({
      itemId: c.itemId,
      text: c.text,
      sourceName: c.sourceName,
      sourceDate: c.sourceDate,
      score: c.score,
      derivation: c.derivation,
    })),
  };
}

/**
 * The sentence a single evidence item offers.
 *
 * The user's own correction note wins — it is the one piece of text in the
 * ledger a human wrote on purpose about this player. After that the
 * deterministic template, then the stored excerpt. The excerpt is used verbatim
 * or not at all: trimming a sentence is the cheapest way to change what it says.
 */
export function sentenceOf(item: EvidenceItem): string | null {
  const note = item.userOverride?.note?.trim();
  if (note) return tidy(note);

  const summary = item.contextSummary?.trim();
  if (summary) return tidy(summary);

  const excerpt = item.excerpt?.trim();
  if (!excerpt) return null;
  /*
   * A long excerpt is a paragraph, not a takeaway, and cutting it to fit is
   * exactly the "strengthen or generalise" failure the brief rules out. Better
   * to decline and let a shorter, equally supported item win.
   */
  if (excerpt.length > 160) return null;
  return tidy(excerpt);
}

function scoreCandidate(text: string, item: EvidenceItem, corroboration: number, now: Date): number {
  const effective = effectiveEvidence(item);
  let score = CATEGORY_WEIGHT[effective.category ?? 'other'] ?? 0.5;

  for (const { pattern, points } of SPECIFICITY_PATTERNS) {
    if (pattern.test(text)) score += points;
  }
  for (const pattern of GENERIC_PATTERNS) {
    if (pattern.test(text)) score -= 2;
  }

  // A stronger classification is a stronger claim, bounded so a magnitude-3
  // rule cannot outrank a specific fact on its own.
  score += Math.min(effective.magnitude, 3) * 0.5;

  // Repeated by two different issues is worth more than said once, with a hard
  // cap so a widely reprinted platitude cannot win on volume.
  score += Math.min(corroboration - 1, 2) * 0.75;

  /*
   * Recency, as a decay rather than a cutoff.
   *
   * A three-week-old role change is still the reason the tally reads the way it
   * does; a cutoff would discard it and leave the card explaining a +4 with a
   * practice report. Halving every three weeks lets a genuinely important old
   * fact keep beating a trivial new one, and stops it beating an equally
   * important new one.
   */
  const ageDays = Math.max(0, (now.getTime() - Date.parse(item.sourceDate)) / 86_400_000);
  if (Number.isFinite(ageDays)) score *= 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);

  // Confidence the classifier itself reported. A low-confidence read is not a
  // headline, whatever it says.
  if (item.confidence === 'low') score *= 0.6;
  else if (item.confidence === 'medium') score *= 0.85;

  return Math.round(score * 1000) / 1000;
}

/** Whitespace only. Wording is never altered. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}
