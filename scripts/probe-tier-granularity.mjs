/**
 * What tiers does the live Draft board actually have, and why?
 *
 * The bug this exists to catch is the opposite of the one
 * `probe-tier-survival.mjs` watches for. That one asks whether the board is
 * covered in warnings; this one asks whether it has any structure at all. The
 * reported failure was a quarterback filter showing twelve players between ADP
 * 53 and ADP 111 as a single undifferentiated tier — three obvious steps down
 * inside it and not one line drawn.
 *
 * So this prints, per position, the groups the model found and the arithmetic
 * behind every boundary: the gap that opened it, the local spacing it was
 * measured against, and the multiple of that spacing. Calibration you can read.
 *
 * It also runs the old rule alongside the new one, so "what changed" is a
 * column rather than a memory — §17's before-and-after, against the real board
 * rather than a fixture.
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 *
 *   node scripts/probe-tier-granularity.mjs
 *   APP_URL=http://localhost:8787 node scripts/probe-tier-granularity.mjs
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

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

/*
 * The rule as it stood before this pass, reimplemented here and nowhere else.
 *
 * It measured every gap against `max(local spacing, whole-position spacing)`
 * and opened a tier only where that cleared both an absolute per-position floor
 * and twice the baseline. Kept as ten lines of arithmetic rather than as a flag
 * in the model, because the model should carry one rule and this one is only
 * ever wanted for a before-and-after column.
 */
const OLD_MIN_GAP = { QB: 12, RB: 8, WR: 8, TE: 13, DEF: 14 };

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function oldTierSizes(position, adps) {
  const ladder = [...new Set(adps)].sort((a, b) => a - b);
  if (ladder.length === 0) return [];
  const gaps = ladder.slice(1).map((a, i) => Math.round((a - ladder[i]) * 10) / 10);
  const positionMedian = median(gaps);
  const floor = OLD_MIN_GAP[position] ?? 10;

  const sizes = [];
  let current = 0;
  for (let i = 0; i < ladder.length; i++) {
    current += adps.filter((a) => a === ladder[i]).length;
    const gap = i + 1 < ladder.length ? gaps[i] : null;
    if (gap == null) break;
    // The old window: three gaps behind, four ahead, candidate included.
    const local = median(gaps.slice(Math.max(0, i - 3), Math.min(gaps.length, i + 4)));
    const baseline = Math.max(...[local, positionMedian].filter((v) => v != null && v > 0));
    const after = gaps.slice(i + 1, i + 4);
    const followMean = after.length < 2 ? null : after.reduce((a, b) => a + b, 0) / after.length;
    const cliff =
      ladder.length >= 4 &&
      adps.filter((a) => a === ladder[i]).length === 1 &&
      gap >= floor &&
      baseline > 0 &&
      gap / baseline >= 2 &&
      (followMean == null || gap >= 1.4 * followMean);
    if (cliff) {
      sizes.push(current);
      current = 0;
    }
  }
  sizes.push(current);
  return sizes;
}

console.log(`Checking ${BASE}\n`);

const status = await get('/api/setup/status');
const draftId = process.env.DRAFT_ID || status.json?.league?.draftId || '';
check('a league with a draft is configured', !!draftId, draftId || 'none');
if (!draftId) process.exit(1);

const board = await get(`/api/drafts/${draftId}/board?limit=300`);
check('the board answers', board.status === 200, `HTTP ${board.status}`);
const recs = board.json?.recommendations ?? [];
check('it returned players', recs.length > 0, `${recs.length} scored`);
console.log(
  `      pick #${board.json?.currentPick} · your next pick ${board.json?.myNextPick ?? '—'} · ` +
    `${board.json?.picksUntilMyTurn ?? '—'} picks away\n`,
);

const byPosition = new Map();
for (const rec of recs) {
  const list = byPosition.get(rec.position);
  if (list) list.push(rec);
  else byPosition.set(rec.position, [rec]);
}

const summary = [];

for (const [position, players] of [...byPosition].sort()) {
  players.sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity));
  const priced = players.filter((p) => p.adp != null);
  const unpriced = players.length - priced.length;

  /*
   * The groups, read back off the players rather than recomputed.
   *
   * `tierIndex` is the model's own answer, so what is printed here is what the
   * screen drew — a probe that recomputed the tiers could agree with itself
   * while disagreeing with production.
   */
  const tiers = new Map();
  for (const p of priced) {
    const index = p.tierCliff?.tierIndex ?? 0;
    const group = tiers.get(index);
    if (group) group.push(p);
    else tiers.set(index, [p]);
  }
  const ordered = [...tiers].sort((a, b) => a[0] - b[0]);

  console.log(
    `── ${position}: ${priced.length} available${unpriced ? ` (+${unpriced} unpriced)` : ''}, ` +
      `${ordered.length} tier${ordered.length === 1 ? '' : 's'}`,
  );

  for (const [index, members] of ordered) {
    const opener = members[0]?.tierCliff ?? {};
    console.log(`   ${position} Tier ${index + 1}: ${members.length} players`);
    for (const p of members) {
      console.log(
        `      ADP ${String(p.adp ?? '—').padStart(6)}  ${String(p.name ?? '').slice(0, 24).padEnd(24)}` +
          ` gap=${String(p.tierCliff?.gapToNext ?? '—').padStart(5)}` +
          ` local=${String(p.tierCliff?.localMedianGap ?? '—').padStart(5)}` +
          ` ratio=${String(p.tierCliff?.gapRatio ?? '—').padStart(5)}` +
          `  ${p.tierCliff?.severity ?? 'none'}`,
      );
    }
    if (index > 0 && opener.tierGapBefore != null) {
      // The one line §16 asks for, in the shape it asks for it.
      const edge = ordered[index - 1]?.[1]?.at(-1)?.tierCliff ?? {};
      const local = edge.localMedianGap;
      const strength = local ? (opener.tierGapBefore / local).toFixed(1) : '—';
      console.log(
        `      boundary above: ADP gap ${opener.tierGapBefore}; local median ${local ?? '—'}; ` +
          `${strength}x local spacing${edge.severity === 'last_in_tier' ? ' (cliff)' : ''}`,
      );
    }
  }

  const adps = priced.map((p) => p.adp);
  const oldSizes = oldTierSizes(position, adps);
  const newSizes = ordered.map(([, members]) => members.length);
  summary.push({ position, count: priced.length, oldSizes, newSizes });

  /*
   * §18. No target count — but a deep position reported as one tier is the
   * failure this probe exists for, and a position with a tier per player is the
   * failure the fragmentation cap exists for.
   */
  check(
    `${position}: a deep position has some structure`,
    priced.length < 8 || ordered.length > 1,
    `${ordered.length} tier(s) across ${priced.length} players`,
  );
  check(
    `${position}: it is not a line between every player`,
    priced.length < 4 || ordered.length <= Math.ceil(priced.length * 0.6),
    `${ordered.length} tier(s) across ${priced.length} players`,
  );

  const cliffs = priced.filter((p) => p.tierCliff?.severity === 'last_in_tier');
  check(
    `${position}: cliffs are still rare`,
    priced.length < 4 || cliffs.length <= Math.max(1, Math.ceil(priced.length * 0.2)),
    `${cliffs.length} of ${priced.length}`,
  );

  console.log('');
}

console.log('── before and after, by position (§17)\n');
console.log(`   ${'pos'.padEnd(5)} ${'n'.padStart(4)}  ${'old'.padStart(4)}  ${'new'.padStart(4)}   sizes`);
for (const row of summary) {
  console.log(
    `   ${row.position.padEnd(5)} ${String(row.count).padStart(4)}  ` +
      `${String(row.oldSizes.length).padStart(4)}  ${String(row.newSizes.length).padStart(4)}   ` +
      `old [${row.oldSizes.join(', ')}] -> new [${row.newSizes.join(', ')}]`,
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
