/**
 * Which modules are allowed in the chunks a page load fetches.
 *
 * The page-weight budgets measure bytes. This measures *identity*, and it
 * exists because the failure it catches is invisible to a byte count until it
 * is already large.
 *
 * Rollup's placement rule is the whole mechanism: a module reachable from the
 * entry is placed in the entry chunk, whatever else also reaches it. So the
 * moment one render-path import points at a module Demo Mode runs for real,
 * that module — and every module behind it — moves out of `demo-*.js` and into
 * the shell, and every real user downloads a model only a demo can reach.
 *
 * It has happened twice, and both times it was found by hand:
 *
 *   - `core/dst/planner.ts` — the render path took `weekRange` from it to print
 *     "Weeks 15–17", and once Demo Mode called `planDst` for real that one
 *     import placed the whole defence model, and the start/sit engine behind
 *     it, in the entry chunk. 25KB on every page load, for a heading. Fixed by
 *     splitting the leaf out to `core/dst/weeks.ts`.
 *   - `core/sleeper/scoring.ts` — the Team and Players screens read a roster's
 *     *shape* from the same module that holds its *scoring*, so the defence
 *     scoring table shipped to the shell. Fixed by splitting the leaf out to
 *     `core/sleeper/rosterShape.ts`.
 *
 * Neither would have failed a size budget at the commit that caused it: the
 * app-JavaScript ceiling has headroom by design — it has to, or every commit
 * fails — and a leak that fits inside the headroom passes green and stays.
 * That is what this is for. It fails at the commit, and it names the module,
 * which is the part a byte count can never do.
 *
 * The declaration lives in `perf-budgets.json` under `chunkOwnership`, beside
 * the other ceilings: `watch` names the regions that are not render-path
 * unless said otherwise, and `renderPath` lists the modules in them that are.
 * Adding to that list is the same deliberate act as raising a number — in the
 * same commit as whatever needed it, with the reason in the commit message.
 *
 * Nothing here reads the app's source or its imports. It reads what the
 * bundler actually did, from the build's own source maps, which is the only
 * account of chunk membership that cannot disagree with the shipped bytes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Vite names Demo Mode's chunks with this prefix. See `vite.config.ts`. */
const DEMO_CHUNK_PREFIX = 'demo-';

/** A repo-relative, forward-slashed path, whatever the platform separator is. */
const repoRelative = (root, absolute) => relative(root, absolute).split(sep).join('/');

/**
 * The modules a chunk carries, read from its source map.
 *
 * `sources` is relative to the map, so it is resolved against the map's own
 * directory rather than guessed at with a prefix strip — the number of `../`
 * segments depends on where the build output sits, and a wrong guess here
 * would silently produce paths that match no rule and report green.
 */
export function chunkModulesFromMap(mapPath, map, root) {
  const from = dirname(mapPath);
  return (map.sources ?? []).map((source) => repoRelative(root, resolve(from, source)));
}

/**
 * Every JavaScript chunk in a built site, with what each one contains.
 *
 * A chunk whose map is missing is reported rather than skipped. Skipping is
 * how this check would quietly stop checking the day somebody turns source
 * maps off, and a guard that measures less than it claims to is worse than no
 * guard at all.
 */
export function readBuiltChunks(distDir, root) {
  const assets = join(distDir, 'assets');
  let entries;
  try {
    entries = readdirSync(assets);
  } catch {
    return { chunks: [], chunksWithoutMap: [] };
  }

  const chunks = [];
  const chunksWithoutMap = [];

  for (const name of entries.filter((n) => n.endsWith('.js')).sort()) {
    const file = `assets/${name}`;
    const mapPath = join(assets, `${name}.map`);
    let map;
    try {
      map = JSON.parse(readFileSync(mapPath, 'utf8'));
    } catch {
      chunksWithoutMap.push(file);
      continue;
    }
    chunks.push({
      file,
      isDemo: name.startsWith(DEMO_CHUNK_PREFIX),
      modules: chunkModulesFromMap(mapPath, map, root),
    });
  }

  return { chunks, chunksWithoutMap };
}

/**
 * The modules that crossed into a chunk a page load can fetch.
 *
 * `watch` is a list of path prefixes — the regions whose modules are Demo
 * Mode's or an engine's unless declared otherwise. `renderPath` is the
 * declared exceptions: the modules in those regions that a page genuinely
 * needs. Anything else in a watched region, sitting in a non-demo chunk, is
 * the leak.
 *
 * Deliberately a *whole-region allowlist* rather than a list of the two
 * modules already fixed. Naming the known offenders would catch the same bug
 * twice and the next one never; naming the region catches whichever module
 * crosses next, including one written after this file.
 */
export function findChunkOwnershipLeaks({ chunks, watch, renderPath }) {
  const allowed = new Set(renderPath);
  const watched = (module) => watch.some((prefix) => module.startsWith(prefix));

  const leaks = [];
  const seen = new Set();

  for (const chunk of chunks.filter((c) => !c.isDemo)) {
    for (const module of chunk.modules) {
      if (!watched(module) || allowed.has(module) || seen.has(module)) continue;
      seen.add(module);
      leaks.push({ module, chunk: chunk.file });
    }
  }

  /*
   * An allowance nobody uses any more is not a failure — a module can leave
   * the render path for a dozen honest reasons and none of them should turn a
   * build red. It is worth saying out loud all the same: a list that only ever
   * grows is a list that stops describing anything, and the entries that have
   * gone quiet are the ones nobody would otherwise think to look at.
   */
  const inBuild = new Set(chunks.flatMap((c) => c.modules));
  const unusedAllowances = renderPath.filter((module) => !inBuild.has(module)).sort();

  leaks.sort((a, b) => a.module.localeCompare(b.module));
  return { leaks, unusedAllowances };
}

/**
 * What to print when a module has crossed. Named, and with the two ways out.
 *
 * The message is the point of the whole check. "app JavaScript: 148.2kB
 * against a budget of 148kB" is true and tells nobody what to do; this says
 * which module moved, which chunk it moved into, and why that costs every
 * user something.
 */
export function describeChunkOwnershipLeaks(leaks) {
  const lines = [
    `${leaks.length} module${leaks.length === 1 ? '' : 's'} crossed into the render path:`,
    '',
  ];

  for (const leak of leaks) {
    lines.push(`  ${leak.module}`);
    lines.push(`    now placed in ${leak.chunk}, which every page load fetches.`);
  }

  lines.push(
    '',
    '  A module reachable from the entry is placed in the entry chunk, whatever',
    '  else also reaches it — so a single render-path import into a module Demo',
    '  Mode runs for real drags that module, and everything behind it, out of',
    '  demo-*.js and into the shell.',
    '',
    '  Either split the leaf the render path actually needs into its own module',
    '  — as core/dst/weeks.ts and core/sleeper/rosterShape.ts were, both of them',
    '  this exact bug — or, if the module genuinely belongs on the render path,',
    '  add it to chunkOwnership.renderPath in perf-budgets.json in the same',
    '  commit, with the reason in the commit message.',
    '',
  );

  return lines.join('\n');
}
