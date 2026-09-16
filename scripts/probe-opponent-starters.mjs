/**
 * Where did the opponent's lineup go?
 *
 * Alex, 16 September 2026: Sleeper's own app shows a complete week 2 lineup for
 * this exact matchup, and the Matchup screen says "your opponent has not set a
 * lineup for this week yet". The app's own forecast has all sixteen of his
 * players, priced — C. Williams 20.1, J. Taylor 19.1, M. Evans 11.6 — and every
 * one of them flagged bench, `slot=null starting=false`.
 *
 * So the roster arrives and the *starters* do not. `toPlayers` reads
 * `row.starters`, skips any entry that is falsy or the literal `"0"`, and puts
 * everybody else on the bench. Sixteen players and no starters is exactly what
 * that produces when `starters` is empty, null, or all zeroes.
 *
 * This asks Sleeper directly rather than asking the app what it made of
 * Sleeper, because the whole question is which of the two is wrong. Public
 * endpoint, no key, read-only.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app/v1';

const j = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return { __status: res.status };
  return res.json();
};

const leagues = await j(`${APP}/api/leagues`);
const league = (leagues.leagues ?? []).find((l) => l.isSelected) ?? (leagues.leagues ?? [])[0];
if (!league) {
  console.log('no league:', JSON.stringify(leagues).slice(0, 300));
  process.exit(0);
}
console.log(`league: ${league.name} (${league.id})`);

/*
 * The Sleeper id, which the public league list may or may not carry. Falling
 * back to the setup status rather than guessing — an id typed from memory is
 * how a probe ends up confidently describing somebody else's league.
 */
let sleeperId = league.sleeperLeagueId ?? null;
if (!sleeperId) {
  const status = await j(`${APP}/api/setup/status`);
  sleeperId = status?.league?.sleeperLeagueId ?? status?.league?.id ?? null;
}
if (!sleeperId) {
  console.log('could not resolve the Sleeper league id; keys were:', Object.keys(league).join(', '));
  process.exit(0);
}
console.log(`sleeper league: ${sleeperId}`);

const state = await j(`${SLEEPER}/state/nfl`);
console.log(`sleeper state : season=${state.season} type=${state.season_type} week=${state.week} display=${state.display_week}`);

const rosters = await j(`${SLEEPER}/league/${sleeperId}/rosters`);
const byRoster = new Map((Array.isArray(rosters) ? rosters : []).map((r) => [r.roster_id, r]));

for (const week of [state.week, state.display_week].filter((w, i, a) => w && a.indexOf(w) === i)) {
  console.log(`\n=== /league/${sleeperId}/matchups/${week} ===`);
  const rows = await j(`${SLEEPER}/league/${sleeperId}/matchups/${week}`);
  if (!Array.isArray(rows)) {
    console.log(`  not an array: ${JSON.stringify(rows).slice(0, 200)}`);
    continue;
  }
  console.log(`  rows: ${rows.length}`);
  for (const r of rows) {
    const starters = r.starters ?? null;
    const zeros = Array.isArray(starters) ? starters.filter((s) => !s || s === '0').length : 0;
    const roster = byRoster.get(r.roster_id);
    console.log(
      `  roster=${String(r.roster_id).padEnd(3)} matchup=${String(r.matchup_id ?? 'null').padEnd(5)}` +
        ` players=${(r.players ?? []).length} starters=${starters == null ? 'NULL' : starters.length}` +
        ` zeros=${zeros} points=${r.points ?? 0}` +
        `  owner=${roster?.owner_id ?? '?'}`,
    );
    if (Array.isArray(starters) && starters.length > 0) {
      console.log(`      starters: ${JSON.stringify(starters)}`);
    }
    /*
     * The roster's own `starters`, which is a different field on a different
     * endpoint and is the lineup as it stands *now* rather than as it was
     * locked for a week. If the matchup row is empty and this one is not, that
     * is the answer: the app is reading the week-locked lineup for a week that
     * has not locked.
     */
    if (roster) {
      console.log(`      roster.starters: ${JSON.stringify(roster.starters ?? null)}`);
    }
  }
}

console.log('\ndone. nothing was written.');
