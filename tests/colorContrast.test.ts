/**
 * Small text clears WCAG AA (4.5:1) on every light surface it sits on.
 *
 * Read from the stylesheet's own light tokens, so a later change to a colour
 * is checked here rather than on a phone in daylight. The October 2026 audit
 * found the faint grey at 4.23:1 and the green at 4.49:1 on the sunken grey.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../src/web/styles.css'), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root);
  if (!m) throw new Error(`no light token --${name}`);
  return m[1]!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('light-mode text contrast', () => {
  for (const text of ['text-dim', 'text-faint', 'pos', 'neg', 'warn', 'accent-text']) {
    for (const surface of ['bg', 'surface', 'surface-sunken', 'surface-inset']) {
      it(`--${text} on --${surface} is at least 4.5:1`, () => {
        expect(contrast(token(text), token(surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
