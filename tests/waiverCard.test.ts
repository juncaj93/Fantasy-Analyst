/**
 * The waiver card round (21 October 2026): visual only.
 *
 * Three claims, each against the engine's real answer for the seeded league,
 * captured as the support snapshot a tap on Waivers produces:
 *
 * 1. **Nothing recommended changed.** `waiverDecision.before.json` was written
 *    from the commit before this round (5bdcd60), through the same capture.
 *    Tiers, order, gains, reasons, drops, bids, alternatives, the claim plan
 *    and the league rule must match it field for field, and the file must
 *    replay to the same answer.
 * 2. **The card prints the engine's numbers.** Its gain chip is the same
 *    number the old card showed, without the unit; at most two chips, from the
 *    fixed set; a reason of 32 characters at most.
 * 3. **Nothing left the product.** Every line the old card printed (the
 *    pickup line, the reason, the "Or ..." line, Team's best drops) is in the
 *    move's detail sheet; everything the old screen printed around the cards
 *    (the Watch list subtitle, the wallet paragraph, the league rule) is in
 *    the info sheet.
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureDemoWaivers, decisionDigest, tierRows, type CapturedWaivers } from './helpers/waiverDecision.ts';
import { readSnapshot, replaySnapshot } from '../src/core/support/dispatch.ts';
import { byGain, CARD_CHIPS_MAX, CARD_REASON_MAX, clearDay, shortReason, tierCard, waiverChip } from '../src/web/waiverCard.ts';
import { WaiverCard } from '../src/web/components/waiverCard.tsx';
import { tierBadge, TierDetailBody } from '../src/web/components/waiverTiers.tsx';
import { budgetLines, claimLine, claimsDepend, WaiversInfoBody } from '../src/web/components/waivers.tsx';
import type { TierRow, WaiverTiersView } from '../src/core/waivers/tierPlan.ts';
import type { FaabAdvice } from '../src/web/api.ts';

const before = JSON.parse(readFileSync('tests/fixtures/waiverDecision.before.json', 'utf8'));

/** Rendered markup, as the words a reader sees. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * The lines the card printed before this round, rebuilt from the code it ran
 * (`PickupLine`, the reason, the `extra` line, Team's `BestDrops`). Kept here
 * on purpose, apart from the shipped code, so the test cannot agree with
 * itself.
 */
function oldCardLines(row: TierRow): string[] {
  const bid = row.bid;
  const pickup: string[] = [];
  if (bid.kind === 'free') pickup.push('Free agent');
  if (bid.kind === 'claim') {
    if (bid.until) pickup.push(`On waivers until ${clearDay(bid.until)}`);
    pickup.push(`$${bid.recommended} to ${bid.posture === 'stash' ? 'stash' : 'win'}`);
  }
  pickup.push(
    row.needsSpot
      ? row.tier === 'watch'
        ? 'needs a roster spot'
        : row.tier === 'do_this'
          ? 'you pick the spot'
          : 'needs a spot first'
      : row.drop?.viaReserve
        ? `${row.drop.name} to IR first`
        : row.drop
          ? `in for ${row.drop.name}`
          : 'uses an open spot',
  );
  const extra = row.alternatives.length > 0 ? `Or ${row.alternatives.join(', ')}` : row.competesWith.length > 0 ? `Same spot as ${row.competesWith.join(', ')}` : null;
  return [pickup.join(' · '), row.reason, ...(extra ? [extra] : []), ...(row.bestDrops ?? []).slice(0, 3).map((c) => c.name)];
}

/** Hand-made rows for the cases the seeded league does not reach: a claim, a stash, an IR move, best drops. */
function edgeRows(base: TierRow): TierRow[] {
  const claim = (over: Partial<TierRow['bid']>): TierRow['bid'] => ({
    kind: 'claim', recommended: 3, low: 2, high: 7, reason: 'Two or more other managers are likely to bid.', ceiling: 9, overCeiling: false, likely: [], thin: null, until: '2026-10-14T07:10:00.000Z', posture: 'consider', ...over,
  });
  return [
    { ...base, playerId: 'e1', name: 'Courtland Sutton', tier: 'watch', reasonCode: 'upgrade', reason: 'Starts over Braelon Allen, +1.7 pts in week 7', needsSpot: [], drop: null, bid: claim({ recommended: 1, posture: 'stash' }), alternatives: [], competesWith: [] },
    { ...base, playerId: 'e2', name: 'KC Concepcion', tier: 'watch', reasonCode: 'bye_depth', reason: 'Your WR Nico Collins is on bye in week 8', alternatives: ['Tyjae Spears', "Tre' Harris", 'Tyler Allgeier'], drop: { playerId: 'x', name: 'Jaylen Wright', position: 'RB' } },
    { ...base, playerId: 'e3', name: 'Jordan Love', tier: 'do_this', reasonCode: 'hole_bye', reason: 'Your QB Joe Burrow is on bye in week 6', drop: { playerId: 's', name: 'Will Shipley', position: 'RB', viaReserve: true }, bid: claim({}) },
    {
      ...base, playerId: 'e4', name: 'Mark Andrews', tier: 'do_this', reasonCode: 'hole_bye', reason: 'Your TE Sam LaPorta is on bye in week 6', drop: { playerId: 'h', name: "Tre' Harris", position: 'WR' },
      bestDrops: [
        { playerId: 'h', name: "Tre' Harris", position: 'WR', stat: '1.2 pts', reason: 'lowest season points on your bench' },
        { playerId: 'b', name: 'Brian Robinson', position: 'RB', stat: 'handcuff', reason: 'handcuff to Bijan Robinson' },
      ],
    },
    { ...base, playerId: 'e5', name: 'Zach Ertz', tier: 'watch', reasonCode: 'upgrade', reason: 'Makes your lineup better by 0.6 pts over the three weeks', competesWith: ['Will Shipley'], alternatives: [] },
    { ...base, playerId: 'e6', name: 'Travis Etienne', tier: 'watch', reasonCode: 'ir_stash', stashLabel: 'return unknown', reason: 'Out now, return unknown; a name to watch, not a stash yet', bid: claim({ recommended: 0, low: 0, high: 1, posture: 'stash', until: null }) },
    { ...base, playerId: 'e7', name: 'Kendre Miller', tier: 'do_this', reasonCode: 'start_now', reason: 'Starts this week: +0.9 pts on your best lineup', drop: null, needsSpot: [{ playerId: 'w', name: 'Jaylen Wright', position: 'RB', stat: '0.4 pts', reason: 'no start in weeks 6 to 8' }] },
  ];
}

describe('the waiver card round changes nothing that is recommended', () => {
  let captured: CapturedWaivers;
  beforeAll(async () => {
    captured = await captureDemoWaivers();
  });

  it('matches the engine output recorded before the round, field for field', () => {
    expect(tierRows(captured.tiers).length).toBeGreaterThan(0);
    expect(decisionDigest(captured.tiers, captured.claimPlan)).toEqual(before);
  });

  it('replays from the snapshot file alone to the same answer', async () => {
    const report = await replaySnapshot(readSnapshot(JSON.parse(JSON.stringify(captured.snapshot))));
    expect(report.outcome, report.summary).toBe('reproduced');
    expect(report.differences).toEqual([]);
  });

  it('prints the same gain the old card did, two chips at most, and a short reason', () => {
    for (const row of tierRows(captured.tiers)) {
      const card = tierCard(row);
      expect(card.gain).toBe(tierBadge(row).replace(/ pts$/, ''));
      expect(card.chips.length).toBeLessThanOrEqual(CARD_CHIPS_MAX);
      if (card.reason) expect(card.reason.length).toBeLessThanOrEqual(CARD_REASON_MAX);
      expect(card.fullReason).toBe(row.reason);
    }
  });

  it('puts every line the old card printed in the move’s detail sheet', () => {
    const rows = tierRows(captured.tiers);
    for (const row of [...rows, ...edgeRows(rows[0]!)]) {
      const sheet = text(renderToStaticMarkup(createElement(TierDetailBody, { row, tiers: captured.tiers as WaiverTiersView })));
      for (const line of oldCardLines(row)) expect(sheet, `${row.name}: "${line}" is not on the sheet`).toContain(line);
    }
  });
});

describe('the card, 22 October 2026', () => {
  it('carries no photo: pill, logo, name, gain, chips, reason', async () => {
    const { tiers } = await captureDemoWaivers();
    for (const row of tierRows(tiers)) {
      const html = renderToStaticMarkup(
        createElement(WaiverCard, { model: tierCard(row), onOpen: () => {}, testId: 't', gainTestId: 'g', reasonTestId: 'r' }),
      );
      expect(html).not.toMatch(/player-face|cmp2-face|<img[^>]+sleepercdn/);
      expect(html.indexOf('pos-pill')).toBeLessThan(html.indexOf('player-name'));
    }
  });

  it('says a claim in one short chip: the waiver status and the bid band, the day on the sheet', () => {
    expect(waiverChip('2026-10-14T19:10:00.000Z', '$3–7')).toBe('Waivers $3–7');
    expect(waiverChip(null, '$0–1')).toBe('Waivers $0–1');
    expect(waiverChip('2026-10-14T19:10:00.000Z', null)).toMatch(/^Waivers until \w{3}$/);
  });

  it('sorts a tier by the gain on its chip, keeping the engine order for equal gains', () => {
    const rows = [
      { name: 'Andrews', gain: 3.9 },
      { name: 'Henry', gain: 2.4 },
      { name: 'Strange', gain: 3.3 },
      { name: 'Mayer', gain: 0 },
      { name: 'Ertz', gain: 2.4 },
    ];
    expect(byGain(rows).map((r) => r.name)).toEqual(['Andrews', 'Strange', 'Henry', 'Ertz', 'Mayer']);
  });
});

describe('the card’s few words', () => {
  it.each([
    ['Your TE Sam LaPorta is on bye in week 6', 'hole_bye', 'LaPorta on bye wk 6'],
    ['Starts over Braelon Allen, +1.7 pts in week 7', 'upgrade', 'Starts over B. Allen wk 7'],
    ['Nobody on your roster can start at QB in week 1', 'hole_empty', 'No QB to start wk 1'],
    ['Your RB Christian McCaffrey is Out', 'hole_injury', 'McCaffrey out'],
    ['Your WR Amon-Ra St. Brown is Doubtful for week 7', 'bye_depth', 'St. Brown doubtful wk 7'],
    ['Backup for your RB Kenneth Walker, who is questionable', 'injury_backup', 'Backs up Walker'],
    ['Better depth than Jaylen Wright; he would not start yet', 'depth', 'Depth over J. Wright'],
    ['Starts this week: +0.3 pts on your best lineup', 'start_now', 'Starts this week'],
    ['Makes your lineup better by 0.6 pts over the three weeks', 'upgrade', null],
  ] as const)('%s', (reason, reasonCode, short) => {
    expect(shortReason({ reason, reasonCode, stashLabel: null })).toBe(short);
  });

  it('clips anything it does not recognize to the limit, with an ellipsis', () => {
    const r = shortReason({ reason: 'A sentence this card has never seen before and cannot shorten', reasonCode: 'depth', stashLabel: null })!;
    expect(r.length).toBeLessThanOrEqual(CARD_REASON_MAX);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('the info sheet holds what left the screen', () => {
  const faab = {
    rule: { total: 100, usesFaab: true, provenance: 'League settings' },
    mine: { remaining: 77 },
    prices: { sample: 45, low: 0, high: 5 },
    losingBids: 'Highest losing bid seen: $11 (other managers’ failed claims are not all published).',
  } as unknown as FaabAdvice;
  const rule = 'In this league a dropped player is on waivers for 2 days, and a player whose game has started waits for the Wednesday run; anyone else is an instant add.';

  it('says the rule, the wallet, the Watch list and the chip, in lines', () => {
    const sheet = text(renderToStaticMarkup(createElement(WaiversInfoBody, { faab, rule, window: { weeks: [6, 7, 8], weights: [1, 0.5, 0.5] } })));
    for (const line of [
      'on waivers for 2 days',
      'waits for the Wednesday run',
      'instant add',
      '$77 of $100 left.',
      'Winning bids here have run $0–5 across 45.',
      'Highest losing bid seen: $11',
      'Watch list: better on paper; no move needed now.',
      'what the move adds to your best lineup over weeks 6–8',
      'Week 6 counts in full; weeks 7 and 8 count half.',
    ]) expect(sheet).toContain(line);
    expect(budgetLines(faab)).toHaveLength(3);
  });
});

describe('the "Do this" summary', () => {
  const claim = (addName: string, dropPlayerId: string | null, dropName: string | null, qualifier: string | null = null) =>
    ({ addName, dropPlayerId, dropName, qualifier, relation: qualifier ? 'fallback' : 'primary' }) as never;

  it('shows only for claims that depend on each other', () => {
    expect(claimsDepend({ claims: [claim('Mark Andrews', null, null)] })).toBe(false);
    expect(claimsDepend({ claims: [claim('Jordan Love', 'a', 'Will Shipley'), claim('Mark Andrews', 'b', 'Emeka Egbuka')] })).toBe(false);
    expect(claimsDepend({ claims: [claim('Keenan Allen', 'w', 'Jaylen Wright'), claim('Tyjae Spears', 'w', 'Jaylen Wright', 'Only if 1 loses')] })).toBe(true);
  });

  it('says each claim in names only', () => {
    expect(claimLine(claim('Keenan Allen', 'w', 'Jaylen Wright'))).toBe('Add Allen, drop Wright');
    expect(claimLine(claim('Tyjae Spears', 'w', 'Jaylen Wright', 'Only if 1 loses'))).toBe('Add Spears, drop Wright, if 1 loses');
  });
});
