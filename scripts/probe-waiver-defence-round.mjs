/**
 * Four complaints from one screenshot round, asked of production at once.
 *
 * 1. A quarterback was recommended at $7 on a card that also said nobody else
 *    in the league needs a quarterback.
 * 2. Two receivers compared on what may be season-long rather than recent form.
 * 3. Atlanta ranked above Tampa Bay and San Francisco as a streaming defence.
 * 5. A notable early pick, hurt this week, offered as a drop after one bad game.
 *
 * Reads only, GET only, no passphrase. It prints the *keys it actually found*
 * before reading any of them, because three separate readings in the previous
 * round were wrong about the key rather than about the app.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const NOW = new Date();

async function get(path) {
  try {
    const res = await fetch(`${APP}${path}`);
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: null, text: text.slice(0, 300) };
    }
  } catch (err) {
    return { status: 0, json: null, text: String(err) };
  }
}

const j = (v) => JSON.stringify(v);
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(', ') : `(${typeof o})`);

console.log(`probe run at ${NOW.toISOString()}  (${APP})\n`);

const leaguesRes = await get('/api/leagues');
const league =
  (leaguesRes.json?.leagues ?? []).find((l) => l.isSelected) ?? (leaguesRes.json?.leagues ?? [])[0] ?? null;
if (!league) {
  console.log('no league:', j(leaguesRes).slice(0, 400));
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})  season ${league.season}`);

// =====================================================================  waivers
console.log('\n================ WAIVERS: raw top-level shape ================');
const w = await get(`/api/leagues/${league.id}/waivers`);
console.log(`GET waivers -> ${w.status}`);
const W = w.json ?? {};
console.log(`top-level keys: ${keys(W)}`);

console.log('\n--- upgrades (slot-shaped) ---');
for (const u of W.upgrades ?? []) {
  console.log(`\nSLOT ${u.slot}  accepts=${j(u.accepts)}  need=${u.need}  bar=${u.bar}`);
  console.log(`  current: ${u.currentName ?? '(empty)'}  score=${u.currentScore ?? '—'}`);
  console.log(`  upgrade keys: ${keys(u)}`);
  for (const c of u.candidates ?? []) {
    console.log(
      `   - ${String(c.name).padEnd(22)} ${String(c.position).padEnd(4)} ` +
        `score=${String(c.score ?? '—').padEnd(7)} gain=${String(c.gain).padEnd(7)} ` +
        `conf=${String(c.confidence ?? '-').padEnd(7)} statusFlag=${c.statusFlag ?? '-'}`,
    );
    console.log(`       role=${j(c.role)}`);
    console.log(`       reasons=${j(c.reasons)}`);
    if (c === (u.candidates ?? [])[0]) console.log(`       candidate keys: ${keys(c)}`);
  }
}

console.log('\n--- valueAdds ---');
for (const v of (W.valueAdds ?? []).slice(0, 8)) {
  console.log(`   ${String(v.name).padEnd(22)} ${String(v.position).padEnd(4)} score=${v.score ?? '—'}  gain=${v.gain}`);
}
console.log(`valueAdds total: ${(W.valueAdds ?? []).length}`);

console.log('\n--- faab / bids ---');
const F = W.faab ?? null;
console.log(`faab keys: ${keys(F)}`);
if (F) {
  console.log(`  rule: ${j(F.rule)}`);
  console.log(`  mine: ${j(F.mine)}`);
  console.log(`  prices: ${j(F.prices)}`);
  for (const b of F.bids ?? []) {
    console.log(
      `\n  BID ${String(b.name).padEnd(22)} expected=${j(b.expected)} recommended=$${b.recommended} ` +
        `dne=$${b.doNotExceed} worth=${b.worth} conf=${b.confidence}`,
    );
    console.log(`    headline: ${b.headline}`);
    console.log(`    reasons : ${j(b.reasons)}`);
    console.log(`    components: ${j(b.components)}`);
  }
}

console.log('\n--- claimPlan ---');
const CP = W.claimPlan ?? null;
console.log(`claimPlan keys: ${keys(CP)}`);
if (CP) {
  for (const c of CP.claims ?? []) {
    console.log(`\n  CLAIM ${j({ add: c.addName, drop: c.dropName, bid: c.bid, netGain: c.netGain, addValue: c.addValue, dropCost: c.dropCost, lineupGain: c.lineupGain, confidence: c.confidence })}`);
    console.log(`    why: ${j(c.why ?? c.reasons ?? null)}`);
    if (c === (CP.claims ?? [])[0]) console.log(`    claim keys: ${keys(c)}`);
  }
  console.log(`\n  drops/notes keys present: ${keys(CP)}`);
  if (CP.drops) console.log(`  drops: ${j(CP.drops)}`);
}

console.log('\n--- dst block on the waiver board ---');
console.log(`dst keys: ${keys(W.dst)}`);
console.log(j(W.dst)?.slice(0, 2000));

// ============================================================  the DST plan
console.log('\n\n================ DST PLAN (support snapshot) ================');
const dst = await get(`/api/leagues/${league.id}/support-snapshot?context=dst-plan`);
console.log(`GET support-snapshot?dst-plan -> ${dst.status}`);
if (dst.json) {
  const body = dst.json;
  console.log(`snapshot keys: ${keys(body)}`);
  const text = JSON.stringify(body, null, 1);
  console.log(text.length > 14000 ? text.slice(0, 14000) + '\n…truncated…' : text);
} else {
  console.log(dst.text);
}

// ==========================================================  the two receivers
console.log('\n\n================ PLAYERS: the receivers in question ================');
for (const q of ['Keenan Allen', 'Ladd McConkey', 'Bryce Young']) {
  const res = await get(`/api/players?q=${encodeURIComponent(q)}`);
  const list = res.json?.players ?? res.json?.results ?? [];
  console.log(`\nsearch ${j(q)} -> ${res.status}, ${list.length} hit(s); keys=${keys(res.json)}`);
  const hit = list[0];
  if (!hit) continue;
  console.log(`  ${j(hit).slice(0, 600)}`);
  const detail = await get(`/api/players/${hit.id ?? hit.playerId}/detail`);
  if (detail.status === 200) {
    const t = JSON.stringify(detail.json, null, 1);
    console.log(t.length > 6000 ? t.slice(0, 6000) + '\n…truncated…' : t);
  } else {
    console.log(`  detail -> ${detail.status} ${detail.text ?? ''}`);
  }
}

// =================================================================  the roster
console.log('\n\n================ ROSTER (drop-candidate view) ================');
const roster = await get(`/api/leagues/${league.id}/roster`);
console.log(`GET roster -> ${roster.status}; keys=${keys(roster.json)}`);
const players = roster.json?.players ?? roster.json?.roster ?? [];
console.log(`row keys: ${keys(players[0])}`);
for (const p of players) {
  console.log(
    `  ${String(p.name).padEnd(24)} ${String(p.position).padEnd(4)} ` +
      `proj=${String(p.projection ?? p.score ?? '—').padEnd(7)} src=${String(p.projectionSource ?? '-').padEnd(10)} ` +
      `status=${p.injuryStatus ?? p.status ?? '-'}`,
  );
}
