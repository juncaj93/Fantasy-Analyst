/**
 * Round 23 (Vegas build): what per-book lines does SportsGameOdds send today,
 * and why does Ladd McConkey show "No line yet"?
 *
 * Costs ONE entity (one game) of the 2,500 a month: the Chargers' next game,
 * asked for by team. Falls back to the next NFL game when the Chargers have
 * none in the next eight days (still one entity). The account-usage read is
 * free and is printed before and after.
 *
 * D1: SELECTs only, a few hundred rows (McConkey's stored lines for the
 * current slate). Prints field names and numbers, never the key.
 */

const KEY = process.env.SPORTSGAMEODDS_API_KEY ?? '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.ACCOUNT_ID;
const BASE = 'https://api.sportsgameodds.com/v2';
const TARGET = { team: 'LOS_ANGELES_CHARGERS_NFL', player: /MCCONKEY/i };
let probeRows = 0;

const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const et = (iso) =>
  iso
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso))
    : '-';

async function sgo(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': KEY, accept: 'application/json' } });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 200) };
  }
}

let dbUuid = null;
async function sql(text) {
  if (!/^\s*select\b/i.test(text)) throw new Error('read-only: SELECT only');
  const cf = async (path, init = {}) =>
    (
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      })
    ).json();
  dbUuid ??= ((await cf('/d1/database?name=fantasy_analyst')).result ?? []).find((d) => d.name === 'fantasy_analyst')?.uuid;
  if (!dbUuid) throw new Error('no D1 database called fantasy_analyst');
  const body = await cf(`/d1/database/${dbUuid}/query`, { method: 'POST', body: JSON.stringify({ sql: text, params: [] }) });
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 300)}`);
  probeRows += Number(body.result?.[0]?.meta?.rows_read ?? 0);
  return body.result?.[0]?.results ?? [];
}

console.log(`Round 23 books probe, ${et(new Date().toISOString())} ET`);

// ------------------------------------------------------------ 1. stored ---
if (TOKEN && ACCOUNT) {
  heading('1. What the app has stored for McConkey (current slate)');
  const who = await sql(`SELECT id, full_name, team, position FROM players WHERE full_name LIKE '%McConkey%'`);
  console.log(JSON.stringify(who));
  for (const p of who) {
    const rows = await sql(`
      SELECT ps.event_id, ps.game_start, ps.fetched_at, pp.market, pp.line, pp.book_count, pp.books_json, pp.consensus_method
        FROM player_props pp JOIN prop_snapshots ps ON ps.id = pp.snapshot_id
       WHERE pp.player_id = '${String(p.id).replace(/'/g, '')}' AND ps.scope = 'week'
         AND ps.game_start >= datetime('now', '-1 day')
       ORDER BY ps.fetched_at DESC LIMIT 40`);
    console.log(`${p.full_name}: ${rows.length} stored line(s) for games from yesterday on`);
    for (const r of rows) console.log(`  ${et(r.fetched_at)} ${r.market} ${r.line} books=${r.book_count} ${r.books_json}`);
    const events = await sql(`
      SELECT event_id, kickoff, home_team, away_team, game_total, spread, spread_team, lines_seen_at
        FROM vegas_events WHERE (home_team = 'LAC' OR away_team = 'LAC') AND kickoff >= datetime('now', '-1 day')`);
    console.log('LAC events stored:', JSON.stringify(events));
    for (const e of events) {
      const snaps = await sql(`
        SELECT ps.id, ps.fetched_at, (SELECT COUNT(*) FROM player_props pp WHERE pp.snapshot_id = ps.id) AS lines
          FROM prop_snapshots ps WHERE ps.event_id = '${String(e.event_id).replace(/'/g, '')}' AND ps.scope = 'week'
         ORDER BY ps.fetched_at DESC LIMIT 12`);
      console.log(`  looks at ${e.event_id}:`, snaps.map((s) => `${et(s.fetched_at)} (${s.lines} lines)`).join(' | '));
    }
  }
  console.log(`D1 rows read: ${probeRows}`);
} else {
  console.log('No Cloudflare token: stored lines not read.');
}

// -------------------------------------------------------------- 2. live ---
if (!KEY) {
  console.log('\nSPORTSGAMEODDS_API_KEY is not set for this run: no provider call.');
  process.exit(0);
}
heading('2. One live game (1 entity)');
const usage = async () => {
  const u = await sgo('/account/usage');
  const m = u.json?.data?.rateLimits?.['per-month'];
  return m ? `${m['current-entities']} of ${m['max-entities']}` : `status ${u.status}`;
};
console.log('provider count before:', await usage());

const from = new Date().toISOString().slice(0, 10);
const to = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
let answer = await sgo(`/events?leagueID=NFL&type=match&teamID=${TARGET.team}&startsAfter=${from}&startsBefore=${to}&oddsAvailable=true&limit=1`);
let event = answer.json?.data?.[0] ?? null;
if (!event) {
  console.log(`no Chargers game in the next 8 days (status ${answer.status}); asking for the next NFL game instead`);
  answer = await sgo(`/events?leagueID=NFL&type=match&startsAfter=${from}&oddsAvailable=true&limit=1`);
  event = answer.json?.data?.[0] ?? null;
}
console.log('provider count after:', await usage());
if (!event) {
  console.log('no event came back', answer.status, answer.text ?? '');
  process.exit(0);
}
const teams = Object.values(event.teams ?? {}).map((t) => t.teamID).join(' vs ');
console.log(`event ${event.eventID}: ${teams}, kickoff ${et(event.status?.startsAt)}`);

const odds = Object.values(event.odds ?? {});
console.log(`odds objects: ${odds.length}`);

// The shape of one bookmaker entry: field names and one value each.
const withBooks = odds.find((o) => Object.keys(o.byBookmaker ?? {}).length > 0);
if (withBooks) {
  const [bookId, entry] = Object.entries(withBooks.byBookmaker)[0];
  console.log(`\none byBookmaker entry (${withBooks.oddID}, book ${bookId}):`);
  for (const [k, v] of Object.entries(entry ?? {})) {
    console.log(`  ${k}: ${typeof v === 'string' && v.length > 60 ? '(long string)' : JSON.stringify(v)}`);
  }
} else {
  console.log('NO byBookmaker entries on any odd (consensus only)');
}

// Books across the markets the app reads.
const KEEP = new Set(['passing_yards', 'passing_touchdowns', 'rushing_yards', 'receiving_receptions', 'receptions', 'receiving_yards', 'touchdowns']);
const GAME = new Set(['all', 'side1', 'side2', 'home', 'away']);
const bookTally = new Map();
const countDist = new Map();
let quotes = 0;
let noConsensusWithBooks = 0;
for (const o of odds) {
  if (o.periodID !== 'game' || o.betTypeID !== 'ou' || o.sideID !== 'over' || !KEEP.has(o.statID)) continue;
  const entity = o.playerID ?? o.statEntityID ?? '';
  if (!entity || GAME.has(entity)) continue;
  quotes++;
  const books = Object.entries(o.byBookmaker ?? {}).filter(([, b]) => b?.available !== false);
  countDist.set(books.length, (countDist.get(books.length) ?? 0) + 1);
  for (const [id] of books) bookTally.set(id, (bookTally.get(id) ?? 0) + 1);
  if ((o.bookOverUnder == null || o.bookOverUnder === '') && books.length > 0) noConsensusWithBooks++;
}
console.log(`\nplayer over/under quotes the app reads: ${quotes}`);
console.log('available books per quote:', [...countDist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n} books: ${c}`).join(', '));
console.log('quotes per book:', [...bookTally.entries()].sort((a, b) => b[1] - a[1]).map(([b, c]) => `${b} ${c}`).join(', '));
console.log(`quotes with no consensus line but at least one book: ${noConsensusWithBooks}`);

// Game total and spread, per book.
heading('3. Game total and spread, per book');
for (const o of odds) {
  if (o.periodID !== 'game' || o.statID !== 'points' || o.playerID) continue;
  if (!((o.betTypeID === 'ou' && o.sideID === 'over' && o.statEntityID === 'all') || (o.betTypeID === 'sp' && (o.sideID === 'home' || o.sideID === 'away')))) continue;
  const books = Object.entries(o.byBookmaker ?? {})
    .map(([id, b]) => `${id}=${b?.overUnder ?? b?.spread ?? '?'}${b?.available === false ? '(off)' : ''}@${b?.lastUpdatedAt ? et(b.lastUpdatedAt) : '?'}`)
    .join(' ');
  console.log(`${o.oddID}: consensus ${o.bookOverUnder ?? o.bookSpread} | ${books || '(no books)'}`);
}

// The McConkey case.
heading('4. McConkey on this game');
const mine = odds.filter((o) => TARGET.player.test(String(o.playerID ?? o.statEntityID ?? '')));
if (mine.length === 0) console.log('no odds for McConkey on this event');
for (const o of mine) {
  if (o.periodID !== 'game') continue;
  const books = Object.entries(o.byBookmaker ?? {})
    .map(([id, b]) => `${id}=${b?.overUnder ?? '-'}/${b?.odds ?? '-'}${b?.available === false ? '(off)' : ''}`)
    .join(' ');
  console.log(`${o.oddID}: bookOverUnder=${o.bookOverUnder ?? '-'} fair=${o.fairOverUnder ?? '-'} bookOdds=${o.bookOdds ?? '-'} | ${books || '(no books)'}`);
}
