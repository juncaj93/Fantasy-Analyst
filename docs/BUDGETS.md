# Budgets

What this app is allowed to spend, and what enforces it.

Fantasy Analyst runs entirely on free tiers and is expected to keep doing so
while the models behind it grow. That is not a constraint anybody imposed from
outside — it is the reason the project works the way it does, and every design
decision in it that looks odd is usually this constraint showing through.
Nothing in here is a target to optimise towards; they are ceilings, and the
mechanism is that crossing one has to be noticed.

## Why measure at all

The failure mode is slow and invisible. No single commit makes the app heavy.
A Monte Carlo survival model, tier arithmetic, injury normalisation, usage
trends, a board that returns four hundred rows instead of forty — every one of
those was the right call, none of them looks like a page-weight decision, and
all of them ship to a phone. Without a number that fails, the only signal is
somebody eventually noticing the app feels slow, at which point the cause is a
year of commits and there is nothing to bisect.

## Page weight — `npm run perf:budget`

Deterministic, and enforced on every push. `scripts/perf-budget.mjs` gzips the
built assets and compares them against `perf-budgets.json`.

| what | budget (gzip) | roughly today |
| --- | --- | --- |
| app JavaScript | 140 kB | 128 kB |
| app CSS | 20 kB | 14 kB |
| HTML shell | 4 kB | 1.6 kB |
| everything needed to render | 160 kB | 144 kB |
| Demo Mode, fetched only when opened | 150 kB | 140 kB |

Both columns are read from `perf-budgets.json` and `npm run perf:report`
respectively; the second is a snapshot and will drift, which is why the command
rather than this table is the thing to believe. The Demo Mode *budget* had
fallen out of step here at 108 kB while the file said 150 kB, which is worse
than drift — a table that understates a ceiling reads as headroom nobody has.

The total exists so that splitting one large file into three does not quietly
pass three budgets. Each file is gzipped **individually** and then summed,
because that is how a browser fetches them — measuring the concatenation would
report a compression ratio no client will ever see.

**One thing is excluded from the render-path budgets, and it is capped
separately.** Demo Mode ships as `assets/demo-*.js` — a name `vite.config.ts`
assigns deliberately — and no page load can fetch any of it: every path to it is
a dynamic import behind Settings or an explicit `?demo=`. Counting it against
"everything the browser must fetch to render" would make that number describe
something nobody experiences, and the usual reaction to a number like that is to
raise it until it stops complaining. So `excludeMatch` leaves it out, and the
row above puts a ceiling on it instead. **Excluding without capping is not
allowed**: it is how a budget stops meaning anything, which is the failure this
whole mechanism exists to prevent.

**Raising a number is a deliberate act.** It belongs in the same commit as
whatever needed the room, with the reason in the commit message. A budget
raised on its own, to turn a red build green, is a budget that has stopped
meaning anything.

## Flow timing — `e2e/performance.spec.ts`

The flows §9 of the resilience brief names, measured in a real WebKit iPhone
viewport: shell render, Draft open, Team open, player sheet, search response,
filter response.

These budgets are **deliberately generous** — seconds, where the real numbers
are tens of milliseconds. They run on a shared CI runner that can be three
times slower than a laptop, and a budget that fails on a busy morning gets
marked flaky and then ignored, which is strictly worse than not having one.
They are set to catch a flow going from milliseconds to seconds: a board that
starts re-scoring on every keystroke, a filter that refetches, a sheet that
pulls the whole player universe.

Bytes for precision, wall clock for the shape of the flow. That split is the
point — do not tighten the timings until they run somewhere with a predictable
clock.

One assertion in there is not a timing at all and matters more than the rest:
**typing in the search field must produce zero API requests.** Search filters
rows that are already on the client. If a keystroke ever reaches the server the
flow is not slightly slower, it is a different flow — one that is unusable on a
bad connection, which is exactly where a draft happens.

## Cloudflare Workers CPU

The free plan allows 10ms of CPU per invocation. That is the tightest limit this
app lives under and the one that has actually been hit.

- **Parsing published season files is the danger.** A full parse of a finished
  season's weekly stats measures ~25.6ms — two and a half times the entire
  budget. This is why `core/usage/nflverse.ts` parses incrementally by week
  rather than reading the file whole, and why the injury history backfill walks
  one week per tick instead of one season per tick.
- **Conditional GETs keep the ordinary tick free.** Every published-file source
  goes through `core/source/conditional.ts`, which sends an `ETag` and gets a
  304 with no body. The common case costs a round trip and no parsing at all.
- **The expensive path is gated on a fingerprint.** A draft poll writes picks
  cheaply; *rebuilding the board* on top of them is a Monte Carlo run per
  candidate. `core/sleeper/draftFingerprint.ts` decides whether anything
  actually moved, and most polls during a live draft land on a draft where
  nobody has picked since the last one.
- **Arriving on Draft costs one board, not two.** The gate above had a hole at
  exactly the moment it was most expensive: the refresh loop's first sync had no
  fingerprint to compare against, read its own first answer as a change, and
  rebuilt the board the visit had already fetched. Every board now reports the
  pick state it was built from as `pickFingerprint`, produced by the same
  function the sync route uses, so the two are compared instead of assumed
  apart. Measured on the seeded fixture: **2 board builds and 250kB down to 1
  and 32kB** on a cold load.
- **The board sends what the board draws.** A recommendation carries its own
  workings — fifteen scored components, the bullets they produce, the
  opportunity-cost and NFL-overlap arithmetic, the `Next` model's per-player
  probabilities — and the Draft screen renders none of it. It was about seven
  bytes in ten of the response, on a phone, mid-draft. `core/draft/boardWire.ts`
  is the list of what is dropped and why; everything on it is still computed,
  still carried on `DraftBoardState`, still in every support snapshot, and still
  reachable over HTTP with `?diagnostics=1`, which is how the probes ask.

## D1 reads and writes

The free plan allows 100,000 rows written per day across everything. Two
pipelines write regularly and each has its **own** ledger and its own ceiling,
so neither can spend the other's allowance or hide the other's runaway:

| pipeline | daily ceiling | a healthy day |
| --- | --- | --- |
| injury reports | 5,000 rows | a few dozen; several hundred on a week rollover |
| weekly usage | 2,000 rows | ~350 rows the morning after a game day, zero between |

Both ceilings are far above any legitimate day and far below anything that
would threaten the rest of the app. A pipeline that hits its ceiling stops
writing for the rest of the UTC day rather than degrading anything else.

## Request frequency

| clock | what runs |
| --- | --- |
| every 5 min | injury check (conditional; usually a 304), plus one catch-up week if the check found nothing |
| daily 09:00 | Sleeper player dictionary, `/state/nfl`, last season's stats, one injury check |
| draft live | 5s poll, 2.5s while on the clock — the most this app ever asks of anything |

The draft cadence is the only aggressive number here, it applies for a few
hours a year, and `core/season/lifecycle.ts` caps it by lifecycle state: there
is no cadence at which polling a finished draft is correct.

## Third-party image bytes

The page-weight budgets above govern this repository's own JavaScript, CSS and
HTML. They do not govern player portraits, and deliberately do not grow a
media-budget system for one image on one surface. What is written down instead:

| | |
|---|---|
| measured source | JPEG, dominant 350×254, ~30 kB median (thumb variant ~23 kB, unused) |
| cache policy | Sleeper's own `public, max-age=2678400` — 31 days, Cloudflare `HIT` |
| approved surface | the expanded player sheet, one image, loaded eagerly |
| image-free by decision | Matchup, Draft, Waivers, the Players index, compact Smart Trades rows, and Team |
| eager loading across a result set | never — the sheet is the only eager loader |
| bytes served by this deployment | none: the browser fetches Sleeper directly |

The last two lines are the ones that keep this from needing a budget at all. One
opened card is one ~30 kB request, to somebody else's CDN, cached for a month;
there is no path by which a list can turn that into fifty. Both are asserted in
`tests/playerHeadshotSurfaces.test.ts` rather than left as intentions, and
`e2e/player-face.spec.ts` checks the running app makes no portrait request from
any list. See "Player portraits" in `docs/ARCHITECTURE.md`.

## Browser-side computation

The board arrives ranked and scored from the server. The client filters, sorts
by match tier and draws — it does not score. Two consequences that are load-
bearing:

- searching and filtering are local, so they work at full speed on no
  connection at all;
- the client never becomes the thing that has to be fast on a five-year-old
  phone, because the arithmetic already happened.

## What stays offline

Heavy audits, backtests and source probes live in `scripts/` and run on a
laptop or in CI, never in a Worker. There are ~30 of them. If a question needs
the whole season file, or a thousand simulations, or a walk over every row of a
published dataset, it is a script — not an endpoint.

## No paid monitoring

Everything above is Node, `zlib`, Playwright and a JSON file, all of which the
repository already had. No service, no account, no dashboard that lapses when
somebody stops paying for it. A budget that depends on a subscription is a
budget with an expiry date.
