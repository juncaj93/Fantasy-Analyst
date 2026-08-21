/**
 * When one unrelated player is drafted, what is allowed to move?
 *
 * The incident: in round 21 with three picks left, a receiver was the top
 * recommendation; somebody drafted a **tight end**; the board refreshed and he
 * was fifth, behind four receivers. An unrelated position reordering the top of
 * the board is the kind of thing that costs a reader their trust in it, so this
 * measures exactly which components may move and by how much.
 *
 * It reproduces the live chain rather than approximating it. `simulateNextPick`
 * runs against the real candidate pool, its per-player probability is fed back
 * into `rankAvailablePlayers` as `nextPickSurvival` exactly as `boardBuilder`
 * does, and the ranking is read out of the engine itself.
 *
 * Four measurements:
 *
 *   1. **Determinism.** The same state ranked repeatedly must be identical.
 *   2. **Cross-position perturbation.** Remove one QB, RB, WR or TE and report
 *      how far every *other* position moves, component by component.
 *   3. **Pick advance vs pool change.** A real pick does two things at once —
 *      it removes a player and it advances the clock. They are separated here,
 *      because only one of them is surprising.
 *   4. **Rounding.** How much composite separates adjacent displayed Scores at
 *      the top of a board, which is what decides whether a small change can
 *      reorder the top five.
 *
 * Run with vite-node, for the reason `probe-dog-dominance` documents:
 *
 *   npx vite-node scripts/probe-ranking-perturbation.mjs
 *
 * Read-only. Prints only; changes nothing.
 */

import { rankAvailablePlayers, DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { simulateNextPick } from '../src/core/draft/nextpick/simulate.ts';
import { buildPickOwnership } from '../src/core/draft/nextpick/ownership.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const TEAMS = 12;
const OWNERSHIP = buildPickOwnership({ teams: TEAMS, rounds: 21, type: 'snake' });

/** A late-round best-ball board, shaped like the one in the report. */
const POOL = { QB: 8, RB: 22, WR: 30, TE: 10 };

function board(currentPick) {
  const out = [];
  let i = 0;
  for (const position of POSITIONS) {
    for (let n = 0; n < POOL[position]; n++, i++) {
      const adp = Math.round((currentPick - 20 + n * 2.4 * (POSITIONS.length / 2)) * 10) / 10;
      const lean = ((i * 7) % 11) - 5;
      out.push({
        player: {
          id: `${position}-${n}`,
          sleeperPlayerId: `${position}-${n}`,
          fullName: `${position} ${String(n).padStart(2, '0')}`,
          firstName: position,
          lastName: String(n),
          team: 'DET',
          position,
          status: null,
          active: true,
          normalizedName: `${position}${n}`,
          aliases: [],
        },
        adp,
        dogAdp: Math.round(Math.max(1, adp * (1 + (lean / 5) * 0.1)) * 10) / 10,
        adpRank: i + 1,
        signal: null,
      });
    }
  }
  return out;
}

const ctxFor = (currentPick, nextPick) => ({
  currentPick,
  nextPick,
  shape: SHAPE,
  profile: PROFILE,
  // Late in a best-ball draft the starters are long filled.
  rosterCounts: { QB: 2, RB: 5, WR: 7, TE: 2 },
  totalPicks: TEAMS * 21,
  marketFormat: 'best_ball',
});

/**
 * Rank a board the way the live one is ranked: simulate, then feed the
 * simulator's own answer back in as `nextPickSurvival`.
 */
function rank(entries, currentPick, nextPick) {
  const rosters = new Map();
  for (let slot = 1; slot <= TEAMS; slot++) rosters.set(slot, { QB: 2, RB: 5, WR: 7, TE: 2 });
  const sim = simulateNextPick({
    draftId: 'perturbation',
    currentPick,
    targetPick: nextPick,
    mySlot: 5,
    ownership: OWNERSHIP,
    shape: SHAPE,
    candidates: entries.map((e) => ({
      playerId: e.player.id,
      position: e.player.position,
      adp: e.adp,
      dogAdp: e.dogAdp ?? null,
      team: e.player.team,
      order: e.adpRank,
    })),
    rosters,
    totalPicks: TEAMS * 21,
    simulations: 4000,
  });
  const withSurvival = entries.map((e) => {
    const found = sim.byPlayer.get(e.player.id);
    return {
      ...e,
      nextPickSurvival: { probability: found?.probability ?? null, note: 'simulated' },
    };
  });
  return rankAvailablePlayers(withSurvival, ctxFor(currentPick, nextPick), DEFAULT_WEIGHTS);
}

const CURRENT = 241;
const NEXT = 244;

const contributionOf = (rec, key) => rec.components.find((c) => c.key === key)?.contribution ?? 0;
const COMPONENTS = ['market_value', 'survival', 'scarcity', 'tier_cliff', 'separation', 'opportunity', 'market_expectation'];

// ------------------------------------------------------------ 1. determinism

console.log('=== 1. is the same state the same board? ===');
{
  const base = board(CURRENT);
  const a = rank(base, CURRENT, NEXT);
  const b = rank(base, CURRENT, NEXT);
  const sameOrder = a.map((r) => r.playerId).join() === b.map((r) => r.playerId).join();
  const sameTotals = a.every((r, i) => r.total === b[i].total);
  console.log(`   identical order:  ${sameOrder}`);
  console.log(`   identical totals: ${sameTotals}`);
  console.log('   (the simulator is seeded from the draft state, so this must be true)');
}

// --------------------------------------------- 2. cross-position perturbation

console.log('\n=== 2. remove one player; who else moves? ===');
console.log('   Pick is held FIXED, so this isolates the pool change alone.\n');
console.log('   removed  observer  moved/total  worst  mean|Δcomposite|  largest component shift');

const base = board(CURRENT);
const before = rank(base, CURRENT, NEXT);
const beforeAt = new Map(before.map((r, i) => [r.playerId, i]));
const beforeRec = new Map(before.map((r) => [r.playerId, r]));

for (const removed of POSITIONS) {
  // Take out the best available player of that position — the realistic case.
  const victim = before.find((r) => r.position === removed);
  const after = rank(
    base.filter((e) => e.player.id !== victim.playerId),
    CURRENT,
    NEXT,
  );
  const afterAt = new Map(after.map((r, i) => [r.playerId, i]));

  for (const observer of POSITIONS) {
    const peers = after.filter((r) => r.position === observer);
    // Rank among his own position, before and after, so the removal of one
    // player does not count as everybody shifting up one.
    const beforeOrder = before.filter((r) => r.position === observer && r.playerId !== victim.playerId).map((r) => r.playerId);
    const afterOrder = peers.map((r) => r.playerId);
    const at = new Map(afterOrder.map((id, i) => [id, i]));
    let moved = 0;
    let worst = 0;
    beforeOrder.forEach((id, i) => {
      const delta = Math.abs((at.get(id) ?? i) - i);
      if (delta > 0) moved++;
      worst = Math.max(worst, delta);
    });

    let totalDelta = 0;
    const componentShift = Object.fromEntries(COMPONENTS.map((c) => [c, 0]));
    for (const rec of peers) {
      const was = beforeRec.get(rec.playerId);
      if (!was) continue;
      totalDelta += Math.abs(rec.total - was.total);
      for (const key of COMPONENTS) {
        componentShift[key] = Math.max(componentShift[key], Math.abs(contributionOf(rec, key) - contributionOf(was, key)));
      }
    }
    const biggest = Object.entries(componentShift).sort((a, b) => b[1] - a[1])[0];
    console.log(
      `   ${removed.padEnd(8)} ${observer.padEnd(9)} ${String(moved).padStart(3)}/${String(beforeOrder.length).padEnd(6)}` +
        ` ${String(worst).padStart(4)}  ${(totalDelta / Math.max(1, peers.length)).toFixed(4).padStart(15)}` +
        `  ${biggest[0]} ${biggest[1].toFixed(4)}`,
    );
  }
  console.log('');
}
void beforeAt;

// -------------------------------------- 3. pool change vs the clock advancing

console.log('=== 3. a real pick does two things. Which one moves the board? ===\n');
{
  const victim = before.find((r) => r.position === 'TE');
  const poolOnly = rank(base.filter((e) => e.player.id !== victim.playerId), CURRENT, NEXT);
  const clockOnly = rank(base, CURRENT + 1, NEXT);
  const both = rank(base.filter((e) => e.player.id !== victim.playerId), CURRENT + 1, NEXT);

  const wrOrder = (recs) => recs.filter((r) => r.position === 'WR').map((r) => r.playerId);
  const churn = (a, b) => {
    const at = new Map(b.map((id, i) => [id, i]));
    return a.reduce((n, id, i) => n + ((at.get(id) ?? i) !== i ? 1 : 0), 0);
  };
  const baseWr = wrOrder(before);
  console.log(`   receivers reordered by removing one tight end : ${churn(baseWr, wrOrder(poolOnly))}/${baseWr.length}`);
  console.log(`   receivers reordered by advancing the clock one : ${churn(baseWr, wrOrder(clockOnly))}/${baseWr.length}`);
  console.log(`   receivers reordered by a real pick (both)      : ${churn(baseWr, wrOrder(both))}/${baseWr.length}`);
}

// --------------------------------------------------- 4. how tight is the top?

console.log('\n=== 4. how much composite separates the displayed Scores? ===\n');
{
  const top = before.slice(0, 8);
  console.log('   rank  score  internal   gap to next');
  top.forEach((rec, i) => {
    const next = top[i + 1];
    console.log(
      `   ${String(i + 1).padStart(4)}  ${String(rec.score).padStart(5)}  ${rec.total.toFixed(4).padStart(8)}` +
        `  ${next ? (rec.total - next.total).toFixed(4) : '—'}`,
    );
  });
  console.log('\n   A displayed Score is a logistic of the composite, so near the top a');
  console.log('   whole point of Score can be a few thousandths of composite. Anything');
  console.log('   that moves the composite by more than the gap reorders the pair.');
}

// ------------------------------- 5. what does one pick of the clock actually do?

/*
 * Measurement 3 says the clock, not the pool, is what moves receivers. This
 * asks which component the clock moves, because "the draft advanced" is only a
 * satisfying answer if the thing that moved is something a pick should move.
 */
console.log('\n=== 5. advancing the clock by one: which component moves? ===\n');
{
  const after = rank(base, CURRENT + 1, NEXT);
  const afterRec = new Map(after.map((r) => [r.playerId, r]));
  const shifts = Object.fromEntries(COMPONENTS.map((c) => [c, { max: 0, mean: 0, n: 0 }]));
  for (const was of before) {
    const now = afterRec.get(was.playerId);
    if (!now) continue;
    for (const key of COMPONENTS) {
      const d = Math.abs(contributionOf(now, key) - contributionOf(was, key));
      shifts[key].max = Math.max(shifts[key].max, d);
      shifts[key].mean += d;
      shifts[key].n++;
    }
  }
  console.log('   component            mean |Δ|   max |Δ|');
  for (const [key, s] of Object.entries(shifts).sort((a, b) => b[1].max - a[1].max)) {
    console.log(`   ${key.padEnd(20)} ${(s.mean / Math.max(1, s.n)).toFixed(4).padStart(8)}  ${s.max.toFixed(4).padStart(8)}`);
  }
  console.log('\n   `market_value` reads the distance from the clock, and `survival` reads');
  console.log('   how many picks are left before your turn. Both are supposed to move.');
}

// ------------------------------------------------- 6. ties, and what breaks them

console.log('\n=== 6. exact ties near the top, and what decides them ===\n');
{
  const top = before.slice(0, 25);
  let ties = 0;
  for (let i = 1; i < top.length; i++) if (top[i].total === top[i - 1].total) ties++;
  console.log(`   exact composite ties inside the top 25: ${ties}`);

  // Feed the same players in a different input order and see whether the
  // ranking survives it. A tie broken by arrival order is deterministic for one
  // board and arbitrary across two.
  const shuffled = [...base].reverse();
  const reversed = rank(shuffled, CURRENT, NEXT);
  const a = before.map((r) => r.playerId);
  const b = reversed.map((r) => r.playerId);
  const same = a.join() === b.join();
  console.log(`   same ranking when the input arrives reversed: ${same}`);
  if (!same) {
    const at = new Map(b.map((id, i) => [id, i]));
    const movers = a.map((id, i) => ({ id, from: i, to: at.get(id) ?? i })).filter((m) => m.from !== m.to);
    console.log(`   players whose rank depends on input order: ${movers.length}`);
    for (const m of movers.slice(0, 6)) {
      const rec = beforeRec.get(m.id);
      console.log(`     ${m.id.padEnd(8)} rank ${m.from + 1} -> ${m.to + 1}   composite ${rec.total.toFixed(4)}  score ${rec.score}`);
    }
  }
  console.log('\n   A tie broken by arrival order is stable for one board and arbitrary');
  console.log('   between two. If any mover above is a genuine tie, that is the finding.');
}


// ---------------- 7. one-pick sensitivity across the whole draft (Phase 13)

/*
 * Measurement 3 showed the clock moving ten receivers of thirty at pick 241.
 * On its own that number means nothing: it could be normal, or it could be the
 * late board being hypersensitive. So the same experiment is run early, middle
 * and late, and the distribution of movement is reported rather than one count.
 */
console.log('\n=== 7. one pick, at three depths ===\n');
console.log('   depth   pick  moved/top25  worst  mean|Δrank|  mean|Δcomposite|  new top-1?');
for (const [label, pick, next] of [
  ['early', 13, 16],
  ['middle', 121, 124],
  ['late', 241, 244],
]) {
  const pool = board(pick);
  const was = rank(pool, pick, next);
  // A real pick: the best available player goes, and the clock advances.
  const now = rank(pool.filter((e) => e.player.id !== was[0].playerId), pick + 1, next);
  const at = new Map(now.map((r, i) => [r.playerId, i]));
  const wasRec = new Map(was.map((r) => [r.playerId, r]));

  const top = was.slice(1, 26); // skip the drafted player himself
  let moved = 0;
  let worst = 0;
  let totalRank = 0;
  let totalComposite = 0;
  top.forEach((rec, i) => {
    const to = at.get(rec.playerId);
    if (to == null) return;
    const delta = Math.abs(to - i);
    if (delta > 0) moved++;
    worst = Math.max(worst, delta);
    totalRank += delta;
    const before = wasRec.get(rec.playerId);
    const after = now.find((r) => r.playerId === rec.playerId);
    if (before && after) totalComposite += Math.abs(after.total - before.total);
  });
  const newLeader = now[0].playerId !== was[1].playerId;
  console.log(
    `   ${label.padEnd(7)} ${String(pick).padStart(4)}  ${String(moved).padStart(7)}/25` +
      `  ${String(worst).padStart(5)}  ${(totalRank / top.length).toFixed(2).padStart(11)}` +
      `  ${(totalComposite / top.length).toFixed(4).padStart(16)}  ${newLeader ? 'yes' : 'no'}`,
  );
}
console.log('\n   `worst` is the number to watch. A pick should shuffle neighbours, not');
console.log('   throw a player across the board; a double-digit jump would be the');
console.log('   hypersensitivity the brief is asking about.');

// ------------------------------------- 8. why is this player here? (Phase 15)

/*
 * The diagnostic the brief asks for, and the reason it is worth having: when a
 * player moves, this says which components moved him instead of leaving the
 * next reader to reverse-engineer it from a screenshot.
 */
function explain(rec) {
  return {
    rank: null,
    score: rec.score,
    total: rec.total,
    components: Object.fromEntries(rec.components.map((c) => [c.key, c.contribution])),
  };
}

function compare(beforeRecs, afterRecs, playerId) {
  const b = beforeRecs.find((r) => r.playerId === playerId);
  const a = afterRecs.find((r) => r.playerId === playerId);
  if (!b || !a) return null;
  const from = beforeRecs.findIndex((r) => r.playerId === playerId) + 1;
  const to = afterRecs.findIndex((r) => r.playerId === playerId) + 1;
  const eb = explain(b);
  const ea = explain(a);
  const changed = [];
  const unchanged = [];
  for (const key of new Set([...Object.keys(eb.components), ...Object.keys(ea.components)])) {
    const delta = (ea.components[key] ?? 0) - (eb.components[key] ?? 0);
    if (Math.abs(delta) >= 0.0005) changed.push([key, delta]);
    else unchanged.push(key);
  }
  changed.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  return { playerId, from, to, eb, ea, changed, unchanged };
}

console.log('\n=== 8. why did this player move? ===\n');
{
  const pool = board(CURRENT);
  const was = rank(pool, CURRENT, NEXT);
  const now = rank(pool.filter((e) => e.player.id !== was[0].playerId), CURRENT + 1, NEXT);

  // The biggest faller in the top ten, which is the case a reader notices.
  const at = new Map(now.map((r, i) => [r.playerId, i]));
  const faller = was
    .slice(1, 11)
    .map((r, i) => ({ id: r.playerId, from: i + 1, to: (at.get(r.playerId) ?? i) + 1 }))
    .sort((a, b) => b.to - b.from - (a.to - a.from))[0];

  const report = compare(was.slice(1), now, faller.id);
  if (report) {
    console.log(`   Player: ${report.playerId}`);
    console.log(`   Rank:   ${report.from} -> ${report.to}`);
    console.log(`   Score:  ${report.eb.score} -> ${report.ea.score}   (displayed)`);
    console.log(`   Total:  ${report.eb.total.toFixed(4)} -> ${report.ea.total.toFixed(4)}   (internal)`);
    console.log('\n   Changed:');
    for (const [key, delta] of report.changed) {
      console.log(`     ${key.padEnd(20)} ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`);
    }
    console.log(`\n   Unchanged: ${report.unchanged.join(', ')}`);
    console.log('\n   That list is the whole answer. A component missing from "Changed"');
    console.log('   provably did not move him, which is what makes this quicker than');
    console.log('   reading the ranking code again.');
  }
}

// ------------------- 9. unknown market data, and the invariants (Phases 11/14)

/*
 * A late board is full of players nobody has priced. The question is not
 * whether they rank well — it is whether "unknown" is being read as a number.
 * A missing ADP treated as 0 is the best pick on the board; treated as a huge
 * number it is the worst; treated as unknown it is neither.
 */
console.log('\n=== 9. players the market never priced ===\n');
{
  const pool = board(CURRENT);
  const unpriced = pool.slice(0, 3).map((e) => ({ ...e, adp: null, dogAdp: null, adpRank: null }));
  const mixed = [...pool.slice(3), ...unpriced];
  const recs = rank(mixed, CURRENT, NEXT);

  const ids = new Set(unpriced.map((e) => e.player.id));
  const positions = recs.map((r, i) => ({ i, r })).filter((x) => ids.has(x.r.playerId));
  console.log(`   ${unpriced.length} unpriced players placed at ranks: ${positions.map((p) => p.i + 1).join(', ')}`);
  console.log(`   board size: ${recs.length}`);

  const bad = recs.filter((r) => !Number.isFinite(r.total) || (r.score != null && !Number.isFinite(r.score)));
  console.log(`   non-finite totals or scores anywhere on the board: ${bad.length}`);

  const anyTop = positions.some((p) => p.i < 5);
  console.log(`   any unpriced player in the top five: ${anyTop ? 'YES — investigate' : 'no'}`);
  for (const p of positions) {
    const mv = p.r.components.find((c) => c.key === 'market_value');
    const sc = p.r.components.find((c) => c.key === 'scarcity');
    console.log(
      `     ${p.r.playerId.padEnd(8)} score ${String(p.r.score).padStart(4)}  market_value ${mv?.contribution ?? 0}` +
        ` (unknown: ${mv?.unknown})  scarcity ${sc?.contribution ?? 0} (unknown: ${sc?.unknown})`,
    );
  }
  console.log('\n   Unknown must be marked unknown and contribute nothing, rather than');
  console.log('   scoring as zero — zero is a *value*, and on a signed component it is');
  console.log('   the middle of the range rather than the absence of one.');
}

console.log('\n=== 10. the invariants, stated as checks ===\n');
{
  const pool = board(CURRENT);
  const recs = rank(pool, CURRENT, NEXT);

  const monotonic = recs.every((r, i) => i === 0 || r.total <= recs[i - 1].total);
  console.log(`   composite never rises going down the board:      ${monotonic}`);

  const scoreMonotonic = recs
    .filter((r) => r.score != null)
    .every((r, i, list) => i === 0 || r.score <= list[i - 1].score);
  console.log(`   displayed Score never rises going down:          ${scoreMonotonic}`);

  const finite = recs.every((r) => Number.isFinite(r.total));
  console.log(`   every composite is a finite number:              ${finite}`);

  const sums = recs.every((r) => {
    const summed = r.components.reduce((t, c) => t + c.contribution, 0);
    return Math.abs(summed - r.total) < 0.02;
  });
  console.log(`   components sum to the composite they explain:    ${sums}`);

  const ids = recs.map((r) => r.playerId);
  console.log(`   no player appears twice:                         ${new Set(ids).size === ids.length}`);
  console.log(`   every available player is ranked:                ${ids.length === pool.length}`);
}
