/**
 * The surface Channel 4 consumes, built end to end from the real modules.
 *
 * Two payloads are constructed: one where every source is connected, and one
 * where none of them are. The second is the one that matters — a degraded
 * payload must be full of `null`, not full of zeros, and must still validate.
 * A consumer that cannot tell "no data" from "no points" will eventually start
 * a player who does not exist.
 *
 * The enumerated cases from the brief that are not natural to any single
 * module — missing nflverse data, a stale source, a tiny sample, FLEX legality,
 * an unavailable waiver pivot — are exercised here, through the contract, which
 * is where a consumer would meet them.
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL3_CONTRACT_VERSION,
  beneficiaryContract,
  channel3Payload,
  lineupIntelligence,
  roleTrendContract,
  scheduleContract,
  validateChannel3Payload,
  valueContract,
  xfpContract,
  type PlayerIntelligence,
} from '../src/core/contracts/channel3.ts';
import { XFP_LIMITATIONS, assessXfp } from '../src/core/xfp/model.ts';
import { assessRole } from '../src/core/startsit/decisions.ts';
import { assessUsage } from '../src/core/startsit/usageTrend.ts';
import { toRoleMetrics } from '../src/core/usage/role.ts';
import { buildDefenseTendencies, type DefenseGame } from '../src/core/startsit/defense.ts';
import { roleScheduleOutlook } from '../src/core/schedule/roleStrength.ts';
import { valueOverWeeks } from '../src/core/value/multiWeek.ts';
import { buildBeneficiaryGraph } from '../src/core/injury/beneficiaries.ts';
import { assessFragility } from '../src/core/startsit/fragility.ts';
import { contingencyPlans } from '../src/core/startsit/contingency.ts';
import { findBoundaries } from '../src/core/startsit/boundary.ts';
import { suggestMode } from '../src/core/startsit/modeSuggest.ts';
import { assessStreaming } from '../src/core/startsit/streaming.ts';
import { recommendLineup } from '../src/core/startsit/lineup.ts';
import { evaluatePlayer } from '../src/core/startsit/engine.ts';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { NO_INJURY_INFORMATION } from '../src/core/injury/model.ts';
import type { RosterShape } from '../src/core/sleeper/scoring.ts';
import type { StartSitInput } from '../src/core/startsit/engine.ts';
import type { UsageWeek } from '../src/core/usage/role.ts';
import { candidate } from './helpers/startsit.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const NOW = '2025-10-05T14:00:00Z';
const EARLY = '2025-10-05T17:00:00Z';
const LATE = '2025-10-05T20:25:00Z';

const SHAPE: RosterShape = {
  starters: { QB: 1, RB: 1, WR: 2, TE: 1 },
  flex: [{ slot: 'FLEX', positions: ['RB', 'WR', 'TE'] }],
  benchSlots: 5,
  irSlots: 1,
  totalStarters: 6,
  superflex: false,
};

function week(over: Partial<UsageWeek> & { week: number }): UsageWeek {
  return {
    seasonType: 'REG',
    passAttempts: null,
    carries: null,
    targets: null,
    receptions: null,
    targetShare: null,
    wopr: null,
    ...over,
  };
}

function weeks(count: number, template: Omit<Partial<UsageWeek>, 'week'>): UsageWeek[] {
  return Array.from({ length: count }, (_, i) => week({ week: i + 1, ...template }));
}

function softDefense(defense: string): DefenseGame[] {
  return Array.from({ length: 6 }, (_, i) => ({
    defense,
    week: i + 1,
    position: 'WR',
    bucket: 'deep_receiver' as const,
    points: 20,
    baseline: 12,
  }));
}

function questionable(input: StartSitInput): StartSitInput {
  return {
    ...input,
    injury: {
      ...NO_INJURY_INFORMATION,
      designation: 'questionable',
      designationSource: 'sleeper',
      practice: { trend: 'stable_limited', days: [], latest: 'limited', label: 'limited all week' },
      freshness: 'fresh',
      confidence: 'high',
    },
  };
}

describe('a fully-populated payload', () => {
  const usage = weeks(7, { targets: 9, receptions: 6, recYards: 78, recTds: 0.4, receivingAirYards: 108, targetShare: 0.24 });
  const tendencies = buildDefenseTendencies(softDefense('MIA'));
  const schedule = roleScheduleOutlook({
    position: 'WR',
    bucket: 'deep_receiver',
    schedule: [
      { week: 6, opponent: 'MIA' },
      { week: 7, opponent: null },
      { week: 8, opponent: 'MIA' },
      { week: 9, opponent: 'SEA' },
    ],
    tendencies,
    fromWeek: 5,
  });

  const roster: StartSitInput[] = [
    candidate('qb1', 'A Quarterback', 'QB', 19, { kickoff: LATE }),
    candidate('rb1', 'A Back', 'RB', 13, { kickoff: EARLY }),
    questionable({ ...candidate('wr1', 'The Questionable Receiver', 'WR', 14, { kickoff: LATE }), usageWeeks: usage }),
    candidate('wr2', 'Second Receiver', 'WR', 12, { kickoff: LATE }),
    candidate('wr3', 'Third Receiver', 'WR', 9, { kickoff: EARLY }),
    candidate('te1', 'A Tight End', 'TE', 8, { kickoff: LATE }),
  ];

  const payload = (() => {
    const xfp = assessXfp('WR', usage, HALF_PPR);
    const role = assessRole(toRoleMetrics('WR', usage));
    const value = valueOverWeeks({
      playerId: 'wr1',
      name: 'The Questionable Receiver',
      position: 'WR',
      currentWeek: 5,
      thisWeekScore: 14,
      usage: assessUsage('WR', usage),
      role,
      schedule,
      xfp,
      byeWeek: 7,
    });

    const player: PlayerIntelligence = {
      playerId: 'wr1',
      name: 'The Questionable Receiver',
      position: 'WR',
      team: 'NE',
      xfp: xfpContract(xfp, XFP_LIMITATIONS),
      roleTrend: roleTrendContract(role),
      value: valueContract(value),
      schedule: scheduleContract(schedule),
      optionality: null,
      confidence: { level: 'high', reasons: [] },
      freshness: [
        { source: 'vegas', state: 'fresh', observedAt: '2025-10-05T13:00:00Z', ageMinutes: 60 },
        { source: 'usage', state: 'stale', observedAt: '2025-10-01T09:00:00Z', ageMinutes: 6000 },
        { source: 'weather', state: 'missing', observedAt: null, ageMinutes: null },
      ],
    };

    const lineup = recommendLineup(roster, SHAPE, HALF_PPR, { now: NOW });
    const evaluations = roster.map((r) => evaluatePlayer({ ...r, now: NOW }, HALF_PPR));

    return channel3Payload({
      season: '2025',
      week: 5,
      generatedAt: NOW,
      players: [player],
      lineup: lineupIntelligence({
        fragility: assessFragility({ lineup, evaluations, shape: SHAPE, currentWeek: 5 }),
        trees: contingencyPlans({ roster, shape: SHAPE, profile: HALF_PPR, now: NOW }),
        mode: suggestMode({
          mine: roster.map((r) => ({ playerId: r.player.id, position: r.player.position, marketPoints: 12 })),
          opponent: roster.map((r) => ({ playerId: `o-${r.player.id}`, position: r.player.position, marketPoints: 9 })),
          shape: SHAPE,
        }),
        boundaries: findBoundaries(
          [candidate('wr1', 'The Questionable Receiver', 'WR', 12.2), candidate('wr2', 'Second Receiver', 'WR', 11.9)],
          HALF_PPR,
        ),
        streaming: [
          assessStreaming({
            position: 'TE',
            roster: [candidate('te1', 'A Tight End', 'TE', 8, { kickoff: LATE })],
            available: [candidate('fa1', 'Wire TE', 'TE', 7.6, { kickoff: LATE })],
            shape: SHAPE,
            profile: HALF_PPR,
            now: NOW,
          }),
        ],
      }),
    });
  })();

  it('validates clean', () => {
    expect(validateChannel3Payload(payload)).toEqual([]);
  });

  it('carries its versions, so a consumer can refuse a shape it does not know', () => {
    expect(payload.contractVersion).toBe(CHANNEL3_CONTRACT_VERSION);
    expect(payload.modelVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('carries every promised output', () => {
    const player = payload.players[0]!;
    expect(player.xfp).not.toBeNull();
    expect(player.roleTrend).not.toBeNull();
    expect(player.value).not.toBeNull();
    expect(player.schedule).not.toBeNull();
    expect(payload.lineup!.fragility).not.toBeNull();
    expect(payload.lineup!.mode).not.toBeNull();
    expect(payload.lineup!.replacementTrees.length).toBeGreaterThan(0);
    expect(payload.lineup!.streaming).toHaveLength(1);
  });

  it('carries freshness beside the numbers rather than a request away', () => {
    const player = payload.players[0]!;
    expect(player.freshness.map((f) => f.state).sort()).toEqual(['fresh', 'missing', 'stale']);
    expect(player.freshness.find((f) => f.state === 'missing')!.observedAt).toBeNull();
  });

  it('states the limitations of the expected-points model wherever the number appears', () => {
    expect(payload.players[0]!.xfp!.limitations.join(' ')).toMatch(/red-zone/);
  });

  it('keeps the bye out of the schedule average and in the week list', () => {
    const schedule = payload.players[0]!.schedule!;
    expect(schedule.byes).toBe(1);
    expect(schedule.weeks.find((w) => w.bye)!.points).toBeNull();
  });
});

describe('a payload with nothing connected', () => {
  const roster: StartSitInput[] = [
    candidate('wr1', 'A Receiver', 'WR', null),
    candidate('wr2', 'Another Receiver', 'WR', null),
  ];

  const payload = channel3Payload({
    season: '2025',
    week: 1,
    generatedAt: NOW,
    players: [
      {
        playerId: 'wr1',
        name: 'A Receiver',
        position: 'WR',
        team: 'NE',
        // Two games of usage: below every minimum in the workstream.
        xfp: xfpContract(assessXfp('WR', weeks(2, { targets: 4 }), HALF_PPR), XFP_LIMITATIONS),
        roleTrend: roleTrendContract(assessRole(toRoleMetrics('WR', weeks(2, { targets: 4 })))),
        value: valueContract(
          valueOverWeeks({ playerId: 'wr1', name: 'A Receiver', position: 'WR', currentWeek: 1, thisWeekScore: null }),
        ),
        schedule: scheduleContract(
          roleScheduleOutlook({
            position: 'WR',
            bucket: 'unclassified',
            schedule: [],
            tendencies: new Map(),
            fromWeek: 1,
          }),
        ),
        optionality: null,
        confidence: { level: 'low', reasons: ['no usage source connected', 'no Vegas markets'] },
        freshness: [{ source: 'usage', state: 'missing', observedAt: null, ageMinutes: null }],
      },
    ],
    lineup: lineupIntelligence({
      mode: suggestMode({ mine: [], opponent: [], shape: SHAPE }),
      boundaries: findBoundaries(roster, HALF_PPR),
    }),
  });

  it('validates clean', () => {
    expect(validateChannel3Payload(payload)).toEqual([]);
  });

  it('says null rather than zero, everywhere', () => {
    const player = payload.players[0]!;
    expect(player.xfp).toBeNull();
    expect(player.roleTrend).toBeNull();
    expect(player.value).toBeNull();
    expect(player.schedule).toBeNull();
  });

  it('defaults the mode rather than reading a matchup out of nothing', () => {
    expect(payload.lineup!.mode!.auto).toBe(false);
    expect(payload.lineup!.mode!.suggested).toBe('balanced');
  });

  it('offers no decision boundaries when nothing can be scored', () => {
    expect(payload.lineup!.boundaries).toEqual([]);
  });
});

describe('the validator earns its place', () => {
  it('catches a NaN that arithmetic let through', () => {
    const payload = channel3Payload({
      season: '2025',
      week: 5,
      generatedAt: NOW,
      players: [
        {
          playerId: 'wr1',
          name: 'A Receiver',
          position: 'WR',
          team: 'NE',
          xfp: {
            expectedPerGame: Number.NaN,
            actualPerGame: 10,
            fpoePerGame: null,
            touchdownsOverExpectationPerGame: null,
            interpretation: 'matched',
            label: 'matched',
            games: 6,
            depthMeasured: true,
            confidence: 'high',
            limitations: [],
          },
          roleTrend: null,
          value: null,
          schedule: null,
          optionality: null,
          confidence: { level: 'high', reasons: [] },
          freshness: [],
        },
      ],
    });
    expect(validateChannel3Payload(payload).join(' ')).toMatch(/NaN/);
  });

  it('catches a missing source that claims to have been observed', () => {
    const payload = channel3Payload({
      season: '2025',
      week: 5,
      generatedAt: NOW,
      players: [
        {
          playerId: 'wr1',
          name: 'A Receiver',
          position: 'WR',
          team: 'NE',
          xfp: null,
          roleTrend: null,
          value: null,
          schedule: null,
          optionality: null,
          confidence: { level: 'high', reasons: [] },
          freshness: [{ source: 'vegas', state: 'missing', observedAt: NOW, ageMinutes: 0 }],
        },
      ],
    });
    expect(validateChannel3Payload(payload).join(' ')).toMatch(/missing but carries an observation time/);
  });
});

describe('the awkward cases the brief enumerates', () => {
  it('fills a hole through the FLEX, respecting which positions it accepts', () => {
    const roster: StartSitInput[] = [
      candidate('qb1', 'A Quarterback', 'QB', 19, { kickoff: LATE }),
      candidate('rb1', 'A Back', 'RB', 15, { kickoff: LATE }),
      candidate('wr1', 'First Receiver', 'WR', 14, { kickoff: LATE }),
      candidate('wr2', 'Second Receiver', 'WR', 12, { kickoff: LATE }),
      candidate('te1', 'A Tight End', 'TE', 8, { kickoff: LATE }),
      // The questionable player holds the flex; the only cover for it is a
      // tight end, which is legal there and would not be legal at WR.
      questionable(candidate('wr3', 'The Questionable Receiver', 'WR', 10, { kickoff: LATE })),
      candidate('te2', 'Backup Tight End', 'TE', 7, { kickoff: LATE }),
    ];
    const trees = contingencyPlans({ roster, shape: SHAPE, profile: HALF_PPR, now: NOW });
    const tree = trees.find((t) => t.playerId === 'wr3')!;
    expect(tree.slot).toBe('FLEX');
    const late = tree.plans.find((p) => p.key === 'inactive_late')!;
    expect(late.feasible).toBe(true);
    expect(late.replacementName).toBe('Backup Tight End');
  });

  it('offers no waiver pivot when the pool is empty, and one when it is not', () => {
    const roster: StartSitInput[] = [
      candidate('qb1', 'A Quarterback', 'QB', 19, { kickoff: LATE }),
      candidate('rb1', 'A Back', 'RB', 13, { kickoff: LATE }),
      questionable(candidate('wr1', 'The Questionable Receiver', 'WR', 14, { kickoff: LATE })),
      candidate('wr2', 'Second Receiver', 'WR', 12, { kickoff: LATE }),
      candidate('wr3', 'Third Receiver', 'WR', 3, { kickoff: LATE }),
      candidate('te1', 'A Tight End', 'TE', 8, { kickoff: LATE }),
    ];
    const without = contingencyPlans({ roster, shape: SHAPE, profile: HALF_PPR, now: NOW }).find((t) => t.playerId === 'wr1')!;
    const with_ = contingencyPlans({
      roster,
      shape: SHAPE,
      profile: HALF_PPR,
      now: NOW,
      waiverCandidates: [candidate('fa1', 'A Free Agent', 'WR', 11, { kickoff: LATE })],
    }).find((t) => t.playerId === 'wr1')!;
    expect(without.waiverPivot).toBeNull();
    expect(with_.waiverPivot!.name).toBe('A Free Agent');
  });

  it('carries a beneficiary graph that says unknown, without pretending otherwise', () => {
    const graph = beneficiaryContract(
      buildBeneficiaryGraph({
        team: 'NE',
        absent: { playerId: 'rb1', name: 'A Back', position: 'RB', weeks: weeks(3, { carries: 18 }) },
        teammates: [],
      }),
    )!;
    expect(graph.unknown).toBe(true);
    expect(graph.beneficiaries).toEqual([]);
    expect(graph.pivot).toBeNull();
    expect(graph.notes.join(' ')).toMatch(/unknown/);
  });

  it('surfaces the emergency pivot only when the beneficiary is unrostered', () => {
    const absence = {
      team: 'DET',
      absent: {
        playerId: 'rb1',
        name: 'Star Back',
        position: 'RB',
        weeks: [1, 2, 3, 4].map((w) => week({ week: w, carries: 19 })),
      },
      teammates: [
        {
          playerId: 'rb2',
          name: 'Second Back',
          position: 'RB',
          weeks: [
            ...[1, 2, 3, 4].map((w) => week({ week: w, carries: 5 })),
            week({ week: 5, carries: 17 }),
            week({ week: 6, carries: 16 }),
          ],
        },
        {
          playerId: 'wr1',
          name: 'A Receiver',
          position: 'WR',
          weeks: [1, 2, 3, 4, 5, 6].map((w) => week({ week: w, targets: 8 })),
        },
      ],
    };
    const graph = buildBeneficiaryGraph(absence);
    const rostered = beneficiaryContract(graph, [])!;
    const free = beneficiaryContract(graph, ['rb2'])!;

    expect(rostered.pivot).toBeNull();
    expect(free.pivot!.playerId).toBe('rb2');
    expect(free.pivot!.detail).toMatch(/unrostered/);

    const payload = channel3Payload({
      season: '2025',
      week: 7,
      generatedAt: NOW,
      players: [],
      beneficiaries: [free],
    });
    expect(validateChannel3Payload(payload)).toEqual([]);
    expect(payload.beneficiaries[0]!.pivot!.name).toBe('Second Back');
  });

  it('rejects a pivot that is not one of the beneficiaries', () => {
    const payload = channel3Payload({
      season: '2025',
      week: 7,
      generatedAt: NOW,
      players: [],
      beneficiaries: [
        {
          absentPlayerId: 'rb1',
          absentName: 'Star Back',
          team: 'DET',
          unknown: false,
          vacated: { carries: 18, targets: 4 },
          beneficiaries: [],
          pivot: { playerId: 'nobody', name: 'Nobody', detail: '', confidence: 'low' },
          notes: [],
        },
      ],
    });
    expect(validateChannel3Payload(payload).join(' ')).toMatch(/not one of the beneficiaries/);
  });
});
