/**
 * Has a full production pass already run today?
 *
 *   node scripts/sweep-ran-today.mjs
 *
 * Reads GH_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID from the environment
 * `smoke-daily.yml` gives it, and writes `ran_today=yes|no` to GITHUB_OUTPUT.
 *
 * Two kinds of run count, both started today (UTC):
 *
 *  - a hand-dispatched `smoke.yml`, which is a full pass by default;
 *  - any earlier run of `smoke-daily.yml` itself, scheduled or by hand, whose
 *    full-pass browser jobs actually ran. Until October 2026 only the first
 *    kind was counted, so a hand-started daily sweep and the scheduled one on
 *    the same day both ran, each about a third of the D1 allowance.
 *
 * A daily run that stood down (because of this check, or because the budget
 * guard declined it) ran no browser job and does not count: nothing was tested,
 * so a later run that same day is still worth having. Neither does a run that
 * was cancelled before its shards started.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A full-pass shard is named `smoke (1/3)`; the deploy gate is `smoke (deploy gate)`. */
export function isFullPassShard(name) {
  const n = String(name ?? '');
  return /smoke \(\d+\/\d+\)/.test(n);
}

/** Whether a job got far enough to read the live site. */
function jobRan(job) {
  return job.status === 'in_progress' || job.conclusion === 'success' || job.conclusion === 'failure';
}

/**
 * Counts today's passes from what the API returned.
 *
 * `manualSmokeRuns` are `smoke.yml` runs with event workflow_dispatch;
 * `dailyRuns` are `smoke-daily.yml` runs, each with its `jobs`.
 */
export function passesToday({ today, currentRunId, manualSmokeRuns, dailyRuns }) {
  const startedToday = (run) => String(run.created_at ?? '').startsWith(today);
  const manual = manualSmokeRuns.filter(startedToday).length;
  const daily = dailyRuns
    .filter(startedToday)
    .filter((run) => String(run.id) !== String(currentRunId))
    .filter((run) => (run.jobs ?? []).some((job) => isFullPassShard(job.name) && jobRan(job))).length;
  return { manual, daily, total: manual + daily };
}

async function main() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const currentRunId = process.env.GITHUB_RUN_ID ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const api = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub API GET ${path} -> ${res.status}`);
    return res.json();
  };

  let counts = { manual: 0, daily: 0, total: 0 };
  try {
    const manual = await api(`/actions/workflows/smoke.yml/runs?event=workflow_dispatch&created=%3E%3D${today}&per_page=50`);
    const daily = await api(`/actions/workflows/smoke-daily.yml/runs?created=%3E%3D${today}&per_page=20`);
    const dailyRuns = [];
    for (const run of daily.workflow_runs ?? []) {
      if (String(run.id) === String(currentRunId)) continue;
      const jobs = await api(`/actions/runs/${run.id}/jobs?per_page=50`);
      dailyRuns.push({ ...run, jobs: jobs.jobs ?? [] });
    }
    counts = passesToday({ today, currentRunId, manualSmokeRuns: manual.workflow_runs ?? [], dailyRuns });
  } catch (err) {
    // Unreadable is "no": the budget guard inside the sweep is the backstop.
    console.log(`Could not read today's runs (${err.message}); treating it as none.`);
  }

  console.log(`full passes already run today: ${counts.total} (hand-dispatched smoke ${counts.manual}, earlier daily sweeps ${counts.daily})`);
  const ranToday = counts.total > 0 ? 'yes' : 'no';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ran_today=${ranToday}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && ranToday === 'yes') {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Daily sweep stood down',
        '',
        `${counts.total} full production pass(es) already ran today against the same live site (${counts.manual} hand-dispatched, ${counts.daily} earlier daily sweep(s)).`,
        'Running another one learns nothing and costs about a third of the daily D1 allowance.',
        '',
      ].join('\n'),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
