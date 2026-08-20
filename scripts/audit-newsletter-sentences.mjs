/**
 * Print every player-containing sentence in one stored newsletter, with the
 * outcome the current rules give it.
 *
 * Why this exists: `coverage.samples` is capped — it is a prompt for
 * rule-writing, not a ledger — so the diagnostics can say "118 sentences
 * matched no rule" and show eight of them. Eight is enough to notice a decoding
 * failure and nowhere near enough to claim the other 110 are correctly
 * non-actionable. This walks all of them, so every sentence ends in an explicit
 * bucket and there is no silent remainder.
 *
 * It reads. It writes nothing, and it never touches evidence: it re-runs the
 * same pure pipeline the app runs, over the same stored body, and prints what
 * it sees. Deliberately a script rather than an endpoint — auditing a whole
 * issue is something you do while writing rules, not something the app needs to
 * serve.
 *
 * Input is two files of `wrangler d1 execute --json` output, because that is a
 * read-only path to the real production rows that needs no new API surface:
 *   AUDIT_MESSAGE_JSON  the newsletter_messages row
 *   AUDIT_PLAYERS_JSON  the players rows
 *
 * Run it through the "Audit a newsletter" workflow rather than by hand.
 */

import { readFileSync } from 'node:fs';
import { PlayerIndex } from '../src/core/identity/index.ts';
import { classifySentence } from '../src/core/newsletter/classify.ts';
import { extractBlocks, splitSentences } from '../src/core/newsletter/html.ts';
import { collectUnresolvedNames, detectMentions } from '../src/core/newsletter/mentions.ts';
import { recoverBody } from '../src/core/newsletter/mime.ts';

/** `wrangler d1 execute --json` wraps results differently across versions. */
function rowsFrom(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? first?.result?.[0]?.results ?? [];
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Mirror of PlayerRepo's row -> CanonicalPlayer mapping, for the fields identity uses. */
function toPlayer(row) {
  return {
    id: row.id,
    sleeperPlayerId: row.sleeper_player_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    team: row.team ?? '',
    position: row.position ?? '',
    status: row.status ?? null,
    active: row.active === 1,
    normalizedName: row.normalized_name,
    aliases: parseJson(row.aliases_json, []),
    externalIds: parseJson(row.external_ids_json, {}),
    searchRank: row.draft_rank ?? null,
    jerseyNumber: null,
    heightInches: null,
    weightPounds: null,
    age: null,
    yearsExp: null,
  };
}

const message = rowsFrom(process.env.AUDIT_MESSAGE_JSON ?? '/tmp/message.json')[0];
if (!message) {
  console.error('::error::no such newsletter in the message log');
  process.exit(1);
}
const players = rowsFrom(process.env.AUDIT_PLAYERS_JSON ?? '/tmp/players.json').map(toPlayer);
if (players.length === 0) {
  console.error('::error::no players; the index would resolve nothing');
  process.exit(1);
}
const index = new PlayerIndex(players);

console.log(`subject : ${message.subject}`);
console.log(`id      : ${message.message_id}`);
console.log(`received: ${message.received_at}`);
console.log(`players : ${players.length} in the dictionary`);

// The same recovery the pipeline applies on the way in, so this audit reads
// exactly the text the rules read.
const recovered = recoverBody({ html: message.body_html, text: message.body_text });
console.log(`repairs : ${recovered.repairs.join(', ') || '(none)'}`);

const body = recovered.html ?? recovered.text ?? '';
const blocks = extractBlocks(body, { isHtml: recovered.html != null ? true : undefined });

const documentPlayerIds = new Set();
const rows = [];
let total = 0;
const unknownNames = new Set();

for (const block of blocks) {
  for (const sentence of splitSentences(block.text)) {
    total++;
    const mentions = detectMentions(sentence, index, { documentPlayerIds });
    for (const name of collectUnresolvedNames(sentence, index, mentions)) unknownNames.add(name);
    if (mentions.length === 0) continue;

    const resolved = mentions.filter((m) => m.playerId);
    for (const m of resolved) documentPlayerIds.add(m.playerId);
    const ambiguous = mentions.filter((m) => m.match.status === 'ambiguous');
    const distinct = new Set(resolved.map((m) => m.playerId)).size;

    const classification = classifySentence(sentence, {
      playersInSentence: Math.max(distinct, mentions.length),
      identityAmbiguous: ambiguous.length > 0,
    });

    // The pipeline's own buckets, in its own order of precedence.
    let outcome;
    if (classification.polarity === 'neutral') outcome = resolved.length > 0 ? 'no_rule' : 'no_rule_unresolved';
    else if (resolved.length > 0) outcome = `signal_${classification.polarity}`;
    else outcome = 'signal_but_unresolved';

    rows.push({
      n: rows.length + 1,
      block: block.index,
      kind: block.kind,
      sentence,
      players: resolved.map((m) => index.get(m.playerId)?.fullName ?? m.matchedText),
      ambiguous: ambiguous.map((m) => m.matchedText),
      outcome,
      polarity: classification.polarity,
      ruleId: classification.ruleId,
      severity: classification.severity,
      confidence: classification.confidence,
    });
  }
}

const withResolved = rows.filter((r) => r.players.length > 0);
const withAmbiguous = rows.filter((r) => r.ambiguous.length > 0);
const signals = rows.filter((r) => r.outcome.startsWith('signal_') && r.players.length > 0);

console.log('');
console.log('=== COUNTS ===============================================');
console.log(`sentences total            : ${total}`);
console.log(`sentences naming a player  : ${withResolved.length}`);
console.log(`  ...that became a signal  : ${signals.length}`);
console.log(`  ...that matched no rule  : ${withResolved.length - signals.length}`);
console.log(`sentences with an ambiguous name: ${withAmbiguous.length}`);
console.log(`name-like spans not in the dictionary: ${unknownNames.size}`);

console.log('');
console.log('=== EVERY SENTENCE THAT NAMES A PLAYER ===================');
for (const r of rows) {
  if (r.players.length === 0 && r.ambiguous.length === 0) continue;
  const who = r.players.join(', ') || `(unresolved: ${r.ambiguous.join(', ')})`;
  const verdict = r.ruleId ? `${r.polarity}/${r.severity} ${r.ruleId} [${r.confidence}]` : 'no rule';
  console.log(`${String(r.n).padStart(3)} | ${r.outcome.padEnd(22)} | ${verdict}`);
  console.log(`    who : ${who}`);
  console.log(`    text: ${r.sentence.replace(/\s+/g, ' ').slice(0, 300)}`);
}

console.log('');
console.log('=== NAME-LIKE SPANS NOT IN THE DICTIONARY ================');
for (const name of [...unknownNames].sort()) console.log(`  ${name}`);

/*
 * The whole issue in document order, on request.
 *
 * A sentence-by-sentence audit answers "what did the classifier make of this
 * line", which is the right question for rule coverage and the wrong one for
 * deciding whether a line is news at all. A leaderboard row reads `Romeo Doubs
 * - 0.216`, and whether that number is good or bad lives in a heading two
 * blocks above it that names no player and therefore never appears in the
 * audit. The same gap hides whether a projection sits under a real transaction
 * or under a hypothetical.
 *
 * So this prints every block and every sentence with its index, including the
 * ones naming nobody, so the structure the reader sees can be read here too.
 */
if (process.env.FULL_TEXT === '1') {
  console.log('');
  console.log('=== THE WHOLE ISSUE, IN ORDER ============================');
  let n = 0;
  for (const block of blocks) {
    console.log(`[block ${String(block.index).padStart(3)} ${block.kind}]`);
    for (const sentence of splitSentences(block.text)) {
      n++;
      console.log(`  ${String(n).padStart(3)}| ${sentence.replace(/\s+/g, ' ')}`);
    }
  }
}
