/**
 * Round 16: the one combined production read for the rest-of-season backtest.
 *
 * Read-only. Runs `probe-round16-gather.ts` once (Sleeper's documented league
 * endpoints, plus SELECTs on production D1 through the app's repositories),
 * then prints the gathered file into the log as gzip + base64 between two
 * marker lines, so it can be saved to `docs/backtest/round16-data.json` and
 * the backtest re-run with no database read at all:
 *
 *   node --experimental-transform-types --no-warnings scripts/probe-round16-score.ts docs/backtest/round16-data.json
 *
 * It also runs that backtest here, on the same file, so the log carries the
 * answer as well as the data.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const eastern = (d = new Date()) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
console.log(`Round 16 backtest probe, started ${eastern()} ET`);

const dir = mkdtempSync(join(tmpdir(), 'round16-'));
const file = join(dir, 'round16-data.json');
const ts = (script, args) =>
  execFileSync('node', ['--experimental-transform-types', '--no-warnings', script, ...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });

console.log(ts('scripts/probe-round16-gather.ts', [file]));

const raw = readFileSync(file);
const packed = gzipSync(raw, { level: 9 }).toString('base64');
console.log(`data: ${raw.length.toLocaleString('en-US')} bytes, sha256 ${createHash('sha256').update(raw).digest('hex')}`);
console.log('-----BEGIN ROUND16 DATA-----');
for (let i = 0; i < packed.length; i += 4000) console.log(packed.slice(i, i + 4000));
console.log('-----END ROUND16 DATA-----');

try {
  console.log(ts('scripts/probe-round16-score.ts', [file]));
} catch (err) {
  console.log(`backtest run failed here (the data above is still complete): ${String(err?.stderr ?? err).slice(0, 2000)}`);
}
console.log(`finished ${eastern()} ET`);
