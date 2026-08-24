#!/usr/bin/env node
/**
 * What Sleeper actually publishes about a league's *previous* drafts.
 *
 * Written before the manager-tendency model, because every decision in it turns
 * on an answer here: how far back the chain goes, what identifies a manager
 * across seasons, and — the one that decides whether a whole feature is allowed
 * to exist — whether a historical pick carries a contemporaneous market price.
 *
 * Read-only against the documented public endpoints; no key, no account.
 *
 *   node scripts/probe-sleeper-draft-history.mjs <league_id> [username]
 *
 * What the first run established, against a real ten-team league
 * (`1385016656425668608`, "Tony's Pizza Fantasy", 2026):
 *
 *   - The chain is three seasons deep — 2026, 2025, 2024 — and then ends with a
 *     null `previous_league_id`. Each hop is one `GET /league/<id>`. Two of the
 *     three are complete drafts of 160 picks; the current season is `pre_draft`
 *     and has none yet, so **two** historical drafts are actually available.
 *
 *   - `picked_by` is a **user_id**, present on all 320 historical picks, and is
 *     the only stable cross-season identity.
 *
 *   - `roster_id` is emphatically *not* stable, and this league demonstrates the
 *     failure in its sharpest form: **roster_id 4 was three different people.**
 *
 *         2024  roster_id 4 -> Anthonyberardo
 *         2025  roster_id 4 -> Tupaz11
 *         2026  roster_id 4 -> zackstephens54   (new manager, no history)
 *
 *     Attributing history by roster id therefore does not merely misfile a few
 *     picks — it hands a brand-new manager a confident 32-pick "tendency"
 *     assembled from two strangers. The reverse hazard (one manager moving
 *     between roster ids) does not happen to occur here, which is exactly why
 *     it must not be relied on: the safe key is user_id in both directions.
 *
 *   - `draft_order` is keyed by user_id, confirming the same anchor.
 *     `slot_to_roster_id` maps draft slot to that season's roster id, and slot
 *     does not equal roster id (2025 pick 1.01 was draft_slot 1, roster_id 9).
 *
 *   - Draft pick `metadata` carries a player snapshot — first/last name, team,
 *     position, years_exp, injury_status, number, status, news_updated.
 *     **There is no ADP field and no `search_rank`.** See §4 below.
 *
 *   - `is_keeper` exists on every pick and was null on all 320, so no keeper
 *     distortion of round/slot meaning in this league's history.
 */

const BASE = 'https://api.sleeper.app/v1';

const leagueId = process.argv[2];
const username = process.argv[3] ?? null;

if (!leagueId) {
  console.error('usage: node scripts/probe-sleeper-draft-history.mjs <league_id> [username]');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  return !text || text === 'null' ? null : JSON.parse(text);
}

function keysOf(objects) {
  const seen = new Set();
  for (const o of objects) for (const k of Object.keys(o ?? {})) seen.add(k);
  return [...seen].sort();
}

const me = username ? await get(`/user/${encodeURIComponent(username)}`) : null;
if (me) console.log(`you            ${me.display_name} (user_id ${me.user_id})`);

// ---------------------------------------------------------------- the chain
const chain = [];
let cursor = leagueId;
const guard = new Set();
while (cursor && !guard.has(cursor)) {
  guard.add(cursor);
  const league = await get(`/league/${encodeURIComponent(cursor)}`);
  if (!league) break;
  chain.push(league);
  cursor = league.previous_league_id ?? null;
}

console.log(`\n=== chain (${chain.length} season(s)) ===`);
for (const l of chain) {
  console.log(
    `${l.season}  ${l.league_id}  ${String(l.status).padEnd(10)} teams=${l.total_rosters}  prev=${l.previous_league_id ?? '(none — first season)'}  ${l.name}`,
  );
}

// -------------------------------------------------- identity across seasons
console.log(`\n=== manager identity ===`);
/** user_id -> season -> roster_id */
const rosterByUser = new Map();
const nameByUser = new Map();
for (const l of chain) {
  const [rosters, users] = await Promise.all([
    get(`/league/${l.league_id}/rosters`),
    get(`/league/${l.league_id}/users`),
  ]);
  for (const u of users ?? []) nameByUser.set(u.user_id, u.display_name ?? u.username ?? u.user_id);
  for (const r of rosters ?? []) {
    if (!r.owner_id) continue;
    if (!rosterByUser.has(r.owner_id)) rosterByUser.set(r.owner_id, new Map());
    rosterByUser.get(r.owner_id).set(l.season, r.roster_id);
  }
}

let movers = 0;
for (const [userId, bySeason] of rosterByUser) {
  const ids = [...new Set(bySeason.values())];
  const trail = [...bySeason.entries()].map(([s, r]) => `${s}:r${r}`).join(' ');
  if (ids.length > 1) movers++;
  console.log(`${ids.length > 1 ? 'MOVED' : '     '} ${String(nameByUser.get(userId) ?? userId).padEnd(20)} ${trail}`);
}
console.log(
  `\n${rosterByUser.size} manager(s) seen; ${movers} hold a different roster_id in different seasons.`,
);
console.log(
  movers > 0
    ? 'roster_id is NOT a safe cross-season key here. user_id is.'
    : 'roster_id happens to be stable here, which is not a guarantee. user_id is the safe key.',
);

// ------------------------------------------------------------- the drafts
console.log(`\n=== drafts ===`);
const allPicks = [];
for (const l of chain) {
  const drafts = (await get(`/league/${l.league_id}/drafts`)) ?? [];
  console.log(`${l.season}  ${drafts.length} draft(s)`);
  for (const d of drafts) {
    const picks = (await get(`/draft/${d.draft_id}/picks`)) ?? [];
    const full = await get(`/draft/${d.draft_id}`);
    const orderKeys = Object.keys(full?.draft_order ?? {});
    const slotMap = full?.slot_to_roster_id ?? {};
    console.log(
      `   ${d.draft_id}  ${String(d.status).padEnd(10)} type=${d.type} rounds=${d.settings?.rounds ?? '?'} teams=${d.settings?.teams ?? '?'} picks=${picks.length}`,
    );
    console.log(
      `      draft_order keys look like ${orderKeys.length ? (/^\d{15,}$/.test(orderKeys[0]) ? 'user_id' : 'other') : '(empty)'} (${orderKeys.length}) | slot_to_roster_id entries ${Object.keys(slotMap).length}`,
    );
    if (picks.length > 0) {
      const withPickedBy = picks.filter((p) => p.picked_by).length;
      const keepers = picks.filter((p) => String(p.metadata?.is_keeper) === 'true').length;
      console.log(`      picked_by present on ${withPickedBy}/${picks.length}; keepers flagged ${keepers}`);
      console.log(`      pick keys      ${keysOf(picks).join(', ')}`);
      console.log(`      metadata keys  ${keysOf(picks.map((p) => p.metadata)).join(', ')}`);
      const sample = picks[0];
      console.log(`      first pick     ${JSON.stringify(sample)}`);
      for (const p of picks) {
        allPicks.push({ season: d.season ?? l.season, draftId: d.draft_id, ...p });
      }
    }
  }
}

// ------------------------------------------- the integrity question (brief §4)
console.log(`\n=== historical market price ===`);
const ADP_FIELDS = ['adp', 'search_rank', 'rank', 'adp_full_ppr', 'market_rank', 'draft_rank'];
const metaKeys = new Set(keysOf(allPicks.map((p) => p.metadata)));
const found = ADP_FIELDS.filter((f) => metaKeys.has(f));
console.log(`fields present on historical picks that could price a pick: ${found.length ? found.join(', ') : 'NONE'}`);
console.log(
  found.length === 0
    ? 'No contemporaneous market price is published with a historical pick.\n' +
        'Under the brief\'s §4 rule, reach-vs-ADP is therefore UNAVAILABLE for these\n' +
        'seasons and must not be substituted with current ADP or current search_rank.'
    : 'A candidate field exists — verify it is written at pick time, not read live.',
);

console.log(`\ntotal historical picks collected: ${allPicks.length}`);
