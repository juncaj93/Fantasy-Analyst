/**
 * Why is Atlanta the streaming pick when Tampa Bay and San Francisco are the
 * obvious plays?
 *
 * Three things have to be told apart before that is a bug at all:
 *
 *   1. TB and SF may simply be rostered, in which case there is nothing to
 *      stream and the app is right;
 *   2. they may be in the pool and correctly ranked below Atlanta;
 *   3. they may be in the pool and unscorable, which drops them out of a
 *      ranking that only ever sees scored players.
 *
 * The suspicion is (3), because the receiver probe showed week 2 player props
 * with a Saturday kickoff and `game.spread` / `game.total` both null — so
 * `projectDst` has no anchor for anybody and every defence on the slate is
 * falling through to `fromOpponentForm`, which is one week of somebody else's
 * pricing. A defence whose opponent has no priced game at all gets nothing,
 * and nothing is not a low rank — it is an absence from the list.
 *
 * Reads only, GET only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 400) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const leaguesRes = await get('/api/leagues');
const league =
  (leaguesRes.json?.leagues ?? []).find((l) => l.isSelected) ?? (leaguesRes.json?.leagues ?? [])[0] ?? null;
console.log(`league: ${league?.name} (${league?.id})\n`);

// ------------------------------------------- are there any game lines at all?
console.log('=== 1. game lines for the week the app thinks it is in ===');
const vegas = await get('/api/vegas');
console.log(`GET /api/vegas -> ${vegas.status}; keys=${Object.keys(vegas.json ?? {}).join(', ')}`);
const events = vegas.json?.events ?? vegas.json?.games ?? [];
console.log(`events: ${events.length}`);
if (events[0]) console.log(`event keys: ${Object.keys(events[0]).join(', ')}`);
let withLine = 0;
for (const e of events) {
  const spread = e.spread ?? e.homeSpread ?? null;
  const total = e.total ?? null;
  if (spread != null && total != null) withLine += 1;
  console.log(
    `  ${String(e.kickoff ?? e.startTime ?? e.gameStart ?? '?').slice(0, 16)}  ` +
      `${String(e.away ?? e.awayTeam ?? '?').padEnd(4)}@${String(e.home ?? e.homeTeam ?? '?').padEnd(4)}  ` +
      `spread=${spread ?? '—'}  total=${total ?? '—'}  spreadTeam=${e.spreadTeam ?? '-'}`,
  );
}
console.log(`events carrying BOTH a spread and a total: ${withLine} of ${events.length}`);

// ------------------------------------------------- every defence, side by side
console.log('\n=== 2. every defence the planner saw ===');
const snap = await get(`/api/leagues/${league.id}/support-snapshot?context=dst-plan`);
console.log(`GET support-snapshot?dst-plan -> ${snap.status}`);
const d = snap.json?.decision ?? {};
console.log(`decision keys: ${Object.keys(d).join(', ')}`);
const inputs = d.inputs ?? {};
console.log(`inputs keys: ${Object.keys(inputs).join(', ')}`);

const rows = [];
for (const [where, bag] of [
  ['roster', inputs.roster],
  ['wire', inputs.candidates],
]) {
  for (const i of bag?.inputs ?? []) {
    const position = i.player?.position ?? i.position ?? '';
    if (!/^(DEF|DST|D\/ST)$/i.test(position)) continue;
    rows.push({ where, i });
  }
}
console.log(`defences found: ${rows.length}`);
if (rows[0]) console.log(`input keys: ${Object.keys(rows[0].i).join(', ')}`);

for (const { where, i } of rows) {
  const team = i.player?.team ?? i.player?.id ?? '?';
  const game = i.game ?? {};
  const form = i.opponentForm ?? null;
  console.log(
    `  ${String(team).padEnd(5)} ${where.padEnd(7)} opp=${String(i.opponent ?? game.opponent ?? '—').padEnd(5)} ` +
      `spread=${String(game.spread ?? '—').padEnd(7)} total=${String(game.total ?? '—').padEnd(7)} ` +
      `form=${form ? `${form.impliedTotal} over ${form.games}g` : '—'}`,
  );
}

console.log('\n--- implied totals the planner was handed (for the forward weeks) ---');
const totals = d.inputs?.reads?.impliedTotals ?? d.reads?.impliedTotals ?? null;
console.log(totals ? JSON.stringify(totals).slice(0, 2500) : '(none recorded under that key)');

console.log('\n--- the plan it reached ---');
const plan = d.plan ?? d.output ?? d.result ?? null;
console.log(plan ? JSON.stringify(plan, null, 1).slice(0, 3000) : `(no plan key; decision keys above)`);

// --------------------------------------------- which defences are rostered
console.log('\n=== 3. who owns a defence in this league ===');
const board = await get(`/api/leagues/${league.id}/managers`);
console.log(`GET managers -> ${board.status}; keys=${Object.keys(board.json ?? {}).join(', ')}`);
