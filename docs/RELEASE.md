# Releasing, and putting a release back

Production runs one revision at a time, it says which one, and putting a
previous one back is a form you fill in rather than an incident you survive.

## The normal release

```
PR green  ->  merge  ->  CI passes for that exact SHA  ->  Deploy checks out that
              SHA  ->  production reports that SHA  ->  smoke asserts that SHA
```

Nobody runs a command. `deploy.yml` starts when **CI completes on main**, not
when the push lands — the two used to start together, which meant a commit could
be live before the WebKit gate for that same commit had finished judging it.

What each file does:

| Workflow | Starts when | Does |
|---|---|---|
| `ci.yml` | push to main, and every PR | typecheck, unit + integration, build, perf budget, wrangler dry-run, WebKit at 430/390/375/360 across three shards |
| `deploy.yml` | CI **succeeded**, on main | decides whether that revision is still the one to ship, then calls Release and Smoke |
| `release.yml` | called only | checks out that exact SHA, stamps it into the Worker, migrates, builds, deploys, checks production reports it |
| `rollback.yml` | you, by hand | the same, for a revision you name |
| `smoke.yml` | called, or by hand | asserts production is the expected SHA, then checks the live site on three iPhone widths |

## What is running right now

```bash
curl -s https://fantasy-analyst.juncaj93.workers.dev/api/health
# {"ok":true,"service":"fantasy-analyst","release":{"gitSha":"21c37b4…"}}
```

Or with the comparison built in:

```bash
node scripts/check-release-sha.mjs https://fantasy-analyst.juncaj93.workers.dev
```

`release.gitSha` is written into `wrangler.toml` by the release workflow in the
step before the build, so it is compiled into the Worker. `unknown` means the
deployment did not come from the release path — a hand-run `wrangler deploy`,
usually.

## Rolling back

1. Find the last known-good SHA. Every Deploy and Rollback run names its revision
   in the run summary; `/api/health` names the one that is live.
2. Actions → **Rollback** → *Run workflow* → paste the SHA (or a tag), and a
   one-line reason.
3. It validates the revision is real and is part of main's history, refusing
   otherwise. There is no fallback to main anywhere in the file.
4. `release.yml` deploys exactly that revision. Smoke then asserts production is
   answering as it — using that revision's own `e2e-production/` suite, because
   an older UI should be judged by the assertions it shipped with.
5. Fix forward afterwards: revert on main through a PR like any other change.
   Rollback never writes to the repository.

Rollback is also the only way to deploy by hand. `deploy.yml` cannot be started
from the Actions tab, because "deploy whatever main is now" is the thing this
arrangement exists to remove.

## Migrations: expand first, contract later

**A code rollback is not a data rollback.** Migrations apply forward only, and
nothing puts a dropped column back. So the rule is about keeping the door open:

- **Expand.** Add tables, columns and indexes. Never drop, never rename, never
  repurpose. The *previous* release has to keep working against the new schema —
  that is the whole point, and it is what makes a rollback routine.
- **Transition.** New code starts writing and reading the new shape. Ship it.
- **Contract.** Only once the rollback window has passed, and ideally in its own
  migration and its own PR, remove what nothing reads any more.

A migration that drops, renames or deletes closes the rollback path for every
release before it — hours before anyone discovers they needed it. So one is
allowed only with a line saying why it is safe now:

```sql
-- contract: player_signal_cache.recent21_net has been unread since 0031 (Nov 2025)
```

`tests/release.migrations.test.ts` enforces that. Do not write fake down
migrations; a down migration that cannot restore the data is worse than none,
because it is believed.

### What a rollback actually recovers

| Bad release | Rolling back gets you |
|---|---|
| UI only | everything back, immediately |
| Model or scoring logic, no schema change | everything back, immediately |
| Additive migration + bad code | the code back. The new columns stay and sit unread — harmless, because the old code never knew about them |
| Destructive migration + bad code | the code back, and the data still gone. This is the case expand/contract exists to prevent, and the only real defence is upstream: do not write one |

Anything a cron wrote while the bad release was live is also still there.
Rollback restores code, not history.

## Two releases at once

Both `deploy.yml` and `rollback.yml` sit in one concurrency group, so nothing
ever writes to the Worker twice at the same time, and neither cancels the other.
CI has its own group keyed by ref, so an ordinary push cannot cancel a rollback.

When main moves while CI is running — A merges, then B merges before A's CI
finishes — whichever revision is main's head when its CI passes is the one that
deploys. The other stands down and says so in its summary, because releasing it
would move production backwards.

The honest cost: if A is superseded by B and B's CI then fails, production stays
on the revision before A. It is behind main, and it is a revision that passed
CI. `/api/health` says which one it is, and Rollback can put A live by name.

## Browser verification

Sharded and parallel, always: four widths × three shards in CI, three widths in
smoke. Never a serial sweep, never a raised timeout to cover a slow one, never a
Playwright run piped through `tail` or `grep` — a pipe reports the exit code of
the last command in it, which turns a failing suite into a green tick.
