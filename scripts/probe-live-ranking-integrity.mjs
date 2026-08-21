/**
 * Phase 18 of the ranking-integrity audit: do the invariants hold in production?
 *
 * Every other phase of this audit is proved against fixtures — boards this repo
 * constructs, at picks it chooses, with a pool it controls. That is the right
 * way to prove a *mechanism*, because a fixture can be perturbed one variable at
 * a time and a live draft cannot. It is not proof about the deployed system.
 * The gap between the two is real and has bitten this project before: the MKT
 * line was dark in production for a week while every fixture test was green,
 * because the fixtures supplied season markets and production had none.
 *
 * So this probe asks the deployed app the same questions, and it asks them of
 * whatever board is actually live. It runs on a GitHub runner because the
 * development sandbox cannot reach Cloudflare.
 *
 * **It is strictly read-only.** It issues `GET`s and nothing else, so it cannot
 * mutate a live draft — the requirement that made a probe the right instrument
 * here rather than an end-to-end test that drafts a player.
 *
 * Two properties need the board read twice, and a real draft can advance
 * between the two reads. That is not a failure and is not treated as one: when
 * the pick moves, those two checks report SKIP with the reason, because a
 * different pick is a legitimately different question.
 *
 * Exit code is 1 if any check fails, so the workflow log's last line is the
 * verdict.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/** The 15 components the contribution map documents. Anything else is new. */
const KNOWN_COMPONENTS = new Set([
  'market_value',
  'my_guy',
  'news_lifetime',
  'avoid',
  'league_fit',
  'survival',
  'scarcity',
  'news_30',
  'market_expectation',
  'tier_cliff',
  'news_7',
  'need',
  'separation',
  'opportunity',
  'concentration',
]);

const results = [];
function check(name, ok, detail) {
  results.push({ name, state: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  results.push({ name, state: 'SKIP', detail: why });
  console.log(`SKIP  ${name} — ${why}`);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const status = await get('/api/setup/status');
const draftId = status.json?.league?.draftId;
if (!draftId) {
  console.log('no draft configured in production — nothing to verify');
  process.exit(1);
}

const path = `/api/drafts/${encodeURIComponent(draftId)}/board?limit=300`;
const first = await get(path);
if (first.status !== 200 || !Array.isArray(first.json?.recommendations)) {
  console.log(`board did not answer: status ${first.status}`);
  process.exit(1);
}

const recs = first.json.recommendations;
const pick = first.json.currentPick;
console.log(`\nproduction board: ${recs.length} players at pick ${pick}, round ${first.json.round}\n`);

/*
 * 1. Board order is the composite's order.
 *
 * The single property everything else rests on. If the rows are not sorted by
 * `total`, then every explanation the card gives is an explanation of a number
 * that did not decide the position it is printed in.
 */
{
  const inversions = [];
  for (let i = 1; i < recs.length; i++) {
    if (recs[i].total > recs[i - 1].total + 1e-9) {
      inversions.push(`${recs[i].name} (${recs[i].total.toFixed(4)}) above ${recs[i - 1].name} (${recs[i - 1].total.toFixed(4)})`);
    }
  }
  check('board order is non-increasing in total', inversions.length === 0, inversions.slice(0, 3).join('; '));
}

/*
 * 2. Score is a monotone transform of total, and of nothing else.
 *
 * The Score is what the reader actually compares. If two players' Scores can
 * disagree with their totals, the visible number is lying about the ranking —
 * and because `draftScore` is a pure function of `total`, any disagreement here
 * means something downstream is rescaling it against the pool.
 */
{
  const priced = recs.filter((r) => r.score !== null);
  const bad = [];
  for (let i = 1; i < priced.length; i++) {
    if (priced[i].score > priced[i - 1].score) {
      bad.push(`${priced[i].name} ${priced[i].score} above ${priced[i - 1].name} ${priced[i - 1].score}`);
    }
  }
  check('Score never disagrees with total', bad.length === 0, bad.slice(0, 3).join('; '));

  // Same total must give the same Score, whoever else is on the board.
  const byTotal = new Map();
  for (const r of priced) {
    const key = r.total.toFixed(6);
    if (byTotal.has(key) && byTotal.get(key) !== r.score) {
      bad.push(`total ${key} scored both ${byTotal.get(key)} and ${r.score}`);
    }
    byTotal.set(key, r.score);
  }
  check('the same total always gives the same Score', bad.length === 0, bad.slice(0, 2).join('; '));
}

/*
 * 3. Every number that reaches a card is finite.
 *
 * A NaN in a component propagates silently: it makes the total NaN, every
 * comparison against it false, and the player sorts wherever the sort happens
 * to leave him. It would not throw and it would not look obviously wrong.
 */
{
  const bad = [];
  for (const r of recs) {
    if (!Number.isFinite(r.total)) bad.push(`${r.name}.total=${r.total}`);
    if (r.score !== null && !Number.isFinite(r.score)) bad.push(`${r.name}.score=${r.score}`);
    if (r.survivalProbability !== null && !Number.isFinite(r.survivalProbability)) {
      bad.push(`${r.name}.survival=${r.survivalProbability}`);
    }
    for (const c of r.components ?? []) {
      if (!Number.isFinite(c.contribution)) bad.push(`${r.name}.${c.key}=${c.contribution}`);
    }
  }
  check('no non-finite value anywhere on the board', bad.length === 0, bad.slice(0, 5).join(', '));
}

/*
 * 4. The total is the sum of the parts that are shown.
 *
 * This is what makes the expanded card an explanation rather than a decoration.
 * If a contribution is applied to the total but not listed, the card cannot
 * account for the player's position and the Phase 15 diagnostic would be
 * comparing an incomplete picture.
 */
{
  const bad = [];
  for (const r of recs) {
    const sum = (r.components ?? []).reduce((t, c) => t + c.contribution, 0);
    if (Math.abs(sum - r.total) > 1e-6) bad.push(`${r.name}: parts ${sum.toFixed(6)} vs total ${r.total.toFixed(6)}`);
  }
  check('total equals the sum of the listed components', bad.length === 0, bad.slice(0, 3).join('; '));
}

/*
 * 5. No component the contribution map does not know about.
 *
 * A new key reaching the board without reaching the map is how the map goes
 * stale, and a stale map is how the next incident gets reverse-engineered by
 * hand instead of read off.
 */
{
  const seen = new Set();
  for (const r of recs) for (const c of r.components ?? []) seen.add(c.key);
  const unknown = [...seen].filter((k) => !KNOWN_COMPONENTS.has(k));
  const missing = [...KNOWN_COMPONENTS].filter((k) => !seen.has(k));
  check('every component on the board is a documented one', unknown.length === 0, `undocumented: ${unknown.join(', ')}`);
  console.log(`      ${seen.size} distinct components live${missing.length ? `; not exercised on this board: ${missing.join(', ')}` : ''}`);
}

/*
 * 6. An unpriced player says so, rather than being scored on a curve that does
 *    not apply to him.
 *
 * Proved on fixtures in Phase 11. Worth re-asking here because production is
 * where the unpriced players actually are: the fixture chooses which players
 * lack a market and the live board does not.
 */
{
  const unpriced = recs.filter((r) => r.adp === null);
  if (unpriced.length === 0) {
    skip('an unpriced player shows no Score', 'every player on this board is priced');
  } else {
    const scored = unpriced.filter((r) => r.score !== null);
    check('an unpriced player shows no Score', scored.length === 0, `${scored.length} of ${unpriced.length} carried a Score`);

    // And he sits at the bottom rather than being lifted by the absence.
    const positions = unpriced.map((r) => recs.indexOf(r));
    const highest = Math.min(...positions);
    check(
      'an unpriced player is not lifted above priced ones',
      highest >= recs.length - unpriced.length - 2,
      `${unpriced.length} unpriced, highest at row ${highest + 1} of ${recs.length}`,
    );
  }
}

/*
 * 7. The board answers for the pick it says it is answering for.
 *
 * The race audit (Phase 5) proves the *client* cannot render a stale answer.
 * This is the other half: that the answer the server composed is internally
 * consistent — the pick it reports is the pick the draft is actually on, so a
 * board that is correct on arrival was correct at composition too.
 */
{
  const draft = await get(`/api/drafts/${encodeURIComponent(draftId)}`);
  const livePick = draft.json?.currentPick ?? draft.json?.draft?.currentPick ?? null;
  if (livePick === null || livePick === undefined) {
    skip('the board is answering for the live pick', 'the draft endpoint does not report a current pick');
  } else {
    check(
      'the board is answering for the live pick',
      Math.abs(livePick - pick) <= 1,
      `board says ${pick}, draft says ${livePick}`,
    );
  }
}

/*
 * 8. Asked twice, it answers the same.
 *
 * Determinism in production, not on a fixture. A board that reorders between
 * two identical requests at the same pick is drawing on something outside its
 * inputs — wall-clock, iteration order, a cache that half-refreshed — and no
 * amount of fixture determinism would show it.
 */
{
  const second = await get(path);
  const again = second.json?.recommendations ?? [];
  if (second.json?.currentPick !== pick) {
    skip('the same question twice gives the same answer', `a pick landed between reads (${pick} → ${second.json?.currentPick})`);
    skip('tie-break order is stable', 'a pick landed between reads');
  } else {
    const sameIds = again.length === recs.length && again.every((r, i) => r.playerId === recs[i].playerId);
    const sameTotals = sameIds && again.every((r, i) => Math.abs(r.total - recs[i].total) < 1e-9);
    check('the same question twice gives the same answer', sameIds && sameTotals, sameIds ? 'order held, totals moved' : 'order changed');

    /*
     * Ties specifically. Equal composites are the only place order is decided
     * by something other than the composite, so they are the only place a
     * non-deterministic sort could hide — everywhere else the totals would have
     * to differ for the order to.
     */
    const ties = [];
    for (let i = 1; i < recs.length; i++) {
      if (Math.abs(recs[i].total - recs[i - 1].total) < 1e-9) ties.push([recs[i - 1], recs[i]]);
    }
    if (ties.length === 0) {
      skip('tie-break order is stable', 'no exact ties on this board');
    } else {
      const held = ties.every(([a, b]) => {
        const ia = again.findIndex((r) => r.playerId === a.playerId);
        const ib = again.findIndex((r) => r.playerId === b.playerId);
        return ia >= 0 && ib >= 0 && ia < ib;
      });
      check('tie-break order is stable', held, `${ties.length} exact ties on this board`);
    }
  }
}

/*
 * 9. The news components move only for players the ledger actually counts.
 *
 * Phase 9 proves the transfer function on fixtures. What it cannot prove is
 * that production's ledger and production's board agree, because the ledger it
 * builds is its own. Here the two live sources are compared directly: a player
 * carrying a news contribution must carry a net tally to explain it, and a
 * player with no tally must carry no contribution.
 */
{
  const bad = [];
  for (const r of recs) {
    const news = (r.components ?? []).filter((c) => c.key.startsWith('news_'));
    const contribution = news.reduce((t, c) => t + c.contribution, 0);
    const tally = Math.abs(r.newsLifetimeNet) + Math.abs(r.news30Net) + Math.abs(r.news7Net);
    if (Math.abs(contribution) > 1e-9 && tally === 0) bad.push(`${r.name}: scored ${contribution.toFixed(4)} on an empty ledger`);
    if (Math.abs(contribution) < 1e-9 && r.newsLifetimeNet !== 0) bad.push(`${r.name}: net ${r.newsLifetimeNet} reached no component`);
  }
  const withNews = recs.filter((r) => r.newsLifetimeNet !== 0).length;
  check('news contributions and the visible tally agree', bad.length === 0, bad.slice(0, 3).join('; '));
  console.log(`      ${withNews} of ${recs.length} players carry a lifetime tally`);

  // And the sign agrees: a negative ledger cannot help a player.
  const wrongWay = recs.filter((r) => {
    const c = (r.components ?? []).filter((x) => x.key.startsWith('news_')).reduce((t, x) => t + x.contribution, 0);
    return r.newsLifetimeNet !== 0 && Math.sign(c) !== 0 && Math.sign(c) !== Math.sign(r.newsLifetimeNet);
  });
  check('a negative ledger never helps a player', wrongWay.length === 0, wrongWay.slice(0, 3).map((r) => r.name).join(', '));
}

/*
 * 10. The positional family stays inside its cap.
 *
 * Four components describe the same thing from four angles — how thin the
 * position is. Capped jointly, they are context; uncapped they would quietly
 * become the largest term on the board and turn every ranking into a positional
 * ranking. The cap is enforced on weights, so this reads it back off the board.
 */
{
  const FAMILY = ['scarcity', 'tier_cliff', 'separation', 'opportunity'];
  let worst = { name: null, weight: 0 };
  for (const r of recs) {
    const weight = (r.components ?? []).filter((c) => FAMILY.includes(c.key)).reduce((t, c) => t + Math.abs(c.weight), 0);
    if (weight > worst.weight) worst = { name: r.name, weight };
  }
  check(
    'the positional family stays inside its 0.5 cap',
    worst.weight <= 0.5 + 1e-6,
    `heaviest is ${worst.name} at ${worst.weight.toFixed(4)}`,
  );
}

const failed = results.filter((r) => r.state === 'FAIL');
const skipped = results.filter((r) => r.state === 'SKIP');
console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
    ` — against production at pick ${pick}`,
);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
process.exit(failed.length ? 1 : 0);
