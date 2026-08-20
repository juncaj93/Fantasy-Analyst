/**
 * Newsletter fixtures.
 *
 * Player names here match tests/helpers/players.ts. The HTML deliberately
 * includes real-world newsletter chrome: tracking pixels, MSO comments,
 * unclosed tags, boilerplate footers and a duplicated title line.
 */

export const CLEAN_NEWSLETTER = `<!DOCTYPE html>
<html><head><style>.x{color:red}</style><title>FF Newsletter</title></head>
<body>
<div class="preheader">View this email in your browser</div>
<h1>Training Camp Notes</h1>
<p>Training Camp Notes</p>
<p>Bijan Robinson was named the starter and is taking first-team reps.</p>
<p>Puka Nacua did not practice on Wednesday with a hamstring injury.</p>
<p>Jordan Love is not expected to miss time; the team is not concerned.</p>
<p>Tyler Boyd returned to practice but is expected to split work in a committee.</p>
<p>&nbsp;</p>
<img src="https://track.example/pixel.gif" width="1" height="1" />
<div class="footer">
  <a href="https://example.com/u">Unsubscribe</a> | <a href="https://example.com/p">Privacy Policy</a>
  <p>&copy; 2026 FF Newsletter, All rights reserved</p>
  <p>123 Main Street, Suite 400, Springfield, IL 62704</p>
</div>
</body></html>`;

export const MALFORMED_NEWSLETTER = `<html><body><div><p>Bijan Robinson is expected to lead the backfield.
<p>Puka Nacua was limited in practice.<div>
<span style="color:#fff" >José Ramírez signed a contract extension.
<script>var tracking = "<p>not real content</p>";</script>
<div class=unclosed`;

export const TWO_PLAYERS_ONE_SENTENCE = `<html><body>
<p>Bijan Robinson and Puka Nacua both returned to practice on Wednesday.</p>
</body></html>`;

export const SURNAME_COLLISION = `<html><body>
<p>Chris Johnson was named the starter in Kansas City.</p>
<p>Johnson is taking first-team reps.</p>
</body></html>`;

export const SURNAME_ANAPHORA = `<html><body>
<p>Puka Nacua has been a standout camp performer this August.</p>
<p>Nacua is also getting goal-line work near the end zone.</p>
</body></html>`;

export const REPEATED_MENTION = `<html><body>
<p>Bijan Robinson was named the starter. Bijan Robinson was named the starter.</p>
</body></html>`;

export const NO_PLAYERS = `<html><body>
<p>The league announced a new kickoff rule for the upcoming season.</p>
<p>Unsubscribe</p>
</body></html>`;

export const PLAIN_TEXT_NEWSLETTER = `Training Camp Notes

Bijan Robinson was named the starter.

Puka Nacua was limited in practice.

Unsubscribe from this newsletter`;

/**
 * A Substack issue in the exact shape that broke production.
 *
 * Every property here was observed in the failing newsletter, and each one is
 * load-bearing for a different layer of the parser:
 *
 *  - the `Content-Type` header is FOLDED before its `boundary=` parameter, which
 *    is what made the whole raw body look like plain text;
 *  - the multipart is NESTED (`mixed` wrapping `alternative`);
 *  - both parts are quoted-printable UTF-8, so punctuation arrives as
 *    `=E2=80=9C` / `=E2=80=A2` / `=E2=80=93` and lines end in soft breaks;
 *  - the plain-text part spells links the Substack way, `Anchor [ url ]`;
 *  - the HTML part hard-wraps mid-sentence and puts tracking redirects in href;
 *  - the subject is an RFC 2047 encoded word;
 *  - Substack's own chrome surrounds the article.
 *
 * The prose is written against tests/helpers/players.ts and deliberately mixes
 * real news, ordinary mentions with no news in them, and one ambiguous name.
 */
export const SUBSTACK_RAW_MIME = [
  'Received: from mail-d0.substack.com (mail-d0.substack.com [104.18.0.1])',
  '\tby mx.example.net with ESMTPS id 4f2a1c; Wed, 13 Aug 2026 12:00:02 +0000',
  'From: Fantasy Football Weekly <ffweekly@substack.com>',
  'Subject: =?UTF-8?Q?Week_1_Camp_Risers_=E2=80=94_Who=E2=80=99s_Up?=',
  'Message-ID: <issue.4f2a1c@mg-d0.substack.com>',
  'Date: Wed, 13 Aug 2026 12:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed;',
  ' boundary="--==_mimepart_outer_68aa"',
  '',
  '----==_mimepart_outer_68aa',
  'Content-Type: multipart/alternative;',
  ' boundary="--==_mimepart_inner_68aa"',
  '',
  '----==_mimepart_inner_68aa',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Week 1 Camp Risers',
  '',
  '=E2=80=A2 Bijan Robinson [ https://substack.com/redirect/9f2b1a3c?j=3DeyJ1I=',
  'joiYWJjIn0 ] was named the starter, and the coach called him =E2=80=9Cthe en=',
  'gine=E2=80=9D of this offense=2E',
  '',
  '=E2=80=A2 Puka Nacua didn=E2=80=99t practice on Wednesday =E2=80=93 a hamstr=',
  'ing issue the staff is watching=2E',
  '',
  '=E2=80=A2 Jordan Love grew up in Bakersfield and still golfs there every Jun=',
  'e=2E',
  '',
  '=E2=80=A2 Chris Johnson was ruled out for Sunday=2E',
  '',
  'Unsubscribe [ https://substack.com/redirect/unsub?token=3Dabc ]',
  '',
  '----==_mimepart_inner_68aa',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><h2>Week 1 Camp Risers</h2>',
  '<ul>',
  '<li><a href=3D"https://substack.com/redirect/9f2b1a3c?j=3DeyJ1IjoiYWJjIn0">B=',
  'ijan Robinson</a> was named the starter, and the coach called him =E2=80=9Ct=',
  'he engine=E2=80=9D of this offense.</li>',
  '<li>Puka Nacua didn=E2=80=99t practice on Wednesday =E2=80=93 a hamstring is=',
  'sue the staff is',
  'watching.</li>',
  '<li>Jordan Love grew up in Bakersfield and still golfs there every',
  'June.</li>',
  '<li>Chris Johnson was ruled out for Sunday.</li>',
  '</ul>',
  '<p>Like &middot; Comment &middot; Restack</p>',
  '<p><a href=3D"https://substack.com/redirect/unsub?token=3Dabc">Unsubscribe</=',
  'a></p>',
  '</body></html>',
  '',
  '----==_mimepart_inner_68aa--',
  '',
  '----==_mimepart_outer_68aa--',
  '',
].join('\r\n');

/**
 * The same issue delivered without an HTML part.
 *
 * Exercises the plain-text path on its own: Substack link syntax, hard wrapping
 * inside a paragraph, and bullets as paragraph boundaries.
 */
export const SUBSTACK_RAW_MIME_TEXT_ONLY = [
  'From: Fantasy Football Weekly <ffweekly@substack.com>',
  'Subject: Week 1 Camp Risers',
  'Message-ID: <issue.textonly@mg-d0.substack.com>',
  'Date: Wed, 13 Aug 2026 12:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/plain;',
  ' charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=E2=80=A2 Bijan Robinson [ https://substack.com/redirect/9f2b1a3c ] was name=',
  'd the starter, and the coach called him =E2=80=9Cthe engine=E2=80=9D of this',
  'offense=2E',
  '',
  '=E2=80=A2 Tyler Boyd returned to practice but is expected to split work in a',
  'committee=2E',
  '',
].join('\r\n');

/**
 * The stored body of the real production issue, in shape.
 *
 * The live message log holds
 * `<20260820114548.3.2eac9edb56b4cb63@mg2.substack.com>` with a `body_text`
 * that is everything from the first boundary delimiter onwards — the top-level
 * `Content-Type` that declared the multipart was left behind in the header
 * block, which is exactly what made the boundary invisible in the first place.
 *
 * So this fixture starts AT a delimiter, with `text/plain` as the first part.
 * Read naively that first part's headers pass for the message's own and the
 * HTML alternative is swallowed into its body — which is why `leadingBoundary`
 * exists. The prose reproduces the artefacts the production diagnostics listed
 * verbatim: `Name [ redirect-url ]` cut by a soft line break, an undecoded
 * bullet, an undecoded en dash, and an emoji whose UTF-8 lead bytes were being
 * read as the name `F0=9F`.
 */
export const STORED_CORRUPT_BODY = [
  '--_----1755690348-abcdef',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=F0=9F=8F=88 Week 1 Notes',
  '',
  'Keenan Allen [ https://substack.com/redirect/5169cc6b-e24f-470d-b520-d5d5f1=',
  '2eac9e?j=3DeyJ1IjoiOHd3MndjIn0 ] was named the starter in three-receiver se=',
  'ts=2E',
  '',
  '=E2=80=A2 Puka Nacua didn=E2=80=99t practice on Wednesday=2E',
  '',
  'Zay Flowers =E2=80=93 0=2E152',
  '',
  '--_----1755690348-abcdef',
  'Content-Type: text/html; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><p><a href=3D"https://substack.com/redirect/5169cc6b">Keenan All=',
  'en</a> was named the starter in three-receiver sets.</p>',
  '<p>Puka Nacua didn=E2=80=99t practice on Wednesday.</p>',
  '<p>Zay Flowers =E2=80=93 0.152</p>',
  '</body></html>',
  '',
  '--_----1755690348-abcdef--',
  '',
].join('\r\n');
