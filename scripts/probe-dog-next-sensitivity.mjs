/**
 * What DOG moves, and what Sleeper moves — measured separately for Score and
 * for `Next%`.
 *
 * The brief's architecture asks for two different emphases:
 *
 *   - **Score and tiers** should lean on DOG, because that is sharp best-ball
 *     consensus about how good a player is;
 *   - **`Next%`** should lean on Sleeper ADP, because the draft actually
 *     happening is a Sleeper draft and the question is whether *this room* takes
 *     him before your next pick.
 *
 * Those are claims about sensitivity, not about weights, so this measures the
 * sensitivity directly: move one market by 10, 20 and 30 picks with everything
 * else held still, and print what each answer does.
 *
 * Run it with vite-node, for the reason `probe-dog-dominance` documents:
 *
 *   npx vite-node scripts/probe-dog-next-sensitivity.mjs
 *
 * Prints only; changes nothing.
 */

import { rankAvailablePlayers, DEFAULT_WEIGHTS } from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { simulateNextPick } from '../src/core/draft/nextpick/simulate.ts';
import { buildPickOwnership } from '../src/core/draft/nextpick/ownership.ts';

const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const SHAPE = buildRosterShape(ROSTER);
const PROFILE = buildScoringProfile({ rec: 1, pass_td: 4 }, ROSTER);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

const CTX = {
  currentPick: 53,
  nextPick: 68,
  shape: SHAPE,
  profile: PROFILE,
  rosterCounts: {},
  totalPicks: 180,
};

/** A board where the subject sits at a known ADP and everyone else is fixed. */
function board({ subjectAdp = 60, subjectDog = 60 } = {}) {
  const out = [];
  for (let i = 0; i < 120; i++) {
    const position = POSITIONS[i % POSITIONS.length];
    const adp = 20 + i * 1.4;
    out.push({
      player: {
        id: `p${i}`,
        sleeperPlayerId: `p${i}`,
        fullName: `Player ${i}`,
        firstName: 'Player',
        lastName: String(i),
        team: 'DET',
        position,
        status: null,
        active: true,
        normalizedName: `player${i}`,
        aliases: [],
      },
      adp: Math.round(adp * 10) / 10,
      dogAdp: Math.round(adp * 10) / 10,
      adpRank: i + 1,
      signal: null,
    });
  }
  out.push({
    player: {
      id: 'subject',
      sleeperPlayerId: 'subject',
      fullName: 'The Subject',
      firstName: 'The',
      lastName: 'Subject',
      team: 'DET',
      position: 'WR',
      status: null,
      active: true,
      normalizedName: 'thesubject',
      aliases: [],
    },
    adp: subjectAdp,
    dogAdp: subjectDog,
    adpRank: Math.round(subjectAdp),
    signal: null,
  });
  return out;
}

const scoreOf = (opts, format) => {
  const recs = rankAvailablePlayers(board(opts), { ...CTX, marketFormat: format }, DEFAULT_WEIGHTS);
  return recs.find((r) => r.playerId === 'subject').total;
};

// ------------------------------------------------------- 1. Score sensitivity

console.log('=== 1. Score: what does moving each market do? ===');
console.log('   (subject at ADP 60 / DOG 60; one market improved by N picks, the other held)\n');
for (const format of ['standard', 'best_ball']) {
  const base = scoreOf({ subjectAdp: 60, subjectDog: 60 }, format);
  console.log(`  ${format}`);
  for (const shift of [10, 20, 30]) {
    // "Improved" = an earlier pick number, i.e. the market rates him higher.
    const dog = scoreOf({ subjectAdp: 60, subjectDog: 60 - shift }, format) - base;
    const sleeper = scoreOf({ subjectAdp: 60 - shift, subjectDog: 60 }, format) - base;
    console.log(
      `    +${String(shift).padStart(2)} picks:  DOG ${dog >= 0 ? '+' : ''}${dog.toFixed(3)}` +
        `   Sleeper ${sleeper >= 0 ? '+' : ''}${sleeper.toFixed(3)}` +
        `   ratio ${sleeper === 0 ? 'n/a' : (dog / sleeper).toFixed(2)}`,
    );
  }
  console.log('');
}
console.log('  A DOG-anchored Score wants the DOG column larger, and best ball larger still.');

// ------------------------------------------------------ 2. Next% sensitivity

console.log('\n=== 2. Next%: what does moving each market do? ===');
console.log('   (same subject, simulated against a fixed room)\n');

const ownership = buildPickOwnership({ teams: 12, rounds: 15, type: 'snake' });
const rosters = new Map();
for (let slot = 1; slot <= 12; slot++) rosters.set(slot, { QB: 1, RB: 2, WR: 3, TE: 1 });

function candidates({ subjectAdp }) {
  const out = [];
  for (let i = 0; i < 120; i++) {
    const adp = Math.round((20 + i * 1.4) * 10) / 10;
    out.push({
      playerId: `p${i}`,
      position: POSITIONS[i % POSITIONS.length],
      adp,
      order: adp,
    });
  }
  out.push({ playerId: 'subject', position: 'WR', adp: subjectAdp, order: subjectAdp });
  return out;
}

function nextOf({ subjectAdp }) {
  const result = simulateNextPick({
    draftId: 'probe',
    currentPick: 53,
    targetPick: 68,
    mySlot: 5,
    ownership,
    shape: SHAPE,
    candidates: candidates({ subjectAdp }),
    rosters,
    totalPicks: 180,
    simulations: 4000,
  });
  return result.byPlayer.get('subject').probability;
}

{
  const base = nextOf({ subjectAdp: 60 });
  console.log(`  baseline Next% at Sleeper ADP 60: ${(base * 100).toFixed(1)}%`);
  for (const shift of [10, 20, 30]) {
    // Later ADP = the room wants him less = he should survive more often.
    const later = nextOf({ subjectAdp: 60 + shift }) - base;
    const earlier = nextOf({ subjectAdp: 60 - shift }) - base;
    console.log(
      `    Sleeper ${shift} later:  ${later >= 0 ? '+' : ''}${(later * 100).toFixed(1)} pts` +
        `     ${shift} earlier: ${earlier >= 0 ? '+' : ''}${(earlier * 100).toFixed(1)} pts`,
    );
  }
}

/*
 * And DOG, which the simulator is never handed.
 *
 * `SimCandidate` has one market field, `adp`, and the board fills it from
 * Sleeper. So the DOG sensitivity of `Next%` is exactly zero by construction —
 * not small, absent. That is the finding, and it is printed rather than
 * asserted so the next person to read this file can see why there is no number.
 */
console.log('\n  DOG sensitivity of Next%: structurally zero.');
console.log('  `SimCandidate` carries one market field (`adp`), filled from Sleeper.');
console.log('  DOG never reaches the survival model, so it cannot move it by any amount.');

// ----------------------------------------------- 3. late-draft confidence

/*
 * The case the third brief reports: current pick 148, ADP ~164, a next pick a
 * few selections away, and a survival estimate that reads as near-certain.
 */
console.log('\n=== 3. late-draft confidence, the reported case ===');
{
  const lateOwnership = buildPickOwnership({ teams: 12, rounds: 20, type: 'snake' });
  const lateRosters = new Map();
  for (let slot = 1; slot <= 12; slot++) lateRosters.set(slot, { QB: 1, RB: 2, WR: 3, TE: 1 });

  for (const [currentPick, targetPick, adp] of [
    [148, 153, 164],
    [148, 165, 164],
    [148, 151, 210],
    [10, 15, 26],
  ]) {
    const late = [];
    for (let i = 0; i < 160; i++) {
      const a = Math.round((5 + i * 1.6) * 10) / 10;
      late.push({ playerId: `q${i}`, position: POSITIONS[i % POSITIONS.length], adp: a, order: a });
    }
    late.push({ playerId: 'subject', position: 'QB', adp, order: adp });
    const result = simulateNextPick({
      draftId: 'probe-late',
      currentPick,
      targetPick,
      mySlot: 5,
      ownership: lateOwnership,
      shape: SHAPE,
      candidates: late,
      rosters: lateRosters,
      totalPicks: 240,
      simulations: 4000,
    });
    const p = result.byPlayer.get('subject').probability;
    console.log(
      `  pick ${String(currentPick).padStart(3)} -> ${String(targetPick).padStart(3)}` +
        ` (${String(targetPick - currentPick).padStart(2)} away), ADP ${String(adp).padStart(3)}:` +
        `  Next ${(p * 100).toFixed(1)}%`,
    );
  }
  console.log('  Rows one and four are the same ADP distance at opposite ends of the draft.');
  console.log('  If late confidence is calibrated, row one should be materially less certain.');
}
