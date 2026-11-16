/**
 * Round 28: past the probe ceiling, the budget probe still shows Cloudflare's
 * own totals (they read no database rows), and nothing that reads production.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'scripts/probe-d1-budget-round14.mjs';

function run(env: Record<string, string>): string {
  const r = spawnSync(process.execPath, [SCRIPT], {
    // No Cloudflare token, and an app address nothing listens on: any part
    // that tries the live app prints its heading first, which is what is checked.
    env: { PATH: process.env.PATH ?? '', APP_URL: 'http://127.0.0.1:9', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return `${r.stdout}\n${r.stderr}`;
}

describe('the budget probe past the ceiling', () => {
  it('runs no part that reads production when CF_TOTALS_ONLY=yes', () => {
    const out = run({ CF_TOTALS_ONLY: 'yes' });
    expect(out).toContain('Cloudflare totals only');
    expect(out).not.toContain('What one Matchup refresh costs');
    expect(out).not.toContain('Output digest');
    expect(out).not.toContain('Tables that only grow');
  });

  it('still asks for those parts otherwise (the switch is what holds them back)', () => {
    const out = run({ STEPS: 'digest' });
    expect(out).toContain('Output digest');
  });

  it('is let through by the Probe workflow in totals-only mode, and every other guarded probe still stands down', () => {
    const yml = readFileSync('.github/workflows/probe.yml', 'utf8');
    const branch = yml.slice(yml.indexOf("grep -q '^proceed=no'"), yml.indexOf('DRAFT_ID=""'));
    expect(branch).toMatch(/if \[ "\$SCRIPT" = probe-d1-budget-round14\.mjs \]; then[\s\S]*export CF_TOTALS_ONLY=yes[\s\S]*GUARDED=no/);
    expect(branch).toMatch(/else[\s\S]*Standing down[\s\S]*exit 0/);
  });
});

describe('the usage-hours probe gets the Cloudflare token (Round 30)', () => {
  it('is on the list that hands CLOUDFLARE_API_TOKEN on, not only the unguarded list', () => {
    const yml = readFileSync('.github/workflows/probe.yml', 'utf8');
    const handOn = yml.split('\n').find((line) => line.includes('probe-d1-top-readers.mjs|probe-cleanup-d1.mjs') || line.includes('probe-d1-usage-hours.mjs|probe-cleanup-d1.mjs'));
    expect(handOn, 'the token hand-on list').toBeDefined();
    expect(handOn).toContain('probe-d1-usage-hours.mjs');
  });
});
