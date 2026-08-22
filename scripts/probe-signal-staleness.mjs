/**
 * Is the derived signal cache telling the truth about *today*?
 *
 * `player_signal_cache` stores the recency windows as numbers, computed once by
 * `refreshSignal` with `now` set to the moment it ran. But a recency window is
 * not a fact about a player, it is a fact about a player *and the current date*
 * — a row that was inside the last 7 days when the cache was written leaves
 * that window seven days later whether or not anybody recomputes it.
 *
 * Nothing recomputes it. `refreshSignal` runs on ingest, import and review, so
 * a player whose evidence has not been touched since keeps whatever `7d` and
 * `30d` were true on the day his last row landed. `refreshAllSignals` exists
 * and has no caller.
 *
 * This proves or disproves that against production without a database, using
 * two routes that answer the same question from different places:
 *
 *   - `GET /api/players`      serializes the *cached* signal
 *   - `GET /api/players/:id`  aggregates from the ledger *live*
 *
 * If they disagree on `7d`/`30d`, the cache is stale and every cache-fed
 * surface — Trades, the draft board, Start/Sit, the Team roster — is reading a
 * window that expired.
 *
 * Reads only, and only GET. No passphrase, no writes.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

const NAMED = [
  'Puka Nacua',
  'Jaxon Smith-Njigba',
  'Josh Allen',
  'Jahmyr Gibbs',
  'Jonathan Taylor',
  'Sam LaPorta',
  'Kyle Pitts',
  'Jalen Hurts',
];

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

const w = (win) => (win ? win.net : null);
const s = (n) => (n === null ? '  —' : `${n > 0 ? '+' : ''}${n}`);

console.log(`${BASE}\ncached (/api/players) vs live (/api/players/:id)\n`);
console.log(
  'player'.padEnd(22),
  '  cached 7d/30d/life',
  '   live 7d/30d/life',
  '  carried',
  ' verdict',
);

let stale = 0;
let checked = 0;

for (const name of NAMED) {
  let listed;
  try {
    const body = await getJson(`/api/players?q=${encodeURIComponent(name)}&limit=10`);
    listed = (body.players ?? []).find((p) => p.name === name);
  } catch (err) {
    console.log(`${name.padEnd(22)}  list failed: ${err.message}`);
    continue;
  }
  if (!listed) {
    console.log(`${name.padEnd(22)}  not in the player list`);
    continue;
  }

  let file;
  try {
    file = await getJson(`/api/players/${encodeURIComponent(listed.id)}`);
  } catch (err) {
    console.log(`${name.padEnd(22)}  detail failed: ${err.message}`);
    continue;
  }

  const cached = listed.signal ?? null;
  const live = file.signal ?? null;
  if (!cached || !live) {
    console.log(`${name.padEnd(22)}  no signal on one of the two responses`);
    continue;
  }

  checked++;
  const c = [w(cached.last7), w(cached.last30), w(cached.raw)];
  const l = [w(live.last7), w(live.last30), w(live.raw)];
  const differs = c[0] !== l[0] || c[1] !== l[1];
  if (differs) stale++;

  console.log(
    name.padEnd(22),
    `${s(c[0]).padStart(6)}${s(c[1]).padStart(6)}${s(c[2]).padStart(6)}`,
    `   ${s(l[0]).padStart(6)}${s(l[1]).padStart(6)}${s(l[2]).padStart(6)}`,
    `${String(live.carriedOverItems ?? '—').padStart(6)}  `,
    differs ? 'STALE' : 'agrees',
  );

  if (differs) {
    console.log(
      `${' '.repeat(4)}cache last written ${cached.updatedAt ?? '(not sent)'}; ` +
        `last evidence ${live.lastEvidenceAt ?? 'none'}`,
    );
  }
}

console.log(
  `\n${stale} of ${checked} checked player(s) have a cached recency window that ` +
    `disagrees with the ledger as of now.`,
);
if (stale > 0) {
  console.log(
    'The lifetime column agreeing while 7d/30d disagree is the signature of a\n' +
      'window frozen at write time rather than a wrong tally.',
  );
}
