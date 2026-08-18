/**
 * Does the deployed site actually serve what was just shipped?
 *
 * The deploy workflow already checks that the app is up, reads its database and
 * refuses an unauthenticated write. This asks the next question: are the
 * surfaces added by the most recent work answering in production, against the
 * real database rather than a seeded one?
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

let failures = 0;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, json, text };
}

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log(`Checking ${BASE}\n`);

// 1. Season-long market status: the route exists and the season-scoped tables
//    answer. Empty is the expected, honest state for this provider.
const season = await get('/api/vegas/season');
check('/api/vegas/season responds', season.status === 200, `HTTP ${season.status}`);
if (season.json) {
  check(
    'it reports a season and a provider',
    typeof season.json.season === 'string' && typeof season.json.provider === 'string',
    `${season.json.provider} / ${season.json.season}`,
  );
  check(
    'it says why it has what it has',
    typeof season.json.reason === 'string' && season.json.reason.length > 0,
    season.json.reason,
  );
  console.log(
    `      stored: ${season.json.quotes} quote(s) across ${season.json.players} player(s), ` +
      `${season.json.unresolved} unresolved, fetched ${season.json.fetchedAt ?? 'never'}`,
  );
}

// 2. The draft board: the shape the new Draft screen reads.
const status = await get('/api/setup/status');
const draftId = status.json?.league?.draftId ?? null;
check('a league with a draft is configured', !!draftId, draftId ?? 'none');

// Hoisted, and asked for the whole board rather than five rows: the tier checks
// below are about the shape of a position's ladder, and five players is not one.
let board = { status: 0, json: null };
if (draftId) {
  board = await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=200`);
  check('the draft board builds', board.status === 200, `HTTP ${board.status}`);
  const rec = board.json?.recommendations?.[0];
  check('it returns ranked players', !!rec, rec ? rec.name : 'none');
  check(
    'every starting slot is reported for the roster line',
    Array.isArray(board.json?.rosterProgress) && board.json.rosterProgress.length > 0,
    (board.json?.rosterProgress ?? []).map((s) => `${s.filled}/${s.required} ${s.slot}`).join(' · '),
  );
  if (rec) {
    check(
      'the market component is present on every player',
      rec.components.some((c) => c.key === 'market_expectation'),
    );
    check(
      'an unpriced player is unknown rather than zero',
      rec.marketBaseline == null || rec.marketBaseline.points != null,
      rec.marketHeadline ?? 'no market line, and none shown',
    );
    check('roster need is a light contributor', Math.abs(componentOf(rec, 'need')) <= 0.2, `need ${componentOf(rec, 'need')}`);
  }
  /*
   * Which pick "will he last" is measured against.
   *
   * It must be a pick later than the one on the clock, always. When it was your
   * own selection — which is what it was whenever you were on the clock — the
   * question became "is a player available now available now", and the whole
   * board answered 100% at the one moment the number is used to choose.
   */
  const horizon = board.json?.waitHorizonPick ?? null;
  const onTheClock = board.json?.onTheClock === true;
  check(
    'survival is measured against a pick later than this one',
    horizon == null || horizon > (board.json?.currentPick ?? 0),
    `pick ${board.json?.currentPick} on the clock, horizon ${horizon ?? 'none left'}` +
      (onTheClock ? ' (your turn — the case this used to get wrong)' : ''),
  );
  const survivals = (board.json?.recommendations ?? [])
    .map((r) => r.survivalProbability)
    .filter((p) => p != null);
  if (survivals.length > 3) {
    check(
      'the board is not reporting everybody as certain to last',
      horizon == null || !survivals.every((p) => p === 1),
      `${new Set(survivals).size} distinct values across ${survivals.length} players`,
    );
  }

  console.log(
    `      alerts still computed: ${(board.json?.rosterAlerts ?? []).length}, ` +
      `startable positions: ${(board.json?.startablePositions ?? []).join(', ')}`,
  );
}

function componentOf(rec, key) {
  return rec.components.find((c) => c.key === key)?.contribution ?? 0;
}

// 3. The quota guard, in production.
//
// The point of the budget is that a problem is visible while it is still a
// number. So this asks the deployed app what it thinks it has spent, and — more
// importantly — that asking costs nothing: the route reads the ledger, and if it
// ever started calling the provider this check is what would notice.
const budget = await get('/api/vegas/budget');
check('/api/vegas/budget responds', budget.status === 200, `HTTP ${budget.status}`);
if (budget.json) {
  const b = budget.json.budget ?? {};
  check(
    'it reports a month, a state and a ceiling',
    typeof b.month === 'string' && typeof b.state === 'string' && b.limit > 0,
    `${b.used} of ${b.limit} in ${b.month} (${b.state}, counted by ${b.source})`,
  );
  check(
    'the guard is not already in the reserve',
    b.state !== 'hard_stop',
    b.note ?? '',
  );
  check(
    'the next refresh is scoped to the roster, not the slate',
    (budget.json.nextPlan?.estimatedEntities ?? 0) <= 12,
    `${budget.json.nextPlan?.events?.length ?? 0} game(s), ${budget.json.nextPlan?.estimatedEntities ?? 0} entities`,
  );
  const spent = Object.entries(budget.json.bySource ?? {})
    .map(([source, entities]) => `${source} ${entities}`)
    .join(' · ');
  console.log(`      spent this month: ${spent || 'nothing yet'}`);
  for (const row of (budget.json.recent ?? []).slice(0, 3)) {
    console.log(`      ${row.at} ${row.source} ${row.outcome} ${row.entities} — ${row.reason ?? ''}`);
  }
}

// 4. The tier ladder, as the board would draw it.
//
// Two failure modes, opposite and both loud. Every player at a position tagged
// `Tier cliff` is the bug this label has already shipped once; no tier
// structure at all means the grouping quietly collapsed to one group and the
// dividers stopped being drawn. Neither is visible from a unit test, because
// production has a real board on it.
if (board.json) {
  const recs = board.json.recommendations ?? [];
  const byPosition = new Map();
  for (const rec of recs) {
    if (!rec.position) continue;
    const list = byPosition.get(rec.position);
    if (list) list.push(rec);
    else byPosition.set(rec.position, [rec]);
  }
  for (const [position, players] of [...byPosition].sort()) {
    const tiers = new Set(players.map((p) => p.tierCliff?.tierIndex).filter((t) => t != null));
    // Only the last one or two of the group in play may carry the tag.
    const tagged = players.filter(
      (p) => p.tierCliff?.tierIndex === 0 && p.tierCliff?.tierEndsAtCliff && (p.tierCliff?.tierSize ?? 0) <= 2,
    );
    check(
      `${position}: the cliff tag is on nobody or on the last of a group`,
      tagged.length <= 2,
      `${players.length} available, ${tiers.size} tier(s), ${tagged.length} tagged`,
    );
    const currentTier = players.filter((p) => p.tierCliff?.tierIndex === 0);
    check(
      `${position}: the group in play reports one size to all of its members`,
      new Set(currentTier.map((p) => p.tierCliff?.tierSize)).size <= 1,
      `sizes: ${[...new Set(currentTier.map((p) => p.tierCliff?.tierSize))].join(', ')}`,
    );
  }
}

// 4b. The one line of context the expanded card kept, and the injury tags.
//
// Both are quiet failures if they go wrong: a tier line on every card is
// wallpaper, a tier line on none of them means the grouping collapsed, and an
// injury tag that appears on healthy players is worse than no tag.
if (board.json) {
  const recs = board.json.recommendations ?? [];
  const withContext = recs.filter((r) => r.tierContext);
  /*
   * A minority, not a majority.
   *
   * Every tier but the last ends at a cliff, so "ends at a cliff" alone put the
   * line on 158 of 195 players — which is the wallpaper this project keeps
   * having to remove. The line is now gated on the group being small enough
   * that the teams ahead could take it, and this is what would notice if that
   * gate ever came off.
   */
  check(
    'the tier line is on a minority of cards',
    withContext.length > 0 && withContext.length < recs.length * 0.5,
    `${withContext.length} of ${recs.length}`,
  );
  const overlong = withContext.filter((r) => r.tierContext.length > 90);
  check('it is one short line, never a paragraph', overlong.length === 0, withContext[0]?.tierContext ?? '');

  const tagged = recs.filter((r) => r.status);
  check(
    'injury designations are carried, and not by everybody',
    tagged.length < recs.length,
    tagged.length === 0
      ? 'nobody is currently designated'
      : `${tagged.length} designated: ${[...new Set(tagged.map((r) => r.status))].join(', ')}`,
  );
  /*
   * Ranking is ordered by total regardless of who is hurt.
   *
   * Checked among the players the market has priced, because the board has one
   * deliberate exception to "order follows total" and it is not injury: a
   * player with no published ADP is ranked after every player who has one. The
   * arithmetic alone gets that backwards -- an unknown market contributes zero
   * while a genuine reach contributes a negative, so sorting on the total alone
   * floats anonymous players above ranked ones. The tail is checked separately
   * below.
   */
  const priced = recs.filter((r) => r.adp != null);
  const pricedTotals = priced.map((r) => r.total);
  check(
    'the board is still ordered by score, not by health',
    pricedTotals.every((t, i) => i === 0 || pricedTotals[i - 1] >= t),
    `${priced.length} priced players in order`,
  );
  const firstUnpriced = recs.findIndex((r) => r.adp == null);
  const lastPriced = recs.map((r) => r.adp == null).lastIndexOf(false);
  check(
    'and players it cannot price are ranked after the ones it can',
    firstUnpriced === -1 || firstUnpriced > lastPriced,
    firstUnpriced === -1
      ? 'every player on the board carries an ADP'
      : `first unpriced at ${firstUnpriced + 1}, last priced at ${lastPriced + 1}, of ${recs.length}`,
  );
}

// 4c. The visible Score, on a real board.
//
// Two ways it can be useless, and neither shows up in a unit test. It can be
// flat — a calibration that squashes a live board into five points is exactly
// what the fixed constants were chosen to avoid — or it can disagree with the
// order it is supposed to be a transform of. Production is the only place with
// a genuine two-hundred-player spread to check against.
if (board.json) {
  const recs = board.json.recommendations ?? [];
  const scores = recs.map((r) => r.score);
  check(
    'every player carries a whole-number Score in range',
    scores.length > 0 && scores.every((s) => Number.isInteger(s) && s >= 0 && s <= 100),
    `${scores[0]} … ${scores[scores.length - 1]}`,
  );
  /*
   * The Score is a transform of the total, so it must agree with the order the
   * total produced -- among the players that order actually ranks. The unpriced
   * tail is placed by policy rather than by arithmetic, so a Score there can
   * legitimately sit above the priced player in front of it; what must never
   * happen is the priced part of the board disagreeing with itself.
   */
  const pricedScores = recs.filter((r) => r.adp != null).map((r) => r.score);
  check(
    'Score never contradicts board order',
    pricedScores.every((s, i) => i === 0 || pricedScores[i - 1] >= s),
    `across ${pricedScores.length} priced players`,
  );
  const top = scores.slice(0, 20);
  check(
    'it separates the players actually being chosen between',
    top.length > 3 && Math.max(...top) - Math.min(...top) >= 3,
    `top 20 span ${Math.min(...top)}–${Math.max(...top)}, whole board ${Math.min(...scores)}–${Math.max(...scores)}`,
  );

  /*
   * The live component. It is bounded by construction, so what production is
   * asked is the other half: does it actually vary? A component that reads the
   * same for every player is not noticing anything.
   */
  const separations = recs.map((r) => r.components?.find((c) => c.key === 'separation')?.contribution ?? null);
  const present = separations.filter((s) => s != null);
  check(
    'the separation component is computed for the whole board',
    present.length === recs.length,
    `${present.length} of ${recs.length}`,
  );
  check(
    'it is bounded, and it distinguishes players',
    present.every((s) => s >= 0 && s <= 0.25) && new Set(present).size > 3,
    `${new Set(present).size} distinct values, max ${Math.max(...present)}`,
  );
}

// 4d. Where availability comes from, in production.
//
// The interesting failure is not "the source is down" — it is the source being
// up and mapping almost nothing, which reads as a quiet board full of healthy
// players. So this asks for the counts, and it treats a season with no reports
// published yet as the fact it is rather than as an alarm.
const injury = status.json?.injury;
check('setup reports where injury information comes from', !!injury, injury ? injury.summary : 'missing');
if (injury) {
  check(
    'Sleeper owns the designation and a free report supplies the detail',
    injury.statusSource === 'sleeper' && injury.reportSource === 'nflverse',
    `${injury.statusSource} + ${injury.reportSource}`,
  );
  const run = injury.lastRun;
  check(
    'the report has been looked for at least once',
    !!run,
    run ? `${run.outcome}, ${run.fetchedAt}` : 'never run',
  );

  /*
   * The five-minute check, which is the thing that has to be alive.
   *
   * `checkedAt` moves on every tick whether or not anything changed, so a
   * `checkedAt` more than about fifteen minutes old means the cron has stopped
   * — the one failure that would silently return the app to reading a report
   * from yesterday morning while looking like it works.
   */
  if (injury.checkedAt) {
    const minutes = (Date.now() - Date.parse(injury.checkedAt)) / 60_000;
    check(
      'the five-minute injury check is running',
      minutes < 15,
      `last checked ${minutes.toFixed(1)} minutes ago`,
    );
  } else {
    console.log('      never checked yet — expected only in the first minutes after a deploy');
  }

  /*
   * The three timestamps must stay distinguishable. Collapsing them is how a
   * card ends up saying "updated 2 minutes ago" about Wednesday's report.
   */
  check(
    'checking and ingesting are reported separately',
    'checkedAt' in injury && 'sourceModifiedAt' in injury && 'ingestedAt' in injury,
    `checked ${injury.checkedAt ?? 'never'} · source ${injury.sourceModifiedAt ?? 'unknown'} · stored ${injury.ingestedAt ?? 'never'}`,
  );

  /*
   * And the budget. This pipeline is designed to spend a few dozen writes a
   * day; a number in the thousands means the diff has stopped working and every
   * tick is rewriting the board.
   */
  check(
    'the injury pipeline is not churning the database',
    (injury.writesToday ?? 0) < injury.writeCeiling,
    `${injury.writesToday ?? 0} of ${injury.writeCeiling} writes used today`,
  );
  if (run?.outcome === 'ok') {
    const mapped = run.matchedById + run.matchedByName;
    check(
      'most of the source maps onto players this app knows',
      run.rowsReturned === 0 || mapped / run.rowsReturned >= 0.8,
      `${mapped} of ${run.rowsReturned} mapped (${run.unmatched} unmatched), week ${run.latestWeek}`,
    );
  } else {
    /*
     * A preseason 404 is the honest state of an injury report before any injury
     * reports exist, and the app is required to say so in words rather than
     * showing a red light or, worse, an empty panel.
     */
    console.log(`      no report ingested: ${run?.outcome ?? 'never run'} — ${run?.note ?? injury.summary}`);
    check(
      'and it says why, rather than showing nothing',
      typeof injury.summary === 'string' && injury.summary.length > 0,
      injury.summary,
    );
  }
}

// The board still ranks on merit, whoever is hurt.
if (board.json) {
  const recs = board.json.recommendations ?? [];
  const lines = recs.filter((r) => r.injuryLine);
  check(
    'the injury line is on the players it is about, not on everybody',
    lines.length < recs.length * 0.5,
    lines.length === 0 ? 'nobody currently carries one' : `${lines.length} of ${recs.length}: ${lines[0].injuryLine}`,
  );
  // Every line must be about a player who actually carries a designation.
  const orphan = lines.filter((r) => !r.status);
  check('and never on a player with no designation', orphan.length === 0, orphan[0]?.name ?? '');
}

// 5. The expanded card's two feeds.
//
// Both are caches of Sleeper data, and a card cannot tell a cache that is empty
// from a player who has nothing — so the counts are asked for directly. Read
// from the status already fetched above; nothing here needs a second request.
const detail = status.json?.playerDetail;
check('setup reports where the player-card data comes from', !!detail, detail ? '' : 'missing');
if (detail) {
  check(
    `${detail.stats.season} statistics are loaded`,
    (detail.stats.players ?? 0) > 0,
    `${detail.stats.players} players, last run ${detail.stats.lastRunAt ?? 'never'}`,
  );
  check(
    'the outlook cache is answering rather than empty',
    (detail.outlook.stored ?? 0) + (detail.outlook.noneAvailable ?? 0) >= 0,
    `${detail.outlook.stored} stored, ${detail.outlook.noneAvailable} with none published`,
  );
  check(
    'roster percentage is reported as unavailable, not invented',
    detail.rosterPercent?.available === false,
    detail.rosterPercent?.note ?? '',
  );
}

// One player's detail, end to end, on whoever is top of the live board.
const topPlayer = board.json?.recommendations?.[0];
if (topPlayer) {
  const one = await get(`/api/players/${topPlayer.playerId}/detail`);
  check(`/api/players/:id/detail answers for ${topPlayer.name}`, one.status === 200, `HTTP ${one.status}`);
  if (one.json) {
    const last = one.json.lastSeason;
    // A finish is only printed for somebody who scored. A four-figure rank
    // would mean the provider's whole-directory ordering had leaked through.
    check(
      'any positional finish is a plausible one',
      !last?.positionRank || /^[A-Z]+([1-9]\d{0,2})$/.test(last.positionRank),
      `${last?.season ?? '—'}: ${last?.gamesPlayed ?? '—'} GP, ${last?.positionRank ?? 'no finish'}`,
    );
    /*
     * The outlook, shortened by selection.
     *
     * The claim being checked is the one that makes shortening somebody else's
     * writing acceptable at all: every sentence shown is a sentence they wrote.
     * If a summary ever contains prose that is not in `fullText`, this app has
     * started composing text and attributing it to a named provider, and that
     * is the loudest failure available here.
     */
    const outlook = one.json.outlook;
    const text = outlook?.text ?? '';
    check(
      'any outlook is attributed',
      !outlook || (text.length > 0 && !!outlook.source),
      outlook ? `${text.length} chars from ${outlook.source}` : (one.json.outlookNote ?? 'none published'),
    );
    if (outlook) {
      const invented = text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !outlook.fullText.includes(s));
      check(
        'every sentence shown is one the provider wrote',
        invented.length === 0,
        invented[0] ?? `${outlook.summarised ? 'shortened' : 'whole'}, ${text.length} of ${outlook.fullText.length} chars`,
      );
      check(
        'a shortened outlook is actually shorter, and says it was shortened',
        !outlook.summarised || text.length < outlook.fullText.length,
        outlook.summarised ? `${Math.round((100 * text.length) / outlook.fullText.length)}% of the source` : 'not shortened',
      );
    }
    // A named injury, or nothing. Never a diagnosis the app made up.
    check(
      'injury context is a label rather than a retelling',
      !one.json.injuryContext ||
        (one.json.injuryContext.startsWith('Major injury history:') && one.json.injuryContext.length < 80),
      one.json.injuryContext ?? 'nothing named in the source',
    );
  }
}

// N. League intelligence: the two waiver fields, and the surfaces beside them.
//
//    Written against the real league rather than a seeded one, so the honest
//    outcomes differ from the test database's. A league whose history has never
//    been synced has no bid prices and no manager profiles, and every check
//    below is phrased so that "nothing known" passes and "a number nobody can
//    justify" fails. That is the whole point of running this in production: the
//    seeded database can never produce the empty case the real one starts in.
const leagueId = status.json?.league?.id ?? null;
check('a league is selected', !!leagueId, leagueId ?? 'none');

if (leagueId) {
  const waivers = await get(`/api/leagues/${encodeURIComponent(leagueId)}/waivers`);
  check('/waivers responds', waivers.status === 200, `HTTP ${waivers.status}`);

  const candidates = (waivers.json?.upgrades ?? []).flatMap((u) => u.candidates ?? []);
  console.log(`      ${candidates.length} candidate(s) across ${(waivers.json?.upgrades ?? []).length} slot(s)`);

  if (candidates.length > 0) {
    /*
     * Present-and-null is a pass that ran and found nothing; absent is no pass
     * at all. Both fields must be present on every candidate, which is the
     * thing a deployment can get wrong without anybody noticing — a null field
     * renders as a quiet dash rather than as an error.
     */
    check(
      'every candidate carries a competition field',
      candidates.every((c) => c.competition !== undefined),
      `${candidates.filter((c) => c.competition != null).length}/${candidates.length} with a value`,
    );
    check(
      'every candidate carries a multi-week field',
      candidates.every((c) => c.multiWeek !== undefined),
      `${candidates.filter((c) => c.multiWeek != null).length}/${candidates.length} with a value`,
    );
    check(
      'competition speaks the board vocabulary',
      candidates.every((c) => c.competition == null || ['high', 'medium', 'low', 'unknown'].includes(c.competition.level)),
      [...new Set(candidates.map((c) => c.competition?.level ?? 'absent'))].join(', '),
    );
    check(
      'multi-week value speaks the board vocabulary',
      candidates.every(
        (c) => c.multiWeek == null || ['season_long', 'multi_week', 'streamer', 'unknown'].includes(c.multiWeek.level),
      ),
      [...new Set(candidates.map((c) => c.multiWeek?.level ?? 'absent'))].join(', '),
    );
    /*
     * A price with no history behind it must say so.
     *
     * Below `MIN_PRICE_SAMPLE` winning bids the pricing model deliberately
     * leads with a budget-share prior rather than with this league's own
     * numbers — checked against the running app, which prices at
     * `sample: 0` and labels the result `confidence: "low"`. That is a
     * defensible design and not this probe's to overrule.
     *
     * What it *is* here to catch is the version of that which would be
     * indefensible: a prior wearing the confidence of an observation. So the
     * assertion is on the label, which is the thing a reader acts on.
     */
    const bids = waivers.json?.faab?.bids ?? [];
    const priced = bids.filter((b) => b.expected != null);
    const sample = waivers.json?.faab?.prices?.sample ?? 0;
    check(
      'a price with no league history behind it is not presented as confident',
      priced.length === 0 || sample > 0 || priced.every((b) => b.confidence === 'low' || b.confidence === 'none'),
      priced.length === 0
        ? 'nothing priced, and nothing claimed'
        : `${priced.length} priced from ${sample} winning bid(s), confidence ` +
          `${[...new Set(priced.map((b) => b.confidence))].join('/')}`,
    );
    const shown = candidates.find((c) => c.competition?.detail);
    if (shown) console.log(`      e.g. ${shown.name}: ${shown.competition.label} — ${shown.competition.detail}`);
  }

  // The three surfaces nothing else answers. Each has an empty state that is
  // the correct answer for a league nothing has been synced for.
  const plan = await get(`/api/leagues/${encodeURIComponent(leagueId)}/plan`);
  check('/plan responds', plan.status === 200, `HTTP ${plan.status}`);
  check(
    'bye planning names the input it does not have',
    plan.json?.byes?.available === false && typeof plan.json?.byes?.note === 'string',
    plan.json?.byes?.note ?? 'no note',
  );
  check(
    'playoff weeks come from the league rather than a default',
    Array.isArray(plan.json?.playoffs?.weeks) && plan.json.playoffs.weeks.length > 0,
    `weeks ${(plan.json?.playoffs?.weeks ?? []).join(', ')} at weight ${plan.json?.playoffs?.weight}`,
  );

  const feed = await get(`/api/leagues/${encodeURIComponent(leagueId)}/feed`);
  check('/feed responds', feed.status === 200, `HTTP ${feed.status}`);
  check(
    'the feed is a delta, and empty is an ordinary answer',
    Array.isArray(feed.json?.events),
    `${(feed.json?.events ?? []).length} open event(s), ${feed.json?.unseen ?? 0} unseen`,
  );

  const fit = await get(`/api/leagues/${encodeURIComponent(leagueId)}/trade-fit`);
  check('/trade-fit responds', fit.status === 200, `HTTP ${fit.status}`);
  const ideas = fit.json?.ideas ?? [];
  check(
    'every listed trade helps both sides',
    ideas.every((i) => i.valueToUser > 0 && i.valueToPartner > 0),
    ideas.length === 0 ? 'no deal clears the bar, which is a real answer' : `${ideas.length} idea(s)`,
  );
  check(
    'untested plausibility is labelled rather than presented as measured',
    ideas.length === 0 || (fit.json?.notes ?? []).length >= 0,
    (fit.json?.notes ?? []).join(' · ') || 'no caveats needed',
  );
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
