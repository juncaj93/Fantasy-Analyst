# Feedback: somewhere to write it down

A support snapshot answers *why is the board recommending this*. It freezes the
state behind one recommendation and hands it over as a file that replays through
the real engine. That is the right shape for a decision, and it is far too much
machinery for the other half of what goes wrong with an app: a number that reads
oddly on Team, a row that wraps at 360px, a screen that felt slow, a word that
is wrong. Those go unwritten because there is nowhere to write them down, and by
the evening they have become *something looked wrong on one of the screens*.

So: **Setup → This app → Add feedback**. A row, a line of text, Save.

---

## For the user

**Add feedback** unfolds a one-line field under the row. Type what looks wrong
and press Save — or Enter, or Cancel if you have changed your mind. The row then
hands your own sentence back to you, and the **Feedback** row directly beneath
it counts one higher.

**Feedback** opens the list: every note, newest first, with how long ago it was
written. Each one can be deleted on its own. **Copy all** puts the whole queue on
the clipboard as plain text, ready to paste into a chat with an AI assistant or
anyone else — and then *asks* whether to clear the queue, because you may well
have copied it to see what it says.

Nothing is uploaded. There is no feedback endpoint, no telemetry and no
background send: the queue is on the phone until you copy it out.

### What a note records

```
1. 2026-08-28 20:41 UTC (1 hour ago)
   "the bench total reads higher than the starters"
   Live · Dark · 390×844 · Home Screen app
```

Your sentence, when you wrote it, and four facts about the session it was
written in: whether the app was reading live data or a demo scenario, which
theme was showing, the size of the glass, and whether this is the Home Screen
app or a browser tab.

That last group is not padding. Half of what only ever happens to one person is
a width, a theme or a shell — "it wraps" and "it wraps at 360 in Dark on the
Home Screen app" are a day apart for whoever has to reproduce it. All four stay
true wherever the note was typed, which is why they are the only things kept
beside the words.

### What it does not record

**Which screen you were on.** Nothing asks you to be on one: the action lives on
the Settings page, beside the list it fills. That is the design rather than a
limitation — a note is a sentence you chose to write, not a recording of a
moment you happened to be having.

Nothing else is collected either: no league id, no draft id, no manager, no
player, no request and no error text. There is therefore no field an identity
could arrive in, which is what lets the queue be pasted into a chat window
without being read first. The diagnostic dump already exists two rows up in the
same group, and it is the thing to reach for when a *recommendation* is wrong —
see [SUPPORT_SNAPSHOT.md](SUPPORT_SNAPSHOT.md).

**The note is the entry.** An entry with no words in it would carry nothing at
all, so Save is offered only once there is something to save, and the queue
refuses an empty note independently of the button. Both halves are tested.

---

## Where it lives, and every place it does not

Two rows in Settings → This app, at the end of the group that already holds
`Data health` and `Copy support snapshot`. The support loop reads downwards:
whether the data was healthy, the state behind one recommendation, and then
plain words for everything those two cannot express.

| not | because |
|---|---|
| a control on every screen | nothing about this is urgent enough to be persistent. Writing feedback is a thing you sit down to do; a control pinned over every screen spends 44px of every page on an errand that is not part of using the app |
| in the taskbar | six destinations is the most that strip of glass carries, and it is at its width limit on a 360px phone. This is maintenance, and maintenance does not compete with the decisions the bar is for — the same rule that keeps Review, Data health and Copy support snapshot inside Settings (§9, §16) |
| a gesture | invisible, and ruled out by [06_UI_AND_QA.md](brief/06_UI_AND_QA.md) — "do not hide essential meaning behind gesture-only controls" |
| a sheet | a sheet can be flicked away, and flicking away a half-typed sentence is a bad trade for a modal nobody asked for |
| a pushed screen | a navigation transition around a single line of text |

What is left is the composer unfolding in place, under the row — the same
`.list-row-actions` arrangement the unscored-newsletter controls already use,
and the one thing that pattern is for: work attached to a row, temporary by
definition. It keeps the queue's count visible one row down while the note is
being written, so saving and the count moving are one glance.

`e2e/feedback.spec.ts` asserts, on every destination the toolbar can show, that
no floating control exists anywhere in the app and that the shell pins nothing
over the page beyond its own navigation bar and toolbar. That property decays
silently otherwise.

---

## Where it is kept

`localStorage`, under `fa.feedback.queue`, exactly as the theme, the install
dismissal, the mock-draft session and the offline board are: a preference of
this phone rather than of the account. It needs no passphrase, no request and no
server, and it must survive a reload — which is what rules out `sessionStorage`.
(The support *context* uses `sessionStorage` deliberately, because a context
remembered from last Tuesday would be worse than none. A note from last Tuesday
is exactly what this is for.)

Every access is guarded the way `offlineCache.ts` guards its own. Safari in a
private window throws on the property rather than returning null, and a control
that cannot be used because the reader is browsing privately would be a poor
trade. A failure to store is silent: there is nothing the reader could do about
it.

The queue is bounded twice — fifty entries and 64,000 characters — and it is
always the **oldest** that go, because the note somebody just wrote is the one
they are thinking about. A note is one line and capped at 200 characters, so a
paste into the field cannot turn the queue into something no clipboard will
take.

A payload that cannot be read is thrown away rather than left to fail again, and
**one malformed entry does not cost the reader the rest of them**: entries are
validated individually. Refusing the whole envelope on one bad row would mean a
single entry written by an older build empties the queue.

The stored schema is `2`. `1` was a per-screen capture whose note could be
absent; an entry from it would read as a note with no words in it, so the whole
queue is dropped rather than half-read. Nothing was ever deployed under `1`.

---

## Files

| file | what it is |
|---|---|
| [`src/web/feedbackQueue.ts`](../src/web/feedbackQueue.ts) | the entry, the storage, the caps, and the copy format |
| [`src/web/components/feedbackQueue.tsx`](../src/web/components/feedbackQueue.tsx) | both Settings rows, the composer, and the pushed queue screen |
| [`tests/feedbackQueue.test.ts`](../tests/feedbackQueue.test.ts) | what a note records, what the queue survives, what the copy says |
| [`e2e/feedback.spec.ts`](../e2e/feedback.spec.ts) | that nothing is persistent anywhere, the composer, delete, and copy-then-ask |
