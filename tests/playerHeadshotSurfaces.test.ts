/**
 * Portraits stay browser-direct, and stay on the surfaces that were argued for.
 *
 * Two invariants, both asserted by reading the source rather than by running
 * anything, because both are the kind that decay quietly. Nobody adds a Worker
 * proxy or a sixth face on purpose; they add the sixth one because the fifth
 * was already there.
 *
 * **The runtime-cost invariant.** The expected request path is
 * `browser → sleepercdn.com`, and never `browser → Junculator Worker →
 * Sleeper`. A direct image load costs this deployment nothing at all: no
 * Worker subrequest, no D1 read, no KV or R2 object, no API route, and no
 * change to the number of requests the app itself makes when a reader looks at
 * a player. That is the entire reason hot-linking was accepted here after being
 * rejected for team marks — see docs/ARCHITECTURE.md — so it is worth a test
 * rather than a paragraph. The day somebody proxies these "to add caching", the
 * per-image cost stops being zero and this fails.
 *
 * **The approved-surfaces invariant.** The read-only discovery quantified what
 * a face costs a dense row: on Matchup at 390px the name column goes from about
 * 85px to about 60px, which is a large truncation regression on the one screen
 * a reader scans fastest. Matchup, Draft, Waivers, the Players index and the
 * compact trade rows are therefore image-free by decision, not by accident.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Every source file, as `src`-relative POSIX paths mapped to their text. */
function sources(sub: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(join(SRC, sub))) {
    out.set(relative(SRC, file).split('\\').join('/'), readFileSync(file, 'utf8'));
  }
  return out;
}

/**
 * The one module allowed to know the portrait host.
 *
 * URL construction is kept out of presentation components on purpose: a second
 * place that builds this string is a second place that can start building it
 * from a name.
 */
const URL_OWNER = 'core/players/headshot.ts';

describe('portraits are fetched by the browser and by nothing else', () => {
  it('only the URL helper names the portrait host', () => {
    const offenders: string[] = [];
    for (const [path, text] of [...sources('core'), ...sources('web'), ...sources('server'), ...sources('worker')]) {
      if (path === URL_OWNER) continue;
      if (text.includes('sleepercdn')) offenders.push(path);
    }
    expect(offenders, `the portrait host is built outside ${URL_OWNER}`).toEqual([]);
  });

  it('no Worker, server route or repository ever fetches a portrait', () => {
    // The whole cost story. A Worker that touches this host is a Worker
    // subrequest per image, per reader, on a path that currently costs nothing.
    for (const [path, text] of [...sources('server'), ...sources('worker')]) {
      expect(text, `${path} reaches the portrait CDN from the server`).not.toContain('sleepercdn');
      expect(text, `${path} imports the portrait URL helper`).not.toContain('players/headshot');
    }
  });

  it('no API route serves, proxies or records a headshot', () => {
    const router = readFileSync(join(SRC, 'server/http/router.ts'), 'utf8');
    for (const word of ['headshot', 'portrait', 'avatar']) {
      expect(router.toLowerCase(), `the router grew a /${word} route`).not.toContain(word);
    }
  });

  it('no migration stores an image', () => {
    const dir = join(import.meta.dirname, '..', 'migrations');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8').toLowerCase();
      for (const word of ['headshot', 'portrait', 'avatar']) {
        expect(text, `${file} added a column for a ${word}`).not.toContain(word);
      }
    }
  });

  it('adds no storage binding to the Worker', () => {
    // D1 is already bound and is not this feature's business; R2 and KV are not
    // bound at all, and a portrait must never be the reason they are.
    const toml = readFileSync(join(import.meta.dirname, '..', 'wrangler.toml'), 'utf8');
    expect(toml, 'an R2 bucket appeared').not.toContain('r2_buckets');
    expect(toml, 'a KV namespace appeared').not.toContain('kv_namespaces');
    expect(toml, 'the portrait CDN reached the Worker config').not.toContain('sleepercdn');
  });
});

describe('only the surfaces that were argued for draw a face', () => {
  /**
   * Where a portrait is allowed to be rendered.
   *
   * `common.tsx` defines the primitive, so it names it by necessity. Everything
   * else on this list is a surface somebody argued for, at a size that was
   * checked at 430, 390, 375 and 360 in both themes.
   */
  const APPROVED = new Set(['web/components/common.tsx', 'web/components/playerPage.tsx']);

  /**
   * Where a portrait is forbidden, by name rather than by omission.
   *
   * Listed explicitly as well as covered by the sweep below, so that deleting a
   * screen from `APPROVED` cannot silently make it legal, and so the failure
   * message names the decision instead of a rule.
   */
  const PROTECTED = [
    'web/components/matchup.tsx',
    'web/screens/MatchupScreen.tsx',
    'web/components/draftBoard.tsx',
    'web/screens/DraftScreen.tsx',
    'web/components/waivers.tsx',
    'web/screens/WaiversScreen.tsx',
    'web/screens/PlayersScreen.tsx',
    'web/components/playerRow.tsx',
    'web/components/smartTrades.tsx',
  ];

  const web = sources('web');

  it('the protected dense lists draw no portrait', () => {
    for (const path of PROTECTED) {
      const text = web.get(path);
      expect(text, `${path} is on the protected list but is not in the source tree`).toBeTypeOf('string');
      expect(text, `${path} is a protected dense surface and grew a face`).not.toContain('PlayerFace');
    }
  });

  it('nothing outside the approved surfaces renders one', () => {
    const offenders = [...web.entries()]
      .filter(([path, text]) => !APPROVED.has(path) && text.includes('PlayerFace'))
      .map(([path]) => path);
    expect(
      offenders,
      'a portrait reached a surface nobody sized or screenshotted; add it to APPROVED with a reason, or take it out',
    ).toEqual([]);
  });

  it('the expanded player sheet actually draws one', () => {
    // The other direction: a rule that only ever forbids can be satisfied by
    // deleting the feature.
    const page = web.get('web/components/playerPage.tsx')!;
    expect(page, 'the sheet stopped drawing a face').toContain('<PlayerFace');
    expect(page, 'the sheet stopped asking for it eagerly').toContain('loading="eager"');
    expect(page, 'the sheet portrait is no longer 64px').toContain('size={64}');
  });

  it('nothing eager-loads a portrait in a list', () => {
    // A list that eager-loads is a roster's worth of images requested at once,
    // which is the one way this feature could cost a reader something. The
    // sheet is the single exception and it is one image the reader asked for.
    for (const [path, text] of web) {
      if (path === 'web/components/playerPage.tsx') continue;
      expect(text, `${path} eager-loads a portrait`).not.toMatch(/<PlayerFace[^>]*loading="eager"/s);
    }
  });
});
