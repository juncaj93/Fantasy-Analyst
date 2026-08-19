/**
 * How much does `MKT PTS` actually move the board?
 *
 * The strategy brief asks for a market-implied points signal that is "strong
 * enough to exploit disagreement between scoring markets and ADP, but without
 * double-counting props, inflating QBs, or overwhelming BPA". Those are four
 * separate claims and a weight in a table proves none of them, so this measures
 * each one against the real ranking engine.
 *
 * Six things are printed, all on synthetic boards so the answers are about the
 * model rather than about whoever happened to be available:
 *
 *   1. `market_expectation`'s nominal share of the weight in play.
 *   2. Its *effective* share — the nominal contribution plus the second-order
 *      movement it causes through `separation` and `opportunity`, which are
 *      functions of the composite and therefore amplify every component.
 *   3. What the board does when the props are removed entirely.
 *   4. Whether raw quarterback points can climb over backs and receivers —
 *      the QB-inflation guard, measured rather than asserted.
 *   5. Whether a props disagreement can beat a large ADP gap. It must not.
 *   6. What partial coverage does to the same disagreement.
 *
 * Run it with vite-node rather than node, for the reason `probe-dog-dominance`
 * documents — the import chain reaches TypeScript that Node's strip-only mode
 * cannot parse:
 *
 *   npx vite-node scripts/probe-mkt-pts-influence.mjs
 *
 * Prints only; changes nothing.
 */

import { rankAvailablePlayers, DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { SEPARATION } from '../src/core/draft/score.ts';
import { OPPORTUNITY } from '../src/core/draft/opportunity.ts';
import { CONCENTRATION } from '../src/core/draft/concentration.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER);
const CTX = {
  currentPick: 53,
  nextPick: 68,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 180,
};

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** The markets each position is priced on, matching `POSITION_MARKETS`. */
const MARKETS = {
  QB: ['season_pass_yards', 'season_pass_tds', 'season_rush_yards'],
  RB: ['season_rush_yards', 'season_rush_tds', 'season_receptions', 'season_receiving_yards'],
  WR: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
  TE: ['season_receiving_yards', 'season_receptions', 'season_receiving_tds'],
};

/** Base season lines, scaled by a per-player quality factor. */
const BASE = {
  season_pass_yards: 3950,
  season_pass_tds: 26.5,
  season_rush_yards: 780,
  season_rush_tds: 7.5,
  season_receptions: 68.5,
  season_receiving_yards: 880,
  season_receiving_tds: 6.5,
};

function player(i, position) {
  return {
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
  };
}

/**
 * A board of 160 players whose props and ADP disagree by a realistic amount.
 *
 * `quality` runs the props independently of ADP so the two can actually
 * disagree — a board where the props merely restate the draft order would make
 * every measurement below read as agreement.
 */
function board({ props = true, coverage = 1 } = {}) {
  const out = [];
  for (let i = 0; i < 160; i++) {
    const position = POSITIONS[i % POSITIONS.length];
    const sleeperAdp = 20 + i * 1.4;
    // Deterministic, signed both ways, and deliberately not a function of ADP.
    const quality = 1 + (((i * 7) % 11) - 5) / 25;
    const keys = MARKETS[position];
    const kept = keys.slice(0, Math.max(1, Math.round(keys.length * coverage)));
    out.push({
      player: player(i, position),
      adp: Math.round(sleeperAdp * 10) / 10,
      adpRank: i + 1,
      signal: null,
      seasonMarkets: props
        ? kept.map((market) => ({ market, line: Math.round(BASE[market] * quality * 10) / 10 }))
        : [],
    });
  }
  return out;
}

const order = (recs) => recs.map((r) => r.playerId);

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

const rank = (b) => rankAvailablePlayers(b, CTX, DEFAULT_WEIGHTS);
const componentOf = (rec, key) => rec.components.find((c) => c.key === key);

// ------------------------------------------------ 1. nominal share of weight

const totalWeight =
  Object.values(DEFAULT_WEIGHTS).reduce((a, w) => a + w, 0) +
  SEPARATION.weight +
  OPPORTUNITY.weight +
  CONCENTRATION.weight;

console.log('=== 1. what the weight in the table is worth ===');
console.log(`  total weight across every component:   ${totalWeight.toFixed(2)}`);
console.log(`  market_expectation nominal weight:     ${DEFAULT_WEIGHTS.marketExpectation.toFixed(2)}`);
console.log(
  `  nominal share of the weight in play:   ${((DEFAULT_WEIGHTS.marketExpectation / totalWeight) * 100).toFixed(1)}%`,
);
console.log(`  market_value, for comparison:          ${DEFAULT_WEIGHTS.marketValue.toFixed(2)}`);
console.log(
  '  note: the component is scored in [-1,1] and multiplied by coverage, so',
);
console.log('        the nominal figure is a ceiling reached only at full coverage.');

// ---------------------------------------- 2. effective share, second order in

/*
 * `separation` and `opportunity` are computed from the composite, which already
 * contains `market_expectation`. They are not a prop-specific duplicate — they
 * amplify every component identically — but they do mean the component's real
 * influence exceeds its nominal weight, and a contribution map that quoted only
 * the nominal figure would understate it. So it is measured.
 */
console.log('\n=== 2. effective influence, including separation/opportunity ===');
{
  const withProps = rank(board({ props: true }));
  const byId = new Map(withProps.map((r) => [r.playerId, r]));
  let nominal = 0;
  let second = 0;
  let counted = 0;
  for (const rec of withProps) {
    const me = componentOf(rec, 'market_expectation');
    if (me == null || me.unknown) continue;
    counted++;
    nominal += Math.abs(me.contribution);
    const sep = componentOf(rec, 'separation');
    const opp = componentOf(rec, 'opportunity');
    second += Math.abs(sep?.contribution ?? 0) + Math.abs(opp?.contribution ?? 0);
  }
  void byId;
  console.log(`  players carrying a scored market expectation: ${counted}/${withProps.length}`);
  console.log(`  mean |market_expectation| contribution:       ${(nominal / counted).toFixed(3)}`);
  console.log(`  mean |separation| + |opportunity|:            ${(second / counted).toFixed(3)}`);
  console.log('  (the second figure is driven by the whole composite, not by props alone —');
  console.log('   see measurement 3 for the part of it the props are actually responsible for)');
}

// ---------------------------------------------- 3. removing the props outright

console.log('\n=== 3. how much of the board are the props holding up? ===');
{
  const withProps = order(rank(board({ props: true })));
  const without = order(rank(board({ props: false })));
  const d = displacement(withProps, without);
  console.log(`  players that move at all: ${d.moved}/160`);
  console.log(`  mean displacement:        ${d.mean} places`);
  console.log(`  worst displacement:       ${d.worst} places`);
  console.log('  a signal that moved nothing would not be worth showing; one that moved');
  console.log('  the whole board would be overpowering BPA. Both failures are visible here.');
}

// -------------------------------------------------- 4. the QB inflation guard

/*
 * The failure this guards against: a quarterback implies far more raw fantasy
 * points than any receiver, so feeding raw points into the composite would
 * float every quarterback to the top. The component is a within-position
 * standing rather than a points total, so it must not.
 */
console.log('\n=== 4. can raw quarterback points climb over the field? ===');
{
  const recs = rank(board({ props: true }));
  const top20 = recs.slice(0, 20);
  const counts = {};
  for (const r of top20) counts[r.position] = (counts[r.position] ?? 0) + 1;
  console.log(`  positions in the top 20: ${JSON.stringify(counts)}`);

  // And the direct comparison: the best-priced QB against the best-priced WR,
  // both at the same ADP, so the only difference is the raw points.
  const pair = [
    {
      player: player(900, 'QB'),
      adp: 40,
      adpRank: 40,
      signal: null,
      seasonMarkets: MARKETS.QB.map((market) => ({ market, line: BASE[market] * 1.25 })),
    },
    {
      player: player(901, 'WR'),
      adp: 40,
      adpRank: 40,
      signal: null,
      seasonMarkets: MARKETS.WR.map((market) => ({ market, line: BASE[market] * 1.25 })),
    },
  ];
  const both = rank([...board({ props: true }), ...pair]);
  const qb = both.find((r) => r.playerId === 'p900');
  const wr = both.find((r) => r.playerId === 'p901');
  const meQb = componentOf(qb, 'market_expectation');
  const meWr = componentOf(wr, 'market_expectation');
  console.log(`  identically-priced QB and WR at ADP 40:`);
  console.log(`    QB market_expectation score ${meQb?.score} -> contribution ${meQb?.contribution}`);
  console.log(`    WR market_expectation score ${meWr?.score} -> contribution ${meWr?.contribution}`);
  console.log(`    QB total ${qb?.total}   WR total ${wr?.total}`);
  console.log('  the two scores are positional standings, so a quarterback\'s larger raw');
  console.log('  points total must not by itself produce a larger contribution.');
}

// ------------------------------------- 5. can the props beat a real ADP gap?

console.log('\n=== 5. props against a large ADP gap ===');
{
  const base = board({ props: true });
  for (const gap of [10, 20, 30]) {
    const cheap = {
      player: player(910, 'WR'),
      adp: 60 + gap,
      adpRank: 60 + gap,
      signal: null,
      // Priced at the very top of the position.
      seasonMarkets: MARKETS.WR.map((market) => ({ market, line: BASE[market] * 1.4 })),
    };
    const dear = {
      player: player(911, 'WR'),
      adp: 60,
      adpRank: 60,
      signal: null,
      // Priced at the very bottom.
      seasonMarkets: MARKETS.WR.map((market) => ({ market, line: BASE[market] * 0.7 })),
    };
    const recs = rank([...base, cheap, dear]);
    const a = recs.find((r) => r.playerId === 'p910');
    const b = recs.find((r) => r.playerId === 'p911');
    const winner = (a?.total ?? 0) > (b?.total ?? 0) ? 'strong props' : 'better ADP';
    console.log(
      `  ADP gap ${String(gap).padStart(2)}: strong-props ${a?.total?.toFixed(3)} vs better-ADP ${b?.total?.toFixed(3)}` +
        `  ->  ${winner} wins`,
    );
  }
  console.log('  BPA stays dominant if the better ADP wins once the gap is large enough.');
}

// ------------------------------------------------ 6. the same, under coverage

console.log('\n=== 6. partial coverage must temper the same disagreement ===');
{
  for (const coverage of [1, 0.66, 0.34]) {
    const recs = rank(board({ props: true, coverage }));
    const scored = recs
      .map((r) => componentOf(r, 'market_expectation'))
      .filter((c) => c != null && !c.unknown);
    const mean = scored.reduce((t, c) => t + Math.abs(c.contribution), 0) / Math.max(1, scored.length);
    console.log(
      `  coverage ${coverage.toFixed(2)}: ${String(scored.length).padStart(3)} scored,` +
        ` mean |contribution| ${mean.toFixed(3)}`,
    );
  }
  console.log('  a thinner picture has to move the board less, and unknown must stay unknown');
  console.log('  rather than becoming a negative opinion.');
}
