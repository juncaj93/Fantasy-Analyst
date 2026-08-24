/**
 * Projection v2 against the 2025 season that actually happened.
 *
 *   node --experimental-strip-types scripts/projection-v2-backtest.mjs
 *
 * Read-only. It downloads public files into a cache directory, imports the same
 * `src/core` modules the Worker runs, and prints. It touches no database and no
 * deployment.
 *
 * ## What can honestly be measured, and what cannot
 *
 * §22 asks for four numbers: market-anchor error, Projection v2 error, Rotowire
 * fallback error, and calibration by confidence tier. Three of those are
 * computable here. The first is not, and it is worth being exact about why.
 *
 * **This app has no betting-market history.** Props are cached as snapshots for
 * the current week and are not retained per historical week, the provider is on
 * the mock adapter by default, and no vendor publishes free historical player
 * props. So "what did the market say about Chris Olave in week 9 of 2025" is a
 * question nothing available can answer, and any number claiming to be
 * market-anchor error would be invented.
 *
 * What is available is **Rotowire's published weekly projection**, through
 * Sleeper, for every week of 2025 — 6,165 player-weeks. It is a real,
 * independent, third-party forecast, it is the app's own tier-2 fallback, and,
 * critically for this test, it is published **per component**: `rec_tgt`,
 * `rec`, `rec_yd`, `rec_td`, `rush_att`, `rush_yd`, `rush_td`, `pass_yd`,
 * `pass_td`. That component structure is the same structure a market has, and
 * it is the structure Projection v2's gap fill operates on.
 *
 * So this backtest uses it two ways, and labels them differently everywhere:
 *
 *   - as the **fallback baseline**, which is what it is in the app today;
 *   - as a **proxy anchor** — component lines fed through the same
 *     `buildAnchor` a market's contributions go through — so the gap-fill and
 *     double-counting arithmetic can be exercised against something real.
 *
 * A proxy anchor is not a market and nothing here pretends it is. What it can
 * establish is structural: whether filling a withheld component beats having no
 * estimate, whether a full-coverage anchor survives v2 untouched, and how often
 * the fresh-information path fires at all. What it cannot establish is whether
 * betting markets are sharper than Rotowire. That question is answerable only
 * by running one real season with the props feed enabled, and it is named as
 * the open item rather than answered here.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoster, rosterUrl, toIdentityLinks } from '../src/core/nflverse/roster.ts';
import { parseWeeklyUsage, weeklyStatsUrl } from '../src/core/usage/nflverse.ts';
import { parseSnapCounts, snapCountsUrl } from '../src/core/nflverse/snapCounts.ts';
import { buildFeatures, teamWeekTotals } from '../src/core/projection/features.ts';
import { buildAnchor } from '../src/core/projection/anchor.ts';
import { projectV2 } from '../src/core/projection/v2.ts';
import { buildExpectation } from '../src/core/startsit/expectation.ts';
import { actualPoints } from '../src/core/xfp/model.ts';

const SEASON = process.env.SEASON ?? '2025';
const CACHE = process.env.BACKTEST_CACHE ?? join(process.cwd(), '.backtest-cache');
/** Weeks projected. Six is the first with a five-game window behind it. */
const FIRST_WEEK = Number(process.env.FIRST_WEEK ?? 6);
const LAST_WEEK = Number(process.env.LAST_WEEK ?? 18);

/** Full PPR, to match Sleeper's `pts_ppr` exactly. Comparing under two scorings would be meaningless. */
const PROFILE = {
  ppr: 1,
  teBonus: 0,
  pointsPerRushYard: 0.1,
  pointsPerRecYard: 0.1,
  pointsPerPassYard: 0.04,
  passTd: 4,
  rushTd: 6,
  recTd: 6,
  interception: -2,
  fumbleLost: -2,
  superflex: false,
  tePremium: false,
  label: 'Full PPR',
};

mkdirSync(CACHE, { recursive: true });

async function cached(name, url) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  process.stderr.write(`downloading ${name}...\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  writeFileSync(path, text);
  return text;
}

function sleeperProjectionUrl(season, week) {
  const positions = ['QB', 'RB', 'WR', 'TE'].map((p) => `position[]=${p}`).join('&');
  return `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&${positions}&order_by=ppr`;
}

// ------------------------------------------------------------------ load ---

const rosterText = await cached(`roster_${SEASON}.csv`, rosterUrl(SEASON));
const statsText = await cached(`stats_player_week_${SEASON}.csv`, weeklyStatsUrl(SEASON));
const snapsText = await cached(`snap_counts_${SEASON}.csv`, snapCountsUrl(SEASON));

const roster = parseRoster(rosterText);
const crosswalk = toIdentityLinks(roster, 'roster', null);
/** gsis -> sleeper, and back. The bridge, measured on a real workload below. */
const sleeperByGsis = new Map();
const gsisBySleeper = new Map();
const pfrToGsis = new Map();
for (const link of crosswalk) {
  if (link.sleeperId) {
    sleeperByGsis.set(link.gsisId, link.sleeperId);
    gsisBySleeper.set(link.sleeperId, link.gsisId);
  }
  if (link.pfrId) pfrToGsis.set(link.pfrId, link.gsisId);
}

/** Every regular-season week of usage, by gsis id. */
const usageByPlayer = new Map();
const positionOf = new Map();
const teamOf = new Map();
for (let week = 1; week <= LAST_WEEK; week++) {
  const parsed = parseWeeklyUsage(statsText, { week });
  for (const row of parsed.rows) {
    if (row.seasonType.toUpperCase() !== 'REG') continue;
    positionOf.set(row.gsisId, row.position);
    teamOf.set(row.gsisId, row.team);
    const list = usageByPlayer.get(row.gsisId) ?? [];
    list.push({
      week: row.week,
      seasonType: row.seasonType,
      team: row.team,
      passAttempts: row.passAttempts,
      carries: row.carries,
      targets: row.targets,
      receptions: row.receptions,
      targetShare: row.targetShare,
      wopr: row.wopr,
      passYards: row.passYards,
      passTds: row.passTds,
      rushYards: row.rushYards,
      rushTds: row.rushTds,
      recYards: row.recYards,
      recTds: row.recTds,
      receivingAirYards: row.receivingAirYards,
      airYardsShare: row.airYardsShare,
    });
    usageByPlayer.set(row.gsisId, list);
  }
}

/** Snap weeks, joined pfr -> gsis through the crosswalk. */
const snapsByPlayer = new Map();
let snapRowsSeen = 0;
let snapRowsJoined = 0;
for (let week = 1; week <= LAST_WEEK; week++) {
  const parsed = parseSnapCounts(snapsText, { week });
  for (const row of parsed.rows) {
    if (row.gameType !== 'REG') continue;
    snapRowsSeen++;
    const gsisId = pfrToGsis.get(row.pfrId);
    if (!gsisId) continue;
    snapRowsJoined++;
    const list = snapsByPlayer.get(gsisId) ?? [];
    list.push({ week: row.week, gameType: row.gameType, offenseSnaps: row.offenseSnaps, offenseShare: row.offenseShare });
    snapsByPlayer.set(gsisId, list);
  }
}

/** Rotowire's own weekly numbers, by week then by Sleeper id. */
const rotowire = new Map();
for (let week = 1; week <= LAST_WEEK; week++) {
  const raw = JSON.parse(await cached(`sleeper_${SEASON}_w${week}.json`, sleeperProjectionUrl(SEASON, week)));
  const byPlayer = new Map();
  for (const row of raw) {
    const stats = row?.stats ?? {};
    if (stats.pts_ppr == null) continue;
    byPlayer.set(String(row.player_id), stats);
  }
  rotowire.set(week, byPlayer);
}

// ------------------------------------------------------- the proxy anchor ---

/**
 * Rotowire's component projections, shaped like the props `buildExpectation`
 * reads.
 *
 * Deliberately built through the *same* function a real market goes through, so
 * the anchor arithmetic under test is the shipping arithmetic and not a
 * reimplementation of it. `withhold` simulates the coverage gaps that are the
 * ordinary state of a real props feed.
 */
function proxyProps(stats, position, withhold = new Set()) {
  const props = [];
  const add = (market, line, impliedProbability = null) => {
    if (withhold.has(market)) return;
    if (line == null && impliedProbability == null) return;
    props.push({
      playerId: 'x',
      sourcePlayerName: 'x',
      market,
      line,
      overPrice: -110,
      underPrice: -110,
      bookCount: 4,
      books: [],
      consensusMethod: 'median',
      impliedProbability,
    });
  };
  if (position === 'QB') {
    add('pass_yards', num(stats.pass_yd));
    add('pass_tds', num(stats.pass_td));
    add('rush_yards', num(stats.rush_yd));
  } else {
    add('rush_yards', num(stats.rush_yd));
    add('receiving_yards', num(stats.rec_yd));
    add('receptions', num(stats.rec));
    const scores = (num(stats.rec_td) ?? 0) + (num(stats.rush_td) ?? 0);
    // The same Poisson mapping the fill uses, so the two are comparable.
    if (scores > 0) add('anytime_td', null, 1 - Math.exp(-scores));
  }
  return props;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// -------------------------------------------------------------- the sweep ---

/** Coverage regimes, chosen to bracket what a real props feed actually does. */
const REGIMES = [
  { key: 'full', label: 'every component priced', withhold: new Set() },
  { key: 'no_receptions', label: 'receptions line missing', withhold: new Set(['receptions']) },
  { key: 'yards_only', label: 'yards only, no receptions or TD', withhold: new Set(['receptions', 'anytime_td']) },
  { key: 'none', label: 'nothing priced — usage model alone', withhold: new Set(['pass_yards', 'pass_tds', 'rush_yards', 'receiving_yards', 'receptions', 'anytime_td']) },
];

const rows = [];
let playerWeeks = 0;
let rotowireUnjoined = 0;

for (let week = FIRST_WEEK; week <= LAST_WEEK; week++) {
  const projections = rotowire.get(week) ?? new Map();
  // Club denominators from the weeks strictly before this one.
  const priorLeagueWeeks = [];
  for (const [gsisId, weeks] of usageByPlayer) {
    for (const w of weeks) if (w.week < week) priorLeagueWeeks.push({ ...w, team: w.team ?? teamOf.get(gsisId) });
  }
  const totals = teamWeekTotals(priorLeagueWeeks);

  for (const [gsisId, weeks] of usageByPlayer) {
    const actualWeek = weeks.find((w) => w.week === week);
    if (!actualWeek) continue; // he did not play; nothing to score against
    const position = positionOf.get(gsisId);
    if (!['QB', 'RB', 'WR', 'TE'].includes(position)) continue;

    const sleeperId = sleeperByGsis.get(gsisId);
    const stats = sleeperId ? projections.get(sleeperId) : null;
    if (!stats) {
      if (sleeperId) rotowireUnjoined++;
      continue; // no baseline to compare against
    }

    const actual = actualPoints(position, actualWeek, PROFILE);
    if (!actual) continue;
    playerWeeks++;

    const priorWeeks = weeks.filter((w) => w.week < week);
    const priorSnaps = (snapsByPlayer.get(gsisId) ?? []).filter((s) => s.week < week);
    const features = buildFeatures(position, priorWeeks, {
      snaps: priorSnaps,
      teamTotals: totals,
      team: actualWeek.team ?? teamOf.get(gsisId),
    });

    /** A deliberately dumb baseline: his own trailing three games. */
    const trailing = priorWeeks
      .slice(-3)
      .map((w) => actualPoints(position, w, PROFILE)?.points)
      .filter((p) => p != null);
    const naive = trailing.length > 0 ? trailing.reduce((a, b) => a + b, 0) / trailing.length : null;

    const perRegime = {};
    for (const regime of REGIMES) {
      const expectation = buildExpectation(position, proxyProps(stats, position, regime.withhold), PROFILE);
      const projection = projectV2({
        playerId: sleeperId ?? gsisId,
        name: gsisId,
        position,
        team: actualWeek.team ?? null,
        expectation,
        features,
        profile: PROFILE,
        identity: 'sleeper_direct',
        // No historical props timestamp exists, so the fresh-information gate
        // cannot open here at all. That is the conservative direction and it is
        // why this backtest measures the *structure* rather than the C path.
        marketAsOf: null,
      });
      perRegime[regime.key] = projection;
      if (regime.key === 'full') {
        perRegime.fullAnchor = buildAnchor(position, expectation, features, PROFILE).points;
      }
    }

    rows.push({
      week,
      gsisId,
      position,
      actual: actual.points,
      rotowire: num(stats.pts_ppr),
      naive,
      perRegime,
    });
  }
}

// -------------------------------------------------------------- reporting ---

function mae(values) {
  const present = values.filter((v) => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + Math.abs(b), 0) / present.length;
}

function rmse(values) {
  const present = values.filter((v) => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return Math.sqrt(present.reduce((a, b) => a + b * b, 0) / present.length);
}

function fixed(v, places = 2) {
  return v == null ? '—' : v.toFixed(places);
}

const line = (s = '') => process.stdout.write(`${s}\n`);

line();
line('Projection v2 — 2025 backtest');
line('='.repeat(78));
line();
line(`Season ${SEASON}, weeks ${FIRST_WEEK}–${LAST_WEEK}, full PPR.`);
line(`Player-weeks scored: ${playerWeeks}`);
line();

line('Identity, on a real workload');
line('-'.repeat(78));
line(`  roster rows at carried positions        ${roster.rows.length}`);
line(`  with a sleeper_id                       ${crosswalk.filter((l) => l.sleeperId).length} (${pct(crosswalk.filter((l) => l.sleeperId).length, crosswalk.length)})`);
line(`  with a pfr_id                           ${crosswalk.filter((l) => l.pfrId).length} (${pct(crosswalk.filter((l) => l.pfrId).length, crosswalk.length)})`);
line(`  snap rows joined pfr -> gsis            ${snapRowsJoined} of ${snapRowsSeen} (${pct(snapRowsJoined, snapRowsSeen)})`);
line(`  players with usage but no Rotowire row  ${rotowireUnjoined} player-weeks (he was not projected that week)`);
line();

line('Error against what actually happened, by coverage regime');
line('-'.repeat(78));
line('  regime                          n      MAE    RMSE   vs Rotowire');
for (const regime of REGIMES) {
  const errs = rows.map((r) => (r.perRegime[regime.key].points == null ? null : r.perRegime[regime.key].points - r.actual));
  const rot = rows.map((r) => (r.rotowire == null ? null : r.rotowire - r.actual));
  const n = errs.filter((e) => e != null).length;
  const delta = mae(errs) != null && mae(rot) != null ? mae(errs) - mae(rot) : null;
  line(
    `  ${regime.label.padEnd(30)} ${String(n).padStart(5)}  ${fixed(mae(errs)).padStart(6)}  ${fixed(rmse(errs)).padStart(6)}  ${delta == null ? '—' : (delta >= 0 ? '+' : '') + fixed(delta)}`,
  );
}
{
  const rot = rows.map((r) => (r.rotowire == null ? null : r.rotowire - r.actual));
  const nai = rows.map((r) => (r.naive == null ? null : r.naive - r.actual));
  line(`  ${'Rotowire (the app’s fallback)'.padEnd(30)} ${String(rot.filter((e) => e != null).length).padStart(5)}  ${fixed(mae(rot)).padStart(6)}  ${fixed(rmse(rot)).padStart(6)}       0.00`);
  line(`  ${'trailing 3-game average'.padEnd(30)} ${String(nai.filter((e) => e != null).length).padStart(5)}  ${fixed(mae(nai)).padStart(6)}  ${fixed(rmse(nai)).padStart(6)}  ${mae(nai) != null && mae(rot) != null ? (mae(nai) - mae(rot) >= 0 ? '+' : '') + fixed(mae(nai) - mae(rot)) : '—'}`);
}
line();

line('Does a full anchor survive v2 untouched?');
line('-'.repeat(78));
{
  const moved = rows.filter((r) => {
    const p = r.perRegime.full.points;
    const a = r.perRegime.fullAnchor;
    return p != null && a != null && Math.abs(p - a) > 0.005;
  });
  line(`  player-weeks with full component coverage   ${rows.length}`);
  line(`  where v2 differs from the anchor at all     ${moved.length} (${pct(moved.length, rows.length)})`);
  line('  (the fresh-information gate needs a market timestamp, which no historical');
  line('   props snapshot exists to supply, so it cannot open in this backtest)');
}
line();

line('Gap fill: does estimating a withheld component beat leaving it out?');
line('-'.repeat(78));
for (const regime of REGIMES.slice(1, 3)) {
  const filled = rows.map((r) => (r.perRegime[regime.key].points == null ? null : r.perRegime[regime.key].points - r.actual));
  const full = rows.map((r) => (r.perRegime.full.points == null ? null : r.perRegime.full.points - r.actual));
  line(`  ${regime.label}`);
  line(`    MAE with the component filled from usage   ${fixed(mae(filled))}`);
  line(`    MAE with every component priced           ${fixed(mae(full))}`);
  line(`    cost of losing that line                  ${fixed(mae(filled) - mae(full))}`);
}
line();

line('Calibration: does the interval hold, and does confidence mean anything?');
line('-'.repeat(78));
line('  A nominal 10–90 interval should contain the outcome 80% of the time, below');
line('  it 10% and above it 10%. `scaled error` is |v2 - actual| divided by the');
line('  projection: MAE is scale-dependent, and a high-confidence player is usually');
line('  a high-volume one, so comparing raw MAE across tiers compares workloads.');
line();
for (const regime of ['full', 'none']) {
  const label = REGIMES.find((r) => r.key === regime).label;
  line(`  regime: ${label}`);
  line('    confidence      n    below   inside   above     MAE   scaled err   mean cv');
  for (const tier of ['high', 'medium', 'low']) {
    const subset = rows.filter((r) => r.perRegime[regime].confidence.level === tier && r.perRegime[regime].interval);
    if (subset.length === 0) {
      line(`    ${tier.padEnd(12)} ${String(0).padStart(5)}        —        —       —       —            —         —`);
      continue;
    }
    const below = subset.filter((r) => r.actual < r.perRegime[regime].interval.floor);
    const above = subset.filter((r) => r.actual > r.perRegime[regime].interval.ceiling);
    const inside = subset.length - below.length - above.length;
    const errs = subset.map((r) => r.perRegime[regime].points - r.actual);
    const scaled = subset
      .filter((r) => r.perRegime[regime].points > 1)
      .map((r) => (r.perRegime[regime].points - r.actual) / r.perRegime[regime].points);
    const spread = subset.reduce((a, r) => a + r.perRegime[regime].uncertainty.cv, 0) / subset.length;
    line(
      `    ${tier.padEnd(12)} ${String(subset.length).padStart(5)}   ${pct(below.length, subset.length).padStart(6)}   ${pct(inside, subset.length).padStart(6)}  ${pct(above.length, subset.length).padStart(6)}  ${fixed(mae(errs)).padStart(6)}   ${fixed(mae(scaled)).padStart(10)}   ${fixed(spread).padStart(7)}`,
    );
  }
  line();
}

line('  and the same, by position, in the full-coverage regime');
line('    position        n    below   inside   above    mean cv');
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  const subset = rows.filter((r) => r.position === position && r.perRegime.full.interval);
  if (subset.length === 0) continue;
  const below = subset.filter((r) => r.actual < r.perRegime.full.interval.floor);
  const above = subset.filter((r) => r.actual > r.perRegime.full.interval.ceiling);
  const inside = subset.length - below.length - above.length;
  const spread = subset.reduce((a, r) => a + r.perRegime.full.uncertainty.cv, 0) / subset.length;
  line(
    `    ${position.padEnd(12)} ${String(subset.length).padStart(5)}   ${pct(below.length, subset.length).padStart(6)}   ${pct(inside, subset.length).padStart(6)}  ${pct(above.length, subset.length).padStart(6)}   ${fixed(spread).padStart(8)}`,
  );
}
line();

line('Where v2 lands, by basis');
line('-'.repeat(78));
for (const regime of REGIMES) {
  const counts = { market: 0, market_plus_model: 0, model: 0, none: 0 };
  for (const r of rows) counts[r.perRegime[regime.key].basis]++;
  line(
    `  ${regime.label.padEnd(30)} market ${String(counts.market).padStart(5)}  +model ${String(counts.market_plus_model).padStart(5)}  model ${String(counts.model).padStart(5)}  none ${String(counts.none).padStart(5)}`,
  );
}
line();

line('The ten largest disagreements with Rotowire, usage model alone');
line('-'.repeat(78));
{
  const ranked = rows
    .filter((r) => r.perRegime.none.points != null && r.rotowire != null)
    .map((r) => ({ ...r, gap: r.perRegime.none.points - r.rotowire }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 10);
  line('  wk  pos  gsis           v2     rotowire   actual    gap   confidence');
  for (const r of ranked) {
    line(
      `  ${String(r.week).padStart(2)}  ${r.position.padEnd(3)}  ${r.gsisId.padEnd(12)} ${fixed(r.perRegime.none.points).padStart(6)}  ${fixed(r.rotowire).padStart(9)}  ${fixed(r.actual).padStart(7)}  ${fixed(r.gap).padStart(6)}   ${r.perRegime.none.confidence.level}`,
    );
  }
}
line();

function pct(part, whole) {
  if (!whole) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}
