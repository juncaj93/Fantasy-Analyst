/**
 * The Smart Trades probe's own claims, pointed at violations.
 *
 * A gate nobody has ever seen fail is a gate nobody knows the shape of — the
 * lesson `probe.boardInvariants.test.ts` records, applied to the checks §24 asks
 * for. Each one is exercised twice: once on a board that satisfies it, once on a
 * board that breaks it in the specific way the product would break it.
 *
 * A check that cannot fail is not a check, and a real-league review built from
 * checks that cannot fail is a report that always says "clean".
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs probe helper, deliberately not part of the app build
import { duplicateFindings, offerFindings, orderingEffect, reviewFindings } from '../scripts/lib/smartTradeReview.mjs';

interface Player {
  playerId: string;
  name: string;
  position: string;
  value: number;
}

/** A clean offer. Every test below breaks exactly one thing about it. */
function offer(over: Record<string, unknown> = {}): Record<string, unknown> {
  const give: Player[] = [{ playerId: 'a', name: 'Aaron', position: 'WR', value: 12 }];
  const get: Player[] = [{ playerId: 'b', name: 'Bijan', position: 'RB', value: 12.5 }];
  return {
    id: '2:a>b',
    partner: { key: '2', rosterId: 2, displayName: 'Dermot', userId: 'u2' },
    give,
    get,
    fairness: { band: 'even', label: 'Roughly even', incoming: 12.5, outgoing: 12, gap: 0.04 },
    user: { starterGain: 3.1, depthChange: -1, entersLineup: get, displaced: ['x'], opensSlot: false, rationales: ['fills_hole'] },
    counterparty: {
      starterGain: 1.2,
      depthChange: 1,
      entersLineup: give,
      displaced: [],
      opensSlot: false,
      rationales: ['upgrades_starter'],
    },
    managerFit: {
      displayName: 'Dermot',
      activity: 'active',
      contribution: 0.04,
      evidence: { sample: 8, seasonsObserved: 3, historyComplete: true, confidence: 0.7 },
    },
    breakdown: { total: 0.7, managerFit: 0.04 },
    ...over,
  };
}

/** Merge one level down, so a test can break a single field of one side. */
function withSide(base: Record<string, unknown>, side: 'user' | 'counterparty', patch: Record<string, unknown>) {
  return offer({ ...base, [side]: { ...(base[side] as Record<string, unknown>), ...patch } });
}

describe('a clean board produces no findings', () => {
  it('says nothing about an offer that passes every gate', () => {
    expect(reviewFindings({ offers: [offer()] })).toEqual([]);
  });

  it('says nothing about an empty board', () => {
    expect(reviewFindings({ offers: [] })).toEqual([]);
    expect(reviewFindings({})).toEqual([]);
  });
});

describe('stars for piles of junk', () => {
  it('catches an offer banded outside the recommendation range', () => {
    const bad = offer({ fairness: { band: 'outside_range', label: 'Outside', incoming: 24, outgoing: 6, gap: 0.75 } });
    expect(offerFindings(bad).join(' ')).toMatch(/outside the recommendation range/);
  });

  it('catches a gap past the cap even when the band claims otherwise', () => {
    /*
     * Band and gap are two witnesses and the check reads both. A band computed
     * from a different constant than the probe's would otherwise pass silently,
     * which is precisely how a stale invariant survives.
     */
    const bad = offer({ fairness: { band: 'even', label: 'Roughly even', incoming: 24, outgoing: 6, gap: 0.75 } });
    expect(offerFindings(bad).join(' ')).toMatch(/objective gap of 75%/);
  });

  it('accepts a gap inside the range', () => {
    const ok = offer({ fairness: { band: 'edge_user', label: 'Slight edge', incoming: 14, outgoing: 12, gap: 0.14 } });
    expect(offerFindings(ok)).toEqual([]);
  });
});

describe('opponent-harming offers', () => {
  it('catches a deal that costs the partner real lineup points', () => {
    const bad = withSide(offer(), 'counterparty', { starterGain: -4.2 });
    expect(offerFindings(bad).join(' ')).toMatch(/opponent loses 4\.2 pts/);
  });

  it('tolerates a deal that is lineup-neutral for them but has roster logic', () => {
    const ok = withSide(offer(), 'counterparty', { starterGain: 0, rationales: ['surplus_for_need'] });
    expect(offerFindings(ok)).toEqual([]);
  });

  it('catches a deal that is neutral for them and has no roster logic at all', () => {
    const bad = withSide(offer(), 'counterparty', { starterGain: 0, rationales: [] });
    expect(offerFindings(bad).join(' ')).toMatch(/no counterparty logic and no counterparty gain/);
  });
});

describe('bench-for-bench noise', () => {
  it('catches a swap nobody would start either side of', () => {
    const bad = offer({
      user: { starterGain: 1.1, depthChange: 0, entersLineup: [], displaced: [], opensSlot: false, rationales: [] },
      counterparty: { starterGain: 1.1, depthChange: 0, entersLineup: [], displaced: [], opensSlot: false, rationales: ['no_worse_hole'] },
    });
    expect(offerFindings(bad).join(' ')).toMatch(/nothing enters either lineup/);
  });

  it('accepts a swap that enters one lineup', () => {
    const ok = withSide(offer(), 'counterparty', { entersLineup: [] });
    expect(offerFindings(ok)).toEqual([]);
  });
});

describe('unknown must never read as inactive', () => {
  it('catches a manager called inactive on history nobody finished reading', () => {
    const bad = offer({
      managerFit: {
        displayName: 'Kim',
        activity: 'effectively_inactive',
        contribution: -0.04,
        evidence: { sample: 0, seasonsObserved: 2, historyComplete: false, confidence: 0.3 },
      },
    });
    expect(offerFindings(bad).join(' ')).toMatch(/called inactive on incomplete history: Kim/);
  });

  it('catches any classification made with no season observed at all', () => {
    const bad = offer({
      managerFit: {
        displayName: 'Sam',
        activity: 'low_activity',
        contribution: -0.02,
        evidence: { sample: 1, seasonsObserved: 0, historyComplete: true, confidence: 0.2 },
      },
    });
    expect(offerFindings(bad).join(' ')).toMatch(/zero observed seasons: Sam/);
  });

  it('leaves an honestly unknown manager alone', () => {
    const ok = offer({
      managerFit: {
        displayName: 'Pat',
        activity: 'unknown',
        contribution: 0,
        evidence: { sample: 0, seasonsObserved: 0, historyComplete: false, confidence: 0 },
      },
    });
    expect(offerFindings(ok)).toEqual([]);
  });
});

describe('history may not overpower value', () => {
  it('catches a contribution past the documented cap, in either direction', () => {
    for (const contribution of [0.2, -0.2]) {
      const bad = offer({
        managerFit: {
          displayName: 'Dermot',
          activity: 'active',
          contribution,
          evidence: { sample: 9, seasonsObserved: 3, historyComplete: true, confidence: 0.8 },
        },
      });
      expect(offerFindings(bad).join(' ')).toMatch(/exceeds the documented cap/);
    }
  });

  it('accepts a contribution exactly at the cap', () => {
    const ok = offer({
      managerFit: {
        displayName: 'Dermot',
        activity: 'active',
        contribution: 0.08,
        evidence: { sample: 9, seasonsObserved: 3, historyComplete: true, confidence: 0.8 },
      },
    });
    expect(offerFindings(ok)).toEqual([]);
  });
});

describe('illegal packages and stale rosters', () => {
  it('catches an offer that empties a slot on either side', () => {
    expect(offerFindings(withSide(offer(), 'user', { opensSlot: true })).join(' ')).toMatch(/one of your slots empty/);
    expect(offerFindings(withSide(offer(), 'counterparty', { opensSlot: true })).join(' ')).toMatch(
      /one of their slots empty/,
    );
  });

  it('catches an empty side', () => {
    expect(offerFindings(offer({ give: [] })).join(' ')).toMatch(/one side of the package is empty/);
  });

  it('catches a player the engine could not value', () => {
    const bad = offer({ get: [{ playerId: 'b', name: 'Ghost', position: 'RB', value: null }] });
    expect(offerFindings(bad).join(' ')).toMatch(/Ghost has no objective value/);
  });
});

describe('repeated near-duplicates', () => {
  it('tolerates one player in two offers and catches him in three', () => {
    const shared = { playerId: 'star', name: 'Star', position: 'RB', value: 20 };
    const two = [offer({ id: 'a', get: [shared] }), offer({ id: 'b', get: [shared] })];
    const three = [...two, offer({ id: 'c', get: [shared] })];

    expect(duplicateFindings(two)).toEqual([]);
    expect(duplicateFindings(three).join(' ')).toMatch(/Star appears in three or more/);
  });
});

describe('whether history changed the order', () => {
  it('reports no movement when the manager term does not reorder anything', () => {
    const a = offer({ id: 'a', breakdown: { total: 0.8, managerFit: 0.02 } });
    const b = offer({ id: 'b', breakdown: { total: 0.6, managerFit: -0.02 } });
    expect(orderingEffect([a, b]).moved).toBe(0);
  });

  it('reports movement when it does', () => {
    /*
     * Without the manager term `b` leads (0.66 against 0.62); with it `a` does.
     * A near tie settled by behaviour, which is exactly what the cap permits and
     * exactly what this number exists to make visible.
     */
    const a = offer({ id: 'a', breakdown: { total: 0.7, managerFit: 0.08 } });
    const b = offer({ id: 'b', breakdown: { total: 0.66, managerFit: 0 } });
    const effect = orderingEffect([a, b]);

    expect(effect.moved).toBeGreaterThan(0);
    expect(effect.withFit).toEqual(['a', 'b']);
    expect(effect.withoutFit).toEqual(['b', 'a']);
  });
});
