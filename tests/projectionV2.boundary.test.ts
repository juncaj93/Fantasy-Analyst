/**
 * The phase-1 boundary, asserted against the dependency graph rather than
 * promised in a comment.
 *
 * §13: "This phase should be feature-flagged or otherwise non-authoritative. No
 * live recommendation/ranking path should consume Projection v2 until the
 * side-by-side evaluation is reviewed."
 *
 * A flag would be the weaker version of that. A flag is a runtime value, it can
 * be flipped by a deploy, and a reader cannot tell from the code whether it is
 * on. What is asserted here instead is that the *arrow does not exist*: no
 * module that produces a recommendation imports anything from `core/projection`
 * or `core/nflverse`, transitively or otherwise, so there is nothing to flip.
 * Turning Projection v2 on is a code change with a diff somebody has to read,
 * which is what "explicit approval after evaluation" should mean.
 *
 * The companion assertion lives in `tests/sleeperProjectionFallback.test.ts`,
 * which keeps the Rotowire feed out of the same engines by the same method.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

/** Resolve a relative import to an absolute path, or null for a bare specifier. */
function resolve(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(from), specifier);
}

/**
 * Everything that produces a recommendation, a ranking or a simulation.
 *
 * Named as directories rather than files so a new module inside one of them is
 * covered on the day it is written rather than on the day somebody remembers
 * to add it here.
 */
const RECOMMENDATION_ROOTS = [
  'core/startsit',
  'core/matchup',
  'core/draft',
  'core/trades',
  'core/players',
  'core/waivers',
  'core/value',
  'core/faab',
  'core/xfp',
  'core/usage',
];

/** What phase 1 built, and what nothing above may reach. */
const PHASE_ONE_ROOTS = ['core/projection', 'core/nflverse'];

function within(file: string, roots: string[]): boolean {
  return roots.some((root) => file.startsWith(path.join(ROOT, ...root.split('/')) + path.sep));
}

describe('nothing that recommends anything can reach Projection v2', () => {
  it('the recommendation modules exist to be checked', () => {
    for (const root of RECOMMENDATION_ROOTS) {
      const dir = path.join(ROOT, ...root.split('/'));
      expect(sourceFiles(dir).length, `${root} has no modules`).toBeGreaterThan(0);
    }
  });

  it('the phase-1 modules exist to be kept out', () => {
    for (const root of PHASE_ONE_ROOTS) {
      const dir = path.join(ROOT, ...root.split('/'));
      expect(sourceFiles(dir).length, `${root} has no modules`).toBeGreaterThan(0);
    }
  });

  it('no recommendation module imports core/projection or core/nflverse, at any depth', () => {
    /*
     * Transitive, not direct. A direct-import check passes the moment somebody
     * adds one file in between, and the file in between is exactly how a
     * boundary like this is usually lost.
     */
    const graph = new Map<string, string[]>();
    for (const file of sourceFiles(ROOT)) {
      graph.set(
        file,
        importsOf(file)
          .map((specifier) => resolve(file, specifier))
          .filter((p): p is string => p != null)
          .map((p) => (p.endsWith('.ts') || p.endsWith('.tsx') ? p : `${p}.ts`)),
      );
    }

    const offenders: string[] = [];
    for (const start of sourceFiles(ROOT)) {
      if (!within(start, RECOMMENDATION_ROOTS)) continue;
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of graph.get(current) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          if (within(next, PHASE_ONE_ROOTS)) {
            offenders.push(
              `${path.relative(ROOT, start)} reaches ${path.relative(ROOT, next)}` +
                (current === start ? '' : ` via ${path.relative(ROOT, current)}`),
            );
            continue;
          }
          queue.push(next);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the arrow points the other way, so the report reads the live engine', () => {
    /*
     * The comparison would be worthless otherwise. The side-by-side prints the
     * number the Team screen prints because it calls the same function on the
     * same inputs, rather than reconstructing it.
     */
    const service = readFileSync(
      path.join(ROOT, 'server', 'services', 'projectionV2Service.ts'),
      'utf8',
    );
    expect(service).toMatch(/from '\.\.\/\.\.\/core\/startsit\/engine\.ts'/);
    expect(service).toMatch(/from '\.\.\/\.\.\/core\/startsit\/projection\.ts'/);
    expect(service).toMatch(/startSitInputsFor/);
  });
});

describe('no live surface can render a Projection v2 number', () => {
  it('the web app never mentions Projection v2 at all', () => {
    const web = sourceFiles(path.join(ROOT, 'web'));
    const offenders = web.filter((file) => /projection[-_ ]?v2|projectionV2/i.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('only the diagnostics route and the cron know the services exist', () => {
    const allowed = new Set(
      [
        'server/app.ts',
        'worker/index.ts',
        'server/services/projectionV2Service.ts',
        'server/services/nflverseService.ts',
        'server/repos/nflverse.ts',
      ].map((p) => path.join(ROOT, ...p.split('/'))),
    );
    const offenders = sourceFiles(ROOT).filter((file) => {
      if (allowed.has(file)) return false;
      if (within(file, PHASE_ONE_ROOTS)) return false;
      return /from '[^']*(projectionV2Service|nflverseService|repos\/nflverse)[^']*'/.test(readFileSync(file, 'utf8'));
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the diagnostics route says out loud that it is not authoritative', () => {
    const app = readFileSync(path.join(ROOT, 'server', 'app.ts'), 'utf8');
    const route = app.slice(app.indexOf("'/api/diagnostics/projection-v2'"));
    expect(route).toMatch(/authoritative: false/);
    expect(route).toMatch(/No recommendation, ranking or/);
  });

  it('is a GET, so it cannot write on a read', () => {
    const app = readFileSync(path.join(ROOT, 'server', 'app.ts'), 'utf8');
    expect(app).toMatch(/router\.get\('\/api\/diagnostics\/projection-v2'/);
    expect(app).not.toMatch(/router\.post\('\/api\/diagnostics\/projection-v2'/);
  });

  it('the nflverse refresh is the last thing the daily tick does', () => {
    /*
     * A queue position is part of the phase-1 promise, not just the dependency
     * graph. Everything above it on the daily tick feeds a live surface — the
     * player dictionary, the injury report, per-game usage, the season-long
     * market lines the draft board prices against, the matchup calibration
     * ledger, the published weekly fallback. A slow or hanging fetch placed
     * before those delays them, and an invocation killed part-way through never
     * reaches them at all, so a feed no recommendation reads could cost two
     * that several do.
     *
     * It was written directly after the usage refresh, which read well and was
     * wrong. This is what stops it drifting back.
     */
    const worker = readFileSync(path.join(ROOT, 'worker', 'index.ts'), 'utf8');
    const nflverse = worker.indexOf('new NflverseService(env.DB).refreshAll()');
    expect(nflverse, 'the daily tick should refresh the nflverse feeds').toBeGreaterThan(-1);

    for (const live of [
      'syncPlayers()',
      'refreshSeasonStats()',
      'new InjuryService(env.DB).refresh()',
      'new SeasonMarketService(env.DB, appEnv.vegas).refresh()',
      'refreshMatchupCalibration(env, appEnv)',
      'refreshPublishedProjections(env, appEnv)',
    ]) {
      const at = worker.indexOf(live);
      expect(at, `${live} should be on the daily tick`).toBeGreaterThan(-1);
      expect(at, `${live} must run before the nflverse refresh`).toBeLessThan(nflverse);
    }
  });

  it('the side-by-side service writes nothing', () => {
    /*
     * §21 asks for a report and this checks it stays one. No INSERT, no UPDATE,
     * no DELETE and no `save`/`record` call — there is deliberately no
     * `projection_v2` table for a recommendation to find later.
     */
    const service = readFileSync(path.join(ROOT, 'server', 'services', 'projectionV2Service.ts'), 'utf8');
    expect(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(service)).toBe(false);
    expect(/\.(save|saveWeeks|saveSnapshot|record|prune)\(/.test(service)).toBe(false);
  });
});
