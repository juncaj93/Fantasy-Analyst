# Milestone 1 status

## Built

| # | Priority from the brief | State |
|---|---|---|
| 1 | Canonical player model | Done — strict matching ladder, aliases, ambiguity → review |
| 2 | Sleeper player sync | Done — client, transforms, idempotent upsert |
| 3 | League connection + selection | Done |
| 4 | League scoring/settings persistence | Done — scoring profile and roster shape derived, not hardcoded |
| 5 | Draft-state model + sync | Done — picks, snake maths, status-based poll backoff |
| 6 | Underdog ADP snapshot import | Done — CSV/JSON, frozen, hash-idempotent, unresolved rows kept |
| 7 | Evidence/tally schema | Done — ledger is source of truth, cache derived |
| 8 | Deterministic classification engine | Done — editable rules, negation, mixed, confidence |
| 9 | Newsletter ingestion fixtures | Done — fixture source + fixture-driven tests |
| 10 | Review data model + UI | Done — evidence queue and identity queue |
| 11 | Vegas provider interface | Done |
| 12 | Mock Vegas adapter | Done, and the default |
| 13 | Initial Draft Room | Done — ranked board with full component breakdown |
| 14 | Player Intelligence screen | Done — windows, categories, evidence timeline |
| 15 | Automated tests | Done — 335 unit/integration + 61 browser checks |

## Verification

```
npm run typecheck   clean
npm test            335 passed (11 files)
npm run e2e         WebKit — not runnable in this sandbox (see limitations)
npm run e2e:chromium 61 passed at 390x844, 375x812, 360x800
wrangler deploy --dry-run   bundles, all bindings resolve
```

## Known limitations

1. **WebKit was never executed here.** The Playwright WebKit build could not be
   downloaded (network egress policy blocks the CDN). The WebKit projects are
   configured and CI runs them; locally the identical specs were run on Chromium
   at the three iPhone widths. Run `npx playwright install webkit && npm run e2e`
   on a machine with network access to close this gap.

2. **The Odds API adapter is unverified against the live service.** The vendor's
   domain is also blocked here, so free-tier terms, NFL prop coverage and market
   keys could not be confirmed. The adapter is implemented and unit-tested
   against recorded payload shapes but ships disabled. See `docs/VEGAS.md`.

3. **Live email delivery is not connected.** The interface, parser, classifier,
   persistence, idempotency and review workflow are complete; the transport is
   not. `docs/EMAIL_INGESTION.md` gives the exact wiring steps for Cloudflare
   Email Routing (the worker's `email()` handler is already written), a Gmail
   poller, or an inbound webhook.

4. **Newsletter qualification rejects everything until configured.** The default
   sender pattern is a placeholder, deliberately — unrelated mail must never be
   processed.

5. **Magnitude weights are conservative.** Almost every rule is magnitude 1;
   only explicitly season-altering families (season-ending injury, surgery,
   suspension, named starter, demotion) are 2 or 3, because the brief said not
   to invent magnitude rules. Expect to tune this once real newsletters land.

6. **Draft recommendation weights are untuned defaults.** They encode the stated
   priority (market value dominates; news breaks close calls) but have not been
   validated against a real draft.

7. **Survival probability is a heuristic**, not a fitted model: a logistic curve
   over ADP and pick distance. It is labelled as an estimate in the UI.

8. **No `player_props` freshness per player in the UI.** The Players screen shows
   cached lines but not their age; only the start/sit comparison surfaces
   freshness.

9. **Rate limiting is per-isolate**, held in worker memory. Adequate for a
   single-user private tool; it is not a distributed limiter.

10. **Sleeper draft polling is client-driven.** The Draft screen has a Live
    toggle that polls at the server-recommended interval; there is no background
    sync while the tab is closed.

## Recommended next work package

In order:

1. **Connect real email delivery** (Cloudflare Email Routing is ~30 minutes of
   config plus a redeploy) and run one real newsletter through the review queue.
   This is the highest-value unblock: every downstream signal depends on real
   evidence volume rather than fixtures.
2. **Tune the rule dictionary against real issues.** Add a small "rule coverage"
   report showing how many sentences matched no rule, so gaps are visible.
3. **Verify and enable a live Vegas provider**, then confirm the cache keeps
   Sunday inside the free tier.
4. **Season-mode lineup view**: apply start/sit across every roster slot at once
   (slot-aware, still recommendation-only), instead of pairwise comparison.
5. **Draft-weight tuning UI** exposing the component weights, so the balance
   between market value and personal signal is adjustable without a deploy.
6. **Tier visualisation on the draft board** — the scarcity component already
   computes tier gaps; showing the break points would make the board faster to
   read mid-draft.
7. **Backfill/replay tooling**: reprocess stored newsletters after rule changes
   and show a diff of what would change before committing it. The reprocess path
   already preserves overrides; it needs a preview.
