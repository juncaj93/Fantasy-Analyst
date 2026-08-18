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
9. **The browser suite shares one dev server across all three viewports.** Run
   repeatedly against a reused server, accumulated review-queue state can make
   `can reassign an item to the right player` fail; it passes on a fresh server,
   which is what CI uses. Worth isolating per project if it ever fails in CI.

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

## Milestone 15 — the Team screen as a weekly tool, and the waivers shell (done)

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
slot he fits (and the others he also fits), what he is worth this week, one
short phrase saying why — and defines the interface the league-intelligence pass
will fill: expected FAAB range with its unit, likely competition, multi-week
value and a league-specific rank. Until that pass lands those four read as
unknown, with the reason attached, and the page says once which ones are
outstanding. **There is no arithmetic anywhere that turns projected points into
a bid**, and the tests assert the absence rather than the shape.

The Team screen shows the best three of those rows; the whole board is the new
Waivers destination, with position filters that only offer chips that would
leave something on screen, and the same pull-to-refresh.

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

Checks at this milestone: 1,692 unit/integration tests (38 new), the browser
suite extended to a fourth width — 430, the Pro Max class — plus new specs for
the pull gesture, the weekly card, the waiver rows, the seasonal toolbar swap
and the mark alignment. Typecheck and build green.


## Recommended next work

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
