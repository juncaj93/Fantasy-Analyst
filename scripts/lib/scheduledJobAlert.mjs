/**
 * The state a "Scheduled job failures" issue carries, and how it changes.
 *
 * Separated from the script that talks to the GitHub API so the part that can
 * be wrong — which job is listed, since when, how many times, and whether the
 * issue should still be open — is decidable from a unit test rather than only
 * from a workflow run that has to fail on purpose first.
 *
 * The issue body is both the report and the store: the table is for a reader,
 * the JSON in the HTML comment below it is what the next run reads back. One
 * issue holds every scheduled workflow, so a job failing for the twelfth day
 * updates a row rather than opening a twelfth issue.
 */

/** Everything between these two markers is the machine-readable state. */
const OPEN = '<!-- scheduled-job-alert:state';
const CLOSE = '-->';

export const ISSUE_TITLE = 'Scheduled job failures';
export const ISSUE_LABEL = 'scheduled-job-failure';

/**
 * Read the state back out of an issue body.
 *
 * A body with no marker — an issue somebody wrote by hand, or one from before
 * this existed — reads as empty rather than throwing, so the next failure
 * rebuilds it instead of leaving the alert stuck.
 */
export const parseState = (body) => {
  const empty = { failing: {} };
  if (typeof body !== 'string') return empty;
  const start = body.indexOf(OPEN);
  if (start === -1) return fromTable(body);
  const end = body.indexOf(CLOSE, start + OPEN.length);
  if (end === -1) return fromTable(body);
  try {
    const parsed = JSON.parse(body.slice(start + OPEN.length, end));
    const failing = parsed && typeof parsed === 'object' ? parsed.failing : null;
    if (!failing || typeof failing !== 'object') return fromTable(body);
    return { failing: { ...failing } };
  } catch {
    return fromTable(body);
  }
};

/**
 * The same state, read back out of the table a human reads.
 *
 * The marker is the store; this is what happens when it is not there — an
 * issue somebody edited, or a renderer somewhere that strips HTML comments.
 * Without it a lost marker would silently reset every count to one and leave
 * the issue open forever, because nothing would remember what it was tracking.
 *
 * Everything the table prints comes back; the seconds do not, and nothing
 * depends on them.
 */
const fromTable = (body) => {
  const failing = {};
  //   | job | 2026-08-16 11:45 UTC (11 days) | 12 | [run 16](url) — 2026-08-27 11:45 UTC |
  const row =
    /^\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC[^|]*\|\s*(\d+)\s*\|\s*(?:\[run ([^\]]*)\]\(([^)]*)\)|run ([^—|]*?))\s*—\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\s*\|$/;
  for (const line of body.split('\n')) {
    const match = row.exec(line.trim());
    if (!match) continue;
    const [, workflow, sinceDay, sinceTime, count, runNumber, runUrl, plainRun, atDay, atTime] = match;
    failing[workflow] = {
      since: `${sinceDay}T${sinceTime}:00Z`,
      count: Number(count),
      at: `${atDay}T${atTime}:00Z`,
      runUrl: runUrl ?? '',
      runNumber: (runNumber ?? plainRun ?? '').trim(),
    };
  }
  return { failing };
};

/**
 * Fold one run's outcome into the state.
 *
 * `event.result` is the calling job's own result, so `cancelled` and `skipped`
 * arrive here too and mean neither "broken" nor "fixed": a cancelled run is
 * somebody pressing stop, and treating it as a recovery would clear a genuine
 * failure that is still there.
 */
export const nextState = (state, event) => {
  const failing = { ...state.failing };
  const { workflow, result, at, runUrl, runNumber } = event;

  if (result === 'failure') {
    const existing = failing[workflow];
    failing[workflow] = {
      since: existing?.since ?? at,
      count: (existing?.count ?? 0) + 1,
      at,
      runUrl,
      runNumber,
    };
    return { state: { failing }, change: existing ? 'still-failing' : 'newly-failing' };
  }

  if (result === 'success') {
    if (!failing[workflow]) return { state: { failing }, change: 'still-fine' };
    delete failing[workflow];
    return { state: { failing }, change: 'recovered' };
  }

  return { state: { failing }, change: 'ignored' };
};

const stamp = (iso) => {
  // `2026-08-27T20:57:26Z` reads as `2026-08-27 20:57 UTC` — a date somebody
  // can compare against a cron without decoding it.
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
};

const days = (since, at) => {
  const from = new Date(since).getTime();
  const to = new Date(at).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
};

/** The issue body: the table a reader sees, then the state the next run reads. */
export const renderIssueBody = (state, { now } = {}) => {
  const rows = Object.entries(state.failing).sort(([a], [b]) => a.localeCompare(b));

  const lines = [
    'A scheduled GitHub Actions workflow in this repository failed. This issue is',
    'opened, updated and closed by `.github/workflows/alert-on-failure.yml`, which',
    "every scheduled workflow calls as its last job — so a job that fails every day",
    'updates the row below rather than opening a new issue each morning.',
    '',
  ];

  if (rows.length === 0) {
    lines.push('Nothing is failing. Every job listed here has since had a successful run.', '');
  } else {
    lines.push('| job | failing since | consecutive failures | last run |', '|---|---|---|---|');
    for (const [workflow, entry] of rows) {
      const age = days(entry.since, entry.at);
      const since = `${stamp(entry.since)}${age ? ` (${age} day${age === 1 ? '' : 's'})` : ''}`;
      const run = entry.runUrl
        ? `[run ${entry.runNumber ?? '?'}](${entry.runUrl})`
        : `run ${entry.runNumber ?? '?'}`;
      lines.push(`| ${workflow} | ${since} | ${entry.count} | ${run} — ${stamp(entry.at)} |`);
    }
    lines.push(
      '',
      'The run link is the failing log. Fixing the cause is enough to close this:',
      "the next successful run of that job takes its row away, and the issue closes",
      'itself once no rows are left.',
      '',
    );
  }

  if (now) lines.push(`_Last updated ${stamp(now)}._`, '');

  lines.push(`${OPEN}`, JSON.stringify({ version: 1, failing: state.failing }, null, 2), CLOSE);
  return lines.join('\n');
};

/** The one-line comment posted when a job starts failing, or stops. */
export const renderComment = (change, event) => {
  const where = event.runUrl ? ` — [run ${event.runNumber ?? '?'}](${event.runUrl})` : '';
  if (change === 'newly-failing') {
    return `**${event.workflow}** failed at ${stamp(event.at)}${where}.`;
  }
  if (change === 'recovered') {
    return `**${event.workflow}** succeeded again at ${stamp(event.at)}${where}, and is no longer listed above.`;
  }
  return null;
};

/** Whether the issue should be open after this event. */
export const shouldBeOpen = (state) => Object.keys(state.failing).length > 0;
