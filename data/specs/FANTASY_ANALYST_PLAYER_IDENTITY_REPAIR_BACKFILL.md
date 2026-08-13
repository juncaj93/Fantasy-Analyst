# Fantasy Analyst — Non-Interrupting Player Identity Repair & Tally Backfill Pass

## Mission

Fix missing player-name mappings that are causing existing tally evidence to fail to reach the correct canonical Sleeper player, and make the system robust for future incoming newsletters.

This pass should be **non-interrupting** for the user.

Claude should do everything it can autonomously:

- inspect the current evidence ledger;
- compare unresolved names/aliases against Sleeper canonical players;
- repair safe deterministic matches automatically;
- backfill existing tally history;
- rebuild all derived signals;
- add a user-facing repair queue only for genuinely ambiguous cases;
- make future newsletter ingestion reuse confirmed aliases automatically;
- test that corrected evidence actually affects Draft, Start/Sit, Trade, Players, and Team views.

The user should only need to intervene for names that truly cannot be resolved safely.

Do not ask the user to manually re-import the tally PDF or old newsletters.

Do not ask the user to redo past tally work.

Do not lose or duplicate any existing evidence.

---

# Source-of-truth tally example

The attached tally PDF is the current reference for expected accumulated player scores.

Important example:

**JSN = +11**

The PDF explicitly lists:

- JSN: +11
- key drivers include breakout/coverage numbers and R4 metrics

Fantasy Analyst must correctly attribute that accumulated signal to:

**Jaxon Smith-Njigba**

If Jaxon Smith-Njigba currently shows a zero tally boost, that is a bug in player identity resolution/backfill and must be repaired.

Treat this as a required regression case.

---

# Primary goals

1. Find all tally/evidence names that are not currently mapped to canonical Sleeper players.
2. Automatically fix every safe alias/name variant.
3. Backfill the repaired evidence into the canonical player.
4. Recalculate:
   - lifetime tally;
   - 30-day tally;
   - 7-day tally;
   - draft boost;
   - trade signal;
   - start/sit news signal.
5. Ensure future occurrences of the alias map correctly.
6. Surface only ambiguous/unresolved cases to the user.
7. Make the repair process visible but non-blocking.

---

# Non-interrupting behavior

The user does NOT want to babysit this cleanup.

Claude should first attempt autonomous resolution.

Use the following resolution order:

1. exact existing external ID;
2. existing confirmed alias;
3. exact normalized full name;
4. exact normalized full name + team;
5. exact normalized full name + position;
6. known/common abbreviation mapping;
7. deterministic nickname/shorthand mapping where unambiguous;
8. bounded fuzzy candidate generation;
9. user review only when ambiguity remains.

Do not send the user a giant list of names to fix if most can be resolved safely.

---

# Canonical alias examples to support

At minimum support patterns like:

- `JSN` → `Jaxon Smith-Njigba`
- hyphen vs no hyphen
- apostrophe variants
- initials
- suffix variants:
  - Jr
  - Jr.
  - III
  - II
- common fantasy shorthand
- spacing differences
- punctuation differences
- accents/diacritics for lookup purposes only
- common short forms where exactly one active Sleeper player fits

Do not guess if multiple active players could plausibly match.

---

# Backfill existing evidence

After an alias is resolved:

1. find every unresolved evidence item associated with that alias;
2. attach it to the canonical player;
3. preserve:
   - original source;
   - original excerpt;
   - original date;
   - polarity;
   - magnitude;
   - review state;
   - user override;
   - source message ID;
4. do NOT create duplicate evidence;
5. rebuild derived signals idempotently.

The user should not have to manually open every old newsletter and re-review the same evidence.

---

# Reconcile against current tally expectations

Use the attached tally PDF as a sanity-check reference for existing accumulated totals.

The PDF contains many current positive and negative scores, including:

- Puka Nacua +13
- JSN +11
- Josh Allen +10
- Jahmyr Gibbs +9
- Jonathan Taylor +7
- Jalen Hurts +7
- Sam LaPorta +6
- D'Andre Swift +6
- Trevor Lawrence +6
- De'Von Achane +6
- Kyle Pitts -5
- Chuba Hubbard -4
- multiple other positive, negative, and neutral players

Do not blindly overwrite the database with the PDF.

Instead:

- compare the app's derived tally to the reference;
- investigate mismatches;
- determine whether the cause is identity resolution, missing evidence, duplicate handling, review state, or another deterministic bug;
- fix the root cause;
- preserve the evidence ledger as truth.

Create a diagnostic report showing:

- reference name;
- reference score;
- canonical Sleeper player;
- app-derived score before repair;
- app-derived score after repair;
- delta;
- cause of mismatch;
- whether user review remains needed.

---

# JSN required repair

Explicitly verify:

1. `JSN` exists in historical tally/evidence data.
2. It maps to `Jaxon Smith-Njigba`.
3. All historical JSN evidence attaches to Jaxon Smith-Njigba.
4. Jaxon Smith-Njigba's lifetime tally reflects the repaired evidence.
5. His 30-day / 7-day values reflect timestamps correctly.
6. Draft Mode receives the tally boost.
7. Trade Intelligence receives the signal.
8. Players detail shows the evidence timeline.
9. Future `JSN` newsletter mentions map automatically.

Add a regression test for this exact alias.

---

# Help My Scores / Fix Player Matches

Keep or add a user-facing repair surface in Settings.

Preferred name:

**Help My Scores**

This should only show unresolved or suspicious aliases after autonomous repair has already run.

Example:

**Help My Scores**
2 names still need matching
+6 net tally currently unassigned

Tap to fix

For each unresolved alias show:

- alias/name;
- number of evidence items;
- net lifetime tally currently stranded;
- 30-day tally stranded;
- example excerpt;
- suggested player candidates;
- confidence.

User actions:

- Select correct player
- Ignore
- Not a player
- Search player

Once the user confirms a match:

- persist the alias globally;
- repair all matching evidence;
- rebuild signals;
- future occurrences auto-map.

Do not require repeated mapping.

---

# Suspicious mismatch detection

Add diagnostics for likely broken identity mappings.

Examples:

- unresolved alias has meaningful non-zero tally;
- canonical likely player has zero tally;
- alias and canonical surname/name are strongly similar;
- multiple evidence items share the same unresolved alias;
- a reference tally exists but app-derived tally is zero.

Surface these as:

**Likely score mismatch**

Do not auto-merge ambiguous cases.

---

# Future newsletter ingestion

Incoming newsletters must reuse the alias table before fuzzy matching.

Order:

1. exact canonical name;
2. confirmed alias;
3. normalized variant;
4. safe deterministic abbreviation;
5. bounded fuzzy candidate;
6. review.

Confirmed user mappings are authoritative.

Never overwrite them during reprocessing.

---

# Idempotency

This cleanup must be safe to rerun.

If Claude runs the repair process multiple times:

- no duplicate evidence;
- no duplicate aliases;
- no double-counted tallies;
- no duplicate user overrides;
- same final result.

Add tests.

---

# Review-state semantics

Preserve current rules:

- accepted / auto-applied / corrected contribute;
- pending / rejected / ignored do not;
- mixed / neutral contribute zero;
- user overrides survive all remapping/reprocessing.

If a score mismatch is caused by review state rather than identity, report that clearly.

Do not silently force pending evidence into the tally.

---

# Diagnostic reconciliation page

Add a lightweight Settings diagnostic section:

**Score Health**

Show:

- canonical players with tally mismatches;
- unresolved aliases;
- stranded evidence count;
- total stranded net tally;
- recent stranded tally;
- last repair run;
- repair status.

Possible states:

- Healthy
- Needs review
- Repaired
- Some evidence unresolved

Keep this user-friendly.

---

# Draft-day readiness

Before an active draft, if unresolved evidence would materially affect rankings:

show a non-blocking warning:

**Some player scores need matching**
2 unresolved names represent +9 net tally

`Fix now`

Do not block drafting.

---

# Performance

Do not scan the entire database on every page load.

Use:

- targeted reconciliation jobs;
- cached health summary;
- incremental updates after new newsletter ingestion;
- alias lookup indexes where appropriate.

Keep normal app usage fast.

---

# Tests

Add strong deterministic coverage for:

## Alias repair

- JSN → Jaxon Smith-Njigba
- punctuation normalization
- hyphen removal/addition
- initials
- suffixes
- confirmed alias persistence
- future auto-match
- ambiguous alias remains unresolved

## Backfill

- existing unresolved evidence reattaches
- no duplicate evidence
- lifetime signal rebuilds
- 30d signal rebuilds
- 7d signal rebuilds
- user override survives
- rejected/pending items remain excluded

## Reference reconciliation

- reference +11 vs app 0 identifies mismatch
- repaired alias resolves mismatch
- unresolved mismatch remains visible
- neutral player stays net zero

## UI

- Help My Scores count
- unresolved card
- candidate search
- confirm mapping
- score updates immediately
- iPhone rendering

## Regression

Required exact regression:

`JSN historical evidence -> Jaxon Smith-Njigba -> lifetime tally +11`

assuming the current evidence ledger contains the same reference evidence.

If exact database evidence differs from the PDF, the test should verify the mapping/backfill behavior rather than hardcode a false production total.

---

# Do not overwrite good data

Do not mass-replace current evidence with the PDF.

Do not delete evidence.

Do not change polarity/magnitude solely to force totals to match.

The goal is to repair identity resolution and missing attribution, not manufacture a desired score.

If a mismatch remains after identity repair:

report the true cause.

---

# Autonomous workflow

This should be a non-interrupting implementation pass.

Claude should:

1. inspect current player aliases;
2. inspect unresolved evidence;
3. inspect current derived tallies;
4. compare against the attached tally reference;
5. automatically fix safe mappings;
6. implement backfill/rebuild;
7. add Help My Scores / Score Health if incomplete;
8. add future-ingestion alias reuse;
9. test;
10. fix failures;
11. commit;
12. push;
13. open/update PR.

Do not ask the user to manually fix anything unless ambiguity truly remains.

If user action is required, provide only the single next action.

Do not merge unless explicit authority has already been given.

---

# Completion report

At the end, answer in plain English:

1. Why was JSN's score missing?
2. Is JSN now permanently mapped to Jaxon Smith-Njigba?
3. What is Jaxon Smith-Njigba's repaired lifetime tally?
4. Did all historical JSN evidence backfill correctly?
5. Which other names were automatically repaired?
6. How many aliases remain unresolved?
7. How much tally is still stranded?
8. Does Help My Scores show only genuinely ambiguous cases?
9. Will future newsletters automatically reuse confirmed aliases?
10. Were any evidence items duplicated or overwritten?
11. Are all derived signals rebuilt?
12. Do Draft/Trade/Start-Sit now receive the repaired signal?
13. Are all tests green?
14. Is the PR ready?
15. Is any user action required?

If user action is required, give only the single next action.
