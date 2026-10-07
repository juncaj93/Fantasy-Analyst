#!/usr/bin/env node
/**
 * Which players the trade check cannot put a number on this week, and why.
 *
 * Read-only against a running deployment, through its own endpoints, plus
 * Sleeper's public projections API for the earlier weeks. Every request is a
 * GET and nothing is changed.
 *
 *   node scripts/probe-trade-bye.mjs
 *   URL=http://127.0.0.1:8788 node scripts/probe-trade-bye.mjs
 *
 * Built for the October 2026 audit (finding T1). Before the fix, a player on a
 * bye, ruled out, or with nothing priced or published this week had no rate,
 * and any trade that moved him got no verdict. The fix values him on his most
 * recent earlier week of Sleeper's published projection (weeks back from this
 * one, three at most), through the same scoring gate as this week's.
 *
 * Run it before the fix ships and after, on the same week:
 *  - before: lists every rostered player with no rate, the reason the check
 *    gives, and the earlier-week figure the fix would use (read from Sleeper's
 *    public API, which is what the stored rows are a copy of, so it can differ
 *    from the stored copy by a late revision);
 *  - after: the same players should come back valued on `recent_week`, and the
 *    trades that moved them should have a verdict.
 *
 * Cost: four checks per pair of rosters (eight players a check), plus one
 * check for each player a failed check names. The first one is metered and
 * printed.
 */

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const SLEEPER = 'https://api.sleeper.com';
const MAX_PER_SIDE = 4;
const BACK = 3;

async function fetchJson(url) {
  const started = Date.now();
  try {
    const res = await fetch(url);
    const text = await res.text();
    try {
      return { status: res.status, ms: Date.now() - started, body: JSON.parse(text) };
    } catch {
      return { status: res.status, ms: Date.now() - started, body: { error: text.slice(0, 200) } };
    }
  } catch (err) {
    return { status: 0, ms: Date.now() - started, body: { error: String(err?.cause?.message ?? err?.message ?? err) } };
  }
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

async function main() {
  console.log(`Trade check coverage against ${URL_BASE}`);
  const leagues = await fetchJson(`${URL_BASE}/api/leagues`);
  const league = leagues.body?.leagues?.find((l) => l.isSelected) ?? leagues.body?.leagues?.[0];
  if (!league) {
    console.log('No league found.');
    process.exitCode = 1;
    return;
  }
  const base = `${URL_BASE}/api/leagues/${encodeURIComponent(league.id)}/trades/check`;
  const teams = await fetchJson(`${base}/teams`);
  if (teams.status !== 200 || !teams.body?.found) {
    console.log(`teams: ${teams.status} ${teams.body?.reason ?? teams.body?.error ?? ''}`);
    process.exitCode = 1;
    return;
  }
  const week = teams.body.horizon.currentWeek;
  const season = league.season ?? String(new Date().getUTCFullYear());
  console.log(`League ${teams.body.league.name}, season ${season}, week ${week}`);

  const rosters = teams.body.teams.filter((t) => t.players.length > 0);
  const byId = new Map();
  for (const t of rosters) for (const p of t.players) byId.set(p.playerId, { ...p, owner: t.label, rosterId: t.rosterId });

  // Pair the rosters so each check reads two of them, and send four players a side.
  const lines = new Map();
  const blocked = new Map();
  let checks = 0;
  let metered = false;
  for (let i = 0; i < rosters.length; i += 2) {
    const a = rosters[i];
    const b = rosters[i + 1] ?? rosters[0];
    const aGroups = chunks(a.players.map((p) => p.playerId), MAX_PER_SIDE);
    const bGroups = i + 1 < rosters.length ? chunks(b.players.map((p) => p.playerId), MAX_PER_SIDE) : [];
    const n = Math.max(aGroups.length, bGroups.length);
    for (let g = 0; g < n; g += 1) {
      const give = aGroups[g] ?? [];
      const get = bGroups[g] ?? [];
      if (give.length + get.length === 0) continue;
      const cost = metered ? '' : '&cost=1';
      const res = await fetchJson(`${base}?a=${a.rosterId}&b=${b.rosterId}&give=${give.join(',')}&get=${get.join(',')}${cost}`);
      checks += 1;
      if (!metered && res.body?.cost) {
        console.log(`one check costs: ${JSON.stringify(res.body.cost)}`);
        metered = true;
      }
      const ev = res.body?.evaluation;
      if (res.status !== 200 || !ev) {
        console.log(`  check ${a.label} vs ${b.label}: ${res.status} ${res.body?.error ?? ''}`);
        continue;
      }
      if (ev.status === 'ok') {
        for (const side of [ev.a, ev.b]) for (const p of side.outgoing) lines.set(p.playerId, p);
        continue;
      }
      // The reason names the players with no number. Ask about each of those
      // alone, for his own reason; the rest of the group is not re-checked.
      const named = (id) => {
        const name = byId.get(id)?.name;
        return name != null && (ev.insufficientReason ?? '').includes(name);
      };
      for (const [from, to, id] of [...give.map((id) => [a, b, id]), ...get.map((id) => [b, a, id])].filter(([, , id]) => named(id))) {
        const one = await fetchJson(`${base}?a=${from.rosterId}&b=${to.rosterId}&give=${id}&get=`);
        checks += 1;
        const e = one.body?.evaluation;
        if (e?.status === 'ok') lines.set(id, e.a.outgoing[0]);
        else blocked.set(id, e?.insufficientReason ?? one.body?.error ?? `HTTP ${one.status}`);
      }
    }
  }
  console.log(`${checks} checks run; ${byId.size} rostered players, ${blocked.size} with no number.\n`);

  const tally = new Map();
  for (const p of lines.values()) tally.set(p.basis, (tally.get(p.basis) ?? 0) + 1);
  console.log(`basis, for players in checks that got a verdict: ${[...tally].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const p of [...lines.values()].filter((x) => x.basis === 'recent_week')) {
    const who = byId.get(p.playerId);
    console.log(`  recent_week: ${p.name} (${p.position} ${p.team}, ${who?.owner}) ${p.rate}/g. ${p.rateNote ?? ''}`);
  }

  if (blocked.size === 0) {
    console.log('\nEvery rostered player has a number.');
    return;
  }

  // What the fix would use: the latest of the last three weeks with at least a point.
  const earlier = new Map();
  for (let back = 1; back <= BACK; back += 1) {
    const w = week - back;
    if (w < 1) break;
    const res = await fetchJson(
      `${SLEEPER}/projections/nfl/${season}/${w}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K`,
    );
    if (!Array.isArray(res.body)) {
      console.log(`Sleeper projections week ${w}: ${res.status} ${res.body?.error ?? ''}`);
      continue;
    }
    for (const row of res.body) {
      const id = String(row.player_id ?? '');
      if (!blocked.has(id) || earlier.has(id)) continue;
      const pts = Number(row.stats?.pts_half_ppr);
      if (Number.isFinite(pts) && pts >= 1) earlier.set(id, { week: w, pts });
    }
  }

  console.log('\nNo number this week (no verdict for any trade that moves him):');
  const rows = [...blocked].map(([id, reason]) => ({ id, reason, p: byId.get(id), e: earlier.get(id) }));
  rows.sort((x, y) => (x.p?.owner ?? '').localeCompare(y.p?.owner ?? '') || (x.p?.name ?? '').localeCompare(y.p?.name ?? ''));
  for (const { id, reason, p, e } of rows) {
    const after =
      p?.position === 'QB'
        ? 'stays unvalued: this league’s scoring refuses published QB totals'
        : e
          ? `fix would use week ${e.week}: ${e.pts.toFixed(2)}/g`
          : 'fix finds no earlier week either';
    console.log(`  ${p?.name ?? id} (${p?.position ?? '?'} ${p?.team ?? '?'}, ${p?.owner ?? '?'}${p?.reserve ? ', IR' : ''}): ${after}`);
    console.log(`      check says: ${reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
