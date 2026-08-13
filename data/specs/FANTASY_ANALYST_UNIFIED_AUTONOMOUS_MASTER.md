# Fantasy Analyst — Unified Autonomous Intelligence Master Pass

## Purpose

This document REPLACES the separate Draft Intelligence, Start/Sit Intelligence, and Trade Intelligence briefs.

Treat this as the single source of truth for the next major Fantasy Analyst implementation pass.

The project should operate as ONE shared intelligence system with three decision surfaces:

1. Draft
2. Start/Sit
3. Trades

All three must consume the same shared player identity, evidence ledger, Sleeper data, Vegas data, weather, recent usage, freshness, and explainability infrastructure.

Do not build three disconnected systems.

---

# Critical autonomy requirement

Claude Code should be as autonomous as possible.

The user does not want to be involved in implementation details, routine setup, testing, deployment preparation, configuration edits, repository commands, branch management, or ordinary technical decisions.

Claude should:

- inspect the repo itself;
- make reasonable reversible technical decisions itself;
- research current official docs when needed;
- choose the best free source based on verified current capabilities;
- implement code itself;
- run migrations itself when access permits;
- create/update config itself;
- run tests itself;
- fix failures itself;
- commit and push itself;
- create/update PRs itself;
- deploy or prepare deployment itself when existing auth allows;
- perform smoke tests itself;
- document what it changed.

Do NOT turn the user into a human command runner.

Only stop for user intervention when absolutely necessary, such as:

- account login/authorization that Claude cannot perform;
- an API key/signup that genuinely requires the user's identity/account;
- Cloudflare or GitHub permission approval unavailable to Claude;
- a secret that must be entered by the user;
- a destructive or irreversible action;
- a major product decision where two approaches would materially change intended behavior.

If a user-only action is required:

1. Give ONLY the single next action.
2. Make it dummy-proof.
3. Say exactly what website/app to open.
4. Say exactly what to click/type.
5. Say what success looks like.
6. STOP and wait.

Do not dump future steps.

Otherwise continue working autonomously until the branch is finished and PR-ready.

The user's preferred workflow is:

**Claude works → Claude tests/fixes → Claude pushes/opens PR → user reviews the finished result and gives product feedback.**

---

# Critical source update: no Underdog ADP

The project no longer uses Underdog ADP.

Do not add, restore, or depend on Underdog.

For draft market value / ADP:

**Use Sleeper ADP / Sleeper player market data as the draft-market source wherever currently available and reliable.**

Sleeper remains the primary fantasy source of truth for:

- league settings;
- scoring;
- rosters;
- draft state;
- drafted players;
- player identity;
- roster positions;
- lineup eligibility;
- player status where available;
- draft-market/ADP information where Sleeper exposes it.

If Sleeper does not expose a needed ADP field directly in the existing endpoint/model, inspect the current Sleeper payloads and existing project code first.

Do not introduce another ADP provider unless explicitly requested later.

---

# Shared architecture first

Before polishing any one feature, make sure shared infrastructure supports all three modes.

Shared sources/components:

## Sleeper

Use for:

- league;
- scoring;
- roster;
- current draft;
- current team;
- player identity;
- player status where available;
- current lineup;
- roster eligibility;
- Sleeper ADP / draft-market value where available.

## Evidence ledger

This remains source of truth for newsletter intelligence.

Preserve:

- lifetime tally;
- 30-day tally;
- 7-day tally;
- category;
- magnitude;
- polarity;
- confidence;
- user overrides;
- original evidence.

Never store only the aggregate.

## Vegas

Use a free/free-tier provider selected after verifying CURRENT official limits and NFL coverage.

Evaluation preference:

1. SharpAPI
2. SportsGameOdds
3. The Odds API

Pick the best actually-free provider based on observed player-prop + game-line coverage.

Need:

- player props;
- game total;
- spread;
- implied team scoring environment;
- line movement snapshots;
- freshness;
- caching.

Do not enable paid plans.

Do not enter a credit card.

## Weather

Prefer a free source such as:

- Open-Meteo
- National Weather Service API

No paid weather API.

## Recent opportunity / usage

Prefer a genuinely free source such as nflverse/nflfastR if it is timely enough.

Useful fields:

- targets;
- carries;
- receptions;
- pass attempts;
- rush attempts;
- receiving yards;
- rushing yards;
- snaps/routes/red-zone usage only if reliably available.

Do not scrape random fantasy websites.

---

# Implementation order

Implement in this order to minimize rework:

## Phase A — Shared intelligence foundation

1. Verify/complete free Vegas provider integration.
2. Add game total/spread/implied team total.
3. Preserve sportsbook snapshots so line movement can be calculated.
4. Add weather source + stadium metadata.
5. Add recent usage/opportunity source.
6. Add source freshness/caching/health.
7. Extend shared recommendation component types so Draft, Start/Sit, and Trade can consume clean inputs.

## Phase B — Draft intelligence

1. Lifetime tally never decays.
2. Recency boosts/penalties layer on top of lifetime.
3. Use Sleeper ADP instead of Underdog.
4. Add roster-aware needs.
5. Add position scarcity.
6. Add team concentration/stack logic.
7. Use survival-to-next-pick.
8. Keep explanations visible.

## Phase C — Start/Sit intelligence

1. Vegas player-prop baseline.
2. Prop-line movement.
3. Game total/spread/implied team total.
4. Position-aware game-script adjustments.
5. Weather.
6. Injury/status gating.
7. Late-swap risk.
8. Recent opportunity trend.
9. Signal agreement/disagreement.
10. Whole-roster recommendation support where practical.

## Phase D — Trade intelligence

1. Trade Targets.
2. Emerging Targets.
3. Possible Sell High.
4. Trade Away / Risk Reduction.
5. Hold / Mixed.
6. Use 30-day + 7-day trend heavily.
7. Preserve lifetime signal as context.
8. Reuse Vegas/usage when available as supporting evidence.

Do not prematurely over-tune weights.

First ensure all signals are:

- correctly collected;
- normalized;
- timestamped;
- inspectable;
- tested;
- explained.

---

# Shared explainability rule

Every decision must expose component reasoning.

Do not return only:

`Player A score = 87`

Instead expose relevant components such as:

- market value;
- lifetime news;
- 30-day news;
- 7-day momentum;
- roster need;
- scarcity;
- concentration/stack;
- Vegas baseline;
- prop movement;
- game environment;
- weather;
- injury/status;
- opportunity trend;
- uncertainty;
- confidence;
- reasons;
- counterpoints.

Unknown remains unknown.

---

# Draft Intelligence

## Lifetime tally is permanent

This is non-negotiable.

For Draft Mode:

- ALL accepted/auto-applied/corrected historical evidence continues to count;
- old positive evidence never drops out of lifetime;
- old negative evidence never drops out of lifetime;
- do not decay lifetime evidence;
- do not replace lifetime with recent-only scoring.

If a player was favored all offseason, that should matter on draft day.

Recent evidence is an ADDITIONAL modifier.

Example:

Player A:
- lifetime +12
- 30d +1
- 7d 0

Player B:
- lifetime +2
- 30d +4
- 7d +2

Player A retains the stronger lifetime foundation.

Player B receives a recency/momentum boost.

Do not erase Player A's offseason advantage.

---

## Draft news component

Keep separate:

- lifetime net;
- lifetime positive count;
- lifetime negative count;
- 30-day net;
- 7-day net;
- recency boost;
- conflict penalty;
- final news contribution.

Starting philosophy:

- lifetime = dominant base;
- 30-day = meaningful modifier;
- 7-day = acceleration modifier.

Centralize weights.


## Increase tally influence on draft rankings

The current implementation has treated news/tally intelligence too conservatively.

For Draft Mode, increase the influence of the user's evidence/tally signal so that it becomes a **meaningful secondary ranking factor**, not merely a tiny tiebreaker.

The user's accumulated research is intended to create a real edge.

### Desired behavior

When two players are reasonably close in Sleeper ADP / market value:

- a strongly positive lifetime tally should be able to move a player several spots higher;
- a strongly negative lifetime tally should be able to move a player several spots lower;
- strong recent positive evidence should add an additional boost;
- strong recent negative evidence should add an additional penalty.

Example:

Player A
- Sleeper ADP: 48
- Lifetime tally: +12
- 30d: +4

Player B
- Sleeper ADP: 44
- Lifetime tally: 0
- 30d: 0

It should be entirely plausible for Player A to rank ahead of Player B if roster context and scarcity are otherwise similar.

Likewise:

Player C
- Sleeper ADP: 50
- Lifetime tally: -10
- 30d: -4

should be meaningfully downgraded relative to a similarly valued player with neutral or positive evidence.

### But do not let tally become absolute

Do not make tally capable of blindly overriding everything.

A large positive tally should NOT automatically beat:

- a massive Sleeper ADP gap;
- a critical missing-position need late in the draft;
- a severe roster-construction problem;
- a major positional tier cliff;
- strong contradictory recent evidence;
- an unavailable/injured player.

Think of tally as a **strong secondary input**.

The practical target is:

- market/ADP remains an important baseline;
- roster construction and scarcity remain important;
- the user's intelligence can materially reshape close and medium-close decisions.

### Calibration

Increase the current tally/news weights enough that real examples visibly change ranking order.

Do not simply change a displayed score while leaving ordering effectively unchanged.

Add fixture tests proving that:

1. a strong positive lifetime tally can move a player above a modestly better-ADP player;
2. a strong negative tally can move a player below a modestly worse-ADP alternative;
3. recent positive momentum increases the effect;
4. recent negative momentum increases the penalty;
5. huge market-value gaps still usually remain dominant;
6. critical roster need can still override tally when appropriate.

### Explain the impact

For any player whose ranking changed materially because of evidence, surface it clearly:

- `Boosted by strong lifetime signal`
- `Boosted by recent positive trend`
- `Downgraded by negative lifetime signal`
- `Downgraded by recent deterioration`

If possible, show the approximate contribution or rank movement in expanded reasoning.

Do not hide this in a magic score.

### Start/Sit and Trade modes

Do NOT automatically apply the same stronger weighting to every mode.

- Draft Mode: stronger tally influence is explicitly desired.
- Start/Sit: Vegas, availability, and recent opportunity should remain primary; recent news can influence close decisions.
- Trade Intelligence: 30-day/7-day evidence already intentionally carries heavy weight.

Tune each mode for its purpose rather than globally multiplying tally everywhere.


---

## Sleeper ADP / market value

Use Sleeper ADP as the market baseline.

Display:

- Sleeper ADP;
- current pick;
- ADP value / reach;
- survival to next pick.

Do not refer to Underdog anywhere in new UI, docs, code comments, or recommendation copy.

If legacy Underdog code exists and is no longer needed, remove or disable it safely only after confirming nothing else depends on it.

---

## Roster-aware draft recommendations

Recompute needs after every pick.

Use:

- starting requirements;
- FLEX/SUPERFLEX;
- bench;
- current round;
- current roster;
- future pick distance;
- available players;
- positional tier depth.


## Live roster during the draft — non-negotiable UX requirement

The **Team** page must show the user's roster DURING an active Sleeper draft, not only after the draft is complete.

Do not wait for Sleeper's post-draft roster state if the live draft pick stream already contains enough information to reconstruct the user's drafted team.

During an active draft:

- identify the user's Sleeper draft slot / roster ownership;
- consume live draft picks as they occur;
- immediately add the user's newly drafted player to the Team page;
- preserve all previously drafted players;
- update position counts and starting-slot coverage;
- update roster-need calculations after every user pick;
- reflect the same live roster state on the Draft page and Team page;
- avoid requiring a manual refresh whenever reasonable;
- if polling is needed, use the existing efficient live-draft polling architecture;
- clearly show that the roster is a **live draft roster** while the draft is in progress.

The desired experience is:

1. User drafts a player in Sleeper.
2. Fantasy Analyst detects the pick.
3. Within the normal live-poll interval, that player appears on **Team**.
4. Draft recommendations immediately recalculate using the updated roster.

The Team page should remain useful throughout the draft.

### Draft-time Team page presentation

Show a compact roster organized by actual Sleeper starting requirements where practical:

- QB
- RB
- WR
- TE
- FLEX / SUPERFLEX
- Bench / drafted depth

If exact starting-slot assignment is ambiguous mid-draft, do not fabricate a final lineup. Show drafted players grouped sensibly by position and indicate open required slots.

Useful draft-time indicators:

- `Live draft`
- picks made by user;
- roster spots filled;
- roster spots remaining;
- missing starting positions;
- position counts;
- next user pick if known.

### Source-of-truth behavior

During an active draft, reconstruct the user's current roster from the live Sleeper draft pick data if that is more current than Sleeper's normal roster endpoint.

After the draft completes, reconcile with Sleeper's canonical roster data.

Do not create duplicate roster entries during the transition from live draft state to post-draft roster state.

If Sleeper draft ownership cannot be confidently mapped to the user, show an explicit setup/review state rather than guessing.

### Testing

Add coverage for:

- first user pick appears on Team page during active draft;
- subsequent user picks append correctly;
- opponent picks do not appear on user's Team page;
- roster counts update after every user pick;
- missing-position indicators update immediately;
- draft recommendation engine consumes the same live roster state;
- draft completion reconciles to Sleeper roster without duplicates;
- reconnect/reload preserves correct live drafted roster;
- iPhone Team page remains readable during an active draft.


### Missing starters

Example:

Round 10 and no TE:
- meaningful TE boost;
- stronger if TE tier cliff is near;
- do not force TE if remaining TE value is poor and depth remains strong.

Explain:

`You still need a starting TE and the current tier may not reach your next pick.`

---

## Round awareness

### Early
Prioritize:
- elite value;
- lifetime signal;
- scarcity;
- do not force needs too early.

### Middle
Increase:
- roster construction;
- missing starters;
- scarcity;
- value.

### Late
Increase:
- completing lineup;
- upside;
- diversification;
- contingent value;
- positive recent news.

---

## Position scarcity

Use remaining player pool and Sleeper ADP tiers.

Boost a position when:
- user needs it;
- current tier is ending;
- next tier is materially worse;
- candidate is unlikely to survive.

---

## Same-team / concentration logic

Do NOT blanket-ban same-team players.

Use a modest adjustment.

Potential small positives:
- QB + WR
- QB + TE

Potential small negatives:
- too many skill players from same offense;
- RB + multiple pass catchers on mediocre offense;
- redundant role overlap.

RB + RB may be:
- negative redundancy;
- or intentional handcuff.

A great-value player can override a concentration penalty.

---

## Draft recommendation display

Compact iPhone row/card:

**Player**
Position · Team

Sleeper ADP  
Value vs pick  
Lifetime tally  
30d tally  
Need  
Survival %

Expandable:
- roster need;
- scarcity;
- concentration/stack;
- news history;
- reasons/counterpoints.

---

# Start/Sit Intelligence

## Vegas player baseline

Use market lines as expectation inputs, not betting advice.

Position-relevant props:

QB:
- pass yards;
- pass TDs;
- rush yards.

RB:
- rush yards;
- receiving yards;
- receptions;
- anytime TD.

WR/TE:
- receiving yards;
- receptions;
- anytime TD;
- occasional rush yards.

Convert using ACTUAL Sleeper scoring.

Example half-PPR:

59.5 receiving yards → 5.95
4.5 receptions → 2.25
37% TD probability × 6 → 2.22 expected TD points

Market baseline ≈ 10.42

Avoid double counting.

---

## Prop line movement

Preserve snapshots.

Show:
- first weekly line;
- latest;
- 24h movement where available;
- near-kickoff movement.

Example:

Saturday: 52.5  
Sunday: 59.5

Display:

`Receiving line 59.5 ↑ 7.0`

Normalize importance by market type.

Multiple related markets moving together should increase confidence.

Conflicting markets lower confidence.

---

## Game total / spread / implied team total

Store:
- total;
- spread;
- moneyline if useful;
- movement;
- consensus;
- freshness.

Derive implied team scoring transparently.

Label derived team totals as derived unless provider directly supplies team total.

---

## Position-aware game script

### RB
Favored team → small boost due to possible rushing/red-zone environment.

### WR/TE
Underdog → small possible pass-volume boost.

### QB
High total and competitive game can help.
Huge-favorite blowout risk may cap volume.

Effects should be modest relative to player props and actual recent usage.

---

## Weather

Only apply meaningfully to outdoor/open-roof games.

Maintain stadium metadata:
- coordinates;
- roof type;
- timezone.

Important variables:
- sustained wind;
- gusts;
- precipitation;
- temperature;
- snow/thunderstorm where available.

Wind strongest.

Suggested tunable starting guide:
- <10 mph negligible;
- 10–15 small;
- 15–20 meaningful;
- >20 strong concern.

Rain:
- light = small;
- heavy = modest meaningful effect.

Cold alone:
- small.

Do not double-count weather if Vegas total has already moved substantially because of the same conditions.

---

## Injury / availability

Strong gate.

Use:
1. Sleeper status;
2. newsletter evidence;
3. prop presence/movement;
4. practice-related evidence if available.

Out / IR / Suspended:
- hard block.

Doubtful:
- very strong penalty.

Questionable:
- evaluate context;
- do not auto-bench.

If props disappear close to kickoff:
- warning only;
- do not automatically infer injury.

Display:
`Props disappeared — verify status.`

---

## Late-swap risk

Compare:
- kickoff times;
- questionable player;
- healthy alternatives;
- expected score gap;
- confidence;
- prop availability.

Surface a warning when a late player has only a small projection edge over a healthy early option.

---

## Recent opportunity

Focus on opportunity, not fantasy points alone.

Last 3 vs season average.

WR/TE:
- targets;
- receptions;
- routes/snaps if reliable;
- red-zone targets if reliable.

RB:
- carries;
- targets;
- receptions;
- red-zone touches;
- snaps if reliable.

QB:
- pass attempts;
- rush attempts;
- red-zone rushing if reliable.

Trend labels:
- Rising
- Stable
- Falling
- Mixed
- Insufficient data

Do not overreact to one game.

---

## Signal agreement/conflict

Inputs:
- Vegas baseline;
- prop movement;
- game environment;
- weather;
- injury;
- opportunity;
- 30d news;
- 7d news.

Return:
- Strong agreement
- Moderate agreement
- Mixed
- Conflicting
- Insufficient

This should affect confidence heavily.

---

## Whole-roster recommendation

Where practical, rank all eligible players for actual Sleeper slots.

Respect:
- QB/RB/WR/TE/FLEX/SF;
- locked players;
- kickoff time;
- questionable status.

Never write lineup changes to Sleeper.

Recommendation only.

---

# Trade Intelligence

## Trade Targets

Players the user does NOT roster.

Main driver:
- positive 30-day signal;
- 7-day acceleration;
- evidence volume;
- season/lifetime context;
- category quality;
- conflict/uncertainty.

Lifetime remains context.

Recent signal is the primary trade-discovery driver.

---

## Emerging Target

Use when:
- trend is improving;
- signal is positive;
- sample is still limited.

---

## Possible Sell High

Rostered players with:
- deteriorating recent evidence;
- negative 30-day;
- negative 7-day momentum;
- meaningful current value signal if any exists.

Do not call someone "sell high" solely because their news is bad.

If market/value evidence is weak, label:
`Possible Sell High`

---

## Trade Away / Risk Reduction

Use when:
- sustained negative evidence;
- deteriorating role/health/opportunity;
- current value may already be poor.

---

## Hold / Mixed

Use when:
- contradictory evidence;
- sparse evidence;
- recent rebound;
- uncertainty too high.

---

## Trade signal windows

At minimum:
- 7 days;
- rolling 30 days;
- season;
- lifetime.

30-day is the main trade window.

Lifetime never disappears, but it should not dominate trade discovery the same way it dominates draft scoring.

---

## Free agents / waiver players

If Sleeper ownership data shows a player can simply be added:

Do not call them a trade target.

Use:
`Add / Waiver Target`

Separate from actual trade targets.

---

## Trade + Vegas/usage

If available:

Positive recent evidence + improving Vegas + improving opportunity
→ stronger Trade Target confidence.

Negative recent evidence + still-strong Vegas baseline
→ can support literal Sell High.

Negative recent evidence + falling Vegas + falling opportunity
→ stronger Trade Away / Risk Reduction.

Trade engine must still function without Vegas.

---

# Source freshness

Every shared source must carry timestamps.

Examples:
- Sleeper synced 9:07 AM
- Vegas 8:31 AM
- Weather 9:05 AM
- Usage through Week 4
- Newsletter last processed 7:42 AM

Stale data reduces confidence.

Never present stale data as fresh.

---

# Free-tier discipline

No paid plans.

No credit card.

No unnecessary polling.

Sportsbook refresh cadence should be provider-quota-aware.

Weather can refresh more frequently.

Usage stats refresh after data publishes.

Completed historical stats should be cached permanently.

Provider failure:
- retain last good snapshot;
- mark stale;
- reduce confidence;
- do not erase data.

---

# UI structure

Keep navigation compact.

Suggested:

- Draft
- Start/Sit
- Trades
- Players
- Review
- Setup

Primary device:
iPhone Safari.

Avoid:
- giant dashboards;
- excessive decorative cards;
- sportsbook visual language;
- technical jargon.

---

# Shared player detail

A player detail view can show all intelligence in one place:

- lifetime tally;
- 30d tally;
- 7d tally;
- evidence timeline;
- Sleeper ADP;
- roster ownership;
- current props;
- prop movement;
- recent opportunity;
- injury/status;
- weather/game environment;
- trade signal;
- draft signal.

Do not duplicate separate player truth across modes.


---

# Player Identity Repair / “Help My Scores” — required

The app must provide a simple user-facing way to repair player identity mismatches when newsletter/tally data cannot be confidently attached to a canonical Sleeper player.

This is important because aliases and shorthand such as:

- `JSN`
- `Jaxon Smith-Njigba`
- `Jaxon Smith Njigba`
- surname-only mentions;
- punctuation variants;
- common fantasy abbreviations;

may refer to the same player, but deterministic matching may intentionally refuse to guess.

A mismatch must NEVER silently cause a player's tally boost to disappear.

## Product behavior

Add a Settings / Setup section called something like:

**Help My Scores**

or

**Fix Player Matches**

Use plain language.

This screen should show unresolved or suspicious player references that are preventing evidence from contributing to a canonical player's score.

Examples:

- `JSN` — 9 evidence items — not matched
- `J. Smith-Njigba` — 3 evidence items — ambiguous
- `Hollywood Brown` — 2 evidence items — needs confirmation

For each unresolved reference, show:

- the source name/alias;
- number of evidence items;
- net tally represented by those items;
- recent 30-day tally represented;
- example evidence context;
- current match status;
- suggested candidate players if available.

## Manual assignment flow

The user should be able to tap an unresolved reference and choose the correct canonical Sleeper player.

Example:

`JSN`
→ Select player
→ search `Jaxon Smith-Njigba`
→ confirm

After confirmation:

1. create/persist the alias mapping;
2. attach all appropriate unresolved evidence items to that canonical player;
3. rebuild the player's derived lifetime/30d/7d signals;
4. update Draft, Start/Sit, Trades, Players, and Team views immediately;
5. future occurrences of that same alias should automatically map to the confirmed player;
6. do not require the user to repair the same alias repeatedly.

User-confirmed alias mappings are authoritative.

Do not overwrite them during future sync/reprocessing unless the user explicitly changes them.

## Important JSN example

Treat the following as a canonical test case:

`JSN`
must be able to map to
`Jaxon Smith-Njigba`

If the evidence ledger contains a large positive tally under `JSN`, once the user confirms that alias, Jaxon Smith-Njigba's lifetime and recent draft/news boosts must reflect those items.

This is exactly the class of issue this feature must solve.

## Unmatched evidence visibility

Do not hide unmatched evidence in developer logs.

Show the user when unresolved evidence exists.

Useful Setup summary:

**Help My Scores**
3 player names need matching
+14 net tally currently not assigned

Tap to fix

This should make missing intelligence obvious before draft day.

## Review-like UX

Reuse the interaction style/patterns from the existing Review section where practical.

The user is comfortable manually resolving a small number of ambiguous cases.

The flow should be fast on iPhone:

- unresolved alias card;
- suggested players;
- search;
- select;
- confirm;
- next unresolved item.

Support bulk consequence automatically:

one confirmed alias should repair all matching unresolved evidence where safe.

## Candidate suggestions

Use the canonical player database to suggest likely matches.

Prefer:

1. exact alias normalization;
2. exact name variant;
3. known abbreviation;
4. same-team/position hints if present;
5. bounded fuzzy candidates.

But DO NOT auto-commit ambiguous fuzzy matches.

The user should confirm.

## Persistent alias table

Store confirmed mappings in the existing alias/identity system.

Suggested fields if not already present:

- alias;
- normalized_alias;
- canonical_player_id;
- source;
- user_confirmed;
- confirmed_at.

Do not create a separate one-off workaround only for the UI.

This should improve the canonical identity system globally.

## Reprocessing behavior

After a new manual mapping:

- re-run affected unresolved evidence;
- preserve original excerpts;
- preserve user overrides;
- avoid duplicate evidence;
- update caches/signals idempotently.

Do not require the newsletter itself to be re-imported manually.

## Suspicious zero-boost detection

Add a lightweight diagnostic to catch cases where:

- an unresolved alias has non-zero tally;
- a likely canonical player has zero/low tally;
- evidence volume is significant.

Do not auto-merge based on this alone.

Surface it under **Help My Scores** as a likely mismatch.

Example:

`JSN` has +11 unresolved
Possible match: Jaxon Smith-Njigba
Current canonical tally boost: 0

## Draft-day readiness

Before an active draft, if unresolved evidence would materially affect rankings, show a non-blocking warning:

**Some player scores need matching**
2 unresolved names represent +12 net tally.
Fix now

Do not block the draft.

Do not silently ignore the missing signal.

## Tests

Add coverage for:

- `JSN` → `Jaxon Smith-Njigba`;
- punctuation/hyphen normalization;
- abbreviation mapping;
- user-confirmed alias persistence;
- future occurrences auto-map after confirmation;
- unresolved evidence excluded until mapped;
- mapping rebuilds lifetime/30d/7d signals;
- no duplicate evidence after remap;
- user override survives remap/reprocess;
- ambiguous candidate remains unresolved;
- Help My Scores badge/count;
- draft ranking updates after alias repair;
- iPhone flow for search/select/confirm.


---

# Testing

Retain all existing tests.

Add deterministic coverage for:

## Draft
- lifetime never decays;
- recency adds modifier;
- roster need;
- missing TE/QB;
- scarcity;
- concentration;
- stack bonus;
- round awareness;
- survival;
- Sleeper ADP value.

## Start/Sit
- Vegas normalization;
- prop movement;
- game total/spread;
- implied team total;
- position-aware script;
- weather;
- injury gates;
- late swap;
- recent usage;
- signal conflict;
- stale fallbacks;
- lineup eligibility.

## Trades
- positive 30d targets;
- recent acceleration;
- negative rostered candidates;
- sell-high distinction;
- trade-away distinction;
- mixed/hold;
- free-agent separation;
- lifetime context;
- Vegas/usage optional support.

## Browser
At:
- 390x844
- 375x812
- 360x800

Run:
- typecheck;
- full tests;
- browser tests;
- build;
- Wrangler dry-run.

Fix failures before stopping.

---

# Git / merge workflow

Use feature branches.

Do not work directly on main.

If multiple related branches already exist:

- inspect them;
- avoid duplicating work;
- integrate in a sensible order;
- rebase/merge as needed;
- preserve green exact-head verification.

Claude should autonomously:

- commit;
- push;
- open/update PR;
- resolve ordinary conflicts;
- rerun tests after integration.

Do not merge into main without explicit user approval unless the user has already clearly delegated merge authority for this pass.

If merge authority is not explicit, leave the PR ready and report that it is safe to merge.

---

# Completion standard

Do not stop merely because the first implementation works.

Before handing back to the user:

1. Run all relevant tests.
2. Fix failures.
3. Inspect iPhone-sized UX.
4. Inspect degraded states.
5. Verify source freshness behavior.
6. Verify no paid dependency was introduced.
7. Verify no secret is committed.
8. Verify Sleeper is the only ADP source.
9. Verify all three modes consume shared intelligence rather than duplicate data.
10. Verify explanations match actual calculations.
11. Push final branch state.
12. Ensure PR is ready.

The user intends to review the finished result and provide product feedback afterward.

---

# Completion report

At the end, answer in plain English:

## Shared sources
1. Which free Vegas provider was chosen and why?
2. Which free weather source was chosen?
3. Which free recent-usage source was chosen?
4. Are all still free for this use?
5. How often does each refresh?

## Draft
6. Does lifetime tally ever decay?
7. How do 30d and 7d modify lifetime?
8. Is Sleeper ADP the only ADP source now?
9. How does roster need work?
10. How do missing positions become more urgent?
11. How do stacks/concentration work?
12. How is survival-to-next-pick used?
13. How much stronger is tally influence on draft rankings now, and can it visibly reorder close ADP decisions?
14. Does the Team page update live during an active draft, and how quickly after each pick?

## Start/Sit
15. How is Vegas baseline calculated?
16. How is prop movement used?
17. How are spread/total used by position?
18. How does weather affect recommendations?
19. How are injury and late-swap risks handled?
20. Which recent usage metrics are available?
21. How does signal disagreement affect confidence?
22. Can the app recommend a whole lineup without writing to Sleeper?

## Trades
23. How are Trade Targets ranked?
24. How are Sell High vs Trade Away separated?
25. How much does 30-day signal matter?
26. How is lifetime used in trade logic?
27. Are free agents separated from actual trade targets?

## Quality
28. What exactly will the user see on iPhone?
29. Are all tests green?
30. Is the branch safe to merge?
31. Is the PR ready?
32. Does Help My Scores surface unresolved aliases and let me permanently map them to Sleeper players?
33. Is there any manual step required?

If a manual step remains, give only the single next required action in dummy-proof terms.

Start by inspecting the current repository and reconciling any existing implementation with this unified brief.
