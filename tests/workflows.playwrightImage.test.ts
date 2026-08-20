import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The WebKit jobs run inside the official Playwright container image, and the
 * image tag has to stay in step with the Playwright the lockfile resolves to.
 *
 * Both workflows already notice drift for themselves — they compare the two and
 * download the browser the installed Playwright wants, so a mismatch degrades to
 * a warning and a minute of download rather than a broken job. That is the right
 * behaviour in CI, and it is also the reason drift can persist: a warning costs
 * a minute per width per push and nothing ever forces anyone to read it.
 *
 * This is the half that CI cannot do. `@playwright/test` is a caret range, so
 * the bump that causes drift is a lockfile update with no local signal at all —
 * nothing on a developer machine reads these files. Failing here puts the repin
 * in front of whoever ran `npm install`, in a second, before the minute-per-job
 * starts being paid.
 */
const ROOT = join(import.meta.dirname, '..');

/** Every workflow job that launches a browser. */
const BROWSER_WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/smoke.yml'];

/*
 * From the lockfile, not from package.json.
 *
 * package.json asks for a range (`^1.49.1`), and a range is not a version: CI
 * runs `npm ci`, which installs precisely what package-lock.json resolved.
 * Checking the range would compare the image against a number nobody is
 * running, and would go on passing through exactly the bump this exists to
 * catch.
 */
function lockedPlaywrightVersion(): string {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const version: string | undefined = lock.packages?.['node_modules/@playwright/test']?.version;
  expect(version, '@playwright/test should be in the lockfile').toBeTruthy();
  return version as string;
}

/**
 * The image tags a workflow pins.
 *
 * Both spellings YAML allows for `container:` — the bare string and the mapping
 * with `image:` — because a job that grows an `options:` line changes from one
 * to the other, and a checker that only understood the old spelling would go
 * quietly green on a file it could no longer see.
 */
function containerImages(workflow: string): string[] {
  const yaml = readFileSync(join(ROOT, workflow), 'utf8');
  return [
    ...[...yaml.matchAll(/^\s*container:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? ''),
    ...[...yaml.matchAll(/^\s*image:\s*(mcr\.microsoft\.com\/playwright\S*)\s*$/gm)].map((m) => m[1] ?? ''),
  ];
}

describe('the WebKit container tag tracks the installed Playwright', () => {
  it.each(BROWSER_WORKFLOWS)('%s runs its browser job in the official image', (workflow) => {
    const images = containerImages(workflow);
    expect(images.length, `${workflow} should pin exactly one container image`).toBe(1);
    expect(images[0]).toMatch(/^mcr\.microsoft\.com\/playwright:v[\d.]+-\w+$/);
  });

  it.each(BROWSER_WORKFLOWS)('%s pins the version the lockfile resolves to', (workflow) => {
    expect(containerImages(workflow)[0]).toBe(
      `mcr.microsoft.com/playwright:v${lockedPlaywrightVersion()}-noble`,
    );
  });

  /*
   * The workflows' own drift check hardcodes the version it compares against,
   * because a shell step cannot import this file. So the number it quotes has
   * to be the number the image is tagged with, or it warns about the wrong
   * thing — or, worse, stays silent through a real mismatch.
   */
  it.each(BROWSER_WORKFLOWS)('%s compares against the tag it actually pins', (workflow) => {
    const tag = containerImages(workflow)[0]!.replace(/^.*:v/, '').replace(/-\w+$/, '');
    const yaml = readFileSync(join(ROOT, workflow), 'utf8');
    const compared = [...yaml.matchAll(/\[ "\$wanted" != "([\d.]+)" \]/g)].map((m) => m[1]);
    expect(compared.length, `${workflow} should check the lockfile against its pin`).toBeGreaterThan(0);
    for (const version of compared) expect(version).toBe(tag);
  });
});
