# Flagging a screen: the other half of "this looks wrong"

A support snapshot answers *why is the board recommending this*. It freezes the
state behind one recommendation and hands it over as a file that replays through
the real engine. That is the right shape for a decision, and it is far too much
machinery for the other half of what goes wrong with an app: a number that reads
oddly on Team, a row that wraps at 360px, a screen that felt slow, a word that
is wrong. Those are noticed in passing, three taps from anywhere that could
record them, and by the evening they have become *something looked wrong on one
of the screens*.

**Flagging** is the same idea at a tenth of the weight. One tap says *here,
this, now*; the app writes down where "here" was; the whole queue leaves later
as one block of text.

---

## For the user: one tap, and then nothing

There is a small flag in the bottom corner of every screen. Tap it and the
screen is flagged — that is the whole of it. A strip appears saying what was
just flagged, with a one-line field beside it; type in it if you have something
to say, and ignore it if you do not. It takes itself away after a few seconds if
you never touch it.

**Skipping the note is not a shorter path — it is no path.** The flag is written
down before anything is drawn, so walking away, locking the phone or navigating
somewhere else all keep it. Nothing here is a form with a Cancel on it.

Everything flagged is at **Setup → This app → Flagged**, newest first, with the
screen, your note and how long ago it was. Each one can be deleted on its own.
**Copy all** puts the whole queue on the clipboard as plain text, ready to paste
into a chat with an AI assistant or anyone else — and then *asks* whether to
clear the queue, because you may well have copied it to see what it says.

Nothing is uploaded. There is no feedback endpoint, no telemetry and no
background send: the queue is on the phone until you copy it out.

### What one flag records

```
1. Team — 2026-08-28 20:41 UTC (1 hour ago)
   "the projection under Ike looks low"
   Last recommendation: Waivers · Live · Dark · 390×844 · Home Screen app
```

The destination you were on, the recommendation you had last looked at, whether
the data was live or a demo scenario, which theme was showing, the size of the
glass, and whether this is the Home Screen app or a browser tab. Plus your line,
if you wrote one.

That last group is not padding. Half of what only ever happens to one person is
a width, a theme or a shell — "it wraps" and "it wraps at 360 in Dark on the
Home Screen app" are a day apart for whoever has to reproduce it.

### What it does not record, and why

**The screen's own title.** The obvious improvement is to read the visible
`NavBar` title, which would say `Newsletter` rather than `Setup` when a panel is
pushed. One of those titles is the league's own name — `TeamScreen` heads itself
with it — and this text is written to be pasted into a chat window. A capture
that is right seven times and prints the league's name the eighth is one that
has to be read before it can be sent, which defeats the point of a queue you
copy in one tap. The destination is an enum in this repository, so it can never
become an identity.

Nothing else is collected either: no league id, no draft id, no manager, no
player, no request and no error text. This is a note about a moment. The
diagnostic dump already exists, one row up the same group, and it is the thing
to reach for when a *recommendation* is wrong — see
[SUPPORT_SNAPSHOT.md](SUPPORT_SNAPSHOT.md).

---

## Where the control lives, and every place it does not

The control is drawn by the shell — `App.tsx`, beside the toolbar — so no screen
knows it exists and no screen can forget it. That is the same arrangement the
demo indicator has, and it is what makes the control reachable from screens
nobody is allowed to edit this week.

Where it sits was the whole design question, and the alternatives are worth
keeping because they are the reasons somebody will move it back one day:

| not | because |
|---|---|
| in the taskbar | six destinations is the most that strip of glass carries, and it is at its width limit on a 360px phone. Flagging is maintenance, and maintenance does not compete with the decisions the bar is for — the same rule that keeps Review, Data health and Copy support snapshot inside Settings |
| in the navigation bar | Draft, Players, Trades and Review already put their own actions on its trailing edge, so a shell-level control there would land on top of one of them on the screens most likely to be flagged |
| a gesture | invisible, and ruled out by [06_UI_AND_QA.md](brief/06_UI_AND_QA.md) — "do not hide essential meaning behind gesture-only controls". The app also already spends its gestures: an edge swipe for Back, a downward pull for refresh, a downward drag on a sheet. A fourth would have to be arbitrated against all three |
| inside a screen | it has to be on every one of them, including the ones nobody may touch |
| at the bottom of the page | a control you have to scroll a three-hundred-row board to reach is not reachable |

What is left is a small floating control in the trailing corner, in the same
material as the toolbar it sits above: the same capsule, blur, hairline and
shadow, because it floats over the page in the same way and a second floating
material would be a second design. It does not take the accent — a filled circle
in the corner of every screen would read as a primary action, and this is not
one.

**It costs 44px of the corner of the page, and that is a real cost.** It is the
most honest thing wrong with this design. Everything above costs more.

### What it does not interfere with, and how that is known

`e2e/feedback-capture.spec.ts` holds each of these, by measurement rather than
by assertion:

- **Scrolling.** It is an ordinary `<button>`: nothing calls `preventDefault`,
  sets `touch-action` or attaches a `touchmove` listener, so a finger that lands
  on it and moves scrolls the page underneath. The spec drags upwards from the
  control's own centre and asserts the page moved and the control did not fire.
- **Taps along the bottom of the page.** The layer the control sits in spans the
  page's width, and it takes no pointer events — only the control and, while it
  is up, the strip do. The spec asks `elementFromPoint` at the leading edge of
  that band and asserts the layer is not what answers.
- **Back.** It is on the *trailing* edge; the edge-swipe gesture starts in a
  28px strip on the leading one.
- **Pull to refresh.** That begins at the top of the page.
- **The toolbar.** The control's bottom edge sits at `--content-inset` — where
  the page's own content stops — so it is clear of the pill, and the spec
  measures the two rectangles rather than trusting the arithmetic.
- **Anything modal.** It leaves whenever a layer covers the app (`useAppIsCovered`),
  so it can never take a tap meant for a sheet, a menu or the draft board.
- **The keyboard.** It leaves while the keyboard is up, exactly as the toolbar
  does, and the strip lifts by the occlusion so a field is never drawn under the
  keyboard.

---

## Where it is kept

`localStorage`, under `fa.feedback.queue`, exactly as the theme, the install
dismissal, the mock-draft session and the offline board are: a preference of
this phone rather than of the account. It needs no passphrase, no request and no
server, and it must survive a reload — which is what rules out `sessionStorage`.
(The support *context* uses `sessionStorage` deliberately, because a context
remembered from last Tuesday would be worse than none. A flag from last Tuesday
is exactly what this is for.)

Every access is guarded the way `offlineCache.ts` guards its own. Safari in a
private window throws on the property rather than returning null, and a flag
control that cannot be tapped because the reader is browsing privately would be
a poor trade. A failure to store is silent: there is nothing the reader could do
about it.

The queue is bounded twice — fifty entries and 64,000 characters — and it is
always the **oldest** that go, because the flag somebody just made is the one
they are thinking about. A note is one line and capped at 200 characters, so a
paste into the field cannot turn the queue into something no clipboard will
take.

A payload that cannot be read is thrown away rather than left to fail again, and
**one malformed entry does not cost the reader the rest of them**: entries are
validated individually. Refusing the whole envelope on one bad row would mean a
single entry written by an older build empties the queue.

---

## Files

| file | what it is |
|---|---|
| [`src/web/feedbackQueue.ts`](../src/web/feedbackQueue.ts) | the entry, the storage, the caps, and the copy format |
| [`src/web/components/feedbackCapture.tsx`](../src/web/components/feedbackCapture.tsx) | the floating control and the strip, and why it floats there |
| [`src/web/components/feedbackQueue.tsx`](../src/web/components/feedbackQueue.tsx) | the row in Settings and the pushed queue screen |
| [`tests/feedbackQueue.test.ts`](../tests/feedbackQueue.test.ts) | what a tap writes down, what the queue survives, what the copy says |
| [`e2e/feedback-capture.spec.ts`](../e2e/feedback-capture.spec.ts) | the control on four screens, the gestures it does not take, delete, and copy-then-ask |
