/**
 * One read-only answer to "why is production on mock, and what would turning it
 * on actually get us?"
 *
 * Three separate questions get conflated whenever this comes up, so this asks
 * them separately and prints them separately:
 *
 *   1. What does the deployed app currently say about itself — which provider,
 *      is it live, what has it stored, what has it spent?
 *   2. Does SportsGameOdds publish SEASON-LONG player totals, which is what a
 *      draft board wants? Established from the market catalogue and from
 *      season-shaped event queries, never inferred from weekly prop support.
 *   3. Does it publish WEEKLY game props, and do the names on them resolve to
 *      this app's players? Measured with the app's own matcher, not a
 *      re-implementation that could be kinder than the real thing.
 *
 * Every quote printed here is labelled WEEKLY or SEASON-LONG from its own
 * periodID. Nothing is filled in, defaulted or rounded to zero: a market that
 * is absent prints as absent.
 *
 * Cost: the free plan bills one entity per event returned, so this reads
 * `/account/usage` before and after and prints the measured delta rather than
 * an estimate. Every event query is deliberately small.
 *
 * Prints only. Changes nothing, stores nothing, and never echoes the key.
 */

import { toCanonicalPlayers } from '../src/core/sleeper/transform.ts';
import { PlayerIndex, resolvePlayer } from '../src/core/identity/index.ts';

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const BASE = 'https://api.sportsgameodds.com/v2';
const APP = process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

const now = new Date();
const YEAR = now.getUTCFullYear();

function head(title) {
  console.log(`\n\n========== ${title} ==========`);
}

function sub(title) {
  console.log(`\n--- ${title} ---`);
}

async function getJson(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the text for the report */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: `fetch failed: ${err.message}` };
  }
}

let sgoRequests = 0;
async function sgo(path) {
  sgoRequests++;
  return getJson(`${BASE}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
}

/* ------------------------------------------------------------------ *
 * 1. What production says about itself
 * ------------------------------------------------------------------ */

head('1. PRODUCTION STATE (read-only GETs anyone can make)');

const status = await getJson(`${APP}/api/setup/status`);
console.log(`GET /api/setup/status -> ${status.status}`);
const vegas = status.json?.vegas;
if (vegas) {
  console.log(`  provider           : ${vegas.provider}`);
  console.log(`  live               : ${vegas.live}`);
  console.log(`  note               : ${vegas.note}`);
  console.log(`  stored events      : ${vegas.events}`);
  console.log(`  last refreshed at  : ${vegas.lastRefreshedAt ?? 'never'}`);
  console.log(
    `  budget             : ${vegas.budget?.used} of ${vegas.budget?.limit} used ` +
      `(${vegas.budget?.state}, source=${vegas.budget?.source}, month=${vegas.budget?.month})`,
  );
  console.log(`  budget by source   : ${JSON.stringify(vegas.budget?.bySource ?? null)}`);
  console.log(`  season markets     : ${JSON.stringify(vegas.season ?? null)}`);
  const step = (status.json?.steps ?? []).find((s) => s.id === 'vegas');
  console.log(`  Setup step shown   : state=${step?.state} summary="${step?.summary}"`);
} else {
  console.log(`  no vegas block in the response: ${(status.text ?? '').slice(0, 300)}`);
}

const budget = await getJson(`${APP}/api/vegas/budget`);
console.log(`\nGET /api/vegas/budget -> ${budget.status}`);
console.log(`  ${(budget.text ?? '').slice(0, 900)}`);

if (!KEY) {
  console.log('\n\nSPORTSGAMEODDS_API_KEY is not set for this run — the provider half cannot be asked.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 2. Spend before
 * ------------------------------------------------------------------ */

head('2. PROVIDER QUOTA, BEFORE');

const usageBefore = await sgo('/account/usage');
console.log(`status ${usageBefore.status}`);
console.log(`  ${(usageBefore.text ?? '').slice(0, 700)}`);

/** Pull the month's entity counter out of whatever shape usage comes back in. */
function entityCount(res) {
  const seen = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const here = path ? `${path}.${k}` : k;
      if (typeof v === 'number' && /entit/i.test(here)) seen.push([here, v]);
      else if (v && typeof v === 'object') walk(v, here);
    }
  };
  walk(res.json?.data ?? res.json, '');
  return seen;
}
console.log(`  entity counters seen: ${JSON.stringify(entityCount(usageBefore))}`);

/* ------------------------------------------------------------------ *
 * 3. The market catalogue — the authoritative answer on season support
 * ------------------------------------------------------------------ */

head('3. SEASON-LONG SUPPORT: THE MARKET CATALOGUE');
console.log('The catalogue lists every market the league offers and the period each is quoted on.');
console.log('If no season-length period exists here, no season-long player total can exist either.\n');

const catalogue = await sgo('/markets?leagueID=NFL');
console.log(`GET /markets?leagueID=NFL -> ${catalogue.status}`);
const markets = catalogue.json?.data ?? [];
if (!Array.isArray(markets) || markets.length === 0) {
  console.log(`  no catalogue returned: ${(catalogue.text ?? '').slice(0, 400)}`);
} else {
  console.log(`  ${markets.length} markets listed`);
  const periods = new Map();
  for (const m of markets) {
    const p = m.periodID ?? m.period ?? '?';
    periods.set(p, (periods.get(p) ?? 0) + 1);
  }
  console.log(`  periods present: ${[...periods.entries()].map(([p, n]) => `${p}(${n})`).join(', ')}`);

  // "reg" is regulation time inside a game, NOT a season. Reading it as a
  // season is how a 28.5-yard line becomes a season total, so it is excluded
  // from the season test by name.
  const SEASON_SHAPED = /season|full[_-]?year|^year$|futures?/i;
  const seasonPeriods = [...periods.keys()].filter((p) => SEASON_SHAPED.test(String(p)));
  const seasonNamed = markets.filter(
    (m) => SEASON_SHAPED.test(String(m.marketName ?? '')) || SEASON_SHAPED.test(String(m.statID ?? '')),
  );
  console.log(`  season-length periods  : ${seasonPeriods.length ? seasonPeriods.join(', ') : 'NONE'}`);
  console.log(`  season-named markets   : ${seasonNamed.length}`);
  for (const m of seasonNamed.slice(0, 15)) {
    console.log(`     ${m.statID ?? '?'} | period=${m.periodID ?? '?'} | "${m.marketName ?? ''}"`);
  }
  const fantasy = markets.filter((m) => /fantasy/i.test(String(m.statID ?? '') + String(m.marketName ?? '')));
  console.log(`  fantasy-score markets  : ${fantasy.length}`);
  for (const m of fantasy.slice(0, 5)) {
    console.log(`     ${m.statID ?? '?'} | period=${m.periodID ?? '?'} | "${m.marketName ?? ''}"`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. Season-shaped events
 * ------------------------------------------------------------------ */

head('4. SEASON-LONG SUPPORT: SEASON-SHAPED EVENT QUERIES');
console.log('A season-long player future has to hang off an event that is not a single game,');
console.log('and it settles when the season does. Each query below is limit=1: the question is');
console.log('"does even one exist", and one answers it exactly as well as twenty-five would.\n');

const seasonQueries = [
  [`type=prop`, `/events?leagueID=NFL&type=prop&oddsAvailable=true&limit=1`],
  [`type=tournament`, `/events?leagueID=NFL&type=tournament&oddsAvailable=true&limit=1`],
  [`dated after the regular season`, `/events?leagueID=NFL&startsAfter=${YEAR}-12-20&limit=1`],
  [`season=${YEAR} with odds`, `/events?leagueID=NFL&season=${YEAR}&oddsAvailable=true&limit=1`],
];

const SEASON_PERIODS = new Set(['season', 'full_season', 'regular_season', 'year']);
let seasonQuotesFound = 0;

for (const [label, path] of seasonQueries) {
  sub(label);
  const res = await sgo(path);
  console.log(`  status ${res.status}`);
  const data = res.json?.data;
  if (!Array.isArray(data) || data.length === 0) {
    console.log(`  NO EVENTS RETURNED — ${(res.text ?? '').slice(0, 200)}`);
    continue;
  }
  for (const ev of data) {
    const odds = Object.values(ev.odds ?? {});
    const periodsHere = new Set(odds.map((o) => o?.periodID).filter(Boolean));
    const seasonOdds = odds.filter((o) => o?.periodID && SEASON_PERIODS.has(o.periodID));
    seasonQuotesFound += seasonOdds.length;
    console.log(
      `  ${ev.eventID} type=${ev.type} starts=${ev.status?.startsAt ?? '?'} ` +
        `odds=${odds.length} players=${Object.keys(ev.players ?? {}).length}`,
    );
    console.log(`     periods on this event: ${[...periodsHere].join(', ') || 'none'}`);
    console.log(`     SEASON-LONG quotes on it: ${seasonOdds.length}`);
    for (const o of seasonOdds.slice(0, 10)) {
      console.log(
        `       SEASON-LONG ${o.statID} entity=${o.statEntityID} line=${o.bookOverUnder ?? o.fairOverUnder ?? 'none'}`,
      );
    }
  }
}

console.log(`\nSEASON-LONG player quotes found across every query: ${seasonQuotesFound}`);

/* ------------------------------------------------------------------ *
 * 5. Weekly regular-season coverage
 * ------------------------------------------------------------------ */

head('5. WEEKLY (GAME) PROP COVERAGE ON REGULAR-SEASON FIXTURES');

const weekly = await sgo(
  `/events?leagueID=NFL&type=match&oddsAvailable=true&startsAfter=${YEAR}-09-08&limit=4`,
);
console.log(`status ${weekly.status}`);
const games = weekly.json?.data ?? [];
console.log(`${games.length} regular-season fixture(s) returned\n`);

/** One provider quote, flattened, with the horizon it describes made explicit. */
const flat = [];
const providerPlayers = new Map(); // playerID -> { name, teamID, position }

for (const ev of games) {
  const players = ev.players ?? {};
  for (const [id, p] of Object.entries(players)) {
    if (!providerPlayers.has(id)) {
      providerPlayers.set(id, {
        name: p?.name ?? [p?.firstName, p?.lastName].filter(Boolean).join(' '),
        teamID: p?.teamID ?? null,
        position: p?.position ?? p?.positionID ?? null,
      });
    }
  }
  const odds = Object.values(ev.odds ?? {});
  const combos = new Map();
  for (const o of odds) {
    if (o?.cancelled) continue;
    const key = `${o?.statID ?? '?'} | period=${o?.periodID ?? '?'} | bet=${o?.betTypeID ?? '?'}`;
    combos.set(key, (combos.get(key) ?? 0) + 1);
    const entity = o?.playerID ?? o?.statEntityID ?? '';
    if (players[entity] && (o?.sideID === 'over' || o?.sideID === 'yes')) {
      flat.push({
        eventID: ev.eventID,
        gameStart: ev.status?.startsAt ?? null,
        entity,
        name: providerPlayers.get(entity)?.name ?? entity,
        teamID: providerPlayers.get(entity)?.teamID ?? null,
        position: providerPlayers.get(entity)?.position ?? null,
        statID: o.statID ?? null,
        periodID: o.periodID ?? null,
        betTypeID: o.betTypeID ?? null,
        line: o.bookOverUnder ?? o.fairOverUnder ?? null,
        overPrice: o.bookOdds ?? o.fairOdds ?? null,
        underPrice: o.bookOverUnder != null ? (o.bookOddsUnder ?? null) : null,
        scope: o.periodID && SEASON_PERIODS.has(o.periodID) ? 'SEASON-LONG' : 'WEEKLY (single game)',
        books: Object.keys(o.byBookmaker ?? {}),
      });
    }
  }
  sub(`${ev.eventID}  kickoff ${ev.status?.startsAt ?? '?'}`);
  console.log(`  ${Object.keys(players).length} named players, ${odds.length} odds objects`);
  const rows = [...combos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [k, n] of rows) console.log(`    ${k} -> ${n}`);
  if (combos.size > rows.length) console.log(`    … and ${combos.size - rows.length} more combinations`);
}

console.log(`\nprovider players seen across those fixtures: ${providerPlayers.size}`);
console.log(`player quotes flattened (over/yes side): ${flat.length}`);
const scopes = new Map();
for (const q of flat) scopes.set(q.scope, (scopes.get(q.scope) ?? 0) + 1);
console.log(`by horizon: ${[...scopes.entries()].map(([s, n]) => `${s}=${n}`).join(', ') || 'none'}`);

/* ------------------------------------------------------------------ *
 * 6. Player matching, with the app's own matcher
 * ------------------------------------------------------------------ */

head("6. PLAYER MATCHING, USING THE APP'S OWN RESOLVER");
console.log('Sleeper is the dictionary the app matches against, so it is the dictionary used here.');
console.log('resolvePlayer() and PlayerIndex are imported from src/, not re-implemented.\n');

const sleeper = await getJson('https://api.sleeper.app/v1/players/nfl');
console.log(`GET sleeper players -> ${sleeper.status}`);
let index = null;
if (sleeper.json) {
  const canonical = toCanonicalPlayers(sleeper.json);
  index = new PlayerIndex(canonical);
  console.log(`  ${canonical.length} canonical fantasy players indexed`);
} else {
  console.log(`  could not load the dictionary: ${(sleeper.text ?? '').slice(0, 200)}`);
}

const matchReport = new Map(); // providerId -> { name, status, method, playerId, position }
if (index) {
  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  const methods = new Map();
  for (const [id, p] of providerPlayers) {
    if (!p.name) continue;
    const res = resolvePlayer({ name: p.name }, index);
    matchReport.set(id, {
      name: p.name,
      status: res.status,
      method: res.method ?? null,
      playerId: res.status === 'matched' ? res.playerId : null,
      position: p.position,
      teamID: p.teamID,
    });
    if (res.status === 'matched') {
      matched++;
      methods.set(res.method, (methods.get(res.method) ?? 0) + 1);
    } else if (res.status === 'ambiguous') ambiguous++;
    else unmatched++;
  }
  const total = matched + ambiguous + unmatched;
  console.log(`\n  provider names tested : ${total}`);
  console.log(`  matched               : ${matched}${total ? ` (${Math.round((matched / total) * 100)}%)` : ''}`);
  console.log(`  ambiguous             : ${ambiguous}`);
  console.log(`  unmatched             : ${unmatched}`);
  console.log(`  by method             : ${[...methods.entries()].map(([m, n]) => `${m}=${n}`).join(', ')}`);

  // Never silently dropped: every name that did not resolve is printed.
  const unresolved = [...matchReport.values()].filter((m) => m.status !== 'matched');
  if (unresolved.length) {
    sub('every name that did NOT resolve');
    for (const u of unresolved) {
      console.log(`  ${u.status.padEnd(9)} "${u.name}" pos=${u.position ?? '?'} team=${u.teamID ?? '?'}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. Positional samples
 * ------------------------------------------------------------------ */

head('7. POSITIONAL SAMPLES — WHAT A REAL PLAYER ACTUALLY HAS');
console.log('Every line below is labelled with the horizon it describes. A missing market prints');
console.log('as "no market", never as a zero.\n');

const byPlayer = new Map();
for (const q of flat) {
  const list = byPlayer.get(q.entity);
  if (list) list.push(q);
  else byPlayer.set(q.entity, [q]);
}

/** Rank by how many markets a player carries: a proxy for how featured he is. */
const ranked = [...byPlayer.entries()].sort((a, b) => b[1].length - a[1].length);

const POSITION_OF = (entity) => matchReport.get(entity)?.position ?? providerPlayers.get(entity)?.position ?? null;

function positionOfQuotes(quotes) {
  const stats = new Set(quotes.map((q) => q.statID));
  if (stats.has('passing_yards')) return 'QB';
  if (stats.has('receiving_receptions') || stats.has('receiving_yards')) return 'WR/TE';
  if (stats.has('rushing_yards')) return 'RB';
  return '?';
}

const buckets = new Map();
for (const [entity, quotes] of ranked) {
  const pos = POSITION_OF(entity) ?? positionOfQuotes(quotes);
  const list = buckets.get(pos) ?? [];
  list.push([entity, quotes]);
  buckets.set(pos, list);
}

for (const [pos, list] of buckets) {
  sub(`position ${pos} — ${list.length} player(s); showing the most-quoted and a mid-tier one`);
  const picks = [list[0], list[Math.floor(list.length / 2)]].filter(Boolean);
  const seen = new Set();
  for (const [entity, quotes] of picks) {
    if (seen.has(entity)) continue;
    seen.add(entity);
    const m = matchReport.get(entity);
    console.log(
      `\n  ${quotes[0].name}  (provider id ${entity}, team ${quotes[0].teamID ?? '?'})` +
        `\n    resolves in this app : ${m ? `${m.status}${m.method ? ` via ${m.method}` : ''}${m.playerId ? ` -> ${m.playerId}` : ''}` : 'not tested'}` +
        `\n    kickoff              : ${quotes[0].gameStart ?? 'unknown'}`,
    );
    for (const q of quotes) {
      console.log(
        `    ${q.scope.padEnd(20)} ${String(q.statID).padEnd(24)} period=${String(q.periodID).padEnd(6)} ` +
          `bet=${String(q.betTypeID).padEnd(4)} line=${q.line ?? 'no line'} price=${q.overPrice ?? 'no price'} ` +
          `books=${q.books.length ? q.books.join('/') : 'consensus only (byBookmaker empty)'}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 8. Spend after
 * ------------------------------------------------------------------ */

head('8. PROVIDER QUOTA, AFTER — THE MEASURED COST OF THIS PROBE');

const usageAfter = await sgo('/account/usage');
console.log(`status ${usageAfter.status}`);
console.log(`  ${(usageAfter.text ?? '').slice(0, 700)}`);

const before = entityCount(usageBefore);
const after = entityCount(usageAfter);
console.log(`\n  entity counters before: ${JSON.stringify(before)}`);
console.log(`  entity counters after : ${JSON.stringify(after)}`);
for (const [path, value] of after) {
  const prior = before.find(([p]) => p === path);
  if (prior) console.log(`  DELTA ${path}: ${prior[1]} -> ${value}  (+${value - prior[1]})`);
}
console.log(`\n  requests made to the provider by this probe: ${sgoRequests}`);
console.log('  (usage reads are free; the bill is one entity per EVENT returned)');
