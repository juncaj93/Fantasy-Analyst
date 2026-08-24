/**
 * The manager-history adjustment, measured against a real league.
 *
 * A unit test can prove the model is self-consistent on a fixture. It cannot
 * say whether the tendencies it reads out of eleven real people are the ones a
 * human who watched those drafts would recognise, or whether the resulting
 * movement in `Next%` is the "few percentage points" the brief asked for rather
 * than something that quietly reshapes the board.
 *
 * So this runs the real thing end to end: the real previous-league chain, the
 * real completed drafts, the real profiles, and a simulated live board built
 * from them. Read-only against Sleeper's public endpoints; writes nothing.
 *
 *   node --experimental-strip-types scripts/probe-manager-history-next.ts <league_id>
 *
 * TypeScript rather than `.mjs` because it imports the shipped modules directly.
 * Measuring a reimplementation of the model would prove nothing about the model.
 */

import { readManagerTendencies } from '../src/core/managers/managerTendencies.ts';
import type { HistoricalPick } from '../src/core/managers/draftProfile.ts';
import {
  MANAGER_HISTORY_CEILING,
  estimateNextPickAvailability,
  readManagerPrior,
  slotsAheadOf,
  buildPickOwnership,
  positionsInPlay,
  type SimCandidate,
} from '../src/core/draft/nextpick/index.ts';
import { buildRosterShape } from '../src/core/sleeper/scoring.ts';
import type { PositionCounts } from '../src/core/draft/nextpick/demand.ts';

const BASE = 'https://api.sleeper.app/v1';
const leagueId = process.argv[2];
if (!leagueId) {
  console.error('usage: node --experimental-strip-types scripts/probe-manager-history-next.ts <league_id>');
  process.exit(1);
}

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const text = await res.text();
  return !text || text === 'null' ? null : (JSON.parse(text) as T);
}

interface League {
  league_id: string;
  season: string;
  name: string;
  total_rosters?: number;
  roster_positions?: string[];
  previous_league_id?: string | null;
}
interface Draft {
  draft_id: string;
  status: string;
  season: string;
  settings?: Record<string, number>;
  slot_to_roster_id?: Record<string, number> | null;
}
interface Pick {
  pick_no: number;
  round: number;
  picked_by?: string | null;
  roster_id?: number | string | null;
  metadata?: Record<string, string>;
}

// ------------------------------------------------------------- the chain
const chain: League[] = [];
let cursor: string | null = leagueId;
const seen = new Set<string>();
while (cursor && !seen.has(cursor)) {
  seen.add(cursor);
  const league: League | null = await get<League>(`/league/${cursor}`);
  if (!league) break;
  chain.push(league);
  cursor = league.previous_league_id ?? null;
}
if (chain.length === 0) {
  console.error('no such league');
  process.exit(1);
}

const current = chain[0]!;
const teams = current.total_rosters ?? 10;
const shape = buildRosterShape(current.roster_positions ?? ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DEF']);
const positions = positionsInPlay(shape);

console.log(`league        ${current.name} (${current.season}), ${teams} teams`);
console.log(`chain         ${chain.map((l) => l.season).join(' <- ')}  (${chain.length} season(s))`);

// ------------------------------------------------------- names and identity
const nameByUser = new Map<string, string | null>();
const userByRosterNow = new Map<number, string>();
for (const league of chain) {
  for (const u of (await get<{ user_id: string; display_name: string | null }[]>(`/league/${league.league_id}/users`)) ?? []) {
    nameByUser.set(u.user_id, u.display_name);
  }
}
for (const r of (await get<{ roster_id: number; owner_id: string | null }[]>(`/league/${current.league_id}/rosters`)) ?? []) {
  if (r.owner_id) userByRosterNow.set(r.roster_id, r.owner_id);
}

// ------------------------------------------------------------ the history
const picks: HistoricalPick[] = [];
let rounds = 16;
let completedDrafts = 0;
for (const league of chain) {
  for (const draft of (await get<Draft[]>(`/league/${league.league_id}/drafts`)) ?? []) {
    if (draft.status !== 'complete') continue;
    completedDrafts++;
    rounds = draft.settings?.rounds ?? rounds;
    for (const pick of (await get<Pick[]>(`/draft/${draft.draft_id}/picks`)) ?? []) {
      picks.push({
        season: league.season,
        draftId: draft.draft_id,
        pickNo: pick.pick_no,
        round: pick.round,
        userId: pick.picked_by ?? null,
        rosterId: typeof pick.roster_id === 'number' ? pick.roster_id : Number(pick.roster_id) || null,
        position: pick.metadata?.['position'] ?? null,
        // Sleeper publishes no contemporaneous price. See the brief's §4.
        marketRank: null,
        yearsExp: Number(pick.metadata?.['years_exp'] ?? NaN) || null,
      });
    }
  }
}

console.log(`history       ${completedDrafts} completed draft(s), ${picks.length} picks, ${rounds} rounds`);
console.log(
  `reach vs ADP  UNAVAILABLE — no contemporaneous market price is published with a historical pick`,
);

const tendencies = readManagerTendencies({
  picks,
  positions,
  rounds,
  latestSeason: chain.map((l) => l.season).sort().at(-1) ?? current.season,
  displayNames: nameByUser,
});

// ------------------------------------------------------ what was learned
console.log(`\n=== manager profiles (${[...tendencies.values()].filter((t) => t.usable).length} usable) ===`);
const rows = [...tendencies.values()].sort((a, b) => b.picksObserved - a.picksObserved);
for (const t of rows) {
  const label = `${t.displayName ?? t.userId}`.padEnd(18);
  if (!t.usable) {
    console.log(`${label} (no usable history: ${t.picksObserved} pick(s), ${t.draftsObserved} draft(s))`);
    continue;
  }
  const strongest = [...t.byPosition.values()]
    .filter((p) => Math.abs(p.lift) >= 0.02)
    .sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift))
    .slice(0, 3)
    .map(
      (p) =>
        `${p.position} ${p.lift > 0 ? '+' : ''}${p.lift} (first r${p.medianFirstRound ?? '—'} vs room r${p.roomMedianFirstRound ?? '—'}, spread ${p.spread ?? 0})`,
    );
  console.log(
    `${label} ${t.draftsObserved} draft(s), ${String(t.picksObserved).padStart(3)} picks  ${strongest.join('  |  ') || '(close to the room everywhere)'}`,
  );
}

const samples = rows.filter((t) => t.usable).map((t) => t.draftsObserved);
const distribution = new Map<number, number>();
for (const n of samples) distribution.set(n, (distribution.get(n) ?? 0) + 1);
console.log(
  `\nsample-size distribution: ${[...distribution.entries()].sort().map(([d, n]) => `${n} manager(s) with ${d} draft(s)`).join('; ') || '(none)'}`,
);

// ------------------------------------------------- what it does to Next%
/*
 * A board built from the real profiles.
 *
 * The current season is `pre_draft` in most leagues most of the year, so a
 * plausible mid-draft state is constructed rather than read: the user on the
 * clock at pick 53, every manager holding a realistic partial roster, and a
 * board of available players priced one per pick. The *profiles* are real, which
 * is the part being measured.
 */
const currentPick = 5 * teams + 3;
const ownership = buildPickOwnership({ teams, rounds, type: 'snake' });
const mySlot = 1;
const targetPick = ownership.nextOwnedPickAfter(mySlot, currentPick);
const slotsAhead = targetPick == null ? [] : slotsAheadOf(ownership, currentPick, targetPick, mySlot);

const candidates: SimCandidate[] = [];
for (const [position, count, spacing] of [
  ['RB', 40, 3],
  ['WR', 50, 2],
  ['TE', 16, 8],
  ['QB', 16, 8],
] as const) {
  for (let i = 0; i < count; i++) {
    const adp = currentPick + 2 + i * spacing;
    candidates.push({ playerId: `${position}-${adp}`, position, adp, order: adp });
  }
}

const rosters = new Map<number, PositionCounts>();
for (let slot = 1; slot <= teams; slot++) rosters.set(slot, { RB: 2, WR: 2 });

const slotToRoster = (await get<Draft>(`/league/${current.league_id}/drafts`).then(async () => {
  const drafts = (await get<Draft[]>(`/league/${current.league_id}/drafts`)) ?? [];
  return drafts[0]?.slot_to_roster_id ?? null;
})) as Record<string, number> | null;

const userBySlot = new Map<number, string | null>();
for (let slot = 1; slot <= teams; slot++) {
  const rosterId = slotToRoster?.[String(slot)] ?? slot;
  userBySlot.set(slot, userByRosterNow.get(rosterId) ?? null);
}

const prior = readManagerPrior({
  tendencies,
  userBySlot,
  slotsAhead,
  rosters,
  shape,
  positions,
  displayNames: new Map([...userBySlot].map(([slot, u]) => [slot, u ? (nameByUser.get(u) ?? null) : null])),
});

console.log(`\n=== the adjustment, at pick ${currentPick} (next own pick ${targetPick}) ===`);
console.log(`managers picking ahead: ${slotsAhead.length}; with usable history: ${prior.entries.length}`);
for (const note of prior.notes) console.log(`  ${note}`);

const common = {
  draftId: current.league_id,
  currentPick,
  targetPick,
  mySlot,
  ownership,
  shape,
  candidates,
  rosters,
  totalPicks: teams * rounds,
  completed: [],
  universe: candidates.map((c) => ({ position: c.position, adp: c.adp! })),
  teamsInLeague: teams,
  simulations: 5000,
  noCache: true,
};

const withHistory = estimateNextPickAvailability({ ...common, managerPrior: prior });

const moves = [...withHistory.byPlayer.values()]
  .filter((a) => a.historyAdjustment != null && Math.abs(a.historyAdjustment) > 0.0005)
  .sort((a, b) => Math.abs(b.historyAdjustment!) - Math.abs(a.historyAdjustment!));

console.log(`\nplayers whose Next% moved: ${moves.length} of ${withHistory.byPlayer.size}`);
for (const move of moves.slice(0, 12)) {
  const before = (move.historyBaseline! * 100).toFixed(1);
  const after = (move.probability! * 100).toFixed(1);
  const delta = (move.historyAdjustment! * 100).toFixed(1);
  console.log(
    `  ${move.playerId.padEnd(9)} ${before.padStart(5)}% -> ${after.padStart(5)}%  (${Number(delta) > 0 ? '+' : ''}${delta} pts)`,
  );
}
console.log(`\nlargest absolute movement: ${withHistory.historyLargestMovePoints} percentage points`);
console.log(`hard ceiling:              ${MANAGER_HISTORY_CEILING * 100} percentage points`);
console.log(`players clamped by it:     ${withHistory.historyCeilingHits}`);
if (withHistory.historyCeilingHits > 0) {
  console.log('  NOTE: a non-zero count means the ceiling is shaping the answer rather than guarding it.');
}
