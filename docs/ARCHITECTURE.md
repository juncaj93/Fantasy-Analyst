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

## Safety invariants

- No endpoint writes to Sleeper. There is no pick or lineup mutation path, and a
  test asserts those routes 404.
- No paid AI dependency at runtime; the only runtime dependencies are `react`
  and `react-dom`.
- Secrets stay server-side; the sportsbook key never reaches the browser.
- Auth is a passphrase plus an HMAC-signed HttpOnly/Secure/SameSite cookie, with
  constant-time comparison and a login rate limit.
