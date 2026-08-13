/**
 * Deterministic newsletter sentence classification.
 *
 * No LLM, no probabilistic model: a sentence is scanned against the editable
 * rule dictionary, negation is applied inside a bounded token window, and the
 * aggregate polarity is derived from the surviving matches.
 *
 * Contradictory evidence stays `mixed`. Anything that is not unambiguous comes
 * back below `high` confidence, and only `high` may be auto-applied.
 */

import {
  ALL_RULES,
  CLAUSE_BOUNDARIES,
  CONTRAST_PATTERNS,
  HEDGE_PATTERNS,
  NEGATION_CUES,
  NEGATION_WINDOW_TOKENS,
  activeRules,
  type ClassificationRule,
  type EvidenceCategory,
  type Polarity,
} from './rules.ts';

export type Confidence = 'high' | 'medium' | 'low';

export interface RuleMatch {
  ruleId: string;
  category: EvidenceCategory;
  /** Polarity declared by the rule. */
  declaredPolarity: 'positive' | 'negative';
  /** Polarity after negation handling. */
  effectivePolarity: 'positive' | 'negative';
  magnitude: 1 | 2 | 3;
  negated: boolean;
  negationCue: string | null;
  matchedText: string;
  index: number;
}

export interface Classification {
  polarity: Polarity;
  /** 0 for neutral/mixed/uncertain; otherwise the dominant rule magnitude. */
  magnitude: 0 | 1 | 2 | 3;
  confidence: Confidence;
  /** Numeric confidence in [0,1], exposed for sorting the review queue. */
  confidenceScore: number;
  category: EvidenceCategory | null;
  matches: RuleMatch[];
  /** Rule ids joined by `+`, persisted as `evidence_items.rule_id`. */
  ruleId: string | null;
  /** Deterministic template text, or null when no safe template exists. */
  contextSummary: string | null;
  /** Why this landed where it did — shown verbatim in the review UI. */
  notes: string[];
}

export interface ClassifyOptions {
  rules?: ClassificationRule[];
  /** Number of distinct players mentioned in the same sentence. */
  playersInSentence?: number;
  /** True when the subject player's identity was not resolved cleanly. */
  identityAmbiguous?: boolean;
}

/** Detect a negation cue in the bounded window before `index`. */
export function detectNegation(
  sentence: string,
  index: number,
): { negated: boolean; cue: string | null } {
  const before = sentence.slice(0, index);
  const tokens = before.split(/\s+/).filter(Boolean);
  const window = tokens.slice(-NEGATION_WINDOW_TOKENS);

  for (let i = window.length - 1; i >= 0; i--) {
    const token = window[i]!;
    // Negation never crosses a clause boundary.
    if (CLAUSE_BOUNDARIES.test(token)) return { negated: false, cue: null };
    for (const cue of NEGATION_CUES) {
      if (cue.test(token)) return { negated: true, cue: token.replace(/[^a-zA-Z']/g, '') };
    }
  }
  return { negated: false, cue: null };
}

function findMatches(sentence: string, rules: ClassificationRule[]): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const m = rule.pattern.exec(sentence);
    if (!m) continue;
    const index = m.index;
    const { negated, cue } = rule.selfNegating
      ? { negated: false, cue: null }
      : detectNegation(sentence, index);
    const effectivePolarity: 'positive' | 'negative' = negated
      ? rule.polarity === 'positive'
        ? 'negative'
        : 'positive'
      : rule.polarity;
    matches.push({
      ruleId: rule.id,
      category: rule.category,
      declaredPolarity: rule.polarity,
      effectivePolarity,
      // A negated statement is weaker evidence than a direct one.
      magnitude: negated ? 1 : rule.magnitude,
      negated,
      negationCue: cue,
      matchedText: m[0],
      index,
    });
  }
  return matches.sort((a, b) => a.index - b.index);
}

/**
 * Classify one sentence.
 *
 * Guarantees:
 *  - never returns `high` confidence when positive and negative signals coexist
 *  - never returns `high` confidence when identity is ambiguous or several
 *    players share the sentence
 *  - never invents summary prose: `contextSummary` is composed only of rule
 *    templates, otherwise it is null
 */
export function classifySentence(sentence: string, opts: ClassifyOptions = {}): Classification {
  const rules = activeRules(opts.rules ?? ALL_RULES);
  const matches = findMatches(sentence, rules);
  const notes: string[] = [];

  if (matches.length === 0) {
    return {
      polarity: 'neutral',
      magnitude: 0,
      confidence: 'high',
      confidenceScore: 0.9,
      category: null,
      matches: [],
      ruleId: null,
      contextSummary: null,
      notes: ['no classification rule matched'],
    };
  }

  const positives = matches.filter((m) => m.effectivePolarity === 'positive');
  const negatives = matches.filter((m) => m.effectivePolarity === 'negative');

  const posWeight = positives.reduce((a, m) => a + m.magnitude, 0);
  const negWeight = negatives.reduce((a, m) => a + m.magnitude, 0);

  let polarity: Polarity;
  let dominant: RuleMatch[];
  if (positives.length > 0 && negatives.length > 0) {
    polarity = 'mixed';
    dominant = matches;
    notes.push('positive and negative signals in the same sentence');
  } else if (positives.length > 0) {
    polarity = 'positive';
    dominant = positives;
  } else {
    polarity = 'negative';
    dominant = negatives;
  }

  const magnitude = (polarity === 'mixed'
    ? 0
    : Math.max(...dominant.map((m) => m.magnitude))) as 0 | 1 | 2 | 3;

  // ---- confidence ---------------------------------------------------------
  let confidence: Confidence = 'high';
  const demote = (level: Confidence, why: string) => {
    if (rank(level) < rank(confidence)) confidence = level;
    notes.push(why);
  };

  if (polarity === 'mixed') demote('low', 'mixed signals require review');

  const hedge = HEDGE_PATTERNS.find((p) => p.test(sentence));
  if (hedge) demote('medium', 'hedging language');

  const hasContrast = CONTRAST_PATTERNS.some((p) => p.test(sentence));
  if (hasContrast && polarity !== 'mixed' && matches.length > 1) {
    demote('medium', 'contrast connective with multiple signals');
  }

  // A flip is only risky when every supporting match had to be flipped.
  const flippedOnly = dominant.length > 0 && dominant.every((m) => m.negated);
  if (flippedOnly) demote('medium', 'polarity derived entirely from negation');

  const players = opts.playersInSentence ?? 1;
  if (players === 2) demote('medium', 'two players in the same sentence');
  if (players > 2) demote('low', 'more than two players in the same sentence');

  if (opts.identityAmbiguous) demote('low', 'player identity ambiguous');

  if (sentence.length > 400) demote('medium', 'very long sentence');

  const confidenceScore = scoreFor(confidence, posWeight, negWeight);
  const category = pickCategory(dominant);

  return {
    polarity,
    magnitude,
    confidence,
    confidenceScore,
    category,
    matches,
    ruleId: matches.map((m) => m.ruleId).join('+'),
    contextSummary: buildContextSummary(matches, polarity),
    notes,
  };
}

function rank(c: Confidence): number {
  return c === 'high' ? 3 : c === 'medium' ? 2 : 1;
}

function scoreFor(c: Confidence, posWeight: number, negWeight: number): number {
  const base = c === 'high' ? 0.9 : c === 'medium' ? 0.6 : 0.3;
  const dominance = Math.abs(posWeight - negWeight) / Math.max(1, posWeight + negWeight);
  return Math.round(Math.min(0.99, base * (0.85 + 0.15 * dominance)) * 100) / 100;
}

function pickCategory(matches: RuleMatch[]): EvidenceCategory | null {
  if (matches.length === 0) return null;
  const best = [...matches].sort((a, b) => b.magnitude - a.magnitude || a.index - b.index)[0]!;
  return best.category;
}

/**
 * Compose a context summary from rule templates only.
 * Returns null when no matched rule carries a template, so the caller stores a
 * truncated excerpt instead of fabricated prose.
 */
export function buildContextSummary(matches: RuleMatch[], polarity: Polarity): string | null {
  const templates = (rules: RuleMatch[]) =>
    rules
      .map((m) => ALL_RULES.find((r) => r.id === m.ruleId)?.template)
      .filter((t): t is string => !!t);

  if (polarity === 'mixed') {
    const pos = templates(matches.filter((m) => m.effectivePolarity === 'positive'))[0];
    const neg = templates(matches.filter((m) => m.effectivePolarity === 'negative'))[0];
    if (pos && neg) return `${pos} However: ${neg.replace(/\.$/, '')}.`;
    return pos ?? neg ?? null;
  }

  const unique = [...new Set(templates(matches))];
  if (unique.length === 0) return null;
  return unique.slice(0, 2).join(' ');
}

/** Only unambiguous, high-confidence, non-mixed evidence may bypass review. */
export function canAutoApply(c: Classification): boolean {
  if (c.confidence !== 'high') return false;
  if (c.polarity === 'mixed' || c.polarity === 'uncertain') return false;
  return true;
}

/** Signed tally contribution. Mixed and neutral contribute exactly 0. */
export function tallyDelta(polarity: Polarity, magnitude: number): number {
  if (polarity === 'positive') return magnitude;
  if (polarity === 'negative') return -magnitude;
  return 0;
}
