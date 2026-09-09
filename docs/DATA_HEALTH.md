# Data Health

Support Snapshot answers **what Junculator knew** when it made a decision. This
answers the question directly beside it: **was what it knew healthy and
current?**

A recommendation built on a betting line from Wednesday, an injury report that
has not published for this week, or a manager ledger that yielded its
subrequests to the injury check is not a *wrong* recommendation. It is a correct
recommendation about degraded inputs, and telling those two apart is the first
fork of every diagnosis. Before this existed, that fork required opening
Cloudflare's tail, the Actions tab and D1.

The whole surface is one row in Setup and one pushed screen behind it. It is not
a monitoring platform: no history, no charts, no alerting, no retention.

---

## The three refusals

**`not_published` is never a failure.** The NFL publishes a week's injury report
when it publishes it; nflverse publishes a season's snap file when the games
have been played. A source that has correctly nothing to say is `waiting`, and
calling that a fault trains a reader to ignore the one word that means somebody
has to do something.

**Last attempt is not last success.** The pair is why a five-minute injury check
can look perfectly healthy while four consecutive ingests have died —
`checked_at` moves every tick and `ingested_at` has not moved since Tuesday.
Every source carries both, and its state is derived from whichever one its own
policy says is the real question.

**Unknown stays unknown.** A source nothing has ever recorded a timestamp for is
`unknown`, not `current` and not `missing`.

---

## The model

`src/core/health/model.ts`. Two vocabularies, and neither is a boolean.

A **source** is `current`, `stale`, `waiting`, `degraded`, `missing`,
`deferred` or `unknown`.

The **overall** state is one of the five words a person reads — `Healthy`,
`Waiting on source`, `Some data stale`, `Degraded`, `Refresh problem` — plus
`unknown` for a deployment nothing has run on.

A **run** is `succeeded`, `partial`, `deferred`, `failed` or `unknown`, derived
from its steps rather than declared, so a run cannot report success while
carrying a failed step. A **step** is `succeeded`, `not_published`, `deferred`,
`skipped` or `failed` — the pipelines' own `ok | not_published | failed` triple,
preserved rather than replaced, translated in exactly one place
(`stepOutcomeFrom`).

**Severity** is decision impact, not volume. A missing injury report on Sunday
morning changes who starts; a manager ledger three days behind changes a `Next%`
by a point or two. Only `injuries`, `vegas` and `nfl-state` are `critical`, and
a background source going stale never changes the headline.

---

## Freshness policy

`src/core/health/policy.ts` is the only place a source's identity, severity,
cadence and consequence live. **No screen decides how old is too old** — a row
renders the state it is handed and the window it was measured against, and never
computes one.

Almost every window is imported from the module that already owns it:

| Source | Window | Owner |
|---|---|---|
| Injuries | `FRESHNESS_HOURS.fresh` (30h) | `core/injury/model.ts` — the same boundary `injuryLine` prints against |
| Vegas lines | the gap to the last weekend clock, floored at `VEGAS_STALE_HOURS` (36h) | `core/health/policy.ts`, over `server/services/setupService.ts` |
| Season market lines | `SEASON_TTL_MINUTES` (24h) | `server/services/seasonMarketService.ts`, used through its own `stale` verdict |
| NFL week | `STATE_STALE_AFTER_DAYS` (14d) | `core/season/context.ts` |

The Vegas row is the one window that is not a constant, and the reason is its
cadence. Nothing refreshes the market between Sunday 15:00 UTC and the
following Saturday 23:00 — that is deliberate, and it is what keeps the month
inside the free allowance — so a flat 36-hour window reported a perfectly
healthy market as stale for roughly four and a half days of every week, and
`vegas` being `critical` meant it took the headline with it. The window now
stretches to the gap the cadence itself creates and no further, which asks *did
the last scheduled refresh land* rather than *how old are these lines*. Setup's
36 hours stays as the floor, so this screen can only ever be more patient than
Setup and never less, and the two cannot be made to disagree about the same
snapshot.

Two thresholds are genuinely new, and both answer a question no existing rule
answers — *has the pipeline stopped running?* as opposed to *is the data old?*

- `DAILY_ATTEMPT_STALE_MINUTES` = 36h. One and a half daily ticks: the smallest
  window a single slow morning cannot trip, and short enough that a feed which
  stopped on Monday is visible on Tuesday.
- `FREQUENT_ATTEMPT_STALE_MINUTES` = 30 min. Six missed five-minute ticks: one
  Cloudflare hiccup cannot produce a warning, and a deleted cron trigger is
  visible within half an hour rather than at kickoff.

Both are boundary-tested — inclusive on the window, stale one minute past it.

`MAX_AGE_HOURS` from the published-projection service is deliberately *not* a
window here: twelve hours is when that feed is willing to re-ask, which is a
different question from when its numbers stop describing the week.

### Data age, or attempt age

A finished week's snap counts never change again, so ageing them against the
clock would report every October Tuesday as five days stale for ever; what
matters there is whether the pipeline still *asks*. A betting line is the exact
opposite. `usage`, `schedule`, `nflverse`, `players` and `manager-intel` are
measured by attempt; `injuries`, `vegas`, `season-markets`,
`published-projections`, `nfl-state`, `trending` and `newsletter` by data.

### Delivery, not the work attached to it

`newsletter` measures one thing: when an issue last arrived. Whether anybody has
scored it with ChatGPT yet is a different question with a different answer, it
is normal for days at a time, and it is not a fault in anything — so it changes
no state here and is carried as a technical note rather than a headline. Calling
a healthy feed with a job attached "degraded" is how a reader learns to ignore
the word on the day something has genuinely stopped arriving.

The mark that asks for that work is the attention dot on the Setup destination,
which is a different mechanism on a different screen, deliberately.

---

## The run ledger

`migrations/0033_cron_runs.sql` — `cron_run_state`, **one row per cron
expression, overwritten in place.** Three rows, for ever. Not an append-only
ledger: a current view, a last attempt, a last success and the most recent run
is what is wanted, and an append-only table would be a monitoring history nobody
asked for.

**The five-minute injury tick is deliberately not written here.** Its liveness
is already recorded, every tick, by `injury_source_state.checked_at` — the
column that exists for precisely this question. Writing it again would add 288
writes a day to say what one already says, and would create the first place in
this app where two rows could disagree about whether the injury check ran.

`scheduled()` was not rearranged to get a run record. Every feed on the daily
tick was already wrapped in its own `try`/`catch` — the invariant being that one
dead provider must never take down the ten under it — and `CronRunRecorder.step`
*is* that try/catch with the outcome kept instead of discarded. Order, priority
and the separate-catch rule are exactly as they were.

Nothing that comes off a wire is stored. A step contributes an id, a label, an
outcome word from a closed vocabulary, an optional count and a note that has
been through `boundedNote` (160 characters, whitespace-collapsed). A thrown
error becomes a bounded **category** — `the source refused the request`, `the
source did not answer in time` — and the exception itself goes to the log, where
an operator can read it and a user cannot.

### Budget and yield

The only budget numbers this app can report honestly are the daily tick's, and
they come from `RequestBudget.snapshot()` — which counts at the transport, so
retries and redirect hops are included and `used/limit` is what actually went
out on the wire. The two weekend clocks pass the unmetered transport and report
`null` rather than three zeroes, because `0/0` would read as "spent nothing"
rather than "this clock has no ceiling".

Deferral is a first-class outcome, never a generic failure:

> Manager tendencies — Deferred · background
> *Refresh budget reserved for higher-priority data (48/48 already spent).*

An allowance-bound batch is deferred too: it advanced as far as its slice of the
pool allowed and stopped with checkpoints intact, which is the steady state of a
backfill's first few days. Calling that a success would hide from somebody
reading a thin `Next%` that there is more history still to come.

This lane **observes** the refresh priority; it does not redesign it.

---

## The API

`GET /api/data-health`. A read, public like every other read, with a stable
typed contract (`DataHealthView`).

It triggers no provider fetch, no cron and no mutation. That is structural
rather than promised: `DataHealthService` has no write method, no `refresh`, no
`fetch`, and `tests/dataHealth.isolation.test.ts` asserts it by snapshotting
every row of every table before and after, by watching every statement the
endpoint prepares, and by handing it transports that throw.

It carries timestamps, canonical outcome words, bounded notes written for a
person, and the same revision `/api/health` reports. No secrets, no provider
payloads, no raw exceptions, no identifiers.

**`/api/health` is untouched.** That endpoint answers three things and the third
is what the release gate compares against the SHA it deployed; growing it is how
that check starts failing for reasons unrelated to the deploy.

---

## The screen

Setup → *This app*, directly above Copy support snapshot. Never in the taskbar.

```
Data health          Healthy · refreshed 18 min ago   ›
```

or

```
Data health          2 inputs need attention          ›
```

Behind it, four sections in the order somebody diagnosing reads them:

1. the overall state and when anything was last refreshed;
2. **Needs attention**, drawn only when there is something in it;
3. every other input, one compact row each —
   `Injuries — Waiting on source`, `Usage — Current · 2h ago`,
   `Vegas lines — Current · 18 min ago`,
   `Manager tendencies — Deferred · background`;
4. what the last scheduled refresh did, in one sentence.

A row carries a sentence underneath only when its state is not `current` — and
that sentence says what being stale *costs a recommendation*, not merely that
something is old.

**Technical details** is one tap and folded by default: exact instants, the
pipelines' own outcome codes, the measured subrequest counters, consecutive
failure counts and the running revision.

Colour is never the state. Every row carries its state as a word as well as a
drawn mark, `waiting` and `deferred` take the neutral mark rather than the
warning one, controls are ≥44px, nothing scrolls sideways at 430/390/375/360 in
either theme.

---

## Support Snapshot integration

Every capture carries a `dataHealth` block on the **envelope**, outside
`decision`. Outside on purpose: health is a fact about the deployment measured
by a different subsystem, and a snapshot captured on a Tuesday and replayed in
March would fail every freshness term in it for no reason anybody cares about.
Replay is unchanged, and a file written before this existed still reads.

It is a projection of the view, not the view: twelve rows of `{id, label, state,
severity, ageMinutes}` plus one run line naming what deferred and what failed.
About a kilobyte, under 5% of a snapshot, with a hard test ceiling of 2KB — the
cadence prose, the impact sentences and the technical block stay on the screen
where they belong.

It is enough for an agent to distinguish, without asking anybody:

- an exact replay standing on **stale injury data** — `injuries: stale`, with its age;
- a legitimate **`not_published`** — `injuries: waiting`;
- **missing or fallback** data — `vegas: missing`;
- **deferred** background work that has nothing to do with the complaint —
  `manager-intel: deferred, severity: background`, named again on the run.

---

## Demo Mode

`/api/data-health` is served from the scenario's own declared freshness, with no
network and no D1, and reports `gitSha: demo` so a rehearsal cannot be mistaken
for production.

There is **no alternate fake health engine**: `core/demo/runtime/health.ts`
builds its rows with `sourceHealth`, reads its labels, severities and cadences
from `SOURCE_POLICIES`, and computes the overall word, the attention count and
the Setup sentence with `overallState`, `needsAttention` and `headline` — the
production functions, in the production order. The only thing a scenario
supplies is the *state*, which is what a scenario is.

Every selectable scenario answers. Healthy, legitimately waiting (a draft
scenario has played no week, so weekly usage and published projections have
nothing to publish), stale/degraded (the degraded bundle) and deferred (a league
whose transaction history has not been backfilled) are all reachable, and a
degraded scenario cannot report itself healthy.

---

## The database allowance

One extra group at the bottom of the screen, and the only thing on it that is
about the platform rather than about a feed: **how much of today's D1 row
allowance is gone, and whether today is on pace to run out of it.**

D1's free plan allows 5,000,000 rows read a day and answers everything with an
error once that is spent, until midnight UTC. That has happened three times.
Each time the first anybody knew of it was the app failing, and each diagnosis
began with a question nothing in the app could answer.

### What is actually obtainable

A Worker **cannot** read its own quota. There is no binding, nothing on the D1
REST resource but size and table counts, and no header on a query result that
adds up to a daily total. What exists is the **GraphQL Analytics API** — the
same source the dashboard's own D1 charts are drawn from — and a Worker can
call it like any other HTTPS endpoint.

So the app can show this itself, with one condition that cannot be engineered
away: it needs an API token, and a token is a secret somebody has to make.

Two settings, both optional:

| Name | Where | What |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler.toml` `[vars]` | The account tag. An identifier, not a credential. `wrangler whoami` prints it. |
| `CLOUDFLARE_ANALYTICS_TOKEN` | `wrangler secret put` | An API token with **Account Analytics: Read** and nothing else. |

Deliberately **not** the deploy token. This one lives inside a Worker that
answers HTTP, so it is scoped to the single metrics dataset it needs: if it
leaked it could not read a row of anybody's data, change a setting, or deploy
anything.

Without both, the panel says **Not connected** and what to do about it. It does
not estimate, and it does not count its own reads and present the total as the
account's — the allowance is charged to the account and includes the crons, the
Actions workflows and anything else touching the database, so a self-count
would be an undercount wearing the authority of a measurement.

### What it says

    Daily rows read                                    38% of today's rows
    1,900,000 of 5,000,000 rows read across 24,100 queries.
    On pace for 79% by midnight UTC. Yesterday finished on 49.2%.

Rows *and* queries, because the pair is what tells the two failure shapes
apart: a hundred thousand rows across four calls is one bad query, and a
hundred thousand across forty thousand calls is a loop nobody meant to write.
Every incident here has turned on that distinction.

The pace is the early-warning half. A day at 52% by noon is not alarming and is
on pace for 104%, which is; the panel says so while there are still twelve
hours to do something about it. It refuses to project from the first two hours
of a UTC day, because one cron tick at 00:04 extrapolates to several times the
allowance and an alarm that fires every morning is an alarm nobody reads by
October.

### Four things it refuses to do

1. **A missing token is not zero rows.** No credential means "not connected",
   in words.
2. **A renamed field is not zero rows.** `d1-insights.yml` printed a column of
   zeroes on its first run because it guessed at `rowsRead`/`sumRowsRead`/
   `rows_read` and the payload used none of them. Here the metric is *found*,
   and a response without a recognisable rows-read field reports that — naming
   the fields it did get — rather than displaying `0%`.
3. **An empty answer is not a quiet day.** Cloudflare's analytics lag by a few
   minutes, so "nothing recorded for today yet" and "no reads today" are
   different facts and only one of them is knowable.
4. **It is not folded into the headline count.** `needsAttention` counts
   *inputs a recommendation is built from*, and the row allowance is not one of
   those — it is the thing that stops all of them at once. Putting it in that
   number would make "2 inputs need attention" mean two different kinds of
   thing.

### Why it is its own endpoint

`GET /api/diagnostics/d1-quota`, not a field on `/api/data-health`. §18 says
reading data health must not leave the process, and `dataHealth.isolation.test.ts`
proves it by making every transport that endpoint can reach throw. This reading
is a subrequest to Cloudflare by construction, so it belongs beside data health
rather than inside it — and a screen that shows both fetches both. It also
means this panel failing is quiet: an unreachable Cloudflare leaves every other
row exactly as it was.

One subrequest per five minutes, and **zero database rows**. It is the only
panel on this screen that costs nothing against the allowance it reports on.

For *which query* spent the allowance rather than how much of it is gone, the
answer is still `.github/workflows/d1-insights.yml` — `wrangler d1 insights`
attributes rows to the query that read them, and no API a Worker can reach
does.

---

## What checks production, and what it costs

On 8 September the daily row allowance was spent by the thing that checks the
app rather than by the app. Cloudflare's own analytics, bucketed at fifteen
minutes, attribute the day like this:

| What | Rows |
| --- | --- |
| Production browser suite — two hand-dispatched, one scheduled | ~5.06M |
| Deploy gates | ~0.11M |
| The Worker's own crons (09:00 sync + 288 five-minute ticks) | ~24,000 |
| Real user traffic | indistinguishable from zero |
| **Day total** | **5,330,262 (106.6%)** |

The app answered errors from 12:30 UTC until midnight. Nothing was wrong with
the app.

Three changes, and none of them is "run it less and hope".

**One width on the schedule.** The daily sweep runs 390 only, a third of the
executions and a third of the rows. What it gives up is layout at 375 and 360
*against production data* — and `ci.yml` already runs four widths, sharded the
same way, against a seeded local build on every pull request. Width is a
question about layout, and layout does not need real rows to be wrong. What
only production can answer — the live revision, a cold boot, the API's JSON
boundary, a real roster read, a stranger's write refused — is width-independent
and still runs daily.

**A day gets one full pass.** A dispatched run is a full pass by default,
against the same live site, on the same day; the scheduled sweep a few hours
later learns nothing and costs a third of the allowance. On a day that already
had one, the sweep stands down and says so in its summary. Deploy gates do not
count — eight specs at one width is not this check.

**Every full pass asks first.** `scripts/d1-budget-guard.mjs` reads today's
usage before the suite starts and declines when the day is already past a
ceiling (50% by default, raisable per run). Being over the ceiling is an
ordinary green outcome reported in the summary. *Not being able to tell* is a
loud failure, because a full sweep is never urgent and a guard that quietly
disabled the sweep for a month would be worse than no guard.

The deploy gate is never gated on budget. It is eight checks at one width and
the last thing standing between a bad release and production.

---

## What this is not

No recalibration of any fantasy model. No change to waiver, DST or trade logic.
No navigation redesign. No rewrite of cron scheduling. No paid monitoring, no
telemetry, no alerts, no push, no admin dashboard. No `Refresh Everything`
button — the existing manual refresh is untouched, and observation is the
mission.
