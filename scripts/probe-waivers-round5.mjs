/**
 * Waivers round 5 (November 2026 review: W1, W2, W6, W7, W8, W11, W12, X3,
 * and the defence on a bye): the round's ONE combined production check.
 * Read-only, and Sleeper is never called.
 *
 *   1. the deployed SHA (`/api/health`) and today's D1 rows before and after;
 *   2. the Waivers screen as the phone reads it (`/api/leagues/:id/waivers`,
 *      once): Do this, Worth considering and the Watch list with each row's
 *      reason, gain, drop and bid; the defence plan; every bye week's number;
 *      the lowest drop scores; any Sleeper-only free agent the tiers ranked;
 *   3. X3, the two reads that came back as Cloudflare's 503 page in the
 *      review's probe, once each: the waiver-plan support snapshot and the
 *      trade-value replay. Status, size and time only.
 *
 * "Before" is the review's own read of the same screen (3 November, 12:31 AM
 * ET, register `docs/REVIEW_2026-11.md`), printed alongside.
 *
 * The Probe workflow runs the D1 budget guard first. Run after 7:05 PM ET.
 * Times printed in Eastern.
 */

import { spawnSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const heading = (t) => console.log(`\n${'#'.repeat(70)}\n# ${t}\n${'#'.repeat(70)}`);
const eastern = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));

async function getJson(path) {
  const started = Date.now();
  const res = await fetch(`${APP}${path}`).catch((err) => ({ ok: false, status: String(err), headers: new Map() }));
  const text = res.ok || typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ms: Date.now() - started, bytes: text.length, html: /^\s*</.test(text), body };
}

/** Today's D1 rows, from Cloudflare's own analytics (free; no database read). */
function rowsToday() {
  if (!process.env.CLOUDFLARE_API_TOKEN) return null;
  const run = spawnSync(process.execPath, ['scripts/d1-budget-guard.mjs', '--ceiling', '100', '--what', 'waivers round 5 probe'], {
    encoding: 'utf8',
    env: process.env,
  });
  const match = /([\d,]+) of 5,000,000 rows read today/.exec(`${run.stdout}${run.stderr}`);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

console.log(`Started ${eastern()} ET`);
const before = rowsToday();
console.log(`D1 rows read today before: ${before ?? 'unknown'}`);

heading('Production SHA');
const health = await getJson('/api/health');
console.log(`production sha: ${health.body?.release?.gitSha ?? '?'}`);
const setup = await getJson('/api/setup/status');
const leagueId = process.env.LEAGUE_ID || setup.body?.league?.id;
console.log(`league: ${leagueId ? 'found' : '?'}`);
if (!leagueId) process.exit(0);

heading('Waivers, as the phone reads it (one request)');
const w = await getJson(`/api/leagues/${encodeURIComponent(leagueId)}/waivers`);
console.log(`HTTP ${w.status}, ${w.ms} ms, ${w.bytes} bytes`);
const t = w.body?.tiers ?? null;
if (t) {
  console.log(`window: weeks ${t.window?.weeks?.join(', ')} weighted ${t.window?.weights?.join(', ')}; valued ${t.valued}, unvalued ${t.unvalued}`);
  const row = (r) => {
    const bid = r.bid?.kind === 'free' ? 'free agent' : r.bid?.kind === 'claim' ? (r.bid.recommended == null ? 'waivers, no bid' : `bid $${r.bid.recommended} ($${r.bid.low}-${r.bid.high})`) : r.bid?.kind ?? '?';
    const drop = r.needsSpot ? `needs a drop (${r.needsSpot.map((c) => c.name).join(', ') || 'none listed'})` : r.drop ? `${r.drop.viaReserve ? 'IR' : 'drop'} ${r.drop.name}` : 'open spot';
    const weeks = (r.weekNumbers ?? []).map((n) => `w${n.week} ${n.source === 'bye' ? 'BYE' : fmt(n.points)}${n.fromWeek ? ` (wk ${n.fromWeek} proj)` : ''}`).join(' ');
    return `${r.name} (${r.position}) [${r.reasonCode}] "${r.reason}"; gain ${fmt(r.gain)}; ${drop}; ${bid}; alternatives ${(r.alternatives ?? []).join(', ') || 'none'}; ${weeks}`;
  };
  for (const r of t.doThese ?? []) console.log(`DO THIS: ${row(r)}`);
  for (const r of t.consider ?? []) console.log(`CONSIDER: ${row(r)}`);
  for (const r of t.watch ?? []) console.log(`WATCH: ${row(r)}`);
  console.log(`drop-ready: ${(t.dropReady ?? []).map((d) => `${d.name} (${d.reason})`).join('; ') || 'none'}`);
  console.log(`lowest drop scores: ${(t.dropScores ?? []).slice(0, 6).map((d) => `${d.name} ${fmt(d.score)}${d.protectedAs ? ` [${d.protectedAs}]` : ''} recent ${JSON.stringify(d.factors?.recent ?? null)} weeks ${d.factors?.weeksPlayed ?? '?'}`).join('; ')}`);
  heading('Every bye week in the window (W1)');
  for (const [id, f] of Object.entries(t.weekFigures ?? {})) {
    for (const wk of f.weeks ?? []) {
      if (wk.bye) console.log(`${f.name} (${f.position} ${f.team}) w${wk.week}: points ${wk.points}, source ${wk.source}`);
      else if (wk.fromWeek) console.log(`${f.name} w${wk.week}: ${fmt(wk.points)} from week ${wk.fromWeek}'s projection`);
    }
    void id;
  }
  heading('Top of the audit: gains the tiers rank on (W2)');
  for (const a of (t.audit ?? []).slice(0, 8)) {
    console.log(`${a.name} (${a.position}) gain ${fmt(a.gain)} by week ${JSON.stringify(a.byWeek)}; "${a.reason}"; numbers ${(a.weekNumbers ?? []).map((n) => `${fmt(n.points)}/${n.source}`).join(' ')}`);
  }
} else {
  console.log('no tiers in the response');
}
const claim = w.body?.claimPlan;
console.log(`claim card: ${claim?.surface ? claim.claims.map((c) => c.headline).join(' | ') : claim?.headline ?? 'none'}`);

heading('The defence (DEF on a bye)');
const dst = w.body?.dst;
if (dst) {
  console.log(`decision ${dst.decision}, surface ${dst.surface}, activation ${dst.activation}`);
  console.log(`headline: ${dst.headline}`);
  console.log(`why: ${(dst.why ?? []).join(' / ')}`);
  console.log(`current: ${dst.current?.name ?? 'none'} (${dst.current?.unavailableReason ?? 'plays'}); target: ${dst.target?.name ?? 'none'} ${fmt(dst.target?.thisWeek)} addable now ${dst.target?.addableNow ?? '?'}`);
  console.log(`notes: ${(dst.notes ?? []).join(' / ')}`);
} else {
  console.log('no defence plan');
}

heading('Pick up and start (the same call Team reads)');
const ps = w.body?.pickupStart;
console.log(`start: ${ps?.start ? `${ps.start.name} +${fmt(ps.start.gain)} over ${ps.start.displaces?.name ?? 'an empty slot'}` : 'none'}; ties: ${(ps?.consider ?? []).map((c) => `${c.name} +${fmt(c.gain)}`).join(', ') || 'none'}`);

heading('X3: the two reads that were a 503 page (once each)');
const snap = await getJson(`/api/leagues/${encodeURIComponent(leagueId)}/support-snapshot?context=waiver-plan`);
console.log(`waiver-plan support snapshot: HTTP ${snap.status}, ${snap.ms} ms, ${snap.bytes} bytes${snap.html ? ', HTML page' : ''}`);
const replay = await getJson('/api/diagnostics/trade-values');
console.log(`trade-value replay: HTTP ${replay.status}, ${replay.ms} ms, ${replay.bytes} bytes${replay.html ? ', HTML page' : ''}`);

heading('Before (the review, 3 November 12:31 AM ET)');
console.log('Worth considering: C.J. Stroud (QB), "Your QB Jordan Love is on bye in week 11"; drop Antonio Williams; bid $5 ($3 to $25)');
console.log('Bye weeks carried numbers: A. Williams w9 4.89, Love w11 18.00, Pittsburgh DEF w9 9.25, all labelled this week');

const after = rowsToday();
console.log(`\nD1 rows read today after: ${after ?? 'unknown'}${before != null && after != null ? ` (+${after - before}; Cloudflare's count can lag a few minutes)` : ''}`);
console.log(`Finished ${eastern()} ET`);
