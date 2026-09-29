/**
 * What shape is the live waiver plan in?
 *
 * The production sweep's "one See why" check found a drawn plan card with no
 * button. The card offers See why only when the plan has something beyond its
 * headline, so this prints exactly the fields that decide that, and nothing
 * about any player. Read-only: one GET of the public waivers read.
 */

const BASE = process.env.BASE ?? 'https://fantasy-analyst.juncaj93.workers.dev';

const leagues = await fetch(`${BASE}/api/leagues`).then((r) => r.json());
const leagueId = process.env.LEAGUE_ID || leagues?.leagues?.find((l) => l.isSelected)?.id;
if (!leagueId) {
  console.error('no selected league');
  process.exit(1);
}

const res = await fetch(`${BASE}/api/leagues/${leagueId}/waivers`);
console.log(`GET /api/leagues/${leagueId}/waivers -> HTTP ${res.status}`);
const body = await res.json();
const plan = body.claimPlan ?? null;
if (!plan) {
  console.log('claimPlan: null');
  process.exit(0);
}

const len = (x) => (Array.isArray(x) ? x.length : 0);
console.log(`surface          ${plan.surface}`);
console.log(`state            ${plan.state}`);
console.log(`headline         ${plan.headline}`);
console.log(`note             ${plan.note ?? '(none)'}`);
console.log(`claims           ${len(plan.claims)}`);
console.log(`protectedPlayers ${len(plan.protectedPlayers)}`);
console.log(`outcomes         ${len(plan.outcomes)}`);
console.log(`relationships    ${len(plan.relationships)}`);
console.log(`mechanics        ${plan.mechanics == null ? 'null' : 'set'}`);
console.log(`budget           ${plan.budget == null ? 'null' : 'set'}`);
const hasWhy =
  len(plan.claims) > 0 ||
  len(plan.protectedPlayers) > 0 ||
  len(plan.outcomes) > 0 ||
  len(plan.relationships) > 0 ||
  plan.mechanics != null ||
  plan.budget != null;
console.log(`=> card drawn: ${plan.surface}, See why offered: ${hasWhy}`);
