/**
 * One tap, and the four rules it has to obey.
 *
 * The button is the easiest thing in this pass to get subtly wrong, because
 * every failure mode looks like success from the outside: a double tap that
 * spends twice, a provider refusal reported as "updated", a dead source that
 * takes the whole page down with it, a refresh that quietly registers a job.
 * Each of those is a test here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MockVegasProvider } from '../src/core/vegas/mockProvider.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { StartSitRefreshService, DEDUPE_SECONDS } from '../src/server/services/startSitRefresh.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import { PropsRepo } from '../src/server/repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../src/server/repos/settings.ts';
import { seedDemoData, MOCK_GAMES } from '../src/devserver/seed.ts';
import { createTestDb } from './helpers/db.ts';

/** A provider that counts, so "did this spend anything" is observable. */
class CountingProvider extends MockVegasProvider {
  calls = 0;

  constructor() {
    super(MOCK_GAMES);
  }

  override async getPropsForTeams(
    teamIds: string[],
    opts: Parameters<MockVegasProvider['getPropsForTeams']>[1] = {},
  ) {
    this.calls++;
    return super.getPropsForTeams(teamIds, opts);
  }
}

/**
 * A provider that is actually dead, on every method that reaches the network.
 *
 * `getPropsForTeams` alone is not enough and used to look like enough only
 * because the seeded demo had no stored events: with nothing in `vegas_events`,
 * schedule discovery was the only path and breaking it broke everything. The
 * seed now carries a game line for the defence it rosters, so the planner has a
 * known event to go straight to — and a provider that answers *that* is not a
 * dead source, it is a degraded one, which is a different test.
 */
class BrokenProvider extends MockVegasProvider {
  constructor() {
    super(MOCK_GAMES);
  }

  override isConfigured(): boolean {
    return true;
  }

  override async getPropsForTeams(): Promise<never> {
    throw new Error('provider is on fire');
  }

  override async getPlayerProps(): Promise<never> {
    throw new Error('provider is on fire');
  }
}

const source = <T extends { source: string }>(report: { sources: T[] }, name: string): T =>
  report.sources.find((s) => s.source === name)!;

describe('the Start/Sit refresh', () => {
  let db: NodeSqliteDatabase;
  beforeEach(async () => {
    db = await createTestDb();
    await seedDemoData(db);
  });

  it('reports every source it orchestrates, including the one it has no feed for', async () => {
    const report = await new StartSitRefreshService(db, { vegas: new CountingProvider() }).refresh();
    expect(report.sources.map((s) => s.source).sort()).toEqual(
      ['injury', 'sleeper', 'usage', 'vegas', 'weather'].sort(),
    );
    // Weather is honest about not existing rather than absent from the list.
    expect(source(report, 'weather').outcome).toBe('skipped');
    expect(source(report, 'weather').detail).toMatch(/no forecast source/i);
  });

  it('collapses a rapid second tap into the first answer', async () => {
    const provider = new CountingProvider();
    const service = new StartSitRefreshService(db, { vegas: provider });
    const first = await service.refresh();
    const second = await service.refresh();

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.headline).toBe(first.headline);
    // The second tap did not buy anything.
    expect(provider.calls).toBeLessThanOrEqual(1);
  });

  it('runs again once the dedupe window has passed', async () => {
    const provider = new CountingProvider();
    let now = new Date('2026-09-13T15:00:00Z');
    const service = new StartSitRefreshService(db, { vegas: provider, now: () => now });
    await service.refresh();
    now = new Date(now.getTime() + (DEDUPE_SECONDS + 5) * 1_000);
    const later = await service.refresh();
    expect(later.deduped).toBe(false);
  });

  it('does not re-buy lines that were refreshed a minute ago', async () => {
    const now = new Date('2026-09-13T15:00:00Z');
    await new SettingsRepo(db).set(
      SETTING_KEYS.lastVegasRefresh,
      new Date(now.getTime() - 60_000).toISOString(),
    );
    const provider = new CountingProvider();
    const report = await new StartSitRefreshService(db, { vegas: provider, now: () => now }).refresh();

    expect(source(report, 'vegas').outcome).toBe('current');
    expect(provider.calls).toBe(0);
  });

  it('keeps one dead source from taking the others down', async () => {
    const report = await new StartSitRefreshService(db, { vegas: new BrokenProvider() }).refresh();
    expect(report.complete).toBe(false);
    // Vegas failed; usage and injury still answered for themselves.
    expect(['unavailable', 'blocked']).toContain(source(report, 'vegas').outcome);
    expect(source(report, 'usage').outcome).not.toBe('unavailable');
    expect(report.headline).toMatch(/delayed|current|Updated/);
  });

  it('leaves the stored lines exactly where they were when the provider fails', async () => {
    const linesBefore = await new PropsRepo(db).freshness();
    const before = await new VegasUsageRepo(db).view();
    await new StartSitRefreshService(db, { vegas: new BrokenProvider() }).refresh();
    const after = await new VegasUsageRepo(db).view();
    const linesAfter = await new PropsRepo(db).freshness();

    /*
     * The claim is that nothing was *bought*, and it is asserted on the lines
     * rather than only on the ledger — the ledger is the weaker half.
     *
     * The budget layer charges itself for an attempt whether or not it comes
     * back with anything, so the count moves by one per path the planner tried.
     * There are two now that the seed stores an event: schedule discovery, and
     * the known event the planner can go straight to. Both failed, nothing was
     * stored, and the lines on screen are the ones that were there before.
     */
    expect(linesAfter?.fetchedAt).toBe(linesBefore?.fetchedAt);
    expect(after.used - before.used).toBeLessThanOrEqual(2);
  });

  it('reports a budget refusal as blocked rather than as an update', async () => {
    /*
     * Spend the month, then tap refresh. The budget layer says no; the button
     * must say so in the same words rather than reporting a successful pass —
     * showing "Updated" over month-old lines is the one outcome that would make
     * this feature actively harmful.
     */
    const usage = new VegasUsageRepo(db);
    await usage.recordProviderUsage({ entities: 2_500, limit: 2_500 });
    const provider = new CountingProvider();
    const report = await new StartSitRefreshService(db, { vegas: provider }).refresh();

    const vegas = source(report, 'vegas');
    expect(['blocked', 'current']).toContain(vegas.outcome);
    expect(vegas.outcome).not.toBe('updated');
  });

  it('says so plainly when there is no odds provider at all', async () => {
    const report = await new StartSitRefreshService(db, {}).refresh();
    expect(source(report, 'vegas').outcome).toBe('skipped');
    expect(source(report, 'sleeper').outcome).toBe('skipped');
  });

  it('creates no scheduled work of its own', async () => {
    const settings = new SettingsRepo(db);
    const before = await settings.all();
    await new StartSitRefreshService(db, { vegas: new CountingProvider() }).refresh();
    const after = await settings.all();

    /*
     * A refresh may write freshness stamps — that is what the services it calls
     * do, and it is how "already current" stays true on the next tap. What it
     * may not do is invent a key of its own, which is what registering work
     * would look like from here. `vegas.lastSchedule` is on the allowlist and
     * is not a schedule: it records when the week's fixtures were last *bought*.
     */
    const allowed = new Set<string>([SETTING_KEYS.lastVegasRefresh, SETTING_KEYS.lastVegasSchedule]);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.filter((key) => !allowed.has(key))).toEqual([]);
  });
});
