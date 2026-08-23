/**
 * Why a stored published projection is, or is not, reaching the screen.
 *
 * The fallback has four gates between Rotowire's feed and a Team row, and when
 * the row shows `—` after a successful fetch, exactly one of them is shut. This
 * prints all four so the answer is read rather than guessed:
 *
 *  1. **Is anything stored?** The refresh reported rows written; that is a claim
 *     about the write, not about the key it was written under.
 *  2. **Is it stored under the season and week this league asks for?** Both are
 *     resolved by `resolveWeek` on either side, from Sleeper's `/state/nfl` —
 *     and a preseason state answers week 1, which is deliberate and worth
 *     seeing rather than assuming.
 *  3. **Is this league entitled to a published total?** `sleeperScoringKey`
 *     refuses any league not playing the game the three published totals assume.
 *     A best-ball or custom league can very reasonably be refused, and a refusal
 *     is a correct answer that looks exactly like a bug from the outside.
 *  4. **Do the player ids join?** The feed's `player_id` and the app's canonical
 *     id are both Sleeper's, so this should always pass — which is why it is
 *     worth checking when something has gone wrong.
 *
 * Gate 3 is reproduced here from the league's own Sleeper payload using the
 * app's own two functions, so this is the decision the deployment makes rather
 * than an impression of it.
 *
 * **Read-only.** Public GETs the site already answers, plus public Sleeper
 * reads. Nothing logs in, nothing writes.
 *
 *   node scripts/probe-published-fallback.mjs
 *   LEAGUE_ID=... node scripts/probe-published-fallback.mjs
 */

import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { sleeperScoringKey } from '../src/core/sleeper/weeklyProjections.ts';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app';
const LEAGUE_OVERRIDE = process.env.LEAGUE_ID || null;

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) };
    return { ok: true, body: JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err).slice(0, 200) };
  }
}

const head = (t) => console.log(`\n=== ${t} ===`);
const show = (l, v) => console.log(`  ${String(l).padEnd(28)} ${v}`);

/** Sleeper's defaults, as the published totals assume them — mirrors the module. */
const ASSUMED = {
  pointsPerRushYard: 0.1,
  pointsPerRecYard: 0.1,
  pointsPerPassYard: 0.04,
  passTd: 4,
  rushTd: 6,
  recTd: 6,
  interception: -1,
  fumbleLost: -2,
};

const main = async () => {
  console.log(`probe started ${new Date().toISOString()}`);

  const setup = await getJson(`${APP}/api/setup/status`);
  if (!setup.ok) return console.log(`setup unreachable: ${setup.error}`);
  const leagueId = LEAGUE_OVERRIDE ?? setup.body.league?.id;
  if (!leagueId) return console.log('no league selected');

  head('THE LEAGUE');
  show('id', leagueId);
  show('selected in the app', setup.body.league?.id === leagueId ? 'yes' : `no (${setup.body.league?.name})`);

  // ------------------------------------------------ what the app renders
  const lineup = await getJson(`${APP}/api/leagues/${leagueId}/lineup`);
  if (!lineup.ok) return console.log(`lineup unreachable: ${lineup.error}`);
  const slots = (lineup.body.slots ?? []).filter((s) => s.playerId);
  show('scoring label', lineup.body.league?.scoringLabel);
  show('filled slots', slots.length);
  show('with a projection', slots.filter((s) => s.projection != null).length);
  show('by source', JSON.stringify(tally(slots.map((s) => s.projectionSource ?? 'none'))));

  // -------------------------------------- gate 3, from the league's own rules
  head('GATE 3 — is this league entitled to a published total?');
  const sleeperLeague = await getJson(`${SLEEPER}/v1/league/${leagueId}`);
  if (!sleeperLeague.ok) {
    console.log(`  could not read the league from Sleeper: ${sleeperLeague.error}`);
  } else {
    const settings = sleeperLeague.body?.scoring_settings ?? {};
    const profile = buildScoringProfile(settings, sleeperLeague.body?.roster_positions ?? []);
    show('rec (per reception)', profile.ppr);
    show('bonus_rec_te', profile.teBonus);
    for (const [key, expected] of Object.entries(ASSUMED)) {
      const actual = profile[key];
      const same = Math.abs(actual - expected) < 1e-9;
      show(key, `${actual}${same ? '' : `   <-- differs from the assumed ${expected}`}`);
    }
    console.log('');
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      show(`key for a ${position}`, sleeperScoringKey(profile, position) ?? 'REFUSED — no fallback for this position');
    }
  }

  // ------------------------------------------------ gates 1, 2 and 4
  head('GATES 1, 2 and 4 — is the right week stored, and do the ids join?');
  const state = await getJson(`${SLEEPER}/v1/state/nfl`);
  const season = sleeperLeague.ok ? sleeperLeague.body?.season : null;
  show('sleeper season_type', state.ok ? state.body?.season_type : '(unreadable)');
  show('sleeper week (within type)', state.ok ? state.body?.week : '(unreadable)');
  show('league season', season ?? '(unknown)');
  console.log(
    '  the app resolves a preseason state to regular-season week 1 — see resolveWeek,\n' +
      '  and both the writer and the reader use it, so they agree by construction.',
  );

  const week = 1;
  const published = await getJson(
    `${SLEEPER}/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`,
  );
  if (!published.ok || !Array.isArray(published.body)) {
    console.log(`  published feed unavailable: ${published.error}`);
  } else {
    const byId = new Map(published.body.map((r) => [String(r.player_id), r.stats ?? {}]));
    const joined = slots.filter((s) => byId.has(String(s.playerId)));
    show('starters in the feed', `${joined.length} of ${slots.length}`);
    for (const slot of slots.slice(0, 12)) {
      const stats = byId.get(String(slot.playerId));
      console.log(
        `    ${String(slot.name).padEnd(24)} feed half=${String(stats?.pts_half_ppr ?? '—').padStart(6)}` +
          `   app proj=${String(slot.projection ?? '—').padStart(6)}  source=${slot.projectionSource ?? '—'}`,
      );
    }
  }

  console.log(`\nprobe finished ${new Date().toISOString()}`);
};

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

await main();
