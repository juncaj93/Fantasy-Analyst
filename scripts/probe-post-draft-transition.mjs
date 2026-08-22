/**
 * Post-draft transition integrity: what the deployed app believes, beside what
 * Sleeper actually says.
 *
 * The development sandbox cannot reach the Worker — its egress policy refuses
 * the host — so a comparison between "the app's answer" and "Sleeper's answer"
 * cannot be made there at all. This runs on a runner that can reach both, and
 * prints the two side by side so a disagreement is visible rather than inferred.
 *
 * **Read-only in the strongest sense.** Every request is a GET that the public
 * site already answers to anyone, plus public Sleeper reads. Nothing here logs
 * in, nothing posts, nothing touches D1. It prints no address, no token and no
 * cookie; the only identifiers it prints are league, draft, roster and player
 * ids, which are public to anyone who can open the league in Sleeper.
 *
 *   node scripts/probe-post-draft-transition.mjs
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER = 'https://api.sleeper.app/v1';

const started = new Date().toISOString();

async function getJson(url, label) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: `not JSON: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, status: 0, error: `${label}: ${String(err).slice(0, 200)}` };
  }
}

function head(title) {
  console.log(`\n=== ${title} ===`);
}

function show(label, value) {
  console.log(`  ${String(label).padEnd(28)} ${value}`);
}

const main = async () => {
  console.log(`probe started ${started}`);
  console.log(`app: ${APP}`);

  // ---------------------------------------------------------- what the app says
  head('APP /api/overview');
  const overview = await getJson(`${APP}/api/overview`, 'overview');
  if (!overview.ok) {
    console.log(`  unreachable (${overview.status}): ${overview.error}`);
    return;
  }
  const ov = overview.body;
  show('selected league', ov.selectedLeague ? `${ov.selectedLeague.name} (${ov.selectedLeague.id}) season ${ov.selectedLeague.season}` : '(none)');
  show('season.phase', ov.season?.phase);
  show('season.draftVisible', ov.season?.draftVisible);
  show('season.reason', ov.season?.reason);
  show('season.assumed', ov.season?.assumed);
  show('lifecycle.lifecycle', ov.lifecycle?.lifecycle);
  show('lifecycle.draftVisible', ov.lifecycle?.draftVisible);
  show('lifecycle.matchupVisible', ov.lifecycle?.matchupVisible);
  show('lifecycle.draftLive', ov.lifecycle?.draftLive);
  show('lifecycle.reason', ov.lifecycle?.reason);
  const tabs = ['team', 'trades', 'players', 'review', 'setup'];
  if (ov.season?.draftVisible) tabs.unshift('draft');
  else tabs.splice(1, 0, 'waivers');
  if (ov.lifecycle?.matchupVisible) tabs.splice(ov.season?.draftVisible ? 2 : 1, 0, 'matchup');
  show('=> tab bar would show', tabs.join(', '));

  head('APP /api/setup/status');
  const setup = await getJson(`${APP}/api/setup/status`, 'setup');
  if (!setup.ok) {
    console.log(`  unreachable (${setup.status}): ${setup.error}`);
    return;
  }
  const st = setup.body;
  show('sleeper connected', st.sleeper?.connected);
  show('sleeper username', st.sleeper?.username ?? '(none)');
  show('players synced', st.sleeper?.playersSynced);
  show('league id', st.league?.id ?? '(none)');
  show('league name', st.league?.name ?? '(none)');
  show('league season', st.league?.season ?? '(none)');
  show('league teams', st.league?.teams);
  show('draft id', st.league?.draftId ?? '(none)');
  show('rosterFound (isMine)', st.league?.rosterFound);
  show('vegas provider', st.vegas?.provider);
  show('vegas live', st.vegas?.live);
  show('vegas events', st.vegas?.events);
  show('vegas lastRefreshedAt', st.vegas?.lastRefreshedAt ?? '(never)');
  show('vegas season quotes', st.vegas?.season?.quotes);
  show('vegas season fetchedAt', st.vegas?.season?.fetchedAt ?? '(never)');
  show('vegas season stale', st.vegas?.season?.stale);
  show('vegas season reason', st.vegas?.season?.reason ?? '');

  const leagueId = st.league?.id;
  const draftId = st.league?.draftId;
  const username = st.sleeper?.username;
  if (!leagueId) {
    console.log('\nNo selected league — nothing further to compare.');
    return;
  }

  // ------------------------------------------------------------- app: the Team
  head(`APP /api/leagues/${leagueId}/roster  (the Team screen)`);
  const roster = await getJson(`${APP}/api/leagues/${leagueId}/roster`, 'roster');
  if (!roster.ok) {
    console.log(`  failed (${roster.status}): ${roster.error}`);
  } else {
    const r = roster.body;
    show('found (my roster)', r.found);
    show('live (draft mode)', r.live);
    show('starters', (r.starters ?? []).length);
    show('bench', (r.bench ?? []).length);
    show('drafted', (r.drafted ?? []).length);
    show('picksMade', r.picksMade);
    show('filled / remaining', `${r.filled} / ${r.remaining}`);
    show('counts', JSON.stringify(r.counts ?? {}));
    const sample = (r.drafted ?? []).slice(0, 5).map((p) => `${p.draftPick ?? '-'} ${p.position} ${p.name}`);
    show('drafted sample', sample.length ? sample.join(' | ') : '(empty)');
  }

  // ---------------------------------------------------------- app: the Matchup
  head(`APP /api/leagues/${leagueId}/matchup  (the Matchup screen)`);
  const matchup = await getJson(`${APP}/api/leagues/${leagueId}/matchup`, 'matchup');
  if (!matchup.ok) {
    console.log(`  failed (${matchup.status}): ${matchup.error}`);
  } else {
    const m = matchup.body;
    show('week', m.week);
    show('season', m.season);
    show('found', m.found);
    show('reason', m.reason ?? '(none)');
    show('cached', m.cached);
    const f = m.forecast;
    if (!f) {
      show('forecast', '(null)');
    } else {
      show('forecast.phase', f.phase);
      show('mine roster/name', `${f.teams?.mine?.rosterId} / ${f.teams?.mine?.name}`);
      show('theirs roster/name', `${f.teams?.theirs?.rosterId} / ${f.teams?.theirs?.name}`);
      show('mine projectedFinal', f.teams?.mine?.projectedFinal);
      show('theirs projectedFinal', f.teams?.theirs?.projectedFinal);
      show('mine winProbability', f.teams?.mine?.winProbability);
      show('freshness', JSON.stringify(f.freshness ?? {}));
      const slots = f.slots ?? [];
      const withProj = slots.filter((s) => s.mine?.projection != null).length;
      show('slots', `${slots.length}, of which ${withProj} carry a projection for my side`);
      for (const s of slots.slice(0, 6)) {
        console.log(
          `    ${String(s.slot ?? s.key ?? '?').padEnd(10)} mine=${s.mine?.name ?? '-'} proj=${s.mine?.projection ?? 'null'}` +
            `  theirs=${s.theirs?.name ?? '-'} proj=${s.theirs?.projection ?? 'null'}`,
        );
      }
    }
    show('cards', Object.keys(m.cards ?? {}).length);
  }

  // ------------------------------------------------------------ Sleeper truth
  head('SLEEPER /state/nfl');
  const state = await getJson(`${SLEEPER}/state/nfl`, 'state');
  if (state.ok) {
    const s = state.body;
    show('season', s.season);
    show('season_type', s.season_type);
    show('week', s.week);
    show('leg', s.leg);
    show('display_week', s.display_week);
  } else {
    console.log(`  failed (${state.status}): ${state.error}`);
  }

  head(`SLEEPER /league/${leagueId}`);
  const sleeperLeague = await getJson(`${SLEEPER}/league/${leagueId}`, 'league');
  let sleeperSeason = null;
  if (sleeperLeague.ok && sleeperLeague.body) {
    const l = sleeperLeague.body;
    sleeperSeason = l.season;
    show('name', l.name);
    show('season', l.season);
    show('status', l.status);
    show('total_rosters', l.total_rosters);
    show('draft_id', l.draft_id);
    show('settings.best_ball', l.settings?.best_ball);
    show('settings.league_average_match', l.settings?.league_average_match);
    show('settings.playoff_week_start', l.settings?.playoff_week_start);
    show('roster_positions', (l.roster_positions ?? []).join(','));
  } else {
    console.log(`  failed (${sleeperLeague.status}): ${sleeperLeague.error}`);
  }

  head(`SLEEPER /draft/${draftId ?? '(none)'}`);
  if (draftId) {
    const draft = await getJson(`${SLEEPER}/draft/${draftId}`, 'draft');
    if (draft.ok && draft.body) {
      const d = draft.body;
      show('status', d.status);
      show('type', d.type);
      show('season', d.season);
      show('start_time', d.start_time ? new Date(d.start_time).toISOString() : '(none)');
      show('last_picked', d.last_picked ? new Date(d.last_picked).toISOString() : '(none)');
      show('settings.rounds', d.settings?.rounds);
      show('settings.teams', d.settings?.teams);
      show('slot_to_roster_id', JSON.stringify(d.slot_to_roster_id ?? {}));
      show('metadata.best_ball', d.metadata?.best_ball ?? d.settings?.best_ball);
    } else {
      console.log(`  failed (${draft.status}): ${draft.error}`);
    }
  } else {
    console.log('  (no draft id on the selected league)');
  }

  // Who am I, per Sleeper?
  head(`SLEEPER /user/${username ?? '(none)'}`);
  let myUserId = null;
  if (username) {
    const user = await getJson(`${SLEEPER}/user/${encodeURIComponent(username)}`, 'user');
    if (user.ok && user.body) {
      myUserId = user.body.user_id;
      show('user_id', myUserId);
      show('username', user.body.username);
      show('display_name', user.body.display_name);
    } else {
      console.log(`  failed (${user.status}): ${user.error}`);
    }
  }

  head(`SLEEPER /league/${leagueId}/rosters`);
  const rosters = await getJson(`${SLEEPER}/league/${leagueId}/rosters`, 'rosters');
  let myRosterId = null;
  let myPlayers = [];
  if (rosters.ok && Array.isArray(rosters.body)) {
    show('rosters', rosters.body.length);
    for (const r of rosters.body) {
      const mine = myUserId && r.owner_id === myUserId;
      if (mine) {
        myRosterId = r.roster_id;
        myPlayers = r.players ?? [];
      }
      console.log(
        `    roster ${String(r.roster_id).padStart(2)}  owner=${r.owner_id ?? '(none)'}` +
          `  players=${(r.players ?? []).length}  starters=${(r.starters ?? []).filter((p) => p && p !== '0').length}` +
          `${mine ? '   <== MINE' : ''}`,
      );
    }
    const totalPlayers = rosters.body.reduce((n, r) => n + (r.players ?? []).length, 0);
    show('players across all rosters', totalPlayers);
    show('my roster_id', myRosterId ?? '(not matched)');
    show('my player count', myPlayers.length);
  } else {
    console.log(`  failed (${rosters.status}): ${rosters.error}`);
  }

  head(`SLEEPER /draft/${draftId ?? '(none)'}/picks`);
  if (draftId) {
    const picks = await getJson(`${SLEEPER}/draft/${draftId}/picks`, 'picks');
    if (picks.ok && Array.isArray(picks.body)) {
      show('picks', picks.body.length);
      const mine = picks.body.filter(
        (p) => (myRosterId != null && Number(p.roster_id) === myRosterId) || (myUserId && p.picked_by === myUserId),
      );
      show('picks that are mine', mine.length);
      show('sample of mine', mine.slice(0, 5).map((p) => `#${p.pick_no} ${p.metadata?.position ?? ''} ${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim()).join(' | ') || '(none)');
      const nullRoster = picks.body.filter((p) => p.roster_id == null).length;
      const nullPickedBy = picks.body.filter((p) => !p.picked_by).length;
      show('picks with null roster_id', nullRoster);
      show('picks with empty picked_by', nullPickedBy);
    } else {
      console.log(`  failed (${picks.status}): ${picks.error}`);
    }
  }

  // The matchup Sleeper itself publishes, at the week the app resolved.
  const week = matchup.ok ? matchup.body.week : 1;
  head(`SLEEPER /league/${leagueId}/matchups/${week}`);
  const sleeperMatchups = await getJson(`${SLEEPER}/league/${leagueId}/matchups/${week}`, 'matchups');
  if (sleeperMatchups.ok && Array.isArray(sleeperMatchups.body)) {
    show('rows', sleeperMatchups.body.length);
    for (const m of sleeperMatchups.body) {
      const mine = myRosterId != null && m.roster_id === myRosterId;
      console.log(
        `    roster ${String(m.roster_id).padStart(2)}  matchup_id=${m.matchup_id ?? 'null'}` +
          `  players=${(m.players ?? []).length}  starters=${(m.starters ?? []).filter((p) => p && p !== '0').length}` +
          `  points=${m.points ?? 0}${mine ? '   <== MINE' : ''}`,
      );
    }
    // Does Sleeper's public matchup payload carry a projection at all?
    const first = sleeperMatchups.body[0];
    if (first) {
      show('keys on a matchup row', Object.keys(first).join(', '));
      show('players_points present', first.players_points != null);
      show('any "projection" key', Object.keys(first).some((k) => /proj/i.test(k)));
    }
  } else {
    console.log(`  failed (${sleeperMatchups.status}): ${sleeperMatchups.error}`);
  }

  // Weeks 1..4, so "the app picked the wrong week" is distinguishable from
  // "Sleeper has not published a schedule" — and so a wrong week is visible as a
  // wrong *opponent* rather than as an argument about an integer.
  head('SLEEPER matchup availability and my opponent, weeks 1-4');
  const users = await getJson(`${SLEEPER}/league/${leagueId}/users`, 'users');
  const nameByUser = new Map(
    users.ok && Array.isArray(users.body) ? users.body.map((u) => [u.user_id, u.display_name ?? u.username]) : [],
  );
  const ownerByRoster = new Map(
    rosters.ok && Array.isArray(rosters.body) ? rosters.body.map((r) => [r.roster_id, nameByUser.get(r.owner_id) ?? '?']) : [],
  );
  for (const w of [1, 2, 3, 4]) {
    const r = await getJson(`${SLEEPER}/league/${leagueId}/matchups/${w}`, `matchups ${w}`);
    const rows = r.ok && Array.isArray(r.body) ? r.body : [];
    const paired = rows.filter((m) => m.matchup_id != null).length;
    const mineRow = myRosterId == null ? null : rows.find((m) => m.roster_id === myRosterId);
    const theirs = mineRow?.matchup_id == null
      ? null
      : rows.find((m) => m.matchup_id === mineRow.matchup_id && m.roster_id !== myRosterId);
    console.log(
      `    week ${w}: ${rows.length} row(s), ${paired} paired` +
        `  | my opponent: roster ${theirs?.roster_id ?? '-'} (${theirs ? (ownerByRoster.get(theirs.roster_id) ?? '?') : 'none'})`,
    );
  }

  // The app, asked for week 1 by name. If week 1 answers with a *different*
  // opponent from the week the app chose on its own, the week it chose is wrong.
  head(`APP /api/leagues/${leagueId}/matchup?week=1`);
  const week1 = await getJson(`${APP}/api/leagues/${leagueId}/matchup?week=1`, 'matchup w1');
  if (week1.ok) {
    const m = week1.body;
    show('week', m.week);
    show('found', m.found);
    show('mine', m.forecast?.teams?.mine?.name ?? '(none)');
    show('theirs', m.forecast?.teams?.theirs?.name ?? '(none)');
    show('mine projectedFinal', m.forecast?.teams?.mine?.projectedFinal ?? 'null');
    show('freshness', JSON.stringify(m.forecast?.freshness ?? {}));
  } else {
    console.log(`  failed (${week1.status}): ${week1.error}`);
  }

  // ------------------------------------------------------------ the comparison
  head('COMPARISON');
  const appDraftStatus = ov.lifecycle?.lifecycle;
  show('app lifecycle', appDraftStatus);
  show('app says my roster found', st.league?.rosterFound);
  show('app Team drafted count', roster.ok ? (roster.body.drafted ?? []).length : '(unknown)');
  show('Sleeper my roster players', myPlayers.length);
  show('app Matchup found', matchup.ok ? matchup.body.found : '(unknown)');
  show('app Matchup projections', matchup.ok && matchup.body.forecast
    ? `${(matchup.body.forecast.slots ?? []).filter((s) => s.mine?.projection != null).length} of ${(matchup.body.forecast.slots ?? []).length}`
    : '(no forecast)');
  show('league season (app/sleeper)', `${st.league?.season} / ${sleeperSeason}`);
  console.log(`\nprobe finished ${new Date().toISOString()}`);
};

await main();
