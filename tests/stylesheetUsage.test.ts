/**
 * Every class the stylesheet styles is one the app can draw.
 *
 * The stylesheet is close to its 20 KB cap (see `perf-budgets.json`), and a
 * rule left behind by a removed component costs bytes on every page load
 * while doing nothing. This reads every class selector in `styles.css` and
 * asks whether the web source can produce it: as a whole token anywhere in a
 * `.ts` or `.tsx` file, or through a template that builds it from a prefix
 * (`card-pos-${pos}` covers `card-pos-QB`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '../src/web');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|html)$/.test(name) ? [readFileSync(path, 'utf8')] : [];
  });
}

function styledClasses(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set<string>();
  for (const m of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(m[1]!);
  return [...found];
}

describe('the stylesheet', () => {
  it('styles no class the app never draws', () => {
    const css = readFileSync(join(WEB, 'styles.css'), 'utf8');
    const code = sources(WEB).join('\n');
    const prefixes = [...code.matchAll(/([a-z0-9][\w-]*-)\$\{/g)].map((m) => m[1]!);
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const unused = styledClasses(css).filter(
      (name) =>
        !new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(code) &&
        !prefixes.some((prefix) => name.startsWith(prefix)),
    );
    expect(unused).toEqual([]);
  });
});
