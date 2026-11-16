// Decode the probe's bundle from a saved job log: node unpack.mjs <log.txt> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
let raw = readFileSync(process.argv[2], 'utf8');
try { const j = JSON.parse(raw); raw = j.logs_content ?? j.logs?.[0]?.logs_content ?? raw; } catch {}
const lines = raw.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
const a = lines.findIndex((l) => l.includes('-----BEGIN ROUND29 BUNDLE-----'));
const b = lines.findIndex((l) => l.includes('-----END ROUND29 BUNDLE-----'));
if (a < 0 || b < 0) throw new Error(`markers not found (${a}, ${b})`);
const b64 = lines.slice(a + 1, b).join('').replace(/[^A-Za-z0-9+/=]/g, '');
const json = gunzipSync(Buffer.from(b64, 'base64'));
writeFileSync(process.argv[3], json);
console.log(`bundle: ${json.length} bytes, sha256 ${createHash('sha256').update(json).digest('hex')}`);
