/**
 * How much does DOG actually move the board?
 *
 * The brief asks the market baseline to lean heavily on raw Underdog ADP — 60%
 * in an ordinary league, 75% in best ball — and then asks, correctly, whether
 * that has accidentally made DOG 60% of the *Score*. Those are very different
 * claims and the percentage does not distinguish them, so this measures.
 *
 * Five things are printed, all of them on synthetic boards so the answers are
 * about the model rather than about whichever players happened to be available:
 *
 *   1. DOG's share of the total weight in play, against its share of the market
 *      baseline. The gap between those two numbers is the whole point.
 *   2. What happens to the board order when DOG is removed entirely — how many
 *      players move, and how far.
 *   3. Whether Sleeper still matters: the same measurement, with Sleeper removed.
 *   4. Whether the other bounded signals still outvote a market disagreement.
 *   5. What one absurd DOG value does to the board.
 *
 * Run it with vite-node rather than node:
 *
 *   npx vite-node scripts/probe-dog-dominance.mjs
 *
 * This probe imports the ranking engine directly rather than reading a
 * deployed board over HTTP, which is what lets it hold everything but one
 * variable still. That import chain reaches TypeScript that Node's strip-only
 * mode cannot parse (a constructor parameter property in the Vegas types), so
 * it needs a real transform. The probes that talk to production over HTTP have
 * no such dependency and still run under plain node.
 *
 * Prints only; changes nothing.
 */

import { rankAvailablePlayers, DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { MARKET_BLEND, blendMarketBaseline } from '../src/core/draft/marketBaseline.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { SEPARATION } from '../src/core/draft/score.ts';
import { OPPORTUNITY } from '../src/core/draft/opportunity.ts';
import { CONCENTRATION } from '../src/core/draft/concentration.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({}, ROSTER);
const CTX = {
  currentPick: 53,
  nextPick: 68,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 180,
};

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * A board of 160 players whose two markets disagree by a realistic amount.
 *
 * The disagreement is deterministic rather than random so two runs of this
 * probe are comparable, and it is signed both ways so the effect measured is
 * "DOG matters" rather than "everything shifted in one direction".
 */
function board(spread = 12) {
  const out = [];
  for (let i = 0; i < 160; i++) {
    const position = POSITIONS[i % POSITIONS.length];
    const sleeperAdp = 20 + i * 1.4;
    // A repeating but uneven pattern, so the two markets genuinely reorder.
    const lean = ((i * 7) % 11) - 5;
    out.push({
      player: {
        id: `p${i}`,
        sleeperPlayerId: `p${i}`,
        fullName: `Player ${String(i).padStart(3, '0')}`,
        firstName: 'Player',
        lastName: String(i),
        team: 'DET',
        position,
        status: null,
        active: true,
        normalizedName: `player${i}`,
        aliases: [],
      },
      adp: Math.round(sleeperAdp * 10) / 10,
      dogAdp: Math.round(Math.max(1, sleeperAdp + (lean / 5) * spread) * 10) / 10,
      adpRank: i + 1,
      signal: null,
    });
  }
  return out;
}

const order = (recs) => recs.map((r) => r.playerId);

/** How far players moved between two orderings. */
function displacement(a, b) {
  const at = new Map(b.map((id, i) => [id, i]));
  let moved = 0;
  let total = 0;
  let worst = 0;
  a.forEach((id, i) => {
    const delta = Math.abs((at.get(id) ?? i) - i);
    if (delta > 0) moved++;
    total += delta;
    worst = Math.max(worst, delta);
  });
  return { moved, mean: Math.round((total / a.length) * 100) / 100, worst };
}

// ----------------------------------------------- 1. share of the total weight

/*
 * Every weight the engine actually applies, not only the ones in the table:
 * separation, opportunity cost and NFL-team concentration carry their own
 * constants, and leaving them out would overstate the market's share.
 */
const totalWeight =
  Object.values(DEFAULT_WEIGHTS).reduce((a, w) => a + w, 0) +
  SEPARATION.weight +
  OPPORTUNITY.weight +
  CONCENTRATION.weight;

console.log('=== 1. what the percentages actually mean ===');
for (const [label, blend] of [
  ['non-best-ball', MARKET_BLEND.standard],
  ['best ball', MARKET_BLEND.bestBall],
]) {
  const ofBaseline = blend.dog;
  const ofScore = (DEFAULT_WEIGHTS.marketValue * blend.dog) / totalWeight;
  console.log(
    `  ${label.padEnd(14)} DOG = ${Math.round(ofBaseline * 100)}% of the market baseline` +
      `  ->  ${(ofScore * 100).toFixed(1)}% of the weight in play`,
  );
}
console.log(`  total weight across every component: ${totalWeight.toFixed(2)}`);
console.log(`  market value alone:                  ${DEFAULT_WEIGHTS.marketValue.toFixed(2)}`);

// -------------------------------------------------- 2. removing DOG entirely

console.log('\n=== 2. how much of the board is DOG holding up? ===');
for (const format of ['standard', 'best_ball']) {
  const withDog = order(rankAvailablePlayers(board(), { ...CTX, marketFormat: format }));
  const withoutDog = order(
    rankAvailablePlayers(
      board().map((p) => ({ ...p, dogAdp: null })),
      { ...CTX, marketFormat: format },
    ),
  );
  const d = displacement(withDog, withoutDog);
  console.log(
    `  ${format.padEnd(11)} ${d.moved}/160 players move · mean ${d.mean} places · worst ${d.worst}`,
  );
}

// ------------------------------------------------ 3. does Sleeper still matter?

console.log('\n=== 3. does Sleeper still matter? ===');
for (const format of ['standard', 'best_ball']) {
  const both = order(rankAvailablePlayers(board(), { ...CTX, marketFormat: format }));
  const dogOnly = order(
    rankAvailablePlayers(
      board().map((p) => ({ ...p, adp: null })),
      { ...CTX, marketFormat: format },
    ),
  );
  const d = displacement(both, dogOnly);
  console.log(
    `  ${format.padEnd(11)} removing Sleeper moves ${d.moved}/160 · mean ${d.mean} places · worst ${d.worst}`,
  );
}

// ------------------------------- 4. can the bounded signals still outvote it?

console.log('\n=== 4. can the other signals still outvote the market? ===');
{
  /*
   * Two players the market rates alike. One carries the tally, the ★ and a tier
   * cliff; the other carries a DOG edge. If the market baseline had become the
   * Score, the second would win regardless.
   */
  const signal = (net) => ({
    raw: { positive: net > 0 ? net : 0, negative: net < 0 ? -net : 0, net, items: Math.abs(net) },
    last30: { positive: 0, negative: 0, net: 0, items: 0 },
    last7: { positive: 0, negative: 0, net: 0, items: 0 },
    pendingCount: 0,
  });
  const base = board().slice(0, 40);
  /*
   * Swept rather than asserted at one gap, because the interesting number is
   * the crossover: at what DOG edge does the market stop being outvoted?
   *
   * That the market eventually wins is not new and not a DOG problem — the
   * engine has always documented market value as the component a large ADP gap
   * can carry alone ("a player who fell 30 picks scores a full 1.0 on market
   * value alone"). What matters here is that the crossover has not moved down
   * to somewhere trivial now that DOG leads the blend.
   */
  for (const edge of [4, 8, 12, 16, 20, 25]) {
    const contested = base.map((p, i) => {
      if (i === 0) return { ...p, adp: 55, dogAdp: 55, signal: signal(9), myGuyLevel: 3 };
      if (i === 1) return { ...p, adp: 55, dogAdp: 55 - edge, signal: null };
      return p;
    });
    const ranked = rankAvailablePlayers(contested, CTX);
    const researched = ranked.findIndex((r) => r.playerId === 'p0');
    const dogFavoured = ranked.findIndex((r) => r.playerId === 'p1');
    console.log(
      `  DOG edge ${String(edge).padStart(2)} picks -> researched+★★★ at ${String(researched + 1).padStart(2)}, ` +
        `DOG-favoured at ${String(dogFavoured + 1).padStart(2)}  ` +
        `${researched < dogFavoured ? '(research wins)' : '(market wins)'}`,
    );
  }
}

// ------------------------------------------- 5. one absurd DOG value

console.log('\n=== 5. what does one anomalous DOG value do? ===');
{
  const clean = order(rankAvailablePlayers(board(), CTX));
  const anomalous = board();
  // A deep player the Underdog feed has priced at 1.0 — the shape of a real
  // feed error rather than a plausible disagreement.
  anomalous[120] = { ...anomalous[120], dogAdp: 1 };
  const spoiled = order(rankAvailablePlayers(anomalous, CTX));
  const d = displacement(clean, spoiled);
  const from = clean.indexOf('p120');
  const to = spoiled.indexOf('p120');
  const guarded = blendMarketBaseline({ dogAdp: 1, sleeperAdp: anomalous[120].adp, format: 'standard' });
  console.log(`  the anomalous player moves from ${from + 1} to ${to + 1}`);
  console.log(`  everybody else: ${Math.max(0, d.moved - 1)} players move · mean ${d.mean} · worst ${d.worst}`);
  console.log(
    `  the guard: DOG 1 against Sleeper ${anomalous[120].adp} is ` +
      `${guarded.suspectDog ? 'set aside as suspect' : 'blended'} -> baseline ${guarded.adp}`,
  );

  /*
   * And a disagreement that is large but credible must survive, or the guard
   * has thrown away exactly the signal DOG was added to provide.
   */
  const credible = blendMarketBaseline({ dogAdp: 52, sleeperAdp: 70, format: 'standard' });
  console.log(
    `  a real 18-pick disagreement (DOG 52 / Sleeper 70) is ` +
      `${credible.suspectDog ? 'WRONGLY suspect' : 'kept'} -> baseline ${credible.adp}`,
  );
}

// ------------------------------------------------ 6. smoothness under disagreement

console.log('\n=== 6. is the response smooth as the markets diverge? ===');
{
  const base = order(rankAvailablePlayers(board(0), CTX));
  for (const spread of [4, 8, 16, 32, 64]) {
    const d = displacement(base, order(rankAvailablePlayers(board(spread), CTX)));
    console.log(`  spread ±${String(spread).padStart(2)} picks -> mean ${d.mean} places · worst ${d.worst}`);
  }
}
