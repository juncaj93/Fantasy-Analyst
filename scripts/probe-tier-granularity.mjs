/**
 * How far apart are adjacent Scores, and where do tiers actually break?
 *
 * The live board at pick 168 ran one uninterrupted receiver tier from a Score of
 * 91 down to 63, and one back tier from 80 down to 52. Ordering was correct —
 * that was the previous fix — but a group that wide is not a group. The brief
 * asks for a Score-gap boundary alongside the market one, and asks, correctly,
 * that the threshold be chosen from real distributions rather than picked.
 *
 * So this measures, per position and at three depths:
 *
 *   1. the quantiles of the gap between adjacent Scores on a Score-ordered
 *      board — which is the distribution any threshold has to sit inside;
 *   2. how many tiers the market ladder emits today, and the widest Score span
 *      inside one of them, which is the number the brief is complaining about;
 *   3. what a candidate Score-gap threshold would do to both.
 *
 * Run with vite-node, for the reason `probe-dog-dominance` documents:
 *
 *   npx vite-node scripts/probe-tier-granularity.mjs
 *
 * Prints only; changes nothing.
 */

import { rankAvailablePlayers, DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/** Roughly how many of each position a real board still holds at a given depth. */
const DEPTH_POOL = { QB: 14, RB: 34, WR: 44, TE: 14 };

/**
 * A board that still has the players a real one would at `currentPick`.
 *
 * ADP starts near the clock rather than at 1, because everybody meaningfully
 * ahead of the pick is gone — a pool that still holds ADP 5 at pick 168 is not
 * a late board, and every measurement taken from it is about a fiction.
 */
function board(currentPick, { spacing = 1.9, dogSpread = 0.08 } = {}) {
  const out = [];
  let i = 0;
  for (const position of POSITIONS) {
    for (let n = 0; n < DEPTH_POOL[position]; n++, i++) {
      const adp = Math.round((currentPick - 8 + n * spacing * (POSITIONS.length / 2)) * 10) / 10;
      // Deterministic, signed both ways, so DOG and Sleeper genuinely disagree.
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
        adp,
        dogAdp: Math.round(Math.max(1, adp * (1 + (lean / 5) * dogSpread)) * 10) / 10,
        adpRank: i + 1,
        signal: null,
      });
    }
  }
  return out;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next == null ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

const ctxFor = (currentPick, nextPick) => ({
  currentPick,
  nextPick,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 240,
});

const DEPTHS = [
  ['early', 10, 15],
  ['middle', 80, 92],
  ['late', 168, 180],
];

// -------------------------------------------- 1. adjacent Score-gap spread

console.log('=== 1. the gap between adjacent Scores, per position and depth ===');
console.log('   (Score-ordered, so these are the gaps a boundary rule would see)\n');
console.log('   depth    pos   n   p50   p75   p90   p95   max');
const allGaps = { early: [], middle: [], late: [] };
for (const [label, currentPick, nextPick] of DEPTHS) {
  const recs = rankAvailablePlayers(board(currentPick), ctxFor(currentPick, nextPick), DEFAULT_WEIGHTS);
  for (const position of POSITIONS) {
    const scores = recs
      .filter((r) => r.position === position && r.score != null)
      .map((r) => r.score);
    const gaps = [];
    for (let i = 1; i < scores.length; i++) gaps.push(scores[i - 1] - scores[i]);
    const sorted = [...gaps].sort((a, b) => a - b);
    allGaps[label].push(...gaps);
    console.log(
      `   ${label.padEnd(7)} ${position.padEnd(4)} ${String(scores.length).padStart(3)}` +
        `  ${quantile(sorted, 0.5).toFixed(1).padStart(4)}` +
        `  ${quantile(sorted, 0.75).toFixed(1).padStart(4)}` +
        `  ${quantile(sorted, 0.9).toFixed(1).padStart(4)}` +
        `  ${quantile(sorted, 0.95).toFixed(1).padStart(4)}` +
        `  ${(sorted[sorted.length - 1] ?? 0).toFixed(1).padStart(4)}`,
    );
  }
}
console.log('\n   pooled, by depth:');
for (const [label, gaps] of Object.entries(allGaps)) {
  const sorted = [...gaps].sort((a, b) => a - b);
  console.log(
    `     ${label.padEnd(7)} n=${String(sorted.length).padStart(3)}` +
      `  p50 ${quantile(sorted, 0.5).toFixed(1)}` +
      `  p75 ${quantile(sorted, 0.75).toFixed(1)}` +
      `  p90 ${quantile(sorted, 0.9).toFixed(1)}` +
      `  p95 ${quantile(sorted, 0.95).toFixed(1)}`,
  );
}

// ------------------------------ 2. what the market ladder emits on its own

console.log('\n=== 2. what the market ladder alone produces today ===');
console.log('   (tiers seen walking the Score-ordered list, and the widest Score span in one)\n');
console.log('   depth    pos   rows  tiers  widest-span  longest-run');
for (const [label, currentPick, nextPick] of DEPTHS) {
  const recs = rankAvailablePlayers(board(currentPick), ctxFor(currentPick, nextPick), DEFAULT_WEIGHTS);
  for (const position of POSITIONS) {
    const rows = recs.filter((r) => r.position === position && r.score != null);
    // The divider rule the screen uses: the first time the list reaches a tier.
    let deepest = -1;
    let runStart = 0;
    let widest = 0;
    let longest = 0;
    const opens = [];
    rows.forEach((r, i) => {
      const tier = r.tierCliff.tierIndex;
      if (tier != null && tier > deepest) {
        deepest = tier;
        if (i > 0) {
          opens.push(i);
          widest = Math.max(widest, rows[runStart].score - rows[i - 1].score);
          longest = Math.max(longest, i - runStart);
          runStart = i;
        }
      }
    });
    widest = Math.max(widest, rows[runStart].score - rows[rows.length - 1].score);
    longest = Math.max(longest, rows.length - runStart);
    console.log(
      `   ${label.padEnd(7)} ${position.padEnd(4)}  ${String(rows.length).padStart(4)}` +
        `  ${String(opens.length + 1).padStart(5)}` +
        `  ${String(widest).padStart(11)}` +
        `  ${String(longest).padStart(11)}`,
    );
  }
}
console.log('   widest-span is the complaint: a band whose best and worst are far apart');
console.log('   is not a band a reader can treat as interchangeable.');

// ------------------------------------- 3. what a Score-gap rule would add

console.log('\n=== 3. adding a Score-gap boundary, at several thresholds ===');
console.log('   (a boundary opens on a market tier OR a Score drop of at least N)\n');
for (const threshold of [4, 5, 6, 8, 10]) {
  const line = [];
  for (const [label, currentPick, nextPick] of DEPTHS) {
    const recs = rankAvailablePlayers(board(currentPick), ctxFor(currentPick, nextPick), DEFAULT_WEIGHTS);
    let tiers = 0;
    let widest = 0;
    let rowCount = 0;
    for (const position of POSITIONS) {
      const rows = recs.filter((r) => r.position === position && r.score != null);
      rowCount += rows.length;
      let deepest = -1;
      let runStart = 0;
      let count = 1;
      rows.forEach((r, i) => {
        const tier = r.tierCliff.tierIndex;
        const marketOpens = tier != null && tier > deepest;
        const scoreOpens = i > 0 && rows[i - 1].score - r.score >= threshold;
        if (marketOpens && tier != null) deepest = tier;
        if (i > 0 && (marketOpens || scoreOpens)) {
          count++;
          widest = Math.max(widest, rows[runStart].score - rows[i - 1].score);
          runStart = i;
        }
      });
      widest = Math.max(widest, rows[runStart].score - rows[rows.length - 1].score);
      tiers += count;
    }
    line.push(`${label} ${tiers} tiers / ${rowCount} rows, widest ${widest}`);
  }
  console.log(`   >= ${String(threshold).padStart(2)}:  ${line.join('   |   ')}`);
}
console.log('\n   Wanted: widest span down to something a reader can act on, without');
console.log('   a divider every other row. Too small a threshold is separator spam.');

// --------------------------- 4. why an adjacent-gap rule is not enough alone

/*
 * A gap rule bounds the step between neighbours. It cannot bound how far a band
 * drifts: twenty players dropping two points each never trip a threshold of
 * four, and the band still spans forty. That is exactly the reported complaint —
 * 91 and 63 in one group — so the span itself has to be a trigger too.
 */
console.log('\n=== 4. adjacent gap OR cumulative span ===');
console.log('   (a band also ends when it has drifted `span` points from its own top)\n');
for (const gapMin of [4, 5]) {
  for (const spanMax of [10, 12, 15, 20]) {
    const line = [];
    for (const [label, currentPick, nextPick] of DEPTHS) {
      const recs = rankAvailablePlayers(board(currentPick), ctxFor(currentPick, nextPick), DEFAULT_WEIGHTS);
      let tiers = 0;
      let widest = 0;
      let smallest = Infinity;
      for (const position of POSITIONS) {
        const rows = recs.filter((r) => r.position === position && r.score != null);
        let deepest = -1;
        let runStart = 0;
        let count = 1;
        rows.forEach((r, i) => {
          const tier = r.tierCliff.tierIndex;
          const marketOpens = tier != null && tier > deepest;
          const gapOpens = i > 0 && rows[i - 1].score - r.score >= gapMin;
          const spanOpens = i > 0 && rows[runStart].score - r.score > spanMax;
          if (marketOpens && tier != null) deepest = tier;
          if (i > 0 && (marketOpens || gapOpens || spanOpens)) {
            count++;
            widest = Math.max(widest, rows[runStart].score - rows[i - 1].score);
            smallest = Math.min(smallest, i - runStart);
            runStart = i;
          }
        });
        widest = Math.max(widest, rows[runStart].score - rows[rows.length - 1].score);
        smallest = Math.min(smallest, rows.length - runStart);
        tiers += count;
      }
      line.push(`${label}: ${String(tiers).padStart(2)} tiers, widest ${String(widest).padStart(2)}, min ${smallest}`);
    }
    console.log(`   gap>=${gapMin} span<=${String(spanMax).padStart(2)}:  ${line.join('  |  ')}`);
  }
}
console.log('\n   Looking for: widest in the low teens, and a minimum band size that is');
console.log('   not 1 everywhere — a divider between every pair is the other failure.');
