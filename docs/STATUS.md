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

## Milestone 4 — season mode and verified facts (done)

**Whole-roster lineup.** Team now opens with the best legal lineup for the
league's actual slots, the changes needed to reach it, and the points each
change is worth. It is recommendation-only: there is no control anywhere that
edits a lineup, and an e2e test asserts that.

The assignment is exactly optimal, not a greedy slot-fill. Players are admitted
best-first and each admission is tested by an augmenting path; sets of
simultaneously-startable players form a transversal matroid, so greedy
selection is provably the highest-scoring legal lineup. This matters in leagues
that mix `FLEX` (RB/WR/TE) with `REC_FLEX` (WR/TE), where filling slots in order
strands a back on the bench. A test covers exactly that case.

Unknown still means unknown. A player who cannot be scored is listed separately
as undecidable — never silently benched — and no swap is proposed against a
current starter whose score is unknown. The current-lineup total is withheld
entirely when any current starter is unscorable, rather than treating the gap
as zero. Swaps below 0.75 pts are not suggested at all.

**CI fixed.** The `wrangler deploy --dry-run` step ran without `dist/web`
existing, so every run on `main` was red. It builds first now.

**Facts checked instead of guessed.** `.github/workflows/investigate.yml` is a
read-only manual job that answers questions the dev sandbox has no network path
to reach. What it established:

- `juncaj.net` is an active zone on the Cloudflare account, so the newsletter
  address is possible.
- The deploy token is scoped to Workers/D1 and zone listing only. Reading DNS
  or Email Routing returns `Authentication error` (code 10000).
- The Odds API free tier is 500 credits/month, and all six market keys the
  adapter asks for (`player_pass_yds`, `player_pass_tds`, `player_rush_yds`,
  `player_receptions`, `player_reception_yds`, `player_anytime_td`) are current
  in the provider's documentation.

The market set was deliberately left unchanged. `player_rush_tds` and
`player_pass_interceptions` exist and would model rushing quarterbacks better,
but each added market costs credits against a 500/month allowance, so that is a
decision to make with a real key in hand rather than a free accuracy win.

## Milestone 5 — reprocessing, and the defect it exposed (done)

**Reprocessing could not actually run.** `reprocess()` existed, was tested, and
had no caller — because the message log recorded that an email arrived and what
came of it, but never the email. Improving a rule could therefore only ever
affect newsletters that had not arrived yet, which is exactly backwards.
Migration `0003` retains bodies for processed messages so rules can be re-run
over the issues already in the ledger.

Quarantined mail is still logged but deliberately not retained: it came from a
sender the user never named, and keeping it would mean storing whatever a
stranger chose to send.

**Bodies are never republished.** Reads on this site are public and the
newsletter is someone else's work, so `/api/newsletter/messages` strips bodies
and reports only whether one was kept. A test asserts no message payload
carries body content.

**Preview before applying.** Setup can now show what re-running the rules over
one stored newsletter would do: how many items would be added, the resulting
tally change per player, and — the honest part — which stored items the rules
now read *differently* but will be left alone anyway, because reprocessing is
insert-only so a user's correction always survives. That distinction is
reported as `stale` rather than buried in a skip count; tuning rules without
seeing it is guesswork.

## Milestone 6 — the newsletter address is live (done)

`fantasy-news@juncaj.net` → Cloudflare Email Routing → the `fantasy-analyst`
worker. Confirmed against the live account and the deployed app:

```
MX      juncaj.net -> route1/2/3.mx.cloudflare.net
rule    fantasy-news@juncaj.net -> worker fantasy-analyst   (enabled)
app     address: fantasy-news@juncaj.net
        sender set: false        (nothing accepted yet, by design)
        emails received: 0
```

Enabling Email Routing for the first time turned out to be dashboard-only — a
scoped API token can manage routing *rules* but cannot switch the service on.
The setup workflow now treats that step as best-effort and names the dashboard
path instead of reporting a bare authentication error.

**The setup workflow refuses to break existing mail.** Enabling Email Routing
replaces a domain's MX records, so step one aborts if any MX record exists that
is not Cloudflare's own. That interlock is in the workflow, not in anyone's
head, so it still holds if the workflow is re-run against a domain that has
since been given a mailbox.

**A run is not green until mail can actually be delivered.** The first
successful-looking run had created the routing rule with no MX records behind
it — a configuration that looks finished and silently bounces every newsletter.
The final step now verifies Cloudflare MX records exist.

**Accepting a sender no longer requires knowing it in advance.** Nobody knows
their newsletter's from-address offhand. The first issue arrives, is ignored
because no sender is expected yet, and Setup offers its real address for
acceptance in one tap.

## Milestone 7 — proven with real mail, and a privacy leak it exposed (done)

A real email was delivered to `fantasy-news@juncaj.net` and the whole chain
worked first time:

```
emails received: 1
last received:   from <owner's personal address> (quarantined)
detail:          "Ignored: this address only accepts your configured
                  newsletter sender."
```

Cloudflare accepted the mail, invoked the worker's `email()` handler, the
service logged it and refused to parse it because no sender has been accepted
yet. That is the designed behaviour, and it is now observed rather than assumed.

**The leak it exposed.** Reads on this site are public because fantasy data is
not sensitive. A sender's email address is not fantasy data — it is ordinarily
the owner's own personal address — and the inbound log published it. Addresses
are now masked (`a***@gmail.com`) for anyone without a session and shown in full
once unlocked, which is also the only state in which the sender can be accepted.

Masking the structured `fromAddress` alone was not enough: the plain-language
explanation quotes the sender too ("Unexpected sender ..."), so the address
escaped through the reason string. Redaction runs by pattern over the free-text
fields as well, which also covers wording added later. A test asserts no public
payload carries the raw address.

## Milestone 8 — the sender a bulk mailer actually uses (done)

The first real subscription exposed a bug that would have looked like the
newsletter simply never arriving. The app matched subscriptions against the
**SMTP envelope sender**, and bulk senders put a per-message bounce address
there:

```
bounce+93e88f.63af5d-fantasy-news=juncaj.net@mg-d0.substack.com
         ^^^^^^^^^^^^^ unique to one send
```

Saving that would have matched exactly one issue and then silently stopped —
indistinguishable from the subscription breaking.

- The worker now identifies a newsletter by its visible `From:` header, which
  is stable, and records the envelope address alongside it.
- A subscription matches against **either** address, so someone who copied the
  bounce address out of the log is not silently left with nothing.
- Saving an address that looks like a bounce (`bounce+`, `msprvs`, `prvs`, or a
  `+`/`=` encoded local part) is refused with an explanation and a workable
  alternative, rather than accepted and quietly useless.
- `From:` values arrive as `Display Name <a@b.com>`; the display name is never
  matched against.
- A domain pattern covers that domain's **subdomains**. `@substack.com` has to
  accept `...@mg-d0.substack.com`, because that is where the mail actually comes
  from — a plain substring test rejected exactly the mail the user meant to
  accept. The dot is required, so `@substack.com` still does not match
  `@notsubstack.com`.

## Milestone 9 — backfilling four issues that predate the app (done)

Four newsletter issues were read before the app existed. Their text is gone,
but their conclusions survived as a scored summary table, and importing that
beats starting the season from zero.

The importer is deliberately *not* a second classification path: it parses no
prose and runs no rules. Each row is a score somebody already decided, carried
across as one item, labelled as a backfill, and fully reversible in Review.

Against the real document — 141 rows, 106 good / 25 bad / 10 neutral:

```
rows read       141
matched         135
stored (new)    135
sent to review    6
```

and confirmed end to end on the live site: `Puka Nacua | net 13 from 1 item`,
so the derived signal cache picked it up rather than just the ledger.

What honesty cost here, concretely:

- A row's net score covers several issues, so it becomes **one** item of that
  magnitude. Splitting +13 into thirteen items the app never saw would have
  looked richer and been fiction.
- **Mike Evans is listed twice** in the source — -1 in the bad list and again
  as net-zero under neutral. Both rows went to review rather than the importer
  picking a side.
- Net-zero rows are never auto-applied, because applying zero applies nothing.
- Confidence is never `high`. This is a summary of material the app never read,
  and it must not outrank a rule that saw the actual sentence.
- Six names went to the identity queue rather than being guessed: `JSN`,
  `AD Mitchell`, and four punctuation variants (`R.J. Harvey`, `JJ McCarthy`,
  `JK Dobbins`, `Kenneth Gainwell` vs `Kenny Gainwell`). Each is one tap to
  resolve, and none of them was resolved by the machine.

### Underdog ADP cannot be fetched (no longer needed)

Superseded by Sleeper's draft rank, but recorded because it was checked:

Checked directly rather than assumed:

```
api.underdogfantasy.com/v1/rankings      404
api.underdogfantasy.com/beta/v3/rankings 404
api.underdogfantasy.com/v2/adp           404
api.underdogfantasy.com/v1/slates        404
underdogfantasy.com/adp/nfl              404 (after redirects)
underdogfantasy.com/rankings             403
```

There is no public feed, so an ADP snapshot has to be exported by hand and
imported through Setup. Open ADP-ish mirrors do exist — FantasyPros ECR is
reachable — but substituting a different source under the name "Underdog ADP"
would quietly change what the draft board's market value means, so it is not
done. Underdog stays the ADP source of truth or there is no ADP.

## Milestone 10 — nicknames, plain scoring, and Sleeper as the draft order (done)

**Nicknames can be taught.** Three things were each half-present and together
made "JSN" unfixable: resolving a name did not remember it, so it returned every
week; single-token mentions were only ever matched against surnames, so a stored
nickname still would not have matched; and the identity card only offered
candidate buttons, so a name with *no* candidates — exactly the case needing
help — could only be dismissed. Resolving now remembers by default, aliases are
checked before anything is guessed, and there is always a search box.

**Scoring is one line long.** Good news +1, bad news -1, neutral or
self-contradicting news does not count. Every item counts once however dramatic
it is. The rules still grade severity 1-3 and it is still shown, but it no
longer lets one sentence outweigh three — a tally you cannot predict is a tally
you cannot trust. Review states this where the decisions are made.

**Draft order comes from Sleeper.** Sleeper's public player dump — already
synced nightly — ranks ~2,500 players in draft order, so the best-ball import
is gone as the primary path. No export, no file, nothing to keep in step.

Named `draft_rank`, not `adp`, throughout: it is one source's ranking, not an
average of observed drafts, and the UI says so. Sleeper parks unranked players
at a sentinel (9,999,999); read literally that would make a player look merely
undrafted-late rather than unknown, so it is treated as unranked. An imported
file still wins if one exists — a file the user chose is a deliberate statement
about their draft.

## Milestone 11 — the bound-parameter ceiling, and tally-aware ordering (done)

**A live crash, caused by the previous milestone.** Opening a real drafting
league returned `D1_ERROR: too many SQL variables`. D1 caps a statement at 100
bound parameters; `getSignals` batched at 200 and had simply never been handed
a list that large. Switching draft order to Sleeper grew the candidate pool
from a handful of imported rows to every ranked player (~2,500), and the latent
bug became a hard failure.

Fixed in two places, because either alone leaves a trap:

- `MAX_BOUND_PARAMS = 90` is now shared, and every `IN (?, ?, ...)` built from a
  caller's list batches against it — including `listByIds`, which had no
  batching at all and was only safe because callers happened to pass short
  lists.
- The draft board scores the top 300 available rather than all 2,500. That is
  far more than any draft reaches, the cap is applied *after* the position
  filter so filtering by QB still sees the best quarterbacks, and the board says
  out loud how many were left unscored.

**Players are ordered by rank plus news.** `adjusted = draftRank - 0.5 x net`,
so a point of tally moves a player half a pick and a positive tally moves them
up. Enough to lift a riser past a neighbour; not enough for a good run of press
to leapfrog a genuinely better player — a test pins exactly that. Unranked
players sort after everyone ranked rather than being treated as pick zero, and
the list shows Sleeper's raw rank next to the movement so the order is never
mysterious.

## Milestone 12 — search_rank was never a draft order (done)

Taking draft order from Sleeper's `search_rank` was wrong, and the app shipped
it. `search_rank` measures how prominently Sleeper surfaces a player **in
search** — who people look up, not who gets picked. On a real board it put
Drake Maye around 7, floated long-retired players into the top 300, and pushed
quarterbacks to the top of an "all" view in a 1QB league.

The top dozen it returned looked exactly like consensus ADP, which is why it
was believed. Checking the happy path and generalising from it is the whole
mistake: the tail is where a ranking is falsified, and the tail was never read.

- `search_rank` is renamed `searchRank` and is no longer a draft position
  anywhere. It survives only as a weak tie-break for search results, with a
  comment saying why it must not be used as an order.
- Draft order comes from an imported ranking again. With none, the board ranks
  by news and roster need and says so, rather than ordering by a number that
  means something else.
- **The board only offers positions the league starts.** Taken from the
  league's own roster slots, so a league with no kicker slot is never shown a
  kicker — and a league that starts a defence sees defences, which the
  ranked-players-only filter had been silently excluding.

Sleeper does not publish ADP: its REST paths 404 and its GraphQL schema has no
ADP field (`get_adp`, `adp`, `adp_data` all rejected, with unrelated
suggestions).

## Known limitations

0. **Player portraits cannot be seen against Sleeper's real images from here.**
   The sandbox this is built in denies `sleepercdn.com` at the network policy,
   so the CDN's behaviour is taken from the brief's probe rather than
   re-measured, and every screenshot and every test uses a generated stand-in at
   the source's own 350×254 framing. The crop and the URL were since confirmed
   against real portraits on an iPhone, on the surface that shipped first, which
   is the check this environment cannot make — and the surfaces added since use
   the same 64px circle from the same component, so what was confirmed there
   holds. What remains unverifiable here is the same as before: that the URL
   still resolves in production, which is what the initials fallback exists for
   and is the most tested thing in the feature. See docs/ARCHITECTURE.md.

0. **SportsGameOdds publishes no season-long NFL player markets.** Established
   by probe against the live API and its own market catalogue: every NFL event
   is a single game, `type=prop` and `type=tournament` are empty for the league,
   and the catalogue has no season period. The season-market pipeline is built
   end to end — adapter, identity resolution, append-only snapshots, freshness,
   a league-scored baseline with honest partial coverage, a modest ranking
   component and the card line — and lights up the day a provider publishes one.
   Today it stores nothing and the cards say nothing, which is the honest
   answer. See docs/VEGAS.md.
1. **The Odds API adapter is verified but still disabled.** The free tier and
   every market key are confirmed current. What remains unverified is the live
   response shape and actual NFL prop coverage, which needs an API key. Vegas
   shows as "not connected" by design and no quota has been consumed.
2. **No real newsletter has been parsed yet.** Delivery is proven end to end,
   but only with a test email, which was correctly ignored. Rule quality
   against a real issue is still unknown until one arrives.
3. **Rule magnitudes are still conservative** (mostly 1). Expect tuning once
   real newsletters have run through the coverage report.
4. **Draft weights are calibrated for best-player-available.** Roster need is
   0.1 and scaled down further in the early rounds (`needUrgency`), so an empty
   starting slot is worth a pick or two in round one and three or four in the
   last rounds — enough to break a tie, never enough to beat a better player.
   The regression tests in `tests/draft.bpa.test.ts` fail on the old weights.
5. **Survival probability is a heuristic**, labelled as an estimate.
6. **Rate limiting is per-isolate**, not distributed — fine for one user.
7. **Draft polling is client-driven.** The Draft header carries a refresh
   control (↻) that force-syncs the pick stream from Sleeper and rebuilds the
   board; a live draft then keeps updating itself at the interval the server
   nominates until it finishes or a sync fails. Syncing is a write, so a
   view-only reader's refresh rebuilds the board from stored state and never
   starts a background write loop.
8. **The draft board lives on the Draft screen, and only there.** Once the
   season is under way the Draft tab leaves the toolbar (`core/sleeper/phase.ts`),
   and the board leaves with it — the board itself is happy to render a
   completed draft as read-only history, but nothing else in the app currently
   routes to it. A second entry point from a league or history context is a
   navigation decision this workstream deliberately did not take on its own.
9. **`adp_snapshots` carries no season, and nothing else can supply one.**
   Found by the rollover readiness check and deliberately *not* fixed there.
   Every other season-scoped store keys on an explicit `season` column; ADP is
   imported from a file the user uploads and the table records only
   `captured_at`. Nothing in the file says which season it prices.

   The consequence is the one failure the rollover work exists to prevent, and
   it is invisible from every other angle: a snapshot imported in August 2026 is
   still `latest()` in 2027, its numbers are plausible, its ranking is
   plausible, and it is a year old. `GET /api/diagnostics/rollover` therefore
   infers the snapshot's season from its capture date — a guess, and correct
   often enough to be useful — and reports it as `stale` once Sleeper has moved
   on. That surfaces the problem; it does not solve it.

   **The fix belongs to the Draft Usability / DOG ADP workstream**, because
   solving it properly means a `season` column on `adp_snapshots`, a migration
   that backfills it from `captured_at`, the importer stamping it from the
   authoritative season (`services/seasonService.ts` already answers this), and
   `AdpRepo.latest()` taking a season argument so a prior season's snapshot can
   never be returned as current. That is a change to ADP ingestion, which this
   infrastructure pass had no mandate to redesign and which that workstream will
   be inside anyway. Until then the readiness check is the mitigation: it will
   say `ADP still has only 2026 data` rather than letting the board quietly
   serve it.

10. **A sheet's dismiss gesture was measured before the sheet had stopped
   moving.** Found while running the browser suite for the Demo Mode channel:
   `sheets › a downward pull dismisses it` failed intermittently at 430 and
   nowhere else, and passed on every retry — which is the worst failure profile
   there is, because it is green on a fast machine and red on a busy one with
   nothing wrong with the app. `toBeVisible` passes the moment a sheet enters
   the document, which is the *start* of its entry animation; the test then took
   the grip's position and dragged from it, so on a slow frame the drag began
   somewhere the grip no longer was. The fix is in the test and weakens no
   assertion: it waits for the element to stop moving, asked as a question about
   the element rather than answered with a fixed sleep.

11. **A queue-filtered draft board scores differently from the full one.**
   Found while asserting that the ★ moves no ranking: it does not, but
   `?queued=1` narrows the *candidate pool*, and the tier-cliff and positional-
   scarcity components are computed over that pool — so three starred players
   across three positions have no tier structure to read and their scores move.
   The `Next%` simulation is already immune: it was deliberately given the whole
   board rather than the filtered one, and the same argument applies to the tier
   inputs. **Assigned to the Integrity workstream**; Demo Mode did not change it
   and `tests/demo.scenarios.test.ts` asserts the star's neutrality by building
   the same board twice with and without the flags rather than by comparing a
   filtered board to an unfiltered one.

12. **The browser suite shares one dev server across all three viewports, and
   reuses one across runs.** `reuseExistingServer` is on outside CI, so a server
   left behind by an interrupted run is picked up by the next one with its state
   intact — which is how a 390-width run comes to see a 375-width run's
   newsletter sender, and how accumulated review-queue state makes `can reassign
   an item to the right player` fail. Both pass on a fresh server, which is what
   CI uses; locally, run with `CI=1` or kill any surviving `dev-server.mjs`
   first. Worth isolating per project if it ever fails in CI.

11. **The matchup game clock is wall clock, not game clock.** This app has no
   play-by-play feed, so how far into a game a player is is inferred from how
   long ago it kicked off, and kickoff comes from the Vegas event table. A
   player whose game nobody has priced has no clock at all: he is read as not
   started while he has no points and as live once he has some, marked
   `inferred`, and counted in the confidence line. Nothing about that is wrong
   — it is just coarser than a scoreboard, and it is the one input a free feed
   cannot supply.

12. **Kickers and defences have no projection.** The start/sit engine models
   neither, so in a league that starts them they arrive with `projection: null`,
   contribute nothing to the projected total and are named in the confidence
   line as "not projected". Both sides lose the same amount, so the win
   probability is roughly unaffected and the projected *totals* are
   systematically low by a kicker and a defence. The alternative — inventing a
   number — is the one thing this app does not do.

13. **Matchup calibration has no samples yet.** The ledger is written from the
   first request and `GET /api/diagnostics/matchup-calibration` reports what is
   in it, but a band withholds an observed rate below twenty settled weeks and
   there are none. It is a season of Sundays before that sentence can be
   answered, which is exactly why the writing had to start now.

Closed since the last report: **WebKit now runs and passes in CI.** The
"iPhone WebKit smoke tests" job is green on GitHub, so the specs have executed
on the real Safari engine, not only on Chromium locally.

## Milestone 5 — tally magnitude, decision quality, visual pass (done)

**The tally magnitude repair.** An imported tally row is a net score somebody
already decided across several issues, and the app was losing all but one point
of it. Not in the importer — that always wrote the real magnitude — but on the
identity path: an unresolved name recorded only its polarity, so confirming who
it was created evidence worth ±1 whatever the source said. That is how
"JSN +11" reached Jaxon Smith-Njigba as +1, and why AVOID (lifetime <= -5) was
unreachable for any imported row. An identity review now carries the magnitude
the item would have had if the name had resolved; sentence-level scoring is
untouched. A tally document also owns every row bearing its message id, so
re-importing after a confirmation retires the ±1 stand-in instead of counting
the score twice. Verified against the document in the repository: the reference
totals reconcile and JSN reaches +11 and stays there across three imports.

**Decision quality — draft.** Tier cliffs, roster construction alerts that read
the round as well as the roster, ♥/♥♥/♥♥♥ My Guy stored apart from both the
evidence ledger and the draft queue, and automatic AVOID. All move the ranking
rather than decorating it; their thresholds live in
`src/core/draft/decisions.ts`, the tier ones in `src/core/draft/tiers.ts` and
the survival ones in `src/core/draft/survival.ts`.

**Tier calibration.** A cliff is a hole in the market, judged against how that
position is actually spaced: the gap to the next available player must clear an
absolute floor for the position (QB 12, TE 13, RB/WR 8 picks), be at least twice
the median spacing locally and position-wide, and not simply be the point where
the position turns uniformly sparse. Thinning is the same measure, more
permissive, and says only that depth is reducing. No more than a fifth of a
position may wear the cliff label at once. The reported tight end board — ADP
40, 51, 67, 68, 76, 78, 99 — went from seven cliffs to one, and the reported
running back board from several to none. Nothing about the user's roster, the
tally, My Guy, AVOID or Vegas can change the classification; they move the
ranking through their own components.

**Survival.** The chance a player lasts to your next pick is now conditional on
his being available *now*: `S(next) / S(current)` under the same logistic model
around ADP, computed in log space so a deep faller does not divide zero by zero.
A player at ADP 45 still on the board at pick 60 reads ~38% to reach pick 68
rather than ~5%, which is the difference between an estimate and an artefact.
The exact next pick comes from the live snake order, and the colour bands
(0–30 red, 31–65 amber, 66–100 green) are defined once, beside the model.

**Decision quality — weekly.** Locked games (a started player leaves the
optimisation entirely, and the rest of the lineup is worked out around them),
late-swap safety, and market movement read from the snapshots already kept. The
role-change detector was complete and tested but returned "insufficient data",
because no per-game usage source was connected. One now is — see the milestone
below.

**Visual pass.** Position colour coding everywhere a position appears, the
draft stat banner replaced by one line, league settings folded away, denser
rows, and a tab bar flush with the safe area. Six players fit where five did on
a 360px phone.

**Vegas.** `SportsGameOddsProvider` is implemented and tested against the live
API's real payloads, captured by probe. Not enabled — see docs/VEGAS.md.

Checks at this milestone: 683 unit/integration tests, 139 Chromium mobile
browser tests, typecheck, build and `wrangler deploy --dry-run` all green.

## Milestone 13 — per-game usage, and the detector that finally has an input (done)

The role-change detector has been finished since the season brief and had never
once answered a question: with nothing publishing per-game opportunity, every
card said "insufficient data" and was right to. `docs/STATUS.md` called it the
last input the weekly decision layer was missing. It is now connected.

**The source.** nflverse's weekly player stats, the same kind of public GitHub
release asset as the injury report — no key, no account, no quota, nothing to
be withdrawn. `stats_player_week_2025.csv`: 8.3MiB, 19,422 rows, 150 columns,
one row per player per game played, of which 6,321 are at the four positions
this app carries.

**Why not snap counts.** `snap_counts_2025.csv` carries offensive snaps and
snap share, which are better role signals in the abstract, and was rejected
anyway: its only identifier is `pfr_player_id`, an id space this app has never
seen. The weekly stats file is keyed by GSIS — the same space as the injury
report's `gsis_id`, already resolving at 98.9% through `resolveToCanonical`. A
second fuzzy matcher for a second id space is what every brief here has ruled
out, and one good signal on the proven identity path beats a better signal on a
new one.

**The trap.** 19,394 of 19,422 lines contain a quoted comma — `f_auto,q_auto`
inside `headshot_url`, and sometimes a name like `"Kenneth Murray, Jr."`. A
`split(',')` yields 151 fields where the header has 150, and it is not even
uniformly wrong: 19,377 lines give 151, seventeen give 152, and twenty-eight
team rows give 150. A fixed `+1` correction would silently corrupt forty-five
rows and misread `week` on one line in five hundred. So every field is read
quote-aware, by a bounded extractor that keeps only the thirteen columns wanted
— and that extractor is checked against a full RFC4180 parse of every line of
the real file: **19,422 lines, 252,486 fields, zero mismatches**
(`scripts/probe-usage-parse.mjs`; a 255-line slice of the real file carrying all
three line shapes runs the same comparison in CI).

**What it costs, measured honestly.** The file is monotonically non-decreasing
by week, so the latest week is found by walking backwards from the last line;
`week` and `position` are read in the same pass, so the full thirteen-column
extraction runs over the ~350 rows that matter rather than the ~1,070 in the
week. Against the real file: 4.0ms for a worst-case in-season week (truncated to
week 18), 4.3ms for an explicit earlier week by seek, against a 10ms Workers
allowance. The measurement that mattered was the one nearly missed: parsed as
the file stands today the latest week is a 67-row playoff week and the answer
looks like 1.6ms — a real regular-season week is sixteen times that, and was
10.0ms until the position filter moved into the first pass. These are Node
numbers for the JavaScript alone; they exclude D1, which is I/O on Workers.

**Scheduled daily, not every five minutes, and deliberately.** A conditional GET
that 304s is nearly free, so the five-minute tick was tempting. But a game's
target count is settled the moment the game ends and never changes again: 288
checks a day would learn exactly what one learns and spend 288 bookkeeping
writes proving it. It rides the 09:00 UTC cron — about 5am Eastern, after the
late window and Monday night, after nflverse's own pipeline has run.

**What is stored.** `player_usage_weeks`, one row per (player, season, week),
season-keyed so 2025 and 2026 cannot collide: pass attempts, carries, targets,
receptions, target share and WOPR, with `season_type` beside them because a
January playoff week is not part of the population any lineup question is asked
about. A blank in the source stays null and never becomes a zero, and a player
who was inactive has no row at all — his absence is a game that did not happen.

**What Start/Sit says now.** For a player with six regular-season games, the
role trend: targets and target share for a receiver, carries and targets for a
back, pass attempts and carries for a quarterback — pairs that can genuinely
disagree, because the detector's confidence rests on agreement and two views of
the same number agreeing is double counting. Below six games it still says
"insufficient data", and the Setup panel reports how many players have crossed
that line rather than only how many have a row.

**Shared rather than copied.** The conditional GET, the compare-and-swap ingest
lease, the consecutive-failure counter and the daily write ledger were extracted
out of the injury pipeline (`core/source/conditional.ts`,
`repos/sourceState.ts`) and are now used by both, against column-for-column
identical tables and separate ledgers. The injury pipeline's behaviour did not
change; its tests did not either.

**What cannot be observed yet.** `stats_player_week_2026.csv` is a 404 until the
season starts, so in production the feed correctly reports `not_published`, and
the 304 path, a real ingest and the mapped share will first be exercised by the
first published file of the season.

Checks at this milestone: 1,216 unit/integration tests (49 new, plus one that
runs only against a downloaded copy of the whole 8.3MiB file), 547 Chromium
mobile browser tests, typecheck, build and `wrangler deploy --dry-run` green.

And eight deliberate mutations, each caught by a named test: a naive comma
split (10 tests), dropping the ascending-index sort (10), parsing the whole
file rather than one week (2), widening the position filter (2), lowering the
six-game minimum (2), including playoff weeks in the series (1), turning a
missing game into a zero (1), and trimming the read window before the season
type had been read (1).

## Milestone 14 — the room, as a board (done)

The Draft screen answers "who should I take". It has never answered the other
question a drafter asks every thirty seconds, which is *what is the room doing*
— where the receiver run started, how many quarterbacks have gone, who is
hoarding backs, how everybody's roster is being built. Those are questions about
shape, and a ranked list cannot answer them however good the ranking is; until
now the answer was a second app open on the same phone.

**The entry point costs nothing.** A grid glyph beside the league name in the
Draft header — not a row, not a tab, not a persistent `Draft Board` button. The
bar is measured in the browser suite and is still the same two lines of type it
was: `nav.height < 60` at every width, with the button on the title's own line.
Everybody pays for the header on every screen of every draft; only the people
who tap it pay for the board.

**It fetches nothing.** The board draws the picks that are already in the board
response the Draft screen's live refresh rebuilds, so a pick landing in Sleeper
reaches the grid through exactly the sync that was already running. There is no
second polling loop, no second endpoint and no request made from the overlay at
all — asserted directly: with the sync fingerprint frozen, opening the board and
switching its mode twice causes zero board rebuilds, and the existing cadence
does not change.

**It computes nothing.** `core/draft/boardGrid.ts` is a pure transformation —
draft state → rounds → stable manager columns → pick cells — and the component
draws what it returns. No score, no ADP, no value, no survival, no tiers; the
ranking formula, the Monte Carlo, the tier engine, the opportunity cost and the
polling cadence are untouched. The one arithmetic in the overlay is scroll
positions.

**One ownership model, not two.** Columns are draft slots, fixed, so a roster
reads vertically; the snake shows up in the *pick numbers*, running left to
right in odd rounds and right to left in even ones. Whose pick is whose comes
from the ownership model `Next` already uses (`nextpick/ownership.ts`, imported
rather than reimplemented), with one rule on top: a pick that has been made
belongs to the manager Sleeper says made it, and no model overrules an event.

**Compact is the default, and the restraint is the feature.** Every completed
pick is its position in the position's own colour token — the same
`--pos-QB-line` / `--pos-QB-tint` the player cards use, so a receiver is the
same amber on both. Six manager columns fit on a 360px phone. Expanded swaps
the position for `J. Hurts`, the position and the club mark from the existing
`TeamLogo` primitive, and stops there.

**Names are shortened structurally.** First token is the given name, everything
after it identifies him — which handles `A. St. Brown`, `M. Harrison Jr.` and
`C. McCaffrey` with one rule and no dictionary. A collision grows the initial
one character at a time (`Mar. Brown` / `Mal. Brown`) and stops the moment the
group separates; everybody else keeps one initial, and two genuinely identical
names are printed identically rather than given an invented difference.

**Context stays frozen.** One CSS grid inside one scroll container, with the
manager row sticky to the top and the round column sticky to the left. Not a
table: sticky positioning inside `display: table` is where WebKit support has
always been thinnest, and a board whose header detaches on an iPhone is worse
than no board.

**It moves when the reader asks and not otherwise.** Centred once on open — on
the pick on the clock, and on the reader's own column too when the two can share
a screen — and then left alone, with a `Current` control to give the place up
deliberately. A board that re-centred on every pick would yank the grid twelve
times a minute during the exact activity it exists for. Switching modes keeps
the reader's place by anchoring a *cell* rather than a pixel offset, since the
two modes have different column widths.

**The optional roster summary shipped, in the one place it is quiet.** `2 RB ·
3 WR · 1 TE` at the foot of each expanded column, below the last round, where it
takes nothing from any cell. Compact mode does not get it: there is no honest
way to add a line to a 52px column, and density is the whole value of compact.
It is also in every column header's title and accessible name, at no cost in
pixels, in both modes.

**It reads out loud in both modes.** The visible content is abbreviations by
design, which hear badly, so each cell hides them from assistive technology and
offers one plain sentence — pick, manager, full name, position, club — the same
sentence compact or expanded. The pick on the clock carries `aria-current`,
not only an outline.

**A finished draft keeps its board.** Nothing about the board is tied to `draft
is live`; a complete draft is readable history with nobody on the clock, taken
from Sleeper's status rather than from the pick count, so a draft closed early
does not draw a phantom turn.

Checks at this milestone: 1,692 unit/integration tests (38 new — 37 in
`tests/draftBoardGrid.test.ts` and one asserting the three new board fields end
to end), 16 new browser tests (`e2e/draft-board.spec.ts`) run at 390, 375 and
360, typecheck, build and `wrangler deploy --dry-run` green, and visual QA at
430, 390, 375 and 360 in both modes, both themes, and at early / mid / late /
complete draft states, plus landscape.

And twelve deliberate mutations, each caught by a named test. Five in the pure
layer: never reversing the snake in even rounds (3 tests), the current pick off
by one (4), printing the full given name instead of an initial (8), a completed
pick falling back to its seat instead of its actual owner (2), and ignoring the
complete status so a closed draft still shows somebody on the clock (1). Seven
in the browser: the overlay opening a polling loop of its own, switching modes
resetting the board to round one, expanded cells printing full given names,
compact cells carrying a metric, an unreserved club-mark box changing a cell's
shape when the image fails, closing the board resetting the Draft filter, and
the board button taking a row of its own in the header.

Two of them initially survived, and both were informative. Ignoring the
complete status survived because every existing test also ran the counter past
the last pick, so `has no current cell in a draft closed before its last pick`
was added. And the first attempt at the header mutation — making the title row
`display: block` — was caught by nothing because it does not in fact create a
row: an inline name and an inline-flex button still share a line. Replacing it
with a mutation that puts the button in a block of its own failed the height
assertion as intended.

## Milestone 15 — league strategy (done)

The layer above "who do I start". Five decisions a manager makes every week that
the app had no opinion on — what to bid, what to drop, what to offer, whether to
consolidate, and who they are negotiating with — plus one sentence explaining
what the tally already said.

**Three numbers, not one.** The expected market price, the recommended bid and
the do-not-exceed ceiling are computed separately and are frequently far apart,
which is the whole point: the most valuable sentence a waiver tool can say is
*he will go for more than he is worth to you*, and a tool that reports one
number cannot say it. `tests/faab.test.ts` pins the case — a contested player
this roster barely needs produces a recommendation below the market band and the
reason "Losing him at that price is fine."

**No budget is ever assumed.** Sleeper defaults to $100 and the league's rule is
read from its own settings; a league that publishes none gets a sentence rather
than a dollar figure, and a waiver-priority league is told it has no bid advice
to give. Spend is Sleeper's own `waiver_budget_used`, which already accounts for
FAAB moved in a trade — transactions cross-check it and never replace it. That
number was being fetched on every league sync and thrown away: migration 0020
adds `rosters.settings_json` so the roster blob survives the sync.

**Losing bids say unknown when they are unknown.** Sleeper publishes the user's
own failed claims and other managers' inconsistently. `losingBidsComplete` is
false unless the league provably had no failed claims at all, and the card says
so rather than presenting a floor as a distribution.

**Trending is written down before it can be differenced.** Sleeper keeps no
history of its own trending list, so `#2 trending add` is available to anyone and
`add rate accelerated 6×` is available only to somebody who captured yesterday's
list. `trending_snapshots` is that capture. Two guards keep the velocity honest:
rates from different lookback windows are never compared, and a ratio built on
fewer than five adds an hour is withheld — three adds becoming eighteen is "6×"
and is also nothing.

**Trending never touches a projection.** It prices a bid and raises a question,
and `detectDisagreement` returns `affects: 'bid_price_and_confidence_only'` with
a confidence delta bounded to ±0.1. A property test walks the whole input space
asserting no field a projection could consume ever appears. The two populations
it finds are the ones no single ranking surfaces: the market surging while usage
is thin, and the model strong while the market is quiet.

**A bench slot is priced across positions.** The brief's own example is the test:
a mediocre QB2 who scores 16 against a streamable 15 has more *slot value* and
less *surplus* than a handcuff scoring 5 who insures a starter and could take the
job. Insurance is discounted to a quarter rather than counted in full, which is
what stops a roster acquiring four backup running backs and no third receiver.

**Consolidation goes both ways, deliberately.** The same depth and the same
lineup gain produce `consolidate` in week 13 and `keep_depth` in week 3 with two
fragile starters, because a 2-for-1 converts depth into ceiling and fragility in
the same move and only one of those is usually reported.

**Manager profiles refuse to describe a small sample.** Below four completed
trades nothing is called a tendency: `confident` is false, every derived field is
null, and the one note says how many trades there were. Older seasons are
weighted down rather than discarded — a manager who traded picks constantly in
2023 and not since has changed, and a flat average keeps describing the 2023
version of him. Run-following is measured at room scope only, because one
manager's picks are every twelfth pick rather than a sequence.

**The room prior does not modify Next%.** `core/draft/nextpick/` owns that model;
the draft profile is bounded evidence offered to it, and a test asserts the
profile exposes no `nextPercent` or `survivalMultiplier` a caller could apply
behind that module's back.

**The newsletter takeaway is selected, never written.** `Drake Maye +4` is a
direction and a magnitude; the takeaway is the one supported sentence explaining
it, lifted out of the ledger by category relevance, specificity, corroboration
and a three-week recency half-life. A long excerpt is declined rather than
trimmed. The load-bearing test asserts the headline appears while
`aggregatePlayerSignal` returns a byte-identical signal before and after — the
evidence has already been counted once by the tally, and counting it again as a
headline bonus is the failure this whole evidence model exists to prevent.

A real regex bug fell out of writing those fixtures: the specificity pattern for
a ranking was `\b(?:no\.?|#)\s?\d+\b`, and `\b` before `#` can never match —
neither `#` nor the space before it is a word character. Every `#1 in completion
rate` claim had been scoring zero for its most decision-relevant feature.

**One player-detail renderer, finally.** Draft and Players had grown
byte-identical copies of `SeasonOutlook`, `OutlookBody` and `LastSeasonLine`,
each with a comment noting it was the same as the other. Both now read
`src/web/components/playerDetail.tsx`, which is also where the takeaway and the
injury sections live.

**Height and weight, stored and then almost never shown.** Migration 0021 keeps
what the sync had been discarding, because a handful of genuine conjunctions
cannot be asked without them — a light frame projected outside, an older back
whose usage is falling. What stops it becoming a body-type column is enforced in
code: a flag needs a measurement *and* a role it contradicts, the age flag needs
declining usage read through the same `assessRole` the card prints beside it, and
the server nulls the measurements out unless a flag actually fired.

**What is built but has no screen yet.** The trade ladder and the consolidation
read are served at `GET /api/leagues/:id/trades/ladder?playerId=` and are not
drawn anywhere — Trades is still a discovery list, and a negotiation surface is
its own design problem. Manager profiles are served and cached but likewise
unrendered; the ladder consumes them internally to set its opening discount.
Both are complete, tested and reachable, and both are honestly one screen short.

Checks at this milestone: 1,814 unit/integration tests (92 new) and 801 browser
checks after integrating the draft-board work from main, typecheck and build all
green.

One note on running the browser suite locally, because it cost time here.
`reuseExistingServer` is on outside CI, so a dev server left behind by an
interrupted run is silently reused by the next one — with the previous run's
state still in it. That is the mechanism behind limitation 9, and it presents as
a viewport seeing another viewport's data. `CI=1` forces a fresh server; failing
that, kill any surviving `dev-server.mjs` before re-running.

## Milestone 16 — the Team screen as a weekly tool, and the waivers shell (done)

**A label removed, a judgement kept.** The `AVOID — lifetime tally -5` chip is
gone from player cards. It said out loud what the signed tally beside the name
already says, in a red chip that cost a line of every card it landed on. The
tally, the lifetime threshold in `core/draft/decisions.ts`, the bounded penalty
the draft engine applies below it and every test over them are untouched — the
API still carries `avoid` and the model still believes it. The reader now
interprets `-5` directly.

**Pull to refresh.** Both refresh controls have left the Team screen — the one
in the navigation bar and the `Refresh data` button under it. A downward pull
from the top of the screen runs the same all-source orchestrator the button
called, with the same dedupe, the same budget refusal and the same per-source
report, and then reloads the roster, the lineup and the waiver scan. The
thresholds are pure functions in `web/gestures.ts` and tested there; the hook is
single-flight through a ref rather than through the state that paints the
spinner, because state lands a render later and the second pull happens in
between. It fires on distance and never on velocity, so a flick back to the top
of a long list cannot reload the screen underneath the reader. The keyboard
fallback is a control that is off screen until it is focused.

**Four controls, one row.** Balanced, Floor and Ceiling and the `Compare` button
now share a single row at every width down to 360px. The segmented control gives
up horizontal padding and a step of type size; no tap target shrank, and the row
is still 44px.

**The weekly card.** Tapping one of your own players opens a concise sheet
rather than the comparison: the lineup's own verdict, the role trend, the
matchup, what the market expects, availability when it is not the ordinary
answer, the two drivers that decided the score, and up to three prop lines. It
is built from `core/startsit/weekCard.ts` — a pure view model — off evaluations
the lineup had already computed, so it needs no request of its own and cannot
disagree with the row that opened it. Anything unknown is absent rather than
printed as a dash, and named once at the bottom. It carries silent slots for
expected points and for "what would change this", which light up the moment an
evaluation arrives carrying them.

**Waivers, as decisions.** `core/waivers/board.ts` turns the engine's
slot-shaped comparisons into one row per player — recommendation strength, the
slot he fits and the others he also fits, what he is worth this week, one short
phrase saying why — over an interface for the four facts that belong to the
league rather than to the player: expected FAAB range with its unit, likely
competition, multi-week value and a league-specific rank.

That interface met its supplier on the way in. The league-strategy milestone
above prices every upgrade, so the board now joins its bids to its rows and the
cost column carries the real range, to the dollar, as that pass produced it. The
bid's other two figures — what paying it costs, and whether the market is
already on him — open in the detail sheet, and the league's wallet sits once
under the rows rather than on every one of them. Competition and multi-week
value have no supplier yet and still read as unknown with the reason attached.

**There is no arithmetic anywhere in that file that turns projected points into
a bid**, before that pass or after it: a price is read, or it is absent. The
unit tests assert the absence rather than the shape, and the browser test now
checks the row against the API's own figure, so a rounded or re-derived number
would fail.

The Team screen shows the best three rows; the whole board is the new Waivers
destination, with position filters that only offer chips that would leave
something on screen, and the same pull to refresh.

**The seasonal slot.** One place in the toolbar is seasonal and exactly one of
Draft and Waivers is ever in it — written as a single filter so the two facts
cannot disagree. The switch is Sleeper's own season state, as it already was;
no date arithmetic was added.

**Alignment.** The tally and the availability tag now sit in a fixed-width,
right-aligned field, so every club mark on every list starts at the same x
whatever the number beside it is. Nothing is padded to `08` and nothing is
faked: an empty field is the same width as a full one, which is the whole trick.
The board rank is fixed-width and tabular for the same reason at the other end
of the row.

Checks at this milestone: 1,854 unit/integration tests — 40 of them this
channel's, the rest arriving with the two milestones above — and the browser
suite extended to a fourth width: 430, the Pro Max class, in the config, in both
npm scripts, and in the CI matrix that actually gates a merge, which is the one
that had been missing it. New specs cover the pull gesture, the weekly card, the
waiver rows, the seasonal toolbar swap and the mark alignment. Typecheck, build
and the Cloudflare dry-run green at every width.

## Milestone 17 — the intelligence layer beneath the engines (done)

Eleven new `core/` modules, one versioned contract, and 120 tests. No screen
changed, and that was the instruction rather than a shortcut: the brief asks for
reusable outputs, and the parallel Team/Waivers UI work stays mergeable because
nothing here touches it. Full detail in
[docs/PLAYER_AND_LINEUP_INTELLIGENCE.md](PLAYER_AND_LINEUP_INTELLIGENCE.md).

**Opportunity, separated from efficiency.** `core/xfp/` converts targets, target
depth, carries and attempts into expected points under the league's own scoring,
reconstructs what actually happened from the same rows, and reports the gap. Four
readings come out of it — touchdown regression risk, production outrunning
opportunity, a healthy role behind a bad box score, and a thin role behind one —
and the first two are the difference between a sell and a hold on the same hot
month. It scores **nothing**: opportunity is already in the lineup score once as
`usage_level` and the market's number is in it again as `vegas`, so a third count
off the same carries was the failure mode the whole module was arranged to avoid.
A test asserts the engine's score is unchanged by everything in the file.

**Who gets the football.** The beneficiary graph reads the games a team has
already played without a starter rather than a depth chart nobody publishes: with
him against without him, per teammate, per game. A week with no row for him and
rows for two teammates is a game he missed; a week with no rows for anybody is
the bye — derived from the data, because that distinction is the whole
reliability of the sample. With no absence to read it falls back to depth
inference, labelled as inference at low confidence, and with neither it says
`unknown` and names nobody.

**What would change the answer.** For calls inside 2.5 points, the conditions are
found by re-running the real evaluation with one input moved and bisecting for
the flip — the market line a challenger would have to reach, the practice report
that would demote the leader, the wind speed that would end it. Computed against
the engine rather than against a copy of its arithmetic, so a boundary cannot
drift away from the recommendation it annotates. Unreachable conditions are
dropped rather than printed.

**Floor, Balanced or Ceiling, chosen before it is asked.** A substantial
favourite gets Floor and a substantial underdog gets Ceiling, and the
circularity that idea invites is closed structurally: `suggestMode` accepts
market points per player and nothing else, so a mode-weighted score has no field
to travel in on. Thin coverage or an unknown opponent lands on Balanced with
`auto: false`, which is how a screen tells a choice from a default.

**Plan B is not Plan C.** Contingency lineups are real `recommendLineup` calls
with the clock moved to just before the questionable player's kickoff, so slot
legality, FLEX rules, the Out gate and locked starters all come from the
optimiser rather than from a second copy of its rules. The bench receiver who
covers the hole at ten in the morning is unavailable at four, and that is the
only thing the module exists to say.

**The app grades itself, and is not allowed to act on it.** Every recommendation
is recorded before kickoff with the model version that produced it and each
source's own `observedAt`; `lookaheadViolations()` returns every place a record
contains information from after the decision. Grading is two verdicts kept
apart: who scored more, and whether the call was defensible on pregame
information — judged by opportunity, so an alternative who won on a fluky
seventy-yard score grades as `sound_but_unlucky` and one who won on the better
opportunity grades as a real miss. The weekly report separates observed
evidence, counterfactual reasoning, suggested bounded changes and actual model
changes; the last is always empty, suggestions are capped at 15% and only ever
reductions, and nothing is proposed at all below twenty graded decisions.

**Consumed through one door.** `core/contracts/channel3.ts` carries a contract
version and the model version, states absence as `null` rather than zero, keeps
confidence and freshness inside the payload, and ships a validator that catches a
`NaN` anywhere in the tree, an unknown confidence level, a source marked missing
that carries an observation time, and a self-grade claiming it applied something.
Two payloads are built end to end in the tests — one fully connected, one with
nothing connected — and both validate.

Checks at this milestone: 1,783 unit/integration tests, typecheck, build and
`wrangler deploy --dry-run` green.

**Integrated rather than parallel.** Three modules had landed on `main` with
named holes in them, and this pass fills them without drawing anything: the
weekly card's `advanced` line and its `whatWouldChange` list, and the waiver
board's multi-week column — the one this document recorded as having no supplier.
Every projection targets a type imported from the module that owns it, so a
rename over there fails the build here rather than quietly going unfilled, and
the tests feed each adapter into the real consumer rather than into a copy of
its interface.

The sensitivity pass is affordable on a hot endpoint for one reason: a boundary
only exists for a close call, and closeness is a subtraction over scores that
have already been computed. That gate runs first, so a roster of comfortable
calls never reaches the bisection at all.

One word needed settling. `roster/bench.ts` labels role growth `Optionality`
and this branch used the same word for how many lineup paths a bench player
covers. Both are real and they are different quantities, so the assessment now
carries `kind: 'lineup_coverage'`.

**Not built, deliberately:** no screen, no persistence for the grading ledger,
no red-zone data — so the expected-points model is opportunity-shaped and says
so on every number it produces — and no future schedule, so the role-specific
outlook has no source in the running app and the multi-week value falls back to
role trend and the expected-points gap.

## Milestone 18 — the last waiver column without a supplier (done)

`core/waivers/board.ts` declares three league-intelligence fields and documents
how to read an empty one: *present-and-null is a pass that ran and found
nothing, absent is a deployment without the pass.* Two now have suppliers — the
price from `core/faab`, multi-week value from the milestone above. This is the
third.

**Competition, per position rather than per league.** `core/faab/strategy.ts`
asks for `rivalsWithNeed` — "rosters that plausibly want him and can pay" — and
the caller supplied every funded rival in the league, with a comment saying a
finer count would need each rival's lineup scored against each candidate, twelve
optimisations for a 0–1 input.

That is right about scoring and wrong about need. Whether a roster needs a back
is a count of the healthy backs it holds against the back slots it has to fill —
one pass over rosters already in memory, no optimisation, no extra query. It is
now per position and filtered by what each rival can still spend, so a card says
*four teams need one, three of them cannot afford the going rate* instead of
*eleven funded rivals*. Needs are counted honestly and only the bidder list is
filtered by money; a rival whose budget is unknown stays in it, because "cannot
be ruled out" is not "cannot afford it".

Availability is read through `normalizeDesignation` and `isRuledOut` rather than
against a private list of status strings, so "ruled out" means one thing.

**Three questions nothing else answers.** Bilateral trade fits, which choose the
deal `core/trades/ladder.ts` then prices — what you gain, what the partner
gains and plausibility scored separately, both sides gaining or it is not
listed, and plausibility read from the canonical `ManagerTradeProfile` so it
cannot disagree with the ladder. Bye and playoff planning, silent until a bye
leaves a slot short and giving playoff weeks zero weight until the season is a
third old and the record puts the team in the race. And a decision feed needing
both a magnitude and an actual decision change, filtering before it
deduplicates — merging first would let three immaterial reports of one nothing
combine into an item that looks corroborated.

**Two timing calls stopped waiting.** `Buy before usage converts to points` and
`Buy after temporary box-score dip` need expected points, which did not exist
when they were written. `assessXfp` now supplies both sides off usage weeks the
route already loads. A player with no weeks yields `NO_XFP`, whose per-game
figures are null, and the rules require both sides before they say anything — so
an unmeasured player still produces no call rather than one built on a default.

**What this milestone deleted, twice.** It was written against a `main` that had
neither the FAAB layer nor this intelligence layer, and built its own of each.
Gone in favour of the canonical modules: the transaction normaliser and repo,
the expected-cost model, the manager profiler, the waiver view-model, the
injury-beneficiary detector, the multi-week classifier, a duplicate
`getTransactions`, `SleeperTransaction` and `years_exp` column, three migrations
and five API routes. What survives is the one field nothing else fills and the
three surfaces nothing else has.

**Still missing, and each says so.** No bye-week source — neither this work nor
the intelligence layer has one, Sleeper's dictionary carries no bye and the app
stores no schedule, so `/plan` returns no gaps and names the gap. Three of the
five timing calls still rest on signals that exist; the schedule-turn one does
not, for the same missing input.

Checks at this milestone: 2,018 unit/integration tests plus the browser suite at
four widths, typecheck, build, perf budget and `wrangler deploy --dry-run` green.

## Milestone 19 — the Matchup screen (done)

The post-draft head-to-head, and deliberately not a prettier Sleeper.

**Sleeper owns the score; Fantasy Analyst owns the forecast.** The pairing, the
lineups, the slots and every points figure come from
`/league/{id}/matchups/{week}` and are never recomputed. Sleeper's own
projection sits on the same payload and is read nowhere. Everything else on the
screen — the projected finals, the win probability, the insight card, the
lineup counterfactuals — is this app's, built from the same start/sit engine
Team draws.

**A distribution per player, not a number.** `core/matchup/distribution.ts`
turns each starter's projection into a lognormal whose mean is exactly that
projection and whose spread comes from his position and his role: a deep threat
is wider than a possession receiver, a rushing quarterback narrower than a
pocket one. Three states, three different questions — a player who has not
kicked off carries his full pregame distribution, a live one carries what is
*left* conditioned on what he has already scored and how much of the game is
gone, and a finished one carries no distribution at all. That last one is not an
optimisation: a matchup where every game is over has one outcome, and the model
has to say 100%.

**Availability is a branch, not a discount.** An unresolved Questionable is a
mixture over playing, playing limited and not playing, keyed on the existing
`AvailabilityConfidence` state. The engine's own availability penalty is
subtracted out of the projection first, so the same designation is not charged
twice — and the mixture says the thing a shaved mean cannot, which is that his
floor is zero. The branch collapses the moment his game starts, because the
scoreboard has answered the question.

**Correlation, as a factor model.** A quarterback and his own pass-catcher, both
sides of one shootout, two backs splitting one committee. Loadings rather than a
matrix, because rules written pair by pair do not produce a factorable matrix
and the failure is a `NaN` win probability on a Sunday. Every implied
correlation is asserted to sit under 0.45.

**Four thousand afternoons, seeded from the state.** Same matchup state, same
numbers, on any machine — the fingerprint that seeds the generator is the same
string that keys the cache, so a state cannot change one without invalidating
the other. Every player is drawn, starters and bench alike, and every draw is
kept: that is what makes "starting him instead adds 3% to your win odds" an
exact difference over the same simulated afternoons rather than the difference
between two noisy estimates.

**The hero card is the product.** One insight at a time, generated from current
truth, ranked by a fixed ladder: can it still be acted on, how much of the
outcome does it move, how severe is the injury or game state behind it, how much
has it changed, how close is it to a threshold, is it about your own side. The
first axis is a tier and not a weight, which is what makes "an injury outranks a
projection wobble" a property of the code. When nothing material is happening it
says so calmly and stops, because a screen that manufactures urgency is one
whose urgency stops meaning anything.

**What you need, and what they need.** Thresholds are found by bisection over a
player's own simulated range against a target he can actually reach — aiming at
a flat 72% produces "you need forty-one from your tight end", which is true and
is not a path anybody is on. The wording hedges whenever more than one outcome
is still open.

**Which lineup wins *this* matchup**, which is not the same question as which
has the highest median: a big underdog should take the wider distribution and a
strong favourite the narrower one, and both fall out of the same stored draws.
Advisory, like everything else here — there is no code path in this app that
sets a lineup.

**Degraded is a first-class state.** If either side has fewer than half its
starters projectable, there is no honest number to print: the scoreboard stays,
the forecast says it is unavailable, and Sleeper's projection is never
substituted under this app's name.

**Calibration, from day one, and written by a clock.** `matchup_forecasts`
stores one row per roster per week — the first forecast written once and never
touched, the latest one moving as the afternoon does, and the outcome filled in
when the week ends. Keyed by season and week so 2026's week sixteen cannot
collide with 2027's, stamped with the model version so a bucket cannot mix two
models, and reported in ten-point bands that withhold a rate below twenty
settled samples. The writer is the worker's scheduled handler; the Matchup GET
is a pure read and writes nothing. See ARCHITECTURE.md for why that split
exists — it is the final audit's F-01, and it fixes both a write behind a `GET`
that the method-based auth guard could not see and a calibration sample whose
existence depended on somebody happening to open the screen before kickoff.

**Seven destinations, for one stretch of the year.** Matchup arrives the day the
draft completes, which is before Draft leaves, so the bar carries seven between
those two moments. Verified at 360px: no label wraps and no destination is
narrower than 44px.

**Nothing this screen asks is answered twice.** Floor / Balanced / Ceiling is
`core/startsit/modeSuggest.ts`'s answer, carried through the forecast rather
than re-read off the simulated win probability — the matchup model never sees
the question, which is what keeps that module's circularity guard structural.
The player sheet is the Team screen's weekly card, carrying the same
expected-points line, from the same `assessXfp`. Every projection is the
start/sit engine's.

Checks at this milestone: 113 new unit tests across the model, the hero engine,
the lineup decision, the names, the service and the calibration ledger, plus a
mutation file that breaks each of the eight failure modes the brief names and
proves the assertion catches it. 18 new browser tests across four widths, half
against the real endpoint on the seeded server and half against whole-response
fixtures for the states of a Sunday afternoon that a deterministic seed cannot
reach.

## Milestone 20 — Demo Mode and audit fixtures (done)

**A deterministic, read-only view of the real product across states that are
hard to reach on demand.** Draft night at four picks, a best-ball board, the
morning after, a Sunday twenty minutes before kickoff, an injury eight minutes
before it, a head-to-head read from five points in one afternoon, a Tuesday
waiver run with $37 left, a trade window, a playoff week, a rollover in March,
and seven ways it degrades. Twenty-eight scenarios, all of them wired: nothing
in the picker is greyed out.

**It is a substitution layer, not a second app.** One Draft screen, one Team
screen, one Matchup screen, one waiver card, one scoring engine — the demo
renders the product's. The seam is a single function: `request()` in `web/api.ts`, which every screen
already goes through. No screen knows a demo exists and no component takes a
`demo` prop, so a screen written next year inherits the behaviour for free.

**Two assemblies moved so there is one implementation instead of two.** The
draft board is now `core/draft/boardBuilder.ts` and the matchup is
`core/matchup/build.ts`, each driven by a sources interface that repositories
satisfy over D1 and Sleeper and that fixtures satisfy from memory. Both services
keep their exact public API and every caller is untouched. Alongside them the
waiver pricing and league-intelligence passes, the bench held-players mapping,
the bounded free-agent scan and the trade ladder inputs moved out of `app.ts`
into `core` verbatim. A rehearsed bid and a live one are now the same
arithmetic, and a rehearsed win probability the same simulation, by construction
rather than by care.

**The matchup states are the model's readings, not the fixture's claims.** The
fixture writes three kickoff windows, a market line for every man on both
rosters, and Sleeper's own `players_points`; `core/matchup` decides which games
are finished, which are running and which have not begun, and what any of it is
worth. So "one point in it" is a scenario whose two projected finals come out
less than a point apart — asserted through the simulation — rather than a label.
The injury scenario rules a starter out of a game that has not kicked off, which
is what lets the insight engine price the swap in win probability rather than
merely report the designation.

**The Underdog market is wired through the production board, not modelled a
second time.** Every §13 state is a fact about the file, stated as provenance
and resolved by `resolveDog` and `blendMarketBaseline`: DOG present and fresh,
an aging file that is used with its age printed, a nine-day-old file that is
withheld with the reason said out loud, no file at all, a player Sleeper prices
and Underdog does not, a player Underdog prices and Sleeper does not, a
believable 29-pick disagreement carried into the blend, and an Underdog price of
2.4 against a Sleeper 119 that the outlier guard sets aside. The 60/40 and 75/25
blends are asserted against the same board in a redraft league and in one
Sleeper flags as best ball — read from the league's own settings by
`detectBestBall`, never from its name.

**The one write in the app's injected interfaces is inert in a demo.**
`MatchupSources.record` writes both sides of every forecast to the calibration
ledger, because a probability model nobody grades is worth nothing. Demo Mode
satisfies it with a recorder that returns. Two things are asserted rather than
intended: that the interface has gained no second write, and that the demo's
recorder does nothing.

**Nothing a demo does can change anything, and it is refused twice.** In the
browser, `DemoRuntime.request` throws for anything that is not a read — a rule
about requests rather than a list of buttons, so it covers endpoints that do not
exist yet. On the server, a session-scoped `fa_demo` cookie makes the router
refuse every write with a 403, before the passphrase check and regardless of it.
Proved against every `router.post` path scraped from `app.ts`, against the real
router and a real database with a valid session attached, and from a
hand-written `fetch` in the page that goes straight past the UI.

**Time is injected, not replaced.** The app already had the convention, so Demo
Mode supplies a stopped clock to the same parameters production supplies the
real time to — including the instant an Underdog file's age is measured from.
`Date` is untouched, so there is nothing to leak.

**Fixtures state inputs, never outputs.** A market line, a designation, a target
count, a pick, a spend, an ADP. Every score, bid, verdict, blend and percentage
on a demo screen was computed by the production engine from those.

**Bundle cost is ~7 kB gzip on the render path** — the indicator, the session
and the API hook. The runtime, the registry, the picker and each fixture family
are separate dynamic imports that no page load can reach; they come to 92 kB
gzip, most of the growth being the matchup distribution model, the correlation
factors and the simulator arriving when the Matchup scenarios were wired. `vite.config.ts` names
every demo chunk `assets/demo-*.js`, which is what lets the page-weight budgets
exclude them from the render path *and* cap them with a budget of their own;
excluding without capping is how a budget stops meaning anything, so both were
done together.

Checks at this milestone: 2,600 unit/integration tests plus the browser suite at
four widths, typecheck, build, perf budget and `wrangler deploy --dry-run` green.

Full detail: [DEMO_MODE.md](DEMO_MODE.md).

## Milestone 21 — the Team screen at a glance (done)

The weekly intelligence was all there and none of it fitted. Every starter card
carried the market number, the usage reading, a prop line, the matchup note and
a sentence of consequence, which is five useful things per player and, at seven
starters, about three phone screens before the reader reached the one card that
tells them what to actually change. This milestone did not remove any of it. It
moved it.

**A starter is one line now.** Slot, name, the projection, the club mark, and a
tag only when a tag is material — `Locked`, `Not in Sleeper`, or the
availability designation when it is not the ordinary answer. Under it, at most
one short consequence, and only when the engine produced one. Everything else —
the market, expected points, usage, the prop detail, the matchup detail, the
evidence, the newsletter takeaway, the injury history, and the sentence about
what would change the recommendation — is behind the tap that was always there.
The row is between 44 and 72 pixels, so it is still a thumb target and it is no
longer a paragraph.

**The bench folds.** `Bench (6) ›`, shut when the screen opens, with a one-line
summary of what is behind it: `1 strong alternative`, or `No better option`,
taken from the swaps the engine already found rather than from a second opinion
about them. The count and the summary are the two facts that decide whether it
is worth opening, and they are outside the fold.

**The changes card sits directly under it.** It leads with one change — the best
one, its points impact and one short reason — and keeps the rest, the warnings
and the quiet risks inside the disclosure. A risk is only promoted above the
fold if it belongs to somebody the lineup is actually starting; a doubtful
player on the bench is not a headline.

The result is the thing the brief asked for and the thing the tests now measure:
at 430, 390, 375 and 360, every recommended starter is above the bench and
inside the viewport, the bench is shut, and the changes card is within 24 pixels
under it. Those are measured against the real rendered geometry, not against a
class name.

**One expanded player, still.** The weekly sheet now composes
`components/playerDetail.tsx` — the same newsletter takeaway, season outlook,
last season line, injury detail and profile flags that Draft and Players open —
behind a `More on <name>` disclosure, and mounts the body only when it is opened
so a reader who wanted the verdict pays for no request. That is a fifth caller
of the shared implementation rather than a fifth copy of it, which is the point:
the sections were pasted per screen once before, and the second paste is where
six renderers start.

Checks at this milestone: the whole unit/integration suite — over 2,800 tests by
the time this landed, the growth beyond this channel's own belonging to the
milestones it was integrated with — and the browser suite at all four widths,
with seven new density assertions per width — starters fit
above the bench, a collapsed starter stays one line, the bench is folded and
says what is behind it, the changes card follows it, it leads with one change,
the intelligence is still one tap away, and nothing scrolls sideways. Lineup
legality and the pull gesture are asserted unchanged.


## Milestone — one expanded player, on Players and on Trades (done)

The two screens opened the same component and did not read like it. A pass over
what the expanded card actually says, and nothing about what either engine
recommends: Players' ordering, the trade board's classification, confidence and
order, Draft, Team/Matchup and the StartWho import are untouched, and the
browser suite now asserts both lists are rendered in exactly the order their own
API returned them.

**The identity line runs the way every row runs.** Position pill, club's mark,
name, availability tag — and the tag is against the name it qualifies rather
than at the end of a cluster. The sheet had it reversed, with the name first,
which meant the one surface where a reader has committed to a single player was
the surface that changed the grammar they had just been reading. The comment in
the stylesheet claimed the row's order all along; it is true now. A long name
shrinks and truncates before anything to its right moves, which turned out to
need one missing `min-width: 0` on `.sheet-title` — without it a hyphenated name
pushed the status pill off the edge of the sheet at 390.

**The tag appears on Trades, which never had one to pass.** A trade suggestion
carries a trade-shaped injury category and no designation, so the same player
showed `OUT` on Players and nothing on Trades. The detail payload both screens
already fetch is now the fallback, so the pill is the same fact on both.

**One band of readings, in one order, on both screens.** `7d`, `21d`, `Life`,
`PTS`, `<season> GP`, `<season> rank` — with `Rank` and `ADP` in front of them on
Players, which is the only screen that has them. `PTS` is the canonical StartWho
preseason projection and is never allowed to read as a live number: the capture
date sits under the figure, and the tooltip and the accessible name both open
with the word *preseason*. Where nothing covers a player there is no cell at
all; where the season was looked up and he did not appear there is a dash. Never
a zero.

**Four blocks left the card, and every one of them was saying something twice.**
`News by window` repeated the tally windows now in the band; `2025` was a heading
over two numbers now in the band; `Draft market` printed the rank, the ADP and
their difference; `Categories` restated the tally by category. `Vegas props`
went for a different reason — a cached book line is not what a reader opens a
player for, and what the market expected of him is now `PTS`. Nothing was
deleted: all of it is one tap in, unchanged, under Overview and Market on his
own page, and the browser suite asserts that too. The injury designation stopped
being printed a second time under a heading that restates it; what is left below
the pill is the body part, the practice week and any disagreement between
sources — and nothing at all when there is none of that.

**Latest news reads like football.** The card was rendering the evidence console
— `▲ positive · mag 13 · uncategorised · Aug 12 · auto_applied`, then the
excerpt, then `rule: role-change · confidence: high`. Every token is true and
every token is about the classifier. What shows now is the sentence the ledger
already holds — the user's own correction note, then the stored summary, then
the excerpt, quoted verbatim and never trimmed to fit, which is the same ladder
the newsletter takeaway walks — with the date, a polarity mark and its word for
anyone not looking at a colour. The source name is printed only when it varies,
because one name repeated down a card qualifies nothing. The whole console is
untouched under Evidence, which is where the provenance promise lives.

The 2026 Season Outlook is unchanged, semantics and all.

Checks at this milestone: typecheck, the whole unit suite, and the browser suite
at 430, 390, 375 and 360 with a new `player-detail.spec.ts` — the identity order
asserted by x-position so a `row-reverse` cannot satisfy it, the long-name
truncation, the tag on Trades, `PTS` present and absent, last season present,
dashed and absent, no label or figure clipped in the band at any width, the four
removed blocks absent from the card and present on the page, no `mag N` and no
`uncategorised`, the outlook preserved, the news sentence checked against the
API's own stored words, reading order matching visual order in the grid, no
sideways scroll anywhere down either card, and both lists rendered in the order
their API returned.

## Milestone — the last micro-polish before the audit (done)

Three corrections, deliberately the smallest pass in the repository, and the
last Claude UI implementation pass before the read-only Codex UI/UX audit.

**`Market - 247 Pts`, and the pipeline is no longer on the card.** The expanded
player's preseason figure used to be printed as `Preseason 292 PTS` with
`StartWho · Aug 22 · Half PPR, 6pt pass TD` on the line beside it — four facts
about where a number came from, on a card a reader opened to find out about a
player. The reading is four words and a number now. Nothing was thrown away and
nothing was softened: the whole sentence is on the metric's title and in its
accessible text, and it still opens with the word *preseason*, because a
historical number that could be read as a live weekly line is the most expensive
kind of wrong.

**One band instead of two lines.** `Market - 247 Pts · 2025 · 17 GP · WR2
half-PPR` wraps as one line at every width the app is tested at, where the
market reading and the season used to be a line each. The year is the first
token of the readings it labels on every screen now, rather than a heading over
them on the wider cards — a heading that had also become wrong, since `2025`
standing over a projection for the season about to be played files it under the
season already behind it. The draft card lost between 8 and 27 pixels of height
at 360 and gained nothing; the shared band on Players and Trades, which prints
these readings as its own metric cells, was not touched.

**The draft tally sits exactly one space after the name.** `Ja'Marr Chase +5`,
and the same distance whether the name is long or short and whether the tally is
two characters or three. The root cause was a reserved three-character field
with the digits right-aligned inside it: the *box* was a fixed 5px from the
name, so every box measurement said the spacing was constant, while `+5` drew
about a third of a character further right than `+11` did. The field is gone,
the row's gap in front of the tally is cancelled, and a real space is rendered
in its place — so the distance is one space in the row's own font rather than a
pixel constant that stops being true at the next size. Everything after it is
where it was: `.player-row-meta` still hands the row's whole slack to the
trailing edge, so the star and the chevron never moved.

Checks: typecheck, the whole unit suite, and the browser suite at 430, 390, 375
and 360. The tally spacing is now asserted from the *ink* rather than from the
boxes — a `Range` over the text nodes, since box geometry is exactly what could
not see this bug — against a space measured in the row's live font, and required
to be identical across rows. The card assertions require the wording whole, name
each rejected spelling, and require the band to be one line high. The Players
`ALL · QB · RB · WR · TE · FLX · DEF` order was verified and left alone; no
ranking, formula, ordering or data semantics were touched.

## Milestone — Projection v2, evaluated and consumed by nothing (done)

The nflverse investigation left a data contract and no code. This is phase 1 of
it: three more free sources ingested, a deterministic usage/role feature layer,
a market-anchored projection with an uncertainty model, and a side-by-side
evaluation against what the app shows today. **No recommendation reads any of
it**, and that is asserted against the dependency graph rather than promised —
`tests/projectionV2.boundary.test.ts` walks every module under `core/startsit`,
`core/matchup`, `core/draft`, `core/trades`, `core/players` and five more
transitively and requires that none of them can reach `core/projection` or
`core/nflverse`. There is no flag to flip.

**The roster file turned out to be the keystone, and it is not football.** It
publishes `gsis_id`, `sleeper_id` and `pfr_id` on one row, which does two things.
It fills in the GSIS ids Sleeper leaves blank for 16.5% of skill-position
players — rookies especially, which is exactly the population whose role is
changing. And its `pfr_id` retires an objection this codebase wrote down and
meant: `core/usage/nflverse.ts` rejected the PFR snap counts because
`pfr_player_id` was "an id space this app has never seen", and a second fuzzy
matcher for a second id space is what every brief here has ruled out. That was
right and it is now spent. Measured over the full 2025 season the join resolves
**6,955 of 6,981** regular-season skill-position snap rows — 99.6% — on two
identifier hops and no name. Offensive snap share is the best role signal in the
free data and it is reachable now.

**The depth chart is a 44MiB file read 768KiB at a time.** It is written
newest-first, one capture is about 310KiB, and the release asset answers an
explicit `bytes=0-N` range with 206 while still answering `If-None-Match` with
304 — so the ordinary tick costs a round trip and no bytes. A prefix read cannot
tell a complete capture from a truncated one by looking at the rows, and a
truncated one reads as a club having released everybody the read did not reach,
so the parser calls a capture complete only once it has seen the *next, older*
one begin, and refuses outright if a newer timestamp ever appears below an older
one. The pre-2025 schema means something different by "rank" and is versioned
rather than papered over.

**The projection is arithmetic, not discipline.** `market components + estimates
for components no market priced + a capped adjustment for information newer than
the market snapshot`, and there is no fourth term. Every feature declares
A/B/C/D in a registry the engine actually calls before touching a mean, so a
feature cannot reach the mean by being wired in and forgotten. Most of them are
B: knowing a receiver's role is stable does not say the market is wrong about
him, it says its number has less to go wrong with it. A depth-chart move on its
own moves the mean by zero — clubs publish two-deeps to satisfy a league
requirement, and Arizona's live chart has a rookie ahead of James Conner — so it
needs a second source that measures behaviour and a timestamp after the market's,
and it is still capped at 1.5 points or a tenth of the anchor.

**The backtest found the uncertainty model twice wrong, which is what a backtest
is for.** Borrowing the matchup simulation's volatility table gave a nominal
10–90 interval that held **43%** of the time over 3,938 player-weeks of 2025.
Widening it to the measured spread got to 69% and stopped, with outcomes falling
below the floor twice as often as above the ceiling — the signature of a wrong
shape rather than a wrong parameter. A lognormal cannot reach zero and a fantasy
week can: 10.5% of receiver weeks scored under 15% of their projection. The
distribution is a mixture now — a bust branch at approximately zero, and a
lognormal for the rest — and it holds 76% with the bottom tail landing at 8.8%
against a nominal 10%. The consequence is stated rather than tuned away: **a
receiver's honest tenth percentile is zero**, because one receiver week in ten
is zero.

A grid search wanted twice the measured spread for backs, receivers and tight
ends, pressed against the top of the search range. That was not adopted — it
would have been absorbing a thin lognormal tail and somebody else's positional
bias into a width. The residual is reported instead: the interval runs tight in
the upper tail, most visibly at tight end.

**What could not be measured, said plainly.** This app has no betting-market
history, so market-anchor error is unanswerable and no number claiming to be it
appears anywhere. The backtest uses Rotowire's published weekly numbers — real,
independent, and published per component — both as the fallback baseline and as
a labelled *proxy* anchor. Whether betting markets are sharper than Rotowire is
the question the whole design rests on and the one this cannot answer.

Every one of the ten largest disagreements in the no-market regime is a backup
quarterback pressed into a start. The usage model correctly has nothing to go on
and correctly marks all ten low confidence.

Checks at this milestone: typecheck, the whole unit suite (3,706 passing and one
skipped, 93 of them new), the browser suite at 430, 390, 375 and 360, the build,
the page-weight budget — unchanged, because the web bundle imports none of this —
and
`scripts/probe-usage-parse.mjs` against the real 19,422-line published file,
which reports **zero mismatches across 252,486 fields** and is the proof that
moving the CSV extractor into `core/source/csv.ts` changed no behaviour. The only
other edit to a live-engine file is one keyword: `depthAdjustedRates` is exported
so the gap fill uses this app's published rates rather than a second copy of
them.

**Recommendation: keep it side-by-side.** See
[docs/PROJECTION_V2.md](docs/PROJECTION_V2.md) §15 for the five open items.

## Milestone — the Matchup answer, above the fold (done)

The screen already knew whether there was a lineup change worth making. It kept
the answer two taps down, inside the sheet behind the win probability, under a
heading called `Lineup impact` — so a reader who did not tap the odds never
learned that a starting slot was being spent on somebody who was not playing.
This promotes `forecast.decision.best` to a compact grouped row between the
scoreboard and the starters, and nothing else came up with it.

**No second optimiser, and it is asserted rather than promised.** The engine's
answer arrives already chosen, already ranked by win-probability gain, already
filtered for legality and already above the two-point materiality threshold. The
web layer reads four fields and lays them out;
`tests/matchup.bestMove.test.ts` walks the source and requires that neither
Matchup file imports a *value* from `core/matchup`, that `assessLineupDecision`
has exactly one caller in the whole repository, and that the threshold is still
0.02 — which is the number a screen like this puts the most pressure on, because
an empty slot above the lineup looks like a bug.

**Four states, and the two that both mean "no move" are told apart.** A move
worth making is a control; nothing worth changing is a footnote on the
`Starters` heading that costs the page no height; no forecast at all says so in
different words, because "your lineup is fine" and "we cannot tell you" are
different answers and both leave `decision.best` null; a finished afternoon says
nothing whatever, since the card above has already stopped forecasting. The copy
is deliberately `No lineup change recommended` rather than `Optimal lineup`: the
engine suppresses sub-threshold improvements, so the restrained sentence stays
true when the reason there is nothing to offer is that it is too late.

**The poll now watches the recommendation as well as the score.** A swap expires
at a kickoff, which is precisely when nothing is live yet and the old condition
— poll only while `phase === 'live'` — was false. A reader holding the screen
open at 12:55 would have been looking at `Start J. Doe over A. Smith` at 1:05.
The condition turns itself off: `decision.best` exists only while both players
it names are unstarted, so the first read after either kickoff removes the move
*and* the reason to keep polling. One timer and one visibility listener, exactly
as before, and the forecast's fingerprint covers every game's clock so a poll
that finds nothing changed recomputes nothing.

**A negative points delta renders with its minus sign.** The swap that gives up
projected points and still wins more afternoons is the answer a median cannot
reach and the reason this engine simulates at all; a row that quietly dropped
the sign would be the one recommendation in the app a reader is right not to
trust. `gain` is printed nowhere — `44% → 48%` already contains it.

**The explanation is its own sheet.** A reader who taps a win probability is
asking what is behind a number; a reader who taps `Best move` has been told what
to do and is asking whether to believe it. `Behind the odds` is unchanged and
still carries the swings, the mode and the freshness. Opening a player from the
best-move sheet swaps rather than stacks, so there is one focus trap, one
Escape and one downward swipe on screen at any time.

## DST safety and scoring foundation

**A defence is now a player this app has an opinion about, and the first lane
that made one scorable had to close every door that opened.**

**League-specific DST scoring, or a refusal.** `core/sleeper/dstScoring.ts`
reads what *this* league pays a defence for, out of the `scoring_settings_json`
Sleeper already persists: sacks, interceptions, fumble recoveries and forced
fumbles, defensive and special-teams touchdowns, safeties, blocked kicks,
two-point returns, and the points-allowed and yards-allowed band tables with
Sleeper's own bounds. There is no standard table to fall back on — two leagues
identical everywhere else can disagree about a shutout by ten points — so a
league that publishes a defence-affecting setting the module does not model is
refused outright rather than scored on the categories it recognised. IDP
settings are not a refusal: they score a linebacker, not the unit. The result
rides on `ScoringProfile.dst`, so every engine reads one answer.

**One anchor, and it is the opponent's implied team total.**
`core/startsit/dstProjection.ts` prices a defence on `total/2 + spread/2` —
the spread read from the defence's own team, negative when favoured, the same
convention `gameScript.ts` states — mapped through the league's own bands by a
monotone, saturating, deterministic curve. Realistic output: about 9.7 points
for a 13.5-point favourite against a weak offence, about 4.1 for a 13.5-point
underdog in a shootout.

Everything else is a bounded residual or an explanation, under one rule: **if
the market could already know it, the anchor already contains it.** The total is
in the anchor, so it is not a second input; defensive-unit quality is *why* the
anchor is low, so it is not an independent component; pace and line quality are
the same. What is allowed on top is a ±0.8 game-script residual for the *shape*
of a game rather than its size, a ±1.0 quarterback adjustment that is **zero
unless the news post-dates the line**, and a ±0.3 home-field nudge. Sacks and
takeaways are in the number — a league paying 2 a sack must project higher than
one paying nothing — but on league-wide baselines identical for every defence,
so they set the scale and can never reorder it.

**Unknown stays unknown.** No total, no spread, no projection. Not a league
average, not a replacement defence, not zero — the rule `projection.ts` was
written for, on the position most likely to break it, because with the anchor
gone the remaining components sum to a small number that sorts above nothing and
reads as a judgement.

**The Team phantom-DEF defect, fixed through the normal path.** `evaluatePlayer`
branches to a defence model on its first line; a rostered, scorable DST now
holds its slot like anybody else, and `no scorable player available for: DEF`
is gone. The second half of that defect was never reported: the current-lineup
total is shown only when every current starter can be scored, so an unscorable
defence blanked the comparison the whole screen is built on. The skill-position
path is byte-identical — asserted as a whole-object comparison, not promised.

**The Smart Trades invariant is now a rule rather than an accident.** A DST was
excluded from trades only because it was unscorable, and `tradeableFrom` drops
anything the engine could not score. Making one scorable removed the accident,
so two independent gates replace it: `needFor` returns a permanently `adequate`
need for DEF, taking it out of `hasNeed`, the need multiplier, `spareness`,
bench depth and every `fills_hole` rationale in one move; and `tradeableFrom`
excludes it explicitly, depending on it being a defence rather than on it being
unpriced. Tested against a genuinely scorable DST in the league shape where the
invariant is actually at risk. See `docs/SMART_TRADES.md`.

**Draft says nothing rather than something it will not act on.** The board has
ranked defences on ADP alone since `DEFENCE_WEIGHTS`; the alerts above it had
not caught up, so `Still need a starting DEF` sat in warn-red over a ranking
that explicitly refused to act on the same fact. Both that and the lopsided
`DEF depth is becoming more important` line are suppressed in one-defence
leagues. `Starting lineup is covered` is *not* fired in their place — it is a
claim about every slot, and a false reassurance is worse than the pressure being
removed. A league starting two or more defences keeps every warning: that is an
objective property of `RosterShape`, not a league-name exception.

**Streaming did not ship by accident.** A scorable defence makes the waiver scan
offer a better one over a rostered one most weeks, because the gap across a
slate clears the upgrade bar comfortably. Filling an *empty* DEF slot is kept —
it is the ordinary answer to an ordinary hole — and the weekly swap is switched
off deliberately in `waivers.ts`, because transaction cost, how long an add
survives and what it does to a playoff plan are the questions the next lane
exists to answer. `assessStreaming` remains written and unwired.

**The schedule foundation.** `nfl_schedule` (migration 0032) stores the nflverse
fixture list as two rows per game, one per team, upserted idempotently on
`(season, week, team)` so a truncated read leaves every row it did not mention
alone — a hole is indistinguishable from a bye to everything downstream. Byes
are derived rather than stored. `roof` is carried because it is a forecast;
`temp` and `wind` are deliberately not, because they are post-game observations
and reading one as a forecast would give this app a weather model that is
perfectly accurate about the past. **No new cron trigger**: it rides the
existing `0 9 * * *` tick in a try/catch of its own, behind a conditional GET
that answers 304 on nearly every morning of the season. Nothing on a
recommendation read path reads it in this lane — asserted, not promised.

**Free tier.** No new cron, no new provider, no read-path fetch, no paid source
and no user-facing backfill. The one new cost is one Vegas team-fetch per
rostered defence on the *refresh* path, which is unavoidable: a defence's whole
projection is the game's total and spread, and those arrive in the same answer
as the props. The Demo Mode bundle budget was raised 108KB → 115KB in this
commit with the reason attached, because the two new modules add ~2.2KB to a
chunk that had 0.4KB of headroom left.

## DST streaming and playoff planning

**The question this lane answers is not "which defence is best".** Making a
defence scorable made "somebody better is available" true almost every week —
the gap across a slate clears any upgrade bar comfortably — and that fact is not
advice. The useful question is whether the better defence is worth what taking
him costs: a transaction, a bench spot, and whatever that bench spot was going
to become. `core/dst/planner.ts` is the whole of it, and it answers in seven
states — `wait`, `add`, `hold`, `stream`, `stash`, `stream_and_stash`, `unknown`
— with `wait` first among them. **There is no assumption anywhere that a defence
must be rostered at all times.**

**Three things stop it churning, and they compose.** Replacement level is the
*median of the top few* available defences rather than the best of them, through
`assessStreaming` — written in the foundation lane, unwired until now, and used
rather than replaced. The churn bar is `MEANINGFUL_UPGRADE_GAIN`, the same 2.5
points every other add in this app has to clear, widening to 4 when either side
of the comparison is thin. And the roster spot is priced: `netGain = points
gained − what the slot was already earning`, in the same weekly points, from the
same `bench.ts` surplus the drop list is built from. A +3.5 defence does not beat
a bench player earning +4.

**A bench player who cannot be scored is never given a number.** `valueOfSlot`
returns a figure for everybody, including somebody it could not score at all —
for whom the figure is the optionality and bye-cover terms over a base of zero.
Passed on as a price that would make every marginal defence look free, so it is
turned back into null and the *bar* widens instead. The card says `costs a bench
spot — X cannot be scored, so what it costs is unknown`. That flier is exactly
the player this product's manager keeps the last slot for.

**Activation is game state, never a date.** Pre-draft is silent, decided from
the draft's own status: a league that drafts in week 2 is not behind. Post-draft,
advice activates inside a centralised 72-hour window before the next kickoff —
read from the stored fixture list, so it is the first thing in this app to put
`nfl_schedule` on a request path. The one exception is the schedule change a
reader has to act on early: a rostered defence with a bye inside two weeks opens
the window regardless, because a bye discovered on Saturday is a bye nobody can
cover. No kickoff known is treated as *outside* the window rather than inside
it — the cost of being quiet a day too long is far below the cost of telling
somebody to claim a defence for a game that has kicked off.

**Multi-week holds are two conditions, not one blended number.** The weekly gain
still has to clear the churn bar, *and* the horizon — this week's gain plus what
each defence is worth over the next three — must not be a net loss. Streaming
gives up the incumbent's schedule as well as taking the challenger's, and a
half-point edge on Sunday that costs two points a week for a month is the trade
every weekly comparison in fantasy football makes. With no outlook on either
side the second condition cannot fire: a hold is never argued from a schedule
this app has not read.

**The forward outlook says what its anchor is.** `core/dst/outlook.ts` values a
future week on a real line where the market has reached it, and otherwise on the
opponent's **mean implied team total across the games already priced** — a
measurement of an offence, not a forecast of a fixture, marked low confidence
wherever it is used and refused below three games. Neither available means the
week is *unrated* and left out of the mean; an unknown week is not a neutral
week, and a bye is a missing week rather than a terrible opponent. **No future
Vegas line is invented.** `outlookDst` is `projectDst`'s own arithmetic over a
different anchor — extracted, not reimplemented — with the game-script residual
*absent* rather than zeroed, because there is no spread, and confidence capped at
`medium` however good the inputs are.

**A playoff stash has to beat the wire, not beat zero.** The alternative to
carrying a second defence into week 15 is not fielding nothing; it is streaming
whatever is free that week. So the arithmetic is stated: per-week gain over
replacement level, amortised by playoff weeks played over weeks carried, minus
the bench spot's own weekly value at a 1.5× premium for a player you are not
starting. The gate is the app's existing `playoffEmphasis.weight >= 0.5`, which
is zero for most of the year and zero for a team not heading there — and the
weeks are the league's own `playoff_week_start`, through the one reader the
`plan` endpoint now shares, never a hard-coded 15–17.

**Byes.** A defence on a bye gets a one-week fill, flagged `temporary`, with the
incumbent still the incumbent — treating a week off as an upgrade would drop a
defence held all season. A bye two weeks out surfaces early enough to act on.
And `plan`'s bye outlook, which reported `null` for every player and said so,
now derives byes from the stored fixture list: a team with no rows reports no
bye rather than thirteen.

**One owner for the DEF row.** The generic waiver scan's DEF-over-DEF guard
stays exactly as the foundation lane wrote it — it was never the problem. What
changed is the *empty* DEF slot: the scan offered a defence for it, which was
right while nothing modelled the alternative, and would now contradict a planner
saying `Wait — no DST needed yet` on the same screen. So the planner wins
wherever it has an opinion and the generic row survives only when no plan could
be computed at all. Team and Waivers read one response, so they cannot diverge.

**Home and road, finally.** Written and dormant in the foundation lane because
`vegas_events.home_team` means "a team we asked about" rather than "the home
side" — the vocabulary trap that had every stored spread pointing the wrong way.
`nfl_schedule` carries the real flag. The term is ±0.3, enough to break a tie and
never enough to decide one, and it is asserted that a skill player evaluated with
the flag is byte-identical to one without it. **The quarterback residual stays at
zero**: it requires news that post-dates a line, no caller supplies a trustworthy
freshness source, and a forced one would count an injury twice.

**Best ball, no DEF, two DEF.** Best ball is silent — there is no weekly add,
drop or start to advise on. A league that starts no defence gets nothing, before
any read at all. A league starting two or more is answered on its own terms: the
slots are filled and never streamed, because one-defence philosophy applied to
two slots leaves one of them empty most Sundays. All three read off `RosterShape`
and Sleeper's own `best_ball` flag; there are no league-name exceptions.

**One line, not a dashboard.** Six weeks of schedule, a bench spot's opportunity
cost and a playoff carry, shown as one row on Team and one above the Waivers
board — the same words on both, tap for why, tap again for the evidence. There
is deliberately no Defense Strategy screen, no chart, and no context-free DST
ranking. A `hold` or a `wait` draws no board row on purpose: there is nobody to
add, and the answer is *none, and here is why*.

**Free tier.** Three bounded D1 reads on top of what the waiver scan already
loads — thirty-two fixtures for the week, about a hundred rows for the planner's
teams across its weeks, and one row per team of implied totals aggregated in
SQL. No new cron, no new provider, no read-path fetch, no backfill, and not one
extra Vegas entity: every number here comes out of rows an earlier refresh
already paid for. No FAAB model was built for a two-dollar add, and a defence row
is excluded from the board's "still to arrive" line rather than promising a
column that is not coming.

## Milestone — a face on the expanded player (done)

Sleeper publishes a portrait per player at a path its own clients use and its
API never documents. A probe of 91 players resolved 80 of them, 78 distinct, no
redirects, ~30 kB median, cached for 31 days. This puts one on the expanded
player sheet at 64px and nowhere else, and everything below is about keeping
that from costing anything.

**The whole feature is optional, structurally.** `playerHeadshotUrl` returns
`string | null`; `PlayerFace` treats a 403, a 404, a network error and an
offline first paint as the same ordinary outcome and draws deterministic
initials in the same box, on the same circle, on the same ground. No retry, no
toast, no banner, no logging, no broken-image chrome — the `<img>` is unmounted
the instant it errors. Twelve percent of probed players have no portrait, so
this is the normal path rather than the sad one, and the app is fully usable
with every image on it missing.

**Failure is remembered per URL, at module scope.** Per-instance would have let
one missing portrait blank out whoever React drew into that component next —
the bug `TeamLogo` already avoids the same way. Module scope is the second
half: a rookie with no portrait is opened, closed and opened again, and a
per-mount memory would re-request an image that is not going to exist this week.
`e2e/player-face.spec.ts` asserts both directions — one request for a URL known
to be missing, and a full attempt for the next player's.

**Nothing about this costs the deployment a request.** The path is
`browser → sleepercdn.com` and never through the Worker: no API route, no proxy
fetch, no D1/KV/R2, no change to the app's own request count when a reader
looks at a player, and an incremental Cloudflare cost of effectively zero. That
is the entire reason hot-linking was accepted here after being rejected for club
marks, so `tests/playerHeadshotSurfaces.test.ts` fails if a server or Worker
module ever names the host, if the router grows a headshot route, if a migration
stores an image, or if a storage binding appears.

**Only the sheet draws one, and the protected lists are named rather than
merely omitted.** Matchup, Draft, Waivers, the Players index and the compact
Smart Trades rows stay image-free by decision — on Matchup at 390px a face takes
the name column from about 85px to about 60px, and a shortened name is
information traded for decoration. The source scan holds the files; the e2e
holds the running app, which never requests a portrait from a list.

**The 64px face cost the sheet's one-line header more than it was worth, and
that is measured rather than argued.** The line — pill, club, name, status —
carried about twenty pixels of slack; the face wanted sixty-eight. At 360px it
truncated nineteen of twenty-two seeded names, `Julian Reyes` down to
`Julian…`, where none truncated before; at 375px, eleven. No size was free —
even 40px cost ten names. So the height the portrait already forces is now
spent: the name takes a line of its own beside the face and the marks that
qualify him take the one under it, which is `PlayerPage`'s own arrangement for
the same player. At 430, 390, 375 and 360, no name truncates at all, and the
header is exactly 64px on every one of them. `e2e/player-face.spec.ts` walks
every seeded player at each width and requires zero.

**Team is deferred, and the discovery's own gate is why.** It expected a 28px
face inside the 44px row, and the row height does hold. But a prototype
measured at all four widths introduced truncation at 390 (`Cal Whitfield`, 28px
short, from none), tripled it at 375 (3px → 43px) and at 360 (18px → 58px) — on
the row carrying the most tags, which is the row a reader most needs to read —
and left the identity column of a populated slot indented 32px from the empty
slots above it, so the leading edge no longer lines up down the screen. Two of
the seven conditions fail. Team keeps its club mark and no portrait.

**A defence is held out twice, and the second rule is the one that matters.**
Live Sleeper keys defences by the club abbreviation, so refusing a non-numeric
id already excludes every defence in production data. This repository's own seed
does not: `1030` is Jacksonville's. So `playerHeadshotUrl` takes the position as
well and refuses `DEF` whatever the id looks like — a rule that holds only
because one provider formats its keys a certain way is a rule waiting to be
broken by a fixture, and the fixture landed in the same week.

**The thumb variant is not used.** It saves roughly 7 kB on an asset the browser
holds for a month, on one image per opened card, in exchange for a second
undocumented path that can rot independently of the first.

## Polish — one fact, one home, and the eight pixels under a thumb (done)

A bounded finishing pass, deliberately narrow: four demonstrable defects, no
feature invention, and nothing taken from the DST streaming or headshot lanes.

**`Lineup impact` was the recommendation, printed a third time.** The Matchup
screen answers the lineup question above the fold now, and `Best move` explains
itself in a sheet of its own. `Behind the odds` was still restating the same
`decision.best` near its bottom — the same swap, the same `44% → 48%`, the same
sentence — four sections below where the reader had already met it and under a
heading about something else. The duplicated half is gone. The half that was
only ever there stays: `decision.note` tells the three empty cases apart, and
the screen's own footnote says one thing for all three, so `Every remaining
lineup decision is already locked` still has exactly one home and it is this
one. The section is keyed on the note rather than on the absence of a move,
which is the same condition in the terms the block is about. **No model
change**: `core/matchup/decision.ts` is untouched, the 0.02 threshold is
untouched, and `tests/matchup.bestMove.test.ts` still holds.

**One product name.** A snapshot import that was refused for looking like a
projection table told the reader "Junculator did not import it as Preseason
Vegas". Every other surface in the app — the title, the manifest, the install
copy, the Matchup degraded notice, Setup's own prose — says `Fantasy Analyst`,
and the sibling refusal two branches up already said `Nothing was imported as
Preseason Vegas`. That is now what both say. Nothing else was renamed: the
package is still `fantasy-analyst`, the Home Screen short name is still
`Fantasy`, and `The Junculator` remains what it always was — a league name in
the rollover fixtures, not a product.

**The badges that were replaced, deleted rather than left reachable.**
`components/decisions.tsx` still carried `WaitTag` (the `Take Now` /
`can probably wait` chips), `TierCliffTag`, `MyGuyStars`, `Verdict`,
`draftVerdict` and `saidAlready`. Nothing imports any of them. Each was
superseded rather than merely dropped — the tier cliff is drawn by
`player-row-cliff` on the board, which knows the row's width; the heart is
`MyGuyControl`; a verdict belongs to the weekly card — so the file kept only
what something on screen still calls, and the five stylesheet rules that went
dead with them (`.tag-take`, `.tag-avoid`, `.tag-cliff`, `.tag-risky`,
`.verdict-risky`) went too. `.tag-calm`, `.tag-star`, `.tag-warn` and
`.tag-urgent` stayed, because the Team screen still draws them. **No model
change**: every judgement behind those badges is still computed and still
travels on the API.

**Eight pixels, and then fourteen.** §5 of the design system says a touch target
stays 44px even when the visible control is smaller, and `.search-toggle`
implements that with an inset `::after` and documents it. Two controls beside it
did not. `.icon-btn` — the draft-board glyph, the board's own close, the install
prompt's dismiss — measured 44×36 while its comment claimed "a full tap target".
The three sort segments measured 30px tall. Both now carry the same `::after`,
vertically only: sideways would reach under the neighbour in the same track and
re-sort the board the wrong way. **Not one pixel of any of them moved** — the
dense bar is exactly as dense as it was. Hit-tested with `elementFromPoint` at
430, 390, 375 and 360 rather than measured as a box, because a box measurement
is what passed on the day the target was short.

**Cost.** App JS 126.4kB → 126.3kB gzipped, total render weight 142.0kB →
141.9kB, both inside budget; two CSS rules added, four removed. No new
dependency, request path, cron or data source.

**Resynced against both parallel lanes.** DST streaming (#175) and the expanded
player's face (#177) landed while this was being gated, and both touch
`styles.css`. One real collision: the defence planner adopted `.tag-take` for
`Add`, `Stream` and `Stream + stash`, which this pass had deleted as dead with
the `Take Now` badge that was its only previous wearer. The rule is restored and
the comment above it now says who wears it. `.tag-avoid`, `.tag-cliff`,
`.tag-risky` and `.verdict-risky` were re-checked against the merged tree and
are still unreferenced, so those four removals stand. `common.tsx` was
deliberately left alone in this pass because the headshot lane owned it — it
edited that file, so the restraint was load-bearing rather than theoretical.

## Milestone — the waiver plan, wired (done)

The claim planner shipped in #179 as core intelligence with nothing calling it,
which was the right way to build it and a strange thing to leave: the app knew
who to add, what to bid, who to drop and in what order to enter the claims, and
the Waivers screen still answered only the first half. This wires it, and the
whole of the wiring is `core/waivers/claimPlan.ts` — two functions, one call
from `app.ts` and one from the demo runtime.

**The gather computes nothing.** `planWaiversFor` takes the objects the waivers
handler is already holding when it is about to reply — the roster inputs it just
scored, the bounded wire it just scanned, the advice it is about to send, the
bids `core/faab` just priced, the IR slots and the wallet — and calls
`planWaiverClaims` once. No provider is touched, no player rescored, no price
recomputed. It rebuilds the board with `buildWaiverBoard`, the same pure function
the screen calls, so the targets the planner ranks are in the order the reader is
looking at; a second ordering would have been a second opinion about who is worth
chasing, arrived at with strictly less information. `PlannerBid` is a structural
subset of the priced bid, so the seam passes a reference and "the displayed bid
is the recommended bid" is a fact about the types rather than a thing to keep
true by hand.

**The wording is the integration's, and it is written once.** The planner emits
`WaiverReasonCode` values and no prose, deliberately, because a plan is read
three ways and prose written there would be prose written for whichever of the
three was imagined first. `describeWaiverPlan` is the only place in the app that
turns a code into a sentence. It runs on the server, beside the arithmetic that
justifies it, which is why the browser paid ~0.7 kB for a feature whose model is
nine files — and the same reason the DST planner writes its own headline.

**The card is an ordered list and nothing on it is a button.** A plan naming one
target twice and one drop twice is exactly right and looks exactly like a
mistake, so `Only if 1 loses` is on the card and not behind **See Why** — a
reader who cannot see it deletes one of the two lines, and which one they delete
decides whether they land the player. The numbering is the instruction, so it is
a real `<ol>` marker rather than a printed digit; the first attempt gave the
`li` a `display: flex` and silently deleted every number on the card, which a
screenshot caught and no assertion would have. One `See why`, at 44px, and no
control anywhere on the screen that could transact.

**An empty plan surfaces only when it says something the board does not.** A
quiet week is already `Nothing available beats what you already have` four
pixels below; `No safe drop for this upgrade` is a different fact — a roster
that needs a trade rather than a better target — and earns its line. A roster
the engine cannot score keeps its adds and its bids and says the cut is the
reader's, and never leaves a blank where a name should be, because a blank reads
as *no cut needed*.

**Two boundaries were held rather than blurred.** The defence is excluded inside
`planWaiverClaims`, so the generic plan can never contradict the DST planner on
the same screen — and because the model reports a rostered defence as
`core_value`, the sheet recovers the position from the drop ranking and says *a
defence, which belongs to the defence plan* rather than filing it under "worth
too much to cut". And the add-specific cut is drawn on a player's own detail
sheet rather than on the compact row, because a row four lines under the plan
card would be repeating it; it reaches the targets the plan had no room for,
which is what makes it worth a line at all. The plan and the sheet are
reconciled inside the seam — they rank on different things underneath and would
otherwise legitimately name two different cuts for one add.

**Demo Mode calls the same function and pays for it.** The demo waivers handler
adds the one line `app.ts` adds, on the scenario's own clock, so a scenario and a
real league cannot draw two different shapes of the same screen. That pulls the
whole planner into the demo chunk for ~9 kB and the budget was raised from 115 kB
to 124 kB in the same commit with the reason recorded — a Demo Mode whose Waivers
screen is missing its headline card is a worse demo than an ideal one is a better
bundle, and reimplementing the plan for the demo would be exactly the second
model this repository refuses to keep honest. The fixtures themselves are
untouched; staging a realistic A → C, B → C, B → D scenario belongs to the Demo
refresh.

Thirty-eight unit and integration tests over the seam and the endpoint, and
twenty-one browser tests over the card, the sheet, the honest endings, a
forty-five-character name, a four-figure bid and a one-dollar one, at all four
widths.

## Milestone — the face on every focused player, and nowhere else (done)

The portrait shipped on one surface: the expanded player card, reached from
Players and from Smart Trades. This puts it on every *other* place the app opens
a single player on purpose, and takes the opportunity to make that a fact about
one component rather than a convention four files are trusted to keep.

**Three more routes, and not one new piece of portrait markup.** Team and
Matchup open a starter or a lineup row into the weekly card; Team and Waivers
open a candidate into the waiver detail. Both of those sheets headed themselves
with the player's name as a bare string and printed his pill and club as the
first line of their *body*. They now render `PlayerSheetTitle` — the header the
shared card already drew, lifted into `common.tsx` — so the same six routes
produce one header: face, name, and the marks that qualify him underneath. Smart
Trades needed nothing at all; its focused player has always been the shared
card, and its *offer* sheet is about a trade rather than a player, so it stays
image-free with no face grid.

**`PlayerFace` is now rendered in exactly one file, and that is the invariant.**
The old rule was a list of approved screens, which was the right shape while one
screen had a face and would have said nothing by the sixth. What replaced it is
stronger and does not decay: `tests/playerHeadshotSurfaces.test.ts` fails if any
file but `common.tsx` renders a portrait, fails if one of the three focused files
stops rendering the shared header, and fails if a protected surface grows either.
The size, the eager load, the empty `alt`, the defence exclusion and the initials
fallback are decided once — so a seventh surface gets all five by calling the
header, and cannot get four of them by copying markup.

**The identity marks moved rather than doubled.** Removing `PositionBadge` from
the weekly card's and the waiver detail's first body line is what keeps this from
costing height: the header above them now carries the same pill and club beside
the name, so those cards are not taller and do not say anything twice. What is
left in the band under the header is what it was always for — how sure the
lineup is, and what it projects.

**Availability is deliberately not repeated in those two headers.** The shared
card has a clean Sleeper designation and shows the code. The weekly card and the
waiver detail carry availability as a phrase — `Questionable · hamstring ·
limited → full` — already printed in words on a line of their own body, and
abbreviating the same fact to `Q` two centimetres above it would be one card
speaking two vocabularies.

**Draft did not ship a face, and that is a measurement rather than an
omission.** Its expanded player card is the one expanded detail in the app that
is not a sheet: it unfolds inside the board, and it is budgeted at about two and
a half collapsed rows precisely so the board it opened from stays on screen. Both
placements were prototyped and measured at 360 and 390. Beside the content, the
working — `Sleeper ADP · DOG ADP · Pick · Val`, which the card is arranged to
keep on one line at 360px — wraps from 15px to 31px on four of five seeded cards,
at 40px as well as at 64px. Above the content costs about 30px on a card whose
ceiling has about 36px left. The widest seeded card goes from 2.53x a collapsed
row to 2.80x, against a 3x ceiling `e2e/draft-card.spec.ts` enforces. The rollout
brief's own rule is that decision content wins where 64px will not fit cleanly,
so Draft keeps the club mark, the status tag, the star and the whole of its
working. It is on the protected list with those numbers attached rather than
quietly missing.

**The dense lists are still image-free, and each page load proves both halves.**
`e2e/player-face-focused.spec.ts` asserts on the same load that the Team roster,
the Matchup lineups with the bench opened, and the waivers board requested zero
portraits *and* that the sheet each of them opens requested exactly one, keyed on
the player the reader tapped. A rule that only forbids is satisfied by deleting
the feature; a rule that only requires is satisfied by putting a face on every
row. It also re-checks, per surface, that the header is 64px tall and that the
name beside it loses no letter — the measurement that decided the header's shape
in the first place, now made on three more screens.

**Nothing about the cost story changed, because nothing about the path did.**
Still `browser → sleepercdn.com`, still no Worker subrequest, no D1/KV/R2, no API
route, no migration, no service worker and no list prefetch. One image per opened
card, per player, cached by the browser for Sleeper's 31 days. JS is 126.4 kB
gzipped against a 140 kB budget and CSS 14.1 kB against 20 kB — the stylesheet
did not grow at all, because the header this rolled out to three more surfaces is
the one the shared card was already using.

## The browser gate is sharded (done)

The item below this used to read "shard the WebKit matrix — this is now
blocking, not recommended". It is done, and this is what it was blocking on.

**Before**, from `main` at `a5448ef` — four widths, the whole suite on one
runner each, against a step budget of thirty minutes:

| width | testing | job |
|---|---|---|
| `webkit-small-360` | 19m24s | 20m19s |
| `webkit-iphone-375` | 23m12s | 23m52s |
| `webkit-iphone-390` | 23m36s | 24m16s |
| `webkit-iphone-430` | **25m03s** | 25m44s |

Every width green, nothing flaky, and 430 inside five minutes of a ceiling that
had already been raised three times. The number had stopped measuring a stuck
browser and started measuring how big the suite is, which is the failure mode
`ci.yml` spends several paragraphs warning about.

**After**: each width runs across three runners as `--shard=n/3`. Twelve jobs
rather than four, named `webkit-iphone-430 (2/3)` so a red tick says which phone
and which third before anything is opened. The test step's budget is eighteen
minutes and the job ceiling thirty-two, both down for the first time.

Measured on the first sharded run, all twelve green:

| width | 1/3 | 2/3 | 3/3 |
|---|---|---|---|
| `webkit-iphone-430` | **10m11s** | 8m19s | 6m15s |
| `webkit-iphone-390` | 9m37s | 7m50s | 6m58s |
| `webkit-iphone-375` | 9m25s | 7m46s | 5m50s |
| `webkit-small-360` | 9m29s | 7m41s | 6m46s |

**The whole workflow went from 25m47s to 10m59s.** Expect a steady state of six
to ten minutes a shard. The eighteen-minute budget is 1.77× the worst shard
measured, so it covers the half-again-slower runner this repo has met twice and
still means "stuck" rather than "big". Aggregate runner time rose about 5% —
three server boots per width instead of one, which is what buys the wall clock.

Shard 1 is the slowest at every width, consistently rather than randomly: that
is the count-versus-time imbalance below, showing up exactly where predicted.

Nothing was dropped to get there. All four widths still run, WebKit is still
authoritative, every spec file still runs at every width, no assertion moved and
no test is skipped or retried that was not before. Playwright splits by whole
spec file — `fullyParallel: false` makes a file the unit — so a shard is a set
of complete files in their own order against their own freshly seeded server,
which is stricter isolation than the one server a whole width used to share, not
looser. A new spec file needs nothing added anywhere.

**Three, not two or four.** Playwright balances shards by test count, so the
question worth measuring is what that does to time. Against the real per-file
durations of a full local run, the slowest shard carries 54% of the suite at two
shards, 42% at three, 35% at four. Two leaves the slowest width near fourteen
minutes — not far enough from the ceiling to keep this conversation from
happening again. Four buys three more minutes for a third again as many runners
and a worse spread. Three puts the slowest shard of the slowest width at roughly
eleven minutes, which is what eighteen is 1.6× of.

**Measured rather than projected**, on the fallback engine at 360 locally, where
the whole suite takes 14.1 minutes on one runner:

| shard | tests | result | wall |
|---|---|---|---|
| 1/3 | 225 | all passed | 5m54s |
| 2/3 | 227 | all passed | 4m15s |
| 3/3 | 199 | 198 passed, 1 known Chromium-360 failure | 4m09s |

Slowest shard against whole suite: **2.4× less wall clock**, for 1.4% more total
runner time — three server boots instead of one, at about 17 seconds each.

**Coverage is exact, and checked rather than assumed.** For each of the four
WebKit widths, the union of the three shard listings is byte-identical to the
unsharded listing: 652 tests, no test in two shards, none missing. The only
entry that repeats is the `setup` project's login, which each shard needs
because each shard has its own server.

**No order dependence was exposed.** Every shard passes standing alone. (One run
did show a `draft-queue-order` failure; it was a rebuild running against the
live server mid-suite, and it did not reproduce once the box was quiet. Recorded
because a shard failure that turns out to be the harness is worth knowing about
before it is diagnosed as a test.)

The wider question the old item raised — which specs overlap, and which of them
need all four widths rather than one — is deliberately still open. Sharding buys
the headroom to answer it without a deadline; the answer is a coverage decision
about the product and this lane changed no product behaviour at all.

## Milestone — the final UX simplification pass (done)

Five approved changes from the decision-clarity audit, and nothing else. The
lane is subtractive by design: **default screen = answer first, tap =
explanation, deeper tap = evidence**, applied to the handful of screens that
still had it the other way round. No model, threshold, ranking or calculation
was touched anywhere in it.

**Team answers before it inventories.** `Changes to consider` used to sit three
sections down — under eight recommended starters and a folded bench — so the
screen showed a roster the reader already owns before saying whether anything
needed doing with it. It is now the first thing under the controls, with the
lineup below it as its evidence. Same card, same `lineup` object, same swap,
same threshold, same disclosure; the defence line and the waiver teaser stay
where they were, because three cards of equal weight at the top of a screen mean
there is no primary recommendation on it at all.

**Trades leads with trades.** The buy/sell/hold inventory — every player the
evidence ledger has an opinion about, which runs to dozens of hold rows — is
behind `Explore the market`, closed. The bilateral offers are what is left open,
which is the only part of the screen that answers *what should I offer, and to
whom*. Nothing was deleted, truncated or re-sorted: the fold is asserted against
`/api/trades` itself, section by section and player by player. The one
conditional in it is deliberate — with no offers to compete with, the fold opens
by itself, because a Trades screen whose entire content is one closed control is
a worse answer than the research it is hiding.

**Matchup says hold out loud.** `No lineup change recommended`, a grey footnote
on the `Starters` heading, is now `Best move: Hold your lineup` in the same slot
and the same shape as a swap. Holding is what the engine is recommending most
weeks, and a reader who finds nothing where the answer lives reads "the app has
nothing to say" and changes something nobody suggested. The three causes are not
flattened: `decision.note` still tells locked, nobody-legal and nothing-better
apart, and it is one tap in behind the row as well as in `Behind the odds`. A
degraded forecast is emphatically *not* this — it stays a footnote, because
"we cannot say" turned into "hold" would be advice invented out of a failure.

**One name per number.** Players' row and player page said `21d` for a field the
Trades row has always called `30d` — and `21d` was simply false:
`RECENCY_WINDOWS.last30` has been thirty days since the window was widened and
the label never followed. Renamed, along with `Lifetime` → `Life` in the window
grid that sat a few hundred pixels under a band already calling it `Life`. No
value, weighting, ordering or aggregation changed; `README.md` and
`docs/ARCHITECTURE.md` were carrying the same stale number and were corrected
with it.

**Waivers instructs rather than explains.** The card's closing sentence — `Enter
them in this order — Sleeper runs claims top to bottom, and a claim whose drop is
already gone does not run.` — wrapped to two lines under the claims on the one
card in this app a reader is copying into another app. What they have to *do* is
four words, and they are now above the list they introduce; why the order matters
is the same fact every week and is behind `See why` under `Why the order
matters`. The per-claim qualifier stays inline where it was: `Only if 1 loses` is
the whole of what stops a repeated line reading as a mistake, and §8 asks for
shorter copy and unambiguous copy in the same breath.

**Draft was left alone, and there is now a fence saying so.** The audit proposed
removing `DOG` and `PTS`; the user rejected it, because Draft is where players
are compared in seconds while on the clock. `e2e/draft-market-delta.spec.ts`
asserts both are on the *collapsed* row — `PTS` against a board answered with
projections, so the claim is required rather than merely permitted — and that no
`Take now` / `Can wait` verdict has crept back.

**One fold, not two.** `Fold` in `native.tsx` is the folded bench's control with
the word "bench" taken out of it, sharing the bench's stylesheet rules rather
than copying them. Its children are not rendered while it is shut — a
`<details>` holding a hundred market rows would cost the page every one of them
in order to hide them — and its state belongs to the screen, because Trades
pushes a player's page by returning a different tree and a fold holding its own
state came back closed from every Back.

**What was deliberately not done.** Players' ordinal rank was inspected and
left: the audit floated removing it and the user did not approve it, it is the
column the list is sorted by, and the row's own `ADP` beside it is what makes
the app's own order legible as a *disagreement* with the market rather than as a
number. Nothing about Draft, the scoreboard, the win-probability model, the
lineup optimiser, trade valuation or offer generation was touched.

## Recommended next work

0. **Watch the defence planner through one real week.** DST is complete enough
   to archive as a product lane: every state it can be in is tested and every
   surface it reaches is drawn. What a preseason league cannot show is the two
   things that need a live season underneath them — whether the 72-hour window
   lands where a reader expects it once real kickoffs are stored, and how much
   of a future week is actually rated from a *line* rather than from form in
   the first fortnight, when no team has the three priced games the fallback
   requires. Both degrade honestly and both are visible in the plan's own
   `confidence` and notes; neither can be judged until September.
0. **Watch one real waiver run.** The FAAB layer is built and tested against
   constructed transactions; what a preseason league cannot show is what
   Sleeper's `transactions/{week}` actually returns for a live waiver run —
   specifically how many other managers' failed claims come back, which is the
   one input `losingBidsComplete` is honest about being unable to verify.
1. **Enable SportsGameOdds and watch one real Sunday.** The adapter is written
   and tested against live payloads; what a preseason event could not show is
   whether regular-season games carry `receptions` and anytime-touchdown
   markets, and what a full slate costs against 2,500 objects a month.
2. **Watch the usage feed through the first real week of the season.** The
   pipeline is built, tested and deployed, but while `stats_player_week_2026.csv`
   is a 404 the 304 path and a real ingest cannot run in production. What the
   first published file will show is the mapped share against the injury feed's
   98.9%, and the ingest's real CPU cost on Workers rather than in Node.
3. **After the first real newsletters arrive**, read the coverage report and add
   the missing phrase families. This is the single highest-value improvement to
   tally quality.
3. **Draft-weight tuning UI**, so the market-value vs personal-signal balance is
   adjustable without a deploy.
4. **Tier visualisation on the draft board** — the tier map already computes
   the ladder, the gaps and the ratios per position; nothing draws them.
5. **Re-reading everything at once**, rather than one newsletter at a time.
   Worth doing only once real issues have accumulated.
6. **Decide which specs need all four widths.** Sharding is done — see "the
   browser gate is sharded" above — and it bought the headroom, but it did not
   answer the question that item raised alongside it. Every spec in `e2e/` runs
   at every width by convention, and a good share of them assert content rather
   than layout; a content assertion does not get more true at 430 than at 360.
   Splitting the suite into what is genuinely width-sensitive and what is not
   would cut the gate again without adding a runner. It is a coverage decision
   rather than a workflow one, which is why sharding went first, and there is no
   deadline on it now: the next feature to add browser tests can add them.

## Milestone — the demo refresh, for the launch showcase (done)

Demo Mode was built before half of what it now has to demonstrate. It showed a
league that started no defence, a week six written down twice with two different
slates in it, a room whose managers were all identically anonymous, and a draft
board whose `PTS` column was empty on every row. Every one of those was a fixture
gap rather than a product one, and each made the demo a demonstration of a
slightly different product from the deployed one.

This lane is fixture work, one production seam and no new features. No model,
threshold, ranking or piece of copy was changed anywhere in it.

**One slate, read by everything.** `fixtures/slate.ts` states the season's
games once — who plays whom, when each window kicks off, who is at home, what
the book made of it — and the weekly market, the defence projections, the
matchup scoreboard and the schedule the DST outlook walks three weeks forward
all read it. Week six had been stated twice, by the lineup fixtures and by the
matchup fixtures, with different opponents, different kickoffs and a tight end on
a bye in one telling and playing in the other. The kickoffs are now real wall
clocks rather than offsets from whoever is reading: a Thursday night game, a
London game, one o'clock, four o'clock and the night game. That Thursday game is
load-bearing — the first kickoff of a week is the deadline every piece of weekly
advice is measured against, and without one in the fixture every waiver scenario
sat outside the defence planner's seventy-two-hour action window and the `DEF`
row went quiet for a reason that was not about defences at all.

**The league starts a defence.** Sixteen of them, twelve rostered and four on the
wire. The reader's own unit is a comfortable home favourite in week six and a
touchdown-and-a-half underdog in Kansas City in week seven, so `No clear upgrade`
on the Sunday and `Stream PHI over DEN · +3.4` on the Tuesday are two readings of
one schedule by `core/dst/planner.ts` rather than two fixtures. The DST plan
reaches the demo through the same code the deployment uses: the assembly moved
out of `server/services/dstPlanService.ts` into `core/dst/assemble.ts` behind a
`DstPlanSources` interface — the same move the draft board and the matchup made
before it — and the service keeps `buildDstPlan(db, request)` and its three D1
reads. `readFinalWeek` and `playoffContextFor` moved to `core/league/planning.ts`
for the same reason, and both are re-exported where they were.

**A league with a history.** `fixtures/ledger.ts` writes down two seasons of
this room's transactions in Sleeper's own shape — claims that won, claims that
lost, free-agent adds and five trades — and `runtime/history.ts` runs the same
four engines the nightly backfill runs over them. The Waivers board now names
the rivals who are short at the position and says what they have paid before;
the pressure column reports what those particular managers actually do, which is
allowed to disagree with what they need; and a Smart Trades offer carries the
partner's own record. The previous limitation said a demo must not state a
tendency, and that still holds: the fixture states transactions, and
`buildTransactionProfiles`, `buildTradeTendencies` and `readManagerTendencies`
state the tendencies.

The ledger is also the single source for the money. The spend on each roster and
the league's price summary are two readings of one list now, where they used to
be two hand-written tables with nothing connecting them — a demo could have
shown a room that had spent $500 between them while claiming a typical winning
bid of $2, and no test would have caught it. The week-seven run is in the ledger
too, so Wednesday morning holds the player Tuesday's plan recommended, at the
price it recommended, with the player it named cut.

**The claim planner has a scenario worth showing.** The Tuesday wire now
produces the three-claim contingency the plan was built for — add A, then the
same drop again for B in case A loses, then B on a different drop in case A
lands — with the wallet covering both claims that can land together. The plan is
the real planner's; the fixtures were tuned until the *scenario* was interesting
rather than until the output was.

**Two things a demo still cannot show, and both are deliberate.** A fixture
player id is not a Sleeper player id, so no portrait exists to request and the
focused view draws its deterministic initials — the alternative being two
hundred requests that can only 404, or a bundled photo pack. And nothing here
invents a newsletter excerpt, which leaves the evidence timeline empty exactly
as it was.

**Realism.** Every club is real and every person is invented. The teams are the
thirty-two actual NFL clubs, because a reader has to recognise a slate to judge
whether the advice about it is sensible; the names on the players are written in
the idiom of an NFL roster and belong to nobody, because the fixtures are full of
claims — a role falling apart, a hamstring, a manager who overpays — and
attaching an invented claim to a real professional is the one kind of realism a
fixture must not buy.

## The release path is gated, identified and reversible (done)

Production used to be deployed by `push: main`. Authoritative CI ran from the
same push, in parallel — so the deploy and the strongest gate for the same
commit started at the same moment and raced, and a commit that broke a phone at
360 could be live before the runner that would have said so had finished
installing its browser. The window was the length of the browser suite: about
eleven minutes since sharding, twenty-five before it.

Production also could not say what it was running, and a rollback meant reverting
on main and waiting for the whole pipeline again.

**Now:**

```
CI passes for a SHA -> Deploy checks that SHA is still main's head
                    -> Release checks out that SHA, stamps it, builds, deploys
                    -> production reports it at /api/health
                    -> Smoke asserts production is answering as that SHA
```

Four workflows where there were two. `deploy.yml` is triggered by CI's
*completion* on main and deploys `github.event.workflow_run.head_sha` — CI's own
report of what it validated — rather than whatever main points at by then.
`release.yml` is the single deploy implementation, callable only, and it refuses
anything that is not a full 40-character commit id and refuses again if the
checkout does not match it. `rollback.yml` is the one manual path to production:
it takes a revision, resolves it, refuses one that was never on main, and deploys
exactly that. `smoke.yml` is now *called* with the revision it is meant to be
reporting on instead of being triggered by "a deploy finished", because the
latter checks whatever is live when it gets a runner — which a second release can
have changed underneath it.

**Production identifies itself.** `wrangler.toml` carries `RELEASE_SHA`, the
release stamps it in the step before the build, and `/api/health` answers
`{"ok":true,"service":"fantasy-analyst","release":{"gitSha":"…"}}`. Nothing is
looked up at runtime: no GitHub API call, no row in D1. A deployment that did not
come from the release path says `unknown` rather than a stale SHA, and
`scripts/check-release-sha.mjs` compares expected against actual for the deploy,
for smoke, and for anyone with a terminal.

**When main moves during CI** — A merges, B merges before A's CI finishes —
whichever revision is main's head when its own CI passes is the one that
deploys; the other stands down and says so. The cost is written down in
`docs/RELEASE.md`: if A is superseded and B's CI then fails, production stays on
the revision before A, which is behind main and is a revision that passed CI.

**Migrations are the part that does not roll back**, and pretending otherwise
with invented down migrations would be worse than saying so. The policy is
expand / contract, and `tests/release.migrations.test.ts` enforces the half that
can be enforced: a migration that drops, renames or deletes has to carry a
`-- contract:` line saying why the rollback window has passed. Two migrations
predate the policy and are listed by name rather than exempted by a rule.

**Nothing about the gate itself changed.** Typecheck, unit and integration,
build, perf budget, wrangler dry-run, and WebKit at 430/390/375/360 across three
shards all run exactly as before; `tests/release.workflows.test.ts` asserts the
matrix and both browser timeouts so this lane cannot be the reason confidence
drops. No fantasy model, screen or scoring path was touched.

## Milestone — Review moves into Settings (done)

**Review is not a destination any more.** The bottom bar carried six
destinations and one of them was a queue of housekeeping: newsletter items the
classifier could not settle, and names the matcher could not place. Real work,
and worth doing — but done occasionally, by the one person who owns the league,
at no particular moment. It was spending a sixth of the most valuable strip of
glass in the app beside the five destinations somebody opens this app on a
Sunday morning to *decide* something with.

It is now a row in Setup, under *This app*, opening the same screen it always
did as a pushed panel with its own title, its own Back control and the same edge
gesture every other settings panel has. Nothing about the queue changed: the
three segments, the four actions on an evidence card, the identity workflow and
the "Wrong player?" search are all exactly as they were, and a correction is
still authoritative and still survives reprocessing.

**Visibility was the whole risk, so it is said twice and announced once.** The
row prints the count in words — `3 items need attention`, or `Nothing waiting
for you` — and the Setup destination carries a 7px accent dot for as long as
anything is waiting. The dot is `aria-hidden` and the count is spelled out in
that destination's accessible name instead, so a screen reader is told once
rather than reading a bare numeral and then a sentence about it. At zero there
is no dot and nothing in the accessible name: an indicator that never clears is
an indicator nobody looks at. Both numbers come from one addition of
`pendingEvidence + pendingIdentity` in `App`, passed down, so the bar and the row
cannot disagree.

**Nothing was promoted into the slot.** The bar is sized by its contents, so it
is simply one destination narrower and still packed, still centred, still 44px a
target. The widest it now gets is six — the stretch between a draft completing
and week one, when Matchup has arrived and Draft has not left — and six fit at
their full width on a 360px phone. That retired the two `data-count='7'` rules
that used to narrow a destination and spend two points of the pill's own padding
to make a seventh fit; the bar was 56px at every supported width again, which
both `toolbar.spec.ts` and the production smoke suite asserted as one number
instead of two. (It is 60 now — see *the taskbar spends what Review left*
below — and still one number.)

**Demo Mode tells the truth about it.** The scenarios ship no review fixtures,
and the overview was publishing the count of unresolved *aliases* as
`pendingIdentity` — a different ledger, belonging to Help my scores. That was
survivable as a numeral on a destination and is not survivable as a sentence on
the row that opens the queue, so both counts are now `0` and the unresolved names
are shown only where they are actually about.

**Asserted in** `e2e/review-in-settings.spec.ts`: Review absent from the bar and
the remaining destinations unchanged; the bar repacked with no gap and no
restyle; the row present, 44px, a real control, and its count equal to the
overview's own; one item counted as one item; the two queues added; no mark and
no announcement at zero; the mark and exactly one announcement above it; the
attention dot and the view-only ring coexisting without overlapping; the screen
itself with its segments and its reference sheet; Back returning one step to the
Settings root with no history entry; Settings staying current and alone while the
queue is open; a retap closing it and deciding nothing; and any saved path
opening the app with Review still one step away and its own reads still
answering.

## Milestone — the taskbar spends what Review left (done)

**A destination is 54 × 48 now, and it is the same one on every phone.** Review
moving into Settings gave the bar back a seventh of its width and nothing was
promoted into the slot, so the bar had been carrying six destinations at numbers
tuned for seven. This lane spends that room on the destinations themselves
rather than on air: 52 × 44 becomes 54 × 48, the glyph goes from 22 to 24, and
the label goes from `0.625rem` to `0.6875rem` — 9.4px to 10.3px against this
app's 15px root, which is the size iOS sets a tab label in and the first time
this bar's words have been drawn at it. The pill comes out 336 × 60 at six
destinations and 282 × 60 at five, against 324 × 56 and 272 × 56 before.

**The narrowest phone gained the most, because it was the one still paying.**
`@media (max-width: 374px)` took a destination down to 48px. It was written when
the bar carried seven and seven at 52 did not fit; the seventh left with Review
and the override did not, so a 360px phone was the only screen still giving up
six points a destination for a rule whose reason had gone. A destination there
goes 48 → 54 and the bar 300 → 336. Every test the bar had asked whether a
destination cleared the 44px floor, and none asked whether it was the size the
design says it is — which is why nothing failed. `toolbar.spec.ts` now asserts
54 and 48 exactly, at every supported width.

**336 is where the enlargement stopped.** `--page-x` is what every screen keeps
between its content and the edge of the phone, and at 360px that leaves 336 —
exactly six destinations at 54 plus the pill's padding and its border. The next
point of destination width would put the bar wider than the page it floats over.
Both `toolbar.spec.ts` and the production smoke suite bound the bar by `--page-x`
read from the page now, rather than by the 20px-either-side they carried before:
that number was one the bar happened to clear, and it would have failed the
widest bar on the narrowest phone for sitting exactly where the page sits.

**The pill's `max-width` does something now.** The destination width was
declared on the button, so the grid tracks were fixed and the clamp was a
decoration: a bar too wide for it drew its destinations at full size and let
them hang out of the rounded ends over the page — the opposite of what the
comment at the rule claimed, for as long as nothing tested it. The width moved
to `grid-auto-columns: minmax(var(--tap), var(--tab-w))` with the button filling
its track, so the same overflow gives width back a point at a time and stops at
a fingertip. Nothing at a supported width reaches that; it is the failure mode,
and it is asserted rather than assumed.

**Nothing else moved.** Not the destinations or their order, not Review's home
in Settings, not the pending-review dot, not retap, swipe, routing or lock
behaviour, not the bar's vertical position or its safe-area arithmetic, and not
the visual language: no pill, no underline, no bloom, no selected-item scaling.
The selected destination is still the accent colour, a heavier glyph and a
heavier word, and the bar still reflows on nothing. No dependency, no API, no
model, no flag, and no performance budget was raised — the stylesheet is 27
bytes larger gzipped (14,307 → 14,334) against 5.8kB of headroom, and the
JavaScript moves 10 bytes (127,686 → 127,696), which is the stylesheet's new
content hash written into it and not a line of code.

**Asserted in** `e2e/toolbar.spec.ts`: the bar is 60px at every width and every
count; a destination is exactly 54 × 48 on the narrowest phone and the widest,
with a 24px glyph and a 10.3px label; the bar never reaches past `--page-x` and
no destination hangs out of the capsule; and no two destinations claim the same
pixel — `elementFromPoint` down every destination's centre line and across both
sides of every shared edge, which is the check that larger glyphs and larger
words could have broken and reasoning about could not have caught.

## Milestone — a recommendation can be reproduced instead of remembered (done)

**The problem was never that the app is wrong. It is that it is wrong once.** A
Draft recommendation somebody disputes was produced against live Sleeper state,
a market snapshot fetched that morning and a newsletter ledger nobody else has,
on a Tuesday, on a phone — and none of that exists by the time anybody looks. A
report became archaeology, and the fix became a guess with a test written after
it to agree.

**Setup → This app → Copy support snapshot.** One row, one tap, and the
exact state behind the board is on the clipboard as
`junculator/support-snapshot@1` — or in the Files app when the clipboard refuses,
which the row says rather than leaving the reader to find out by pasting
nothing. No dashboard, no upload, no backend, no telemetry, no background
collection. `npm run support:fixture -- snapshot.json` on the other end rebuilds
the board deterministically, with the network unplugged, and
`--write <name>` turns the real case into a committed regression fixture.

**The capture is a recording proxy over `DraftBoardSources`, and that is the
whole design.** `buildDraftBoard` is handed its facts rather than fetching them,
which the demo has relied on for a year; a snapshot is the same substitution
run backwards. Two properties fall out that a hand-maintained list of "the
inputs" could not have: completeness is structural — a source method the board
calls is one the snapshot has, and a new member fails to compile in two files
until both know about it — and read-only is a property of the type, because that
interface has no write on it. Replay rebuilds those sources from `Map`s and
hands them to the same `buildDraftBoard` the server and Demo Mode call, so
nothing is reimplemented and nothing can drift.

**The one unbounded read is distilled, and what it dropped is counted.** The
Sleeper dictionary is ~2,500 rows and the board scores at most 300. The file
keeps the players who can reach the answer — the scored pool the board itself
reveals by handing it to three sources, the simulated pool cut with the board's
own exported `simulationEligible` and `byMarketThenSearch`, everybody either
market has priced, and everybody already drafted — and `playerCensus` records
what was listed, what was kept and why. Against a padded 2,476-row table the
capture keeps 300-odd and replays byte-identically. Exactly one board-level
number the distillation moves, `poolHealth.activeEligible`, and the replay
reports it under `distillation` with both values rather than letting a smaller
pool pass quietly as a match.

**Arguments are bounded to the top 24 rows plus every marked player, wherever he
finished.** The second half is the one that matters: a snapshot is usually taken
*because* of a specific player, and the player being argued about is very often
the one that was hearted and did not move — who may be ranked eightieth,
precisely because that is the complaint. The ordering is complete at any depth,
so a reordering is always detectable even for a row whose argument is not in the
file.

**Redaction aliases what the engine needs and refuses what it does not.**
Sleeper user ids and display names become `manager-1` / `Manager 1`,
consistently everywhere they appear, so slot → roster → owner still resolves and
the board is unchanged — a test proves a league of realistic identities emits
none of them *and* still replays exactly. The league and draft ids go with them,
and that is the part worth understanding: a user id is obviously an identity, a
league id is not, and it is worse — `GET /v1/league/<id>/users` is public, needs
no key, and hands back every manager's username. Replacing eleven user ids and
then printing the league id would have been a redaction-shaped object rather
than a redaction. `LeagueRecord.id` *is* the Sleeper league id here, so
`league-1` and `draft-1` are the whole answer. Cookies, authorization, headers,
tokens, provider keys, passphrases, email addresses and newsletter excerpts are
forbidden at any depth and a capture carrying one throws rather than emitting a
partly-redacted file, because a partly-redacted file is worse than none: it
looks safe. The scan runs again at replay, since the copy being replayed is not
necessarily the copy that was emitted. The rules travel inside every snapshot,
so the person holding the file can read what was taken out of it.

**Reproduced means seven terms, compared exactly, with no numeric tolerance.**
Every ranked id in order; every component's score, weight, contribution,
`unknown` and display string; the composite and the 0–100 score; reasons,
counterpoints and warnings as sets of sentences; the favourite's level and what
it spent; degraded and freshness states; and the `Next%` seed, so the samples
match by construction rather than by luck.

The seventh is the one that was easy to leave out and is the reason the list is
not six: **the lines no component score stands behind.** Everything else is the
ranking or an input to it, so matching components are strong evidence the rest
matched too — but `injuryStates` reaches the board through `injuryLine` and
nothing else, and no score reads it. Without that term a snapshot could
reproduce every number on the board while silently losing the availability line
under a player's name, which is precisely the kind of report this exists to
answer. `tierContext`, `marketHeadline`, `preseasonPoints` and the per-player
`Next%` model travel and are compared for the same reason. `elapsedMs` and `cached` measure the
machine rather than the board and are not in the file at all — a field that
cannot be compared should not be in a document whose purpose is comparison. One
concession, and it is not numeric: JSON cannot express `-0`.

**Six outcome words, checked in an order that matters.**
`schema_unsupported` before `data_mismatch` before `engine_version_mismatch`
before `freshness_difference` before `output_difference`. A moved engine version
explains a difference, so it is reported ahead of the difference — otherwise
every replay after a legitimate calibration commit reads `output_difference` and
a real regression becomes indistinguishable from Tuesday.

**Aliasing the draft id broke reproduction, for a reason worth keeping.** That
id is one of the strings hashed into the `Next%` Monte Carlo seed — a *model
input*, not only an identifier — so the alias drew a different sample and the
replay disagreed with its own capture by a point of survival on a handful of
players, indistinguishable from a regression. The seed travels in the file
instead of the identity that produced it: `SimulationInput.seed` is an optional
override, `nextPickModel.seed` is reported on every board, and the replay hands
it back and compares it, so matching samples are a consequence rather than a
coincidence. Reporting it is worth having on its own — "the same board returns
the same numbers" was a promise, and is now something a reader can check. With
no seed supplied the derivation is the one it always had, so no existing board
moved.

**`DRAFT_ENGINE_VERSION` is new, and is not the git SHA.** A SHA says which
commit shipped and changes on every commit including the ones that change
nothing here; the engine version says whether the *reasoning* moved, which is
the question a replay is asking.

**The first case, run through the lane it was built for.** "I hearted a player
and he did not move up" was traced with the harness rather than reasoned about,
and it was three facts. The boost does reach the ranking — ♥/♥♥/♥♥♥ contribute
0.084/0.25/0.5 of composite, exactly as calibrated, with persistence,
propagation and recompute all intact. At one heart the board frequently does not
visibly move, and that is the design: 0.084 is under two picks of ADP against a
board where ten consecutive players sat inside 0.53 of each other. No weight was
touched.

**Two sentences were genuinely wrong, and both are fixed.** The card credited
the boost to `★★` — the *queue* mark, which this app documents as changing no
ranking at all — so a reader who believed it would tap the star and wait for a
board that was never going to move. `MyGuyFlag.stars` is now `marks` and holds
hearts; a field called `stars` holding hearts is the next person's version of
the same bug. And every component sentence promised "about N spots", a claim
about board position that the second-pass composite does not keep: measured, a ♥
announcing "about 2 spots" moved a player zero places and twice moved him down
one. It says "about N picks of ADP" now — the unit the number is actually in,
and one a reader can check against the ADP column on the same card.

**Performance.** App JavaScript 127,380 → 127,994 gzipped (+614 B, the Settings
row) against 11.8kB of headroom; the stylesheet is byte-identical, because the
row reuses `ListRow` and added no rule. Demo Mode's lazy chunk grows 4.0kB
(135.4kB → 139.4kB) since a scenario serves the capture route in the browser.
The *replay* machinery reaches no browser chunk at all, and the capture reaches
none outside Demo Mode's lazy bundle — asserted by grepping the built assets.
No budget raised.

**Phase 2 is a contract, not a promise.** `decision.kind` is already the union
of `draft-board`, `lineup`, `matchup`, `waiver-plan`, `dst-plan` and
`trade-offer`, and everything outside `decision` — schema identity, both
versions, the fixed clock, redaction, the replay harness, the fixture converter,
the CLI, the runbook — is surface-independent. Adding a lane is a payload type,
a recorder over that surface's own sources interface, and a replay adapter that
calls the real assembly function. What each lane would capture is written down
in [docs/SUPPORT_SNAPSHOT.md](SUPPORT_SNAPSHOT.md).

## Milestone — the same button, for the week rather than the draft (done)

**The Draft lane proved the architecture on one surface. This is the other
five.** A questionable Start/Sit call, a Best Move that should have been a hold,
a waiver plan with the wrong drop in it, a defence it says to stream, a trade
offer nobody would send — every one of those is wrong once, against state that
does not exist by the time anybody looks, and every one of them is now a file.

**Setup → This app → Copy support snapshot**, with `Current context: Waivers`
above it. One action, not six: the screens record which recommendation the reader
was last looking at, the row states it so nothing is captured silently, and
`Change` is there for a cold start into Settings or a reader who has moved on.
`npm run support:fixture -- snapshot.json` reads whichever of the six it is
handed and says which — no flag, no selection.

**Two seams, because the surfaces are two shapes.** Matchup and the defence
planner already receive their facts through an interface, so they are recording
proxies exactly like Draft. The lineup, the wire and the trade search are handed
a `StartSitInput[]` that one service assembles out of eight repositories — so
*that value* is the seam, and capturing it captures every field rather than the
calls one request happened to make. Each replays through the same assembly its
screen calls, which is why `assembleLineup`, `assembleWaiverPlan` and
`assembleSmartTrades` were extracted: those pipelines were written out twice, in
`server/app.ts` and again in Demo Mode, and the comment beside the second copy
said it mirrored the first "line for line". It did — and the demo's trade copy
had already drifted.

**The in-season outputs are the engines' own objects, compared leaf by leaf.** A
hand-written output section is the fields somebody remembered, and the field they
forgot is not compared at all; that is how this lane nearly lost `injuryLine`
last time. The structural walk compares a field added next year on the day it is
added.

**Which cost `lossless.ts`, and it earned its keep immediately.** `JSON.stringify`
turns a `Map` into `{}` silently, and four real ones were in the way: the
opponent tendency table attached to every `StartSitInput`, the defence planner's
season-form fallback, the transaction profiles behind the waiver pressure column,
and the trending map behind a bid. Each of those, gone quiet, reads as an engine
that suddenly knows less than it does. The fifth was not a `Map` at all — a
league's points-allowed table ends at `to: Infinity`, which the wire turns into
`null`, so every defence in the league replayed a fraction of a point out. The
payloads now carry the league's own published settings and rebuild the profile.

**And it cost a rethink of redaction.** Aliasing the inputs and scrubbing the
output is what Draft does, and it cannot work for a display name: this app's own
seeded league has a manager called `You`, so replacing names in prose turned
`You are sending Ike Sandoval` into `Manager 9 are sending Ike Sandoval` — a
redaction corrupting the sentence it was protecting. The in-season adapters alias
the rosters, the wallet and the manager profiles *before* the assembly runs, so
the engines compose `Manager 3` themselves and nothing needs replacing
afterwards. One identifier could not be handled that way, and it is the same
catch the draft id produced: the matchup fingerprint hashes the league id and
seeds the simulation from it, so `MatchupForecast.seed` now reports the number
actually drawn with and a replay hands it back.

**A capture with no decision in it refuses.** A Tuesday has no matchup; a league
with no DEF slot has no defence to plan. The sentence the screen would have shown
is a better answer than a file with nothing in it, which somebody would send and
then wait on.

App JavaScript +0.5 kB gzipped, CSS byte-identical, Demo Mode's lazy chunk
+5.6 kB with 4.2 kB of headroom left. No budget raised, and the replay machinery
reaches no browser chunk at all.


## Milestone — whether what it knew was healthy and current (done)

Support Snapshot made a decision reproducible. It could not say whether the state
it captured was any good — and that is the other half of every diagnosis. A
lineup built on Wednesday's betting line, an injury report that has not published
for this week, and a manager ledger that yielded its subrequests to the injury
check all produce the same complaint and need three different answers. Getting
those answers meant opening Cloudflare's tail, the Actions tab and D1.

**One row, one screen.** Setup → This app → **Data health**, directly above Copy
support snapshot, saying `Healthy · refreshed 18 min ago` or `2 inputs need
attention`. Behind it: the overall state, what needs attention when anything
does, twelve compact input rows, and what the last scheduled refresh actually
did. Exact instants, outcome codes and subrequest counters live behind
**Technical details**, folded. Never in the taskbar.

**`not_published` is not a failure, and this is where that stops being a
convention.** The ingests have recorded `ok | not_published | failed` for a long
time, and until now nothing read the middle word: a preseason 404 and a dead
pipeline reached a screen the same way. A source with nothing to say is `Waiting
on source`, is not counted as needing attention, and takes the neutral mark
rather than the warning one.

**Last attempt and last success, kept apart for every source alike.** The state a
single "updated N ago" hides is a five-minute check running happily while four
consecutive ingests have died — and its mirror image, data that is fine today
only because it was fetched before the pipeline stopped. Both are reported, and
neither is inferred from the other.

**Nothing recorded the scheduler.** `scheduled()` wrote its outcome to
`console.log`, which lives in Cloudflare's tail for as long as somebody is
watching. `cron_run_state` is **one row per cron expression, overwritten in
place** — three rows, for ever, because §14 asks for a current view and not a
monitoring history. The five-minute injury tick is deliberately not written
there: `injury_source_state.checked_at` already says whether it ran, and a second
copy could only ever disagree with the first.

**The cron was not rearranged to get it.** Every feed was already in its own
`try`/`catch` so one dead provider could not take down the ten under it;
`CronRunRecorder.step` *is* that catch with the outcome kept instead of
discarded. Order, priority and the separate-catch rule are unchanged — this lane
observes the schedule rather than redesigning it, and four structural tests that
used to read the inline `try {` now read the recorded step.

**Deferral is an outcome, not a failure.** `Manager tendencies — Deferred ·
background`, with `Refresh budget reserved for higher-priority data (48/48
already spent)` beneath it. An allowance-bound batch counts too: it advanced as
far as its slice of the pool allowed and stopped with checkpoints intact, which
is the steady state of a backfill's first few days, and calling it a success
would hide from somebody reading a thin `Next%` that there is more to come. The
budget numbers are the transport's own — retries and redirect hops included — and
the two weekend clocks report `null` rather than three zeroes, because a clock
with no ceiling has no counter to invent.

**No stale constant reached a component.** Nearly every window is imported from
the module that already owns it — the injury layer's own `FRESHNESS_HOURS.fresh`,
Setup's `VEGAS_STALE_HOURS`, the season market's `SEASON_TTL_MINUTES`, the season
resolver's `STATE_STALE_AFTER_DAYS` — so the screen and the engine it describes
cannot disagree. Two thresholds are genuinely new, and both answer a question no
existing rule answers: *has the pipeline stopped running*, as opposed to *is the
data old*. Both are boundary-tested, inclusive on the window.

**And a source's freshness is measured by the right clock.** A finished week's
snap counts never change again, so ageing them against the wall clock would
report every October Tuesday as five days stale for ever; what matters there is
whether it is still being asked. A betting line is the exact opposite.

**A small health block now travels in every support snapshot** — on the envelope,
outside `decision`, so no replay compares it. About a kilobyte, under 5% of a
file, capped by a test at 2KB: enough for an agent to tell stale injury data from
a legitimate `not_published` from a missing provider key from a deferred backfill
that has nothing to do with the complaint, and not enough to bury the decision it
travels with.

**Read-only, structurally.** `DataHealthService` has no write method, no
`refresh` and no `fetch`. The isolation test snapshots every row of every table
before and after, watches every statement the endpoint prepares, and hands it
transports that throw. `GET /api/data-health` is its own route: `/api/health`
answers three things, the third is what the release gate compares, and growing it
is how that check starts failing for reasons unrelated to the deploy.

**Demo Mode demonstrates the same screen with no network and no second engine.**
The rows are built by the production assembler from the production policy table,
and the overall word, the attention count and the Setup sentence come from the
production functions. What a scenario supplies is the state, which is what a
scenario is. Healthy, legitimately waiting, stale and deferred are all reachable,
a degraded scenario cannot report itself healthy, and the same scenario produces
byte-identical health twice.

App JavaScript +2.1 kB gzipped, CSS byte-identical, Demo Mode's lazy chunk
+2.0 kB. No budget raised — and the demo chunk is now within 1.0 kB of its
ceiling, which is the next thing that will need a deliberate decision.

## Milestone — a newsletter creates work, not opinions (done)

**The app was forming fantasy opinions it had no way to form.** An issue arriving
at the inbound address was read by a sentence-level classifier and written
straight into the evidence ledger: *found news on 5 players, 2 applied
automatically, 3 waiting for your review*. Those were guesses about editorial
analysis, made on delivery, that moved player tallies, the draft board, Trades
and Start/Sit — and the review queue they produced asked the reader to work
through classifier output sentence by sentence before the newsletter was any use.

The workflow that actually happens is different, and it is now the only one:

    an issue arrives → Setup shows a mark → Copy for ChatGPT →
    paste its tally back → see exactly what would change → approve →
    applied once → the mark clears

**Arrival writes nothing.** Not an evidence row, not a review item, not a
signal. The issue is decoded, repaired, stored, and marked `awaiting` on
`newsletter_messages.tally_state` — durable state, so the work survives a
reload, a different phone and a Worker restart. The classifier still runs and
its verdicts are discarded; what is kept is the coverage report, which is about
the *delivery* — did the email decode, how much text is there to hand over,
which name-like spans the dictionary does not know. None of those is an opinion
about a player.

**The two controls are where the work is announced.** Copy for ChatGPT and
Paste AI tally are drawn directly beneath the Newsletter row on Setup, without
opening the panel, and they name the issue they act on. They are workflow rather
than furniture: they exist only while an issue is unscored, and they are gone
the moment one is scored. The Setup destination's mark composes the newsletter's
pending work with the two review queues and says which is which in its
accessible name. A backlog is worked oldest first, one issue at a time, and
nothing anywhere combines two.

**Exactly once, three ways, because a double count is silent and permanent.**
`newsletter_tally_applications` claims one application per (newsletter, exact
tally): the insert *is* the decision, so a double tap, a reload or a retry after
a timeout cannot both conclude they are first. Evidence rows are keyed as they
always were. And an approved tally is the reading of its *whole issue*, so
applying one retires whatever the classifier wrote for that newsletter — for
every player, not only the ones the tally names, because the protocol says to
omit players whose signals cancel and silence about a player is therefore a
verdict rather than an absence of one. That last scope was the bug: displacing
only the scored players left the rest of the automatic reading stacked
underneath the approved one.

Three cases are kept apart by what a person has already said, and `accepted` is
not enough to say it: the identity-repair path writes `accepted` for every row
it recovers, so the question is asked of `user_reviews`, which is written when
somebody presses a button in Review and by nothing else. A row they ruled on is
untouched; a row the tally scores the *other* way stops counting and waits for
them; everything else is retired. Nothing is deleted, ever — `ignored` stops a
row counting while it stays in the ledger with a note saying why, reversible
like any other item.

**The issue already in production is reconciled by provenance, once.** Migration
0034 stops classifier rows counting for newsletters still awaiting a tally, and
is narrow on purpose: classifier rows only, never `ai-tally-import` or
`tally-backfill` — the lifetime `+11` from the hand-imported running tally is
somebody's own work and is never touched — never a row with an override, never
one with any history in `user_reviews`. Its two `UPDATE`s change nothing when
run again, and that is tested against a database built migration by migration
into the shape the deployed one is in.

**Reprocessing is gone, and that is what makes "one scoring path" true.**
`NewsletterService.reprocess()` and its preview were the last live route by
which the classifier could put a number in a player's tally. The decoding repair
they also carried moved to the way *out*: `chatSource` runs `recoverBody` every
time an issue is copied, so a body stored as undecoded MIME still hands ChatGPT
clean text — and with arrival writing no evidence there is no longer a row
derived from garbage for a repair to retire. The one-off ops script and workflow
built on those endpoints went with them.

**Player cards stopped explaining the app to the reader.** A backfilled tally
row carries the drivers that justified the score *and* a template describing how
it got into the database — "Carried over from a running tally covering several
earlier issues (net +11)" — and the template won, because the sentence ladder
prefers a stored summary to an excerpt. So a card somebody opened to find out
about a wide receiver led with the app talking about itself. Skipped by
provenance rather than by matching the sentence, in both places that walk the
ladder, and nothing is invented for a row that carries only bookkeeping: it
offers no sentence and a better-supported item wins. The ledger is unchanged and
the timeline still prints it, which is where an explanation of how data arrived
belongs.

**Data Health tells delivery apart from work.** An issue received on Sunday and
unscored on Monday is a healthy feed with a job attached. Freshness is measured
on delivery, as it was; the pending count is a diagnostic, and the mark that
asks for the work is the Setup dot — a different mechanism on a different
screen, deliberately.

No budget raised, and none needed. Measured against `989b4c9` and stated in
bytes, because at this ceiling a tenth of a kilobyte is the whole margin:
app JavaScript **−79 B** gzipped, CSS **+34 B**, and Demo Mode's lazy chunks
**+4 B** — 149.0 kB against a 150.0 kB ceiling, unchanged to the tenth of a
kilobyte the budget is written in. Retiring the reprocess panel paid for the two
Setup controls, and the demo chunk moved only because the four bytes are one
field on the setup fixture.

## Milestone — the card says the football, and moves under a thumb (done)

Two complaints about the same object, reported together because a reader met
them together: they open a player card, the sentence that explains the number
beside his name is missing, and the rest of the card will not scroll.

**Whether a card had a takeaway was decided by the calendar.** The selector
ranked candidates by category, specificity, corroboration and a recency decay,
and then compared the *decayed* score against a fixed floor — so the same
unchanged evidence qualified in August and failed a fortnight later. Puka
Nacua's row scores 5.0 on its merits against a floor of 3 and had dropped to
2.68 by the time it was looked at, while still being the entire reason his tally
read `+13`. Jaxon Smith-Njigba, with the same kind of row from a different
issue, kept his. That is not a rule a reader can learn; it is the app being
arbitrary. In the demo world it had gone further than inconsistent: *every*
seeded player's takeaway was null, because a hand-scored tally row carries no
category and therefore scored as `other`.

The two questions are separated now. *Whether* there is a takeaway is a property
of the words — ingestion bookkeeping, the name and score the card is already
printing, or praise with nothing checkable behind it, and nothing else is
refused. *Which* sentence leads is the ranking, decay and all. Nothing about the
ordering changed, no category weight moved, and the floor is gone rather than
retuned: it was measuring age. `tests/takeaway.test.ts` asks the production rows
from `data/imports/2026-08-13-tally-r1-r4.md` the same question at four points
on the calendar and expects one answer.

**And the card stopped saying it twice.** The takeaway is chosen out of the same
ledger `Latest news` prints, so a player with one applied item read it at the
top of his card and again four lines down, word for word with a date under it —
marked `quoted above`, which named the duplication without removing it. What the
takeaway lifts is now dropped from that list. Nothing is destroyed: the item is
still counted, still in the ledger, and still on the evidence timeline one tap
in, where the mark stays because that surface exists to show the whole thing.

**The scrolling had two independent causes and both were load-bearing.**

The first was the fix from the last sheet pass. A sheet taller than the screen
declares `touch-action: pan-y` so the browser can scroll it, which used to mean
the browser had classified a downward drag as a scroll before the app saw an
event — so the sheet registered a non-passive `touchmove` and claimed a downward
drag on content sitting at its top, where scrolling has nowhere to go. The
reasoning is sound and WebKit cannot act on it: it decides whether a touch
sequence may scroll **once**, from the first `touchmove`, and never revisits it.
The claim therefore had to be staked on one or two pixels of movement, and one
or two pixels of a thumb landing is noise — an upward flick that began with a
pixel of downward drift was refused its scroll for the whole swipe. First
attempt does nothing, third attempt works. The listener also took WebKit off its
fast scrolling path for every sheet in the app.

No threshold fixes that, because at the instant the browser wants its answer the
information is not there. So the question is settled from something that *is*
known when the finger lands — whether the box under it can scroll at all — and
scrolling gets the benefit of it. Dismissal keeps the grip, the header, the
backdrop, Done and Escape, and keeps the content of the many sheets shorter than
the screen, where there is no scroll to take. `useSheetDrag` calls
`preventDefault` on no touch, and the claim in `gestures.ts` that this app
prevents no touch default anywhere is true again.

The second was a latch. `touch-action: none` goes on a body with nothing to
scroll — and `none` means no touch scroll, no touch scroll means no `scroll`
event, so a body measured before its content arrived had no way left to notice
that it had grown. It was reachable by an ordinary route: a sheet is capped at
`88dvh` and an expanded player fills in from two requests after it opens, so
once the sheet reaches the cap the body's own box stops changing while its
content is still coming, and the `ResizeObserver` watching that box goes quiet.
Reproduced in Chromium before the fix — content grew from 286px to 1186px inside
a 262px box with the flag still reading `false`. The sheet wraps its children in
one bare block and observes that too, so the question is answered from the
content rather than from the thing clipping it.

**Coverage.** `e2e/player-card-scroll.spec.ts` walks the card the way a reader
does at all four widths — takeaway present and quoted once, takeaway absent with
no empty heading, and a long card scrolled to the bottom, back to the top,
closed and reopened, with the list behind it pinned throughout and content that
arrives late still flipping the flag. What a headless browser cannot answer is
stated in the file: `page.mouse` is not a finger, so WebKit's own "may this
touch scroll" decision is exercised by the CI shards and by the physical-device
pass, not here. `sheet-interaction.spec.ts` now pins the reversed rule, and the
`sheetCandidate` threshold went with the listener it existed for.

No budget raised. Measured against `51d068c`: app JavaScript **130.6 kB**
against a 140.0 kB ceiling (−0.3 kB, the removed listener), CSS **14.3 kB**
against 20.0 kB, everything the browser must fetch **146.4 kB** against 160.0
kB, Demo Mode's lazy chunks **149.0 kB** against 150.0 kB — unchanged.

## Milestone — the draft card carries the insight (done)

A wording pass and a hierarchy pass on the same object, and both are about what
a card spends its lines on.

**Three labels, shorter.** `Newsletter takeaway` is `Insight`; the provider's
`2026 Season Outlook` is `2026 outlook`; `Read the full outlook` is `Full
outlook`. And the attribution that ran after every takeaway — `— Demo FF
Newsletter` — is no longer printed. This app has one newsletter, so it was the
same four words under every player, spending the end of the one line the section
exists for; `LatestNews` under it has withheld a source that never varies for
exactly that reason since it was written. Nothing is lost: the name is on the
element's title, in its accessible text, and on every row of the evidence
timeline, which is the surface that exists to answer where something came from.
The heading is now built from the season rather than trimmed out of the
provider's title, because trimming a provider's words is how a heading starts
saying something the provider did not — the attribution that *is* a quotation,
`— Rotowire, via Sleeper`, still runs inside the paragraph.

**The draft card spends two of its lines differently.** It rested at the working
behind the row's own market deltas — `Sleeper ADP 6.4 · DOG ADP 7.7 · Pick 1 ·
Val -5.4` — and its last-season band opened with a preseason figure the row
already prints as `PTS`. Both are gone from the card and neither is gone from
the screen: the row prints the deltas and carries the raw market and the pick in
the title of the metric that shows them, and `PTS` is on the row itself. The one
thing genuinely retired is the `Val` column, which the compact row stopped
printing in an earlier pass and which nothing else draws.

What took their place is the one thing a collapsed row cannot say: `Insight`,
and under it `Latest news` — one item at rest, three when the card is opened in
full, so the card's existing single control does the expanding rather than a new
one. The reading is now Insight → Latest news → 2026 outlook → 2025 GP and rank,
with the named `Full outlook` in the slot `.detail-foot` was built for: last
season on the left, the way in on the right, one line for both. That control is
new only in being *named* — the blurb has expanded itself since the card was cut
down, which is the right affordance inside a paragraph that visibly runs out of
room and a poor one as the only way in, because nothing on the card said it was
there. It is drawn only where there is something behind it.

**The height guard moved, deliberately, and it moved to the units it is about.**
It was a ratio against the board's own collapsed rows, ceiling three, which was
right while a card's content was roughly proportional to its row's. The insight
broke that: a player with a busy ledger and no market line has the shortest
collapsed row on the board and the most to say underneath it — Silas Mbeki's row
is 59px and his card is 176px, a ratio of four and a perfectly reasonable card.
So the rule the rationale actually states, *opening a player must not cost you
the board you opened him from*, is asserted directly: the disclosed part of the
card against the height of the phone, under 40%. Measured at 390×844 on the demo
board, worst case of each: 21% of the viewport and 4.0 collapsed rows. The
article this guard was written to catch was eight to nine rows and most of the
screen, and it still fails on that.

**Coverage.** `draft-card.spec.ts` gained the hierarchy — both branches of it,
because which of `Insight` and `Latest news` a player carries depends on his
ledger and the pair is the point — plus the named control and the two removals,
and its band assertion now names `Market - ` among the spellings it refuses.
`draft-market-delta.spec.ts` asserts the working where it now lives, on the
title of the delta that was made from it.

No budget raised: app JavaScript 130.6 kB against 140.0 kB, CSS 14.3 kB against
20.0 kB, first paint 146.5 kB against 160.0 kB, Demo Mode 149.0 kB against
150.0 kB. The Draft card's second request — the ledger, for the news under the
insight — is made only when a card is opened, so a board of forty rows still
costs nothing until one of them is tapped.

## Milestone — one fact, one line (done)

Bijan Robinson's expanded card, under `Latest news`, from the same day and one
directly under the other:

> Elite receiving efficiency/target rate paired with an NFL-leading 2,298
> scrimmage yards
>
> Elite receiving efficiency/target rate and led the NFL with 2,298 scrimmage
> yards

Two of the card's lines spent saying one thing. The section already refused to
repeat the sentence the `Insight` above it had quoted, but it refused it *by
item id*, which catches the row the takeaway was built from and nothing else. A
second row saying the same fact in different words is a different id, and the
card had no way to tell that it was the same football.

**Near-duplicate detection, in `core/evidence/nearDuplicate.ts`.** Two lines are
one claim reworded when they share enough of the facts they are made of:
Jaccard overlap of content tokens — grammar removed, punctuation split on, and
`2,298` and `2298` read as the same number — at or above 0.6, over at least
three shared tokens. The reported pair scores 0.75, with `paired`/`leading`
against `led` the only difference between them.

**The rule that keeps it from over-collapsing is about numbers.** If both lines
carry numbers and share none of them, they are distinct however alike they read:
"14 carries and 5 targets in Week 1" and "18 carries and 7 targets in Week 2"
score 0.67 on vocabulary — above the threshold, and two separate weeks of
football. Same-day is not
evidence of anything either way — a role note and an injury note from one
Wednesday share almost nothing and both still show, which is the owner's own
rule: *if there's like two unique things from a certain day, that's fine to have
both.* Every threshold here is set where a false merge is the harder mistake to
make, because a repeated line costs a line and a suppressed one costs the reader
a fact he will never know he did not see.

**It is selection, and only selection.** Nothing is deleted, nothing is merged
into a new sentence, and no row is altered: `selectLatestNews` picks the most
recent telling of each distinct fact out of the list it is handed and hands the
list back untouched. The suppressed rewording is still counted by the tally, is
still counted in the `N older items on his full profile` line under the section,
and is still printed whole on the evidence timeline one tap in — which is the
surface that exists to show everything, and the one place the repetition is the
point. The card also stops repeating the takeaway's fact in someone else's
words, which is the same defect one rewording deeper.

Collapsing a pair does not shorten the card: the freed line goes to the next
distinct signal, so the card that showed one fact twice now shows two.

**Coverage.** `evidence.nearDuplicate.test.ts` asserts the reported pair
collapsing to its more recent telling, two genuinely distinct items from one day
both surviving, two weeks of the same statistic staying apart, and the ledger
handed to the section coming back with every row in it.

No budget raised: the detector and the selection it feeds cost 572 bytes gzipped
on the app JavaScript chunk, 130.6 kB to 131.2 kB against 140.0 kB. CSS 14.3 kB
against 20.0 kB, first paint 147.0 kB against 160.0 kB, Demo Mode unchanged at
149.0 kB against 150.0 kB.
