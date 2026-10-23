/**
 * Every sheet closes with the same X (23 October 2026).
 *
 * The X in a grey rounded square at the top right, named "Close" for a screen
 * reader, was Compare's alone from 16 October; every other sheet said Done. The
 * shared `Sheet` now draws only the X and takes no option to draw anything
 * else (TypeScript refuses a `close` prop), and these checks fail if a word
 * comes back into it or a Done button is written by hand.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(process.cwd(), 'src/web');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The body of the shared `Sheet` component, from its signature to the next export. */
function sheetComponent(): string {
  const native = readFileSync(join(WEB, 'components/native.tsx'), 'utf8');
  const start = native.indexOf('export function Sheet(');
  expect(start, 'the shared Sheet component').toBeGreaterThan(-1);
  const end = native.indexOf('\nexport ', start + 1);
  return native.slice(start, end === -1 ? undefined : end);
}

describe('the sheet close control', () => {
  it('is the X named "Close", and never a word', () => {
    const sheet = sheetComponent();
    expect(sheet).toMatch(/className="sheet-close-x"[^>]*aria-label="Close"/);
    expect(sheet).toContain('<CloseIcon');
    expect(sheet, 'a close button in words').not.toMatch(/>\s*(Done|Close)\s*</);
    expect(sheet, 'a choice of close style').not.toMatch(/\bclose\??:\s*['"]?(done|x)/);
  });

  it('is not hand-written as a Done button anywhere in the app', () => {
    const offenders = sources(WEB).filter((file) => />\s*Done\s*<\/button>|['"]Done['"]/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
