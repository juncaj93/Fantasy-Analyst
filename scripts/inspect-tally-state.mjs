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
    const total = s
      ? `net ${show(Number(s.raw_net))} lifetime, ${show(Number(s.recent21_net))} in the last 30 days`
      : 'no cached signal';
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

// ------------------------------------------------------------- projection ---

/*
 * What the ledger would look like afterwards, worked out from the ledger rows
 * and the preview's own description of what it would do.
 *
 * Deliberately independent of the app's arithmetic. The preview states a net
 * move per player; this reconstructs the after-state row by row and derives the
 * same number a second way. Two derivations that agree is evidence; the app
 * agreeing with itself is not. The one question worth asking of a replacement —
 * "does anything end up counted twice?" — is then answered by looking at the
 * projected rows rather than by trusting the summary.
 */
const previewPath = process.env.PREVIEW_JSON;
if (previewPath) {
  const preview = JSON.parse(readFileSync(previewPath, 'utf8'));

  console.log('# Dry run — nothing was written');
  console.log('');
  console.log(preview.detail);
  console.log('');
  console.log(`${preview.rowsParsed} row(s) read from the pasted block.`);
  console.log('');

  const section = (title, list, render) => {
    console.log(`## ${title} — ${list.length}`);
    console.log('');
    if (!list.length) {
      console.log('(none)');
      console.log('');
      return;
    }
    for (const r of list) console.log(`- ${render(r)}`);
    console.log('');
  };
  const scored = (r) => `${r.playerName ?? r.name} ${show(r.score)}`;
  section('Newly added', preview.ready ?? [], (r) => `${scored(r)} — ${r.reason}`);
  section('Unchanged, already counting', preview.duplicates ?? [], scored);
  section('Previously retired, brought back', preview.reinstated ?? [], (r) => `${scored(r)} — ${r.reason}`);
  section('Earlier imported rows retired', preview.wouldRetire ?? [],
    (r) => `${named(r.playerId)} was ${r.polarity} ${r.magnitude} — "${r.excerpt}"`);
  section("Parser rows displaced (stop counting)", preview.parserSuperseded ?? [],
    (r) => `${r.ruleId} ${r.polarity} ${r.magnitude} — "${r.excerpt}"`);
  section('Opposite-direction rows moved to review', preview.parserNeedsReview ?? [],
    (r) => `${r.ruleId} ${r.polarity} ${r.magnitude} — "${r.excerpt}"`);
  section('Left exactly as you ruled them', preview.protectedByUser ?? [],
    (r) => `${named(r.playerId)} — "${r.excerpt}"`);
  section('Held back, waiting for a person', [
    ...(preview.pending ?? []).map((r) => `${scored(r)} — scored twice in one block`),
    ...(preview.ambiguous ?? []).map((r) => `${r.name} ${show(r.score)} — more than one player has this name`),
    ...(preview.unmatched ?? []).map((r) => `${r.name} ${show(r.score)} — not in the player list`),
  ], (r) => r);
  section('Lines that could not be read', preview.rejected ?? [],
    (r) => `line ${r.lineNumber}: ${r.why} — "${r.line}"`);

  console.log('## If this tally were applied');
  console.log('');

  // Start from what is counting now, then move each row the preview names.
  const after = evidence.map((r) => ({
    id: String(r.id),
    playerId: String(r.player_id),
    origin: r.rule_id === AI_TALLY_RULE_ID ? 'import' : 'parser',
    delta: COUNTED.has(r.review_status) ? signed(r) : 0,
    counted: COUNTED.has(r.review_status),
    why: 'unchanged',
  }));
  const byId = new Map(after.map((r) => [r.id, r]));
  const stop = (id, why) => {
    const row = byId.get(String(id));
    if (row) Object.assign(row, { delta: 0, counted: false, why });
  };

  for (const r of preview.wouldRetire ?? []) stop(r.id, 'replaced by this tally');
  for (const r of preview.parserSuperseded ?? []) stop(r.id, 'superseded by this tally');
  for (const r of preview.parserNeedsReview ?? []) stop(r.id, 'parked for review');
  for (const r of preview.reinstated ?? []) {
    // Reinstated rows are already in the ledger; find them by their key.
    const row = after.find((a) => byId.get(a.id) && a.playerId === String(r.playerId) && !a.counted);
    if (row) Object.assign(row, { delta: r.score, counted: true, why: 'counts again' });
  }
  for (const r of preview.ready ?? []) {
    after.push({
      id: `new:${r.dedupeKey}`,
      playerId: String(r.playerId),
      origin: 'import',
      delta: r.score,
      counted: true,
      why: 'added by this tally',
    });
  }

  // The same net move, derived from the projected rows rather than announced.
  const before = new Map();
  for (const r of evidence) {
    if (!COUNTED.has(r.review_status)) continue;
    before.set(String(r.player_id), (before.get(String(r.player_id)) ?? 0) + signed(r));
  }
  const projected = new Map();
  for (const r of after) {
    if (!r.counted) continue;
    projected.set(r.playerId, (projected.get(r.playerId) ?? 0) + r.delta);
  }

  const promised = new Map((preview.tallyDelta ?? []).map((d) => [String(d.playerId), d.net]));
  const ids = new Set([...before.keys(), ...projected.keys(), ...promised.keys()]);
  const disagreements = [];
  let total = 0;
  console.log('| player | now | after | move | preview promised |');
  console.log('|---|---|---|---|---|');
  for (const id of [...ids].sort()) {
    const now = before.get(id) ?? 0;
    const then = projected.get(id) ?? 0;
    const move = then - now;
    const said = promised.get(id) ?? 0;
    total += move;
    if (move !== 0 || said !== 0) {
      console.log(`| ${named(id)} | ${show(now)} | ${show(then)} | ${show(move)} | ${show(said)} |`);
    }
    if (move !== said) disagreements.push(`${named(id)}: ledger moves ${show(move)}, preview said ${show(said)}`);
  }
  console.log('');
  console.log(`Total change across this newsletter: ${show(total)}`);
  console.log('');

  if (disagreements.length) {
    console.log('### The preview does not match the ledger');
    console.log('');
    for (const d of disagreements) console.log(`- ${d}`);
    console.log('');
    process.exitCode = 1;
  } else {
    console.log('Every number the preview promises is the number the ledger would move by.');
    console.log('');
  }

  console.log('### Would anything be counted twice?');
  console.log('');
  const twice = [];
  for (const id of new Set(after.filter((r) => r.counted).map((r) => r.playerId))) {
    const rows = after.filter((r) => r.counted && r.playerId === id);
    const imports = rows.filter((r) => r.origin === 'import').length;
    const parsed = rows.filter((r) => r.origin === 'parser').length;
    if (rows.length > 1) {
      twice.push(`${named(id)}: ${rows.length} counted row(s) — ${imports} imported, ${parsed} from the app's own reading`);
    }
  }
  if (twice.length === 0) {
    console.log('No. Every player this newsletter scores would end with exactly one counted row.');
  } else {
    for (const t of twice) console.log(`- ${t}`);
    console.log('');
    console.log('Each of these needs a reason, or it is a double count.');
    process.exitCode = 1;
  }
  console.log('');
}
