# Working agreements — how an autonomous session runs here

Standing rules for anyone, human or agent, doing long autonomous work in this
repository. The other files in `docs/brief/` say what to build; this one says how
to run the session that builds it.

---

## The CI watcher rule

> Do not hold an open shell solely to watch CI, deployment, logs, or another
> remote process. Start the remote job, release the shell, and query status
> periodically. Before waiting longer than roughly five minutes on one shell
> command, determine whether the work is actually happening remotely. If yes,
> terminate only the local watcher and preserve the remote job. After a
> container or session restart, inspect git status, branch and head, PR state,
> uncommitted changes, and remote CI and deploy state before resuming. Resume
> from evidence rather than rerunning completed work.

This repository's CI runs a WebKit end-to-end suite that takes twelve to fifteen
minutes. That is long enough that a session which blocks on it spends most of
its life asleep, and long enough that a `sleep` loop looks exactly like a stuck
session. Neither is acceptable when the remote job is perfectly healthy.

**Local work is not a watcher.** `npx vitest run` and `CI=1 npm run e2e:chromium`
are doing the work themselves and should be left alone until they finish. The
rule is about processes whose only job is to wait for somebody else's.

---

## Never cancel remote work to unstick a local session

Stopping a local poller must not stop the GitHub Actions run, the deploy, or the
Cloudflare build it was watching. Cancel remote work only when there is a reason
to cancel *that work* — a bad commit, a superseded head, a runaway job.

---

## Exact-head discipline

The thing merged must be the thing validated.

If head `A` is green and a further change produces head `B`, then `A` is no
longer the merge proof. Push `B`, let CI run against it, and merge on that.
A green run against a head that no longer exists proves nothing about what would
land.

The corollary shapes what "independent safe work" means while CI runs: read-only
diagnosis, notes, and planning are free, but **do not commit to the branch under
test** unless you intend the new head to become the gate.

## Green-but-skipped is not green

A required job that did not execute has not passed. Check that the job ran, not
only that the run is not red.

---

## After a container restart

Git, PR state, CI state and the deployed state are authoritative. Memory of the
previous shell is not. Audit before acting:

branch and head · `git status` · uncommitted and untracked files · recent
commits · remote branch · open PR and its exact head · CI state for that head ·
deploy state.

Then continue only the missing work. Do not rerun an implementation that is
already committed, retrigger CI that is already running, or redeploy a deploy
that already completed, merely because the container restarted.

If uncommitted work survived, inspect it and carry on. If it is gone, work out
from `git status`, the reflog and the remote what was actually lost, and recreate
only that.

---

## Background process hygiene

Keep the number of long-lived local processes near zero. Before backgrounding
anything, ask whether it needs to stay alive locally; if not, do not background
it. Stop dev servers when the browser QA that needed them is done, and check for
an existing one before starting another. Do not leave orphaned Playwright or
Vitest processes, and do not run duplicate suites against the same database.

At each checkpoint, clean up: stale watchers, finished dev servers, log tails,
polling loops.

---

## Reporting

Report at meaningful checkpoints — implementation complete, exact head pushed,
CI started, CI finished, blocker found, deploy complete, restart audited — and
not on a timer. Repeating "still running" while nothing has changed is noise. If
a local task is genuinely taking unusually long, inspect it and say what it is
actually doing rather than leaving a vague running shell.

---

## Autonomy

Slow CI, a container restart, a killed watcher, or a stopped shell are not
reasons to ask the user for anything. Handle them.

Interrupt only for a real blocker: unavailable credentials, anything that would
cost money, a destructive or irreversible risk to data, an ambiguous production
recovery, a genuine product or architecture decision, or something that can only
be done on real hardware.
