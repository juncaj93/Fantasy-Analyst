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
    xfp/       expected points from opportunity, and the gap to what happened
    schedule/  role-specific schedule strength, weeks ahead
    value/     this-week and next-four-week player value
    grading/   recommendation ledger, counterfactual grading, weekly self-grade
    support/   capture a decision's inputs and output, redact it, replay it
    contracts/ the versioned surface all of the above is consumed through
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

Injected dependencies buy more than testability, and `core/support/` is where
that becomes obvious. Because `buildDraftBoard` receives every fact it knows
through one interface — `DraftBoardSources`, which the server fills from D1,
Demo Mode fills from fixtures, and a support snapshot fills from a file — a
capture can be a *recording proxy* around that interface rather than a
hand-maintained list of "the inputs", and a replay can be the same board
assembly over `Map`s. Completeness is then structural: a source the board calls
is a source the snapshot has.

The in-season surfaces are captured the same way where they have an interface —
`MatchupSources`, `DstPlanSources` — and through their normalised input where
they do not. The lineup, the wire and the trade search are handed a
`StartSitInput[]` that one service assembles, so *that value* is the seam, and
capturing it captures every field rather than the calls one request happened to
make. Each then replays through the same assembly its screen calls, which is why
`assembleLineup`, `assembleWaiverPlan` and `assembleSmartTrades` were extracted
out of the routes and out of Demo Mode's handlers: one pipeline per decision,
three callers of it. See [SUPPORT_SNAPSHOT.md](SUPPORT_SNAPSHOT.md).

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
- Recency windows (7d / 30d / season-to-date) are computed from `source_date`;
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

## Advanced intelligence layer

A second tier of `core/` sits beside the engines rather than inside them:
expected points from opportunity (`xfp/`), the injury-beneficiary graph, decision
boundaries for close calls, mode suggestion, role-specific schedule strength
(`schedule/`), multi-week value (`value/`), contingency lineups, fragility,
bench optionality, streaming, and the self-grading ledger (`grading/`).

Two rules hold the layer together and both are enforced in code rather than
promised in prose. **Nothing here enters a lineup score** unless it is named as
doing so — `assessXfp` returns `points: 0`, `assessFragility` returns
`projectionEffect: 0`, and `assessOptionality` has no points field at all, so a
caller cannot add roster-management value to a projection by accident. And
**everything is consumed through one versioned envelope**,
`core/contracts/channel3.ts`, where absence is `null` rather than zero and
confidence and freshness travel with the numbers.

Where a question was already answered somewhere in the app, the answer is reused
rather than reimplemented: the contingency plans are real `recommendLineup`
calls with the clock moved, the schedule outlook is `assessMatchup` applied
forward, and the decision boundaries bisect the actual `evaluatePlayer`. Full
detail in [docs/PLAYER_AND_LINEUP_INTELLIGENCE.md](PLAYER_AND_LINEUP_INTELLIGENCE.md).

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

## The fetch boundary

`fetch` resolves for every answer that arrived, including the ones that are not
this app's. The client used to read each body and call `JSON.parse` on it before
looking at the status or the content-type, so a page where a payload should have
been reached the user as the parser's own complaint — on JavaScriptCore, which is
every iPhone, `JSON Parse error: Unrecognized token '<'`. Every screen renders
`err.message` verbatim, so that sentence was the whole of what a person saw, and
because the parser quotes what it failed on it was also a small leak of the page.

There are at least three ways to be handed markup on an `/api/` path with nothing
in this repository being wrong at the time: the Worker throws or exhausts CPU and
Cloudflare answers with its own `Error 1101` page; an edge or proxy layer answers
with a 502/503/504 interstitial while the origin is cold or mid-deploy; or the
static-asset router answers before the Worker and the single-page-application
fallback returns `index.html` — **status 200**, `text/html`, and the API never
ran. `run_worker_first = ["/api/*"]` in `wrangler.toml` is the line that prevents
the third, and therefore the line whose absence causes it.

`src/web/apiResponse.ts` is the contract, and it is one rule: **the status and
the content-type are read before the body is parsed, and a body that is not JSON
is never handed to the parser.** What comes back instead is an `ApiError`
carrying the method, the endpoint, the status, what kind of answer arrived
(`json` / `html` / `text` / `empty`), which family of failure it is (`auth` /
`client` / `server` / `protocol` / `network`), whether asking again could
plausibly help, Cloudflare's ray id, and a bounded, tag-stripped prefix of the
body for diagnosis.

`protocol` is worth naming separately: the request completed, the status may even
be 200, and the thing that answered was not the API — a 500 means this app's code
failed, a protocol failure means this app's code never ran.

Three properties the contract is careful about:

- **Auth stays auth.** A 401 that arrives as a sign-in page is still a 401, is
  classified from the status rather than from the body, and is never retryable.
  Softening one into "try again" turns a locked session into a spinner that can
  never resolve. A JSON refusal keeps the server's own words, because the server
  writes better copy about its own refusals than anything general could.
- **Nothing is swallowed.** Every failure leaves as a rejection.
  `retryable` is a fact offered to whoever owns the retry policy — the draft
  refresh controller's backoff, or the reader's pull-to-refresh — not a retry
  performed at the seam. Nothing returns `null` on failure: a resolved `null`
  would be stored by the session cache as though the server had said so, which is
  how a transient edge page becomes a screen that is confidently empty.
- **The body never reaches the glass.** The message is the sentence a person
  reads and nothing else — four of them, chosen by what happened and by whether
  the request was a read or a write. The prefix travels beside the message, in a
  field screens do not render.

The API side keeps the matching half: **every answer to an `/api/` request is
JSON, including the ones nobody meant to send.** The router runs its middleware
inside the same guard as its handlers (an exception from `verifySession` used to
escape the Worker and be answered by Cloudflare in HTML), and `worker/index.ts`
wraps the whole `/api/` dispatch for anything thrown before the router exists.
Client hardening is still required regardless, because the layers above the
Worker are not ours.

Guarded by `tests/api.errors.test.ts` (the response matrix),
`tests/api.jsonContract.test.ts` (the server's half) and
`e2e/api-error-resilience.spec.ts`, which injects production-shaped HTML answers
at the route and asserts that no parser wording, no markup and no fragment of a
body ever reaches the rendered UI.

## Same-session response cache

Tabs are mounted as `{tab === 'draft' ? <DraftScreen/> : null}`, so leaving one
destroys the screen and every piece of state it held. Each screen fetched on
mount and rendered nothing until the response landed, which meant a *revisit*
cost a full round trip of blank screen — measured on the seeded league with a
fixed delay added to every `/api/` call:

| revisit | +0 ms | +250 ms | +600 ms |
| --- | --- | --- | --- |
| Team → Draft | 25 ms | 276 ms | 626 ms |
| Draft → Team | 26 ms | 276 ms | 627 ms |
| Team → Players | 244 ms | 494 ms | 843 ms |

The tab itself lit up in 3–11 ms every time. All of the delay was between the tab
lighting up and there being anything to look at, it scaled exactly with the round
trip, and the request count per revisit was fixed — a caching problem, not a slow
query. `src/web/sessionCache.ts` makes `api.get` stale-while-revalidate: a repeat
read resolves in the same microtask with what the app last saw, revalidates
behind it, and calls the caller's `onFresh` only if the answer moved. Those
revisits are now 9–17 ms at any latency.

**It caches responses, not decisions.** Nothing in it scores, ranks or projects
anything; every number still comes from the server. It is a `Map` and does not
survive a reload — persistence for the Draft board is `offlineCache.ts`'s job,
with its own schema, age limit and "this is a capture" banner, and two caches
disagreeing about the last known board would be worse than one round trip.

Writes empty it, since a write is the one thing that can change a held answer
without it hearing. The single exception is the draft refresh controller's sync,
which is a poll wearing a POST's clothes: emptying the whole cache every few
seconds would mean no other tab could hold anything during a draft, and what that
sync changes — the board — is re-read with `fresh: true` in the same beat.
Demo worlds are handled by dropping everything when the world changes, because
two scenarios share a league id.

Guarded by `tests/sessionCache.test.ts` and `e2e/tab-revisit.spec.ts`. The e2e
tests assert the structural property — content is on screen while the request
that would have produced it is still being held open — rather than a wall-clock
number, which a shared runner cannot be trusted with. `scripts/measure-tabs.mjs`
is the diagnostic that produced the table above.

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

**Player portraits are the opposite decision, on purpose.** They are hot-linked
from Sleeper's CDN rather than bundled, and the section below sets out why the
four reasons above do not carry across to them — chiefly that a club mark is
information the row needs and a portrait is not. The two are meant to be read
together, so neither reads as an accident.

## Player portraits

The one place in this app that hot-links a third party's images, and the section
above is the argument it has to answer: club marks are **bundled**, deliberately,
for four reasons that all still hold. Portraits are the opposite decision on
purpose, and the difference between the two cases is what justifies it.

`src/core/players/headshot.ts` answers "does this player have a face, and what is
its URL" and nothing else. Screens reach it through the `PlayerFace` primitive in
`src/web/components/common.tsx`, exactly as they reach `nflTeamLogoUrl` through
`TeamLogo` — no component builds the string itself. Screens do not reach
`PlayerFace` directly either: every focused surface renders `PlayerSheetTitle`,
the one header in the app that draws a player as a heading, so the portrait's
size and loading behaviour are also decided in a single place.

### The URL is a convention, not a contract

    https://sleepercdn.com/content/nfl/players/{player_id}.jpg

Sleeper's player dictionary carries **no image field**. The path is the one
Sleeper's own clients use, and it was established here empirically rather than
from documentation. A local probe of 91 players measured:

| | |
|---|---|
| resolved | 80 of 91 (88%) |
| distinct portraits | 78 (86%) |
| stars / starters / backups / rookies / kickers / PUP-NFI | 100% distinct within each group |
| redirects | none |
| format | JPEG, dominant size 350×254 |
| median weight | ~30 kB full, ~23 kB thumb variant |
| cache policy | `public, max-age=2678400` (31 days), Cloudflare `HIT` |

Nothing published promises any of that keeps working. That is why the helper
returns `string | null`, why the component treats a failed load as an ordinary
outcome rather than an error, and why no screen's content depends on one
arriving.

The thumb variant is **not** used. It saves roughly 7 kB on an asset the browser
caches for a month, on one image per opened card, in exchange for a second path
that can rot independently of the first. The canonical path is simpler and the
saving is not real at this volume.

### Why hot-linking is right here and wrong for club marks

The four reasons the marks are bundled were: the PWA keeps working offline, there
is no third-party runtime dependency, coverage is a fact a test can check against
the filesystem, and the marks can be seen in local visual QA. Every one of them
is about something the app **needs**. A portrait is not needed — it is identity
polish, and the fallback below makes its absence a non-event — so each reason
weighs differently:

* **offline** — a missing portrait offline is initials, which is the same thing a
  missing portrait online is. A missing club mark was a missing club.
* **third-party dependency** — real, and contained: it degrades to initials
  rather than to a broken screen, and it cannot take a request path with it
  because there is no request path (below).
* **coverage as a fact** — there is no filesystem to check. 88% was measured
  once and is not asserted anywhere, because it is Sleeper's number to change.
* **local visual QA** — genuinely lost, and paid for. See the note on the stand-in
  image in `e2e/player-face.spec.ts`.

Against that, hot-linking buys one thing bundling cannot: **the player lifecycle
is free**. A rookie with no portrait today gets initials; the day Sleeper adds
one, the same URL starts resolving and he has a face, with no sync job, no
re-vendoring, no image administration and no deploy. A vendored set of ~2,000
active players would need a pipeline, a refresh policy and an annual rookie pass —
and would be stale between them. There is no annual workflow here at all: the
existing Sleeper player sync supplies the ids, and a club change does not touch
image identity because the id is the identity.

If the convention becomes unreliable, two exits are open and neither is urgent:
fall back permanently (delete one component; every surface already renders
correctly without it), or vendor active-player assets the way the marks are
vendored, at which point only `playerHeadshotUrl` changes.

### The runtime-cost invariant

The expected path is:

    browser → sleepercdn.com

and never:

    browser → Junculator Worker → Sleeper

No API route, no Worker `fetch` that touches the host, no D1/KV/R2 dependency,
and no change to the number of requests this app's own API serves when a reader
looks at a player. The incremental Cloudflare cost of the feature is therefore
effectively **zero** — a direct image load is not a Worker subrequest. This is
asserted rather than asserted-in-prose: `tests/playerHeadshotSurfaces.test.ts`
fails if any server or Worker module names the host, if the router grows a
headshot route, if a migration stores an image, or if a storage binding appears.

### Failure is the normal case, not the exception

Twelve percent of probed players had no portrait, so this path runs constantly:

* a 403, a 404, a network error and an offline first paint all end at
  deterministic initials from the display name;
* in the **same box** — same square, same circle, same ground — so nothing on the
  page moves and a screen of mixed coverage keeps one column;
* no retry, no toast, no banner, no error copy, no repeated logging, and no
  broken-image chrome: the `<img>` is unmounted the instant it errors;
* the failure is remembered **per URL**, at module scope, so one player's missing
  portrait cannot blank out the next player drawn into the same reused component
  instance, and a portrait already known to be missing is not re-requested when
  the reader reopens that player.

The fallback is initials and never a silhouette — a generic head is a picture of
someone who is not this player — and never the club's mark, which is already on
the line beside it.

### Where portraits are drawn, and where they are not

The rule is one sentence: **dense lists stay image-free, and a view of one
player gets his face.** Everything below is that rule applied, plus the two
places where applying it cost a measurement.

**Drawn**, at 64px, loaded eagerly, on every surface where the reader has
committed to a single player:

| surface | reached from | implementation |
|---|---|---|
| shared player card / page | Players, Smart Trades | `PlayerSheetTitle` |
| weekly card | Team (a starter or bench player), Matchup (a lineup row) | `PlayerSheetTitle` |
| waiver detail | Team (a waiver upgrade), Waivers (the board) | `PlayerSheetTitle` |

Six routes, one implementation. `PlayerSheetTitle` in
`src/web/components/common.tsx` is the only thing in this app that renders
`PlayerFace`, so the size, the eager load, the empty `alt`, the defence
exclusion and the initials fallback are decided once. That is enforced rather
than intended: `tests/playerHeadshotSurfaces.test.ts` fails if a second file
renders a face, and fails if one of the three focused files stops rendering the
shared header. A seventh surface gets a portrait by calling the header, and a
dense list cannot get one by accident because a list has no header to put it in.

The header is also where the identity marks now live on the weekly card and the
waiver detail. Both used to print the position pill and the club as the first
line of their *body*, above the verdict; that line is gone, because the header
above it now carries the same two marks beside the name. The card is not taller
and does not say anything twice.

Availability is deliberately **not** repeated in those two headers. The shared
card has a clean Sleeper designation and shows the code; the weekly card and the
waiver detail carry availability as a phrase — `Questionable · hamstring ·
limited → full` — already printed in words on a line of their own body, and
abbreviating the same fact to `Q` two centimetres above it would be one card
speaking two vocabularies.

**Not drawn**, by decision rather than by omission: Matchup's mirrored lineup
rows, the draft board, the waivers list, the Players index, Team's roster rows,
and the compact Smart Trades rows. The read-only discovery quantified the worst
of these — on Matchup at 390px the name column falls from about 85px to about
60px — and a shortened name is information lost in exchange for decoration.
`tests/playerHeadshotSurfaces.test.ts` names these files and fails if one grows a
face; `e2e/player-face.spec.ts` and `e2e/player-face-focused.spec.ts` check the
running app never requests a portrait from a list, on the same page load that
proves the sheet it opens requests exactly one.

The Smart Trades **offer** sheet is image-free for a different reason: it is not
about one player. A trade has two sides and several names on each, and a grid of
faces there would be decoration competing with the one thing the sheet is for.
Trades reaches a portrait the same way Players does — by opening a player.

**Deferred, by measurement:** Team's compact rows. The discovery expected a 28px
face to fit inside the 44px row, and the row height does hold — but a measured
prototype at all four widths introduced name truncation at 390 (`Cal Whitfield`,
28px short, from none), 375 (3px → 43px) and 360 (18px → 58px), and left the
identity column of a populated slot indented 32px from the empty slots above it.
Two of the gate's conditions fail. Team keeps its bundled club mark and no
portrait on the row — and gets the face in the card that row opens.

**Ruled out, by measurement:** Draft's expanded player card. It is the one
expanded player detail in the app that is not a sheet — it unfolds *inside* the
board, and it is budgeted at about two and a half collapsed rows precisely so the
board it opened from stays on screen. Both placements were prototyped and
measured at 360 and 390:

* **beside the content** — the working (`Sleeper ADP · DOG ADP · Pick · Val`,
  which the card is arranged to keep on one line at 360px) wraps from 15px to
  31px on four of five seeded cards. At 64px and at 40px alike: no face size that
  is worth drawing leaves the line intact.
* **above the content** — about 30px on a card whose ceiling has about 36px left.

The widest seeded card goes from 2.53× a collapsed row to 2.80×, against a
ceiling of 3× that `e2e/draft-card.spec.ts` enforces. The feature's own rule is
that decision content wins when 64px will not fit cleanly, so Draft keeps the
club mark, the status tag, the star and the whole of its working, and no face.
Draft is the one surface named in the rollout that did not ship one, and it is on
the protected list with those numbers attached.

### The focused header, and what the portrait changed about it

A 64px portrait makes a sheet's header 64px tall whatever else is on it. On the
single identity line the header used to have — pill, club, name, status — that
was expensive rather than free: the line carried about twenty pixels of slack and
the face wanted sixty-eight, so at 360px it truncated nineteen of twenty-two
seeded names, `Julian Reyes` down to `Julian…`, where none truncated before. No
size was free; even a 40px face cost ten names.

The height the portrait already costs is now spent instead of wasted. The name
takes a line of its own beside the face and the marks that qualify him — pill,
club, status — take the line under it. That is the arrangement `PlayerPage`
already uses for the same player in a navigation bar (`.nav-title` over
`.nav-subtitle`), so every surface where a player is a *heading* reads the same
way — and since they all render `PlayerSheetTitle`, that is a fact about one
component rather than a convention four files are trusted to keep. Every **list**
is untouched: pill → club → name still reads across one line
on Draft, Players, Trades and Waivers, which is the situation that rule was
written for — making forty names start on one column. A header has one name in
it. At 430, 390, 375 and 360, no name truncates.

### Security and privacy

There is no CSP in this repository, and this feature does not add one — a
security layer is not something to introduce as a side effect of an image. If one
is added later, `https://sleepercdn.com` needs to be in `img-src` and nothing
else.

Nothing but a numeric Sleeper player id ever reaches the URL: no user, league,
auth or session value, no query string, no fragment. And there is no fuzzy
matching and no name-derived path, because a portrait keyed on a name draws the
wrong person the first time two players share one, and a confident wrong face is
worse than no face.

**A defence is excluded twice, on purpose.** Live Sleeper keys team defences by
the club abbreviation — `CHI` is a real `player_id` — so the numeric rule alone
already covers production data. That is the incidental version of the rule and
it is not enough: this repository's own demo seed keys its three defences
numerically (`1030` is Jacksonville), so the id shape is a convention of the
*source* rather than a fact about defences. `playerHeadshotUrl` therefore takes
the position too, and refuses `DEF` whatever the id looks like. A rule that
holds only because one provider happens to format its keys a certain way is a
rule waiting to be broken by a fixture — and that fixture is already in the
tree. Both shapes are exercised in `e2e/player-face.spec.ts`.

### Performance

The perf budgets govern JS, CSS and HTML — this repository's own bytes — and
deliberately do not grow a media-budget system for one image. What holds instead:

* text and data render independently of image completion; nothing awaits a
  portrait;
* the box is fixed by `--face` and by the `width`/`height` attributes, so CLS
  from a portrait is structurally zero;
* no prefetch of the roster or the player pool, no background batch loading, no
  service worker;
* dense lists stay image-free (above), so nothing eager-loads across a large
  result set — `tests/playerHeadshotSurfaces.test.ts` asserts the shared focused
  header is the only eager loader, and it draws one image for the one player the
  reader opened;
* repeat visits are the browser's HTTP cache, at Sleeper's 31-day `max-age`.

## Season as data

Nothing hardcodes a year, and nothing derives one from the calendar if it can
avoid it. `core/season/context.ts` is the single authority and answers on a
ladder: Sleeper's `/state/nfl` first, the selected league second, the calendar
last and marked `assumed`. Four services used to carry the same
`month >= 2 ? year : year - 1` expression privately; they now delegate to one
implementation and use it only as a fallback, with callers that can reach the
database passing the authoritative answer in.

What the resolver deliberately will **not** do is infer the season from stored
data. That is the rollover failure mode: with no current-season feed published,
the newest rows in every table belong to last season, and a "newest wins" rule
would promote them to current truth on the first Sunday of the new year.

Four modules sit on top of it:

- `lifecycle.ts` — eight deterministic states (offseason, preseason, draft-open,
  draft-live, post-draft, regular season, playoffs, season complete), all read
  off provider fields rather than dates. A live draft outranks every other
  witness, because Sleeper flips `season_type` to `regular` before week one and
  leagues that draft late are still drafting when it does.
- `keys.ts` — season-first cache keys, so Week 3 2026 and Week 3 2027 are
  structurally different, and readable back, so a rollover sweep knows what it
  is deleting and leaves alone what it does not recognise.
- `rollover.ts` — the carry-forward/reset table (behavioural signals about
  people decay; anything about *this season* is rebuilt) and successor-league
  discovery, which takes Sleeper's own `previous_league_id` silently and only
  ever *proposes* a name/size/scoring match.
- `readiness.ts` — grades each source against the current season by name, with
  `waiting` (not published yet, and not expected to be) kept distinct from
  `stale` (published, wrong season) and `failed`. Served at
  `GET /api/diagnostics/rollover`.

`core/search/players.ts` is the one player matcher every search field shares,
built on the identity layer's normalizer so a name means the same thing to the
search box as to the resolver. Results are ranked — exact, prefix, word-prefix,
substring, then typo — and the board's own order breaks ties within a tier, so
search never re-ranks the board by string similarity.

Both are structurally prevented from touching football logic; see
`tests/infrastructureIsolation.test.ts`, which asserts the import graph in both
directions.
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

## Live matchup (`core/matchup/`)

The post-draft head-to-head. One rule shapes the whole module: **Sleeper owns
the score, and this owns the forecast.**

The section numbers these modules cite in their comments — `§6`, `§8`, `§14`,
`§33` — are the Matchup brief's, preserved verbatim at
[docs/brief/09_MATCHUP.md](brief/09_MATCHUP.md).

Sleeper's `/league/{id}/matchups/{week}` is the authority for the pairing, the
lineups, the slot each starter fills and every points figure, and none of it is
recomputed. That payload also carries Sleeper's own projection, which is read
nowhere in this app — a number labelled as Fantasy Analyst's that came from
Sleeper would be the most misleading thing the feature could do.

Everything else is built from the start/sit engine every other screen uses, with
exactly one adjustment: the availability component is subtracted out of a
player's score before it becomes a projection. The engine prices a Questionable
designation as points off; this model prices the same fact as a branch. Leaving
both in charges it twice.

| module | what it owns |
| --- | --- |
| `distribution.ts` | the shape of what is still to come, per player |
| `correlation.ts` | who moves with whom, as factor loadings |
| `simulate.ts` | four thousand afternoons, seeded from the state |
| `needs.ts` | leverage in win probability, and the thresholds it implies |
| `decision.ts` | which legal lineup wins *this* matchup |
| `insights.ts` | the one card that says what matters right now |
| `fingerprint.ts` | the string that both seeds and caches |
| `names.ts` | `J. Hurts`, and what to do when two of them are on screen |
| `model.ts` | the assembly, and the degraded path |

**Three game states, three questions.** Not started carries the full pregame
distribution. Live carries what is *left*, conditioned on points already banked
and how much of the game is gone — a blend that leans further on observed pace
the deeper into the game it is, capped so a quiet first half cannot erase a
projection. Finished carries nothing at all: actual points are truth, the player
is never drawn for, and a matchup where everything is final says 100% rather
than 94%.

**Distributions are lognormal**, parameterised by mean and coefficient of
variation so the mean is *exactly* the projection the rest of the app shows.
Fantasy scoring is non-negative, right-skewed and unbounded above; a normal
puts real probability below zero and none in the tail that matters, and
truncating one at zero silently inflates every projected total.

**Correlation is a factor model, not a matrix.** Rules written one pair at a
time do not produce a positive semi-definite matrix, and a matrix that cannot be
factored cannot be sampled from — the failure is a `NaN` win probability on a
Sunday afternoon. Loadings on a per-club factor, a per-fixture factor and a
per-club-and-position competition factor produce a consistent structure by
construction, and every implied correlation is asserted under 0.45.

**The simulation is seeded from a fingerprint of the matchup state**, and that
same string is the cache key. A state cannot move one without invalidating the
other. Every player is drawn — starters and bench alike — and every draw is
kept, which is what makes a lineup counterfactual an exact difference over the
same afternoons rather than the difference between two noisy estimates.

**Degraded is a first-class outcome.** If either side has fewer than half its
starters projectable, there is no honest forecast to print: the scoreboard
stays, the card says the forecast is unavailable, and nothing is substituted.

**The mode suggestion is carried, not formed.** Floor / Balanced / Ceiling is
answered once in the app, by `core/startsit/modeSuggest.ts`, off market points;
the matchup service calls that module and passes the answer through the forecast
untouched. The matchup model never sees the question, which is why the
circularity guard in that file stays structural: the one number that could make
the mode depend on the lineup — the simulated win probability — is produced
after the suggestion and cannot reach it.

**Calibration is written on a clock, and the screen is a pure read.**
`matchup_forecasts` holds one row per roster per week — the first forecast
written once and never updated, the latest one moving with the afternoon, the
outcome filled in when the week settles. Keyed by season and week, stamped with
the model version. A live win probability is a function of a Sunday that stops
being obtainable the moment the games end; if nobody writes it down at the time,
"is 70% actually 70%" is unanswerable forever rather than merely hard.

The writer is the worker's `scheduled()` handler — a capture on the daily 09:00
tick and on the two weekend ticks, and a settlement pass that closes out any
week the season has moved past, reading the final scores from Sleeper rather
than simulating them. `GET /api/leagues/:id/matchup` writes nothing at all.

It used to. The final comprehensive audit's F-01 found the ledger being written
from inside that GET, which was wrong twice over. The auditable half: both write
guards classify a request by its method, so a hidden write behind a `GET` is
invisible to the passphrase check *and* to the Demo Mode check — a demo browser
was writing rows to the live calibration table by opening a screen. The quieter
half: it made the calibration sample a function of browsing. `first_phase`
recorded when somebody first *looked*, so a week nobody opened before kickoff
produced no pregame sample at all, and settlement only happened if a request
landed in the few hours between the last whistle and Sleeper rolling the week
over. A cron looks every day whether or not anybody does, which is what makes
`first_phase = 'pregame'` mean what the calibration report says it means.

### Endpoints

| route | what it does |
| --- | --- |
| `GET /api/leagues/:id/waivers` | upgrades, now with the bid, the opportunity cost and the market line per candidate |
| `POST /api/leagues/:id/strategy/refresh` | fetch missing transaction weeks and capture the trending list; rate limited |
| `POST /api/leagues/:id/managers/refresh` | walk the previous-league chain and rebuild every manager profile |
| `GET /api/leagues/:id/managers` | the cached profiles, with their sample sizes |
| `GET /api/leagues/:id/bench` | what each bench slot earns, and the drop candidates |
| `GET /api/leagues/:id/trades/ladder?playerId=` | opening / fair / do-not-exceed for one target, plus the consolidation read |
| `GET /api/leagues/:id/matchup[?week=]` | the week's head-to-head, with the forecast over it |
| `GET /api/diagnostics/matchup-calibration` | how the win probability has actually held up, in ten-point bands |

The two refresh routes are writes and are rate limited beside the Vegas one. The
work `strategy/refresh` does also runs on the 09:00 UTC cron for the selected
league, because the trending list and a current week's transactions are the two
things in this app that **cannot be reconstructed after the fact**: Sleeper keeps
no trending history, and its transaction endpoint has no all-weeks form. Manager
profiles are not on any clock — they change perhaps once a season.

## Safety invariants

- No endpoint writes to Sleeper. There is no pick, lineup, waiver, bid or trade
  mutation path, and a test asserts those routes 404.
- Matchup advises and never acts. It reports what a lineup change would be
  worth in win probability and there is no path by which it sets one.
- Sleeper's own projection is never read. `custom_points` arrives on the
  matchup payload and is ignored; every projected number on that screen is
  this app's, or absent.
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
- The offline board cache is read-only about draft state. It stores what the
  server sent and hands it back; it never composes a pick, and a cached board is
  always rendered as a capture with its age. A test asserts the module has no
  vocabulary for picks, rosters or fetching.
- Page weight and free-tier resource use are budgeted and enforced in CI. See
  [docs/BUDGETS.md](BUDGETS.md).
