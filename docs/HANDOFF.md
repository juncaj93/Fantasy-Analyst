# Handoff — Fantasy Analyst

Written at the end of the session of 2026-08-14. Read this first, then
`docs/brief/` for standing product rules and `docs/VEGAS.md` for the quota
numbers, which are the most load-bearing measurements in the repository.

Live: <https://fantasy-analyst.juncaj93.workers.dev>
`main` is deployed, green, and in sync. Nothing is half-finished and there is no
queued spec.

---

## The Draft visual pass — chrome, colour, tiers, and the expanded card

A fifth brief arrived after the four below and is delivered. Six things.

**The global banner is gone.** "Fantasy Analyst" plus the league name sat above
every page; the first is the app the user already opened and the second was
printed again four pixels below it by the draft bar. The one thing it carried
that nothing else did — whether changes are possible at all — is now a ring on
the Setup tab with the sentence in the button's accessible name.

**The tab bar stopped spending the whole home-indicator inset.** 34px below the
labels is a bar tall enough to read as a blank strip. The indicator is a 5px
pill about 8px off the bottom edge; `--nav-inset` keeps ~20px and hands the rest
back. **Both insets are custom properties now** (`--safe-top`, `--safe-bottom`)
and that is the load-bearing part: `env()` cannot be overridden, so a layout
written directly against it can only be checked on hardware that has an inset,
which is why the strip survived several passes. Measured at 390×844 with the
inset simulated: 43px of list reclaimed, one more collapsed card per screen.

**The roster line ends with the bench.** `0/1 QB · 1/2 RB · … · 0/5 BN`, where
bench is depth held beyond what the starting allocation took, out of the
league's configured spots, from the same allocation so nobody is counted twice.
Kickers are still not modelled, so a K slot still does not appear.

**Position tint is a token, not a number.** Dark was a pale tint mixed 45% into
a near-black surface — two or three points of luminance, which is not a
difference on a phone in daylight. `--pos-mix` is 62% in Light and 92% in Dark,
and the dark tints are deeper and more saturated. Same mapping now paints
Players, Team and Trades from `positionCardClass()`.

### Tiers are drawn now, and a tier means one thing

The map has known where a position breaks since the last pass and nothing drew
it. Two treatments, because the two boards are different lists:

- **filtered to one position** — a hairline, `TIER DROP`, and the gap in picks;
- **`ALL` and the queue** — no lines (a rule across mixed positions claims a
  boundary that does not exist), and `Tier cliff · N away` on the last one or
  two players of the tier *in play* at their position.

Three conditions keep that tag narrow, and they matter: his tier is the best one
left, a real cliff closes it rather than the board running out, and it is down
to one or two. Being *somewhere* in a tier that eventually cliffs describes
every player in it — which is how this board once stamped every tight end.

**A tier is delimited by cliffs only.** It used to end at either label. That
contradicted the model's own words (a thinning says "comparable players
remain", and comparable players are one tier) and made the grouping useless to
draw: thinnings are common by design, so a real receiver board carries ~20
across 80 players. Cliffs are rare and capped: 7 across the same 80. `TierCliff`
now carries `tierSize`, `tierEndsAtCliff` and `tierGapBefore`. **No ranking
moved** — `score` never read the grouping, and 801 tests agreed before the UI
was touched.

Where a line goes on screen is separate arithmetic in `tierBoard.ts`, because
the board is ordered by the ranking and not by draft order: a line the first
time the list reaches each tier, never twice, never above the first row.

### "Next pick %" was asking about the wrong pick

Reported after the pass above and fixed: on the clock, survival was measured
against **the selection being made right now**. A player available now is
available now, so every row read 100% — at the one moment the number exists to
choose between them, and 100% reads as "there is time".

The snake order now answers two questions, and the distinction is the whole fix:

- `nextPickForSlot` — "when is my turn". On the clock that is this pick, and the
  header still reads `YOUR PICK`. Unchanged.
- `waitHorizonForSlot` — "when could I next take him if I pass". One pick
  further on while the clock is running, identical otherwise.

The board passes the **horizon** into the engine, so survival, positional
scarcity and tier urgency all measure against it. All three had gone flat
together on the clock, because all three read the same zero-length gap.

On your final selection the horizon is `null` and stays null: survival is
**unknown**, not 100%. It used to arrive as "next pick = this pick" and come
back certain, which is not optimism but the opposite of the truth — there is no
later pick for anyone to last until.

`tests/draft.onTheClock.test.ts` builds a real board through the real service at
pick 22 of a 12-team snake and fails if any of this regresses; three of its five
cases fail against the old code.

### The card lost its rationale, and the bottom bar had two real bugs

A later brief cut the expansion again, and this cut changed what it is for.
`WHY THIS RANK`, its bullets, the counterpoint and the `Advanced breakdown` are
**gone from the quick expansion** — all three justified a position the reader
can already see, on a screen where the question is "who is this". They are not
gone from the system: the engine still computes every reason, counterpoint,
component, weight and contribution, and `/api/drafts/:id/board` still returns
them. Only the rendering stopped.

What is there now: one tier-context line, the outlook, `15 GP · WR50 half-PPR`,
and injury context when there is any.

**The tier line** (`src/core/draft/tierContext.ts`) is `WR board thinning · 5
left in this tier · 4 teams ahead still need WR`. Shown for the player's whole
tier, absent for the last tier at a position (nothing follows it, so there is no
drop to be ahead of). The demand clause comes from `demandAhead.ts`, which reads
the real snake order and the real pick stream: TE/QB/K/DEF count as covered with
one rostered, RB/WR only when the league's **starting** slots are filled. It
stays quiet in the ordinary middle, and — the part worth keeping — quiet in
round one, where "all eleven teams ahead need one" is true of every position and
describes only how early it is.

**The outlook is shown whole now.** Cutting to three sentences dropped the
depth-chart and workload half, because these paragraphs open with last season
and work forwards. Compressing it here instead would mean paraphrasing somebody
else's analysis under their name.

**Injury context is a label** — `Major injury history: ACL` — read out of the
outlook text against a closed list of named diagnoses. "Missed time" and
"limited" are deliberately not on that list. The outlook above already explains
it properly, so this exists only so a reader scanning the card sees it.

**Collapsed cards carry the current designation** (`Q`, `D`, `OUT`, `IR`, `PUP`,
`SUS`) with the word in the accessible name. `status` is read by nothing in the
engine, so this cannot move the ranking, and a test asserts the board is
byte-identical with and without it.

#### Two bottom-bar bugs, and both were in the measurement

The tab bar's height has always been measured at runtime so the page can
reserve it exactly. It was not being measured at all.

1. **The hook never attached.** `useTabbarHeight(ref)` was `useEffect(...,
   [ref])`. On the first render the app is showing its loading state, so there
   is no bar, `ref.current` is null, the effect bailed — and its dependency
   never changed, so it never ran again. `--tabbar-height` sat at its 50px
   fallback for a bar that is 45px flat and 62px with an indicator. It is a
   **callback ref** now, which fires when the node arrives.
2. **The observer watched the wrong box.** `ResizeObserver` observes the
   *content* box by default, and everything that changes this bar's height
   changes its `padding-bottom`. The content box — a row of 44px buttons —
   never moves. So the observer correctly reported nothing through exactly the
   event it exists to catch: Safari's chrome collapsing, the inset going 0 → 34,
   the bar growing, and the page under-reserving by 17px so the last row went
   under the bar. It is `observe(node, { box: 'border-box' })` now.

Also: `.app` restated `min-height: 100dvh` inside a `#root` that already had it,
and `--nav-inset` was `inset − 14px`, a magic number. The height claim is
`#root`'s alone, and the clearance is now derived from
`--home-indicator-reach: 13px` — the pill is 5px tall sitting 8px off the edge —
capped by the inset and floored at zero.

Measured at 390×844 with a 34px inset simulated: bar 79px → 62px, list height
629px → 675px, 7 → 8 collapsed cards.

**`env()` is still read in exactly one place** (`--safe-bottom`) and consumed in
exactly one rule (the bar's own padding). The shell comment in `styles.css`
names the three owners; keep it true.

### The expanded card, and what Sleeper actually publishes

It opened with a grid of ADP, value, survival and the tally — all four printed
two lines above on the row just tapped. It now leads with why the rank is what
it is, then **exactly one** counterpoint (or an honest "No major counterpoint"),
then the outlook, then last season. Advanced keeps every component, weight and
contribution, plus the tier note, the season-market implication and the recent
tally halves — reference rather than decision.

**The season outlook is real and it is Sleeper's.** `get_player_outlook(sport,
player_id, season)` on `sleeper.app/graphql` — the same endpoint that proved
Sleeper publishes no ADP, listed under introspection, no key. It returns a
title, the text, and `source: "rotowire"`. **That attribution is shown**, not
merely stored: this is editorial writing Sleeper serves, not writing Sleeper
generated. There is no bulk form and nothing loops to invent one — it is fetched
when a card opens and cached for a week, *misses included* (30 days), because
most players have none and asking every time is unbounded third-party fetching.

**2025 games and the half-PPR finish come from `/stats/nfl/regular/2025`.** One
request, every player, a season that has stopped changing — so it runs on the
nightly cron after the player dictionary (before it, every new player reads as
unmatched). The finish is computed in `seasonStats.ts` rather than taken from
`pos_rank_half_ppr`, for one reason worth not undoing: **Sleeper ranks everyone
on its books including players who never took a snap**, so a rookie comes back
as `WR1240`, which looks like a result. Ranking only the players who scored
means somebody who did not play has no finish. Both are stored so the
disagreement is counted rather than assumed.

**Sleeper publishes no roster percentage.** Checked twice — absent from the
player dictionary, no field in the GraphQL schema. The card shows none and Setup
says so in words. Do not re-litigate this by scraping the app.

---

## What landed earlier in this session

Four briefs arrived and all four are delivered, merged and deployed.

| PR | What |
|---|---|
| #7, #8, #9 | Visual overhaul, BPA calibration, Vegas season-market foundation |
| #10 | The draft queue split from My Guy; tier + survival repair |
| #11 | Vegas free-tier budgeting and targeted fetching |
| #12 | The production quota check in the smoke probe |

### The ★ and the ♥ are two different marks

They used to be one stored value. Starring a player on the draft board
bookmarked him *and* moved him up the board; only the first was ever wanted.

- the ★ queue — written by the star on the draft board, read by the ★ filter,
  and **read by nothing else**. The board comes back in identical order with
  identical totals whether the star is lit or not; a unit test and an e2e test
  both assert it.
- `player_flags.level` — still My Guy, still written by the ♥ on the players
  list, still worth its bounded ranking boost.

Migration `0009` moved existing flags to queue entries and dropped the boost
they were silently applying.

> **Superseded in the storage, not in the principle.** The queue lived in
> `player_flags.queued` / `player_flags.queue_order` until migration `0029`,
> keyed by player id alone — one global list shown by whichever draft was open,
> which is how a finished best-ball shortlist turned up in the next league's
> draft. It is `draft_queue`, keyed `(draft_id, player_id)`, from `0029` on, and
> the routes moved to `/api/drafts/:id/queue` so there is no way to read or
> write one without naming the draft. My Guy did not move: it is an opinion
> about a player and outlives every draft he is in. See
> `src/server/repos/draftQueue.ts` and `tests/queueScope.test.ts`.

### Tiers are a distribution now, not a threshold

`src/core/draft/tiers.ts` is new and owns all of it. The old rule marked all
seven tight ends on a real board as `Tier cliff`, for two reasons: one gap floor
(8 picks) for every position, and "last in tier" asked of the players *at or
after* this one, which is true of the last man in every tier.

A cliff now needs the gap to the next available player to clear a per-position
floor (QB 12, TE 13, RB/WR 8), be ≥2× the median spacing both locally and
across the position, and not simply be where the position turns uniformly
sparse. A cap keeps at most a fifth of a position labelled. Classification is
**market-only** — a test asserts the labels are identical for an empty roster
and a full one, because roster need used to scale it.

Live production board after deploy: TE 1 cliff of 33, RB 2 of 53, QB 3 of 31,
WR 7 of 80.

### Survival conditions on the player still being there

`S(next) / S(current)` under the same logistic model, computed in log space so a
deep faller does not divide zero by zero. ADP 45, still on the board at pick 60,
now reads ~38% to reach pick 68 rather than ~5%. Colour bands live in
`src/core/draft/survival.ts` and the screen imports them.

### The Vegas quota model was measured, and the old note was wrong

This is the finding most likely to be re-litigated, so it is worth stating
plainly. **The free plan bills one "entity", and an entity is one *event*
returned** — not one odds object. A request for a single game cost exactly 1
whether the payload carried 6 lines or 194.

`docs/VEGAS.md` previously said a Sunday slate was "~3,200 objects against 2,500
a month". It was counting odds objects. **A sixteen-game Sunday is sixteen
entities.** The slate fetch was wasteful, not fatal.

The real risk was the season probe: `limit=25` on two requests, daily — up to
**1,500 entities a month**, 60% of the allowance, for markets this provider does
not publish. It is `limit=1` now (2 entities), skipped once the draft is
complete, and counted.

Everything else in `docs/VEGAS.md` under "What the free plan actually charges
for" is measured, with the probe that measured it. Do not replace those numbers
with numbers from a pricing page.

---

## The shape of the Vegas system now

```
VegasRefreshService          the only thing that may spend weekly quota
  ├─ provider.getAccountUsage()   free, authoritative, read before every run
  ├─ VegasUsageRepo.view()        ledger + provider count, larger of the two wins
  ├─ discoverIfNeeded()           by team, ≤ once per 72h, IS the first fetch
  ├─ buildFetchPlan()             roster → events, deduped, locked games dropped
  ├─ canSpend()                   healthy / caution / conservation / reserve / stop
  └─ getPropsWithCache()          per event, TTL and manual cooldown
```

- `src/core/vegas/budget.ts` — every threshold, and `canSpend`.
- `src/core/vegas/plan.ts` — the plan and `simulateMonth`.
- `src/server/repos/vegasUsage.ts`, `vegasEvents.ts` — ledger and learned schedule.
- Migration `0010` creates `vegas_usage`, `vegas_usage_log`, `vegas_events`.

Cost of the shipped strategy: **200 entities a month of 2,500 — 8%**.
`tests/vegas.budget.test.ts` fails if that stops being true.

`GET /api/vegas/budget` reports the month by source with the next plan; Setup
says the same in words. Neither makes a provider call.

### Turning the real provider on

`VEGAS_PROVIDER = "mock"` deliberately. Every gate the activation checklist asks
for exists and is tested — measured accounting, targeted requests, a simulated
month at 8%, a hard stop, stale fallback, dedupe, no slate fetch anywhere. What
has **not** happened is a real NFL Sunday. The strategy rests on mapping
Sleeper's team abbreviations (`KC`) onto this vendor's ids
(`KANSAS_CITY_CHIEFS_NFL`) — `matchTeam()` in `vegasRefresh.ts` — on kickoff
times, and on staleness arithmetic against a live slate. Preseason cannot
exercise any of it.

When the user wants it live:

1. `npx wrangler secret put SPORTSGAMEODDS_API_KEY` (the repo secret exists and
   authenticates; the Worker does not have it yet).
2. `VEGAS_PROVIDER = "sportsgameodds"` in `wrangler.toml`, redeploy.
3. Watch `/api/vegas/budget` after the first Saturday run. If `nextPlan.events`
   is larger than the roster spans, the team mapping has failed and it is
   fetching too much — that is what `probe-live-smoke.mjs` now checks for.

Do it on a weekend somebody can watch. The blast radius is bounded at 85% of a
free plan, but bounded is not zero.

---

## Traps this session fell into

Read these before touching the same ground. The earlier session's traps are
still true and are listed after them.

**The sandbox clock does not track the session's progress.** This cost a real
mistake: I merged PR #10 believing a 20-minute job timeout had "long since"
passed, when `date -u` showed only five minutes had elapsed. Sleeps do not
reliably consume wall-clock time relative to a sequence of tool calls. When
waiting on CI, check `date -u` and wait against it:

```bash
until [ "$(date -u +%s)" -ge "$(( $(date -u -d '<job started_at>' +%s) + 480 ))" ]; do sleep 15; done
```

WebKit e2e takes ~6.5 real minutes. Do not conclude a job is stale, hung or
finished from anything but its own `completed_at`.

**Vendor documentation is unreachable from here.** `sportsgameodds.com` is
blocked by the egress proxy, as is the production URL. Anything that needs the
open internet goes through `probe.yml`, which runs one `scripts/probe-*.mjs` on
a GitHub runner with the API key in env.

**Measure the quota, do not reason about it.** The pattern that worked:
read `/account/usage`, make one request, read it again, report the delta. It is
free (usage reads move neither counter) and it is the only thing that would have
caught the objects-vs-entities error. `scripts/probe-sgo-quota*.mjs` are the
templates.

**A filter you have not verified is a filter that returns everything.** The
`teamID` filter was checked against a real team id *and* a nonsense one, because
a silently-ignored filter would have returned the whole slate and billed for it.
Do the same for any new provider parameter.

**Probe logs are public.** The account payload carries an email, a customer id
and a key hash; `probe-sgo-quota-scale.mjs` redacts all three. Any new probe
that prints a provider payload must do the same.

### Still true from the previous session

- **Sleeper publishes no ADP.** Confirmed by full GraphQL introspection. ADP
  comes from beatadp.com via `refresh-adp.yml`. Do not re-litigate. The same
  introspection *does* list `get_player_outlook`, which is where the season
  outlook comes from — "no ADP" was never "no player data".
- **beatadp.com is blocked by the egress proxy** from this container (403 on
  CONNECT), so ADP cannot be fetched locally. `refresh-adp.yml` runs it on a
  GitHub runner. `api.sleeper.app` and `sleeper.app/graphql` *are* reachable
  here, which is how the outlook and stats endpoints were established.
- **`search_rank` is not ADP.** It measures who gets looked up; it is a search
  tie-break only.
- **D1 caps bound parameters at 100.** `MAX_BOUND_PARAMS = 90`; chunk any new
  batched query.
- **The Setup screen is layout-fragile**, and the panel that intercepts pointer
  events on its own contents is **still unfixed** — it was worked around by not
  clicking that control in a browser test. Investigate properly if it bites
  again.
- **The e2e suite shares one dev server across three browser projects.** Tests
  that mutate global config break later tests. Prefer asserting presence over
  flipping shared state.
- **WebKit is not installed in this container.** `npm run e2e` fails; use
  `CI=1 npm run e2e:chromium`. WebKit runs in CI.
- **One spec disagrees between the engines, and it is the fallback that is
  wrong.** `e2e/shell.spec.ts:179` — "the draft board shows at least eight
  players before a scroll" — fails at **Chromium 360 only**, on `main`, with no
  change in front of it. It is the first of the test's two assertions that goes:
  the chrome above the board measures 146.6px against a bound of 132, where
  WebKit 360 measures the 129px the comment describes. The count of cards on the
  first screen — the thing the test is named for — is not what fails.

  The cause is measured, not guessed. It is the roster-progress strip — the
  `0/1 QB · 1/2 RB · …` chips under the nav bar — wrapping to a second row. At
  360 Chromium lays out six chips on the first row and drops `0/4 BN` onto a
  second at `top=74.8` against the first row's `57.0`; that 17.8px is the whole
  of the 146.6-against-129 gap. Chromium simply measures the chips a shade wider
  than WebKit does and the seventh no longer fits. `isMobile` is not the reason
  and was checked: the fallback projects set `isMobile: true` and the WebKit ones
  cannot, but forcing it either way gives 146.59 in Chromium both times.

  So it is a font-metric difference between two engines over a strip that is
  *designed* to wrap when it has to, and neither engine is drawing the wrong
  thing. iPhone Safari is what ships, WebKit is the authority, and the bound
  stays tuned to it.

  Do not loosen the 132 to make the fallback green: 177 is the regression it was
  written to catch, and the margin is most of what it is worth. Note also that
  the assertion which fails is the chrome-height guard, not the claim the test
  is named for — the board is nine ordinary cards deep at Chromium 360, against
  the eight it asks for. `e2e:chromium` at 360 is expected to come back with
  this one failure and nothing else.
- **`actions_list` responses are enormous.** They get saved to a file; parse it
  with `python3` rather than reading it inline.

---

## Verification

```bash
npm run typecheck          # tsc
npx vitest run             # 882 tests, 39 files
CI=1 npm run e2e:chromium  # all four widths, fallback engine
npm run build
npx wrangler deploy --dry-run
```

A single width is 652 tests and about fourteen minutes here. CI shards each
width across three runners, and one of those runners is reproducible locally:

```bash
npx playwright test --project=chromium-small-360 --shard=2/3
```

Playwright splits by whole spec file (the config sets `fullyParallel: false`),
so a shard is a set of complete files running in their own order against their
own freshly seeded server — nothing is added anywhere when a spec file is.

Note `npx playwright test` with no project will try WebKit, which is not
installed here, and report ~225 failures that are all the missing browser. Use
`e2e:chromium`; CI runs WebKit and has never disagreed.

Deployment is automatic, but it starts from **CI passing on main**, not from the
push (`deploy.yml` → `release.yml`), and what it deploys is the exact SHA CI
validated. Production reports that SHA at `/api/health`, and `rollback.yml` puts
a named known-good revision back. Migrations are applied forward only and a code
rollback does not undo them — see `docs/RELEASE.md`, which is short and is the
first thing to read before touching anything under `.github/workflows/`.

Crons in `wrangler.toml`: Sat 23:00 and Sun 15:00 UTC for the Vegas refresh,
daily 09:00 UTC for the Sleeper player dictionary.

Useful probes (all read-only, all via `probe.yml`):

| Script | Answers |
|---|---|
| `probe-live-smoke.mjs` | is production serving what was just shipped, incl. the budget |
| `probe-tier-survival.mjs` | per-position tier ladder and survival on the live board |
| `probe-sgo-quota.mjs` | what the provider charges for |
| `probe-sgo-quota-scale.mjs` | how the bill scales, and the account's real ceilings |
| `probe-sgo-team-filter.mjs` | whether `teamID` is honoured |

---

## Loose ends

Nothing blocking. In rough order of value:

1. **A real Sunday with the provider on** — see the activation section above.
2. **A per-game usage source** (nflverse or similar). The role-change detector
   is finished and returns "insufficient data" until one exists; it is the last
   input the weekly decision layer is missing.
3. **Season-long markets do not exist at SportsGameOdds.** Proved three ways
   (event types, the market catalogue's periods, a live sweep). The pipeline is
   built and will light up if they ever appear; `INBOUND_SEASON_MARKETS` is
   where they would land.
4. **Draft-weight tuning UI**, so the market-vs-signal balance is adjustable
   without a deploy.
5. **The season-outlook cache fills one card at a time.** That is deliberate —
   there is no bulk query and a loop over the board would be exactly the
   fetching this project refuses — but it means the first open of each player
   costs one request. If it ever feels slow mid-draft, warm the top of the
   board from the nightly cron rather than widening the request path.
6. `origin/claude/probe-sgo-season` is a stale temp branch; deleting it failed
   with a remote hangup. Harmless — its scripts are on `main`.

---

## Standing rules that outrank convenience

From the user, verbatim in spirit:

- never commit or expose credentials, tokens, or account-recovery information
- no paid services, no credit card, no overage risk
- Sleeper is the source of truth for league, roster, scoring, draft state
- the evidence ledger is truth; tallies are derived and rebuildable
- unknown stays unknown — never invent a value
- never draft, never write a lineup to Sleeper
- deterministic and explainable: every recommendation shows its components
- user corrections are authoritative
- one action at a time when the user is genuinely needed, dummy-proofed, then stop

The user works asynchronously, expects autonomous work to land on `main`, and
does not want routine interruptions. Branch per piece of work, verify, merge
when green, deploy, smoke-test, then report once.

**And wait for the checks.** Green CI on the exact head is the gate, and the
clock in this sandbox will lie to you about whether it has arrived.
