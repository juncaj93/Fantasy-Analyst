/**
 * Newsletter HTML -> clean text blocks.
 *
 * Tolerant by design: newsletter HTML is frequently malformed (unclosed tags,
 * inline styles, tracking pixels, MSO conditionals). This module never throws;
 * worst case it returns fewer blocks.
 *
 * By the time text reaches here it has been transfer- and charset-decoded (see
 * `mime.ts`). What remains is to decide where one thought ends and the next
 * begins — which is not the same question in HTML as in plain text, and getting
 * it wrong is how a newsletter turns into hundreds of fragments that match no
 * rule. See `extractBlocks`.
 */

import { normalizePunctuation } from './mime.ts';

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
  // Newlines in HTML source are insignificant whitespace: the boundaries have
  // already been recorded by the block-level tags above.
  s = s.replace(/[\r\n\t\f\v\u00a0\u200b\u2028\u2029]/g, ' ');
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
  // Substack chrome. It surrounds the article on every issue, mentions players
  // in "recent posts" teasers, and is not the newsletter's own reporting.
  // The action row reads "Like \u00b7 Comment \u00b7 Restack", and punctuation
  // normalization has already turned every separator into a hyphen.
  { id: 'substack_actions', pattern: /^(?:(?:like|comment|restack|share|read in app|view comments?|leave a comment)\s*[|\u00b7-]?\s*)+$/i },
  { id: 'substack_upgrade', pattern: /\b(upgrade to paid|subscribe now|become a (paid|founding) (subscriber|member)|pledge your support)\b/i },
  { id: 'substack_forward', pattern: /\b(forwarded this (email|post)\?|refer a friend|share this post)\b/i },
  { id: 'substack_app', pattern: /\b(read (this )?(post )?(in|on) the substack app|get the substack app)\b/i },
  { id: 'substack_attribution', pattern: /^a guest post by\b/i },
  { id: 'reader_count', pattern: /^\d[\d,.]*\s*(likes?|comments?|restacks?|shares?|subscribers?)$/i },
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
 * Strip tracking and redirect URLs, keeping the visible text around them.
 *
 * A newsletter's plain-text part spells a link as `Keenan Allen [ https://... ]`
 * and the reader's eye skips the bracket entirely. The parser does not: the URL
 * becomes tokens, its path segments become name candidates, and the sentence it
 * was embedded in stops resembling English. The anchor text is the content; the
 * target is plumbing.
 */
export function stripLinkNoise(text: string): string {
  return (
    text
      // `visible text [ https://... ]` and `visible text < https://... >`.
      .replace(/\s*\[\s*(?:https?:\/\/|www\.)[^\]]*\]/gi, '')
      .replace(/\s*<\s*(?:https?:\/\/|www\.)[^>]*>/gi, '')
      // A bare URL left in prose.
      .replace(/\bhttps?:\/\/\S+/gi, ' ')
      .replace(/\bwww\.[^\s,;)\]]+/gi, ' ')
      // Tidy what a removed link leaves stranded.
      .replace(/\(\s*\)/g, ' ')
      .replace(/\[\s*\]/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** Bullet markers, as they read after punctuation normalization. */
const BULLET_MARKER = /^[-*]\s+/;

/**
 * Split HTML into candidate blocks.
 *
 * Only the block-level tags decide a boundary. A newline in HTML source is
 * insignificant whitespace — the sender's text editor wrapping a column — and
 * treating it as a boundary chops mid-sentence, which is how
 * `<li>Keenan Allen is dealing with a heel injury - he did not\npractice.</li>`
 * became two fragments that between them matched nothing.
 */
function htmlPieces(html: string): string[] {
  return htmlToText(html).split(BLOCK_BOUNDARY);
}

/**
 * Split plain text into candidate blocks.
 *
 * The inverse problem: here a newline IS often just wrapping, because senders
 * hard-wrap plain-text parts at around 72 columns. A paragraph is what sits
 * between blank lines, and a bullet starts one of its own; every other line
 * break inside a paragraph is rejoined.
 */
function textPieces(text: string): string[] {
  const pieces: string[] = [];
  for (const paragraph of text.split(/\r?\n[ \t]*\r?\n/)) {
    let current = '';
    for (const line of paragraph.split(/\r?\n/)) {
      if (BULLET_MARKER.test(line.trim()) && current.trim()) {
        pieces.push(current);
        current = line;
      } else {
        current = current ? `${current} ${line}` : line;
      }
    }
    if (current.trim()) pieces.push(current);
  }
  return pieces;
}

/**
 * Convert raw newsletter content (HTML or plain text) into ordered, deduped,
 * boilerplate-free text blocks.
 *
 * Punctuation is normalized first, so that bullet detection sees one marker
 * rather than six, and so the rule dictionary — written in ASCII — meets the
 * apostrophe it expects in `didn't` rather than the typographic one the
 * newsletter actually shipped.
 */
export function extractBlocks(raw: string, opts: { isHtml?: boolean } = {}): TextBlock[] {
  const isHtml = opts.isHtml ?? looksLikeHtml(raw);
  const source = normalizePunctuation(raw);
  const pieces = (isHtml ? htmlPieces(source) : textPieces(source))
    .map((p) => stripLinkNoise(p.replace(/\s+/g, ' ').trim()))
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
    // The marker told us this is a list item; it is not part of the sentence.
    const kind = classifyBlock(piece);
    blocks.push({ index: blocks.length, text: piece.replace(BULLET_MARKER, ''), kind });
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
