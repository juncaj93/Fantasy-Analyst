# The in-person draft

A league that meets in a room, calls names off a wall, and tells Sleeper about
it that evening — if at all. Two things are true of every one of them, and this
app got both wrong until 30 August 2026.

---

## 1. The board must not disappear

**Reported, hours before a real draft:** the Draft tab was gone from the
toolbar, Matchup had taken its place, and the Team screen was drawing eight
`Nobody eligible yet` rows for a league in which not one pick had been made.

Three independent faults produced that screen. All three are fixed and each is
held by its own test in
[`tests/draft.inPersonDraft.test.ts`](../tests/draft.inPersonDraft.test.ts).

### `season_type: regular` does not mean the season has started

`/state/nfl`, read that morning — eleven days before any game:

```json
{ "week": 1, "leg": 1, "season": "2026", "season_type": "regular",
  "display_week": 1, "season_start_date": "2026-09-09" }
```

`core/sleeper/phase.ts` read `season_type === 'regular' && week >= 1` as "the
regular season is under way", with one guard against exactly this gap: a comment
and a test asserting that Sleeper "reports `week: 0` until it actually starts".
**It does not, and the guard never fired once.** Every league that had not
finished drafting by the last week of August lost its board — which is most of
the in-person ones, because they draft on a Saturday in September.

The field that separates the two is `season_start_date`, published on the same
object. It is now captured by `syncNflState` and is what week one is checked
against; week two and later need no date, and a stored state too old to carry
one keeps the board rather than guessing.

### An untimed draft is `pre_draft`, never `drafting`

`resolveLifecycle` already held that a draft taking picks outranks any calendar
witness. That rule was right and its reach was too short: `drafting` is a state
a draft only enters because somebody opened Sleeper's own draft room. A draft
with no start time sits at `pre_draft` from the day the league is created until
somebody marks it done, so it had nothing standing between it and a calendar
that had already declared the season under way.

`isDraftPending` now says so one level down, in `phase.ts`, where both the
four-state phase and the eight-state lifecycle reach it: **a draft Sleeper
positively describes as unfinished keeps the board, whatever the calendar
says.** That is the belt to the kickoff date's braces — it makes the class of
failure impossible rather than the specific instance.

### Sleeper's roster is not authoritative before the final pick

`buildLiveRoster` treated `pre_draft` as a finished draft, so an empty roster
was read as a real one and the Team screen drew a lineup over it. `pre_draft`
now counts as draft mode, which is what the screen already had: players *held*,
the slots still open, and none of the lineup furniture nobody sets before a
draft.

---

## 2. The picks have to get in somehow

An in-person draft publishes nothing. Every model in this app is built over the
pick stream — who is gone, the run at a position, what survives to your next
turn, what you hold — so with nothing arriving the board ranks a pool nobody has
been taken out of, four rounds in.

So the reader enters the picks themselves, one tap per name called.

| | |
|---|---|
| **Turn it on** | The `⊙` switch in the Draft header, beside the sort. Remembered per draft (`web/pickEntry.ts`), so a locked phone does not cost the reader their place. |
| **Record a pick** | Each row's ★ becomes a `+`. One tap appends it at the next pick number. |
| **Whose pick it was** | The `Mine` / `Theirs` chip on the entry bar. It follows the board's own `onTheClock` and resets to it after every pick, so a correction is about one pick rather than the rest of the afternoon. |
| **Undo** | The entry bar's `Undo`. |

### Where the picks go

**Into `draft_picks`, the same table Sleeper's picks go into.** That is the
whole design: no parallel store, no second read path, no flag downstream. The
board, the tiers, `Next%`, the survival model, roster need and the Team screen
read `listPicks(draftId)` and cannot tell the difference, because there is none.

The arithmetic — which pick number, which round, which seat — is
[`core/draft/manualPick.ts`](../src/core/draft/manualPick.ts), pure and tested.
Attribution takes Sleeper's `slot_to_roster_id` where a commissioner published
one, the reader's own answer where none exists (which is the common case for a
draft nobody opened), and stores no owner rather than guessing.

### Three refusals worth knowing about

- **Sleeper still wins.** `upsertPicks` conflicts on `(draft_id, pick_no)` and
  overwrites, so a commissioner who types the afternoon into Sleeper afterwards
  replaces the hand-entered rows with the official ones, pick for pick, with
  nothing to undo first.
- **Undo will only ever remove a pick this app wrote.** Hand-entered rows carry
  a marker in `raw_json`; a Sleeper row is *refused* rather than skipped past to
  find a hand-entered one underneath it, which would delete a pick the reader
  was not looking at.
- **A rehearsal cannot reach the real draft.** Both routes are POSTs, so the
  mock-draft and demo guards at the top of `server/app.ts` refuse them without a
  line being written for it. Asserted directly, because the real draft did not
  accept picks at all until now and a guard nobody has checked against the thing
  it guards is a guard nobody has checked.
