/**
 * Newsletter HTML -> clean text blocks.
 *
 * Tolerant by design: newsletter HTML is frequently malformed (unclosed tags,
 * inline styles, tracking pixels, MSO conditionals). This module never throws;
 * worst case it returns fewer blocks.
 */

export interface TextBlock {
  /** 0-based index in document order. */
  index: number;
  text: string;
  kind: 'heading' | 'paragraph' | 'list_item';
}

const BLOCK_BOUNDARY = '\u0001';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  middot: '-',
  bull: '-',
  reg: '',
  copy: '(c)',
  trade: '',
  eacute: 'e',
  aacute: 'a',
  iacute: 'i',
  oacute: 'o',
  uacute: 'u',
  ntilde: 'n',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name: string) => {
      const key = name.toLowerCase();
      return key in ENTITIES ? ENTITIES[key]! : m;
    });
}

function safeFromCode(code: number): string {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Strip markup and produce boundary-delimited text.
 * Script/style/head content is removed entirely, never rendered.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Unclosed script/style at EOF.
  s = s.replace(/<(script|style)\b[\s\S]*$/gi, ' ');
  // Block-level tags become boundaries.
  s = s.replace(/<\s*(br|hr)\s*\/?>/gi, BLOCK_BOUNDARY);
  s = s.replace(
    /<\s*\/?\s*(p|div|tr|td|th|table|section|article|header|footer|ul|ol|blockquote|h[1-6]|li)\b[^>]*>/gi,
    BLOCK_BOUNDARY,
  );
  s = s.replace(/<[^>]*>/g, ' ');
  // A stray unclosed final tag.
  s = s.replace(/<[^>]*$/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\t\f\v\u00a0\u200b\u2028\u2029]/g, ' ');
  return s;
}

/** Detect whether input looks like HTML rather than plain text. */
export function looksLikeHtml(input: string): boolean {
  return /<\s*(html|body|div|p|table|br|span|a)\b/i.test(input);
}

/**
 * Boilerplate patterns removed before player detection.
 * Editable: extend this list as new newsletter chrome shows up.
 */
export const BOILERPLATE_PATTERNS: { id: string; pattern: RegExp }[] = [
  { id: 'unsubscribe', pattern: /\bunsubscribe\b/i },
  { id: 'view_in_browser', pattern: /view (this )?(email|newsletter) in (your )?browser/i },
  { id: 'email_preferences', pattern: /(manage|update|edit) (your )?(email )?(preferences|subscription)/i },
  { id: 'copyright', pattern: /(^|\s)(©|\(c\)|copyright)\s*\d{4}/i },
  { id: 'all_rights', pattern: /all rights reserved/i },
  { id: 'sent_to', pattern: /this (e-?mail|message) (was|is being) sent to/i },
  { id: 'you_received', pattern: /you (are )?receiv(ed|ing) this (e-?mail|because)/i },
  { id: 'privacy_policy', pattern: /\b(privacy policy|terms of service|terms and conditions)\b/i },
  { id: 'social_follow', pattern: /^(follow us|connect with us|share this)\b/i },
  { id: 'social_links', pattern: /^(twitter|facebook|instagram|x|youtube|tiktok|linkedin)(\s*[|\u00b7\-\u2022]\s*(twitter|facebook|instagram|x|youtube|tiktok|linkedin))+$/i },
  { id: 'mailing_address', pattern: /\b\d{1,5}\s+\w+(\s+\w+)*\s+(st|street|ave|avenue|rd|road|blvd|suite|ste)\b.*\b\d{5}\b/i },
  { id: 'advertisement', pattern: /^(advertisement|sponsored( content| by)?|presented by)\b/i },
  { id: 'app_promo', pattern: /(download (the|our) app|available on the app store|get it on google play)/i },
  { id: 'nav_chrome', pattern: /^(home|about|archive|subscribe|contact|newsletter)(\s*[|\u00b7\-\u2022]\s*\w+)+$/i },
];

/** A block is boilerplate when a pattern matches and it carries no sentence content. */
export function isBoilerplate(text: string): { boilerplate: boolean; ruleId: string | null } {
  const t = text.trim();
  if (!t) return { boilerplate: true, ruleId: 'empty' };
  if (t.length < 3) return { boilerplate: true, ruleId: 'too_short' };
  // Pure link/handle rows.
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return { boilerplate: true, ruleId: 'bare_url' };
  if (/^@[\w.]+$/.test(t)) return { boilerplate: true, ruleId: 'bare_handle' };
  for (const rule of BOILERPLATE_PATTERNS) {
    if (rule.pattern.test(t)) return { boilerplate: true, ruleId: rule.id };
  }
  return { boilerplate: false, ruleId: null };
}

/**
 * Convert raw newsletter content (HTML or plain text) into ordered, deduped,
 * boilerplate-free text blocks.
 */
export function extractBlocks(raw: string, opts: { isHtml?: boolean } = {}): TextBlock[] {
  const isHtml = opts.isHtml ?? looksLikeHtml(raw);
  const text = isHtml ? htmlToText(raw) : raw;
  const pieces = text
    .split(new RegExp(`[${BLOCK_BOUNDARY}\\n]`))
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const blocks: TextBlock[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const { boilerplate } = isBoilerplate(piece);
    if (boilerplate) continue;
    // Repeated title metadata / duplicated nav lines.
    const key = piece.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ index: blocks.length, text: piece, kind: classifyBlock(piece) });
  }
  return blocks;
}

function classifyBlock(text: string): TextBlock['kind'] {
  if (/^[-*\u2022\u00b7\u25cf]\s+/.test(text)) return 'list_item';
  // Short, no terminal punctuation, title-ish -> heading.
  if (text.length <= 60 && !/[.!?]$/.test(text) && /^[A-Z0-9]/.test(text)) return 'heading';
  return 'paragraph';
}

const ABBREVIATIONS = /\b(No|St|Mr|Mrs|Dr|Jr|Sr|vs|etc|approx|Inc|Co|Sept|Oct|Nov|Dec|Jan|Feb|Aug|U\.S|e\.g|i\.e)\.$/i;

/** Split a block into sentences, guarding common abbreviations. */
export function splitSentences(block: string): string[] {
  const rough = block.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buffer = '';
  for (const part of rough) {
    buffer = buffer ? `${buffer} ${part}` : part;
    if (ABBREVIATIONS.test(buffer.trim())) continue;
    // A single trailing initial ("J.") is not a sentence end.
    if (/\b[A-Z]\.$/.test(buffer.trim())) continue;
    out.push(buffer.trim());
    buffer = '';
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out.filter(Boolean);
}
