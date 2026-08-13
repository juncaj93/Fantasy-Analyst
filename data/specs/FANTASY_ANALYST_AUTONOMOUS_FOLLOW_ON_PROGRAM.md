# Fantasy Analyst — Autonomous Follow-On Program
## Decision Quality + Visual Refinement, Non-Interrupting

## Read this first

This is a **queued follow-on work package** for Fantasy Analyst.

You are currently working on other Fantasy Analyst features.

**Do not interrupt, abandon, partially rewrite, or destabilize your current work in order to start this package.**

Finish the current workstream first.

The intended autonomous sequence is:

1. Finish the work you are currently doing.
2. Run its full required verification.
3. Fix failures.
4. Commit/push it.
5. Merge it into `main` if it is safe, all required checks are green, and no genuinely user-only approval or destructive decision is required.
6. Update your local `main`.
7. Only then begin **Phase 1 — Decision Quality** from this document.
8. Finish, test, commit, push, and integrate Phase 1 cleanly.
9. Update `main` again.
10. Then begin **Phase 2 — Visual Refinement**.
11. Finish, test, commit, push, and integrate Phase 2 cleanly.
12. Leave the deployed/current product in a green state and give one final plain-English report.

The user expects to be away while this runs.

The user does **not** want routine interruptions.

---

# Autonomy mandate

Operate as autonomously as reasonably possible.

The user is comfortable reviewing the finished result afterward and giving product feedback then.

Do not ask the user about:

- implementation details;
- routine architecture choices;
- branch naming;
- test fixes;
- CSS choices within the provided direction;
- reversible UX details;
- refactors needed to support the specified behavior;
- ordinary Git operations;
- ordinary Cloudflare/Wrangler commands you can perform;
- whether to proceed from one phase to the next when the prior phase is green.

You should independently:

- inspect the current repo state;
- understand work already landed since this brief was written;
- avoid duplicating features that already exist;
- adapt this brief to the actual current architecture;
- make reasonable reversible decisions;
- add/update tests;
- fix regressions;
- commit;
- push;
- create/update PRs;
- merge completed green work when safe;
- deploy when the existing project workflow/auth permits;
- smoke test the resulting site.

## Only interrupt the user if absolutely necessary

Stop only for something you genuinely cannot perform, such as:

- account authentication/authorization that requires the user;
- an API key or secret only the user can obtain/enter;
- a destructive or irreversible operation with meaningful risk;
- a major product decision where the brief does not establish intent;
- an external service/account action that cannot be completed with current access.

If that happens:

1. Ask for **one action only**.
2. Make it dummy-proof.
3. Say exactly what to open/click/type.
4. Say what success looks like.
5. Stop and wait.

Do not dump a future checklist.

---

# Branch and integration strategy

Do not put all of this into one giant risky branch if the repo is actively moving.

Preferred sequence:

## Current work
Finish and integrate whatever is already in progress.

## Phase 1 branch
Create a fresh branch from updated `main` for **Decision Quality**.

Implement the functional decision-support improvements first.

Why first:
- these changes affect recommendation behavior and state;
- the visual pass must style the final functional surfaces rather than an outdated intermediate UI;
- this minimizes conflicts and rework.

Once Phase 1 is exact-head green:
- commit;
- push;
- open/update PR;
- merge when safe;
- pull/update `main`.

## Phase 2 branch
Create a fresh branch from the newly updated `main` for **Visual Refinement**.

The visual pass is **presentation only**.

It must not change the behavior implemented in Phase 1 or prior features.

Once Phase 2 is exact-head green:
- commit;
- push;
- open/update PR;
- merge when safe;
- deploy/smoke test if that is part of the current project workflow.

Do not leave duplicate stale branches as the only source of completed work.

---

# Existing architecture and product intent outrank stale implementation assumptions

Before coding:

- inspect the current repo;
- inspect current tests;
- inspect current feature branches/PRs if relevant;
- identify whether any item in this brief is already implemented;
- preserve the strongest current implementation;
- do not regress newer work simply because wording in this document assumes an older state.

If a requested feature already exists:
- verify it works as intended;
- strengthen it only where the brief requires;
- do not rebuild it unnecessarily.

---

# Non-negotiable product rules

Preserve the project's standing rules:

- no paid AI at runtime;
- no new external APIs for this queued package;
- Sleeper remains source of truth for league/draft/roster/lineup facts;
- evidence/tallies remain deterministic and explainable;
- existing Vegas/game-line/weather/usage integrations are reused, not replaced;
- never auto-draft;
- never write lineup changes to Sleeper;
- user choices/flags outrank inference where applicable;
- unknown is allowed;
- missing/stale data must not be fabricated;
- iPhone Safari is the primary experience.

---

# PHASE 1 — Decision Quality

Implement the complete Decision Quality brief below.

Key outcomes include:

### Draft
- tier-cliff warnings;
- roster construction alerts;
- ★ / ★★ / ★★★ My Guy;
- AVOID tag at lifetime tally <= -5;
- Can Probably Wait / Risky to Wait / Take Now guidance.

### Weekly / Start-Sit
- late-swap safety;
- meaningful Vegas market-movement alerts;
- smart multi-game role-change detection;
- locked-game awareness.

These must affect the existing recommendation engines, not exist as decorative labels only.

Do not add a new API.

After implementation:
- run all relevant tests;
- add missing deterministic coverage;
- verify iPhone behavior;
- fix failures;
- integrate cleanly before Phase 2.

---

# PHASE 2 — Visual Refinement

After Phase 1 is integrated into `main`, execute the complete Visual Overhaul brief below.

This phase is **visual only**.

Do not alter:
- recommendation weights;
- decision logic;
- APIs;
- data models;
- draft calculations;
- start/sit calculations;
- trade calculations;
- identity matching;
- sync behavior;
- navigation destinations;
- feature structure.

The purpose is to make the final functionality much easier to scan and use on iPhone.

Key outcomes include:

- consistent position color coding;
- remove the large Draft pick / “until you” banner;
- show league name only in the Draft header;
- fit substantially more players on screen;
- tighten unnecessary whitespace;
- make bottom navigation flush with the iPhone safe area;
- preserve every interaction and function.

Because Phase 1 adds new decision tags/states, visually integrate them carefully without badge clutter.

Prioritize no more than the most decision-relevant 1–2 inline tags per player row; deeper detail can remain expandable.

---

# Cross-phase integration rules

The two phases must feel like one product.

Examples:

- `★★ My Guy` should coexist cleanly with position color coding.
- `AVOID` must be prominent but not make rows huge.
- `Tier cliff`, `Can wait`, `Risky to wait`, and market movement should use compact visual treatments.
- Position colors must not conflict with positive/negative/alert semantics.
- Locked-game indicators must remain readable.
- The denser Draft layout must still leave My Guy controls tappable.
- Visual compression must not hide recommendation reasons or remove existing functionality.

Do not sacrifice usability for density.

---

# Final autonomous QA

After both phases are integrated:

## Functional
Verify:
- Draft recommendations still compute;
- My Guy persists and changes rankings by level;
- AVOID threshold works;
- tier cliffs and Can Probably Wait work;
- roster alerts use live draft roster;
- late-swap logic respects Questionable/Doubtful;
- market movement only fires on meaningful changes;
- role change avoids one-game false positives;
- locked players disappear from impossible swap options.

## Visual
Verify at:
- 390×844
- 375×812
- 360×800

Check:
- position colors are consistent;
- Draft banner is gone;
- league header is compact;
- player density is materially improved;
- bottom nav is flush to safe area;
- new decision tags do not create clutter;
- no important names/values are clipped;
- touch targets remain usable.

## Engineering
Run:
- typecheck;
- full automated test suite;
- browser/E2E suite;
- production build;
- Wrangler dry-run or equivalent deployment packaging check;
- any existing project-specific exact-head checks.

Fix failures before merging.

If WebKit is available, run it.
If not, run the strongest available mobile browser checks and report the limitation without blocking unrelated work.

---

# Final report — one report after the entire queued program

Do not send progress updates unless blocked.

When all work is complete, give one concise plain-English report covering:

1. What current work was completed before this package began.
2. What Decision Quality features were added.
3. How My Guy ★ / ★★ / ★★★ affects rankings.
4. How AVOID works.
5. How tier cliffs and Can Probably Wait work together.
6. How late-swap safety works.
7. What market movement triggers an alert.
8. How role-change confidence avoids one-game noise.
9. How locked-game awareness works.
10. What visual changes were made.
11. How many more Draft player rows roughly fit in the first iPhone viewport.
12. Whether all existing functionality was preserved.
13. Tests/checks run and results.
14. Branches/PRs merged.
15. Deployment/live smoke-test status if applicable.
16. Any remaining known limitation.
17. Whether the user needs to do anything.

If no user action is needed, explicitly say:

**No manual action is required. Review the finished site and send product feedback when ready.**

---

# SOURCE BRIEF A — DECISION QUALITY

The following brief is authoritative for Phase 1.

# Fantasy Analyst — Draft & Weekly Decision Quality Pass

## Mission

Add a focused set of high-value decision-support improvements to Fantasy Analyst without introducing any new external APIs.

This pass should strengthen:

1. Draft decisions
2. Start/Sit decisions
3. Weekly awareness

Use the data and infrastructure the project already has or is already integrating:

- Sleeper
- evidence/tallies
- Vegas player props
- Vegas game lines
- injury/status
- recent opportunity/usage
- weather
- kickoff times
- live draft state

Do not add paid AI.

Do not add new APIs for this pass.

Do not auto-draft.

Do not auto-set lineups.

All behavior must remain deterministic and explainable.

---

# Features in this pass

Implement all of the following as one coherent decision-quality upgrade:

## Draft
1. Tier-cliff warnings
2. Roster construction alerts
3. User-controlled “My Guy” flags with strength levels
4. Automatic “Avoid” tags for strongly negative lifetime tally players
5. “Can Probably Wait” guidance

## Start/Sit / Weekly
6. Late-swap safety
7. Market movement alerts
8. Smart role-change detection
9. Locked-game awareness

These should integrate with the existing recommendation engines rather than becoming disconnected widgets.

---

# 1. Tier-cliff warnings

## Goal

Help the user understand when the remaining talent at a position is about to drop materially.

The app should not merely rank Player A above Player B.

It should sometimes say:

**TE tier cliff approaching**

or:

**Last RB in this tier**

or:

**WR depth remains strong — you can probably wait**

## Inputs

Use existing data such as:

- Sleeper ADP
- available player pool
- positional rankings
- gaps in ADP/rank between adjacent players
- current user roster need
- number of picks until user's next pick
- survival probability

## Behavior

Detect meaningful positional breaks.

Do not flag every tiny ADP gap as a tier cliff.

Use centralized tunable thresholds.

A cliff matters more when:

- the user still needs that position;
- the candidate is near the end of the current tier;
- the next tier is materially worse;
- several picks will occur before the user selects again.

## Examples

**TE tier cliff**
You do not have a TE yet. This is the final TE in the current tier, and the next group begins ~18 picks later.

**RB tier cliff**
Two similar RBs remain before a large drop.

**No urgency**
WR depth remains strong through your next projected pick.

## Recommendation integration

Tier-cliff information should meaningfully affect the draft recommendation component, but not blindly override massive player-value differences.

---

# 2. Roster construction alerts

## Goal

Make the draft engine actively understand the shape of the user's live roster.

Use the same live draft roster already reconstructed from Sleeper picks.

## Useful alerts

Examples:

- `Still need a starting TE`
- `Only 1 RB through 7 rounds`
- `5 WRs already — RB depth is becoming more important`
- `Starting lineup is covered`
- `Bench is WR-heavy`
- `No QB yet in a Superflex league`
- `You have enough early WR depth to wait`

## Round awareness

Urgency changes by round.

Early draft:
- avoid forcing positions.

Middle draft:
- missing starters become more relevant.

Late draft:
- unresolved starting positions should become increasingly urgent.

## Explainability

Show why roster construction affected the recommendation.

Example:

**Boosted by roster need**
You have drafted 5 WRs but only 1 RB.

Do not use generic labels without context.

---

# 3. “My Guy” user flags

## Goal

Let the user manually identify players they personally want to prioritize beyond the automated tally system.

This is separate from the evidence/news tally.

Add a simple star control on player views/lists.

## Strength levels

Use three strengths:

### ★ My Guy
Small ranking boost.

### ★★ Strong My Guy
Moderate ranking boost.

### ★★★ Must-Have
Strong but still bounded ranking boost.

The user should be able to tap/cycle or select the level easily on iPhone.

## Persistence

Persist the user's My Guy designation.

It should survive:

- refresh;
- draft polling;
- reopening the site;
- page navigation.

## Draft ranking effect

A My Guy should move upward by a meaningful but bounded amount.

Suggested intent:

### ★
Can break very close ties.

### ★★
Can move a player several spots when market values are fairly close.

### ★★★
Can justify a modest reach.

But even ★★★ should NOT blindly override:

- an enormous ADP gap;
- an unavailable player;
- severe roster imbalance;
- extreme positional scarcity elsewhere.

## UI

Show the star clearly beside the player's name.

Examples:

`★★ Jaxon Smith-Njigba`

or a compact star control.

Do not confuse My Guy with positive tally.

A player may have:

Lifetime tally +8  
My Guy ★★

These are separate signals.

## Recommendation explanation

Example:

**Personal preference boost**
You marked this player ★★ Strong My Guy.

---

# 4. Automatic Avoid tag

## Goal

Make heavily negative accumulated research impossible to overlook during the draft.

## Rule

If a player's **lifetime net tally is -5 or lower**, automatically show:

**AVOID**

This threshold should be centralized/configurable.

Do not require the user to manually flag it.

## Ranking impact

The player should receive an additional visible draft caution/penalty.

However, avoid should remain advisory rather than an absolute ban.

If extreme value or circumstances make the player worth consideration, the app can still rank them, but must make the conflict obvious.

Example:

**AVOID — lifetime tally -6**

Counterpoint:
Player has fallen 28 picks past Sleeper ADP.

## Recent reversal

If a historically bad player has strongly positive recent evidence, keep the AVOID tag based on the lifetime threshold but show:

`Recent trend improving`

Do not erase historical evidence.

---

# 5. “Can Probably Wait” guidance

## Goal

Help the user know not only who is good, but who can likely be postponed until the next pick.

This should combine:

- current pick;
- next user pick;
- Sleeper ADP;
- survival estimate;
- positional depth;
- tier cliff;
- roster need.

## Output states

Useful labels:

**Take Now**
Low survival / tier cliff / strong need.

**Can Probably Wait**
Good probability of surviving and no urgent tier cliff.

**Likely Available Later**
High survival estimate.

**Risky to Wait**
Borderline survival or position thinning.

## Example

Player A:
Recommendation rank #3
Survival to next pick: 78%

Show:

**Can Probably Wait**

Player B:
Recommendation rank #5
Survival: 18%
last RB in tier

Show:

**Risky to Wait**

The engine may recommend Player B now even if Player A's raw ranking is slightly higher.

## Explainability

State why.

Example:

**Can probably wait**
Estimated 76% chance to reach your next pick, and WR depth remains strong.

---

# 6. Late-swap safety

## Goal

Late kickoff uncertainty should be an explicit Start/Sit consideration.

Especially important when:

- player is Questionable;
- player is Doubtful;
- player has uncertain props;
- player plays SNF/MNF;
- viable alternatives play earlier.

## Inputs

Use existing:

- Sleeper status;
- kickoff times;
- current lineup;
- bench eligibility;
- Vegas baseline;
- confidence;
- prop availability;
- injury/news evidence.

## Behavior

For a questionable later player, identify earlier alternatives that will lock first.

Compare:

- expected advantage of late player;
- confidence in availability;
- quality of earlier alternative.

## Example

**Late-swap risk**

Your preferred WR plays Sunday night and is Questionable.

Healthy 1 PM alternative trails by only ~0.7 expected points.

Recommendation:

**Consider starting the healthy early option unless status improves before 1 PM.**

## Strong-player exception

If the later player is dramatically better, say:

**Worth waiting**
The projected advantage is large enough to justify the availability risk.

## Doubtful

Treat Doubtful much more aggressively than Questionable.

## Lineup optimizer

Late-swap risk must influence whole-roster recommendations, not just pairwise comparison.

---

# 7. Market movement alerts

## Goal

Make significant Vegas changes visible without forcing the user to inspect individual prop history manually.

Use the line snapshots already being stored.

## Alerts

Examples:

**Market rising**
Receiving yards: 52.5 → 59.5

**Market falling**
Rushing yards: 76.5 → 65.5

**Multiple markets rising**
Receptions ↑
Receiving yards ↑
TD probability ↑

**Game environment falling**
Game total: 49.5 → 44.0

## Significance thresholds

Do not alert on trivial movement.

Normalize by market type.

Examples:

A 1-yard passing change = meaningless.

A 7-yard receiving change may be important.

A 1.0 reception shift is very important.

A 4–5 point game-total movement is meaningful.

Keep thresholds centralized/configurable.

## UI

Use compact alerts:

`↑ Market rising`

`↓ Market falling`

Tap/expand for actual numbers.

Do not make the app look like a sportsbook.

---

# 8. Smart role-change detector

## Goal

Detect meaningful changes in player opportunity, especially targets/carries, while avoiding false alarms from one unusual game.

## Core principle

Role change should require evidence across multiple recent games.

Do NOT flag:

`Targets up!`

because one game had 14 targets after the player averaged 5.

## Baseline comparison

Compare:

- last 3 games
vs.
- season baseline / previous rolling baseline.

Where enough data exists, optionally compare:

- latest 3
vs.
- preceding 3–5 games.

## WR / TE

Primary signals:

- targets;
- receptions;
- routes/snaps if reliably available;
- red-zone targets if available.

Targets should be the most important easily available role metric.

## RB

Primary:

- carries;
- targets;
- receptions;
- red-zone usage;
- snap share if available.

## QB

Primary:

- pass attempts;
- rush attempts;
- designed rushing/red-zone usage if available.

## Confidence states

Return:

**Role Rising — High confidence**

**Role Rising — Moderate confidence**

**Stable**

**Role Falling — Moderate confidence**

**Role Falling — High confidence**

**Insufficient data**

## Confidence logic

High confidence should generally require:

- sustained multi-game movement;
- meaningful magnitude;
- enough sample;
- ideally agreement across related opportunity metrics.

Example:

Targets:
Season 6.2/game
Last 3: 9.7/game

Routes:
Season 73%
Last 3: 88%

This is stronger than targets alone.

## One-game spike protection

If:

Season targets: 6.0  
Last 3: 7.0  
Last game: 14

Do NOT call this a strong upward role change.

Say:

`One-game spike; broader role stable`

## Start/Sit integration

Role trend should meaningfully affect close decisions.

Example:

Vegas nearly equal, but Player A's target share has risen for three straight games.

Give Player A a modest boost.

## Trade integration

Reuse the same role-change signal for Trade Intelligence.

Positive recent tally + rising role
→ stronger Trade Target.

Negative recent tally + falling role
→ stronger Trade Away.

---

# 9. Locked-game awareness

## Goal

Once a player's NFL game has started, Fantasy Analyst must stop recommending impossible lineup changes involving that player.

## Behavior

Use kickoff/game state.

If a player is locked:

- clearly show `LOCKED`;
- preserve their current lineup position;
- exclude them from future swap options;
- do not recommend benching them;
- do not recommend moving another player into their occupied slot;
- recalculate recommendations using only remaining unlocked players.

## Started bench player

If a bench player's game has already started:

- they are no longer a valid swap option;
- exclude them from recommendations.

## Late-swap recalculation

Example:

1 PM games start.

Fantasy Analyst should automatically recalculate:

- remaining FLEX options;
- SNF/MNF decisions;
- remaining injury uncertainty.

## UI

Compact lock indicator:

`🔒 Locked`

or equivalent.

Do not create intrusive alerts for every lock.

## Tests

Verify multiple staggered kickoff windows.

---

# Cross-feature behavior

These features should work together.

## Draft example

Available players:

Player A
- Sleeper ADP 54
- Lifetime +7
- My Guy ★★
- 72% survival
- deep WR tier

Player B
- Sleeper ADP 59
- Lifetime +3
- last RB in tier
- 20% survival
- user only has 1 RB

Fantasy Analyst may recommend:

**Take Player B**

Reasons:
- RB tier cliff
- roster need
- risky to wait

And show:

Player A — **Can Probably Wait**

This is much more useful than simply ranking A > B.

---

# Start/Sit example

Player A:
- Vegas baseline 11.3
- receiving line ↑ 6 yards
- targets rising over last 3
- Healthy
- 1 PM

Player B:
- Vegas baseline 11.8
- Questionable
- SNF
- role stable

Fantasy Analyst may say:

**Lean Player A**

because:

- the projection gap is small;
- Player A's market and role are rising;
- Player B creates late-swap risk.

---

# Avoid conflicting labels

Do not overwhelm player rows with 6 badges.

Create priority.

Examples:

Draft row might show:

`★★ My Guy`
`AVOID`
`Tier cliff`
`Can wait`

But only show the most decision-relevant 1–2 inline.

Additional details can appear when expanded.

---

# Central configuration

Put thresholds/weights in central configuration.

At minimum:

- Avoid lifetime threshold (-5 default);
- My Guy ★ boost;
- My Guy ★★ boost;
- My Guy ★★★ boost;
- tier-cliff threshold;
- wait/survival thresholds;
- market movement significance;
- role-change minimum sample;
- role-change magnitude;
- late-swap risk threshold.

Do not scatter constants across UI components.

---

# No new API requirement

This entire pass should use existing/planned project data.

Do not add a new external service merely for these features.

If a signal is unavailable from current data:

show `unknown` or `insufficient data`.

Do not create a new paid/free integration just to complete this MD.

---

# iPhone UX

Primary target remains iPhone Safari.

These additions should improve decisions without making screens more cluttered.

Prioritize:

- compact tags;
- short explanations;
- expandable reasoning;
- obvious stars;
- obvious AVOID warning;
- minimal alert clutter.

Do not turn Draft or Start/Sit into dashboards.

---

# Testing

Retain all current tests.

Add coverage for:

## Tier cliffs
- meaningful gap alerts;
- trivial gaps ignored;
- roster need increases relevance;
- deep position says wait.

## Roster alerts
- position imbalance;
- missing starter;
- late-round urgency;
- filled lineup.

## My Guy
- ★ persistence;
- ★★ persistence;
- ★★★ persistence;
- ranking boosts by level;
- bounded against huge ADP difference.

## Avoid
- lifetime -5 triggers;
- -4 does not;
- recent improvement does not erase lifetime tag;
- ranking penalty;
- extreme value remains possible with warning.

## Can Probably Wait
- high survival;
- low survival;
- tier cliff;
- roster need;
- next-pick logic.

## Late swap
- Questionable SNF vs healthy 1 PM;
- Doubtful;
- large projection gap worth waiting;
- small gap favors safety.

## Market movement
- receiving line rise;
- rushing fall;
- insignificant movement ignored;
- multiple-market agreement;
- game-total movement.

## Role change
- sustained target rise;
- sustained carries fall;
- one-game spike ignored;
- insufficient sample;
- multiple metrics increase confidence.

## Locked players
- starter locks;
- bench player locks;
- locked player removed from swaps;
- remaining lineup recalculates.

## Browser
At:
- 390x844
- 375x812
- 360x800

Verify Draft and Start/Sit remain readable.

---

# Autonomous workflow

Work autonomously.

Inspect the existing engines first and reuse their components.

Do not ask the user implementation questions unless genuinely necessary.

Use a feature branch.

Implement.

Test.

Fix failures.

Commit.

Push.

Open/update PR.

Do not merge unless authority has already explicitly been granted for this pass.

---

# Completion report

At completion answer:

1. Are tier-cliff warnings working?
2. What triggers roster construction alerts?
3. How do ★ / ★★ / ★★★ My Guy levels affect rankings?
4. Is `AVOID` automatically applied at lifetime tally <= -5?
5. How is Can Probably Wait determined?
6. How does late-swap safety influence lineup recommendations?
7. Which market movements generate alerts?
8. How does the role-change detector avoid one-game false signals?
9. Are locked players automatically removed from impossible swap suggestions?
10. Do these signals combine correctly in Draft and Start/Sit?
11. Did you add any new external API? Expected answer: no.
12. Are all tests green?
13. Is the PR ready?
14. Is any manual action required?

If manual action is required, give only the single next action.


---

# SOURCE BRIEF B — VISUAL OVERHAUL

The following brief is authoritative for Phase 2.

# Fantasy Analyst — Visual Overhaul Pass (Visual Only)

## Mission

Give Fantasy Analyst a focused visual overhaul for iPhone Safari.

This is a **visual/UI presentation pass only**.

Do NOT change:

- application architecture;
- data models;
- APIs;
- recommendation logic;
- draft logic;
- start/sit logic;
- trade logic;
- Sleeper sync behavior;
- newsletter parsing;
- evidence/tally calculations;
- Vegas/weather/usage calculations;
- player matching behavior;
- navigation destinations;
- feature structure;
- functional flows.

Do not add new product functionality.

Do not remove existing functionality except where this brief explicitly asks to remove visual chrome.

The goal is to make the existing app feel cleaner, denser, easier to scan, and much better optimized for iPhone.

Work autonomously.

---

# Primary visual goals

1. Fit meaningfully more players on screen.
2. Make player positions instantly scannable.
3. Remove unnecessary draft-page chrome.
4. Simplify league identification.
5. Make the bottom navigation sit properly against the bottom safe area.
6. Improve visual hierarchy without redesigning the structure of the product.
7. Preserve all existing interactions and functions.

Primary device:

**iPhone Safari portrait**

Test especially around:

- 390px width;
- 375px width;
- 360px width.

Use the real mobile viewport and safe-area behavior.

---

# 1. Position color coding — highest priority

When looking at a long list of players, it should be immediately obvious who is:

- QB
- RB
- WR
- TE

Use a clear, consistent position-color system throughout the app.

Apply the same mapping anywhere a player position appears, including where relevant:

- Draft player list;
- Team page;
- Start/Sit;
- Trades;
- Players;
- recommendation cards/rows;
- search results;
- review-related player references when appropriate.

## Design direction

Use restrained position badges or compact color accents.

Do NOT turn every player card into a giant colored block.

Preferred treatment:

- small position pill/badge;
- strong enough color distinction to scan instantly;
- position text remains readable;
- colors should work on light backgrounds;
- accessible contrast;
- do not rely on color alone — keep the letters `QB`, `RB`, `WR`, `TE`.

Example concept:

`QB` — one consistent accent color  
`RB` — another  
`WR` — another  
`TE` — another

Choose tasteful colors that fit the existing app.

Avoid:

- neon;
- rainbow clutter;
- harsh saturated backgrounds;
- making the app feel like a sportsbook.

Position colors should help scanning, not dominate the screen.

---

# 2. Draft page — remove the top pick-status banner

Remove the visual banner/header block that currently shows things like:

- current pick number;
- “until you”;
- pick-status summary;
- other large draft-status chrome.

The user does NOT want that large banner taking vertical space.

The goal is to get players higher on screen and fit more of them at once.

## Important

This is a visual removal only.

Do NOT break or remove the underlying draft-state data.

Do NOT change draft calculations.

If those values are needed internally, keep them.

If a very small inline status indicator is already necessary for orientation, keep it extremely compact, but do not recreate the same large banner in another form.

The player list should begin much closer to the top.

---

# 3. League info — reduce to league name only

Where the draft page currently shows league details/settings metadata, simplify the visible treatment to:

**League name only**

Remove visible extra league metadata from the main draft header area such as:

- scoring-format text;
- roster-setting summary;
- league configuration details;
- redundant season text;
- draft descriptors;

unless one of those is absolutely required for an existing interaction.

The main visible identity should simply be the league name.

Example:

**Tony's Pizza Fantasy**

not:

**Tony's Pizza Fantasy · 10 Team · Half PPR · 1QB · 2026**

The underlying settings still exist and still drive recommendations.

This is a presentation simplification only.

---

# 4. Fit significantly more players on the Draft screen

This is the main outcome of removing the draft banner and shortening league info.

Rework spacing, density, and hierarchy so the user can see substantially more available players without scrolling.

## Player row/card density

Reduce unnecessary:

- vertical padding;
- card height;
- margins;
- repeated labels;
- whitespace between player rows;
- oversized headings;
- decorative spacing.

Keep rows comfortably tappable.

Do NOT make text cramped or tiny.

The goal is:

**dense but polished**

not:

**compressed spreadsheet**

## Prioritize visible information

On the primary player-list surface, favor:

- player name;
- position;
- team;
- Sleeper ADP / rank;
- tally signal;
- key recommendation/value indicator.

Move lower-priority explanatory detail behind the existing tap/expand interaction if already supported.

Do NOT remove information from the product entirely just to make rows shorter.

---

# 5. Draft page visual hierarchy

Desired order near the top:

1. League name
2. Any existing essential compact controls/search/filter
3. Player list

Avoid:

- oversized hero/header region;
- dashboard summary cards;
- pick-status banner;
- large league-info block;
- decorative empty space.

The player list should visually dominate the page.

---

# 6. Bottom toolbar — make it flush with the bottom

The current bottom toolbar/navigation does not feel flush enough with the bottom of the site/screen.

Fix the visual placement.

It should:

- sit naturally against the bottom edge/safe area;
- respect iPhone home-indicator safe area;
- not float awkwardly above the bottom;
- not leave unexplained blank space beneath it;
- not overlap content;
- remain visually stable in Safari;
- feel intentional on iPhone.

Use proper CSS safe-area handling, e.g. where appropriate:

`env(safe-area-inset-bottom)`

Do not hardcode one device-specific pixel offset.

## Important

Do not change navigation behavior.

Do not change tabs/routes.

This is spacing/layout only.

---

# 7. Reduce unnecessary whitespace throughout

Audit all main screens for excess vertical space.

Especially:

- top page padding;
- heading margins;
- card gaps;
- section gaps;
- bottom-nav spacing;
- empty spacer blocks.

The user wants to spend screen real estate on:

- players;
- recommendations;
- roster;
- useful information;

not blank whitespace.

Do not globally shrink everything indiscriminately.

Preserve readability.

---

# 8. Typography

Keep typography clear and compact.

Priorities:

- player names highly readable;
- secondary metadata smaller;
- recommendation labels distinct;
- tally values easy to scan;
- position badges obvious.

Avoid:

- oversized titles;
- excessive bold everywhere;
- tiny gray text;
- unnecessary all-caps;
- long label strings.

League name can be prominent but compact.

---

# 9. Card / row styling

Where possible, visually simplify repeated player cards.

Consider:

- subtle separators;
- compact rounded rows;
- reduced shadows;
- fewer nested containers;
- less border-on-border styling.

Do not redesign interactions.

Do not remove tap targets.

The player list should feel fast and scannable.

---

# 10. Keep functions exactly intact

This pass must not alter functional behavior.

Explicitly preserve:

- search;
- filters;
- sort;
- player detail taps;
- draft live updates;
- roster updates;
- recommendations;
- start/sit comparisons;
- trade screens;
- review queue;
- settings;
- Help My Scores;
- newsletter status;
- Vegas status;
- all APIs and backend behavior.

If a visual change risks breaking function, preserve function.

---

# 11. Position badge consistency

Create a central visual mapping rather than scattering CSS values.

Example conceptual design token:

- QB
- RB
- WR
- TE
- K/DST if present
- FLEX/SUPERFLEX should not be treated as a player position badge unless already used that way

Use one central component/style source.

Do not implement different position colors on different screens.

---

# 12. Accessibility

Maintain:

- adequate contrast;
- readable text;
- touch targets;
- position letters in addition to colors;
- visible selected states;
- clear focus states where relevant.

Do not sacrifice accessibility for density.

---

# 13. iPhone Safari verification

Test visually at:

- 390 × 844
- 375 × 812
- 360 × 800

Check:

## Draft
- league name fits cleanly;
- no pick-status banner;
- player list starts high on screen;
- more players visible;
- position colors obvious;
- no accidental clipping;
- filters/search still usable.

## Bottom navigation
- flush to bottom;
- correct safe area;
- no blank strip beneath;
- no overlap with content;
- stable during scroll.

## Player rows
- still tappable;
- no truncated critical names;
- badges aligned;
- values readable.

---

# 14. Do not expand scope

Do NOT use this pass to:

- change recommendation weights;
- change tally logic;
- modify draft strategy;
- add data sources;
- change player identity matching;
- add features;
- reorganize navigation;
- redesign backend;
- change route structure;
- rewrite components purely for architecture cleanup;
- add animations unless needed for existing states.

This is a **visual refinement only**.

---

# 15. Autonomous implementation

Work autonomously.

Inspect the current live visual state before changing CSS/components.

Make the smallest coherent set of changes that accomplishes this brief.

Use a feature branch.

Run:

- typecheck;
- existing automated tests;
- browser tests;
- production build;
- relevant visual/iPhone smoke checks.

Fix any regressions.

Commit and push.

Open/update a PR.

Do not merge without explicit approval unless merge authority has already been clearly delegated for this pass.

Do not ask the user technical questions unless absolutely necessary.

---

# Completion report

At the end, report in plain English:

1. Did you preserve all functionality?
2. Which screens received position color coding?
3. What position-color mapping did you choose?
4. Is the Draft pick-status banner gone?
5. Is the Draft league header reduced to league name only?
6. Roughly how many more player rows fit in the first iPhone viewport compared with before?
7. Is the bottom toolbar now properly flush with the safe area?
8. Did you change any functional logic? The expected answer should be no.
9. Are all tests green?
10. Is the PR ready?
11. Is there any manual action required?

Include before/after screenshots or equivalent visual evidence if the environment supports it.

Start now.


---

# Final instruction

Queue this package.

Do not interrupt the work already in progress.

When the current work is finished and safely integrated, execute Phase 1 and then Phase 2 autonomously in the order defined above.

Do not ask the user for routine confirmation between phases.

Only interrupt for a genuinely user-only blocker.

Otherwise finish the entire program, integrate it cleanly, verify it, and then report the finished result.
