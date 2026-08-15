# Fantasy Analyst — Per-Game Usage Feed (nflverse weekly stats)

## Mission

Connect a free per-game usage source so the **role-change detector stops
answering "insufficient data"**.

The detector is already written, tested and wired into Start/Sit. It has never
had an input. `docs/STATUS.md` calls this *"the last input the weekly decision
layer is missing"*, and it is the highest-value free improvement left before the
season.

Nothing in this brief costs money. No paid API, no key, no account, no card.

---

## Autonomy

Work autonomously. Inspect latest `main`, implement, test, commit, push, open a
PR, wait for exact-head green, merge, deploy, smoke-test production, report once.

Interrupt only for a real blocker: unavailable credentials, anything with a
cost, or a destructive irreversible action.

Follow `docs/brief/08_WORKING_AGREEMENTS.md`. In particular: do not hold a shell
open to watch CI. Start the remote job, release the shell, query status
periodically, and continue the moment it lands.

---

## 1. The investigation is already done — do not redo it

Everything in this section was measured against the live files on 2026-08-15,
not read from documentation. Trust it, but re-verify anything you are about to
depend on if it looks wrong; the files change weekly.

### The source

```
https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv
```

The 2026 file will be at the same URL with the year changed, and — like the
injury report — **will 404 until the season starts**. That is a reported state,
not a failure. Reuse the `not_published` handling that already exists.

| | |
|---|---|
| Size | 8.3 MiB, 19,422 data rows, 150 columns |
| Grain | one row per player per week |
| Weeks | 1–22 (REG 18,540 rows, POST 882) |
| Skill-position rows | 6,321 (QB/RB/WR/TE) |
| Rows per week | ~883 mean, 1,108 max |
| Validators | `ETag` and `Last-Modified` present — conditional requests work |

### Why this file and not snap counts

`snap_counts_2025.csv` (2.4 MiB, 26,612 rows) carries `offense_snaps` and
`offense_pct`, which are good role signals. **It was rejected anyway**, because
its only identifier is `pfr_player_id`. This app has one canonical identity path
and a proven matcher; adding a second fuzzy matcher for a second id space is
precisely what every brief in this project has ruled out.

`stats_player_week` carries **`player_id` as a GSIS id** (`00-0023459`) — the
same identifier space as `gsis_id` in the injury report, which already resolves
at 98.9% through `resolveToCanonical`. Reuse that path unchanged.

`player_stats_2025.csv` does not exist (404). The release tag is `stats_player`.

### The columns that matter

`player_id`, `player_display_name`, `position`, `week`, `team`, `targets`,
`carries`, `receptions`. Also present and worth considering: `target_share`,
`air_yards_share`, `wopr`, `attempts` (pass attempts, for QBs).

Column indices are **not stable across seasons** — read them from the header by
name, exactly as `parseInjuryReport` does.

---

## 2. The two traps

### Trap 1 — this file cannot be split on commas

**19,394 of 19,422 lines contain a quoted comma.** `headshot_url` embeds
`f_auto,q_auto` inside quotes:

```
00-0023459,A.Rodgers,Aaron Rodgers,QB,QB,"https://…/upload/f_auto,q_auto/league/…",2025,1,REG,…
```

A naive `split(',')` yields **151** fields where the header has 150, shifting
every column after index 5.

This is the mirror image of the injury file, whose entire 679 KiB contains six
quote characters — so `splitRow`'s fast path is worthless here and must not be
copied.

**A fixed offset correction is not safe.** The damage is not uniform:

| Naive field count | Lines |
|---|---|
| 151 | 19,377 |
| 152 | 17 |
| 150 | 28 |

Correcting by +1 would silently corrupt ~45 rows and misread `week` on roughly
one line in 500. Silent corruption of a usage series is worse than no usage
series at all.

### Trap 2 — the general parser is far too expensive

Running a full RFC4180 parse over the whole file is out of the question: the
injury work measured the careful parser at ~154 ms for a 679 KiB file, and this
one is twelve times larger. A Workers invocation gets **10 ms of CPU** on the
free plan.

---

## 3. The design that works, with its measurements

Two properties make this affordable.

**The file is monotonically non-decreasing by week.** Verified across all 19,422
rows. So the latest week is at the end, and the rows for it can be read by
walking backwards from the last line and stopping at the first row of a
different week — no full scan.

**Only eight of 150 columns are wanted.** A quote-aware single-pass extractor
that keeps only the requested indices builds eight strings per row instead of
150.

Measured cost, mid-season file:

| Step | Cost |
|---|---|
| `text.split('\n')` | 0.85 ms |
| walk backwards for the latest week | 0.001 ms |
| extract that week, skill positions only | 0.10 ms |
| **total** | **~1 ms** |

Cheaper than the injury path despite a file twelve times the size.

### The extractor, and the bug to avoid

A working prototype was validated at **0 mismatches across all 19,422 lines**
against a full quote-aware parse. One bug was found and is worth stating,
because it fails silently:

> The single pass requires the wanted column indices in **ascending order**.
> Given `[0, 2, 3, 7, 10, 45, 32, 44]`, it matched up to 45 and then could never
> match 32 or 44 — so `carries` and `receptions` came back as empty strings with
> no error. Sort the indices, then map results back to the caller's order.

Also note: a field may or may not be quoted, so strip a leading/trailing quote
only when present. Handle `\r` if the file ever ships CRLF (it does not today).

**Write the correctness harness first.** Compare the extractor against a full
quote-aware parse over every line of a real downloaded file, and require zero
mismatches. That harness is what caught the ordering bug.

---

## 4. What already exists — reuse, do not rebuild

### The detector (complete, needs only input)

- `assessRole(metrics: RoleMetric[])` in `src/core/startsit/decisions.ts`
- `RoleMetric = { key, label, perGame: number[] }`, per-game values oldest first
- `StartSitInput.usage?: RoleMetric[]` in `src/core/startsit/engine.ts`
- Thresholds in `WEEKLY_THRESHOLDS.role`: **3 recent + 3 baseline games
  minimum**, so nothing is said until a player has six
- It already guards the two failure modes worth guarding: a one-game spike is
  reported as a spike and not a trend, and high confidence needs agreement
  across metrics

Feeding it is the whole job. Do not retune it.

### The ingest machinery (proven this season)

`src/core/injury/nflverse.ts` and `src/server/services/injuryService.ts` between
them already implement, tested and in production:

- conditional GET with `ETag` / `If-None-Match`, 304 handled as "nothing to do"
- `not_published` (404) as a reported state that stores **no** validator
- a compare-and-swap ingest lease that expires (`INGEST_LEASE_SECONDS`)
- a daily write budget with its own ledger key
- an anomaly guard that fails closed on suspicious mass change
- diff-only writes, and `changedPlayerIds` for targeted downstream recompute
- consecutive-failure counting so a fresh `checkedAt` cannot vouch for stale data

Model the usage service on `InjuryService`. Where a helper is genuinely shared,
extract it rather than copying it — but do not refactor the injury pipeline in
this pass beyond what sharing requires.

---

## 5. What to build

1. **A parser**, `src/core/usage/nflverse.ts`: the quote-aware ascending-index
   extractor, header-driven column lookup, bounded to the latest week and to
   QB/RB/WR/TE. Same `FetchOutcome` vocabulary as the injury fetcher.

2. **Storage**, migration `0016_player_usage.sql`: one row per
   `(player_id, season, week)` carrying targets, carries, receptions and
   whatever else is adopted, plus source and fetched-at. Season-keyed, so 2025
   and 2026 cannot collide — the same property that keeps injury history out of
   current status.

   Migrations are parsed **server-side** by D1 on `wrangler d1 migrations apply
   --remote`, which is not the parser `--local` uses. Line comments only, no
   `/* */` blocks — `tests/migrations.test.ts` enforces this and explains why.

3. **A service** with a `refresh()` that follows the injury shape: check →
   304 exit → lease → ingest latest week → diff → write only what moved.

4. **A read path** that assembles `RoleMetric[]` per player from stored weeks,
   oldest first, and passes it into the Start/Sit engine's existing `usage`
   input.

5. **Cron wiring.** The five-minute tick already carries the injury check and,
   until it finishes, one step of the 2025 history backfill. Decide deliberately
   where usage belongs — weekly stats do not change every five minutes, and the
   daily 09:00 cron may be the honest home. State the reasoning in the code.

6. **Diagnostics** in Setup, matching the injury panel's discipline: separate
   "when we last looked" from "when the data last changed" from "how many
   ingests failed in a row".

---

## 6. Constraints that do not move

- **Free only.** No paid API, key, account, trial or card.
- **Unknown stays unknown.** A player with fewer than six games gets
  `insufficient_data`, not an extrapolation. Never invent a per-game value.
- **Never fabricate a trend from one game.** The detector already refuses; do
  not work around it upstream by smoothing or backfilling.
- **Sleeper stays the source of truth** for identity, league, roster, scoring
  and draft state, and for live injury designation.
- **Do not retune** Draft ranking, Start/Sit weights, Trade urgency, tally, ADP
  or the injury pipeline. This is a new input, not a rebalance.
- **Do not add a second identity matcher.** GSIS through `resolveToCanonical`,
  or the row is dropped and counted as unresolved.
- Kickers remain unsupported and out of scope.

---

## 7. Tests

- **Parser correctness**: zero mismatches against a full quote-aware parse over
  a real file, including the 152-field and 150-field lines.
- **The ascending-index bug**: a fixture that requests columns out of order and
  asserts every one comes back populated.
- **Lifecycle**: 404 → `not_published` with no validator stored; first 200 →
  validator stored and rows written; unchanged → 304, no parse, no writes.
- **Bounded parse**: only the latest week is parsed, and only skill positions.
- **Identity**: a GSIS match resolves; an ambiguous name with no GSIS is
  declined and counted, never guessed.
- **The detector, end to end**: six weeks of rising targets produce a rising
  trend; five weeks produce `insufficient_data`; one huge game among five flat
  ones produces `spike`, not a trend.
- **Mutation-test** at least: full-file parse restored, naive comma split
  restored, and the six-game minimum lowered. Break it, watch a test fail,
  restore it.

---

## 8. Verification

```bash
npm run typecheck
npx vitest run
CI=1 npm run e2e:chromium
npm run build
npx wrangler deploy --dry-run
```

Then exact-head CI including the WebKit job — it runs 11–13 minutes, which is
normal, and green-but-skipped does not count.

Integrate latest `main` before final verification.

Production smoke: confirm the 2026 usage file reports `not_published`, that the
five-minute injury check is still firing, and that Start/Sit still answers.

**State clearly what cannot be observed until the season starts.** As with the
injury feed, the 304 path and a real ingest cannot run in production while the
2026 file is a 404. Do not claim production CPU safety from Node timings — on
Workers, D1 calls are I/O and do not count against the 10 ms, so a Node
benchmark that includes synchronous SQLite will overstate CPU badly. That
mistake was made once in this project already.

---

## 9. Final report

1. Which file, and why that one rather than snap counts?
2. Was the quoted-comma trap handled, and how was correctness proven?
3. What is the measured parse cost, and what does it exclude?
4. What is stored, and how is it kept apart from other seasons?
5. How does a player's `RoleMetric[]` get built?
6. How many games before the detector says anything?
7. Where is the ingest scheduled, and why there?
8. What does Start/Sit show now that it did not before?
9. What happens while the 2026 file is still a 404?
10. Tests, including mutation results?
11. Exact-head CI, merge, deploy, smoke?
12. What remains unobservable until the season starts?
13. Does the user need to do anything?

---

## Start here

The source is chosen, the identifier is chosen, the parser design is proven at
~1 ms with zero mismatches, and both traps are documented above. Write the
correctness harness first, then the parser, then the storage, then the wiring.
