/**
 * The resilience work cannot reach the football.
 *
 * This pass added season resolution, rollover policy, cache keys, a shared
 * fuzzy search and an offline board cache. None of it is allowed to change what
 * the app *thinks about football* — not a Draft Score, not an ADP value, not a
 * survival percentage, not a tier boundary, not a Start/Sit weight, not a FAAB
 * recommendation.
 *
 * "We were careful" is not a guarantee; it is a claim that decays on the next
 * commit. So the separation is asserted structurally, in both directions:
 *
 *   - **nothing decision-making may import the infrastructure**, which is what
 *     stops a scoring module quietly starting to depend on, say, the lifecycle
 *     state and thereby scoring a player differently in March than in
 *     September;
 *   - **the infrastructure may not import the decision-making**, which is what
 *     stops it from being able to influence a score even by accident.
 *
 * Read off the imports rather than the behaviour, because behaviour tests can
 * only check the cases somebody thought of, and this needs to hold for the
 * cases nobody has written yet.
 *
 * The one deliberate exception is documented below and is not a football
 * dependency: search reuses the identity layer's name normalizer, which is a
 * string function.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** The modules that decide anything about football. */
const DECISION_DIRS = [
  'core/draft',
  'core/startsit',
  'core/trades',
  'core/adp',
  'core/evidence',
  'core/injury',
  'core/usage',
  'core/vegas',
  'core/newsletter',
];

/** The modules this resilience pass introduced. */
const INFRASTRUCTURE_DIRS = ['core/season', 'core/search'];

/**
 * Imports the infrastructure is allowed to make into shared code.
 *
 * `core/identity/normalize` is a string library — lower-casing, accent folding,
 * edit distance. Search reuses it precisely so that a name means the same thing
 * to the search field as it does to the resolver, which is the whole point of
 * having one normalizer; and it contains no football.
 */
const ALLOWED_SHARED = ['core/identity/normalize', 'core/identity/types'];

function filesUnder(dir: string): string[] {
  const full = join(SRC, dir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(full, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(join(dir, entry)));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(join(dir, entry));
  }
  return out;
}

/** Every module specifier a file imports, as written. */
function importsOf(relative: string): string[] {
  const source = readFileSync(join(SRC, relative), 'utf8');
  const out: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'([^']+)'/g)) {
    out.push(match[1]!);
  }
  return out;
}

/** Resolve `../foo/bar.ts` against the importing file, to a `src`-relative path. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.') continue;
    else if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/').replace(/\.tsx?$/, '');
}

describe('the football cannot depend on the plumbing', () => {
  it('no decision-making module imports the season or search infrastructure', () => {
    const offenders: string[] = [];
    for (const dir of DECISION_DIRS) {
      for (const file of filesUnder(dir)) {
        for (const specifier of importsOf(file)) {
          const resolved = resolveSpecifier(file, specifier);
          if (resolved && INFRASTRUCTURE_DIRS.some((infra) => resolved.startsWith(`${infra}/`))) {
            offenders.push(`${file} imports ${resolved}`);
          }
        }
      }
    }
    /*
     * If this fails, the question to ask is not "how do I allow it" but "why
     * does a score need to know". A Draft Score that reads the lifecycle state
     * is a Draft Score that changes in March for reasons that have nothing to
     * do with the player.
     */
    expect(offenders, 'football logic must not depend on infrastructure').toEqual([]);
  });

  it('finds the decision modules it claims to be checking', () => {
    // Guards against the check silently passing because a directory was
    // renamed and this list was not — a green test that inspects nothing.
    for (const dir of DECISION_DIRS) {
      expect(filesUnder(dir).length, `${dir} has modules to check`).toBeGreaterThan(0);
    }
  });
});

describe('the plumbing cannot reach the football', () => {
  it('the season and search modules import nothing that decides anything', () => {
    const offenders: string[] = [];
    for (const dir of INFRASTRUCTURE_DIRS) {
      for (const file of filesUnder(dir)) {
        for (const specifier of importsOf(file)) {
          const resolved = resolveSpecifier(file, specifier);
          if (!resolved) continue;
          if (ALLOWED_SHARED.some((allowed) => resolved === allowed)) continue;
          if (DECISION_DIRS.some((decision) => resolved.startsWith(`${decision}/`))) {
            offenders.push(`${file} imports ${resolved}`);
          }
        }
      }
    }
    expect(offenders, 'infrastructure must not depend on football logic').toEqual([]);
  });

  it('finds the infrastructure modules it claims to be checking', () => {
    for (const dir of INFRASTRUCTURE_DIRS) {
      expect(filesUnder(dir).length, `${dir} has modules to check`).toBeGreaterThan(0);
    }
  });
});

describe('the offline cache is read-only about draft state', () => {
  it('never writes anything that did not come from the server', () => {
    /*
     * §8 forbids inventing Sleeper picks, and the way to be sure is that the
     * cache module has no vocabulary for it: it stores an opaque value and
     * hands it back. If it ever grows a notion of a pick, a roster slot or a
     * queue mutation, this fails and the reviewer gets to ask why an offline
     * cache is composing draft state.
     */
    const source = readFileSync(join(SRC, 'web/offlineCache.ts'), 'utf8');
    // Comments explain the prohibition at length, so only the code is searched.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const forbidden of ['pick', 'roster', 'draftPlayer', 'fetch(', 'XMLHttpRequest']) {
      expect(code.toLowerCase(), `the offline cache must not know about "${forbidden}"`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });
});
