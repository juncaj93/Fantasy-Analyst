/**
 * What is `Next` actually saying about the live board, and why?
 *
 * A unit test can prove the simulator is self-consistent. It cannot prove that
 * the number on a real card is sensible, because a real card has a real draft
 * behind it — a real room, real rosters, a real ADP snapshot with real gaps.
 * This asks the deployed app for its own board and prints, per player, every
 * input the model used to reach the percentage, so "why is he 18%" can be
 * answered by reading rather than by guessing.
 *
 * It also runs the checks that would catch the failures this feature is most
 * likely to regress into: measuring against the pick on the clock, a board that
 * reads 100% everywhere, a number that jitters between two identical requests.
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 *
 *   node scripts/probe-next-pick-survival.mjs
 *   APP_URL=http://localhost:8787 node scripts/probe-next-pick-survival.mjs
 *   DRAFT_ID=1234 TOP=15 node scripts/probe-next-pick-survival.mjs
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const TOP = Number(process.env.TOP ?? 12);

let failures = 0;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const pct = (v) => (v == null ? '  —' : `${String(Math.round(v * 100)).padStart(3)}%`);

console.log(`Checking ${BASE}\n`);

const status = await get('/api/setup/status');
const draftId = process.env.DRAFT_ID || status.json?.league?.draftId || '';
check('a league with a draft is configured', !!draftId, draftId || 'none');
if (!draftId) process.exit(1);

const board = await get(`/api/drafts/${draftId}/board?limit=60`);
check('the board answers', board.status === 200, `HTTP ${board.status}`);
if (board.status !== 200) process.exit(1);

const state = board.json ?? {};
const model = state.nextPickModel ?? {};
const recs = state.recommendations ?? [];

// ------------------------------------------------------------- the situation

console.log('');
console.log('Draft state');
console.log(`  pick on the clock        ${state.currentPick}  (round ${state.round} of ${state.rounds})`);
console.log(`  your slot                ${state.mySlot ?? '—'}`);
console.log(`  your turn                ${state.myNextPick ?? '—'}${state.onTheClock ? '  (on the clock)' : ''}`);
console.log(`  Next is measured to      ${model.targetPick ?? '—'}`);
console.log(`  opposing picks simulated ${model.picksSimulated ?? 0}`);
console.log(`  managers ahead of you    ${(model.slotsAhead ?? []).join(', ') || '—'}`);
console.log(`  simulations              ${model.simulations ?? 0}${model.cached ? ' (cached)' : ''}`);
console.log(`  computed in              ${model.elapsedMs ?? '—'}ms`);
if (model.marketOnly) {
  console.log('  !! the board was too thin to simulate — these are ADP estimates, not simulated');
}

console.log('');
console.log('Starting-slot gaps among the teams picking before you');
const needAhead = model.needAhead ?? {};
if (Object.keys(needAhead).length === 0) console.log('  (none measured)');
for (const [position, needing] of Object.entries(needAhead)) {
  console.log(`  ${position.padEnd(4)} ${needing} of ${(model.slotsAhead ?? []).length} still short`);
}

console.log('');
console.log('What this room has been doing');
console.log(`  picks read               ${model.roomSample ?? 0}`);
console.log(
  `  market adherence         ${model.dispersion ?? 1}` +
    (model.dispersion == null || model.dispersion === 1
      ? '  (no adjustment)'
      : model.dispersion < 1
        ? '  (tighter than the market — the board is more predictable)'
        : '  (looser than the market — the board is less predictable)'),
);
for (const [position, multiplier] of Object.entries(model.positionRuns ?? {})) {
  if (Math.abs(multiplier - 1) < 0.02) continue;
  console.log(`  run: ${position.padEnd(4)}           x${multiplier}`);
}
for (const [position, multiplier] of Object.entries(model.positionBias ?? {})) {
  if (Math.abs(multiplier - 1) < 0.02) continue;
  console.log(`  bias: ${position.padEnd(4)}          x${multiplier}`);
}
for (const note of model.roomNotes ?? []) console.log(`  · ${note}`);
for (const reason of model.degraded ?? []) console.log(`  ! ${reason}`);

// ------------------------------------------------------------- the players

console.log('');
console.log(`Top ${TOP} candidates`);
console.log('  player                     pos   ADP   Val   Next  market  conf');
for (const rec of recs.slice(0, TOP)) {
  const next = rec.nextPick ?? {};
  console.log(
    `  ${String(rec.name).padEnd(26).slice(0, 26)} ${String(rec.position).padEnd(4)} ` +
      `${String(rec.adp ?? '—').padStart(5)} ${String(rec.adpValue ?? '—').padStart(5)} ` +
      `${pct(rec.survivalProbability)}   ${pct(next.marketBaseline)}  ${(next.confidence ?? '—').padEnd(6)}`,
  );
  for (const driver of next.drivers ?? []) console.log(`      · ${driver}`);
  for (const reason of next.degraded ?? []) console.log(`      ! ${reason}`);
}

// ------------------------------------------------------- contrasting players
//
// The four cases the brief asks to see side by side. Picked from the live board
// rather than named, because which player is which changes every draft.

console.log('');
console.log('Contrasting cases');
const priced = recs.filter((r) => r.survivalProbability != null && r.adp != null);
const cases = [
  ['scarcest TE', priced.filter((r) => r.position === 'TE').sort((a, b) => a.survivalProbability - b.survivalProbability)[0]],
  ['safest QB', priced.filter((r) => r.position === 'QB').sort((a, b) => b.survivalProbability - a.survivalProbability)[0]],
  ['deepest WR', priced.filter((r) => r.position === 'WR').sort((a, b) => b.survivalProbability - a.survivalProbability)[0]],
  ['biggest faller', [...priced].sort((a, b) => (b.adpValue ?? 0) - (a.adpValue ?? 0))[0]],
];
for (const [label, rec] of cases) {
  if (!rec) {
    console.log(`  ${label.padEnd(15)} (none on the board)`);
    continue;
  }
  console.log(
    `  ${label.padEnd(15)} ${String(rec.name).padEnd(24).slice(0, 24)} ADP ${String(rec.adp).padStart(5)}  ` +
      `Next ${pct(rec.survivalProbability)}  vs market ${pct(rec.nextPick?.marketBaseline)}`,
  );
  console.log(`                  ${(rec.nextPick?.drivers ?? []).join(' · ') || '(no drivers)'}`);
}

// ------------------------------------------------------------------- checks

console.log('');
console.log('Checks');

const survivals = recs.map((r) => r.survivalProbability).filter((p) => p != null);
check('players were scored', recs.length > 0, `${recs.length} returned`);

if (model.targetPick == null) {
  check(
    'no future pick, so Next is unknown rather than invented',
    survivals.length === 0,
    `${survivals.length} players carry a percentage`,
  );
} else {
  check('Next targets a pick after the one on the clock', model.targetPick > state.currentPick,
    `target ${model.targetPick}, clock ${state.currentPick}`);

  if (state.onTheClock) {
    check(
      'on the clock, Next targets the following pick and not this one',
      model.targetPick !== state.currentPick,
      `target ${model.targetPick}`,
    );
  }

  check('the board is not uniformly certain', !survivals.every((p) => p === 1), 'every player read 100%');
  check(
    'the board was deep enough to simulate',
    model.marketOnly !== true,
    'fell back to the ADP estimate — the player table is short',
  );
  check(
    'Next spreads across the board',
    survivals.length > 3 && new Set(survivals.map((p) => Math.round(p * 100))).size > 3,
    `${new Set(survivals.map((p) => Math.round(p * 100))).size} distinct values over ${survivals.length} players`,
  );
  check(
    'nobody ahead of you is you',
    !(model.slotsAhead ?? []).includes(state.mySlot),
    `slot ${state.mySlot} appears in ${JSON.stringify(model.slotsAhead)}`,
  );
  check(
    'every simulated pick belongs to somebody else',
    (model.picksSimulated ?? 0) <= model.targetPick - state.currentPick,
    `${model.picksSimulated} simulated over ${model.targetPick - state.currentPick} picks`,
  );
  check(
    'a player further down the board is safer than one at the top',
    (() => {
      const sorted = priced.slice().sort((a, b) => a.adp - b.adp);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return !first || !last || first === last || last.survivalProbability >= first.survivalProbability;
    })(),
    'survival does not rise with ADP',
  );
  check(
    'every driver names the pick Next is measured to',
    recs
      .filter((r) => r.nextPick?.probability != null)
      .every((r) => (r.nextPick.drivers[0] ?? '').includes(String(model.targetPick))),
    'a driver named the wrong pick',
  );
}

// The regression that a live draft would show first: a number that moves when
// nothing has.
const again = await get(`/api/drafts/${draftId}/board?limit=60`);
check(
  'the same board twice gives the same numbers',
  JSON.stringify((again.json?.recommendations ?? []).map((r) => [r.playerId, r.survivalProbability])) ===
    JSON.stringify(recs.map((r) => [r.playerId, r.survivalProbability])),
  'Next moved without a pick landing',
);

const budget = 400;
check(
  'the model fits in the draft-day budget',
  (model.elapsedMs ?? 0) < budget,
  `${model.elapsedMs}ms against a ${budget}ms ceiling`,
);

console.log('');
console.log(failures === 0 ? 'All checks passed.' : `${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exit(failures === 0 ? 0 : 1);
