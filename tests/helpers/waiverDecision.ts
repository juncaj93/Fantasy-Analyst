/**
 * The waiver decision, reduced to what a card or a sheet could ever print.
 *
 * Captured through the real router against the seeded league (the support
 * snapshot a tap on Waivers produces), then replayed from the file alone. Both
 * the capture and the replay go through `assembleWaiverPlan`, so this is the
 * engine's answer and nothing hand-built.
 */

import { SleeperClient } from '../../src/core/sleeper/client.ts';
import { MockVegasProvider } from '../../src/core/vegas/mockProvider.ts';
import { createApp, type AppEnv } from '../../src/server/app.ts';
import { seedDemoData, MOCK_GAMES } from '../../src/devserver/seed.ts';
import { createTestDb } from './db.ts';
import type { TierRow, WaiverTiersView } from '../../src/core/waivers/tierPlan.ts';
import type { WaiverClaimPlan } from '../../src/core/waivers/claimPlan.ts';

export interface CapturedWaivers {
  tiers: WaiverTiersView;
  claimPlan: WaiverClaimPlan;
  snapshot: Record<string, unknown>;
}

export async function captureDemoWaivers(): Promise<CapturedWaivers> {
  const db = await createTestDb();
  await seedDemoData(db);
  const env: AppEnv = {
    db,
    sleeper: new SleeperClient({ fetch: async () => new Response('null', { status: 200 }) }),
    vegas: new MockVegasProvider(MOCK_GAMES),
    APP_PASSPHRASE: 'correct horse battery staple',
    SESSION_SECRET: 'test-secret-value-at-least-32-chars-long',
    releaseSha: '0000000000000000000000000000000000000000',
  };
  const res = await createApp()(new Request('https://app.test/api/leagues/demo-league/support-snapshot?context=waiver-plan'), env);
  if (res.status !== 200) throw new Error(`support snapshot: HTTP ${res.status}`);
  const snapshot = (await res.json()) as { decision: { output: { tiers: WaiverTiersView; claimPlan: WaiverClaimPlan } } };
  return { tiers: snapshot.decision.output.tiers, claimPlan: snapshot.decision.output.claimPlan, snapshot };
}

/** Every row the tiers hold, in screen order. */
export function tierRows(tiers: WaiverTiersView): TierRow[] {
  return [...(tiers.doThese ?? (tiers.doThis ? [tiers.doThis] : [])), ...tiers.consider, ...tiers.watch];
}

/** What the tiers recommend, field by field: tier, order, gain, reason, drop, bid, alternatives. */
export function decisionDigest(tiers: WaiverTiersView, plan: WaiverClaimPlan) {
  return {
    rows: tierRows(tiers).map((r) => ({
      playerId: r.playerId,
      name: r.name,
      tier: r.tier,
      reasonCode: r.reasonCode,
      reason: r.reason,
      gain: r.gain,
      byWeek: r.byWeek,
      drop: r.drop ? { name: r.drop.name, viaReserve: r.drop.viaReserve ?? false } : null,
      needsSpot: r.needsSpot?.map((c) => c.name) ?? null,
      bestDrops: r.bestDrops?.map((c) => c.name) ?? null,
      alternatives: r.alternatives,
      competesWith: r.competesWith,
      bid: { kind: r.bid.kind, recommended: r.bid.recommended, low: r.bid.low, high: r.bid.high, reason: r.bid.reason },
    })),
    dropReady: tiers.dropReady.map((d) => d.name),
    window: tiers.window,
    freeAgentRule: tiers.freeAgentRule,
    claims: plan.claims.map((c) => ({ rank: c.rank, headline: c.headline, detail: c.detail, qualifier: c.qualifier })),
    groups: (plan.groups ?? []).map((g) => g.headline),
  };
}
