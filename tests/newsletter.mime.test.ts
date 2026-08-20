/**
 * The newsletter decoding layers, tested where they actually broke.
 *
 * Production received a newsletter, read it, and turned 209 player sentences
 * into exactly one signal. The rules were not at fault: the email never reached
 * them as text. `Content-Type: multipart/mixed;` was folded before its
 * `boundary=` parameter, the header reader saw only the first physical line,
 * and with no boundary the entire raw MIME body — part headers, boundary
 * markers, undecoded quoted-printable and both alternative parts at once — was
 * handed downstream as the newsletter's plain text.
 *
 * So these tests are deliberately per-layer rather than one golden fixture. A
 * single end-to-end assertion would have gone green again the moment any one of
 * the four defects was patched, and would not say which.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeBase64Bytes,
  decodeCharset,
  decodeEncodedWords,
  decodeQuotedPrintableBytes,
  decodeTransfer,
  headerParam,
  looksLikeQuotedPrintable,
  looksLikeRawMime,
  normalizePunctuation,
  parseMimeMessage,
  recoverBody,
  repairMojibake,
  splitMultipart,
  unfoldHeaders,
} from '../src/core/newsletter/mime.ts';
import { extractBlocks, splitSentences, stripLinkNoise } from '../src/core/newsletter/html.ts';
import { collectUnresolvedNames, detectMentions } from '../src/core/newsletter/mentions.ts';
import { processNewsletter } from '../src/core/newsletter/pipeline.ts';
import { parseRawEmail } from '../src/worker/index.ts';
import { TEST_INDEX } from './helpers/players.ts';
import { SUBSTACK_RAW_MIME, SUBSTACK_RAW_MIME_TEXT_ONLY } from './fixtures/newsletters.ts';

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ------------------------------------------------------------- headers ------
describe('header parsing', () => {
  /**
   * The root cause, isolated. Every other symptom in the incident followed from
   * this one line being read a physical line at a time.
   */
  it('unfolds a Content-Type continued on the next line', () => {
    const folded = 'Content-Type: multipart/mixed;\r\n boundary="--==_mimepart_68aa"';
    expect(unfoldHeaders(folded)).toBe('Content-Type: multipart/mixed; boundary="--==_mimepart_68aa"');
    expect(headerParam(unfoldHeaders(folded), 'boundary')).toBe('--==_mimepart_68aa');
  });

  it('finds no boundary in the folded header without unfolding — the original bug', () => {
    const firstLineOnly = 'Content-Type: multipart/mixed;';
    expect(headerParam(firstLineOnly, 'boundary')).toBeNull();
  });

  it('reads a parameter whether it is quoted or bare', () => {
    expect(headerParam('text/html; charset="utf-8"', 'charset')).toBe('utf-8');
    expect(headerParam('text/html; charset=utf-8', 'charset')).toBe('utf-8');
    expect(headerParam("text/html; charset='utf-8'", 'charset')).toBe('utf-8');
    expect(headerParam('text/html', 'charset')).toBeNull();
  });

  it('decodes RFC 2047 encoded words, joining adjacent ones without a space', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Week_1_=E2=80=94_Risers?=')).toBe('Week 1 — Risers');
    expect(decodeEncodedWords('=?UTF-8?B?V2VlayAx?=')).toBe('Week 1');
    // `_` is a space in Q encoding; a literal underscore is =5F and survives.
    expect(decodeEncodedWords('=?UTF-8?Q?a=5Fb?=')).toBe('a_b');
    // Whitespace between two encoded words is a separator, not content.
    expect(decodeEncodedWords('=?UTF-8?Q?Week?= =?UTF-8?Q?_1?=')).toBe('Week 1');
    expect(decodeEncodedWords('plain subject')).toBe('plain subject');
  });
});

// --------------------------------------------------- transfer + charset -----
describe('transfer and charset decoding', () => {
  /**
   * The distinction the previous decoder missed: quoted-printable describes
   * OCTETS. Turning each octet into its own code point spells `“` as `â€œ`.
   */
  it('decodes UTF-8 punctuation as characters, not as one character per byte', () => {
    expect(utf8(decodeQuotedPrintableBytes('=E2=80=9Cthe engine=E2=80=9D'))).toBe('“the engine”');
    expect(utf8(decodeQuotedPrintableBytes('=E2=80=A2 bullet'))).toBe('• bullet');
    expect(utf8(decodeQuotedPrintableBytes('a =E2=80=93 b'))).toBe('a – b');
    expect(utf8(decodeQuotedPrintableBytes('didn=E2=80=99t'))).toBe('didn’t');
    // The one-byte-per-character mistake, spelled out.
    expect(utf8(decodeQuotedPrintableBytes('=E2=80=9C'))).not.toBe('â€œ');
  });

  it('removes soft line breaks without eating the following character', () => {
    expect(utf8(decodeQuotedPrintableBytes('called him =\r\nthe engine'))).toBe('called him the engine');
    expect(utf8(decodeQuotedPrintableBytes('offense=2E'))).toBe('offense.');
    // A trailing soft break with nothing after it.
    expect(utf8(decodeQuotedPrintableBytes('trailing ='))).toBe('trailing ');
  });

  it('leaves a lone = that is not an escape alone', () => {
    expect(utf8(decodeQuotedPrintableBytes('a=zz b'))).toBe('a=zz b');
  });

  it('decodes base64 to UTF-8 and tolerates missing padding and line breaks', () => {
    const encoded = Buffer.from('Puka Nacua — limited', 'utf8').toString('base64');
    expect(utf8(decodeBase64Bytes(encoded))).toBe('Puka Nacua — limited');
    expect(utf8(decodeBase64Bytes(`${encoded.slice(0, 8)}\r\n${encoded.slice(8)}`))).toBe('Puka Nacua — limited');
    expect(decodeBase64Bytes('').length).toBe(0);
    expect(() => decodeBase64Bytes('!!!not base64!!!')).not.toThrow();
  });

  it('honours the part charset and falls back rather than throwing', () => {
    const latin1 = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]); // "José" in ISO-8859-1
    expect(decodeCharset(latin1, 'iso-8859-1')).toBe('José');
    expect(() => decodeCharset(latin1, 'not-a-real-charset')).not.toThrow();
    expect(decodeCharset(new TextEncoder().encode('José'), 'utf-8')).toBe('José');
  });

  it('treats 7bit/8bit as an identity transfer that still needs a charset', () => {
    // A byte string, as the worker hands it over.
    expect(decodeTransfer('JosÃ©', '8bit', 'utf-8')).toBe('José');
    // Text that is already Unicode is passed straight through.
    expect(decodeTransfer('José —', null, 'utf-8')).toBe('José —');
  });
});

// ------------------------------------------------------------ multipart -----
describe('multipart splitting', () => {
  it('splits only on line-anchored delimiters and stops at the closing one', () => {
    const body = ['preamble', '--B', 'part one', '--B', 'part two', '--B--', 'epilogue'].join('\r\n');
    const parts = splitMultipart(body, 'B');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('part one');
    expect(parts[1]).toContain('part two');
    expect(parts.join('')).not.toContain('preamble');
    expect(parts.join('')).not.toContain('epilogue');
  });

  it('does not tear a part apart where the boundary appears mid-line', () => {
    const body = ['--B', 'a line mentioning --B in passing', '--B--'].join('\r\n');
    expect(splitMultipart(body, 'B')[0]).toContain('mentioning --B in passing');
  });

  it('walks a nested multipart to reach the parts inside it', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="OUT"',
      '',
      '--OUT',
      'Content-Type: multipart/alternative; boundary="IN"',
      '',
      '--IN',
      'Content-Type: text/plain',
      '',
      'plain body',
      '--IN',
      'Content-Type: text/html',
      '',
      '<p>html body</p>',
      '--IN--',
      '--OUT--',
    ].join('\r\n');
    const parsed = parseMimeMessage(raw);
    expect(parsed.text).toContain('plain body');
    expect(parsed.html).toContain('html body');
  });

  it('skips attachments so binary payloads never reach the text parser', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attached notes',
      '--B',
      'Content-Type: text/plain',
      '',
      'the real body',
      '--B--',
    ].join('\r\n');
    expect(parseMimeMessage(raw).text).toContain('the real body');
    expect(parseMimeMessage(raw).text).not.toContain('attached notes');
  });

  it('never throws on malformed or truncated MIME', () => {
    for (const raw of [
      '',
      'Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain',
      'Content-Type: multipart/mixed\r\n\r\nno boundary parameter at all',
      '--B\r\n--B--',
    ]) {
      expect(() => parseMimeMessage(raw)).not.toThrow();
    }
  });
});

// --------------------------------------------- the production newsletter ----
describe('the newsletter that failed in production', () => {
  it('extracts both parts instead of dumping the whole MIME body as text', () => {
    const parsed = parseRawEmail(SUBSTACK_RAW_MIME);
    expect(parsed.html).not.toBeNull();
    expect(parsed.text).not.toBeNull();
    // The failure signature: the body carrying its own MIME scaffolding.
    for (const body of [parsed.html!, parsed.text!]) {
      expect(body).not.toContain('Content-Transfer-Encoding');
      expect(body).not.toContain('mimepart');
      expect(body).not.toContain('=E2=80');
    }
  });

  it('decodes the punctuation the diagnostics showed raw', () => {
    const parsed = parseRawEmail(SUBSTACK_RAW_MIME);
    expect(parsed.text).toContain('“the engine”');
    expect(parsed.text).toContain('•');
    expect(parsed.text).toContain('–');
    expect(parsed.text).toContain('didn’t');
  });

  it('decodes the encoded-word subject', () => {
    expect(parseRawEmail(SUBSTACK_RAW_MIME).subject).toBe('Week 1 Camp Risers — Who’s Up');
  });

  it('reads the sender and message id from the folded header block', () => {
    const parsed = parseRawEmail(SUBSTACK_RAW_MIME);
    expect(parsed.from).toBe('Fantasy Football Weekly <ffweekly@substack.com>');
    expect(parsed.messageId).toBe('<issue.4f2a1c@mg-d0.substack.com>');
  });
});

// ----------------------------------------------------------- link noise -----
describe('link and boilerplate handling', () => {
  it('keeps the anchor text and drops the tracking target', () => {
    expect(stripLinkNoise('Bijan Robinson [ https://substack.com/redirect/9f2b1a3c?j=eyJ1 ] was named the starter.'))
      .toBe('Bijan Robinson was named the starter.');
    expect(stripLinkNoise('See https://substack.com/redirect/abc for more.')).toBe('See for more.');
    expect(stripLinkNoise('Read < https://example.com/x > now.')).toBe('Read now.');
    expect(stripLinkNoise('Visit www.example.com/path today.')).toBe('Visit today.');
  });

  it('leaves prose that contains no link untouched', () => {
    const prose = 'Puka Nacua did not practice on Wednesday.';
    expect(stripLinkNoise(prose)).toBe(prose);
  });

  it('preserves visible anchor text from HTML while discarding the href', () => {
    const blocks = extractBlocks(
      '<p><a href="https://substack.com/redirect/9f2b1a3c?j=eyJ1">Bijan Robinson</a> was named the starter.</p>',
      { isHtml: true },
    );
    expect(blocks[0]?.text).toBe('Bijan Robinson was named the starter.');
  });

  it('drops Substack chrome without dropping the article', () => {
    const blocks = extractBlocks(
      '<p>Like · Comment · Restack</p><p>Upgrade to paid</p><p>Share this post</p>' +
        '<p>Bijan Robinson was named the starter.</p>',
      { isHtml: true },
    );
    expect(blocks.map((b) => b.text)).toEqual(['Bijan Robinson was named the starter.']);
  });
});

// ------------------------------------------------------- block splitting ----
describe('block and sentence extraction', () => {
  /**
   * HTML source wraps at whatever column the sender's editor chose. Treating
   * those newlines as boundaries split sentences in half, and half a sentence
   * matches no rule — which is the shape "209 sentences, 1 signal" takes.
   */
  it('does not split an HTML sentence at the source line wrap', () => {
    const blocks = extractBlocks(
      '<li>Puka Nacua did not practice on Wednesday with a hamstring\ninjury.</li>',
      { isHtml: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Puka Nacua did not practice on Wednesday with a hamstring injury.');
  });

  it('rejoins a hard-wrapped plain-text paragraph', () => {
    const blocks = extractBlocks(
      'Puka Nacua did not practice on Wednesday with a\nhamstring injury.',
      { isHtml: false },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Puka Nacua did not practice on Wednesday with a hamstring injury.');
  });

  it('keeps bullets apart and strips the marker from the sentence', () => {
    const blocks = extractBlocks(
      '• Bijan Robinson was named the starter.\n• Puka Nacua did not practice.',
      { isHtml: false },
    );
    expect(blocks.map((b) => b.text)).toEqual([
      'Bijan Robinson was named the starter.',
      'Puka Nacua did not practice.',
    ]);
    expect(blocks[0]?.kind).toBe('list_item');
  });

  it('keeps a blank-line paragraph break as a boundary', () => {
    const blocks = extractBlocks('First paragraph here.\n\nSecond paragraph here.', { isHtml: false });
    expect(blocks).toHaveLength(2);
  });

  it('normalizes punctuation so the ASCII rule dictionary can match it', () => {
    expect(normalizePunctuation('“the engine”')).toBe('"the engine"');
    expect(normalizePunctuation('didn’t')).toBe("didn't");
    expect(normalizePunctuation('a – b — c')).toBe('a - b - c');
    expect(normalizePunctuation('• item')).toBe('- item');
    expect(normalizePunctuation('a b')).toBe('a b');
    expect(normalizePunctuation('Bijan​Robinson')).toBe('BijanRobinson');
  });

  it('still guards abbreviations when splitting sentences', () => {
    expect(splitSentences('He is the No. 1 back in camp.')).toHaveLength(1);
    expect(splitSentences('Amon-Ra St. Brown is healthy.')).toHaveLength(1);
  });
});

// -------------------------------------------------- name candidate hygiene --
describe('player-name candidates', () => {
  /**
   * "Names not in the player list" was offering the user `E2=80=9Cthe` and
   * `DeyJ1IjoiYWJ`. Neither is a name: the span was built from the first token's
   * start to the last token's end and swallowed the encoded bytes between them.
   */
  it('does not build a name out of an encoded or URL fragment', () => {
    for (const junk of [
      '=E2=80=9Cthe engine=E2=80=9D of this offense',
      'https://substack.com/redirect/9f2b1a3c?j=eyJ1IjoiYWJjIn0',
      'Content-Transfer-Encoding: quoted-printable',
    ]) {
      for (const name of collectUnresolvedNames(junk, TEST_INDEX)) {
        expect(name, `"${name}" from "${junk}"`).toMatch(/^[A-Za-z'’.\-]+(?: [A-Za-z'’.\-]+)*$/);
      }
    }
  });

  it('still finds a genuine unknown name', () => {
    expect(collectUnresolvedNames('Coach Dan Quinnley spoke on Wednesday.', TEST_INDEX).join(' '))
      .toContain('Quinnley');
  });

  it('still resolves a real player written normally', () => {
    const mentions = detectMentions('Bijan Robinson was named the starter.', TEST_INDEX, {});
    expect(mentions.map((m) => m.matchedText)).toContain('Bijan Robinson');
  });

  it('does not resolve a player across intervening junk', () => {
    const mentions = detectMentions('Bijan=80=9C Robinson', TEST_INDEX, {});
    expect(mentions.some((m) => m.matchedText === 'Bijan=80=9C Robinson')).toBe(false);
  });
});

// ------------------------------------------------------------- salvage ------
describe('recovering a body that was already stored badly', () => {
  it('recognises a stored raw MIME blob and re-reads it', () => {
    const stored = SUBSTACK_RAW_MIME.slice(SUBSTACK_RAW_MIME.indexOf('----==_mimepart_outer_68aa'));
    expect(looksLikeRawMime(stored)).toBe(true);
    const recovered = recoverBody({ html: null, text: stored });
    expect(recovered.repairs).toContain('text:mime_reparsed');
    expect(recovered.html).toContain('Bijan Robinson');
    expect(recovered.html).not.toContain('=E2=80');
  });

  it('decodes a stored body that is only undecoded quoted-printable', () => {
    const recovered = recoverBody({ html: null, text: 'Nacua didn=E2=80=99t practice=2E' });
    expect(recovered.repairs).toContain('text:quoted_printable_decoded');
    expect(recovered.text).toBe('Nacua didn’t practice.');
  });

  it('repairs UTF-8 that was decoded one byte at a time', () => {
    expect(repairMojibake('called him âthe engineâ')).toBe('called him “the engine”');
    const recovered = recoverBody({ html: null, text: 'Nacua didnât practice.' });
    expect(recovered.repairs).toContain('text:mojibake_repaired');
    expect(recovered.text).toBe('Nacua didn’t practice.');
  });

  it('leaves a healthy body completely alone', () => {
    const html = '<p>Bijan Robinson was named the starter — “the engine” of this offense.</p>';
    const recovered = recoverBody({ html, text: 'Bijan Robinson was named the starter.' });
    expect(recovered.repairs).toEqual([]);
    expect(recovered.html).toBe(html);
    expect(recovered.text).toBe('Bijan Robinson was named the starter.');
  });

  it('does not mistake ordinary prose for an encoded body', () => {
    expect(looksLikeRawMime('The team said Content-Type matters to nobody here.')).toBe(false);
    expect(looksLikeQuotedPrintable('He gained 20 yards and the score was 21=21 in jest.')).toBe(false);
    // An HTML body wrapped mid-attribute has soft-break-shaped line ends but no
    // hex escape, and re-decoding a body that was fine is the one real hazard.
    expect(looksLikeQuotedPrintable('<td align=\r\n"center">Bijan Robinson</td>')).toBe(false);
    expect(looksLikeQuotedPrintable('a =E2=80=9C b')).toBe(true);
  });

  it('is stable when run twice', () => {
    const once = recoverBody({ html: null, text: 'Nacua didn=E2=80=99t practice=2E' });
    const twice = recoverBody({ html: once.html, text: once.text });
    expect(twice.text).toBe(once.text);
    expect(twice.repairs).toEqual([]);
  });
});

// ------------------------------------------------ end to end over the fixture
describe('the repaired pipeline over the production newsletter', () => {
  const parsed = parseRawEmail(SUBSTACK_RAW_MIME);
  const result = processNewsletter(
    {
      messageId: 'issue-4f2a1c',
      from: 'ffweekly@substack.com',
      subject: parsed.subject ?? '',
      receivedAt: '2026-08-13T12:00:00.000Z',
      html: parsed.html,
      text: parsed.text,
    },
    TEST_INDEX,
  );

  it('reads the article as a handful of sentences, not a pile of fragments', () => {
    // The heading and four bullets. The action row and the footer are chrome,
    // not sentences — before the repair this same issue produced twenty.
    expect(result.coverage.sentences).toBe(5);
    expect(result.coverage.repairs).toEqual([]);
  });

  it('turns the genuine news into signals', () => {
    const byPlayer = new Map(result.evidence.map((e) => [e.playerName, e]));
    expect(byPlayer.get('Bijan Robinson')?.polarity).toBe('positive');
    expect(byPlayer.get('Bijan Robinson')?.ruleId).toContain('pos.named_starter');
    expect(byPlayer.get('Puka Nacua')?.polarity).toBe('negative');
    expect(byPlayer.get('Puka Nacua')?.ruleId).toContain('neg.did_not_practice');
  });

  /**
   * Only reachable because punctuation was normalized: the rule tests
   * `did ?n[o']?t practice`, and the newsletter shipped a typographic
   * apostrophe in `didn’t`.
   */
  it('matches a rule written in ASCII against typographic punctuation', () => {
    const nacua = result.evidence.find((e) => e.playerName === 'Puka Nacua');
    expect(nacua?.excerpt).toContain("didn't");
  });

  it('leaves an ordinary mention with no news in it as a no-match', () => {
    expect(result.evidence.some((e) => e.playerName === 'Jordan Love')).toBe(false);
    expect(result.coverage.samples.some((s) => s.excerpt.includes('Bakersfield'))).toBe(true);
  });

  it('keeps an ambiguous name unresolved rather than guessing', () => {
    // Two active players are called Chris Johnson.
    expect(result.evidence.some((e) => e.playerName.includes('Chris Johnson'))).toBe(false);
    const review = result.identityReview.find((r) => r.matchedText.includes('Johnson'));
    expect(review?.candidates.length).toBeGreaterThan(1);
    expect(review?.proposedPolarity).toBe('negative');
  });

  it('offers no MIME, URL or encoding fragment as a missing player name', () => {
    for (const name of result.coverage.unknownNames) {
      expect(name, name).toMatch(/^[A-Za-z'’.\-]+(?: [A-Za-z'’.\-]+)*$/);
    }
    expect(result.coverage.unknownNames.join(' ')).not.toMatch(/substack|http|E2=|Content-/i);
  });

  it('reads a text-only issue the same way', () => {
    const textOnly = parseRawEmail(SUBSTACK_RAW_MIME_TEXT_ONLY);
    expect(textOnly.html).toBeNull();
    const out = processNewsletter(
      {
        messageId: 'issue-textonly',
        from: 'ffweekly@substack.com',
        subject: 'Week 1 Camp Risers',
        receivedAt: '2026-08-13T12:00:00.000Z',
        html: null,
        text: textOnly.text,
      },
      TEST_INDEX,
    );
    const bijan = out.evidence.find((e) => e.playerName === 'Bijan Robinson');
    expect(bijan?.polarity).toBe('positive');
    // The Substack link target must not have survived into the stored excerpt.
    expect(bijan?.excerpt).not.toMatch(/substack|https?:/i);
    expect(bijan?.excerpt).toContain('was named the starter');
  });
});
