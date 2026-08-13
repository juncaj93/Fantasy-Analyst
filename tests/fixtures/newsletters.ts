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
