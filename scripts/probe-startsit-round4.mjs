/**
 * Round 4 (one toss-up bar, 4 November 2026): the one combined production read.
 *
 * Run after the D1 daily reset (7:05 PM ET in November, 00:05 UTC). Reads, once each:
 *
 *   - GET /api/health               the production SHA
 *   - GET /api/leagues              the selected league
 *   - GET /api/leagues/:id/roster   the stored roster: who sits in Sleeper's DEF
 *                                   slot, and every defense Alex holds
 *   - GET /api/leagues/:id/lineup   Team's swaps, toss-ups and fills under the bar
 *   - GET /api/leagues/:id/waivers  "Pick up and start" under the bar
 *
 * "Before" is the same answer read under the old bars (a swap at 0.75, a pickup
 * at 0.5), from the gains the new answer still carries. Reads only. No odds
 * are bought, nothing is written, Sleeper is not asked.
 */

const APP = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const et = (d) => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET';
const json = async (res) => (res.ok ? res.json() : { httpStatus: res.status });
const fmt = (v) => (v == null ? '-' : Number(v).toFixed(2));
const DEFENSE = new Set(['DEF', 'DST', 'D/ST']);

console.log(`started ${et(new Date())}`);
const health = await fetch(`${APP}/api/health`).then(json).catch(() => null);
console.log(`production sha: ${health?.release?.gitSha ?? '?'}`);
const leagues = await fetch(`${APP}/api/leagues`).then(json);
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) throw new Error('no selected league');

/* The DEF slot: what the stored roster says, not what the lineup recommends. */
const roster = await fetch(`${APP}/api/leagues/${leagueId}/roster`).then(json);
console.log('\n## The DEF slot, from the stored roster');
const positions = roster?.rosterPositions ?? [];
const slots = roster?.starterSlotIds ?? null;
const everyone = [...(roster?.starters ?? []), ...(roster?.bench ?? [])];
const byId = new Map(everyone.map((p) => [p.playerId, p]));
console.log(`roster positions: ${positions.join(' ')}`);
console.log(`starterSlotIds stored: ${slots ? 'yes' : 'no (older sync)'}`);
positions.forEach((pos, i) => {
  if (!DEFENSE.has(String(pos).toUpperCase())) return;
  const id = slots ? slots[i] : undefined;
  const p = id ? byId.get(id) : null;
  console.log(`  slot ${i} ${pos}: ${id === undefined ? 'unknown' : id === null ? 'EMPTY in Sleeper' : `${p?.name ?? id} (${p?.position || 'no position'}, id ${id})`}`);
});
const defenses = everyone.filter((p) => DEFENSE.has(String(p.position).toUpperCase()));
console.log(`defenses on the roster: ${defenses.length === 0 ? 'none' : defenses.map((p) => `${p.name} (id ${p.playerId}, ${(roster?.starters ?? []).some((s) => s.playerId === p.playerId) ? 'starting' : 'bench'})`).join('; ')}`);
const nameless = everyone.filter((p) => !p.position);
console.log(`roster players with no position stored: ${nameless.length === 0 ? 'none' : nameless.map((p) => `${p.name} (${p.playerId})`).join('; ')}`);

/* Team under the bar. */
const lineup = await fetch(`${APP}/api/leagues/${leagueId}/lineup`).then(json);
console.log('\n## Team: Best move and swaps');
const line = (w) => `${w.inName} over ${w.outName} at ${w.slot} +${fmt(w.gain)}`;
const swaps = lineup?.swaps ?? [];
const tossUps = lineup?.tossUps ?? null;
const fills = lineup?.fills ?? [];
console.log(`mode: ${lineup?.mode ?? '?'}; tossUps field: ${tossUps == null ? 'absent (old worker)' : 'present'}`);
console.log(`swaps now: ${swaps.map(line).join('; ') || 'none'}`);
console.log(`toss-ups now: ${(tossUps ?? []).map(line).join('; ') || 'none'}`);
console.log(`fills: ${fills.map((f) => `${f.inName} at ${f.slot} ${fmt(f.gain)}`).join('; ') || 'none'}`);
const before = [...swaps, ...(tossUps ?? []).filter((t) => t.gain >= 0.75)].sort((a, b) => b.gain - a.gain);
console.log(`swaps under the old 0.75 bar: ${before.map(line).join('; ') || 'none'}`);
for (const e of [...(lineup?.starters ?? []), ...(lineup?.bench ?? []), ...(lineup?.undecidable ?? [])]) {
  if (DEFENSE.has(String(e.position).toUpperCase())) {
    const where = (lineup?.starters ?? []).some((s) => s.playerId === e.playerId) ? 'recommended starter' : (lineup?.undecidable ?? []).some((s) => s.playerId === e.playerId) ? 'no number (undecidable)' : 'bench';
    console.log(`  defense in the lineup answer: ${e.name}, ${where}, score ${fmt(e.score)}, status ${e.statusFlag ?? 'none'}`);
  }
}

/* Pick up and start under the bar. */
const waivers = await fetch(`${APP}/api/leagues/${leagueId}/waivers`).then(json);
const p = waivers?.pickupStart;
console.log('\n## Pick up and start');
const say = (m) => (m ? `${m.name} (${m.position}) at ${m.slot ?? '?'}, ${fmt(m.points)}, gain +${fmt(m.gain)}, over ${m.displaces?.name ?? '(empty slot)'}` : 'none');
console.log(`threshold: ${p?.threshold ?? '?'}`);
console.log(`START now: ${say(p?.start)}`);
for (const c of p?.consider ?? []) console.log(`softer row now: ${say(c)}`);
const old = (p?.audit ?? []).filter((a) => (a.status === 'start' || a.status === 'consider') && (a.gain ?? -1) >= 0.5).sort((a, b) => b.gain - a.gain)[0];
console.log(`START under the old 0.5 bar: ${old ? `${old.name} +${fmt(old.gain)}` : 'none'}`);

console.log(`\nfinished ${et(new Date())}. Endpoints read once each: health, leagues, roster, lineup, waivers.`);
