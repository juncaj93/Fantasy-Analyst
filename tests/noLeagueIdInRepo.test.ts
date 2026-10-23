/**
 * The real league's Sleeper id is not written anywhere in this public repository.
 *
 * Probe scripts read it from the `SLEEPER_LEAGUE_ID` secret (docs/SETUP.md).
 * This test cannot name the id it looks for without publishing it, so it
 * compares the SHA-256 of every 15-to-20-digit number in the tracked text
 * against the id's digest.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const LEAGUE_DIGEST = 'c91a21f1e3c0374c7032d79b45cfdcb72c41fb242561b4db091764865aa905d8';

describe('the public repository', () => {
  it('never spells out the real league id', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|tsx|mjs|js|json|md|yml|yaml|toml|sql|html|css|txt)$/.test(f));
    const hits: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(/\b\d{15,20}\b/g)) {
        if (createHash('sha256').update(m[0]).digest('hex') === LEAGUE_DIGEST) hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
