# Handoff — Fantasy Analyst

Written at the end of the session of 2026-08-13. Read this first, then
`docs/brief/` for standing product rules.

Live: <https://fantasy-analyst.juncaj93.workers.dev>
`main` is deployed, green, and in sync. Nothing is half-finished.

---

## Start here

Three specs are queued, in the scratchpad of the previous session and re-listed
below. The user's instruction was: **do the tally-magnitude fix first, then run
the follow-on program (Phase 1 Decision Quality, then Phase 2 Visual
Refinement).** They expect to be away and do not want routine interruptions.

1. `FANTASY_ANALYST_UNIFIED_AUTONOMOUS_MASTER.md` — the umbrella brief. Phases A
   and C are still outstanding (see below).
2. `FANTASY_ANALYST_PLAYER_IDENTITY_REPAIR_BACKFILL.md` — mostly delivered; the
   auto-resolution and reconciliation-page parts are not.
3. `FANTASY_ANALYST_AUTONOMOUS_FOLLOW_ON_PROGRAM.md` — the queued two-phase
   package. Its steps 1–6 (finish and merge current work) are already satisfied.

If those files are gone, ask the user to re-upload; do not reconstruct them from
this document.

---

## The one decision that is already made

**Preserve a tally row's score as written; keep newsletter sentences at ±1.**

The user agreed to this explicitly. Do it before Phase 1.

### Why it matters

`src/core/newsletter/classify.ts` currently caps magnitude at `0 | 1` — "one
item counts once". That is right for a newsletter sentence: an emphatic mention
should not count triple. It is wrong for the imported tally file, where a row
already carries an aggregate score.

Consequences visible in production right now:

- the tally file says `JSN +11`; Jaxon Smith-Njigba's lifetime tally is `+1`
- Phase 1 specifies an **AVOID tag at lifetime tally ≤ −5**, which under the
  current flattening is unreachable — no player can get there

### What to change

- teach the tally importer (`src/core/newsletter/tally.ts`) to carry the row's
  score through as magnitude instead of collapsing it to ±1
- leave `classify.ts` alone — sentence-level scoring stays at ±1
- re-import `data/imports/2026-08-13-tally-r1-r4.md` via the existing
  `import-tally.yml` workflow; the import is idempotent on document + score, so
  check whether the changed magnitudes produce new dedupe keys or collide with
  the existing rows, and clear the old snapshot if they collide
- re-check the six repaired names afterwards with
  `scripts/probe-tally-gaps.mjs` (run via the `probe.yml` workflow)

Expect every player's numbers to move. That is intended.

---

## What is done and live

| area | state |
|---|---|
| Draft ADP | Sleeper ADP in the league's format, refreshed daily (`refresh-adp.yml`, 11:00 UTC) |
| Draft news weighting | lifetime 0.35 / 30d 0.20 / 7d 0.12, calibrated to move ~10 places on a close market |
| Live draft roster | Team + Draft share one reconstruction from the pick stream |
| Help My Scores | groups unresolved names, one tap assigns and creates evidence |
| Tally backfill | recovered 6 stranded items; `backfill-tallies.yml`, idempotent |
| Trades | Phase D complete, evidence-ledger only |
| Newsletter intake | accepts **every** sender at `fantasy-news@juncaj.net` |

Outstanding from the master brief: **Phase A** (Vegas, weather, usage, source
freshness) and **Phase C** (Start/Sit depth). Phase B and D are done.

---

## Vegas — key is ready, adapter is not

`SPORTSGAMEODDS_API_KEY` is in repo secrets. The user added it; it has never been
used.

Provider comparison was run (`scripts/probe-vegas-providers.mjs`):

- **SharpAPI** — not an odds provider at all; no NFL player props. Rejected.
- **SportsGameOdds** — free "Amateur" plan, 2,500 objects/month, 10 req/min,
  player props included, no card. **Chosen.**
- **The Odds API** — free tier 500 credits/month, 126 documented `player_*`
  markets. Fallback if the object accounting proves too tight in practice.

The existing `VegasProvider` abstraction and `MockVegasProvider` are the seam to
build against. `wrangler.toml` carries `VEGAS_PROVIDER = "mock"`.

---

## Traps this session already fell into

Read these before touching the same ground.

**Sleeper publishes no ADP.** Confirmed by full GraphQL introspection (~240
query fields, none for ADP; the `Player` type's 41 fields carry no draft
position) and by REST paths tried against the real draft id. Its schema is
snake_cased — `__Schema.query_type`, not `queryType` — which made introspection
look disabled when it was not. ADP comes from beatadp.com's `SLEEPER` column via
`refresh-adp.yml`. Do not re-litigate this without new evidence.

**`search_rank` is not ADP.** It ranks by who gets looked up. Using it put Drake
Maye at 7 and retired players on the board. It is named `searchRank` now and is
only a search tie-break.

**D1 caps bound parameters at 100.** `MAX_BOUND_PARAMS = 90` in
`src/server/db.ts`. Any new batched query must chunk.

**The Setup screen is layout-fragile.** Two separate bugs there in one day: a
tab bar hardcoded to `repeat(5, 1fr)` that wrapped when a sixth tab arrived, and
a panel that intercepts pointer events on its own contents when it grows. The
second is **unfixed** — I worked around it by not clicking the control in a
browser test. If a third change there misbehaves, investigate the panel
structure properly rather than working around it again.

**The e2e suite shares one dev server across three browser projects.** Tests
that mutate global config (the newsletter sender especially) break later tests
in the same file. Prefer asserting presence over flipping shared state, or give
the test its own fixture.

**WebKit is not installed in this container** and the environment forbids
installing it. `npm run e2e` fails; use `npm run e2e:chromium`. Run it with
`CI=1` so Playwright starts a fresh server instead of reusing a polluted one.

---

## Verification

```bash
npm run typecheck          # tsc
npx vitest run             # 559 tests
CI=1 npm run e2e:chromium  # 121 tests at 390/375/360
npm run build
npx wrangler deploy --dry-run
```

Deployment is automatic on push to `main` (`deploy.yml`), which also applies D1
migrations. The sandbox cannot reach Cloudflare or most of the internet — use
the workflows in `.github/workflows/` as the network proxy:

- `investigate.yml` — reads live app state, ADP source, board contents
- `probe.yml` — runs one `scripts/probe-*.mjs` and prints only that
- `refresh-adp.yml`, `import-tally.yml`, `backfill-tallies.yml` — the operations

`actions_list` responses are enormous; parse the saved JSON with `python3`
rather than reading them inline, and prefer `probe.yml` over `investigate.yml`
when you want one answer.

---

## Standing rules that outrank convenience

From the user, verbatim in spirit:

- never commit or expose credentials, tokens, or account-recovery information
- no paid services, no credit card
- Sleeper is the source of truth for league, roster, scoring, draft state
- the evidence ledger is truth; tallies are derived and rebuildable
- unknown stays unknown — never invent a value
- never draft, never write a lineup to Sleeper
- deterministic and explainable: every recommendation shows its components
- one action at a time when the user is genuinely needed, dummy-proofed, then stop

The user merges on request and has been happy with autonomous work landing on
`main`, but the follow-on program says to integrate cleanly per phase — so
branch per phase, verify, then merge.
