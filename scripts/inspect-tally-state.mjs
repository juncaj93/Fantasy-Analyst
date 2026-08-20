/**
 * Print what a newsletter currently contributes to the ledger.
 *
 * Before a revised tally is pasted over an earlier one, the question that
 * matters is not "what does the new block say" but "what is already on the
 * record for this issue, and which of it is counting". The coverage report in
 * Settings answers neither: it describes the parse, not the ledger.
 *
 * So this prints every row filed under one message id — every status, not just
 * the live ones — split by where it came from, because that is the split the
 * import acts on. An imported row is the tally's own and a re-import replaces
 * it; a parsed row belongs to the app's reading of the same issue and the
 * import may only displace it.
 *
 * Read-only. It is handed the results of SELECTs and writes nothing back.
 */

import { readFileSync } from 'node:fs';

const AI_TALLY_RULE_ID = 'ai-tally-import';
const COUNTED = new Set(['auto_applied', 'accepted', 'corrected']);

function rows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first?.results ?? [];
}

const evidence = rows(process.env.EVIDENCE_JSON);
const players = new Map(rows(process.env.PLAYERS_JSON).map((p) => [String(p.id), p.full_name]));
const signals = new Map(rows(process.env.SIGNALS_JSON).map((s) => [String(s.player_id), s]));

const named = (id) => `${players.get(String(id)) ?? '(unknown)'} [${id}]`;
const signed = (r) => (r.polarity === 'positive' ? r.magnitude : r.polarity === 'negative' ? -r.magnitude : 0);
const show = (n) => (n > 0 ? `+${n}` : String(n));

console.log(`# Ledger for ${process.env.MESSAGE_ID}`);
console.log('');
console.log(`${evidence.length} row(s) carry this message id, in every status.`);
console.log('');

const imported = evidence.filter((r) => r.rule_id === AI_TALLY_RULE_ID);
const parsed = evidence.filter((r) => r.rule_id !== AI_TALLY_RULE_ID);

function table(title, list) {
  console.log(`## ${title} — ${list.length} row(s)`);
  console.log('');
  if (list.length === 0) {
    console.log('(none)');
    console.log('');
    return;
  }
  for (const r of list) {
    const counts = COUNTED.has(r.review_status);
    const override = r.user_override_json && r.user_override_json !== 'null' ? ' USER-RULED' : '';
    console.log(
      `- ${named(r.player_id)} ${show(signed(r))} ` +
        `status=${r.review_status}${counts ? ' (counting)' : ' (not counted)'}` +
        `${override} rule=${r.rule_id ?? '-'} key=${r.dedupe_key}`,
    );
    console.log(`    "${String(r.excerpt ?? '').slice(0, 160)}"`);
    const notes = (() => {
      try {
        return JSON.parse(r.notes_json ?? '[]');
      } catch {
        return [];
      }
    })();
    if (notes.length) console.log(`    notes: ${notes.join('; ')}`);
  }
  console.log('');
}

table('Imported by a tally paste', imported);
table('Found by the app itself', parsed);

// What this newsletter is actually worth right now, per player.
console.log('## What this issue currently contributes');
console.log('');
const perPlayer = new Map();
for (const r of evidence) {
  if (!COUNTED.has(r.review_status)) continue;
  perPlayer.set(String(r.player_id), (perPlayer.get(String(r.player_id)) ?? 0) + signed(r));
}
if (perPlayer.size === 0) {
  console.log('Nothing from this issue is counting.');
} else {
  for (const [playerId, net] of [...perPlayer].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    const s = signals.get(playerId);
    const total = s ? `${s.recent_score ?? '?'} recent / ${s.lifetime_score ?? '?'} lifetime` : 'no signal row';
    console.log(`- ${named(playerId)}: ${show(net)} from this issue — player total ${total}`);
  }
}
console.log('');

// Two rows counting for the same player from the same issue is the failure the
// replacement rules exist to prevent, so say so plainly either way.
console.log('## Double-count check');
console.log('');
const doubles = [];
for (const [playerId] of perPlayer) {
  const live = evidence.filter((r) => String(r.player_id) === playerId && COUNTED.has(r.review_status));
  const fromImport = live.filter((r) => r.rule_id === AI_TALLY_RULE_ID).length;
  const fromParser = live.length - fromImport;
  if (fromImport > 0 && fromParser > 0) {
    doubles.push(`${named(playerId)}: ${fromImport} imported + ${fromParser} parsed, both counting`);
  }
}
if (doubles.length === 0) {
  console.log('No player is counted by both an import and the app\'s own reading of this issue.');
} else {
  for (const d of doubles) console.log(`- ${d}`);
  process.exitCode = 1;
}
