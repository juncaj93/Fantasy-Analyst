/**
 * Why are defenses not showing up?
 *
 * There are four places a DEF can be lost between Sleeper and the draft board,
 * and they fail identically from the outside — an empty list. This asks the
 * live app which one it is, in the order the data actually flows:
 *
 *   1. are defenses in the player dictionary at all?
 *   2. does the league start one, and under what slot name?
 *   3. does the imported ADP snapshot rank them?
 *   4. does the board return them?
 *
 * The interesting failure is (2) vs (3). `startablePositions` compares the
 * league's raw slot names against a player's canonical position, so a league
 * whose slot reads `D/ST` would filter out every player whose position reads
 * `DEF`. And the pool keeps only ranked players once anything is ranked, so a
 * defense absent from the ADP file disappears even when everything else is
 * right.
 *
 * Reads only, public endpoints, no passphrase.
 */

const URL = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

async function get(path) {
  const res = await fetch(`${URL}${path}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

console.log('=== 1. the player dictionary ===');
for (const position of ['DEF', 'K', 'QB']) {
  const body = await get(`/api/players?position=${position}&limit=60`);
  if (body.error) {
    console.log(`  ${position}: ${body.error}`);
    continue;
  }
  const players = body.players ?? [];
  const ranked = players.filter((p) => p.draftRank != null);
  console.log(
    `  ${position}: ${players.length} returned, ${ranked.length} with a draft rank` +
      (players[0] ? ` — e.g. ${players[0].name} (${players[0].team || 'FA'}), rank ${players[0].draftRank ?? 'none'}` : ''),
  );
}

console.log('\n=== 2. what the league starts ===');
const leagues = await get('/api/leagues');
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0];
if (!league) {
  console.log('  no league found');
} else {
  console.log(`  ${league.name} (${league.teams} teams)`);
  console.log('  roster_positions:', JSON.stringify(league.rosterPositions));
  const slots = [...new Set(league.rosterPositions ?? [])];
  // The comparison the board actually makes.
  console.log('  distinct slots:', slots.join(', '));
  console.log('  starts a DEF slot spelled exactly "DEF"? ', slots.includes('DEF'));
  console.log('  starts a K slot spelled exactly "K"?     ', slots.includes('K'));
  const oddSpellings = slots.filter((s) => /^(D\/ST|DST|DEFENSE|PK)$/i.test(String(s)));
  if (oddSpellings.length) {
    console.log('  !! slots that will NOT match a canonical position:', oddSpellings.join(', '));
  }
}

console.log('\n=== 3. the ADP snapshot ===');
const overview = await get('/api/overview');
console.log('  snapshot:', overview.adpSnapshot ? `${overview.adpSnapshot.label} (${overview.adpSnapshot.matchedCount} matched)` : 'none');

console.log('\n=== 4. what the board returns ===');
if (league?.draftId) {
  for (const position of ['DEF', 'K', 'QB']) {
    const board = await get(`/api/drafts/${league.draftId}/board?position=${position}&limit=10`);
    if (board.error) {
      console.log(`  ${position}: ${board.error}`);
      continue;
    }
    const recs = board.recommendations ?? [];
    console.log(`  ${position}: ${recs.length} recommendation(s)` + (recs[0] ? ` — top: ${recs[0].name}` : ''));
    for (const w of board.warnings ?? []) console.log(`      warning: ${w}`);
  }
} else {
  console.log('  no draft attached to the league');
}
