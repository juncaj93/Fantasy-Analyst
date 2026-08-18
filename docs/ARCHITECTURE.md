# Architecture

## Shape

```
src/
  core/        pure domain logic — no I/O, no framework, fully unit tested
    identity/  canonical player model + matching ladder
    sleeper/   API client, transforms, scoring/roster interpretation
    adp/       Underdog snapshot import
    newsletter/ sanitize -> segment -> detect -> classify -> evidence
    evidence/  ledger types + derived signal aggregation
    vegas/     provider interface, adapters, market normalization, cache policy
    draft/     draft recommendation components
    startsit/  start/sit components + Vegas -> fantasy-points conversion
    faab/      waiver budget truth, bid research, bid strategy
    market/    Sleeper trending as attention, and trend-vs-model disagreement
    roster/    bench-slot opportunity cost
    trades/    trade verdicts, offer ladder, consolidation
    managers/  bounded trade and draft tendencies, from league history
    players/   physical and age/experience contextual flags
  server/      D1-shaped persistence, services, HTTP router, auth
  worker/      Cloudflare Worker entry (fetch + scheduled + email)
  web/         React SPA (iPhone Safari first)
  devserver/   local/e2e bundle entry + demo seed data
migrations/    D1 SQL
tests/         vitest (unit + integration against real SQLite)
e2e/           Playwright, iPhone portrait widths
```

## Layering rule

`core/` never imports from `server/`, `worker/` or `web/`. Everything in `core/`
is a pure function or a class with injected dependencies, which is why the
recommendation engines, the classifier and the identity ladder are all testable
without a database, a network or a browser.

## Runtime portability

The API is built as `createApp(): (Request, AppEnv) => Promise<Response>` over a
`Database` interface that is structurally compatible with Cloudflare D1.

- **Production**: the worker passes `env.DB` (D1) straight through.
- **Local dev and e2e**: `NodeSqliteDatabase` implements the same interface on
  top of `node:sqlite`, and `scripts/dev-server.mjs` serves the same routes.
- **Tests**: the same adapter applies every file in `migrations/` in order, so
  repository tests exercise real SQL and a malformed migration fails the suite.

One consequence worth stating: you can run and browser-test the whole app
without Wrangler or workerd.

`node:sqlite` is loaded through `createRequire` because it is still absent from
Node's `builtinModules` list, which breaks static bundler resolution.

## Canonical player identity

`src/core/identity/` is the foundation everything else resolves through:
Underdog rows, newsletter mentions and sportsbook player names all become a
canonical player id (the Sleeper player id, when one exists).

The ladder, strict first:

| # | Method          | Confidence | Notes |
|---|-----------------|-----------|-------|
| 1 | `external_id`   | 1.00 | Sleeper/GSIS/ESPN/Yahoo/odds-vendor ids |
| 2 | `name_team`     | 1.00 | normalized full name + team |
| 3 | `name_position` | 0.98 | normalized full name + position |
| 4 | `alias`         | 0.95 | sync-generated and user-added aliases |
| 5 | `name_unique`   | 0.90 | exact name, exactly one active player |
| 6 | `fuzzy`         | ≤0.77 | bounded candidate generation |

A fuzzy match is auto-committed **only** when all of these hold (`AUTO_FUZZY`):
edit distance ≤ 1, same team, same position, the player is active, and no other
active candidate scores within 0.05. Everything else returns
`status: 'ambiguous'` with ranked candidates and lands in the review queue.

Distance is Damerau-Levenshtein (adjacent transpositions cost 1) because swapped
letters are the most common way a name is miscopied.

Normalization is lookup-only — display names are always stored verbatim.

## Evidence ledger

`evidence_items` is the source of truth. `player_signal_cache` is derived and
can be rebuilt at any time from the ledger.

- Every news item is stored with its original excerpt, matched rule, category,
  polarity, magnitude and confidence. Nothing is reduced to a bare tally.
- `user_override` beats the classifier for every field it specifies, and
  reprocessing never touches a row that already exists (inserts are
  `ON CONFLICT DO NOTHING` keyed on `dedupe_key`).
- Only `auto_applied`, `accepted` and `corrected` rows count toward tallies.
  `pending`, `rejected` and `ignored` rows stay in the ledger and out of the
  numbers.
- `mixed` and `neutral` items count as items but contribute exactly 0.
- Recency windows (7d / 21d / season-to-date) are computed from `source_date`;
  old evidence is never deleted.

## Newsletter ingestion

The production path is a dedicated inbound address (Cloudflare Email Routing ->
the Worker `email()` handler). No personal mailbox is ever accessed.

`NewsletterService.ingest` is the single gate between "mail arrived" and
"evidence exists":

- every message is logged with its outcome, so the app can always show what
  arrived;
- an unexpected sender is **quarantined** — recorded and visible, never parsed;
- the same message id is never handled twice, and identical content is skipped
  only when it was previously *processed*, so a spoofed lookalike cannot
  fingerprint-block the genuine newsletter;
- oversized bodies are rejected;
- failures are recorded in plain language and change nothing.

Each processed newsletter also stores a coverage report (classified vs
unmatched player sentences, plus name-like words missing from the dictionary).
Unmatched content is a quality signal, not an error.

## Newsletter classification

Deterministic and rule-driven — no LLM anywhere in the runtime path.

1. Sanitize HTML (tolerant of malformed markup; script/style dropped).
2. Strip boilerplate via an editable pattern list, dedupe repeated lines.
3. Segment into blocks then sentences (abbreviation-aware).
4. Detect player mentions through the identity ladder.
5. Classify each sentence against `src/core/newsletter/rules.ts`.
6. Persist evidence keyed by a stable dedupe hash.

`rules.ts` is data, not logic: phrase families, categories, magnitudes and
context templates live there; `classify.ts` holds the single evaluation
algorithm.

**Negation** is applied in a bounded 5-token window before each rule hit and
never crosses a clause boundary (`,`, `;`, `but`, `however`, …). A negated rule
flips polarity and drops magnitude to 1. Rules whose pattern already encodes
negation (`did not practice`, `no longer limited`) are marked `selfNegating` so
they are not flipped twice.

**Mixed stays mixed.** When positive and negative signals coexist the result is
`mixed` at low confidence, contributing 0 to the tally and going to review.

**Confidence** starts at `high` and is demoted for: mixed signals (low), hedging
language, contrast connectives with multiple signals, polarity derived purely
from negation, two players in one sentence (medium), more than two players or
ambiguous identity (low). Only `high` may be auto-applied — and never for a
surname-only mention.

**Context summaries** are composed only from rule templates. When no template
matches, a truncated excerpt is stored instead of invented prose.

## Setup surface

`SetupService` renders the state of the five areas (Sleeper, League, ADP,
Newsletter, Vegas) as plain-language strings — the UI shows them nearly
verbatim. Anything that genuinely requires a terminal lives in `docs/SETUP.md`,
never in the app.

Configuration a non-developer can reach from their phone: Sleeper connection and
league choice, player-list refresh, ADP import (file or paste, with a full
matched/ambiguous/unmatched/skipped breakdown), the newsletter address and
expected sender, and the review queue. A test asserts the setup copy contains no
developer vocabulary.

## Recommendations

Both engines return separate, inspectable components — never one opaque number.
The UI renders each component's score, weight and contribution.

**Draft** (`src/core/draft/engine.ts`): market value (`currentPick - ADP`, with
reaches damped by half), roster need, positional scarcity (tier gap + remaining
depth), league fit (derived from Sleeper scoring), recent news, lifetime news,
and survival-to-next-pick. News weights are small and saturating so a big tally
sways a close call without overturning a large market-value gap.

**Survival** — the `Next` column — is a deterministic-seeded Monte Carlo
simulation of the actual picks between now and the user's next owned selection
(`src/core/draft/nextpick/`, documented in `docs/NEXT_PICK.md`). Each simulated
pick asks who owns it, what that manager's starting slots still want, and what
the room has been doing, then samples a position and a player and updates the
board. The ADP distribution it is built on lives in `src/core/draft/survival.ts`
and remains the fallback when a draft cannot be simulated. It is an estimate,
labelled as such, and returns `null` — not a fabricated number — when ADP is
unknown or the user has no later pick.

**Start/sit** (`src/core/startsit/engine.ts`): Vegas market expectation
(converted with the league's own scoring settings), recent news, lifetime news,
availability status and an uncertainty penalty for thin/partial/stale market
data. Missing markets are reported, never imputed; if nothing is usable the
recommendation is withheld.

## Live draft refresh

The Draft board keeps itself level with Sleeper. `src/web/draftRefresh.ts` owns
the whole lifecycle — the screen supplies only "how to sync" and "what to rebuild
when the answer is new" — and its clock is injected, so the schedule is tested at
speed rather than waited out (`tests/draftRefresh.test.ts`).

Polling is **browser-side and foreground only**. There is no worker cron, and
nothing runs while nobody is on the screen: the controller starts when
`DraftScreen` mounts and stops when it unmounts, so entering Draft by any route
syncs immediately and leaving it ends the loop.

| condition | cadence |
| --- | --- |
| Draft open, visible, live | 5000 ms |
| user on the clock | 2500 ms |
| repeated failures | 5s → 10s → 20s → 30s, reset on first success |
| hidden, offline, off Draft, draft complete | stopped |

Immediate syncs happen on mount, route activation, foreground resume, network
recovery and a manual tap. iOS fires several signals for one resume, so those are
coalesced into one request. Requests never overlap: a timer tick that lands
mid-flight steps aside, an explicit trigger is owed at most one follow-up, and a
response that arrives after the screen is gone is discarded rather than applied.

**The board is only rebuilt when the draft actually moved.** Every sync returns a
semantic fingerprint (`src/core/sleeper/draftFingerprint.ts`) over the draft id,
its status, and the pick sequence with ownership — sorted, and blind to transport
timestamps and metadata. An unchanged fingerprint updates `lastCheckedAt` and
stops there: no board request, and therefore no Monte Carlo survival run, no tier
recomputation and no opportunity-cost work. A changed one calls the screen's
ordinary board reload, which is the existing path all of those already hang off;
the refresh layer duplicates none of them. Repeated failures keep the last good
board and show one compact `Draft sync delayed · retrying` line rather than an
error page. `window.__draftRefresh()` reports the loop's state on the device.

## Vegas provider abstraction

Nothing outside `src/core/vegas/` references a vendor field name. Adapters map
into the internal vocabulary: `pass_yards`, `pass_tds`, `rush_yards`,
`receptions`, `receiving_yards`, `anytime_td`. Unknown markets are dropped
rather than guessed.

`MockVegasProvider` is the default and costs no quota. `OddsApiProvider` is
implemented but off by default — see `docs/VEGAS.md` for what to verify first.

Fetches go through `getPropsWithCache`, which refuses to refresh inside the TTL,
enforces a manual-refresh cooldown, and on any failure serves the last cached
snapshot explicitly marked stale. It never throws and never fabricates.

## Team marks

`src/core/nfl/teams.ts` is the only place that answers "which club is this, what
is it called, and which file draws it". Screens reach it through the `TeamLogo`
primitive in `src/web/components/common.tsx`, which `PositionBadge` renders — so
Draft, Team, Players, Trades, Start/Sit and Review all get the identical
treatment from one edit.

Codes are Sleeper's. Anything else — `JAC`, `OAK`, `WSH`, `SD`, `STL` — is
folded onto them by the identity layer's existing `normalizeTeam`, so there is
no second alias table beside the logos.

The 32 marks are **bundled**, at `src/web/public/logos/nfl/<code>.webp`, served
from this app's own origin at a path that never changes. That was chosen over
hot-linking a logo CDN for four reasons: the PWA keeps working offline, there is
no third-party runtime dependency to go down or start rate-limiting, coverage is
a fact a test can check against the filesystem rather than a hope, and the marks
can actually be seen in local visual QA. They are 96px transparent WebP, ~3.4 kB
each and ~110 kB for the set, drawn at 22px — so a mark is one small cacheable
request per club, not per player row.

The artwork was rendered once from the `nfl-team-logos` npm package (ISC, v1.5.0)
into flat files; the package is not a dependency of this project. To regenerate,
extract each component to SVG with `react-dom/server` and rasterise to 96px WebP
with `sharp`, keyed by the lowercased canonical code. Club marks are the
respective clubs' trademarks, used here only to identify the club a player plays
for in a private tool.

Nothing in this path ranks, scores or decides anything, and every step degrades
to the team abbreviation: an unknown code, a free agent, a missing file and a
failed request all end at the same `CHI`-style fallback the rows printed before.

## League strategy

Five things a manager decides that are not "who do I start": what to bid, what
to drop, what to offer, whether to consolidate, and who they are negotiating
with. Every one of them is a pure module in `core/`, and the whole layer holds
to two rules that are enforced in the types rather than promised in prose.

**Nothing here executes anything.** There is no bid, claim, add, drop or trade
path anywhere in the app, and this layer adds none. `buildLadder` returns
`advisory: 'never auto-sent'`; the bid strategy returns three numbers and a
sentence.

**Nothing here moves a projection.** Market attention, disagreement, physical
profile and age are *context*, and each carries a field saying so —
`affects: 'bid_price_and_confidence_only'`, `weight: 'context'`,
`scoreDelta: 0`. A consumer that wants to turn one of them into a score has to
delete a field to do it, which is the point.

### FAAB (`core/faab/`)

Three numbers that are deliberately not one number: the **expected market
price** (a forecast about other people), the **recommended bid** (what he is
worth to this roster) and the **do-not-exceed ceiling**. The recommendation
frequently sits below the market band, and that is the advice rather than a bug.

The budget is read from the league's own settings and **never assumed**. Sleeper
defaults to $100; a $200 league reading $100 calls an ordinary bid reckless, and
a $50 league reading $100 recommends money that does not exist. A league that
publishes no budget, or does not bid at all, gets a sentence instead of a dollar
figure. Spend comes from each roster's `waiver_budget_used`, which already
accounts for FAAB moved in a trade; transactions are used only to cross-check it
and never to replace it.

Prices come from the league's own completed waiver claims, by percentile rather
than mean — FAAB spending is long-tailed and one $71 panic bid drags a mean into
a range nobody has paid. Below three observed winning bids the expected price is
an explicit estimate, labelled as one. **Losing bids are reported as a floor**,
never as a distribution: Sleeper publishes the user's own failed claims and
other managers' inconsistently, so `losingBidNote` says `unknown` when nothing
can be reconstructed.

### Market attention (`core/market/`)

Sleeper's global trending list counts what other people are doing, not what
anybody's model thinks. It is allowed to price a bid and to raise a question; it
may not touch a projection. Feeding it into one would launder the crowd's
opinion into the app's own numbers and then present the result as independent
evidence.

Velocity needs two captures — Sleeper keeps no history, so
`trending_snapshots` is written down before it can be differenced. Rates from
different lookback windows are never compared, and an acceleration ratio built
on fewer than five adds an hour is withheld rather than published as
`accelerated 6×`.

`detectDisagreement` finds the two populations no single ranking surfaces: the
market surging while usage is thin (expect to pay for the story), and the model
strong while the market is quiet (the only cheap edge a waiver wire offers). A
model with nothing behind it cannot disagree with anybody, which is what stops
every rookie with one good game becoming a warning.

### Bench, ladder, consolidation

`core/roster/bench.ts` prices a bench slot **across positions**, which is the
whole point: a mediocre QB2 looks fine next to other QB2s and absurd next to the
slot he occupies. Slot value is what he would score, plus discounted starter
insurance, optionality and bye coverage, minus what the wire offers at his
position. Starters and reserve-slot players are never offered as drops.

`core/trades/ladder.ts` returns an opening offer, a fair zone and a
do-not-exceed, anchored between what the player costs his current owner and what
he is worth to you. `ladderIsOrdered` is the invariant, and a trade that creates
no surplus is reported as blocked rather than dressed up with a band a
millimetre wide.

`core/trades/consolidation.ts` deliberately has no house view. It measures
startable depth, existing fragility, the lineup gain and how late it is, and
returns `consolidate` or `keep_depth` from the same inputs depending on which
way they point — because a 2-for-1 converts depth into ceiling **and** fragility
in the same move.

### Manager profiles (`core/managers/`)

The only source in the app that describes people rather than players, and
correspondingly easy to abuse. Three rules: a sample below the threshold is
never called a tendency (`confident` is false and the notes say why), recency is
weighted rather than filtered, and the profile is descriptive — "trades often"
never means "will accept your offer".

Draft tendencies produce a **bounded room prior** — when the first quarterback
goes, whether the room reaches past the market, whether runs are real once the
position mix is subtracted out. It is offered to `core/draft/nextpick/` as
evidence and **does not modify Next% here**; that module owns its own model, and
a room prior applied behind its back would be a second, uncalibrated ADP.

Run-following is measured only at room scope. One manager's picks are every
twelfth pick, not a sequence, and measuring it there would measure his own
positional streaks under the same name.

### Physical and age flags (`core/players/profileFlags.ts`)

Height, weight, age and years of experience are the most tempting bad inputs in
the dataset — objective, complete, numeric, and explanatory of very little.
Migration 0021 stores them (the sync had been discarding them); the module makes
them nearly unusable on purpose.

A flag fires only where a measurement meets a **role it is in tension with**:
`Small frame for projected outside role`, not `5'9"`. The same body in the slot
gets nothing. Age never fires alone — the running-back flag requires *falling
usage* as well, read through the same `assessRole` the card prints a few pixels
above, so the two can never disagree. Below the six-game usage minimum the trend
is `unknown` and the flag stays silent.

`showMeasurements` is false unless a physical flag fired, and the server nulls
height and weight out at the boundary rather than trusting the browser to hide
them: a number shown is a number the reader will weigh.

### Newsletter takeaway (`core/evidence/takeaway.ts`)

One sentence explaining what the signed tally already said. It is **selected,
never written**: the sentence comes from evidence already in the ledger, ranked
by category relevance, specificity, corroboration and a recency decay, and the
answer is `null` whenever nothing clears the bar. A long excerpt is declined
rather than trimmed, because cutting a sentence to fit is the cheapest way to
change what it says.

It is explanation only. The evidence under it has already been counted once by
the tally, so the returned object carries `scoreDelta: 0` and no consumer adds
it to anything. `tests/takeaway.test.ts` pins the headline appearing while the
aggregate signal is byte-identical before and after.

Every screen renders it through `src/web/components/playerDetail.tsx`, which is
also where the season outlook, the last-season line and the injury sections now
live. Draft and Players had grown byte-identical copies of all three; two copies
is how six start.

### Endpoints

| route | what it does |
| --- | --- |
| `GET /api/leagues/:id/waivers` | upgrades, now with the bid, the opportunity cost and the market line per candidate |
| `POST /api/leagues/:id/strategy/refresh` | fetch missing transaction weeks and capture the trending list; rate limited |
| `POST /api/leagues/:id/managers/refresh` | walk the previous-league chain and rebuild every manager profile |
| `GET /api/leagues/:id/managers` | the cached profiles, with their sample sizes |
| `GET /api/leagues/:id/bench` | what each bench slot earns, and the drop candidates |
| `GET /api/leagues/:id/trades/ladder?playerId=` | opening / fair / do-not-exceed for one target, plus the consolidation read |

The two refresh routes are writes and are rate limited beside the Vegas one. The
work `strategy/refresh` does also runs on the 09:00 UTC cron for the selected
league, because the trending list and a current week's transactions are the two
things in this app that **cannot be reconstructed after the fact**: Sleeper keeps
no trending history, and its transaction endpoint has no all-weeks form. Manager
profiles are not on any clock — they change perhaps once a season.

## Safety invariants

- No endpoint writes to Sleeper. There is no pick, lineup, waiver, bid or trade
  mutation path, and a test asserts those routes 404.
- The strategy layer advises and never acts. Bids are numbers on a card, trade
  ladders carry `advisory: 'never auto-sent'`, and every transaction in this app
  happens in Sleeper, by hand, on purpose.
- No unpublished budget is ever assumed. A league that does not say what its
  waiver budget is gets a sentence, not a dollar figure.
- No paid AI dependency at runtime; the only runtime dependencies are `react`
  and `react-dom`.
- Secrets stay server-side; the sportsbook key never reaches the browser.
- Auth is a passphrase plus an HMAC-signed HttpOnly/Secure/SameSite cookie, with
  constant-time comparison and a login rate limit.
