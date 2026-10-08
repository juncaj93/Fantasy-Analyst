/**
 * What the T3 rule would do to the live Trades ideas (read-only).
 *
 * Fetches the live board (/api/trades/smart) and, for every idea on it plus any
 * named in IDEAS, asks the live Check a trade for the same deal, then applies
 * the rule in core/trades/seasonCheck.ts: an idea the season check says leans
 * to or favors the other team is left off; the rest carry the verdict.
 *
 *   IDEAS="Sam LaPorta>Carnell Tate" node scripts/probe-trade-agree.mjs
 *
 * IDEAS names players, "give,give>get,get", separated by ";". Each is checked
 * against the roster holding the get side. Cost: one trade check per idea.
 *
 * The Probe workflow passes no IDEAS, so the default is the one idea the
 * touchdown fix (#345) surfaced in its replay on 8 October 2026.
 */

const APP = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const get = async (path) => {
  const res = await fetch(`${APP}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const leagues = (await get('/api/leagues')).body;
const league = leagues?.leagues?.find((l) => l.isSelected) ?? leagues?.leagues?.[0];
const teams = (await get(`/api/leagues/${league.id}/trades/check/teams`)).body;
const mine = teams.teams.find((t) => t.isMine);
const byName = new Map();
for (const t of teams.teams) for (const p of t.players) byName.set(p.name.toLowerCase(), { ...p, rosterId: t.rosterId, owner: t.label });

const board = (await get('/api/trades/smart')).body;
const ideas = (board?.offers ?? []).map((o) => ({
  label: `${o.give.map((p) => p.name).join(' + ')} for ${o.get.map((p) => p.name).join(' + ')} (${o.partner.displayName})`,
  partner: o.partner.rosterId,
  give: o.give.map((p) => p.playerId),
  get: o.get.map((p) => p.playerId),
  source: `live board (${o.category ?? 'upgrade'})`,
}));
for (const spec of (process.env.IDEAS ?? 'Sam LaPorta>Carnell Tate').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [g, r] = spec.split('>');
  const give = g.split(',').map((n) => byName.get(n.trim().toLowerCase()));
  const take = r.split(',').map((n) => byName.get(n.trim().toLowerCase()));
  if (give.some((p) => !p) || take.some((p) => !p)) {
    console.log(`IDEAS: could not find every player in "${spec}"`);
    continue;
  }
  ideas.push({ label: `${spec} (${take[0].owner})`, partner: take[0].rosterId, give: give.map((p) => p.playerId), get: take.map((p) => p.playerId), source: 'named' });
}
console.log(`League ${league.name}; live board has ${board?.offers?.length ?? 0} idea(s); checking ${ideas.length}.`);
for (const idea of ideas) {
  const q = `/api/leagues/${league.id}/trades/check?a=${mine.rosterId}&b=${idea.partner}&give=${idea.give.join(',')}&get=${idea.get.join(',')}`;
  const ev = (await get(q)).body?.evaluation;
  const kind = ev?.status === 'ok' ? ev.verdict?.kind : null;
  const action = kind === 'leans_b' || kind === 'favors_b' ? 'LEFT OFF' : 'KEPT';
  console.log(`\n${idea.label}  [${idea.source}]`);
  console.log(`  Check a trade: ${ev?.status === 'ok' ? `${ev.verdict.headline} (${ev.confidence} confidence)` : `not checked: ${ev?.insufficientReason ?? 'no answer'}`}`);
  console.log(`  T3 rule: ${action}`);
  for (const r of ev?.reasons ?? []) console.log(`  why: ${r}`);
}
