/**
 * Round 34: make room.
 *
 * The retired Trades screens, the draft-era Players list in season, the two
 * always-on switches that chose them (`TRADES_SCREENS`, `PLAYERS_INSEASON`)
 * and the never-connected database meter on Data health are gone. The kill
 * switches for newer work stay (`WAIVERS_LOOKAHEAD`, `TRIM_OLD_ROWS`). Each
 * check below fails on the code before this round.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { createTestDb } from './helpers/db.ts';
import { envFor, forbiddenSleeper } from './helpers/tradeLeague.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p: string) => existsSync(new URL(`../${p}`, import.meta.url));

describe('the retired screens are gone', () => {
  it('the old Trades screen and its parts no longer exist', () => {
    for (const p of [
      'src/web/screens/TradesScreen.tsx',
      'src/web/components/smartTrades.tsx',
      'src/web/components/tradeBuilder.tsx',
      'src/web/components/tradeCheck.tsx',
      'src/web/components/tradeLadder.tsx',
      'src/web/components/chipPicker.tsx',
      'src/web/tradeMarks.ts',
      'src/web/features.ts',
    ])
      expect(exists(p), p).toBe(false);
  });

  it('Trades always draws Offers, Build and Check, with no switch to read', () => {
    const tab = read('src/web/screens/TradesTab.tsx');
    expect(tab).toContain("import('./TradesScreenV2.tsx')");
    expect(tab).not.toMatch(/useFeatures|TradesScreen\.tsx|tradesScreens/);
  });

  it('Players is the draft screen only while a draft is ahead, and the in-season screen after', () => {
    const tab = read('src/web/screens/PlayersTab.tsx');
    expect(tab).toMatch(/if \(draftAhead\) return <PlayersScreen/);
    expect(tab).not.toMatch(/useFeatures|playersInSeason/);
    /* The draft screen keeps the heart and ADP; its post-draft owner pill and Pick column are gone. */
    const draft = read('src/web/screens/PlayersScreen.tsx');
    expect(draft).toContain('MyGuyControl');
    expect(draft).toContain("label: 'ADP'");
    expect(draft).not.toContain("label: 'Pick'");
  });
});

describe('switches', () => {
  it('the two always-on screen switches are out of wrangler.toml and the Worker; the kill switches stay', () => {
    const toml = read('wrangler.toml');
    expect(toml).not.toMatch(/^TRADES_SCREENS = /m);
    expect(toml).not.toMatch(/^PLAYERS_INSEASON = /m);
    expect(toml).not.toMatch(/^CLOUDFLARE_ACCOUNT_ID = /m);
    expect(toml).toMatch(/^WAIVERS_LOOKAHEAD = "on"$/m);
    expect(toml).toMatch(/^TRIM_OLD_ROWS = "on"$/m);
    const worker = read('src/worker/index.ts');
    expect(worker).not.toMatch(/TRADES_SCREENS|PLAYERS_INSEASON|CLOUDFLARE_ANALYTICS_TOKEN/);
    expect(worker).toMatch(/WAIVERS_LOOKAHEAD/);
  });

  it('the preview still marks its upload without the removed lines', () => {
    const workflow = read('.github/workflows/preview.yml');
    expect(workflow).toContain('PREVIEW = \\"trades\\"');
    expect(workflow).toContain('PREVIEW = \\"players\\"');
    expect(workflow).not.toMatch(/text\.replace\(\/\^(TRADES_SCREENS|PLAYERS_INSEASON)/);
  });

  it('the status read sends only the preview flag', async () => {
    const res = await createApp()(new Request('http://x/api/auth/status'), envFor(await createTestDb(), forbiddenSleeper().client));
    const body = (await res.json()) as { features: Record<string, unknown> };
    expect(body.features).toEqual({ preview: null });
  });
});

describe('the unconnected database meter', () => {
  it('has no route, no service and no panel', async () => {
    expect(exists('src/server/services/d1QuotaService.ts')).toBe(false);
    expect(read('src/web/components/dataHealth.tsx')).not.toMatch(/d1-quota|Daily rows read/);
    const res = await createApp()(new Request('http://x/api/diagnostics/d1-quota'), envFor(await createTestDb(), forbiddenSleeper().client));
    expect(res.status).toBe(404);
  });
});

describe('source files are plain text (audit C10)', () => {
  it('no source file carries a NUL byte, so code searches read every file', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css|mjs)$/.test(name) && readFileSync(p).includes(0)) offenders.push(p);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);
    expect(offenders).toEqual([]);
  });
});
