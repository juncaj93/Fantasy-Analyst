/**
 * The Home Screen web app's paperwork.
 *
 * iOS decides whether "Add to Home Screen" produces an app or a bookmark by
 * reading the manifest and the icons, and it does that once, silently, with no
 * error anybody sees. So the things that would break it are asserted here:
 * a missing icon file, a size that does not match the declaration, a page that
 * stopped linking the manifest, a display mode that stopped being standalone.
 *
 * These read the repository's source rather than a built site; the e2e suite
 * checks the same things over HTTP, where the content type also matters.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../src/web/${path}`, import.meta.url)));

const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

const html = read('index.html').toString('utf8');

/** A PNG's dimensions live in the IHDR chunk, at a fixed offset. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1'), 'not a PNG').toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the web app manifest', () => {
  it('asks for a standalone window, which is the whole point', () => {
    // `standalone` is what drops Safari's URL field and button bar. Anything
    // else here and the Home Screen icon opens an ordinary tab again.
    expect(manifest.display).toBe('standalone');
  });

  it('starts at the app and owns the whole site', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('is named, with a short name that fits under an icon', () => {
    expect(manifest.name).toBe('Fantasy Analyst');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  /*
   * The launch background is the dark theme's page black rather than the light
   * one's. iOS paints it before the app's own CSS exists and the manifest
   * cannot ask a question about the phone's appearance, so one of the two
   * themes has to take the flash — and a dark frame on the way into a light app
   * is a great deal less unpleasant than a white one on the way into a dark app
   * at night.
   */
  it('launches on the dark page colour', () => {
    expect(manifest.background_color).toBe('#0d1116');
    expect(manifest.theme_color).toBe('#0d1116');
  });

  it('ships icons that exist, at the sizes it claims', () => {
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/'), `${icon.src} must be an absolute path`).toBe(true);
      const bytes = read(`public${icon.src}`);
      const { width, height } = pngSize(bytes);
      expect(`${width}x${height}`, `${icon.src} is not the size it declares`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });

  it('includes a maskable icon and a 512 for the install sheet', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
  });
});

describe('the iOS metadata on the page', () => {
  it('links the manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  /* Safari uses this one for the Home Screen icon; the manifest is not enough. */
  it('ships an apple-touch-icon, 180 square', () => {
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(pngSize(read('public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('declares itself web-app capable in both spellings', () => {
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
  });

  /*
   * Not `black-translucent`: that puts the page behind the clock, and this app
   * has no header to spend on it. See the comment in index.html.
   */
  it('lets iOS draw the status bar', () => {
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
  });

  it('covers the display, so the safe areas are the app’s to manage', () => {
    expect(html).toContain('viewport-fit=cover');
  });

  it('names the Home Screen icon the same as the manifest does', () => {
    expect(html).toContain(`name="apple-mobile-web-app-title" content="${manifest.short_name}"`);
  });
});
