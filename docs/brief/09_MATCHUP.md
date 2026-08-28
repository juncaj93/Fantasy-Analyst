# Fantasy Analyst — Autonomous Matchup Experience
## Post-draft live matchup intelligence, not a Sleeper clone

## Mission

Build a **post-draft Matchup tab** that becomes one of Fantasy Analyst’s most useful in-season surfaces.

This must **not** be a prettier clone of Sleeper’s matchup screen.

Sleeper is the source of truth for:
- league matchup membership;
- rosters;
- starter slots;
- actual fantasy scoring;
- game/player status;
- completed points.

Fantasy Analyst should add value by turning that raw matchup into:

- a much more compact head-to-head view;
- Fantasy Analyst-native projected final scores;
- Fantasy Analyst-native live win probability;
- a rotating hero insight card that explains **what matters right now**;
- concise “what you need / what they need” intelligence;
- starter-by-starter live context;
- expandable benches;
- lineup-impact intelligence;
- injury/game-state alerts;
- decision leverage.

The design north star is:

> **Scoreboard + decision engine + live situational awareness.**

The default screen should answer:

1. Who is winning?
2. What does Fantasy Analyst think the final score will be?
3. What are the current win odds?
4. What is the biggest remaining swing?
5. What does each side need?
6. Which players are still live / matter most?
7. Is there anything I need to act on?

Do not flood the screen with raw stats.

---

# Reference concept

Use the included reference image only as the **visual/product concept direction**, not as a literal pixel-perfect specification.

The approved conceptual hierarchy is:

1. compact matchup score hero;
2. one prominent rotating live insight hero card;
3. very compact starters-vs-starters list;
4. collapsed expandable bench;
5. native bottom navigation with Matchup selected.

Do not reintroduce the earlier over-designed concepts with:
- large positional-edge tables;
- multiple stat panels;
- permanent “what you need / what they need” boxes;
- rows of swing-player cards;
- dense analytics dashboards.

The user explicitly rejected that level of visible statistical clutter.

---

# PARALLEL-SAFE / INTEGRATION RULES

This work may land after or alongside other major Fantasy Analyst workstreams.

Before implementation:
1. fetch latest `main`;
2. inspect all merged work;
3. reuse existing:
   - Start/Sit engine;
   - xFP / FPOE;
   - injury beneficiary logic;
   - contingency logic;
   - Floor/Balanced/Ceiling mode selection;
   - team logos;
   - player identity;
   - live score / matchup data;
   - model integrity diagnostics;
   - What Changed feed if already present;
4. do not reimplement those systems;
5. adapt to the latest post-draft navigation.

Before final merge:
- integrate latest `main` again;
- preserve newer Team/Waivers/Trades/Players work;
- run exact-head verification.

---

# POST-DRAFT NAVIGATION

Once the selected Sleeper league’s draft is complete, Matchup should become a primary in-season destination.

The final post-draft nav should be reconciled with the latest app state, but the intended order is approximately:

- Team
- Matchup
- Waivers
- Trades
- Players
- Review
- Setup

If bottom-nav width requires a smaller primary set, preserve access to all surfaces through the current navigation architecture rather than forcing seven unreadable icons.

Do not hardcode dates.

Use actual Sleeper league/draft/season state.

---

# 1. MATCHUP PAGE HEADER

Keep the top compact.

Show:
- `Week X Matchup`
- subtle live/scheduled/final status
- no redundant giant page chrome

If refresh is already handled by pull-to-refresh or existing background refresh, do not add redundant refresh controls.

---

# 2. PRIMARY SCORE CARD

Create one concise head-to-head score card.

For both teams show:

- fantasy team name;
- small team avatar/logo if available;
- current score;
- Fantasy Analyst projected final score;
- Fantasy Analyst live win probability.

Example conceptual layout:

```text
Ceedeez Nuts                       Juncer's Hog Format
107.0                                      124.2
125.9 proj                              130.7 proj

18% WIN  ━━━━━━━●━━━━━━━━━━━━━━━━ 82% WIN
```

Use Sleeper actual score as authoritative.

Projection and win probability should be clearly Fantasy Analyst outputs.

Do not present Sleeper’s projection as if it is Fantasy Analyst’s.

---

# 3. FANTASY ANALYST PROJECTED FINAL SCORE

Do not simply copy Sleeper projections.

Build the matchup projection from Fantasy Analyst’s existing player-level Start/Sit / projection intelligence.

For each starter, reuse existing signals where already implemented and appropriately calibrated:

- base projection;
- league scoring;
- xFP / opportunity;
- role trend;
- injury status / practice;
- player props;
- game total / spread;
- weather;
- matchup;
- role-specific opponent strength;
- recent usage;
- injury-beneficiary effect;
- lineup mode where relevant;
- uncertainty / confidence.

Do not double-count correlated signals.

Channel/model-integrity safeguards remain authoritative.

---

# 4. PLAYER OUTCOME DISTRIBUTIONS

Win probability should not be calculated from two single deterministic projected totals.

Each relevant remaining starter should have a reasonable outcome distribution.

At minimum model:
- floor;
- median;
- ceiling;
- volatility / uncertainty.

Where possible use position- and role-aware volatility.

Examples:
- rushing QB;
- deep-threat WR;
- receiving RB;
- high-volume possession WR;
- goal-line RB;
- TE.

Do not create false precision where data is weak.

---

# 5. LIVE WIN PROBABILITY

Calculate Fantasy Analyst live win odds using simulation over **remaining uncertain outcomes**.

Conceptually:

```text
actual locked points
+
simulated remaining player outcomes
=
final team total
```

Run enough simulations for stable results.

Use deterministic seeding per matchup state where practical so unchanged state does not jitter.

The win probability should update when:
- player scores;
- game state changes;
- injury status changes;
- role changes;
- props/inactives materially change;
- a player’s game completes.

Do not rerun expensive work on irrelevant UI renders.

---

# 6. LIVE GAME-STATE UNCERTAINTY

Treat players differently based on game state:

### Not started
Use full pregame distribution.

### Live
Condition remaining projection/variance on:
- points already scored;
- time remaining;
- game state;
- role/usage observed so far where available.

### Finished
Actual points are locked truth.
Zero remaining variance.

Do not continue simulating completed players.

---

# 7. CORRELATION

Do not assume all player outcomes are independent.

At minimum consider bounded correlation for:

- QB + WR/TE same team;
- QB vs opposing pass catchers in same game;
- RB with strongly positive game script;
- competing teammates for usage.

Keep this conservative.

Do not build an overcomplicated correlation engine if existing free data does not support it.

Calibration matters more than complexity.

---

# 8. INJURY MIXTURE OUTCOMES

For unresolved questionable players, support mixture-style uncertainty where current intelligence supports it:

- active / normal;
- active / limited;
- inactive.

Do not reduce a questionable player to one flat projection if uncertainty is material.

Once inactives are official, collapse the branch.

---

# 9. CALIBRATION

Persist enough historical information so Matchup win probability can eventually be calibrated.

For example:

- predictions in 50–60% bucket;
- observed win rate;
- sample count.

The long-term goal:

> When Fantasy Analyst says 70%, that outcome should occur roughly 70% of the time over a sufficiently large sample.

Do not overclaim calibration on small samples.

---

# 10. HERO INSIGHT CAROUSEL

Directly beneath the score card, show **one prominent live insight card at a time**.

This is the core differentiator.

The card should cycle or allow subtle swiping between only the most important current matchup insights.

Examples:

### Need / target
`Need 18.4 more from J. Hurts to reach 72% win odds`

### Opponent need
`Opponent needs 11.2 more from J. Jefferson to flip the projection`

### Injury
`C. Olave questionable to return — your win odds moved +9%`

### Unexpected performance
`Swift is +8.1 above projection — biggest positive swing`

### Negative swing
`Burrow is 9.4 below projection — matchup moved toward you`

### Lineup leverage
`Starting Hurts instead of Burrow adds ~4 pts to win odds`

### Game ending
`You clinch if Jefferson stays under 13.6`

### Late-game leverage
`One remaining player decides 41% of remaining outcome variance`

The hero card should feel alive and useful.

---

# 11. HERO CARD PRIORITY ENGINE

Do not rotate random facts.

Rank candidate insight events by:

1. decision/action urgency;
2. impact on win probability;
3. injury/game-state severity;
4. change since last meaningful state;
5. closeness to outcome threshold;
6. user relevance.

Only surface material events.

Avoid:
- tiny projection changes;
- harmless refreshes;
- duplicated injury messages;
- cosmetic stat milestones.

---

# 12. HERO CARD STATE

A hero message should be generated from current truth, not stale copy.

Track:
- source timestamp;
- matchup state fingerprint;
- when message became relevant;
- whether it was superseded.

If nothing material is happening, show a calm neutral card such as:

`You remain a slight favorite · 61% win odds`

Do not fabricate drama.

---

# 13. HERO CARD INTERACTION

Hero card may:
- auto-cycle slowly when multiple high-value insights exist;
- support swipe left/right;
- show 2–3 tiny page dots;
- allow tap for details.

Do not auto-cycle so fast that the user cannot read it.

If only one material insight exists:
- show one card;
- no fake carousel.

---

# 14. “WHAT YOU NEED / WHAT THEY NEED” LOGIC

Do not permanently show large boxes.

Generate this intelligence behind the hero carousel.

The engine should be able to answer:

- what stat threshold materially changes win odds;
- what player outcome matters most;
- what opponent outcome is dangerous;
- what event would effectively clinch/flip the matchup.

Examples:

`You need Hurts ≥ 24.5`
`They need Jefferson ≥ 18.2`
`If Kittle stays under 10, you become ~80% favorite`

Do not create false single-variable certainty if multiple players remain highly dependent.

Use phrases like:
- `roughly`
- `about`
- `most likely path`

when appropriate.

---

# 15. BIGGEST SWING

Compute the biggest remaining swing player/event.

This should reflect **impact on matchup win probability**, not just raw projected points.

Examples:
- high-variance Hurts can matter more than a slightly higher-projected low-variance RB;
- a player can have a modest projection but huge leverage if the matchup is close.

Keep this primarily inside the hero insight system.

---

# 16. STARTERS SECTION

Below the hero card show a highly compact starter-vs-starter list.

The target is to fit nearly the entire starting matchup on one iPhone screen or as close as practical.

Each row:

```text
[team logo] J. Allen   6.9       QB       27.7   D. Maye [logo]
                  25.6 proj       21.8 proj
```

Use a stable center position pill.

Positions:
- QB
- RB
- WR
- TE
- FLEX
- Superflex/etc. if league settings require

Use actual Sleeper lineup slots.

---

# 17. PLAYER ROW CONTENT

Collapsed row should show only:

- first initial + last name;
- team logo;
- live/current fantasy points;
- projected final fantasy points or remaining projection;
- injury/live status if material;
- position.

Do NOT show by default:

- full box score;
- targets;
- carries;
- ADP;
- xFP;
- props;
- detailed weather;
- long injury text;
- evidence ledger.

Tap opens the existing/shared player intelligence sheet if available.

---

# 18. PLAYER NAME FORMAT

Use:
- first initial;
- last name.

Examples:
- `J. Hurts`
- `J. Jefferson`
- `A. St. Brown`

If ambiguous, use minimal deterministic disambiguation.

---

# 19. TEAM LOGOS

Reuse the existing team-logo primitive.

Do not show text team abbreviations unless:
- logo fails;
- accessibility requires text offscreen;
- space/layout explicitly needs fallback.

---

# 20. LIVE STATUS CUES

Use subtle markers:

- green dot = live;
- gray = not started;
- finished = no dot / settled state;
- Q/OUT/etc. only when material.

Avoid excessive animated indicators.

---

# 21. EXPANDABLE BENCH

Default:
- bench collapsed.

Show one compact row:

`Bench (6)   ▾`

On tap:
- expand both teams’ bench players in the same concise left-vs-right style where possible;
- show first initial + last name;
- position;
- team logo;
- actual points;
- projected points/status.

The bench section is primarily for hindsight/context:

- who was left on bench;
- whether a lineup alternative existed;
- how lineup decisions performed.

Do not let bench content overwhelm the main matchup view.

---

# 22. BENCH DECISION CONTEXT

If a bench player materially outperforms a starter:

after games start or complete, the system may surface a hero insight such as:

`Bench swing: Player X outscored your starter by 11.4`

But do not shame the user or use hindsight as if it was predictable.

If the pregame model recommended the starter, say:

`Outcome swung against the pregame recommendation`

rather than implying the decision was obviously wrong.

This should feed the self-grading/counterfactual system.

---

# 23. START/SIT DECISION IMPACT

If the Team/Start-Sit engine has a close decision before lock, Matchup can quantify its effect.

Example:

`Start Hurts → 64% win`
`Start Burrow → 60% win`

This is a major differentiator.

Do not reduce Start/Sit to median points only.

In close cases, optimize based on actual matchup objective:
- maximize win probability.

---

# 24. FLOOR / BALANCED / CEILING INTEGRATION

Reuse the auto mode suggestion.

Matchup should inform that mode.

Examples:

- strong favorite -> Floor;
- close -> Balanced;
- meaningful underdog -> Ceiling.

User override remains authoritative.

Matchup may show a concise label:

`Balanced recommended`

Do not add a large control panel here unless current Team UX requires it.

---

# 25. DECISION OPTIMIZATION

Matchup should be able to answer:

> Which legal lineup gives me the highest probability of winning THIS matchup?

This can differ from:
> Which lineup has the highest median projection?

Use the Start/Sit engine and outcome distributions.

Respect:
- Sleeper slots;
- locks;
- eligibility;
- late swap;
- injury state.

Advisory only.

---

# 26. OPPONENT LINEUP EXPLOITATION

Use opponent lineup context only as a bounded strategic effect.

Examples:
- same-game correlations;
- opponent QB/WR stack;
- need for ceiling.

Do not make weak players better simply because of opponent correlation.

---

# 27. MATCHUP CHANGE LOG

Internally retain material changes:

- win probability movement;
- projected score movement;
- injury changes;
- completed player outcomes;
- lineup lock changes.

This may feed:
- hero carousel;
- What Changed feed;
- post-week grading.

Do not show raw event logs by default.

---

# 28. NOTIFICATIONS / HERO TRIGGERS

Potential high-value trigger examples:

- player ruled OUT;
- player questionable to return;
- major live projection swing;
- win probability crosses 20/50/80/95%;
- biggest swing player changes;
- opponent’s path narrows materially;
- user’s path narrows materially;
- matchup effectively clinched;
- late injury changes lineup option.

Do not trigger on every 1% movement.

---

# 29. CLINCH / NEAR-CLINCH STATES

When simulation says outcome is nearly certain:

Examples:

`You’re effectively safe · 97%`
`Opponent needs ~31 from final player`

Do not literally claim mathematically clinched unless it is impossible for opponent to catch up.

Distinguish:
- mathematical clinch;
- simulation near-clinch.

---

# 30. FINAL / POSTGAME STATE

Once all games are complete:

- show final score;
- remove live win probability;
- display `FINAL`;
- optionally show:
  - biggest positive swing;
  - biggest negative swing;
  - one concise `what decided it` hero card.

Example:

`What decided it`
`Olave beat projection by 18.6 and accounted for most of the winning margin`

Bench remains expandable.

This should feel like a clean postgame recap, not a stat dump.

---

# 31. PRE-GAME STATE

Before kickoff:

- current score = 0 or Sleeper truth;
- Fantasy Analyst projected final;
- win probability;
- recommended mode;
- hero card may show:
  - biggest lineup leverage;
  - injury uncertainty;
  - key matchup;
  - what each side needs relative to projection.

Do not manufacture “live” language before games begin.

---

# 32. SOURCE FRESHNESS

All derived matchup intelligence should track source freshness.

Win probability confidence should degrade when:
- major player status unresolved;
- Vegas stale;
- weather unavailable;
- key projection inputs missing.

Example subtle treatment:
`61% win · medium confidence`

Do not dominate UI with confidence unless materially weak.

---

# 33. FAILURE / DEGRADED MODE

If Fantasy Analyst projections cannot be computed:

- keep Sleeper actual scoreboard visible;
- show a clear but quiet degraded message;
- do not substitute Sleeper projection and label it Fantasy Analyst.

Example:
`Fantasy Analyst forecast temporarily unavailable`

The page must still work as a scoreboard.

---

# 34. PERFORMANCE

The screen must feel live.

Targets:
- tab open feels immediate;
- existing matchup data renders first;
- derived forecast fills without long blocking;
- player taps open instantly;
- no expensive full rebuild from harmless UI changes.

Cache by matchup-state fingerprint.

Only recompute dependent systems when meaningful state changes.

---

# 35. POLLING / REFRESH

Reuse existing refresh/background infrastructure wherever possible.

Do not create uncontrolled parallel polling.

Recommended behavior:
- scoreboard can refresh frequently while games are active;
- model recompute occurs only when relevant state changes;
- pause in background;
- resume immediately when app foregrounds;
- no refresh storm from focus/pageshow/visibility events.

---

# 36. UI VISUAL DIRECTION

Keep:

- dark/light mode support according to the app’s global design;
- clean rounded surfaces;
- strong typography hierarchy;
- compact spacing;
- subtle position colors;
- small logos;
- native iOS feel.

Do not blindly force the dark reference style if the rest of app is in light mode.

Match the current app’s theme.

---

# 37. NO SLEEPER CLONE

Explicitly avoid recreating Sleeper’s matchup UI.

Do NOT include by default:
- long raw stat lines under every player;
- huge player rows;
- detailed box-score strings;
- excessive metadata;
- every bench player expanded;
- static generic win odds with no explanation.

Fantasy Analyst’s advantage is:

- better projection;
- better win probability;
- much denser display;
- live explanatory insight;
- lineup decision leverage;
- injury/context intelligence.

---

# 38. ACCESSIBILITY

- Win probability cannot rely on color only.
- Live/final/injury states require text/semantic labels.
- Player/team logos need accessible names.
- Hero carousel should be controllable and screen-reader safe.
- Dynamic Type should not destroy the starter grid.
- Touch targets remain usable.

---

# 39. RESPONSIVE TARGETS

Required:

- 430 px
- 390 px
- 375 px
- 360 px

At all widths:

- starter rows remain readable;
- team names truncate intelligently;
- no accidental page horizontal overflow;
- hero card remains concise;
- bench control remains reachable;
- bottom nav stays usable.

---

# 40. TESTS — CORE MODEL

Add focused tests for:

- deterministic projected team total;
- scoring-setting propagation;
- completed players locked;
- live players partially uncertain;
- correlation bounded;
- questionable mixture state;
- simulation convergence;
- same seed/state stable;
- win probability changes in expected direction after scoring event;
- no double-counted player contribution.

---

# 41. TESTS — HERO ENGINE

Test:

- injury alert outranks minor projection movement;
- material win swing outranks trivial stat;
- duplicate source events dedupe;
- no stale insight survives superseding state;
- only one high-priority insight shows when one exists;
- calm neutral state when nothing important is happening;
- opponent-need thresholds update correctly.

---

# 42. TESTS — LINEUP DECISION IMPACT

Fixtures:

- close player A/B choice where A improves win probability;
- player with lower median but higher ceiling preferred when major underdog;
- favorite prefers lower-variance legal lineup;
- locked player cannot be changed;
- injured player mixture affects decision;
- illegal FLEX combination rejected.

---

# 43. TESTS — UI

At minimum:

- Matchup tab appears post-draft;
- screen loads actual Sleeper matchup;
- projected final shown;
- Fantasy Analyst win odds shown;
- hero card shown;
- starter rows concise;
- bench collapsed by default;
- bench expands;
- player tap opens shared detail sheet when available;
- final state replaces live state;
- degraded forecast does not break scoreboard.

---

# 44. MUTATION / REGRESSION TESTS

Deliberately prove tests fail when:

- Sleeper projection is substituted as Fantasy Analyst projection;
- completed player remains simulated;
- same QB/WR stack treated as fully independent if correlation logic exists;
- bench expanded by default;
- hero engine surfaces trivial event over injury;
- win probability jitters with unchanged seed/state;
- player row grows into raw box-score dump;
- actual Sleeper score is overwritten by projection.

Break -> red -> restore -> green.

---

# 45. PRODUCTION / HISTORICAL CALIBRATION LOGGING

Persist enough structured outputs for later self-grading:

- matchup ID;
- season;
- week;
- timestamp;
- model version;
- actual score at prediction time;
- projected final;
- win probability;
- source freshness;
- final outcome.

This enables future calibration without retroactively reconstructing impossible states.

Do not store excessive redundant simulation traces.

---

# 46. MODEL VERSIONING

Matchup forecasts must record the relevant model version.

This is necessary for:

- weekly self-grading;
- 2027+ comparisons;
- shadow models;
- calibration.

---

# 47. SEASON AGNOSTIC

Do not hardcode 2026.

The Matchup system must work in future seasons.

Keys should include:
- season;
- week;
- league/matchup identity.

Historical Week 16 from one season must never collide with another.

---

# 48. EXACT-HEAD FINAL GATE

Before merge, integrate latest `main` and run:

```bash
npm run typecheck
npx vitest run
npm run e2e:chromium
npm run build
npx wrangler deploy --dry-run
```

Use authoritative CI WebKit if local WebKit is unavailable.

Do not weaken tests.

---

# FINAL ACCEPTANCE EXPERIENCE

The intended in-season experience should be:

## Top
**Week 16 Matchup**

Compact score:
- actual score;
- Fantasy Analyst projected final;
- Fantasy Analyst win probability.

## Hero card
One live high-value insight such as:

**Need 18.4 more from J. Hurts to reach ~72% win odds**

or:

**C. Olave questionable to return — your win odds moved +9%**

or:

**Opponent needs ~11.2 from Jefferson to flip the projection**

## Starters
One compact head-to-head row per lineup slot.

No giant box-score text.

## Bench
Collapsed by default.
Expandable on demand.

## Live intelligence
Updates when meaningful state changes.

## Postgame
One concise “what decided it” recap.

This should feel like a live matchup assistant, not a scoreboard clone.

---

# FINAL REPORT

Return one comprehensive report:

1. branch / PR / merge / deploy;
2. Matchup navigation behavior;
3. actual score source;
4. player projection architecture;
5. team projection architecture;
6. outcome distribution design;
7. live win-probability design;
8. simulation count / convergence;
9. correlation handling;
10. injury mixture handling;
11. hero insight engine;
12. insight priority logic;
13. what-you-need logic;
14. opponent-need logic;
15. biggest-swing calculation;
16. starter-row design;
17. bench behavior;
18. player-sheet integration;
19. Floor/Balanced/Ceiling integration;
20. lineup win-probability decision impact;
21. live polling/recompute behavior;
22. final/postgame state;
23. degraded/fallback state;
24. calibration logging;
25. model versioning;
26. season-agnostic behavior;
27. mobile QA;
28. accessibility;
29. unit tests;
30. E2E tests;
31. mutation tests;
32. WebKit/CI;
33. production smoke;
34. remaining limitations;
35. anything user must do.

If no action is required, end with:

**No manual action is required. Fantasy Analyst now has a compact post-draft Matchup experience that uses Sleeper for actual league truth but layers its own player projections, simulation-based live win probability, concise starter-vs-starter presentation, expandable benches, and a rotating real-time insight hero that explains what each side needs and which remaining events matter most.**
