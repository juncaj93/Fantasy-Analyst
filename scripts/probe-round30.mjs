/**
 * Round 30: one combined, read-only production check after the deploy.
 *
 *  - the live SHA (/api/health);
 *  - the Waivers screen as the phone reads it (GET, public), which is the new
 *    pickup and drop logic live, with its read cost;
 *  - the waiver-plan support snapshot (the inputs Waivers decided on), so the
 *    plan can be replayed offline with the old and the new code for Wed 18 Nov.
 *
 * GETs only, three of them. No SQL. Everything is printed packed, with the
 * league ids replaced, between ROUND30 markers.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const APP = 'https://fantasy-analyst.juncaj93.workers.dev';
const SLEEPER_LEAGUE = process.env.SLEEPER_LEAGUE_ID ?? '';
const et = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function getApp(path) {
  const t0 = Date.now();
  const res = await fetch(`${APP}${path}`, { signal: AbortSignal.timeout(90_000), headers: { 'cache-control': 'no-cache' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  console.log(`  ${path.replace(/leagues\/[^/]+/, 'leagues/LEAGUE').padEnd(60)} HTTP ${res.status} ${String(Date.now() - t0).padStart(6)} ms ${String(text.length).padStart(9)} bytes${body?.cost ? `  cost ${JSON.stringify(body.cost).slice(0, 160)}` : ''}`);
  return { status: res.status, body, text: body ? null : text.slice(0, 400) };
}

const bundle = { startedAt: new Date().toISOString() };
console.log(`## Round 30 check, started ${et(bundle.startedAt)} ET`);
bundle.health = (await getApp('/api/health')).body;
console.log(`  live SHA: ${bundle.health?.release?.gitSha ?? JSON.stringify(bundle.health).slice(0, 120)}`);
const lg = await getApp('/api/leagues');
const leagueId = process.env.LEAGUE_ID || lg.body?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');
const L = encodeURIComponent(leagueId);
bundle.waivers = await getApp(`/api/leagues/${L}/waivers?cost=1`);
bundle.snapshot = await getApp(`/api/leagues/${L}/support-snapshot?context=waiver-plan`);
bundle.finishedAt = new Date().toISOString();

const w = bundle.waivers.body ?? {};
const s = w.pickupStart?.start;
console.log(`\n## Live answer`);
console.log(`  Best move pickup: ${s ? `add ${s.name}, ${s.drop ? `drop ${s.drop.name}` : s.pickDrop ? `pick your drop (${s.pickDrop.map((x) => x.name).join(', ')})` : 'open spot'}, +${Number(s.gain).toFixed(1)}` : 'none'}`);
for (const r of w.tiers?.doThese ?? []) console.log(`  Do this: ${r.name} (${r.position}) ${r.drop ? `drop ${r.drop.name}` : 'no drop'}; bid ${r.bid?.kind} ${r.bid?.recommended ?? '-'}; ${r.reason}`);

let json = JSON.stringify(bundle);
for (const secret of [SLEEPER_LEAGUE, leagueId].filter((x) => x && String(x).length >= 6)) json = json.split(String(secret)).join('LEAGUE');
const packed = gzipSync(Buffer.from(json), { level: 9 }).toString('base64');
console.log(`\n  bundle: ${json.length} bytes, sha256 ${createHash('sha256').update(json).digest('hex')}`);
console.log('-----BEGIN ROUND30 BUNDLE-----');
for (let i = 0; i < packed.length; i += 4000) console.log(packed.slice(i, i + 4000));
console.log('-----END ROUND30 BUNDLE-----');
console.log(`  finished ${et(bundle.finishedAt)} ET`);
