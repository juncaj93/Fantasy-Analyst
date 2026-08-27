# Fantasy Analyst — full project handoff

**For: ChatGPT, acting as program and project manager.**
**Written: 2026-08-27, from the repository at `main` = `51d068c`.**

You are picking this project up cold, in a fresh chat, with no memory of the
previous one. This document is written to be the only thing you need in order to
manage the work: what the product is, why it is built the way it is, what is
finished, what is not, what the constraints are, what the plan is, and how the
owner wants to be worked with.

Nothing here is aspirational. Where a number is a measurement it says so; where
it is an estimate it says that instead. The project's own strongest rule is
*unknown stays unknown*, and this document keeps it.

---

## 0. How to use this document

Read sections 1–4 to be able to hold a conversation about the project. Read 5–9
to be able to make decisions about it. Sections 10–14 are what you will actually
manage day to day.

**If you read only one section, read 13.** It carries the agreed lane plan, the
capacity window, the parallelisation rules, and the one design that is about to
be lost if nobody writes it down.

If you have the accompanying zip, the deep references are in `docs/`. Section 17
maps every one of them so you can pull the right file rather than all of them.

Three things to internalise before anything else:

1. **This app advises and never acts.** There is no code path in it that makes a
   pick, sets a lineup, submits a bid, claims a player or sends a trade. That is
   a product decision, enforced in code and asserted by tests, and it is not up
   for optimisation.
2. **No paid services, ever.** No credit card, no overage risk, no paid AI at
   runtime. Every data source is free-tier or public, and the free-tier ceilings
   are the hardest constraint in the project — harder than time.
3. **You are inside the product, not just managing it.** Two of the app's
   workflows hand work to ChatGPT by design. Section 10 is your job description.

---

## 1. The 60-second version

**Fantasy Analyst** is a private, mobile-first fantasy football decision tool for
one user (the repository owner). It is a Cloudflare Worker serving a React SPA,
designed for iPhone Safari, deployed at:

> **https://fantasy-analyst.juncaj93.workers.dev**

Reads are public. Every write requires a passphrase.

It combines live Sleeper league/draft state, an imported ADP snapshot,
newsletter intelligence, free public NFL data (nflverse) and cached Vegas player
props into **explainable** recommendations for the decisions a fantasy manager
actually makes: who to draft, who to start, who to claim and for how much, who
to trade with, which defence to stream, and whether this week's matchup is
already decided.

Every recommendation is a sum of separate, inspectable components. There is no
opaque score anywhere, and no model output that cannot be broken back down into
its parts on the phone that showed it.

**State: deployed, green, and nearly feature-complete for the 2026 season.**
Roughly twenty milestones are done. There is no half-finished work.

Two things remain, on different clocks:

- **One substantial feature is still to build** — Mock Draft + Draft Tools
  (Lane 2, section 13a). It is designed but not written down anywhere durable,
  and it is the last thing the owner wants added before feature work stops.
- **Everything else that remains is validation only a live NFL Sunday can
  provide.** Five complete systems have never once run against reality.

**Two dates govern the plan**: the owner's elevated Claude limits expire
**2026-08-28**, which is the build window; and his real draft date, which is the
deadline for Lane 2 and **is not recorded anywhere — ask him.**

---

## 2. The product

### The problem it solves

The owner plays fantasy football and wants better decisions than his gut, but
does not want a black box, does not want to pay for anything, and does not want
an app that acts on his behalf. Commercial tools give one number and no argument.
This gives the argument.

### The design philosophy, stated as rules

These are enforced in code and in tests, not in anybody's head. They are the
single most useful thing to understand about this project, because almost every
design decision in it is downstream of one of them.

| Rule | What it means in practice |
|---|---|
| **Sleeper is the source of truth** | League, roster, draft state, matchup, scoring and settings come from Sleeper and are never assumed. Sleeper's *own projections* are deliberately never read — a projected number on any screen is this app's, or it is absent. |
| **Unknown stays unknown** | No value is ever invented to fill a gap. A waiver budget the league does not publish is shown as unpublished. A player who cannot be scored is listed as undecidable, never silently benched. |
| **Deterministic and explainable** | Every recommendation shows its components, their weights and their contributions. No paid AI runs at runtime. |
| **The evidence ledger is truth** | Every news item is kept forever; player tallies are *derived* from the ledger and are rebuildable. Nothing is ever deleted — an item is marked ignored, with a note, reversibly. |
| **Identity is resolved, never guessed** | A player name that does not resolve to exactly one player goes to a review queue for a human. |
| **User corrections are authoritative** | A human ruling survives reprocessing, re-imports and rule changes. |
| **The app never acts** | No pick, lineup, waiver, bid or trade can be made by this app. Every transaction happens in Sleeper, by hand, on purpose. |
| **Market attention is attention, not quality** | What the rest of Sleeper is adding prices a bid and raises a question. It never moves a projection. |
| **A tendency needs a sample** | Manager and room profiles state how many trades or drafts they rest on, and say nothing at all below the threshold. |

### What makes it unusual

Most of the engineering effort in this repository has gone into *honesty
mechanics* rather than into modelling. Examples worth knowing because they come
up constantly:

- **Double-counting is the enemy.** Several modules compute genuinely useful
  signals and then score nothing, on purpose, because the same underlying fact is
  already counted elsewhere. `core/xfp/` is the clearest case: it reports the gap
  between opportunity and production, and a test asserts the lineup score is
  byte-identical with and without it.
- **A capture is a recording proxy, not a hand-written list.** Support snapshots
  record the interface a decision engine reads through, so completeness is
  structural — a source the engine calls is a source the snapshot has, and a new
  field fails to compile until both know about it.
- **Deliberate mutation testing.** Several milestones were closed by writing a
  deliberate bug, confirming a *named* test catches it, and reverting. Where a
  mutation survived, that is recorded too, along with the test added for it.

---

## 3. The owner, and how he works

Understanding this shapes how you should manage.

- He works **asynchronously**. He is not watching. He wants autonomous work to
  land on `main`, verified, deployed, and reported **once**.
- He does not want routine interruptions. Slow CI, a restarted container, a
  killed watcher: handle them, do not ask.
- **Interrupt only for a real blocker**: unavailable credentials, anything that
  would cost money, a destructive or irreversible risk to data, an ambiguous
  production recovery, a genuine product or architecture decision, or something
  that can only be done on real hardware.
- When he *is* needed, the ask should be **one action at a time, dummy-proofed,
  then stop**. Not a checklist of six things.
- He is not a developer by trade. The Setup screen is written in plain language
  on purpose, and a test asserts the setup copy contains no developer vocabulary.
  Talk to him the same way.

**Standing rules that outrank convenience**, verbatim in spirit from him:

- never commit or expose credentials, tokens, or account-recovery information
- no paid services, no credit card, no overage risk
- Sleeper is the source of truth
- the evidence ledger is truth; tallies are derived and rebuildable
- unknown stays unknown — never invent a value
- never draft, never write a lineup to Sleeper
- deterministic and explainable
- user corrections are authoritative
- one action at a time when he is genuinely needed, dummy-proofed, then stop

The working agreements for autonomous engineering sessions are in
`docs/brief/08_WORKING_AGREEMENTS.md` and are summarised in section 9.

---

## 4. Where it stands today

**Date: 2026-08-27. `main` is `51d068c`, deployed, green, in sync.** Nothing is
half-finished; there is no queued spec.

### The seasonal clock — this is the important part

It is late August 2026. The NFL regular season has not started. That single fact
determines the entire current plan, because it splits the project cleanly:

| | State |
|---|---|
| **Everything buildable without a live season** | Built, tested, deployed. |
| **Everything that needs a real NFL Sunday underneath it** | Built, tested, deployed, and **never once executed against reality.** |

The second category is not a to-do list of code. It is a *watching* list. Five
systems are complete, correct as far as any preseason test can show, and will
first meet real data within the next few weeks:

1. **The Vegas provider** is written, tested against captured live payloads, and
   **deliberately switched off** (`VEGAS_PROVIDER = "mock"`). Turning it on is a
   two-step change plus a watched weekend. See section 7.
2. **The per-game usage feed** correctly reports `not_published`, because
   `stats_player_week_2026.csv` is a 404 until games are played.
3. **The FAAB / waiver layer** has never seen what Sleeper's `transactions/{week}`
   actually returns for a live waiver run.
4. **The defence (DST) streaming planner** cannot be judged until real kickoffs
   are stored and teams have priced games behind them.
5. **Matchup calibration** withholds an observed rate below twenty settled weeks,
   and there are zero. That is a season of Sundays away, which is exactly why the
   ledger writing had to start now.

**So the honest state of the project is: almost everything is built and none of
it has been proven.** Managing this well means making sure each of those five is
*watched* the first time it fires — and, separately, spending the remaining
build capacity on Lane 2 rather than on new capability nobody asked for. Those
two are not in tension; see section 13.

### Recent shipped work (last ~10 merges, newest first)

| PR | What |
|---|---|
| #196 | A newsletter creates work waiting for you, not fantasy opinions — **this is Lane 1, complete** |
| #195 | Data Health: say whether what the app knew was *healthy*, not just what it knew |
| #194 | Call the support row the same thing in all three places |
| #193 | Capture the five in-season decisions, and replay them exactly |
| #192 | Capture the state behind a Draft recommendation, and replay it exactly |
| #191 | Spend what Review left on the destinations, not the air around them |
| #190 | Say so when CI never reached a verdict, instead of skipping in silence |
| #188 | Keep the smoke revision check inside POSIX |
| #187 | Move Review out of the toolbar and into Settings |
| #186 | Gate the deploy on CI, name the revision, make a rollback a form |

Two themes dominate that list, and both are worth understanding as *strategy*:
**making a wrong answer reproducible** (#192, #193, #194), and **making the
system say what it does not know** (#195, #196, #190).

---

## 5. The screens

The app is a bottom-tab SPA built for iPhone portrait. One toolbar slot is
seasonal: **exactly one of Draft and Waivers** is ever in it, switched by
Sleeper's own season state.

| Screen | What it answers | What it will never do |
|---|---|---|
| **Draft Room** | Who should I take? Best-player-available ranking from live Sleeper draft state: market value leads, news tally and ♥ My Guy ratings matter, roster need is a light tiebreaker. Each card carries ADP, ADP value, the colour-coded chance he lasts to your next pick, the news signal and the season market. | It never drafts. |
| **Draft board** (`▦`) | What is the room doing? Rounds down, managers across, the snake running the way it really runs, header row and round column frozen. Compact = every pick as its position in the position's colour, which makes a receiver run visible in one glance. | It fetches nothing and computes nothing — it draws picks the Draft screen already has. |
| **Team** | Is there anything I should do? Then the recommended lineup: Vegas market expectation, news signal, availability and an uncertainty penalty. Balanced / Floor / Ceiling ask the same question three ways. Pull to refresh. | It never changes a lineup. |
| **Matchup** | This week's head-to-head. Sleeper is the score; everything else is this app's. Each starter's projection becomes a distribution shaped by position and role; four thousand simulated afternoons over what is *left* give a projected final and a live win probability. Points already scored are truth and are never re-simulated. Above the starters: `Best move: …`, including `Hold your lineup`, because holding is a decision. | It sets no lineup — it prices what a change is worth in win probability. |
| **Waivers** (in season, where Draft was) | Opens on the plan: an ordered list of claims with drops, including deliberate repeats with `Only if 1 loses` qualifiers, because Sleeper runs claims in entry order and a claim whose drop is gone does not run. Then the board: who is available, how strongly recommended, which slot, what he is worth. Three separate money numbers — expected market price, worth to *your* roster, and the do-not-exceed ceiling. | It never bids, claims, adds or drops. |
| **Players** | Searchable intelligence: tallies by window (7d/30d/season/life), category breakdown, cached prop lines, full evidence timeline with every original excerpt preserved. Each card opens with a *selected* newsletter takeaway — chosen from the ledger, never composed, and it moves no number. | — |
| **Trades / Smart Trades** | Bilateral offers scored separately for what you gain, what the partner gains, and whether that manager plausibly says yes. | It sends nothing. |
| **Setup** | The whole configuration experience in plain language: connect Sleeper, choose a league, import ADP, the dedicated newsletter address, which sender to trust, appearance. Also hosts Review, Demo Mode, Support Snapshot and Data Health. | — |

### Four things inside Setup that are really features

- **Review** — anything the classifier was unsure about, plus ambiguous player
  identities and already-applied items. Accept, change, reassign, ignore. It is
  maintenance rather than a weekly decision, so it lives in Settings with a dot
  when something waits (`3 items need attention`).
- **Demo Mode** — a read-only walk through ~25 states that are hard to reach on
  demand: draft night at four picks, a best-ball board, a Sunday twenty minutes
  before kickoff, an injury eight minutes before it, one live afternoon read from
  five points in it, a Tuesday waiver run with a finite wallet, a playoff week, a
  March rollover, and seven degraded states. These are the *real* screens and the
  *real* engines over versioned fixtures — the app cannot tell the difference.
  Nothing in a demo can change anything, refused twice (browser and server).
- **Support Snapshot** — see section 10.
- **Data Health** — whether what the app knew was healthy and current. Which
  inputs are current, stale, waiting on an unpublished source, or missing; which
  background work yielded its refresh budget; what the last scheduled run did.
  Reading it runs no cron and writes nothing.

---

## 6. The engines, and what is allowed to move a number

This is the part where a PM most easily causes damage by approving a "small
improvement" that quietly double-counts something. The layering:

```
core/          pure domain logic — no I/O, no framework, fully unit tested
  identity/    canonical player model + strict matching ladder
  sleeper/     API client, transforms, scoring/roster interpretation
  adp/         ADP snapshot import
  newsletter/  sanitize → segment → detect → evidence
  evidence/    ledger types + derived signal aggregation
  vegas/       provider interface, adapters, normalization, cache + budget policy
  draft/       draft recommendation components, tiers, survival, next-pick model
  startsit/    start/sit components + Vegas → fantasy-points conversion
  faab/        waiver budget truth, bid research, bid strategy
  waivers/     board, claim planner, drop cost, pricing, league pressure
  market/      Sleeper trending as attention; trend-vs-model disagreement
  roster/      bench-slot opportunity cost
  trades/      verdicts, offer ladder, consolidation, manager fit
  managers/    bounded trade and draft tendencies from league history
  xfp/         expected points from opportunity, and the gap to what happened
  schedule/    role-specific schedule strength, weeks ahead
  value/       this-week and next-four-week player value
  grading/     recommendation ledger, counterfactual grading, weekly self-grade
  dst/         defence scoring, streaming, playoff planning
  support/     capture a decision's inputs and output, redact it, replay it
  contracts/   the versioned surface all of the above is consumed through
server/        D1-shaped persistence, services, HTTP router, auth
worker/        Cloudflare Worker entry (fetch + scheduled + email)
web/           React SPA (iPhone Safari first)
```

**Layering rule: `core/` never imports from `server/`, `worker/` or `web/`.**
Everything in `core/` is a pure function or a class with injected dependencies.
That is why every engine is testable without a database, a network or a browser —
and it is what makes Demo Mode and support-snapshot replay possible at all: they
are the same engines with a different source object handed in.

### Things that deliberately score nothing

Memorise these. Each exists because the underlying fact is *already* counted:

- **`core/xfp/`** — opportunity is already in the lineup score once as
  `usage_level`, and the market's number is in it again as `vegas`. A third count
  off the same carries is the exact failure it was arranged to avoid.
- **The newsletter takeaway sentence** — the evidence it quotes has already been
  counted by the tally it is explaining. The load-bearing test asserts the
  headline appears while the aggregated signal is byte-identical.
- **Sleeper trending** — prices a bid and adjusts confidence by at most ±0.1. A
  property test walks the input space asserting no field a projection could
  consume ever appears.
- **The ★ draft queue** — a bookmark. It fills the queue and the ★ filter and
  changes no ranking. (It used to be fused with ♥ My Guy, which *does* move the
  board by about two, five or ten picks of ADP. Splitting them was migration
  `0009`.)
- **The room prior** — the draft profile is bounded evidence offered to the
  next-pick model, and a test asserts it exposes no multiplier a caller could
  apply behind that module's back.

### One known open defect in this area

A queue-filtered draft board (`?queued=1`) narrows the *candidate pool*, and the
tier-cliff and positional-scarcity components are computed over that pool — so
three starred players across three positions have no tier structure to read and
their scores move. The ★ itself moves nothing; the filter does. Assigned to the
Integrity workstream, not yet fixed. The `Next%` simulation is already immune
because it was deliberately given the whole board.

---

## 7. Data sources, and the constraints that shape everything

| Source | Cost | Status | Notes |
|---|---|---|---|
| **Sleeper API** | Free, no key | Live, load-bearing | League, rosters, draft, matchup, scoring, transactions, trending, player dictionary. Also `sleeper.app/graphql` `get_player_outlook` for the season outlook (attributed to Rotowire). |
| **ADP** | Free, imported | Live | From beatadp.com via a GitHub Actions workflow (blocked from the dev sandbox). An imported file wins if one exists. |
| **nflverse** | Free public GitHub release assets, no key, no quota | Live | Injury reports, weekly player stats (per-game usage), plus three more files added later. Nothing to be withdrawn. |
| **The FF newsletter** | Free (subscription) | Live | Delivered to `fantasy-news@juncaj.net` → Cloudflare Email Routing → the Worker's `email()` handler. See section 10. |
| **SportsGameOdds (Vegas)** | Free plan, 2,500 entities/month | **Written, tested, NOT enabled** | See below. |
| **Cloudflare Workers + D1** | Free tier | Live | The whole runtime. |

### Facts that are measured, and must not be re-litigated from a docs page

The repository is emphatic about these because each one cost real time to
establish and each one *looks* wrong to a newcomer:

- **Sleeper publishes no ADP.** Confirmed by full GraphQL introspection —
  `get_adp`, `adp`, `adp_data` all rejected. Do not go looking again. The same
  introspection *does* list `get_player_outlook`, so "no ADP" was never "no
  player data".
- **`search_rank` is not ADP.** It measures who gets *looked up*. Using it as a
  draft order shipped once and was wrong: it put a quarterback around 7, floated
  retired players into the top 300. Its top dozen looked exactly like consensus,
  which is why it was believed — checking the happy path and generalising is the
  whole mistake, and the tail is where a ranking is falsified.
- **Sleeper publishes no roster percentage.** Checked twice. The card shows none
  and Setup says so in words.
- **SportsGameOdds bills one "entity" = one *event returned***, not one odds
  object. A request for a single game costs exactly 1 whether the payload carries
  6 lines or 194. An earlier note claiming a Sunday slate was "~3,200 objects
  against 2,500 a month" was counting the wrong thing. **A sixteen-game Sunday is
  sixteen entities.**
- **SportsGameOdds publishes no season-long NFL player markets.** Proved three
  ways. The pipeline is built end to end and lights up the day one appears; today
  it stores nothing and the cards say nothing.
- **D1 caps a statement at 100 bound parameters.** `MAX_BOUND_PARAMS = 90` is
  shared, and every `IN (?, ?, …)` batches against it. This caused a live crash
  once (`D1_ERROR: too many SQL variables`) when the candidate pool grew from a
  handful of rows to ~2,500.

### The Vegas activation decision — the one live product decision waiting

`VEGAS_PROVIDER = "mock"` deliberately. Every gate the activation checklist asks
for exists and is tested: measured accounting, targeted requests, a simulated
month at **200 entities of 2,500 (8%)**, a hard stop, stale fallback, dedupe,
and no slate fetch anywhere. `tests/vegas.budget.test.ts` fails if the 8% stops
being true.

What has **not** happened is a real NFL Sunday. The strategy rests on mapping
Sleeper's team abbreviations (`KC`) onto the vendor's ids
(`KANSAS_CITY_CHIEFS_NFL`), on kickoff times, and on staleness arithmetic
against a live slate. Preseason cannot exercise any of it.

**To turn it on** (three steps, in order, on a weekend somebody can watch):

1. `npx wrangler secret put SPORTSGAMEODDS_API_KEY` — the repo secret exists and
   authenticates; the Worker does not have it yet.
2. `VEGAS_PROVIDER = "sportsgameodds"` in `wrangler.toml`, redeploy.
3. Watch `/api/vegas/budget` after the first Saturday run. If `nextPlan.events`
   is larger than the roster spans, the team mapping has failed and it is
   fetching too much — which is exactly what `probe-live-smoke.mjs` checks for.

Blast radius is bounded at 85% of a free plan. Bounded is not zero. **This is a
decision to schedule, not to make silently.**

### The sandbox's network limits (affects how work gets done)

The development container cannot reach `sportsgameodds.com`, `beatadp.com`,
`sleepercdn.com`, or the production URL. Anything needing the open internet runs
through `.github/workflows/probe.yml`, which executes one `scripts/probe-*.mjs`
on a GitHub runner with the key in env. There are ~50 such probes.
`api.sleeper.app` and `sleeper.app/graphql` *are* reachable locally.

**Probe logs are public.** Any probe printing a provider payload must redact the
email, customer id and key hash, as `probe-sgo-quota-scale.mjs` does.

---

## 8. Stack and repository shape

- **Frontend**: React 18 + TypeScript + Vite, iPhone Safari first.
- **Backend**: Cloudflare Workers + D1 + Wrangler.
- **Tests**: Vitest (unit/integration against real SQLite) + Playwright (WebKit
  at 430×932, 390×844, 375×812, 360×800 — the Pro Max, standard, mini and small
  classes).
- **Runtime dependencies: `react` and `react-dom`. Nothing else.** That is
  deliberate and is worth defending.
- **Migrations**: 34 forward-only D1 SQL files, `0001` → `0034`.
- **Tests on disk today**: 250 unit/integration files in `tests/`, 44 browser
  spec files in `e2e/`. (Documented milestone counts run 882 → 1,692 → 1,854 →
  higher; the exact current total was not re-measured for this document because
  dependencies are not installed in the session that wrote it.)

**Runtime portability** is a real property, not an accident: the API is built as
`createApp(): (Request, AppEnv) => Promise<Response>` over a `Database`
interface structurally compatible with D1. Production passes `env.DB`; local dev
and e2e use `node:sqlite`; tests apply every migration in order so repository
tests exercise real SQL and a malformed migration fails the suite. **You can run
and browser-test the whole app without Wrangler or workerd.**

### Performance budgets — a real gate, not a guideline

`perf-budgets.json` is enforced in CI on every push. Ceilings:

| Budget | Ceiling | Roughly today |
|---|---|---|
| app JavaScript (gzipped) | 140 kB | ~98 kB |
| app CSS (gzipped) | 20 kB | ~7.7 kB |
| Demo Mode lazy chunks (gzipped) | 150.0 kB | 149.0 kB |

The demo chunk has about **one kilobyte of headroom**, which is why recent
changelogs report byte deltas to the tenth of a kilobyte. The stated mechanism:
*"Raising one is a deliberate act with a reason attached, in the same commit as
whatever needed the room."* Treat a budget raise as a decision that needs a
justification, not a chore.

---

## 9. How work gets built, shipped and undone

### The pipeline

```
push to main → CI (typecheck, unit, perf budget, 4 widths × 3 shards of WebKit e2e)
             → CI green on the exact SHA
             → deploy.yml → release.yml → D1 migrate → Cloudflare deploy
             → verify the live site → production reports the SHA at /api/health
```

**Deployment starts from CI passing on `main`, not from the push**, and what it
deploys is the exact SHA CI validated. `rollback.yml` puts a named known-good
revision back. **Migrations are forward-only and a code rollback does not undo
them** — which is a real constraint on how a migration should be written.

`docs/RELEASE.md` is short and is the first thing to read before touching
anything under `.github/workflows/`.

### Scheduled work (crons in `wrangler.toml`)

| Cadence | What |
|---|---|
| every 5 minutes | injury check — almost always a conditional 304, no body, no write. Flat cadence rather than fixed windows because kickoff is 9:30am for London games, Thursday night, Friday on holidays and Saturday in December, and a player is ruled out ninety minutes before any of them. |
| daily 09:00 UTC | Sleeper player dictionary, then season stats, then the nflverse per-game usage ingest. ~5am Eastern: after the late window and Monday night, after nflverse's own pipeline has run. |
| Sat 23:00 & Sun 15:00 UTC | Vegas refresh (currently against the mock provider) |

The usage feed is deliberately *not* on the five-minute tick: a game's target
count is settled the moment the game ends and never changes, so 288 checks a day
would learn what one learns and spend 288 bookkeeping writes proving it.

### Manual workflows (all `workflow_dispatch`)

`probe` · `investigate` · `smoke` · `rollback` · `refresh-adp` ·
`refresh-underdog-adp` · `refresh-signals` · `refresh-vegas` · `resync-league` ·
`import-tally` · `inspect-tally` · `backfill-tallies` · `audit-newsletter` ·
`accept-any-sender` · `setup-newsletter-email` · `verify-dog`

### Local verification

```bash
npm run typecheck          # tsc
npx vitest run             # unit + integration
CI=1 npm run e2e:chromium  # all four widths, fallback engine
npm run perf:budget        # gzipped page weight against perf-budgets.json
npm run build
npx wrangler deploy --dry-run
```

WebKit is not installed in the dev container, so `npm run e2e` fails locally —
use `e2e:chromium`. CI runs WebKit and has never disagreed, **with one known
exception**: `e2e/shell.spec.ts:179` fails at Chromium 360 only, on `main`, with
no change in front of it. The cause is measured, not guessed: the roster-progress
chip strip wraps to a second row because Chromium measures the chips a shade
wider than WebKit does. iPhone Safari is what ships and WebKit is the authority,
so the bound stays tuned to WebKit. **Do not loosen it to make the fallback
green.** Expect exactly this one failure from `e2e:chromium` at 360.

### Engineering working agreements

From `docs/brief/08_WORKING_AGREEMENTS.md` — these matter to you as a PM because
they are what an autonomous session will do without asking:

- **Do not hold a shell open just to watch CI.** Start the remote job, release
  the shell, query periodically. The WebKit suite takes twelve to fifteen minutes.
- **Never cancel remote work to unstick a local session.**
- **Exact-head discipline.** If head `A` is green and a further change makes head
  `B`, then `A` is no longer the merge proof. Green CI against a head that no
  longer exists proves nothing.
- **Green-but-skipped is not green.** A required job that did not execute has not
  passed. (PR #190 exists because this happened.)
- **After a container restart, audit before acting.** Git, PR state, CI state and
  deployed state are authoritative; memory of the previous shell is not.
- **Report at meaningful checkpoints, not on a timer.**

One trap worth repeating because it caused a real mistake: **the sandbox clock
does not track the session's progress.** A previous session merged a PR believing
a 20-minute timeout had "long since" passed when only five minutes had elapsed.
Wait against `date -u`, never against a feeling.

---

## 10. Your job inside the product

Two of the app's workflows hand work to ChatGPT *by design*. This is not a
metaphor — the buttons say "Copy for ChatGPT".

### 10a. The newsletter tally loop (weekly, in season)

This shipped today (#196) and it replaced something worse. Previously a
sentence-level classifier read each newsletter on arrival and wrote guesses
straight into the evidence ledger — guesses about editorial analysis that moved
player tallies, the draft board, Trades and Start/Sit.

**Now, arrival writes nothing.** Not an evidence row, not a review item, not a
signal. The issue is decoded, repaired, stored, and marked `awaiting`.

The loop is:

```
an issue arrives → Setup shows a mark → Copy for ChatGPT →
paste its tally back → see exactly what would change → approve →
applied once → the mark clears
```

**Your role is the scoring step.** The owner will paste you a newsletter's text
and expect a strict, parseable tally back. What the app keeps for itself is
everything it can do deterministically: take delivery, clean the text, hand it
over, parse a strict answer back, resolve names against Sleeper, show the deltas,
and write them exactly once.

Rules that constrain your output, and which the app enforces:

- **Scoring is one line long: good news +1, bad news −1, neutral or
  self-contradicting news does not count.** Every item counts once however
  dramatic it is. (Severity 1–3 is still graded and shown, but it no longer lets
  one sentence outweigh three — a tally you cannot predict is a tally you cannot
  trust.)
- **An approved tally is the whole reading of its issue.** The protocol says to
  omit players whose signals cancel, so **silence about a player is a verdict**,
  not an absence of one. Applying a tally retires whatever else was written for
  that newsletter, for every player — not only the ones you name.
- **Exactly once, three ways.** `newsletter_tally_applications` claims one
  application per (newsletter, exact tally); the insert *is* the decision, so a
  double tap, a reload or a retry after a timeout cannot both conclude they are
  first.
- **A human ruling is never overwritten.** A row somebody pressed a button on in
  Review is untouched; a row your tally scores the other way stops counting and
  waits for them.
- **Nothing is ever deleted.** Retired rows stay in the ledger marked `ignored`
  with a note, reversible like anything else.
- **Backlog is worked oldest first, one issue at a time.** Nothing anywhere
  combines two.

### 10b. Support snapshots (whenever a recommendation looks wrong)

**Setup → This app → Copy support snapshot** puts the exact state behind a
recommendation on the clipboard as `junculator/support-snapshot@1`. It captures
whichever of six decisions the reader was last looking at — the Draft board,
the lineup, the matchup and its Best Move, the waiver claim plan, the defence,
or a Smart Trade offer — and the row says which, with `Change` beside it.

The owner will send you one and ask why the app said what it said. On the other
end, one command replays it deterministically, through the real engine, with the
network unplugged:

```bash
npm run support:fixture -- snapshot.json
npm run support:fixture -- snapshot.json --write <name>   # commit it as a fixture
```

So the case is **reproduced rather than reconstructed from memory**, and the
exact decision somebody complained about becomes a regression test. That last
step is the whole point of the feature — when you manage a support case, the
definition of done includes `--write`.

**Nothing is uploaded. There is no support backend, no telemetry, no
collection: the file goes where he sends it.** Sleeper usernames and user ids
become `manager-1`, and so do the league and draft ids — a league id is one
public Sleeper URL away from every manager's username, so aliasing the people
and printing the league would be a redaction that removed nothing. Cookies,
tokens, provider keys, the passphrase, email addresses and newsletter text are
refused outright rather than trimmed, and a capture carrying one **throws** rather
than emitting a partly-redacted file — because a partly-redacted file is worse
than none: it looks safe. Every snapshot carries the list of what was taken out.

### 10c. What you should not do

- Do not propose anything that costs money.
- Do not propose that the app act on the owner's behalf.
- Do not propose scraping a source the repo has already established does not
  publish what you want (section 7 lists them).
- Do not accept a "small" change that adds a second count of an existing signal
  without checking section 6.

---

## 11. The quality bar

This is unusually high for a one-user hobby project, and it is the reason the
codebase is trustworthy. Hold work to it.

**A milestone is done when:**

1. `typecheck`, unit/integration tests, the browser suite at all four widths, the
   perf budget, `build` and `wrangler deploy --dry-run` are all green.
2. The change is **measured, not asserted** — page-weight deltas in bytes, CPU in
   milliseconds against the Workers allowance, quota in entities.
3. **Deliberate mutations are caught by named tests.** Recent milestones close by
   introducing a bug on purpose, confirming a specific test catches it, and
   reverting. Where a mutation *survived*, that is recorded along with the test
   written for it.
4. Anything unknown is rendered as unknown, with the reason attached.
5. Accessibility is real: cells that read badly as abbreviations hide them from
   assistive technology and offer one plain sentence; the pick on the clock
   carries `aria-current`, not just an outline.
6. It works at 360px with a 34px home-indicator inset, in light and dark.

**Two habits worth protecting because they have both caught real bugs:**

- *Check the tail, not the happy path.* The `search_rank` disaster shipped
  because the top dozen looked like consensus.
- *A filter you have not verified is a filter that returns everything.* The
  provider's `teamID` filter was checked against a real team id **and a nonsense
  one**, because a silently-ignored filter would have returned the whole slate
  and billed for it.

---

## 12. What is not done — limitations and risks

### Cannot be resolved before the season starts

1. **Vegas is off.** Adapter written and tested against live payloads; never met
   a real slate. Section 7 has the activation steps.
2. **Per-game usage has no 2026 file yet.** The feed correctly reports
   `not_published`. The 304 path, a real ingest and the mapped share (against the
   injury feed's 98.9%) first run on the season's first published file. Its real
   CPU cost on Workers, as opposed to in Node, is likewise unmeasured — the Node
   measurement is 4.0ms for a worst-case in-season week against a 10ms allowance.
3. **No real waiver run has been observed.** Specifically unknown: how many other
   managers' failed claims Sleeper's `transactions/{week}` returns, which is the
   one input `losingBidsComplete` is honest about being unable to verify.
4. **The defence planner is unproven in a live week** — whether the 72-hour
   window lands where a reader expects it, and how much of a future week is rated
   from a *line* rather than from form in the first fortnight.
5. **Matchup calibration has zero samples.** A band withholds an observed rate
   below twenty settled weeks. That is a season away.

### Known defects and gaps

6. **`adp_snapshots` carries no season column**, and nothing else can supply one.
   A snapshot imported in August 2026 is still `latest()` in 2027: plausible
   numbers, plausible ranking, a year old. The rollover diagnostic *infers* the
   season from the capture date and reports `stale`, which surfaces the problem
   without solving it. **The proper fix** — a `season` column, a migration
   backfilling from `captured_at`, the importer stamping it from
   `seasonService.ts`, and `AdpRepo.latest()` taking a season argument — belongs
   to whoever next works inside ADP ingestion.
7. **A queue-filtered draft board scores differently from the full one** (section
   6). Assigned to the Integrity workstream.
8. **The Setup screen is layout-fragile**, and a panel that intercepts pointer
   events on its own contents is still unfixed — worked around by not clicking
   that control in a browser test.
9. **Kickers and defences have no projection** in the start/sit engine. In a
   league that starts them they arrive as `projection: null`, contribute nothing,
   and are named in the confidence line as "not projected". Both sides lose the
   same amount so win probability is roughly unaffected, but projected *totals*
   are systematically low by a kicker and a defence. (Inventing a number is the
   one thing this app does not do.)
10. **The matchup game clock is wall clock, not game clock.** No play-by-play
    feed exists on a free tier, so how far into a game a player is is inferred
    from kickoff time, which comes from the Vegas event table. A player whose
    game nobody has priced is read as not-started while he has no points, live
    once he has some, marked `inferred`, and counted in the confidence line.
11. **The trade ladder and consolidation read are served and drawn nowhere.**
    `GET /api/leagues/:id/trades/ladder?playerId=` is complete, tested and
    reachable; Trades is still a discovery list. A negotiation surface is its own
    design problem. Manager profiles are likewise served, cached, and unrendered.
12. **The draft board has one entry point.** Once the season starts, the Draft
    tab leaves the toolbar and the board leaves with it — the board renders a
    completed draft happily, but nothing routes to it. A second entry point from
    a league or history context is an undecided navigation question.
13. **Rate limiting is per-isolate, not distributed.** Fine for one user.
14. **The e2e suite shares one dev server across browser projects** and reuses one
    across runs outside CI, so an interrupted run's state leaks into the next.
    Run with `CI=1` locally, or kill any surviving `dev-server.mjs`.

### Repository hygiene

15. **Three stale open PRs**, all superseded by later work on `main`: **#147**
    (Aug 23, "Read the imported projection back out of production"), **#91**
    (Aug 19, "Make the Matchup screen readable at arm's length"), **#35** (Aug 15,
    "Write down what the usage-feed investigation established"). Someone should
    read each, harvest anything not already landed, and close them. This is a
    good first PM action — it costs nothing and it removes three false signals.
16. `origin/claude/probe-sgo-season` is a stale temp branch; a delete attempt
    failed with a remote hangup. Harmless — its scripts are on `main`.

---

## 13. The plan

There are **two plans running at once, on different clocks and against different
resources**, and conflating them is the easiest mistake to make here:

- **The build plan** is a queue of three lanes, rate-limited by *Claude capacity*
  and by the owner's real draft date. It is section 13a.
- **The watch plan** is five systems meeting reality for the first time,
  rate-limited by *the NFL calendar*. It is section 13b.

They do not compete. Building does not consume a Sunday and watching does not
consume a Claude session. Sequence them independently.

---

### 13a. The build plan — three lanes, in order

This is the owner's and the previous PM's agreed sequencing. It supersedes any
ordering implied by the repository's own `docs/STATUS.md` "Recommended next
work", which predates it.

#### Lane 1 — Newsletter / ChatGPT tally correction · **SHIPPED**

**Status: landed as #196 on 2026-08-27, in `main` at `51d068c`.** The previous
PM chat had this queued as "next" and its context may predate the merge — **do
not re-plan it.** Verify and move on.

What it was scoped to do, and what actually landed, item for item:

| Scoped | Landed |
|---|---|
| Kill the old automatic signal-generation behaviour | ✅ Arrival now writes nothing — not an evidence row, not a review item, not a signal. The classifier still runs and its verdicts are discarded. |
| Establish one-newsletter → Copy for ChatGPT → Paste AI tally → review → approve | ✅ The whole loop, with `tally_state` as durable state so it survives a reload, another phone or a Worker restart. |
| Prevent double counting | ✅ Three ways: `newsletter_tally_applications` claims one application per (newsletter, exact tally) and *the insert is the decision*; evidence rows keyed as before; an approved tally retires the classifier's whole reading of that issue, for every player, not only the scored ones. |
| Setup notification dot + transient buttons | ✅ Both controls sit under the Newsletter row only while an issue is unscored and vanish once it is scored. The Setup dot composes newsletter work with the two review queues and says which is which in its accessible name. |
| Clean up player-card evidence showing bookkeeping | ✅ "Carried over from a running tally covering several earlier issues (net +11)" no longer wins the sentence ladder — skipped by *provenance* rather than by matching the text, in both places that walk the ladder. The ledger is unchanged and the timeline still prints it, which is where an explanation of how data arrived belongs. |

Also in it, and worth knowing because it touched production data: **migration
`0034`** stops classifier rows counting for newsletters still awaiting a tally.
It is narrow on purpose — classifier rows only, never `ai-tally-import` or
`tally-backfill` (the hand-imported lifetime `+11` is the owner's own work and is
never touched), never a row with an override, never one with any history in
`user_reviews`. Its two `UPDATE`s are idempotent, tested against a database built
migration by migration into the shape the deployed one is in.

Cost: app JavaScript **−79 B** gzipped. Retiring the reprocess panel paid for the
two Setup controls.

**One consequence to carry forward:** `NewsletterService.reprocess()` and its
preview are *gone*, along with the ops script and workflow built on them. That is
what makes "one scoring path" true. The decoding repair they also carried moved
to the way out — `chatSource` runs `recoverBody` every time an issue is copied,
so a body stored as undecoded MIME still hands you clean text.

#### Lane 2 — Mock Draft + Draft Tools · **NEXT, and the largest remaining piece**

**Nothing of this exists in the repository yet.** No file, no route, no test, no
`docs/` entry. Section 13c is about that.

The shape, as designed:

- The existing **`▦` grid control** beside the league name on the Draft header
  stops being a single-purpose button and becomes the home for three things:
  **Draft Board**, **Draft Order**, and **Mock Draft**.
- **Mock Draft is completely isolated from the real league.** Nothing it does may
  reach Sleeper, the real draft state, or any store the real board reads.
- **It disappears forever for that draft, automatically, the moment Sleeper
  contains the first real pick.** Not hidden, not disabled — gone, permanently,
  for that draft id.

What already exists that this builds on — this is the part that makes the lane
tractable rather than enormous:

| Existing | Why it matters here |
|---|---|
| `src/core/draft/boardGrid.ts` | A **pure** transformation: draft state → rounds → stable manager columns → pick cells. It arranges what it is handed and computes nothing else. A mock draft is a different thing to hand it. |
| `src/core/draft/boardBuilder.ts` — `buildDraftBoard` over a `DraftBoardSources` interface | The board is *handed* its facts rather than fetching them. Demo Mode already substitutes fixtures for them; support-snapshot replay already substitutes a file. A mock is a third source object, not a second engine. |
| `src/web/components/draftBoard.tsx` — `DraftBoardOverlay` | The overlay that draws the grid, with its sticky header row and round column. It fetches nothing and makes no request of its own. |
| Demo Mode's write-refusing middleware | The isolation pattern is already built, tested, and refused twice — in the browser and again at the server. |
| `core/draft/nextpick/ownership.ts` | Whose pick is whose, already correct for the snake, already imported rather than reimplemented by the board. |

So the honest engineering read: **the mock-draft lane is mostly a source object,
an isolation guarantee and a navigation change** — not a new draft engine. Any
plan that proposes writing a second ranking path is wrong and should be pushed
back on. The one genuinely new piece of judgement is what the *other* managers
do on the clock in a mock, and that is a product decision worth asking about
rather than assuming.

**This lane has a hard deadline that nothing else in the project has:** a mock
draft is a pre-draft tool, and its value goes to roughly zero the moment the
owner's real draft starts. It is late August. **Ask him for his draft date and
schedule backwards from it** — that single fact determines whether this lane is
comfortable or impossible, and it is not written down anywhere in the repo.

#### Lane 3 — Remaining pre-draft / final readiness

After Lane 2, **stop adding features.** The owner's stated intent is to return to
readiness work rather than continuing to add capability indefinitely. Section 12
is the candidate list; section 13d has the small unblocked items.

---

### 13b. The watch plan — five unproven systems meeting reality

These are not coding tasks. They are scheduled observations, each with a defined
thing to look at, and none of them consumes engineering capacity.

| # | Watch | Look at | When |
|---|---|---|---|
| 1 | **Enable SportsGameOdds and watch one real Sunday** | `/api/vegas/budget` after the first Saturday run; if `nextPlan.events` exceeds the roster spans, the team mapping failed. Also: do regular-season games carry `receptions` and anytime-touchdown markets? | Needs a decision + a watched weekend |
| 2 | **The usage feed's first published file** | The mapped share against the injury feed's 98.9%; the ingest's real CPU on Workers | First week of the season |
| 3 | **One real waiver run** | What `transactions/{week}` returns for other managers' failed claims | First in-season Tuesday/Wednesday |
| 4 | **The defence planner through one real week** | Whether the 72-hour window lands where a reader expects; how much is rated from a line vs. from form | First fortnight |
| 5 | **The first real newsletter tallies** | The coverage report — which name-like spans the dictionary does not know | Ongoing, weekly |

Item 5 also carries the repository's own judgement that **reading the coverage
report and adding the missing phrase families is the single highest-value
improvement to tally quality**. That one *is* engineering work, and it is the
natural first item of Lane 3.

---

### 13c. The risk that needs handling first: the mock-draft design is not written down

The Lane 2 design was worked out in the ChatGPT conversation that is being
replaced. **What survives into the new chat is the three-sentence summary in
13a and nothing else.** The repository has no record of it at all.

Before Lane 2 starts, that design needs to exist as a brief in
`docs/brief/`, the way every other substantial feature here does — the nine
existing briefs are what let an autonomous session build something correctly
without the person who designed it in the room, and they are preserved verbatim
for exactly this reason.

Questions the brief has to answer, which the summary does not:

- **What do the other managers do on the clock?** ADP with noise? The app's own
  board? A room prior from `core/managers/`? This is the only genuinely new
  modelling decision in the lane and it is undecided.
- **What does "disappears forever for that draft" mean in storage?** A flag, a
  deletion, or a state the phase resolver reads? The nearest precedent is
  `draft_queue` keyed `(draft_id, player_id)` from migration `0029` — which
  exists *because* a global list keyed by player alone let a finished best-ball
  shortlist turn up in the next league's draft. Do not repeat that.
- **Where does isolation get enforced, and is it refused twice?** Demo Mode's
  answer is browser *and* server, and it is the standard to match.
- **What do Draft Board / Draft Order / Mock Draft look like as three
  destinations behind one `▦`?** The current overlay is one thing with no
  navigation in it, and the Draft header is measured in the browser suite
  (`nav.height < 60` at every width) — the control cannot grow a row.
- **Does a mock produce a support snapshot?** Six decisions are capturable today;
  a seventh is either in scope or explicitly out.

**Recommended first action of the new chat:** reconstruct that design with the
owner while it is still fresh in his head, and land it as
`docs/brief/10_MOCK_DRAFT.md`. It is cheap now and unrecoverable later.

---

### 13d. Small, unblocked, and safe to hand to a parallel session

None of these touch Lane 2's files, which is what makes them safe to run
alongside it (see section 13e).

1. **Close the three stale PRs** (section 12.15). Trivial, immediate, no branch.
2. **Draft-weight tuning UI** — so the market-value vs personal-signal balance is
   adjustable without a deploy. Called out repeatedly across sessions. *Touches
   draft config; check for collision with Lane 2 before launching.*
3. **Tier visualisation on the draft board** — the tier map already computes the
   ladder, the gaps and the ratios per position; nothing draws them. *Touches the
   Draft screen; likely collides with Lane 2. Sequence, do not parallelise.*
4. **The `adp_snapshots` season column** (section 12.6) — a migration, the
   importer, and `AdpRepo.latest()`. Genuinely independent of Lane 2's files.
5. **The queue-filtered scoring defect** (section 12.7) — Integrity workstream.
   Independent, well-specified, and a good audit-lane candidate.
6. **Decide which specs need all four widths.** Every spec in `e2e/` runs at every
   width by convention and many assert *content*, which does not get more true at
   430 than at 360. Splitting width-sensitive from width-insensitive would cut
   the gate again without adding a runner. No deadline — the next feature to add
   browser tests can add them.
7. **Re-reading everything at once**, rather than one newsletter at a time. Worth
   doing only once real issues have accumulated.
8. **A negotiation surface for the trade ladder** (section 12.11) — its own design
   problem, and the engine is already waiting. Too large for a filler lane.

### What is explicitly *not* on the plan

- Anything that costs money.
- Any feature that makes the app act.
- Any re-investigation of the settled facts in section 7.
- Any new data source requiring a second identity id-space. (The nflverse snap
  counts file was rejected on exactly these grounds: it is keyed by
  `pfr_player_id`, an id space this app has never seen, and *one good signal on
  the proven identity path beats a better signal on a new one*.)

---

### 13e. Capacity, and running lanes in parallel

**The scheduling constraint as of this writing: the owner's elevated Claude
limits expire 2026-08-28.** The previous PM's call — which was right — was to
front-load anything that benefits from high-effort autonomous coding, repo-wide
analysis, large test work, or parallel lanes *while the capacity exists*, and
leave lightweight cleanup, observation and small fixes for afterwards.

Two consequences:

- **Heavy work first, cheap work later.** Lane 2 is the heavy work. The watch
  plan (13b), the stale-PR cleanup and the small items in 13d are exactly what
  survives a downgrade, because none of them needs a long autonomous session.
- **Do not artificially stay one-channel-at-a-time.** Running lanes serially when
  they are genuinely independent wastes the window. Launch separate sessions.

**But parallelise only where branch ownership is genuinely independent.** This
repository has one property that makes concurrency safe and one that makes it
dangerous:

*Safe:* `core/` is pure, layered and injected, so two lanes working in different
`core/` modules genuinely do not interact. Milestone 17 shipped eleven new
`core/` modules and changed no screen, specifically so a parallel UI channel
stayed mergeable.

*Dangerous:* **exact-head discipline.** If head `A` is green and a further change
makes head `B`, `A` is no longer the merge proof. Two lanes merging into `main`
in quick succession each invalidate the other's gate. Merge one at a time, and
re-run the gate on the actual head that will land. A green run against a head
that no longer exists proves nothing about what would land.

A workable split for the current window:

| Session | Lane | Owns |
|---|---|---|
| Primary | Lane 2 — Mock Draft + Draft Tools | `core/draft/`, `web/screens/DraftScreen.tsx`, `web/components/draftBoard.tsx`, the `▦` navigation |
| Audit / reliability | 13d.5 — the queue-filtered scoring defect | `core/draft/boardBuilder.ts` candidate-pool scoping — **check for collision with Lane 2 first** |
| Independent | 13d.4 — the `adp_snapshots` season column | `migrations/`, `core/adp/`, `server/repos/adp.ts`, `seasonService.ts` |
| Zero-cost | 13d.1 — close the three stale PRs | No branch at all |

Before launching any two together, ask the one question that settles it: **do
these two lanes write to the same files?** If yes, sequence them. The cost of
being wrong is a merge conflict in a repository where the gate takes twelve to
fifteen minutes per attempt.

---

### 13f. How to write a work brief for this repository

The infrastructure below was built specifically so that remaining work can move
faster *without getting sloppier*. A brief that ignores it makes a session
slower, not safer. Every MD you hand to an engineering session should say which
of these it expects to be used.

- **Targeted tests first, not a giant serial sweep.** Name the tests that must
  fail before the change and pass after it. The suite is 250 unit/integration
  files and 44 browser specs; re-running all of it to learn one thing is waste.
- **Use the sharding that already exists.** The browser gate is 4 widths × 3
  shards = 12 parallel jobs, six to ten minutes each, eighteen-minute timeout.
  Playwright splits by whole spec file, so a new spec file needs nothing added
  anywhere. Reproduce one CI runner exactly with
  `npx playwright test --project=webkit-iphone-430 --shard=2/3`.
- **State the exact-head gate.** The brief should say plainly: the thing merged
  must be the thing validated, and green-but-skipped is not green. Both have
  already cost this project a mistake (#190 exists because of the second).
- **Reach for Support Snapshot before archaeology.** When something looks wrong,
  the answer is a captured file replayed deterministically through the real
  engine with the network unplugged — not a reconstruction from memory with a
  test written afterwards to agree with it. And `--write` the case as a fixture.
- **Reach for Data Health when freshness is the question.** "Is the app wrong or
  is its input stale?" already has a screen and an endpoint. Do not have a
  session re-derive it from Cloudflare, GitHub and D1.
- **Say what it costs.** Bytes against `perf-budgets.json`, milliseconds against
  the Workers allowance, entities against the Vegas quota. The demo chunk has
  about one kilobyte of headroom, so "no measurable change" is not a measurement.
- **Name the deliberate mutations.** For anything load-bearing, say which bug
  should be introduced on purpose and which *named* test must catch it.

---

## 14. How to manage this well

A short list of the judgements this project rewards:

1. **Do not trade the build window for the watch list.** They are different
   resources (13). The watching costs nothing but calendar time and survives a
   capacity downgrade; Lane 2 does not. Spend the window on Lane 2 and let the
   five observations happen on the NFL's schedule.
2. **Get the two undated facts out of the owner's head today.** His **real draft
   date** (which is the only deadline Lane 2 has) and the **mock-draft design**
   (13c, which currently exists in no durable place). Both are cheap now and
   expensive or impossible later. Ask for them one at a time.
3. **Schedule the Vegas activation deliberately.** It is the one decision that
   needs him, it needs a weekend he can watch, and it should be asked as *one*
   dummy-proofed action — not bundled with the two above.
4. **Guard the double-counting rules** (section 6). This is where a plausible
   "improvement" does real damage.
5. **Guard the byte budgets** (section 8). The demo chunk has ~1 kB of headroom.
6. **Treat "unknown" as a feature under attack.** Every product instinct pushes
   toward filling a blank field. This project's whole credibility rests on not
   doing that.
7. **Turn every support case into a fixture.** `--write` is the definition of
   done for a bug report.
8. **Check the lane plan against `main` before planning anything.** Lane 1 was
   still "next" in the previous PM's context after it had merged. Read the last
   ten commits before writing a brief.
9. **Ask him for one thing at a time.** Section 3.

### Useful questions to ask the engineering session

- What is the exact head, is CI green *on that head*, and did every required job
  actually run?
- What did this change cost in gzipped bytes, and against which budget?
- Which named test catches this if it regresses?
- What does this show when the input is missing — and is that "unknown" or an
  invented value?
- Does anything in this change count a signal that is already counted?

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **ADP** | Average Draft Position — the market's ranking. Imported, not derived. |
| **AVOID** | A lifetime tally at or below −5. The red chip was removed; the model still applies a bounded penalty and the API still carries the flag. |
| **BPA** | Best player available. The draft board's calibration: roster need is a light tiebreaker (weight 0.1, scaled down further early), worth a pick or two in round one. |
| **Cliff / thinning** | A cliff is a hole in the market — the gap to the next available player clears a per-position floor (QB 12, TE 13, RB/WR 8 picks), is ≥2× median spacing locally and position-wide, and is not just where the position turns uniformly sparse. At most a fifth of a position may be labelled. A thinning is the same measure, more permissive. **A tier is delimited by cliffs only.** |
| **DOG** | Underdog ADP (the "Underdog" source), as in `verify-dog.yml`. |
| **DST** | Team defence/special teams. |
| **Entity** | SportsGameOdds' billing unit: one *event* returned. |
| **Evidence ledger** | The permanent store of every news item. Tallies are derived from it. |
| **FAAB** | Free Agent Acquisition Budget — the waiver bidding wallet. |
| **♥ My Guy** | ♥/♥♥/♥♥♥ — an opinion about a player, worth about two, five or ten picks of ADP. A real tiebreak, never enough to overrule the board. |
| **Next%** | The colour-coded chance a player is still there at your next pick, conditioned on his still being available *now* — `S(next)/S(current)`, computed in log space. Bands: 0–30 red, 31–65 amber, 66–100 green. |
| **★ queue** | A bookmark. Fills the queue and the ★ filter. Changes no ranking. |
| **Tally** | A player's net news score. +1 good, −1 bad, neutral doesn't count. |
| **WOPR** | Weighted Opportunity Rating — a usage metric from the nflverse weekly stats. |
| **xFP** | Expected fantasy points from opportunity alone. Reported, never scored. |

---

## 16. Quick reference

```
Repo         juncaj93/Fantasy-Analyst
Live         https://fantasy-analyst.juncaj93.workers.dev
Health       GET /api/health          → reports the deployed SHA
Vegas budget GET /api/vegas/budget    → month by source + next plan (no provider call)
Newsletter   fantasy-news@juncaj.net  → Cloudflare Email Routing → Worker email()
Main         51d068c (2026-08-27), deployed and green
Deploy       push to main → CI green on that SHA → deploy.yml → release.yml
Rollback     .github/workflows/rollback.yml (a form; names a known-good revision)
Local dev    npm install && npm run dev   → http://127.0.0.1:8787, passphrase "devpass"
```

---

## 17. Where to read more

| Doc | Read it when you need |
|---|---|
| `README.md` | The product, screen by screen, in the owner's own voice. Start here after this file. |
| `docs/STATUS.md` | The full milestone history — ~3,000 lines, every decision and why. The definitive record. |
| `docs/HANDOFF.md` | The previous engineering handoff (2026-08-14). Traps and standing facts, still accurate. |
| `docs/ARCHITECTURE.md` | Layering, identity ladder, engines, runtime portability |
| `docs/SETUP.md` | Local dev, deployment, and the exact manual steps in plain language |
| `docs/RELEASE.md` | How a release reaches production, what is live, how to roll back |
| `docs/VEGAS.md` | The quota numbers — the most load-bearing measurements in the repo |
| `docs/DEMO_MODE.md` | The scenario registry, time injection, mutation isolation |
| `docs/SUPPORT_SNAPSHOT.md` | Capture, redaction, deterministic replay, fixtures |
| `docs/DATA_HEALTH.md` | Source inventory, freshness policy, the scheduled-run ledger |
| `docs/WAIVER_CLAIM_PLANNER.md` | Drop cost, contingency claims, what the reader sees |
| `docs/LEAGUE_INTELLIGENCE.md` | Waiver competition, trade fit, planning, the decision feed |
| `docs/PLAYER_AND_LINEUP_INTELLIGENCE.md` | Expected points, beneficiaries, contingency lineups, self-grading |
| `docs/SMART_TRADES.md` | Bilateral offers: roster need, defensibility, capped manager fit |
| `docs/MANAGER_INTELLIGENCE.md` | The resumable history ledger and the three things it may change |
| `docs/MODEL_INTEGRITY.md` | The correctness audit: findings, invariants, anomaly detection |
| `docs/PROJECTION_V2.md` | The market-anchored usage model, evaluated and consumed by nothing |
| `docs/BUDGETS.md` | Page-weight and free-tier budgets, and what enforces them |
| `docs/EMAIL_INGESTION.md` | Wiring automatic newsletter delivery |
| `docs/IOS_WEB_APP.md` | Home Screen install, and who owns the bottom of the screen |
| `docs/DESIGN_SYSTEM.md` | Tokens, position colours, the shell |
| `docs/brief/` | The original build briefs, preserved verbatim, plus the later ones. `08_WORKING_AGREEMENTS.md` is how an autonomous session runs. |

---

*This handoff describes the repository at `51d068c`. Where it cites a test count,
a byte measurement or a quota figure, that figure is quoted from the
repository's own documentation of the run that measured it — dependencies were
not installed in the session that wrote this document, so nothing here was
re-measured. Everything else is read directly from the code, the workflows and
the migrations as they stand.*
