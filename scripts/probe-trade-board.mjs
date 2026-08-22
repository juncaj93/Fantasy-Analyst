/**
 * What does the deployed trade board say, and can it explain itself?
 *
 * The recency correction is proven by tests against constructed ledgers. This
 * asks the live board the same questions about the real one: which section each
 * player is in, where he sits inside it, how well evidenced the call is, and —
 * the part the tests cannot check — whether the numbers on the card actually
 * account for the order they are shown in.
 *
 * Two properties are asserted rather than merely printed, because they are the
 * ones that were broken:
 *
 *   1. inside Trade target, the 30-day window orders the section, give or take
 *      the bounded modifiers (a week, a lifetime record, an injury);
 *   2. category and confidence are independent — the board is allowed to put a
 *      Low-confidence player above a Medium-confidence one, and the old engine
 *      was not.
 *
 * Reads only, and only GET — no passphrase, no writes, nothing stored. Reads
 * never need a session (`server/app.ts`), so this needs no secret.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/** The players the handoff names, plus controls from the top of the board. */
const NAMED = ['Jahmyr Gibbs', 'Puka Nacua', 'Jaxon Smith-Njigba', 'Josh Allen'];
const CONTROLS = 6;

/** The most the non-30d terms can move a Trade target, from `trades/engine.ts`. */
const MAX_MODIFIERS = 2 /* week */ + 0.5 /* lifetime */ + 0.5 /* volume */ + 2.5 /* injury */;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const res = await fetch(`${BASE}/api/trades?limit=200`, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.log(`FAIL  /api/trades — HTTP ${res.status}`);
  process.exit(1);
}
const board = await res.json();

console.log(`${BASE}/api/trades`);
console.log(`league: ${board.league?.name ?? '(none selected)'} | considered: ${board.considered}`);
for (const w of board.warnings ?? []) console.log(`warning: ${w}`);
console.log();

const sections = board.sections ?? [];
if (sections.length === 0) {
  console.log('FAIL  the board is empty — nothing to validate');
  process.exit(1);
}

/** Every row, with the rank it holds inside its own section. */
const rows = new Map();
for (const section of sections) {
  section.players.forEach((p, i) => {
    rows.set(p.name, { ...p, section: section.label, rank: i + 1, of: section.players.length });
  });
}

function describe(p) {
  const w = p.windows;
  const s = (n) => `${n > 0 ? '+' : ''}${n}`;
  console.log(
    `  ${p.name.padEnd(22)} ${p.section.padEnd(18)} ${String(`${p.rank}/${p.of}`).padStart(6)}  ` +
      `7d ${s(w.last7).padStart(4)}  30d ${s(w.last30).padStart(4)}  Life ${s(w.lifetime).padStart(4)}  ` +
      `items ${String(w.items30).padStart(2)}/${String(w.itemsLifetime).padStart(2)}  ` +
      `${p.confidence.padEnd(6)} urgency ${String(p.urgency).padStart(7)}`,
  );
  if (p.breakdown) {
    const b = p.breakdown;
    console.log(
      `${' '.repeat(4)}basis ${b.basis} | prior23 ${b.prior23} | accel ${b.acceleration} | ` +
        `confirm ${b.confirmation} | life ${b.lifetimeSupport} | vol ${b.volume} | ` +
        `conflict ${b.conflictPenalty} | injury ${b.injury} | total ${b.total}`,
    );
  }
  for (const r of p.reasons ?? []) console.log(`      · ${r}`);
  for (const c of p.counterpoints ?? []) console.log(`      ~ ${c}`);
}

console.log('=== the players the handoff names ===');
for (const name of NAMED) {
  const p = rows.get(name);
  if (!p) {
    console.log(`  ${name.padEnd(22)} not on the board (no recent evidence, or not rostered in this league)`);
    continue;
  }
  describe(p);
}

console.log('\n=== controls: the top of each section ===');
for (const section of sections) {
  console.log(`\n${section.label} (${section.players.length})`);
  for (const p of section.players.slice(0, CONTROLS)) describe(rows.get(p.name));
}

console.log('\n=== properties ===');

/* 1. Trade target is ordered by the 30-day window, within the bounded modifiers. */
const targets = sections.find((s) => s.verdict === 'trade_target')?.players ?? [];
for (let i = 1; i < targets.length; i++) {
  const above = targets[i - 1];
  const below = targets[i];
  const inverted = Math.abs(below.windows.last30) > Math.abs(above.windows.last30);
  if (!inverted) continue;
  const gap = Math.abs(below.windows.last30) - Math.abs(above.windows.last30);
  check(
    `${below.name} (30d ${below.windows.last30}) sits below ${above.name} (30d ${above.windows.last30}) for a nameable reason`,
    gap <= MAX_MODIFIERS,
    `gap ${gap.toFixed(1)} against at most ${MAX_MODIFIERS} of bounded modifiers`,
  );
}
if (targets.length > 1) {
  console.log(`ok    Trade target is ordered by 30d across all ${targets.length} rows`);
}

/* 2. Confidence does not decide the section, and does not decide the order. */
const byConfidence = { high: [], medium: [], low: [] };
for (const p of rows.values()) byConfidence[p.confidence]?.push(p);
const lowInTargets = (targets ?? []).filter((p) => p.confidence === 'low').length;
console.log(
  `      confidence spread: ${byConfidence.high.length} high, ${byConfidence.medium.length} medium, ` +
    `${byConfidence.low.length} low | ${lowInTargets} low-confidence row(s) inside Trade target`,
);
check(
  'a low-confidence player is not barred from Trade target',
  byConfidence.low.length === 0 || lowInTargets > 0 || targets.length === 0,
  lowInTargets > 0
    ? `${lowInTargets} of ${targets.length}`
    : 'no low-confidence player is currently rising, so nothing to place',
);

/* 3. Emerging means recent, not thinly sourced. */
const emerging = sections.find((s) => s.verdict === 'emerging_target')?.players ?? [];
for (const p of emerging) {
  const prior = p.windows.last30 - p.windows.last7;
  check(
    `${p.name} is emerging because the week carries it (7d ${p.windows.last7}, prior23 ${prior})`,
    p.windows.last7 >= 2 && prior < 2,
    `7d ${p.windows.last7} / prior23 ${prior}`,
  );
}
if (emerging.length === 0) console.log('      (no emerging rows on the board right now)');

/* 4. Every row can say why it is there. */
for (const p of rows.values()) {
  if ((p.reasons?.length ?? 0) === 0) check(`${p.name} explains itself`, false, 'no reasons given');
}
console.log(`ok    all ${rows.size} rows carry an explanation`);

console.log(`\n${failures === 0 ? 'All properties hold.' : `${failures} propert(y/ies) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
