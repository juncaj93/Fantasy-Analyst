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
  'news_30d',
  'market_expectation',
  'tier_cliff',
  'news_7d',
  'need',
  'separation',
  'opportunity',
  'team_concentration',
]);

/**
 * Whether any market priced this player.
 *
 * Deliberately the *blend* rather than `adp`. `adp` is Sleeper's number alone,
 * and a player Underdog has priced and Sleeper has not is fully priced as far
 * as this engine is concerned — reading `adp` here would call a third of a deep
 * board unpriced and then assert nonsense about it. `marketBlend.adp` is the
 * same field the engine's own comparator sorts on.
 */
const unpriced = (r) => r.marketBlend?.adp == null;

const results = [];
/** `detail` explains a failure, so it is printed only when there is one. */
function check(name, ok, detail) {
  results.push({ name, state: ok ? 'PASS' : 'FAIL', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
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
 *
 * The order has one term ahead of the composite, and it is deliberate: a player
 * no market has priced sorts after every player somebody has. His total is
 * near zero — not because he is good, but because the component that would have
 * had an opinion is absent — so it is not on the same scale and cannot be
 * compared against a priced player's. So the property is "non-increasing in
 * total *within* each group, and every unpriced player below every priced one",
 * which is the engine's own comparator read back off the wire.
 */
{
  const inversions = [];
  for (let i = 1; i < recs.length; i++) {
    const prev = recs[i - 1];
    const cur = recs[i];
    if (unpriced(prev) && !unpriced(cur)) {
      inversions.push(`priced ${cur.name} sorted below unpriced ${prev.name}`);
    } else if (unpriced(prev) === unpriced(cur) && cur.total > prev.total + 1e-9) {
      inversions.push(`${cur.name} (${cur.total.toFixed(4)}) sorted below ${prev.name} (${prev.total.toFixed(4)})`);
    }
  }
  check('board order is the engine’s order', inversions.length === 0, inversions.slice(0, 3).join('; '));
  console.log(`      ${recs.filter((r) => !unpriced(r)).length} priced, ${recs.filter(unpriced).length} unpriced`);
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
  const priced = recs.filter((r) => r.score !== null && !unpriced(r));
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
  const nameless = recs.filter(unpriced);
  if (nameless.length === 0) {
    skip('an unpriced player shows no Score', 'every player on this board is priced');
  } else {
    const scored = nameless.filter((r) => r.score !== null);
    check('an unpriced player shows no Score', scored.length === 0, `${scored.length} of ${nameless.length} carried a Score`);

    // The converse matters just as much: a priced player must not be denied a
    // Score, or the board goes quiet exactly where it is meant to speak.
    const silent = recs.filter((r) => !unpriced(r) && r.score === null);
    check('a priced player always shows a Score', silent.length === 0, `${silent.length} priced players had none`);

    // And he sits at the tail rather than being lifted by the absence — the
    // defect this rule was written for, where "we know nothing about him"
    // rendered as a confident 83 above every priced player.
    const highest = Math.min(...nameless.map((r) => recs.indexOf(r)));
    check(
      'an unpriced player is not lifted above priced ones',
      highest >= recs.length - nameless.length,
      `${nameless.length} unpriced, highest at row ${highest + 1} of ${recs.length}`,
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
  const made = first.json?.boardPicks;
  if (!Array.isArray(made)) {
    skip('the board is answering for the pick the draft is on', 'this board carries no pick list');
  } else {
    /*
     * The completed picks travel with the board, composed from the same synced
     * state, so `currentPick` must be one past the last of them. A board that
     * disagrees with its own pick list was assembled from two different reads
     * of the draft — which is the server-side form of the stale-answer defect
     * Phase 5 rules out on the client.
     */
    const expected = made.length + 1;
    check(
      'the board is answering for the pick the draft is on',
      expected === pick,
      `board says pick ${pick} but carries ${made.length} completed picks`,
    );
    const numbers = made.map((p) => p.pickNo);
    const duplicated = numbers.length !== new Set(numbers).size;
    check('no pick is recorded twice', !duplicated, `${numbers.length - new Set(numbers).size} duplicates`);
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
    check(
      'the same question twice gives the same answer',
      sameIds && sameTotals,
      sameIds ? 'the order held but a total moved' : 'the order changed between two identical requests',
    );

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
 * position is. Capped jointly they are context; uncapped they would claim
 * eighteen picks of ADP for structure alone and turn every ranking into a
 * positional ranking.
 *
 * The cap is on the family's summed *contribution*, not on its summed weight:
 * the four weights add to 0.9 by design and it is the product that is scaled
 * back. Reading the weights instead would report a violation on every board
 * that has none. The tolerance is for `round3`, which the capping runs through.
 */
{
  const FAMILY = ['scarcity', 'tier_cliff', 'separation', 'opportunity'];
  let worst = { name: null, sum: 0 };
  for (const r of recs) {
    const sum = Math.abs(
      (r.components ?? [])
        .filter((c) => FAMILY.includes(c.key) && !c.unknown)
        .reduce((t, c) => t + c.contribution, 0),
    );
    if (sum > worst.sum) worst = { name: r.name, sum };
  }
  check(
    'the positional family stays inside its 0.5 cap',
    worst.sum <= 0.5 + 5e-3,
    `heaviest is ${worst.name} at ${worst.sum.toFixed(4)}`,
  );
  console.log(`      heaviest positional structure on this board: ${worst.name} at ${worst.sum.toFixed(4)} of 0.5`);
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
