/**
 * Does the live draft board label tiers and survival sensibly?
 *
 * The bug this exists to catch is loud and specific: a run of tight ends spread
 * across forty ADP picks, every one of them stamped `Tier cliff`. That is not
 * something a unit test can prove about production, because production has a
 * real board on it — so this asks the deployed app for its real recommendations
 * and prints, per position, what it decided and why.
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
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

console.log(`Checking ${BASE}\n`);

const status = await get('/api/setup/status');
const draftId = process.env.DRAFT_ID || status.json?.league?.draftId || '';
check('a league with a draft is configured', !!draftId, draftId || 'none');
if (!draftId) process.exit(1);

const board = await get(`/api/drafts/${draftId}/board?limit=200`);
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

for (const [position, players] of [...byPosition].sort()) {
  players.sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity));
  console.log(`── ${position} (${players.length} available and scored)`);
  for (const p of players.slice(0, 14)) {
    const cliff = p.tierCliff ?? {};
    const survival = p.survivalProbability == null ? '   —' : `${String(Math.round(p.survivalProbability * 100)).padStart(3)}%`;
    console.log(
      `   ${String(p.adp ?? '—').padStart(5)}  ${p.name.slice(0, 22).padEnd(22)}` +
        ` gap=${String(cliff.gapToNext ?? '—').padStart(5)}` +
        ` local=${String(cliff.localMedianGap ?? '—').padStart(5)}` +
        ` ratio=${String(cliff.gapRatio ?? '—').padStart(5)}` +
        ` surv=${survival}  ${cliff.severity ?? 'none'}`,
    );
  }

  const cliffs = players.filter((p) => p.tierCliff?.severity === 'last_in_tier');
  // The regression itself: a cliff is meant to be rare. Over a fifth of a
  // position wearing the label is the wallpaper this pass removed.
  check(
    `${position}: cliffs are rare`,
    players.length < 4 || cliffs.length <= Math.max(1, Math.ceil(players.length * 0.2)),
    `${cliffs.length} of ${players.length}`,
  );

  // Tier and survival are separate models and may disagree — but a cliff on a
  // player who is 85% to still be there, with comparable players around him,
  // is the contradiction worth printing.
  for (const p of cliffs) {
    const nearby = players.filter(
      (o) => o !== p && o.adp != null && p.adp != null && Math.abs(o.adp - p.adp) <= (p.tierCliff.gapToNext ?? 0),
    ).length;
    if ((p.survivalProbability ?? 0) >= 0.85 && nearby >= 2) {
      console.log(
        `      note: ${p.name} is a cliff at ${Math.round((p.survivalProbability ?? 0) * 100)}% survival with ${nearby} comparable nearby`,
      );
    }
  }

  const banded = players.filter((p) => p.survivalProbability != null);
  const outOfRange = banded.filter((p) => p.survivalProbability < 0 || p.survivalProbability > 1);
  check(`${position}: survival is a probability`, outOfRange.length === 0, `${banded.length} priced`);
  console.log('');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
