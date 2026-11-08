/**
 * Round 14, the D1 budget: the workflow half.
 *
 *   1. The full production sweep runs once a week, not every night.
 *   2. A commit that changes nothing the site runs is not deployed and pays no
 *      live check; a commit that changes app code still deploys, and its live
 *      checks (the revision check, the site check, the iPhone gate) still run
 *      and still fail the run when production is broken.
 */

import { describe, expect, it } from 'vitest';
import { readWorkflow, steps, type YamlValue } from './helpers/workflowYaml.ts';
import { decide, deployNeeded, isShipped, liveRevision } from '../.github/scripts/deploy-needed.mjs';

const asMap = (value: YamlValue | undefined): Record<string, YamlValue> =>
  (value ?? {}) as Record<string, YamlValue>;
const job = (yaml: Record<string, YamlValue>, name: string) => asMap(asMap(yaml['jobs'])[name]);

const LIVE = '97d1a39cd13e16bd827042871737896887ae8154';
const CANDIDATE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const health = (gitSha: unknown) => async () => ({ ok: true, service: 'fantasy-analyst', release: { gitSha } });

describe('Round 14: the production sweep is weekly', () => {
  it('has exactly one schedule, Wednesday 00:47 UTC (Tuesday 7:47 PM Eastern)', () => {
    const { text } = readWorkflow('smoke-daily.yml');
    const crons = [...text.matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1]);
    expect(crons).toEqual(['47 0 * * 3']);
  });

  it('is not on a game night or the day after one, in Eastern time', () => {
    const { text } = readWorkflow('smoke-daily.yml');
    const dow = /- cron: '\S+ \S+ \S+ \S+ (\S+)'/.exec(text)![1]!;
    expect(dow).not.toBe('*');
    // 00:47 UTC is the previous evening in Eastern time. UTC Mon/Tue/Fri are
    // Sun/Mon/Thu nights Eastern, when games are on.
    expect(['1', '2', '5']).not.toContain(dow);
  });

  it('is still a full pass that can still be started by hand', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    expect(asMap(job(yaml, 'sweep')['with'])['full']).toBe(true);
    expect(Object.keys(asMap(yaml['on']))).toContain('workflow_dispatch');
  });
});

describe('Round 14: which files the site ships', () => {
  it.each([
    'docs/STATUS.md',
    'README.md',
    'tests/startsit.test.ts',
    'e2e/team-startsit.spec.ts',
    'e2e-production/smoke.spec.ts',
    '.github/workflows/smoke-daily.yml',
    '.github/scripts/deploy-needed.mjs',
    'scripts/probe-d1-budget-round14.mjs',
    'playwright.production.config.ts',
    'vitest.config.ts',
  ])('%s is not shipped', (file) => {
    expect(isShipped(file)).toBe(false);
  });

  it.each([
    'src/server/app.ts',
    'src/web/screens/MatchupScreen.tsx',
    'src/core/waivers/tiers.ts',
    'src/docs/notes.md',
    'migrations/0042_whatever.sql',
    'wrangler.toml',
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'tsconfig.build.json',
    'scripts/build-server.mjs',
    'scripts/check-deployed-site.mjs',
    'data/teams.json',
    'public/icon.png',
    'something-new-at-the-root.ts',
  ])('%s is shipped', (file) => {
    expect(isShipped(file)).toBe(true);
  });

  it('needs a deploy when any one file is app code', () => {
    expect(deployNeeded(['docs/a.md', 'tests/b.test.ts', 'src/server/app.ts']).needed).toBe(true);
    expect(deployNeeded(['docs/a.md', 'tests/b.test.ts', '.github/workflows/ci.yml', '']).needed).toBe(false);
  });
});

describe('Round 14: Deploy skips only on a positive answer', () => {
  it('skips a docs, tests and workflow commit', async () => {
    const result = await decide({
      candidate: CANDIDATE,
      fetchHealth: health(LIVE),
      changedFiles: () => ['docs/STATUS.md', 'tests/x.test.ts', '.github/workflows/smoke-daily.yml'],
    });
    expect(result.needed).toBe(false);
    expect(result.live).toBe(LIVE);
  });

  it('deploys a code commit', async () => {
    const result = await decide({
      candidate: CANDIDATE,
      fetchHealth: health(LIVE),
      changedFiles: () => ['docs/STATUS.md', 'src/web/screens/MatchupScreen.tsx'],
    });
    expect(result.needed).toBe(true);
  });

  it('diffs against what production reports, so skipped commits are not forgotten', async () => {
    let asked: [string, string] | null = null;
    await decide({
      candidate: CANDIDATE,
      fetchHealth: health(LIVE.toUpperCase()),
      changedFiles: (from: string, to: string) => {
        asked = [from, to];
        return ['src/server/app.ts'];
      },
    });
    expect(asked).toEqual([LIVE, CANDIDATE]);
  });

  it.each([
    ['the site is down', async () => { throw new Error('fetch failed'); }],
    ['no revision reported', async () => ({ ok: true })],
    ['revision unknown', health('unknown')],
    ['revision is not a sha', health('main')],
  ])('deploys when %s', async (_label, fetchHealth) => {
    const result = await decide({ candidate: CANDIDATE, fetchHealth, changedFiles: () => ['docs/x.md'] });
    expect(result.needed).toBe(true);
  });

  it('deploys when git cannot compare the two revisions', async () => {
    const result = await decide({
      candidate: CANDIDATE,
      fetchHealth: health(LIVE),
      changedFiles: () => { throw new Error('bad object'); },
    });
    expect(result.needed).toBe(true);
  });

  it('reads the revision the same way the release check does', () => {
    expect(liveRevision({ release: { gitSha: ` ${LIVE} ` } })).toBe(LIVE);
    expect(liveRevision({ release: {} })).toBeNull();
    expect(liveRevision(null)).toBeNull();
  });
});

describe('Round 14: Deploy wiring', () => {
  const { yaml } = readWorkflow('deploy.yml');
  const check = steps(yaml, 'decide').find((step) => step['id'] === 'check');
  const script = String(check?.['run'] ?? '');

  it('asks before releasing main’s head, and falls back to deploying', () => {
    expect(script).toContain('node .github/scripts/deploy-needed.mjs "$CANDIDATE" || echo yes');
    const ask = script.indexOf('deploy-needed.mjs');
    const release = script.indexOf('proceed=yes');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(release);
    // Only an explicit `no` stands down.
    expect(script).toContain('if [ "$needed" = "no" ]; then');
  });

  it('still asks only after CI passed, so a red CI still deploys nothing', () => {
    expect(script.indexOf('case "$CI_CONCLUSION" in')).toBeLessThan(script.indexOf('deploy-needed.mjs'));
  });

  it('keeps every live check on the code path: revision, site check, iPhone gate', () => {
    const release = readWorkflow('release.yml').text;
    expect(release).toContain('node scripts/check-release-sha.mjs "$url" "$RELEASE_SHA"');
    expect(release).toContain('node scripts/check-deployed-site.mjs "$url"');
    expect(job(yaml, 'smoke')['uses']).toBe('./.github/workflows/smoke.yml');
    expect(String(job(yaml, 'smoke')['needs'])).toContain('release');
    // The gate is not turned off or made optional.
    expect(job(yaml, 'smoke')['if']).toBeUndefined();
    expect(job(yaml, 'smoke')['continue-on-error']).toBeUndefined();
    const smoke = readWorkflow('smoke.yml').text;
    expect(smoke).toContain('--project=webkit-iphone-390 --grep @critical');
  });
});
