/**
 * Which players is the live board warning about, and why those?
 *
 * A tier-cliff chip answers one question — *if I want a player from the best
 * tier still available at this position, how many are left before I drop into
 * the next one?* — and it has been wrong in both directions. Once it marked
 * every player at a position. Once it marked a group two tiers down while the
 * group above it was still on the board, which is the failure this probe was
 * written for: the one card that needed marking said nothing, and the two that
 * did not warn were the ones a reader would act on.
 *
 * Neither failure announces itself. So this prints, per position, the ordered
 * available tiers, which one is active, whether anything exists below it, and
 * exactly who is warned with what label — the whole chain, in the order the
 * rule walks it.
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 *
 *   node scripts/probe-tier-warnings.mjs
 *   APP_URL=http://localhost:8787 node scripts/probe-tier-warnings.mjs
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
 * The rule, restated here against the API's own payload.
 *
 * Deliberately a restatement rather than an import: this probe exists to check
 * that the deployed board agrees with the rule, and a copy that shared the
 * implementation could only ever agree with itself. It is four lines because
 * the rule is four lines — see `tierCliffWarning`.
 */
function warningFor(tier) {
  if (!tier || tier.tierIndex !== 0) return null;
  if (!tier.tierEndsAtBoundary) return null;
  if (tier.tierSize === 1) return 'Tier cliff · last 1';
  if (tier.tierSize === 2) return 'Tier cliff · 2 left';
  return null;
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

let warnedTotal = 0;

for (const [position, players] of [...byPosition].sort()) {
  players.sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity));
  const priced = players.filter((p) => p.adp != null && p.tierCliff?.tierIndex != null);

  const tiers = new Map();
  for (const p of priced) {
    const index = p.tierCliff.tierIndex;
    const group = tiers.get(index);
    if (group) group.push(p);
    else tiers.set(index, [p]);
  }
  const ordered = [...tiers].sort((a, b) => a[0] - b[0]);

  console.log(`── ${position}`);
  // The top few bands are the whole of the question; the tail is noise here.
  for (const [index, members] of ordered.slice(0, 4)) {
    console.log(
      `   Tier ${index + 1}: [${members.map((p) => p.name).slice(0, 6).join(', ')}${members.length > 6 ? ', …' : ''}]` +
        ` (${members.length})`,
    );
  }

  const active = ordered[0];
  if (!active) {
    console.log('   Active: none — nothing priced at this position\n');
    continue;
  }
  const [activeIndex, activeMembers] = active;
  const lowerExists = activeMembers[0]?.tierCliff?.tierEndsAtBoundary === true;
  console.log(`   Active: Tier ${activeIndex + 1} (${activeMembers.length} left) · lower tier below it: ${lowerExists}`);

  const warned = priced.filter((p) => warningFor(p.tierCliff) != null);
  warnedTotal += warned.length;
  if (warned.length === 0) console.log('   Warnings: none');
  else for (const p of warned) console.log(`   Warning: ${p.name} -> "${warningFor(p.tierCliff)}"`);

  /*
   * The two invariants the rule exists to hold. Both are silent when broken —
   * a chip on the wrong card looks exactly like a chip on the right one — so
   * they are asserted here against the deployed board rather than trusted.
   */
  check(
    `${position}: only the active tier warns`,
    warned.every((p) => p.tierCliff.tierIndex === activeIndex),
    warned.length ? `tiers ${[...new Set(warned.map((p) => p.tierCliff.tierIndex + 1))].join(', ')}` : 'none warned',
  );
  check(
    `${position}: at most one tier warns`,
    new Set(warned.map((p) => p.tierCliff.tierIndex)).size <= 1,
    `${warned.length} chip(s)`,
  );
  check(
    `${position}: a warned tier is down to one or two`,
    warned.length === 0 || activeMembers.length <= 2,
    `${activeMembers.length} left in the active tier`,
  );
  check(
    `${position}: nothing warns with no tier below it`,
    warned.length === 0 || lowerExists,
    lowerExists ? 'a lower tier exists' : 'no lower tier',
  );

  console.log('');
}

check('the board is not covered in warnings', warnedTotal <= 2 * byPosition.size, `${warnedTotal} across the board`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
