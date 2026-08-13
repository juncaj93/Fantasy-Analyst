# Status

## Milestone 1 — foundation (done)

| # | Priority | State |
|---|---|---|
| 1 | Canonical player model | Done — strict matching ladder, aliases, ambiguity → review |
| 2 | Sleeper player sync | Done |
| 3 | League connection + selection | Done |
| 4 | League scoring/settings persistence | Done — derived from Sleeper, not hardcoded |
| 5 | Draft-state model + sync | Done — picks, snake maths, poll backoff |
| 6 | Underdog ADP snapshot import | Done — frozen, hash-idempotent, unresolved rows kept |
| 7 | Evidence/tally schema | Done — ledger is truth, cache derived |
| 8 | Deterministic classification engine | Done — editable rules, negation, mixed, confidence |
| 9 | Newsletter ingestion fixtures | Done |
| 10 | Review data model + UI | Done |
| 11 | Vegas provider interface | Done |
| 12 | Mock Vegas adapter | Done, and the default |
| 13 | Initial Draft Room | Done — full component breakdown |
| 14 | Player Intelligence screen | Done |
| 15 | Automated tests | Done |

## Milestone 2 — merge-ready, non-developer setup, automatic newsletter (done)

**Production hazard fixed.** With Workers Static Assets, the asset router
answers before the Worker; combined with the single-page-application fallback,
every `/api/*` request would have returned `index.html` and the API would never
have run. `wrangler.toml` now sets `run_worker_first = ["/api/*"]`.

**Setup screen.** A fifth tab shows the five areas (Sleeper, League, ADP,
Newsletter, Vegas) with ✅ / ⚠️ / ○ status, a one-line summary and the next
action in plain language. Every setup task that used to require a command or a
hand-written request is now a form on the phone. A test asserts the setup copy
contains no developer vocabulary.

**Newsletter by dedicated address.** The production path is
`fantasy-news@<your-domain>` → Cloudflare Email Routing → the Worker `email()`
handler. No Gmail integration, no personal-inbox access, no manual forwarding.
The address comes from `NEWSLETTER_ADDRESS` (or an in-app override), and the
expected sender is typed into Settings.

**Inbound safety.** Every message is logged with its outcome. Unexpected senders
are quarantined — recorded and visible, never parsed. Oversized bodies are
rejected. Failures are recorded in plain language and change nothing. `email()`
never throws, so mail is never bounced.

**Deduplication hardened.** A quarantined or failed message no longer
fingerprint-blocks a later legitimate delivery of the same newsletter; only a
previously *processed* body does.

**Coverage report.** Each processed newsletter records how many player sentences
produced a signal, how many matched no rule (with examples) and which name-like
words are missing from the player dictionary — the raw material for improving
the rules without an LLM.

**Review upgrades.** Every item shows a plain-language reason. New actions:
reassign to the right player via a search box, and a third tab listing already
applied items so automatic decisions stay inspectable and reversible.

## Verification

```
npm run typecheck             clean
npm test                      384 passed (14 files)
npm run e2e:chromium          100 passed at 390x844, 375x812, 360x800
npm run build                 clean
npx wrangler deploy --dry-run bundles; DB, ASSETS and vars all resolve
```

Secrets scan: no keys, tokens, database files or `.dev.vars` are committed.
`wrangler.toml` contains placeholders and comments only.

## Milestone 3 — deployed (done)

Live at **https://fantasy-analyst.juncaj93.workers.dev**, deployed by GitHub
Actions rather than by hand.

- Pushing to `main` runs the tests, finds or creates the D1 database, applies
  migrations, deploys, stores the passphrase, and verifies the live site.
- On first deploy it also loads the NFL player list (3,303 players) so the app
  is usable immediately. That step is skipped once the list exists.
- Verified against the running site: home page 200, database read 200,
  unauthenticated write correctly refused with 401, login 200, player sync 200.
- Reads are public. Writes require the passphrase.

Deploy-time issue found and fixed: Cloudflare rejects `0` as a cron day-of-week
(`invalid cron string: 0 15 * * 0`), which failed the trigger update after the
Worker had already uploaded. Day names are used now.

## Known limitations

1. **WebKit has still never been executed here.** The sandbox blocks
   Playwright's browser CDN. The WebKit projects are configured and CI runs
   them; locally the identical specs run on Chromium at the three iPhone
   widths. Close this with `npx playwright install webkit && npm run e2e`.
2. **The Odds API adapter remains unverified and disabled.** Free-tier terms,
   NFL prop coverage and market keys could not be checked from here. Vegas shows
   as "not connected" by design and no quota can be consumed.
3. **Email routing has not been exercised end-to-end**, because it needs a real
   domain in Cloudflare. The handler, parser, validation, quarantine and
   idempotency are covered by tests against realistic raw MIME messages.
4. **Rule magnitudes are still conservative** (mostly 1). Expect tuning once
   real newsletters have run through the coverage report.
5. **Draft weights are untuned defaults.**
6. **Survival probability is a heuristic**, labelled as an estimate.
7. **Rate limiting is per-isolate**, not distributed — fine for one user.
8. **Draft polling is client-driven** via the Live toggle.

## Recommended next work

1. **After the first real newsletters arrive**, read the coverage report and add
   the missing phrase families. This is the single highest-value improvement to
   tally quality.
2. **Verify and enable a live Vegas provider**, then confirm the cache keeps a
   full NFL Sunday inside the free tier.
3. **Season-mode lineup view** — slot-aware start/sit across the whole roster at
   once, still recommendation-only.
4. **Reprocess-with-preview** — re-run updated rules over stored newsletters and
   show a diff before committing. The reprocess path already preserves
   overrides; it needs the preview UI.
5. **Draft-weight tuning UI**, so the market-value vs personal-signal balance is
   adjustable without a deploy.
6. **Tier visualisation on the draft board** — the scarcity component already
   computes tier gaps.
