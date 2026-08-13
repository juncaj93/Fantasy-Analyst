/**
 * Player mention detection over newsletter text.
 *
 * Candidate spans are generated from capitalised token n-grams and resolved
 * through the canonical identity ladder. Surname-only mentions are deliberately
 * conservative: they resolve only when the surname is unique in the dictionary
 * or when the same document already introduced that player by full name.
 */

import { PlayerIndex, resolvePlayer } from '../identity/index.ts';
import { normalizeName } from '../identity/normalize.ts';
import type { MatchResult } from '../identity/types.ts';

export interface PlayerMention {
  playerId: string | null;
  /** Text exactly as it appeared. */
  matchedText: string;
  normalized: string;
  start: number;
  end: number;
  match: MatchResult;
  /** True when the mention was only a surname. */
  surnameOnly: boolean;
}

/**
 * Surnames that are also everyday words. A bare occurrence is only accepted
 * when the same document already introduced the player by full name.
 * Editable alongside the rule dictionary.
 */
export const COMMON_WORD_SURNAMES = new Set([
  'love', 'brown', 'white', 'green', 'smart', 'rice', 'price', 'wise', 'young',
  'strong', 'bell', 'gray', 'moss', 'best', 'chase', 'sweat', 'french', 'long',
  'small', 'wood', 'field', 'fields', 'hill', 'hunt', 'may', 'good', 'rush',
  'st', 'first', 'james', 'mark', 'will', 'winston',
]);

const NAME_TOKEN = /^[A-Z][A-Za-z'’.\-]*$/;
const SUFFIX_TOKEN = /^(Jr\.?|Sr\.?|II|III|IV|V)$/;
const MAX_SPAN = 4;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z'’.\-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function isNameToken(t: string): boolean {
  return NAME_TOKEN.test(t) || SUFFIX_TOKEN.test(t);
}

export interface DetectOptions {
  /**
   * Canonical player ids already introduced by full name earlier in the same
   * document. Used for surname anaphora.
   */
  documentPlayerIds?: Set<string>;
  /** Team hint, when the newsletter section is team-scoped. */
  teamHint?: string | null;
}

/**
 * Detect player mentions in a single sentence or block.
 * Longest spans win; overlapping shorter spans are discarded.
 */
export function detectMentions(
  text: string,
  index: PlayerIndex,
  opts: DetectOptions = {},
): PlayerMention[] {
  const tokens = tokenize(text);
  const mentions: PlayerMention[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const first = tokens[i]!;
    if (!isNameToken(first.text)) continue;

    let placed = false;
    for (let len = Math.min(MAX_SPAN, tokens.length - i); len >= 2 && !placed; len--) {
      const span = tokens.slice(i, i + len);
      if (span.some((t, k) => k > 0 && !isNameToken(t.text))) continue;
      const raw = text.slice(span[0]!.start, span[span.length - 1]!.end);
      const result = resolvePlayer({ name: raw, team: opts.teamHint ?? null }, index);
      if (result.status === 'unmatched') continue;
      mentions.push(toMention(raw, span[0]!.start, span[span.length - 1]!.end, result, false));
      for (let k = i; k < i + len; k++) consumed.add(k);
      placed = true;
    }
    if (placed) continue;

    // Single-token (surname or unique first name) fallback.
    const normalized = normalizeName(first.text);
    if (!normalized) continue;

    // A nickname the user taught the app is checked before anything is guessed.
    // Short forms like "JSN" are one token and are not anybody's surname, so
    // without this the nickname could be stored and still never match.
    const aliasHits = index.byAliasKey(normalized).filter((p) => p.active);
    if (aliasHits.length === 1) {
      const player = aliasHits[0]!;
      mentions.push(
        toMention(first.text, first.start, first.end, {
          status: 'matched',
          playerId: player.id,
          method: 'alias',
          confidence: 0.95,
          candidates: [],
          reason: `"${first.text}" is a saved nickname for ${player.fullName}`,
        }, false),
      );
      consumed.add(i);
      continue;
    }

    const surnameHits = index.bySurnameKey(normalized).filter((p) => p.active);
    if (surnameHits.length === 0) continue;

    const isSentenceStart = first.start === 0 || /^[.!?]\s*$/.test(text.slice(Math.max(0, first.start - 2), first.start));
    const risky = COMMON_WORD_SURNAMES.has(normalized) || isSentenceStart;

    const known = surnameHits.filter((p) => opts.documentPlayerIds?.has(p.id));
    if (known.length === 1) {
      const player = known[0]!;
      mentions.push(
        toMention(first.text, first.start, first.end, {
          status: 'matched',
          playerId: player.id,
          method: 'anaphora',
          confidence: 0.88,
          candidates: [
            { playerId: player.id, player, method: 'anaphora', confidence: 0.88, detail: 'introduced earlier in this document' },
          ],
          reason: 'surname resolved to a player named earlier in the document',
        }, true),
      );
      consumed.add(i);
      continue;
    }
    // A "risky" token (everyday word, or sentence-initial where capitalisation
    // proves nothing) is never auto-resolved. It still goes to review when the
    // surrounding sentence carries a signal, so the user decides rather than the
    // parser guessing — or silently dropping real news.
    if (!risky && known.length <= 1 && surnameHits.length === 1) {
      const player = surnameHits[0]!;
      mentions.push(
        toMention(first.text, first.start, first.end, {
          status: 'matched',
          playerId: player.id,
          method: 'name_unique',
          confidence: 0.75,
          candidates: [
            { playerId: player.id, player, method: 'name_unique', confidence: 0.75, detail: 'unique surname in player dictionary' },
          ],
          reason: 'unique surname match',
        }, true),
      );
      consumed.add(i);
      continue;
    }

    // Unresolved surname: emit an ambiguous mention carrying its candidates.
    // The pipeline only turns this into a review item when the sentence
    // actually carries a signal, which keeps the queue free of noise.
    mentions.push(
      toMention(first.text, first.start, first.end, {
        status: 'ambiguous',
        playerId: null,
        method: null,
        confidence: 0,
        candidates: surnameHits.slice(0, 5).map((p) => ({
          playerId: p.id,
          player: p,
          method: 'fuzzy' as const,
          confidence: 0.4,
          detail: `shares surname (${p.team || 'FA'} ${p.position})`,
        })),
        reason:
          surnameHits.length === 1
            ? `surname "${first.text}" is an everyday word or sentence-initial; confirm the player`
            : `${surnameHits.length} active players share the surname "${first.text}"`,
      }, true),
    );
    consumed.add(i);
  }

  return mentions.sort((a, b) => a.start - b.start);
}

/**
 * Words that routinely start a sentence and would otherwise look like the first
 * token of a name. Used only by the coverage report, never by matching.
 */
const SENTENCE_STARTERS = new Set([
  'the', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'he', 'she',
  'they', 'it', 'we', 'you', 'i', 'a', 'an', 'and', 'but', 'if', 'after',
  'before', 'while', 'when', 'with', 'without', 'both', 'head', 'coach',
  'offensive', 'defensive', 'no', 'not', 'per', 'via', 'in', 'on', 'at', 'for',
  'meanwhile', 'however', 'elsewhere', 'week', 'sunday', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday',
]);

/**
 * Capitalised two-to-three token spans that look like a person's name but did
 * not resolve to any canonical player.
 *
 * COVERAGE REPORTING ONLY — this never feeds matching or evidence. It exists so
 * gaps in the player dictionary and the rule set are visible without an LLM.
 * Spans overlapping an already-resolved mention are excluded.
 */
export function collectUnresolvedNames(
  text: string,
  index: PlayerIndex,
  resolved: PlayerMention[] = [],
): string[] {
  const tokens = tokenize(text);
  const taken = resolved.map((m) => [m.start, m.end] as const);
  const overlaps = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);

  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]!;
    if (!NAME_TOKEN.test(first.text)) continue;
    if (SENTENCE_STARTERS.has(first.text.toLowerCase())) continue;

    for (let len = 3; len >= 2; len--) {
      const span = tokens.slice(i, i + len);
      if (span.length < len) continue;
      if (span.some((t) => !isNameToken(t.text))) continue;
      const start = span[0]!.start;
      const end = span[span.length - 1]!.end;
      if (overlaps(start, end)) break;
      const raw = text.slice(start, end);
      if (resolvePlayer({ name: raw }, index).status !== 'unmatched') break;
      out.add(raw);
      break;
    }
  }
  return [...out];
}

function toMention(
  matchedText: string,
  start: number,
  end: number,
  match: MatchResult,
  surnameOnly: boolean,
): PlayerMention {
  return {
    playerId: match.status === 'matched' ? match.playerId : null,
    matchedText,
    normalized: normalizeName(matchedText),
    start,
    end,
    match,
    surnameOnly,
  };
}
