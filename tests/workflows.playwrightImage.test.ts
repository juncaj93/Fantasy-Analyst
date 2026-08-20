import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The WebKit jobs run inside the official Playwright container image, and the
 * image tag has to match the `@playwright/test` in package.json.
 *
 * This is not a style rule. The image ships the browser builds for exactly one
 * Playwright release, so a mismatch means the test runner looks for a browser
 * revision that is not in the image and dies with "Executable doesn't exist" --
 * after checkout, after `npm ci`, inside a job that takes several minutes to
 * get there, on all four widths at once. A dependency bump is the obvious way
 * to cause it and gives no local signal at all, because nothing on a developer
 * machine reads these files.
 *
 * So it fails here instead: in `npm test`, in a second, naming the fix.
 */
const ROOT = join(import.meta.dirname, '..');

/** Every workflow job that launches a browser. */
const BROWSER_WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/smoke.yml'];

/*
 * From the lockfile, not from package.json.
 *
 * package.json asks for a range (`^1.49.1`), and a range is not a version: CI
 * runs `npm ci`, which installs precisely what package-lock.json resolved --
 * 1.62.1 today. Checking the range would compare the image against a number
 * nobody is running, and would go on passing through exactly the bump this
 * test exists to catch.
 */
function installedPlaywrightVersion(): string {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const version: string | undefined = lock.packages?.['node_modules/@playwright/test']?.version;
  expect(version, '@playwright/test should be in the lockfile').toBeTruthy();
  return version!;
}

/** The `container:` tags a workflow declares, without the registry prefix. */
function containerTags(workflow: string): string[] {
  const yaml = readFileSync(join(ROOT, workflow), 'utf8');
  return [...yaml.matchAll(/^\s*container:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
}

describe('the WebKit container tag tracks the installed Playwright', () => {
  it.each(BROWSER_WORKFLOWS)('%s pins the official image', (workflow) => {
    const tags = containerTags(workflow);
    expect(tags.length, `${workflow} should run its browser job in a container`).toBe(1);
    expect(tags[0]).toMatch(/^mcr\.microsoft\.com\/playwright:v[\d.]+-\w+$/);
  });

  it.each(BROWSER_WORKFLOWS)('%s matches package.json', (workflow) => {
    const version = installedPlaywrightVersion();
    expect(containerTags(workflow)[0]).toBe(`mcr.microsoft.com/playwright:v${version}-noble`);
  });

  /*
   * The image carries WebKit and everything it links against. Installing the
   * browser again on top of it is at best wasted minutes, and at worst the
   * thing that has already broken this repository twice: `--with-deps` pulls
   * WebKit's system packages from apt, and apt is what hung -- once for
   * thirty-four minutes, until the job timeout killed it.
   */
  it.each(BROWSER_WORKFLOWS)('%s does not install a browser on top of the image', (workflow) => {
    // Comments are dropped first: the notes in both files quote the old
    // `playwright install --with-deps webkit` command on purpose, to record
    // what went wrong, and that history should not trip its own guard.
    const executable = readFileSync(join(ROOT, workflow), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(executable, `${workflow} should not install a browser`).not.toMatch(
      /playwright\s+install/,
    );
  });
});
