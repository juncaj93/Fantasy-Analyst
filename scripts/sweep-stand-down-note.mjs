/**
 * Say, once a day, that the daily sweep did not run.
 *
 *   node scripts/sweep-stand-down-note.mjs
 *
 * Reads GITHUB_TOKEN, GITHUB_REPOSITORY, SWEEP_PERCENT and SWEEP_CEILING from
 * the environment `smoke-daily.yml` gives it.
 *
 * When the D1 budget guard declines the sweep, nothing was tested, and the one
 * thing that must not happen is the tracking issue ("Scheduled job failures")
 * reading as though it had been. This adds a single line to that issue and
 * touches nothing else on it: not the body, not the state, not the table. An
 * issue that was closed stays closed, an issue listing failures keeps listing
 * them.
 *
 * At most one such line per UTC day. A hand-dispatched run on a day the
 * scheduled one already stood down finds the earlier line and adds nothing.
 */

import { pathToFileURL } from 'node:url';
import { githubApi } from './scheduled-job-alert.mjs';

/** What every note starts with; it is also how today's note is recognised. */
export const NOTE_PREFIX = 'Sweep did not run today:';

export const noteText = ({ percent, ceiling }) =>
  `${NOTE_PREFIX} D1 reads at ${percent}% (guard ${ceiling}%).`;

/**
 * Returns what it did: `commented`, `already-noted` or `no-issue`.
 *
 * With no tracking issue on file there is nowhere to say it. That is not an
 * error, because the alert opens the issue on the first real failure; the run's
 * own summary carries the message in the meantime.
 */
export async function noteStandDown({ api, percent, ceiling, now = new Date(), log = () => {} }) {
  const issue = await api.findIssue();
  if (!issue) {
    log('No tracking issue exists, so there is nothing to comment on.');
    return { action: 'no-issue' };
  }

  const today = now.toISOString().slice(0, 10);
  const comments = await api.listComments(issue.number, `${today}T00:00:00Z`);
  const earlier = comments.find(
    (c) => typeof c.body === 'string' && c.body.startsWith(NOTE_PREFIX) && String(c.created_at ?? '').startsWith(today),
  );
  if (earlier) {
    log(`#${issue.number} already carries today's note, so nothing is added.`);
    return { action: 'already-noted', number: issue.number };
  }

  await api.comment(issue.number, noteText({ percent, ceiling }));
  log(`Commented on #${issue.number} (${issue.state}); the issue itself was not changed.`);
  return { action: 'commented', number: issue.number };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'SWEEP_PERCENT', 'SWEEP_CEILING'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`::error::missing required environment: ${missing.join(', ')}`);
    process.exit(1);
  }
  const api = githubApi({ token: env['GITHUB_TOKEN'], repository: env['GITHUB_REPOSITORY'] });
  try {
    await noteStandDown({
      api,
      percent: env['SWEEP_PERCENT'],
      ceiling: env['SWEEP_CEILING'],
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`::error::Could not record the stand-down: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
