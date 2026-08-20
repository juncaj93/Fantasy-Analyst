/**
 * MIME decoding for inbound newsletters.
 *
 * This module exists because the newsletter parser is only ever as good as the
 * text it is handed. A newsletter that arrives as `=E2=80=9C` instead of `“`
 * does not fail loudly — it produces sentence fragments that quietly match no
 * rule, which reads in the diagnostics as "the rules are bad" rather than "the
 * decoder is broken". So decoding is done properly here, once, to the standard,
 * rather than compensated for with search-and-replace further down.
 *
 * What "properly" means, in the order the layers actually apply:
 *
 *   1. RFC 5322 header unfolding — a header may be continued on the next line,
 *      and the `boundary=` parameter of a `Content-Type` very often is.
 *   2. Recursive multipart traversal — `multipart/mixed` wrapping
 *      `multipart/alternative` is ordinary, not exotic.
 *   3. Transfer decoding to BYTES — quoted-printable and base64 both describe
 *      octets, not characters.
 *   4. Charset decoding of those bytes — `=E2=80=9C` is three UTF-8 octets for
 *      one character, so decoding each octet to its own code point produces
 *      mojibake (`â€œ`) rather than a smart quote.
 *   5. RFC 2047 encoded words, for the header values themselves.
 *
 * Nothing here throws. A malformed message degrades to the best text that could
 * be recovered from it, because losing a week of newsletter evidence is worse
 * than parsing a slightly wrong body.
 */

/** Guards against a pathological or hostile nesting depth. */
const MAX_DEPTH = 8;
/** Guards against a message that claims thousands of parts. */
const MAX_PARTS = 200;

export interface ParsedEmailParts {
  headers: Map<string, string>;
  html: string | null;
  text: string | null;
}

// --------------------------------------------------------------- headers ----

/**
 * Undo RFC 5322 folding: a header line continued by leading whitespace is one
 * logical line.
 *
 * This is the single most consequential function in the file. A `Content-Type`
 * folded before its `boundary=` parameter makes a multipart message look like a
 * message with no boundary at all, and the whole raw MIME body — boundaries,
 * part headers, undecoded quoted-printable and all — then gets treated as the
 * newsletter's plain text.
 */
export function unfoldHeaders(block: string): string {
  return block.replace(/\r?\n[ \t]+/g, ' ');
}

/** Parse a header block into a lower-cased-name map. Later duplicates lose. */
export function parseHeaderBlock(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of unfoldHeaders(block).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!name || /[^\x21-\x39\x3b-\x7e]/.test(name)) continue;
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

/** Split a message (or a part) into its header block and its body. */
export function splitHeadersAndBody(raw: string): { headers: Map<string, string>; body: string } {
  const blank = raw.search(/\r?\n\r?\n/);
  if (blank === -1) {
    // No blank line: either all headers or all body. A line with a colon in the
    // first position of the first line is the only evidence available.
    return /^[\x21-\x39\x3b-\x7e]+:/.test(raw)
      ? { headers: parseHeaderBlock(raw), body: '' }
      : { headers: new Map(), body: raw };
  }
  return {
    headers: parseHeaderBlock(raw.slice(0, blank)),
    body: raw.slice(blank).replace(/^\r?\n\r?\n/, ''),
  };
}

/** The `type/subtype` of a Content-Type value, lower-cased. */
export function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** One parameter of a header value, e.g. `boundary` or `charset`. */
export function headerParam(value: string, name: string): string | null {
  const re = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i');
  const m = re.exec(value);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
}

// -------------------------------------------------------- transfer coding ----

/**
 * Decode quoted-printable to octets.
 *
 * Returns bytes rather than a string on purpose: `=E2=80=9C` is one character
 * spelled in three octets, and only the charset step knows that.
 */
export function decodeQuotedPrintableBytes(input: string): Uint8Array {
  // Soft line breaks first — they are pure line-length padding and carry no data.
  const s = input.replace(/=[ \t]*\r?\n/g, '').replace(/=$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '=' && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code <= 0xff) bytes.push(code);
    // A body that already contains non-Latin-1 characters was decoded upstream;
    // re-encode it so the charset step sees a consistent octet stream.
    else for (const b of utf8Bytes(ch)) bytes.push(b);
  }
  return new Uint8Array(bytes);
}

/** Decode base64 to octets. Whitespace and non-alphabet padding are ignored. */
export function decodeBase64Bytes(input: string): Uint8Array {
  const payload = input.replace(/[^A-Za-z0-9+/]/g, '');
  if (!payload) return new Uint8Array(0);
  // A truncated final quantum is unrecoverable; drop it rather than throw.
  const usable = payload.slice(0, payload.length - (payload.length % 4 === 1 ? 1 : 0));
  try {
    const binary = atob(usable.padEnd(Math.ceil(usable.length / 4) * 4, '='));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function utf8Bytes(ch: string): number[] {
  try {
    return [...new TextEncoder().encode(ch)];
  } catch {
    return [ch.charCodeAt(0) & 0xff];
  }
}

/**
 * Decode octets using a charset label.
 *
 * Falls back rather than throwing: an unknown label is far better handled as
 * UTF-8 than as a failed ingestion.
 */
export function decodeCharset(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '') || 'utf-8';
  for (const candidate of label === 'utf-8' ? ['utf-8'] : [label, 'utf-8']) {
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch {
      // Workers ships a narrower encoding table than Node; try the next label.
    }
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/**
 * Apply one part's Content-Transfer-Encoding and charset.
 *
 * `7bit`/`8bit`/`binary` are identity transfers, but the octets still need
 * charset interpretation — so a body that is still a byte string (every code
 * unit ≤ 0xFF) is decoded, and one that already holds real Unicode is passed
 * through untouched.
 */
export function decodeTransfer(body: string, encoding: string | null, charset: string | null): string {
  const enc = (encoding ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (enc === 'quoted-printable') return decodeCharset(decodeQuotedPrintableBytes(body), charset);
  if (enc === 'base64') return decodeCharset(decodeBase64Bytes(body), charset);
  if (!isByteString(body)) return body;
  return decodeCharset(latin1Bytes(body), charset);
}

function isByteString(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

function latin1Bytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

// ------------------------------------------------------------ RFC 2047 ------

/**
 * Decode encoded words in a header value: `=?UTF-8?Q?Week_1=E2=80=94Camp?=`.
 *
 * Whitespace separating two adjacent encoded words is a separator, not content,
 * so it is dropped — otherwise a subject split across words gains spaces that
 * were never in it.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes =
          enc.toLowerCase() === 'b'
            ? decodeBase64Bytes(data)
            : // In a Q-encoded word `_` stands for a space; a literal underscore
              // is spelled `=5F`, so this substitution cannot lose one.
              decodeQuotedPrintableBytes(data.replace(/_/g, ' '));
        return decodeCharset(bytes, charset);
      } catch {
        return whole;
      }
    });
}

// -------------------------------------------------------------- multipart ---

/**
 * Split a multipart body on its boundary.
 *
 * Anchored to line starts, because a boundary string may legitimately appear
 * inside base64 or inside prose, and a naive `split` would tear the message
 * apart at those points. The preamble before the first delimiter and everything
 * after the closing `--boundary--` are discarded, as the standard requires.
 */
export function splitMultipart(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}[ \\t]*(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');

  const parts: string[] = [];
  let cursor: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = delimiter.exec(body)) !== null) {
    if (cursor !== null) parts.push(body.slice(cursor, m.index));
    if (m[1] === '--') return parts.slice(0, MAX_PARTS); // closing delimiter
    cursor = m.index + m[0].length;
    if (parts.length >= MAX_PARTS) break;
  }
  if (cursor !== null) parts.push(body.slice(cursor));
  return parts.slice(0, MAX_PARTS);
}

/**
 * Walk one entity, filling in the first `text/html` and `text/plain` bodies.
 *
 * Attachments are skipped: a PDF's base64 is not newsletter prose, and letting
 * it through is how binary noise reaches the player-name detector.
 */
function walk(headers: Map<string, string>, body: string, out: ParsedEmailParts, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (out.html !== null && out.text !== null) return;

  const contentType = headers.get('content-type') ?? 'text/plain';
  const type = mediaType(contentType) || 'text/plain';
  const disposition = (headers.get('content-disposition') ?? '').toLowerCase();

  if (type.startsWith('multipart/')) {
    const boundary = headerParam(contentType, 'boundary');
    if (!boundary) return;
    for (const part of splitMultipart(body, boundary)) {
      const sub = splitHeadersAndBody(part);
      walk(sub.headers, sub.body, out, depth + 1);
      if (out.html !== null && out.text !== null) return;
    }
    return;
  }

  if (disposition.startsWith('attachment')) return;
  if (type !== 'text/html' && type !== 'text/plain') return;

  const decoded = decodeTransfer(
    body,
    headers.get('content-transfer-encoding') ?? null,
    headerParam(contentType, 'charset'),
  );
  if (type === 'text/html') {
    if (out.html === null) out.html = decoded;
  } else if (out.text === null) {
    out.text = decoded;
  }
}

/**
 * A body that begins at a boundary delimiter, with no headers of its own.
 *
 * This is precisely what the folded-header bug stored: everything from the
 * first delimiter onwards, with the top-level `Content-Type` that declared the
 * multipart left behind in the header block. Read naively, the FIRST part's
 * headers get mistaken for the message's own, and the remaining parts — the
 * HTML alternative among them — are swallowed into that part's body.
 *
 * Recognising the shape restores the boundary the lost header would have named.
 * The token must be used as a delimiter at least twice, so a line of prose that
 * happens to start with two hyphens is not mistaken for one.
 */
export function leadingBoundary(raw: string): string | null {
  const first = raw.split(/\r?\n/).find((line) => line.trim() !== '');
  const m = first == null ? null : /^--([^\s-]\S*?)(?:--)?$/.exec(first.trim());
  if (!m) return null;
  const token = m[1]!;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uses = raw.match(new RegExp(`(?:^|\\r?\\n)--${escaped}[ \\t]*(?:--)?[ \\t]*(?=\\r?\\n|$)`, 'g'));
  return (uses?.length ?? 0) >= 2 ? token : null;
}

/**
 * Parse a raw RFC 5322 message into its HTML and plain-text bodies.
 *
 * Tolerates a fragment that begins mid-message — a stored body that is really a
 * multipart chunk still yields its parts — which is what makes salvaging an
 * already-ingested corrupt newsletter possible.
 */
export function parseMimeMessage(raw: string): ParsedEmailParts {
  const out: ParsedEmailParts = { headers: new Map(), html: null, text: null };
  if (!raw) return out;
  try {
    // A headerless multipart body is walked as the multipart it is, rather than
    // letting its first part impersonate the whole message.
    const orphaned = leadingBoundary(raw);
    if (orphaned) {
      for (const part of splitMultipart(raw, orphaned)) {
        const sub = splitHeadersAndBody(part);
        walk(sub.headers, sub.body, out, 1);
        if (out.html !== null && out.text !== null) break;
      }
      return out;
    }
    const { headers, body } = splitHeadersAndBody(raw);
    out.headers = headers;
    walk(headers, body, out, 0);
  } catch {
    // Fall through: an unparseable message keeps whatever was recovered.
  }
  return out;
}

// ------------------------------------------------------------- normalizing --

/**
 * Fold Unicode punctuation to the ASCII the rule dictionary is written in.
 *
 * The HTML entity table already maps `&rsquo;` to `'` and `&mdash;` to `-`, so
 * this is the same convention applied to the characters themselves. It matters
 * for matching, not only for looks: `neg.did_not_practice` tests `did ?n[o']?t`
 * and a curly apostrophe in `didn’t` slips straight past it.
 */
export function normalizePunctuation(input: string): string {
  return input
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[•‣▪●◦·⁃]/g, '-')
    .replace(/…/g, '...')
    // Every flavour of exotic space reads as a word separator, including the
    // line/paragraph separators — a name split by one must still be one name.
    .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ')
    // Zero-width marks carry no meaning and would otherwise break a name apart.
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '');
}

// ---------------------------------------------------------------- salvage ---

/**
 * Does this stored body look like a raw MIME message rather than a body?
 *
 * Deliberately demanding: both a `Content-Type` header line and either a
 * boundary delimiter or a transfer-encoding header must be present at a line
 * start. Prose mentioning "Content-Type:" in passing does not qualify, and the
 * cost of a false positive — re-parsing a body that was already fine and
 * recovering nothing — is bounded by only accepting a result that has content.
 */
export function looksLikeRawMime(body: string): boolean {
  if (!body) return false;
  const head = body.slice(0, 8000);
  if (!/^content-type:[ \t]*[a-z]+\/[a-z0-9.+-]+/im.test(head)) return false;
  return /^--[^\s-][^\s]*[ \t]*$/m.test(head) || /^content-transfer-encoding:[ \t]*\S+/im.test(head);
}

/**
 * Does this text still carry undecoded quoted-printable?
 *
 * A hex escape is the unambiguous signature, and encoders emit it in upper
 * case, so requiring one keeps prose containing something like `21=21` from
 * being mistaken for an encoded body. A soft line break alone is not enough on
 * its own: an HTML body wrapped mid-attribute has them too, and re-decoding a
 * body that was already fine is the one way this salvage could do harm.
 */
export function looksLikeQuotedPrintable(body: string): boolean {
  if (!body) return false;
  const escapes = (body.match(/=[0-9A-F]{2}/g) ?? []).length;
  if (escapes === 0) return false;
  return escapes >= 3 || /=[ \t]*\r?\n/.test(body);
}

/**
 * Repair text that is UTF-8 octets which were decoded one-octet-per-character.
 *
 * This is what the previous quoted-printable decoder produced: `“` arrived as
 * `â€œ`. The repair is the inverse of the mistake — re-encode to the octets that
 * were really there and decode them as UTF-8 — rather than a lookup table of
 * mojibake spellings, and it is only kept if the result is valid UTF-8.
 */
export function repairMojibake(input: string): string {
  if (!input) return input;
  // The signature of the mistake: a Latin-1 lead byte followed by a continuation.
  if (!/[\u00c2-\u00c5\u00e2\u00e3][\u0080-\u00bf]/.test(input)) return input;
  if (!isByteString(input)) return input;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(latin1Bytes(input));
  } catch {
    return input;
  }
}

export interface RecoveredBody {
  html: string | null;
  text: string | null;
  /** Machine-readable list of the repairs that were applied, in order. */
  repairs: string[];
}

/**
 * Recover the readable bodies of a newsletter that was stored badly decoded.
 *
 * The pipeline runs this on the way in, so a newsletter already sitting in the
 * message log with a raw MIME blob for a body is repaired by reprocessing it —
 * no migration, no re-delivery, and the message keeps its identity. On a
 * correctly decoded newsletter every check declines and the bodies are returned
 * untouched, which is what makes it safe to run unconditionally.
 */
export function recoverBody(input: { html?: string | null; text?: string | null }): RecoveredBody {
  const repairs: string[] = [];
  let html = input.html ?? null;
  let text = input.text ?? null;

  // A raw MIME blob may have been stored under either field.
  for (const field of ['html', 'text'] as const) {
    const value = field === 'html' ? html : text;
    if (!value || !looksLikeRawMime(value)) continue;
    const parsed = parseMimeMessage(value);
    if (parsed.html === null && parsed.text === null) continue;
    repairs.push(`${field}:mime_reparsed`);
    if (parsed.html !== null) html = parsed.html;
    if (parsed.text !== null) text = parsed.text;
    if (field === 'html' && parsed.html === null) html = null;
    if (field === 'text' && parsed.text === null && parsed.html !== null) text = null;
  }

  const finish = (value: string | null, field: string): string | null => {
    if (value === null) return null;
    let out = value;
    if (looksLikeQuotedPrintable(out)) {
      out = decodeCharset(decodeQuotedPrintableBytes(out), 'utf-8');
      repairs.push(`${field}:quoted_printable_decoded`);
    }
    const repaired = repairMojibake(out);
    if (repaired !== out) {
      repairs.push(`${field}:mojibake_repaired`);
      out = repaired;
    }
    return out;
  };

  return { html: finish(html, 'html'), text: finish(text, 'text'), repairs };
}
