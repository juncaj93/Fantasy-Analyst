/**
 * Say out loud when a scheduled workflow fails.
 *
 *   node scripts/scheduled-job-alert.mjs
 *
 * Reads its whole input from the environment `alert-on-failure.yml` gives it,
 * and keeps one issue — "Scheduled job failures" — in step with reality:
 *
 *   a scheduled job fails    ->  the issue is opened (or reopened), the job is
 *                                listed with the time and a link to the log
 *   it fails again           ->  that row's count and last run are updated;
 *                                no second issue, no second comment
 *   it succeeds              ->  the row goes away, and once no rows are left
 *                                the issue closes itself
 *
 * Why an issue rather than an email: two scheduled jobs failed here for twelve
 * days and for every run since it shipped, and GitHub's own failure email —
 * whatever became of it — is not something this repository can see, test or
 * fix. An issue is visible from the repository itself, costs nothing, needs no
 * new service and no new secret, and is checkable by the tests next door.
 *
 * The GitHub API is reached through a small injectable client so the whole
 * decision — open, update, comment, close — is exercised in tests/ without a
 * network. See scripts/lib/scheduledJobAlert.mjs for the state itself.
 */

import { pathToFileURL } from 'node:url';
import {
  ISSUE_LABEL,
  ISSUE_TITLE,
  nextState,
  parseState,
  renderComment,
  renderIssueBody,
  shouldBeOpen,
} from './lib/scheduledJobAlert.mjs';

/* ---------------------------------------------------------------- the client */

/** The four calls this needs, over the REST API, with the workflow's token. */
export function githubApi({ token, repository, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repository}`;
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text === '' ? null : JSON.parse(text);
  };

  return {
    /*
     * The label is what finds the issue again, so it has to exist before the
     * first issue is created. A repository that already has it answers 200 and
     * nothing happens.
     */
    async ensureLabel() {
      try {
        await call(`/labels/${encodeURIComponent(ISSUE_LABEL)}`);
      } catch {
        await call('/labels', {
          method: 'POST',
          body: JSON.stringify({
            name: ISSUE_LABEL,
            color: 'b60205',
            description: 'A scheduled workflow failed; opened and closed automatically',
          }),
        });
      }
    },

    /*
     * Open first, because that is the one that matters; a closed one is picked
     * up so a job that starts failing again reopens the issue it had before
     * rather than starting a new history.
     */
    async findIssue() {
      const found = await call(
        `/issues?labels=${encodeURIComponent(ISSUE_LABEL)}&state=all&sort=updated&direction=desc&per_page=20`,
      );
      const issues = (found ?? []).filter((issue) => !issue.pull_request);
      return issues.find((issue) => issue.state === 'open') ?? issues[0] ?? null;
    },

    async createIssue({ body }) {
      return call('/issues', {
        method: 'POST',
        body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] }),
      });
    },

    async updateIssue(number, fields) {
      return call(`/issues/${number}`, { method: 'PATCH', body: JSON.stringify(fields) });
    },

    async comment(number, body) {
      return call(`/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    },
  };
}

/* ----------------------------------------------------------------- the logic */

/**
 * One run's outcome, applied to the issue.
 *
 * Returns what it did, so the workflow log says it and the tests can assert it
 * without reading the issue back.
 */
export async function recordOutcome({ api, event, log = () => {} }) {
  if (event.result !== 'failure' && event.result !== 'success') {
    log(`${event.workflow}: ${event.result} — neither a failure nor a recovery, so nothing is recorded.`);
    return { action: 'ignored' };
  }

  const issue = await api.findIssue();
  const before = parseState(issue?.body);
  const { state, change } = nextState(before, event);

  // A success with nothing on file is the ordinary case, every day, for every
  // healthy job. It must not create an issue to announce that all is well.
  if (change === 'still-fine') {
    log(`${event.workflow}: succeeded, and was not listed as failing. Nothing to do.`);
    return { action: 'nothing' };
  }

  const body = renderIssueBody(state, { now: event.at });
  const comment = renderComment(change, event);

  if (!issue) {
    await api.ensureLabel();
    const created = await api.createIssue({ body });
    log(`Opened #${created.number} — ${ISSUE_TITLE}.`);
    return { action: 'opened', number: created.number, state };
  }

  const open = shouldBeOpen(state);
  // Read before the update: what the issue *was* is what says whether this
  // reopened it, and the update is about to change it.
  const wasOpen = issue.state === 'open';
  await api.updateIssue(issue.number, { body, state: open ? 'open' : 'closed' });

  // A first failure and a recovery are each worth a line in the thread. A job
  // on its twelfth consecutive failure updates the row silently, because twelve
  // notifications about one broken thing is how notifications get muted.
  const reopened = open && !wasOpen;
  if (comment) await api.comment(issue.number, comment);

  const action = !open ? 'closed' : reopened ? 'reopened' : 'updated';
  log(`${action} #${issue.number} — ${event.workflow} ${event.result} (${change}).`);
  return { action, number: issue.number, state };
}

/** The event, read from what GitHub Actions puts in the environment. */
export function eventFromEnv(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'ALERT_WORKFLOW', 'ALERT_RESULT'].filter(
    (key) => !env[key],
  );
  if (missing.length) throw new Error(`missing required environment: ${missing.join(', ')}`);
  return {
    workflow: env['ALERT_WORKFLOW'],
    result: env['ALERT_RESULT'],
    at: env['ALERT_AT'] || new Date().toISOString(),
    runUrl: env['ALERT_RUN_URL'] || '',
    runNumber: env['ALERT_RUN_NUMBER'] || '',
  };
}

/* ------------------------------------------------------------------ the CLI */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = eventFromEnv(process.env);
  const api = githubApi({
    token: process.env['GITHUB_TOKEN'],
    repository: process.env['GITHUB_REPOSITORY'],
  });
  try {
    await recordOutcome({ api, event, log: (line) => console.log(line) });
  } catch (err) {
    // This job is the thing that notices; it must not be the thing that goes
    // unnoticed. A red tick here says the alerting itself is broken.
    console.error(`::error::Could not record the outcome of "${event.workflow}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
