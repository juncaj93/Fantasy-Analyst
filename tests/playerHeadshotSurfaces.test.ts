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
 * **The one-implementation invariant.** Six focused surfaces draw a face now,
 * and there is one piece of markup that draws it: `PlayerSheetTitle` in
 * `common.tsx`. A screen either calls that or has no portrait — there is no
 * third option, which is what stops the rules below being re-argued once per
 * surface. This replaced a list of approved screens, which was the right shape
 * while one screen had a face and would have said nothing by the sixth.
 *
 * **The protected-surfaces invariant.** The read-only discovery quantified what
 * a face costs a dense row: on Matchup at 390px the name column goes from about
 * 85px to about 60px, which is a large truncation regression on the one screen
 * a reader scans fastest. The dense lists — Matchup's mirrored rows, the draft
 * board, the waivers list, the Players index, Team's roster rows, the compact
 * trade rows — and Draft's in-board expanded card are therefore image-free by
 * decision, not by accident, and the reasons are recorded on `PROTECTED` below.
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
   * The one file allowed to render a portrait.
   *
   * Not a list of screens any more, and that is the point of this pass. Six
   * focused surfaces now draw a face — the shared player card from Players and
   * Trades, the weekly card from Team and Matchup, the waiver detail from Team
   * and Waivers — and every one of them draws it by rendering
   * `PlayerSheetTitle`, which renders `PlayerFace` once. So the size, the eager
   * load, the empty `alt`, the defence exclusion and the initials fallback are
   * one implementation rather than six that drift.
   *
   * A list of approved *screens* would have grown by four here and stopped
   * meaning anything by the sixth. A rule that says the markup exists once does
   * not decay: the next surface either calls the shared header or it fails
   * this.
   */
  const FACE_OWNER = 'web/components/common.tsx';

  /**
   * Where a focused player header is allowed to be *used*, and by name.
   *
   * The other half of the rule above: owning the markup in one place stops it
   * being copied, and this stops it being pasted into a list by calling the
   * shared component instead. Each of these is a sheet about exactly one
   * player, reached because the reader chose him.
   */
  const FOCUSED = ['web/components/playerPage.tsx', 'web/components/weekly.tsx', 'web/components/waivers.tsx'];

  /**
   * Where a portrait is forbidden, by name rather than by omission.
   *
   * Listed explicitly as well as covered by the sweep, so the failure message
   * names the decision instead of a rule. Two different arguments hold this
   * list, and both are measurements rather than taste:
   *
   * **The dense lists.** A face costs a row its name column. On Matchup at
   * 390px the name falls from about 85px to about 60px, which is a large
   * truncation regression on the screen a reader scans fastest. Team's compact
   * rows were prototyped at 28px and introduced truncation at 390, 375 and 360
   * and a 32px indent between populated and empty slots.
   *
   * **Draft's expanded card, which is not a dense row.** It is the one
   * "expanded player detail" in the app that does not open in a sheet: it
   * unfolds inside the board, and it is budgeted at about two and a half
   * collapsed rows precisely so the board it opened from stays on screen. A
   * portrait beside its content wraps the working — `Sleeper ADP · DOG ADP ·
   * Pick · Val`, which the card is arranged to keep on one line at 360px — from
   * 15px to 31px on four of five seeded cards, at 40px as well as at 64px; a
   * portrait above its content spends about 30px of a card whose ceiling has
   * about 36px left. Measured at 360 and 390 rather than argued: the widest
   * card goes from 2.53x a collapsed row to 2.80x. The feature's own rule is
   * that decision content wins when 64px will not fit cleanly, so Draft keeps
   * the club mark, the status tag and the whole of its working, and no face.
   */
  const PROTECTED = [
    'web/components/matchup.tsx',
    'web/screens/MatchupScreen.tsx',
    'web/components/draftBoard.tsx',
    'web/screens/DraftScreen.tsx',
    'web/screens/WaiversScreen.tsx',
    'web/screens/PlayersScreen.tsx',
    'web/screens/TeamScreen.tsx',
    'web/components/playerRow.tsx',
    'web/components/smartTrades.tsx',
  ];

  const web = sources('web');

  it('the portrait markup exists in exactly one file', () => {
    const offenders = [...web.entries()]
      .filter(([path, text]) => path !== FACE_OWNER && /<PlayerFace\b/.test(text))
      .map(([path]) => path);
    expect(
      offenders,
      `a second portrait implementation appeared; focused surfaces render PlayerSheetTitle, and ${FACE_OWNER} renders the face`,
    ).toEqual([]);
  });

  it('the shared focused header draws one, eagerly, at 64px', () => {
    // The other direction: a rule that only ever forbids can be satisfied by
    // deleting the feature.
    const common = web.get(FACE_OWNER)!;
    const title = common.slice(common.indexOf('export function PlayerSheetTitle'));
    expect(title, 'the focused header stopped drawing a face').toContain('<PlayerFace');
    expect(title, 'the focused header stopped asking for it eagerly').toContain('loading="eager"');
    expect(title, 'the focused portrait is no longer 64px').toContain('size={64}');
    expect(title, 'the focused header stopped excluding defences').toContain('position={position}');
  });

  it('every focused player surface uses that header rather than its own', () => {
    for (const path of FOCUSED) {
      const text = web.get(path);
      expect(text, `${path} is a focused surface but is not in the source tree`).toBeTypeOf('string');
      expect(text, `${path} stopped drawing a focused player header`).toContain('<PlayerSheetTitle');
    }
  });

  it('the protected surfaces draw no portrait and no focused header', () => {
    for (const path of PROTECTED) {
      const text = web.get(path);
      expect(text, `${path} is on the protected list but is not in the source tree`).toBeTypeOf('string');
      expect(text, `${path} is a protected surface and grew a face`).not.toContain('PlayerFace');
      expect(text, `${path} is a protected surface and grew a focused player header`).not.toContain('PlayerSheetTitle');
    }
  });

  it('nothing eager-loads a portrait outside the focused header', () => {
    // A list that eager-loads is a roster's worth of images requested at once,
    // which is the one way this feature could cost a reader something. The
    // focused header is the single exception, and what it loads is one image
    // the reader asked for by opening a card about one player.
    for (const [path, text] of web) {
      if (path === FACE_OWNER) continue;
      expect(text, `${path} eager-loads a portrait`).not.toMatch(/<PlayerFace[^>]*loading="eager"/s);
    }
  });
});
