/**
 * The Demo-Mode leak guardrail, pointed at the leak.
 *
 * A guard nobody has ever seen fail is a guard nobody knows the shape of. This
 * one exists because the same bug has landed twice — a module Demo Mode runs
 * for real ending up in the chunk every page load fetches, because one
 * render-path import reached it — and both times it was found by a person
 * reading a bundle report, not by anything in CI.
 *
 *   - `core/dst/planner.ts`, reached for `weekRange` to print "Weeks 15–17",
 *     which placed the whole defence model and the start/sit engine behind it
 *     in the entry chunk: 25KB on every page load, for a heading.
 *   - `core/sleeper/scoring.ts`, reached for a roster's *shape* by the Team and
 *     Players screens, which shipped the defence scoring table with it.
 *
 * Neither failed a size budget at the commit that caused it. They could not
 * have: the app-JavaScript ceiling carries headroom on purpose — a budget with
 * none fails the next commit whatever that commit is — and a leak that fits
 * inside the headroom is green.
 *
 * So every rule here is exercised twice: once on a build that satisfies it, and
 * once on a build that breaks it in the specific way this repository has
 * already broken it. The third case matters most, because it is the one that
 * says this catches the *pattern* rather than the two modules already fixed: a
 * module invented for this test, which no list anywhere mentions, is caught the
 * same way.
 *
 * What is checked here is the detector, from `npm test`, in milliseconds and
 * with no build. The real build is checked by `npm run perf:budget`, in the
 * same CI job that builds the site — the same split `tests/playerDetailWaves.test.ts`
 * has against the API wave budgets, and for the same reason: a shape worth
 * failing in seconds, and a measurement that genuinely needs the artefact.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// prettier-ignore
// @ts-expect-error -- a plain .mjs budget helper, deliberately not part of the app build
import { chunkModulesFromMap, describeChunkOwnershipLeaks, findChunkOwnershipLeaks } from '../scripts/lib/chunkOwnership.mjs';

interface Chunk {
  file: string;
  isDemo: boolean;
  modules: string[];
}

interface Leak {
  module: string;
  chunk: string;
}

const DECLARATION = JSON.parse(
  readFileSync(new URL('../perf-budgets.json', import.meta.url), 'utf8'),
).chunkOwnership as { watch: string[]; renderPath: string[] };

/**
 * A build shaped like the real one: an entry chunk, a lazy chunk that is still
 * on the render path's side of the line, and Demo Mode's own chunks.
 */
const ENTRY = 'assets/index-aaaa1111.js';
const LAZY = 'assets/liveRoster-bbbb2222.js';
const DEMO = 'assets/demo-cccc3333.js';

const build = (overrides: Partial<Record<string, string[]>> = {}): Chunk[] => [
  {
    file: ENTRY,
    isDemo: false,
    modules: overrides[ENTRY] ?? [
      'node_modules/react/index.js',
      'src/core/dst/weeks.ts',
      'src/core/sleeper/rosterShape.ts',
      'src/web/App.tsx',
      'src/web/demo/session.ts',
      'src/web/screens/TeamScreen.tsx',
    ],
  },
  { file: LAZY, isDemo: false, modules: overrides[LAZY] ?? ['src/core/draft/liveRoster.ts'] },
  {
    file: DEMO,
    isDemo: true,
    modules: overrides[DEMO] ?? [
      'src/core/demo/runtime/handlers.ts',
      'src/core/dst/planner.ts',
      'src/core/sleeper/scoring.ts',
      'src/core/startsit/engine.ts',
      'src/web/demo/DemoPanel.tsx',
    ],
  },
];

/** The declaration a clean synthetic build is measured against. */
const RULES = {
  watch: ['src/core/', 'src/web/demo/'],
  renderPath: [
    'src/core/draft/liveRoster.ts',
    'src/core/dst/weeks.ts',
    'src/core/sleeper/rosterShape.ts',
    'src/web/demo/session.ts',
  ],
};

const check = (chunks: Chunk[], rules = RULES) =>
  findChunkOwnershipLeaks({ chunks, ...rules }) as {
    leaks: Leak[];
    unusedAllowances: string[];
  };

/** The same build, with `module` moved out of the demo chunk and into `into`. */
function leakInto(module: string, into: string): Chunk[] {
  const chunks = build();
  for (const chunk of chunks) {
    chunk.modules = chunk.modules.filter((m) => m !== module);
    if (chunk.file === into) chunk.modules = [...chunk.modules, module].sort();
  }
  return chunks;
}

/* ------------------------------------------------- the build as it stands */

describe('a build with nothing crossed reports nothing', () => {
  it('passes every module the declaration accounts for', () => {
    expect(check(build()).leaks).toEqual([]);
  });

  it('says nothing about the demo chunk, which is allowed everything', () => {
    /*
     * The whole point of the demo chunk is that the engines live in it. A rule
     * that complained about `core/startsit/engine.ts` being in `demo-*.js`
     * would be complaining about the fix rather than the bug.
     */
    const chunks = build();
    const demo = chunks.find((c) => c.file === DEMO);
    demo!.modules = [...demo!.modules, 'src/core/trades/ladder.ts', 'src/core/matchup/simulate.ts'];
    expect(check(chunks).leaks).toEqual([]);
  });

  it('ignores everything outside a watched region', () => {
    const chunks = build();
    chunks[0]!.modules.push('node_modules/scheduler/index.js', 'src/web/screens/DraftScreen.tsx');
    expect(check(chunks).leaks).toEqual([]);
  });
});

/* -------------------------------------------- the two leaks already fixed */

describe('the leaks this repository has actually shipped', () => {
  it('catches core/sleeper/scoring.ts back in the entry chunk', () => {
    const { leaks } = check(leakInto('src/core/sleeper/scoring.ts', ENTRY));
    expect(leaks).toEqual([{ module: 'src/core/sleeper/scoring.ts', chunk: ENTRY }]);
  });

  it('catches core/dst/planner.ts back in the entry chunk', () => {
    const { leaks } = check(leakInto('src/core/dst/planner.ts', ENTRY));
    expect(leaks).toEqual([{ module: 'src/core/dst/planner.ts', chunk: ENTRY }]);
  });

  it('catches a leak into a lazy chunk too, not only the entry', () => {
    /*
     * `liveRoster-*.js` and `mockDraft-*.js` are dynamic imports, but they are
     * the app's, not Demo Mode's — the app-JavaScript budget counts them, and a
     * module that crosses into one has crossed just the same.
     */
    const { leaks } = check(leakInto('src/core/startsit/engine.ts', LAZY));
    expect(leaks).toEqual([{ module: 'src/core/startsit/engine.ts', chunk: LAZY }]);
  });
});

/* ------------------------------------------------------------ the pattern */

describe('the pattern, not the two modules already fixed', () => {
  it('catches a module no list anywhere has heard of', () => {
    /*
     * The one that matters. This module does not exist, is named in no
     * allowlist and in no denylist, and is caught because it is in a watched
     * region and undeclared — which is what makes this a guard against the next
     * leak rather than a re-test of the last one.
     */
    const chunks = build();
    chunks[0]!.modules.push('src/core/somethingNobodyHasWrittenYet/engine.ts');
    expect(check(chunks).leaks).toEqual([
      { module: 'src/core/somethingNobodyHasWrittenYet/engine.ts', chunk: ENTRY },
    ]);
  });

  it('catches Demo Mode’s own web code crossing into the shell', () => {
    const { leaks } = check(leakInto('src/web/demo/DemoPanel.tsx', ENTRY));
    expect(leaks).toEqual([{ module: 'src/web/demo/DemoPanel.tsx', chunk: ENTRY }]);
  });

  it('reports every module that crossed, not just the first', () => {
    const chunks = leakInto('src/core/sleeper/scoring.ts', ENTRY);
    chunks[0]!.modules.push('src/core/startsit/engine.ts');
    expect(check(chunks).leaks.map((l) => l.module)).toEqual([
      'src/core/sleeper/scoring.ts',
      'src/core/startsit/engine.ts',
    ]);
  });

  it('cannot be quieted by a watch list that covers nothing', () => {
    /*
     * Narrowing `watch` is the one edit that would turn this green while the
     * leak is still there, so it is worth seeing what it does: everything.
     */
    const chunks = leakInto('src/core/sleeper/scoring.ts', ENTRY);
    expect(check(chunks, { ...RULES, watch: [] }).leaks).toEqual([]);
    expect(check(chunks).leaks).toHaveLength(1);
  });
});

/* --------------------------------------------------------- what it prints */

describe('the failure says which module and what to do about it', () => {
  const message = describeChunkOwnershipLeaks(
    check(leakInto('src/core/sleeper/scoring.ts', ENTRY)).leaks,
  ) as string;

  it('names the offending module and the chunk it landed in', () => {
    expect(message).toContain('src/core/sleeper/scoring.ts');
    expect(message).toContain(ENTRY);
  });

  it('explains the mechanism rather than quoting a byte count', () => {
    expect(message).toContain('reachable from the entry');
    expect(message).not.toMatch(/\d+(\.\d+)?kB/);
  });

  it('names both ways out, so nobody has to guess which is meant', () => {
    expect(message).toContain('core/sleeper/rosterShape.ts');
    expect(message).toContain('chunkOwnership.renderPath in perf-budgets.json');
  });
});

/* ------------------------------------------------------- the declaration */

describe('the declaration in perf-budgets.json', () => {
  it('is there at all', () => {
    /*
     * `scripts/perf-budget.mjs` reads this block unguarded, so deleting it
     * fails the build rather than turning the check off — but the message that
     * failure gives is about a property of `undefined`. This one says what is
     * actually missing.
     */
    expect(DECLARATION).toBeDefined();
    expect(DECLARATION.watch.length).toBeGreaterThan(0);
    expect(DECLARATION.renderPath.length).toBeGreaterThan(0);
  });

  it('watches the regions both known leaks came from', () => {
    for (const module of ['src/core/dst/planner.ts', 'src/core/sleeper/scoring.ts']) {
      expect(DECLARATION.watch.some((prefix) => module.startsWith(prefix))).toBe(true);
    }
  });

  it('does not permit either module that has already leaked', () => {
    /*
     * The failure mode of an allowlist is that somebody widens it to make a red
     * build green. These two lines are the ones that would be added if that
     * ever happened to this bug, so they are asserted absent by name.
     */
    expect(DECLARATION.renderPath).not.toContain('src/core/dst/planner.ts');
    expect(DECLARATION.renderPath).not.toContain('src/core/sleeper/scoring.ts');
  });

  it('permits only modules inside a watched region', () => {
    /*
     * An entry outside every watched prefix does nothing except look like
     * permission, which is the kind of line that survives long after the rule
     * it was written against has moved.
     */
    const stray = DECLARATION.renderPath.filter(
      (module) => !DECLARATION.watch.some((prefix) => module.startsWith(prefix)),
    );
    expect(stray).toEqual([]);
  });

  it('lists each module once, sorted, so a diff to it is readable', () => {
    expect(DECLARATION.renderPath).toEqual([...new Set(DECLARATION.renderPath)].sort());
  });
});

/* ------------------------------------------------------------ the reading */

describe('reading a chunk’s modules from its source map', () => {
  it('resolves sources against the map, not by stripping ../ off the front', () => {
    /*
     * The number of `../` segments depends on where the build output sits
     * relative to the repository, and a prefix strip that guesses wrong
     * produces paths that match no rule and report green — a guard that has
     * silently stopped guarding. So the resolution is real path arithmetic.
     */
    const modules = chunkModulesFromMap(
      '/repo/dist/web/assets/index-aaaa1111.js.map',
      { sources: ['../../../src/core/dst/weeks.ts', '../../../node_modules/react/index.js'] },
      '/repo',
    ) as string[];
    expect(modules).toEqual(['src/core/dst/weeks.ts', 'node_modules/react/index.js']);
  });

  it('reads a map with no sources as a chunk carrying nothing', () => {
    expect(chunkModulesFromMap('/repo/dist/web/assets/x.js.map', {}, '/repo')).toEqual([]);
  });
});

/* ------------------------------------------------- keeping the list honest */

describe('an allowance nobody uses any more', () => {
  it('is reported, and does not fail the build', () => {
    const { leaks, unusedAllowances } = check(build(), {
      ...RULES,
      renderPath: [...RULES.renderPath, 'src/core/gone/awayLastYear.ts'],
    });
    expect(leaks).toEqual([]);
    expect(unusedAllowances).toEqual(['src/core/gone/awayLastYear.ts']);
  });

  it('counts a module still in the demo chunk as used, not gone', () => {
    /*
     * A module can be on the render path *and* reachable from a demo — that is
     * the ordinary case, not a problem — and once it moves wholly into the demo
     * chunk it has stopped costing a page load anything. Neither is a stale
     * entry, so neither should be reported as one.
     */
    const { unusedAllowances } = check(build(), {
      ...RULES,
      renderPath: [...RULES.renderPath, 'src/core/startsit/engine.ts'],
    });
    expect(unusedAllowances).toEqual([]);
  });
});
