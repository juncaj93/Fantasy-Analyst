/**
 * The Waivers look-ahead on the made-up preview league (Round 26). Never on
 * the live site: the preview build draws it behind the PIN.
 *
 * The same names as the Trades and Players previews (`trades/previewLeague.ts`)
 * and no new ones. Three things are set up so each line has something to say,
 * all in the made-up league:
 *
 *  - Pax Holloway (Kim's receiver) is out for the season, and Lars Penhall,
 *    a free agent, is second on Holloway's club: the Opportunity line.
 *  - Teo Ferreira, your only tight end, is on bye in week 12, and Rocco
 *    Bianchi is the one free tight end: the cover line.
 *  - Hollis Marchetti, Dermot's second back, is on IR in the week you play
 *    Dermot, and Ivo Brandt is a free back: the block line.
 *
 * Every line comes from the real functions (`opportunity.ts`, `upsideStash.ts`,
 * `lookAhead.ts`, `block.ts`), with the window a Monday has: weeks 11 to 13,
 * one lead week, $48 left of $100.
 *
 * Pure. No database.
 */

import { previewFreeAgents, previewLeague } from '../trades/previewLeague.ts';
import { findOpportunities } from './opportunity.ts';
import { upsideStash, type StashCandidate, type StashPlayer } from './upsideStash.ts';
import { coverPickups, type AheadCandidate, type AheadPlayer } from './lookAhead.ts';
import { blockPickup, type BlockCandidate, type BlockPlayer } from './block.ts';
import { playoffReserve } from '../faab/budget.ts';
import type { WaiverTiersView } from './tierPlan.ts';

const WEEKS = [11, 12, 13];
const HOLLOWAY = 'p45';
const PENHALL = 'f03';
const MARCHETTI = 'p23';
const OPPONENT_NAME = 'Dermot';

export function previewLookAhead(): Pick<WaiverTiersView, 'upsideStash' | 'cover' | 'block'> {
  const L = previewLeague('normal');
  const rates = L.rates;
  const fas = previewFreeAgents().map((f) => ({ ...f, team: f.id === PENHALL ? 'LAC' : f.team }));
  const me = L.rosters.find((r) => r.isMine)!;
  const dermot = L.rosters.find((r) => r.rosterId === L.opponent.rosterId)!;
  const rostered = new Set(L.rosters.flatMap((r) => r.playerIds));
  const at = (week: number) => L.horizon.weeks.indexOf(week);
  const spendable = playoffReserve(48, { week: 10, finalWeek: 17 }).spendable;

  /* A. The roles open in the made-up league, from nine made-up weeks at each player's number. */
  const everyone = [
    ...[...rates.values()].map((r) => ({ id: r.playerId, fullName: r.name, team: r.team, position: r.position, active: true })),
    ...fas.map((f) => ({ id: f.id, fullName: f.name, team: f.team, position: f.position, active: true })),
  ];
  const seasonPoints = new Map(everyone.map((p) => [p.id, Array.from({ length: 9 }, () => rates.get(p.id)?.rate ?? fas.find((f) => f.id === p.id)?.rate ?? 0)] as const));
  const leads = findOpportunities({
    week: 10,
    players: everyone,
    rosteredIds: rostered,
    depthOrder: new Map([
      [HOLLOWAY, 1],
      [PENHALL, 2],
    ]),
    injuryNotes: new Map([[HOLLOWAY, { status: 'IR', bodyPart: 'Knee - ACL', notes: 'Surgery' }]]),
    seasonPoints,
    through: 9,
  });

  const roster: StashPlayer[] = me.playerIds.map((id) => {
    const r = rates.get(id)!;
    return { playerId: id, name: r.name, position: r.position, team: r.team, seasonRate: r.rate, designation: r.designation };
  });
  const stashCandidates: StashCandidate[] = fas.map((f) => ({
    playerId: f.id,
    name: f.name,
    position: f.position,
    team: f.team,
    seasonRate: f.rate,
    designation: 'healthy',
    free: false,
    helpsNow: false,
  }));
  const stash = upsideStash({
    shape: L.shape,
    roster,
    candidates: stashCandidates,
    taken: new Set(),
    excludedPositions: new Set(['DEF']),
    verdicts: new Map(),
    reserveTakes: () => false,
    room: { reserve: 0, open: 2, dropReady: [] },
    players: [],
    depthOrder: new Map(),
    injuryStatus: new Map(),
    elite: new Map(),
    spendable,
    usesFaab: true,
    opportunities: new Map(leads.map((l) => [l.playerId, l] as const)),
  });
  const stashBid = stash?.bid.kind === 'claim' ? stash.bid.high : 0;

  /* B. Your next three weeks. */
  const ahead = (id: string): AheadPlayer => {
    const r = rates.get(id)!;
    return { playerId: id, name: r.name, position: r.position, team: r.team, rate: r.rate, weekly: WEEKS.map((w) => r.weekly[at(w)] ?? 1), byeWeek: r.byeWeek ?? null };
  };
  const coverCandidates: AheadCandidate[] = fas
    .filter((f) => f.id !== stash?.playerId)
    .map((f) => ({ playerId: f.id, name: f.name, position: f.position, team: f.team, rate: f.rate, weekly: [1, 1, 1], byeWeek: null, free: false }));
  const cover = coverPickups({
    shape: L.shape,
    roster: me.playerIds.map(ahead),
    weeks: WEEKS,
    excludedPositions: new Set(['DEF']),
    candidates: coverCandidates,
    leadWeeks: 1,
    taken: new Set(stash ? [stash.playerId] : []),
    covered: new Set(),
    room: [{ kind: 'open' }],
    spendable: spendable == null ? null : spendable - stashBid,
    usesFaab: true,
  });
  const coverBids = cover.reduce((s, c) => s + (c.bid.kind === 'claim' ? c.bid.high : 0), 0);

  /* C. Dermot's week 11. */
  const theirs: BlockPlayer[] = dermot.playerIds.map((id) => {
    const r = rates.get(id)!;
    return {
      playerId: id,
      name: r.name,
      position: r.position,
      team: r.team,
      points: r.rate,
      designation: id === MARCHETTI ? 'ir' : r.designation,
      onBye: r.byeWeek === WEEKS[0],
    };
  });
  const taken = new Set([stash?.playerId, ...cover.map((c) => c.playerId)].filter((x): x is string => x != null));
  const wire: BlockCandidate[] = fas.map((f) => ({
    playerId: f.id,
    name: f.name,
    position: f.position,
    team: f.team,
    points: f.rate,
    designation: 'healthy',
    onBye: false,
    addable: true,
    free: false,
  }));
  const block = blockPickup({
    shape: L.shape,
    opponent: { rosterId: dermot.rosterId, roster: theirs },
    candidates: wire,
    taken,
    excludedPositions: new Set(['DEF']),
    room: [{ kind: 'open' }],
    spendable: spendable == null ? null : Math.max(0, spendable - stashBid - coverBids),
    usesFaab: true,
    named: { opponentName: OPPONENT_NAME },
  });

  return { upsideStash: stash, cover, block };
}
