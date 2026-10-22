/**
 * Every export in the web layer is used by something.
 *
 * An exported component nobody renders is dead weight that still has to be
 * read, typechecked and kept in step. This counts each `export function`,
 * `export const` and `export class` under `src/web` and fails when its name
 * appears nowhere but its own declaration, across `src`, `tests`, `e2e`,
 * `e2e-production` and `scripts`.
 *
 * Draft, mock-draft and Demo Mode files are left out on purpose: Alex wants
 * them back next season, unused or not. `KEPT` names the few other exports
 * kept for the same reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const KEPT = new Set([
  // The draft board's control icon; the board is off-season, not gone.
  'GridIcon',
]);
const SEASONAL = /(^|\/)(demo|mock)(\/|$)|draft/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

describe('the web layer', () => {
  it('exports nothing that nothing uses', () => {
    const all = ['src', 'tests', 'e2e', 'e2e-production', 'scripts'].flatMap((d) => files(join(ROOT, d)));
    const counts = new Map<string, number>();
    const texts = new Map<string, string>();
    for (const file of all) {
      const text = readFileSync(file, 'utf8');
      texts.set(file, text);
      for (const word of text.match(/[A-Za-z_$][\w$]*/g) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    const unused: string[] = [];
    for (const file of all) {
      const rel = relative(ROOT, file);
      if (!rel.startsWith('src/web/') || SEASONAL.test(rel)) continue;
      for (const m of texts.get(file)!.matchAll(/^export (?:async )?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = m[1]!;
        if (!KEPT.has(name) && (counts.get(name) ?? 0) <= 1) unused.push(`${rel}: ${name}`);
      }
    }
    expect(unused).toEqual([]);
  });
});
