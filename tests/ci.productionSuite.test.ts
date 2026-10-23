/**
 * CI runs the production suite against a seeded server on every pull request.
 *
 * `e2e-production/` used to run only after a deploy, so a UI change that made
 * one of its assertions stale was found by the nightly sweep instead of by the
 * pull request that caused it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('the production suite in CI', () => {
  it('runs on pull requests, against the local seeded server and never the live site', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const step = /FA_LOCAL_SMOKE=1 npx playwright test --config playwright.production\.config\.ts/.exec(ci);
    expect(step, 'ci.yml has no step running playwright.production.config.ts').not.toBeNull();
    expect(ci).not.toMatch(/PRODUCTION_URL/);
  });

  it('points the suite at a seeded server it starts itself when asked to', () => {
    const config = readFileSync(join(ROOT, 'playwright.production.config.ts'), 'utf8');
    expect(config).toMatch(/FA_LOCAL_SMOKE === '1'/);
    expect(config).toMatch(/FA_SEED=1/);
  });
});
