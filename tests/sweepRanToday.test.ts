/**
 * The daily sweep's "has a full pass already run today?" check.
 *
 * Until October 2026 it counted only hand-dispatched `smoke.yml` runs, so a
 * hand-started daily sweep and the scheduled one could both run a full pass on
 * the same day, each about a third of the D1 allowance.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the script the workflow runs, with no dependencies of its own
import { isFullPassShard, passesToday } from '../scripts/sweep-ran-today.mjs';

const TODAY = '2026-10-08';
const shard = (conclusion: string | null, status = 'completed', n = 1) => ({ name: `sweep / smoke (${n}/3)`, conclusion, status });

describe('what counts as a full pass today', () => {
  it('names the full-pass shards and not the deploy gate', () => {
    expect(isFullPassShard('sweep / smoke (2/3)')).toBe(true);
    expect(isFullPassShard('smoke (deploy gate)')).toBe(false);
    expect(isFullPassShard('recent')).toBe(false);
  });

  it('counts a hand-dispatched smoke run, as before', () => {
    const r = passesToday({
      today: TODAY,
      currentRunId: 9,
      manualSmokeRuns: [{ id: 1, created_at: `${TODAY}T10:00:00Z` }],
      dailyRuns: [],
    });
    expect(r).toEqual({ manual: 1, daily: 0, total: 1 });
  });

  it('counts an earlier daily sweep whose shards ran, passed or failed', () => {
    const r = passesToday({
      today: TODAY,
      currentRunId: 9,
      manualSmokeRuns: [],
      dailyRuns: [
        { id: 2, created_at: `${TODAY}T00:47:00Z`, jobs: [{ name: 'recent', conclusion: 'success' }, shard('success')] },
        { id: 3, created_at: `${TODAY}T06:00:00Z`, jobs: [shard('failure')] },
      ],
    });
    expect(r.daily).toBe(2);
  });

  it('counts one still running', () => {
    const r = passesToday({
      today: TODAY,
      currentRunId: 9,
      manualSmokeRuns: [],
      dailyRuns: [{ id: 2, created_at: `${TODAY}T00:47:00Z`, jobs: [shard(null, 'in_progress')] }],
    });
    expect(r.daily).toBe(1);
  });

  it('does not count a run that stood down, was cancelled early, or is this run', () => {
    const r = passesToday({
      today: TODAY,
      currentRunId: 9,
      manualSmokeRuns: [],
      dailyRuns: [
        { id: 4, created_at: `${TODAY}T00:47:00Z`, jobs: [{ name: 'recent', conclusion: 'success' }, shard('skipped')] },
        { id: 5, created_at: `${TODAY}T01:00:00Z`, jobs: [shard('cancelled')] },
        { id: 9, created_at: `${TODAY}T02:00:00Z`, jobs: [shard(null, 'in_progress')] },
      ],
    });
    expect(r.total).toBe(0);
  });

  it('does not count yesterday', () => {
    const r = passesToday({
      today: TODAY,
      currentRunId: 9,
      manualSmokeRuns: [{ id: 1, created_at: '2026-10-07T23:59:00Z' }],
      dailyRuns: [{ id: 2, created_at: '2026-10-07T00:47:00Z', jobs: [shard('success')] }],
    });
    expect(r.total).toBe(0);
  });
});
