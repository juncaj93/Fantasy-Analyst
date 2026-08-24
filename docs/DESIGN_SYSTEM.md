# The design system

One stylesheet, one set of primitives, six screens. This document is the short
version of [`src/web/styles.css`](../src/web/styles.css) and
[`src/web/components/native.tsx`](../src/web/components/native.tsx); the files
themselves carry the reasoning.

The target is an app that feels like it belongs on an iPhone: hierarchy from
type and surface tone, separation from hairlines and whitespace, a border only
where nothing else will do. It uses iOS's *principles*. It ships no Apple font,
icon, asset or branding — every glyph in the app is drawn in
[`components/icons.tsx`](../src/web/components/icons.tsx).

## Rules

1. **A component names a role, never a colour.** `var(--text-dim)`, not a hex.
   Light and Dark are two settings of one system, not two stylesheets.
2. **Colour is never the only carrier of meaning.** Every positive/negative
   state also carries a sign, a glyph or a word; every position tint also
   carries its letters.
3. **Typography before boxes.** If two things need separating, try size, weight
   and tone first, a hairline second, and a border last.
4. **Everything is on the spacing scale.** 2 (hairline), 4, 8, 12, 16, 20, 24.
   A component that wants its own number has stopped being part of a system.
5. **Touch targets stay at 44px** even when the visible control is smaller.
   The mark and the target are two boxes, not one — see `.row-action`, which is
   how a 28px glyph on a compact row carries a 44px target without the row
   gaining a pixel.
6. **A control is never nested inside another control.** A row that leads
   somewhere *and* carries its own action is a container with two sibling
   buttons in it, never one button wrapping the other: nesting is invalid HTML,
   it collapses two actions into one tab stop, and it leaves the inner one's
   target at whatever its glyph happens to measure.

## Tokens

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg` `--surface` `--surface-raised` `--surface-sunken` `--surface-inset` |
| Material | `--nav-surface` `--toolbar-surface` `--toolbar-border` `--toolbar-bloom` `--blur` `--scrim` |
| Lines | `--separator` `--separator-soft` `--border-strong` |
| Text | `--text` `--text-dim` `--text-faint` |
| Semantic | `--accent` `--pos` `--neg` `--warn` and their `-tint` pairs |
| Injury | `.injury-caution` `.injury-serious` `.injury-out`, over `--status-neutral` |
| Position | `--pos-QB-line` / `--pos-QB-tint` … and `--pos-mix` / `--pos-mix-open` / `--pos-mix-draft` for how much of it a row shows |
| State | `--selected` `--selected-tint` `--pressed` `--focus-ring` |
| Geometry | `--radius-sm: 8` `--radius: 12` `--radius-lg: 16` `--radius-sheet: 20` `--radius-toolbar: 25` `--radius-pill` `--tap: 44` |
| Row control | `--row-action: 28` (the mark) against `--tap: 44` (the target), `--row-pad-top: 6`, `--chevron: 14` / `--chevron-nudge: -2` |
| Spacing | `--sp-0: 2` `--sp-1: 4` `--sp-2: 8` `--sp-3: 12` `--sp-4: 16` `--sp-5: 20` `--sp-6: 24` |
| Motion | `--dur-fast: 120ms` `--dur: 220ms` `--dur-slow: 320ms` `--ease` |
| Elevation | `--shadow-1` `--shadow-2` `--shadow-sheet` `--shadow-toolbar` |
| Toolbar | `--tab-w: 52` (48 under 375px) `--toolbar-pad: 5` `--toolbar-height` (measured) `--toolbar-gap` |
| Device | `--safe-top` `--safe-bottom` `--nav-inset` `--content-inset` |

`--text-faint` is the quietest text allowed: it reads at 4.5:1 against both the
page and a card. Anything greyer looked calmer on a desk and vanished on a phone
in daylight.

`--pos-mix` is how much of a position's hue a row's surface actually takes, and
the default is **none**. A wash strong enough to read as a colour turns a
hundred-row list into a rainbow, so on almost every screen the position is
carried by the lettered pill and nothing else.

**Draft is the one screen with a tinted row, and that is the point.** The board
spends `--pos-mix-draft` — 9% in Light, 22% in Dark — which is faint enough that
the row still reads white first and strong enough to show that four receivers in
a row are four receivers in a row. It is scoped to `.board-list > .card-pos`
rather than set on `.card-pos` itself, so a reader who has learned that a tinted
row means "you are on the draft board" is never shown one anywhere else. Team,
Players, Trades and Waivers all draw the same `card-pos-*` classes and take only
the hue for their pills. `--pos-mix-open` is the same wash on an opened card,
which sits on `--surface-raised` and therefore needs a little more of it to look
like the same amount.

There is no rail. The board used to carry a coloured left border *and* a wash,
which is two cues for one fact; the wash stayed, the border went, and the
hairline between rows is the list's own.

`--status-neutral` exists for the same reason in reverse. A chip that lands on a
card washed in a position's colour cannot be painted in a hue and stay legible —
`Q` was amber on the amber WR tint, and disappeared. Slate is nobody's colour
here, and it inverts between the themes, so the one status a reader sees most
often is readable on all six positions. The severity ladder is then slate →
amber → red, which is shape as well as colour, and the letter still says which
is which.

## Primitives

| Component | What it is |
| --- | --- |
| `NavBar` | A compact, sticky navigation bar: title, one line qualifying it, the screen's actions. Never a hero header. |
| `BackButton` / `PushScreen` | A pushed detail screen and its Back control, plus the edge-swipe gesture where the platform allows it (see [IOS_WEB_APP.md §9](./IOS_WEB_APP.md)). |
| `ListGroup` / `ListRow` | The grouped list: one surface, rows divided by hairlines, trailing value and chevron. |
| `SegmentedControl` | Two to seven exclusive modes on a sunken track; the selected one is raised, not filled. |
| `SearchField` | Magnifier, compact field, clear control that appears only when there is something to clear. Used on Players; the matching itself is `src/web/search.ts`, which filters rows and never re-ranks them. |
| `SearchFilterRow` | Search folded into a glyph beside the filters, unfolding into a field that takes the row. Draft uses it; the row is one tap target tall in both states, so opening it moves nothing. Only the control labelled Cancel discards a query. |
| `Sheet` | A modal sheet: rounded top, grab handle, dimmed backdrop, swipe-to-dismiss, and a Done control because a gesture is never the only way out. |
| `SkeletonRows` | Loading at the shape of what is coming, so the page does not jump when it lands. |
| `PlayerIdentity` | Who a player is, on the leading edge of any row: a fixed-width position pill, then the club's mark at the smaller inline size, then his name. `flex: none`, so every name in a list starts on the same x whatever follows it. Draft, Players, Trades, Waivers and Team's lineup and bench all open with it — `e2e/row-alignment.spec.ts` holds all five to it, and to the column being reserved rather than filled with an invented value. |
| `CompactPlayerRow` | One player as one row, in the columns every list shares: rank, a control of the screen's own, the name, the tally/availability field, the position, a chevron — then up to four labelled numbers and one short line. Players and Trades both draw from it, which is what makes a player read as the same object on both. A container, not a button: the way in is a `.dense-row-open` inside it and the screen's own control is its sibling. |
| `.row-action` / `.row-action-slot` | A row's independent control — the heart on Players, the star on the draft board — hung over the row instead of sitting on it. The line keeps a `.row-action-slot` of exactly the mark's 28px so nothing on it moves; the control is absolutely positioned over that slot at `--tap` square, starting at the row's top edge rather than centred on the mark, so the target never reaches into the row above. Out of flow, so it costs the row no height. |
| `PlayerPage` | The player's own pushed destination: four adaptive metric tiles, then Overview / Outlook / Market / Evidence behind a segmented control. Reached from Players directly, and from Trades with its case as context above the sections. The evidence ledger is entire, with a polarity lens over it. |
| `.dense-group` | The grouped list those rows sit in: one surface, hairlines between rows, no gaps and no per-row shadow. The alternative to forty cards. |
| `Disclose` | Inline expand/collapse that animates height without mounting its children until it opens. |
| `PositionBadge` / `positionCardClass` | The position, as letters and as a card tint. `positionCardClass` paints a fill and belongs to the draft board; `positionAccentClass` hands over the hue without the fill, and is what every other list uses. |
| `CompactTally` / `SignedValue` / `Signal` | The research tally at three levels of loudness. |
| Draft card bottom row | `1fr auto`: the four metrics on the left, the tier-cliff warning tucked into the right-hand end of the same line. A warning costs the card no height, so a thinning position no longer puts a stutter in the board's rhythm. The chip has a short spelling below 376px, where four labelled numbers and nineteen characters will not share the line — the full sentence stays in its accessible name at every width. |
| `Badge` / tags / `Confidence` | Status pills, ranked by how much attention each state deserves. |
| `ScoreCard` | The head-to-head, in one card. Sleeper's score is the largest type on the screen; the projection sits under it in the quieter weight everything derived uses, and carries the word `proj` every time it appears — an unlabelled number that size beside a real score reads as another real score. Once the matchup is settled the projection and the odds both go and a result line takes their place: a probability shown for a finished game is a forecast presented as a fact. |
| `WinBar` | Both percentages printed, and a `role="meter"` between them. The bar is an accelerator and never the carrier of the meaning. |
| `HeroCarousel` | One live insight at a time: auto-advancing slowly, pausing the instant it is touched, swipeable, and pageable by a button because a gesture is never the only way through. A single insight renders as a card with no pager at all — a carousel with one slide is a control that lies about having more to say. |
| `SlotRow` | Both sides of one lineup slot on one line, around a fixed-width position pill that never moves between rows. Names truncate rather than wrap; below 400px the numbers and the club marks each give up a point so the names get their letters back. |
| `BenchSection` | Collapsed on arrival, always. The bench is hindsight, and hindsight belongs behind a tap. Its rows are a starter's row exactly — same `PlayerIdentity`, same value field, same widths — so opening the fold adds rows without moving the columns above it. A bench player's pill says what he plays, never `BN`: where he is sitting is what the section heading is for. |
| Team's trailing value | One number, alone, in a fixed field: the weekly **projection**, in every game state. Team does not read Sleeper's running points at all — live and final scores are the Matchup screen's, from `players_points`. Where no market has priced a player the field holds `—`; it is never a zero, and never the ranking score, which is a different question with a different scale (see `core/startsit/projection.ts`). |

## The bottom of the screen

The navigation is one floating pill rather than a full-width band, and the
arithmetic under it is worth stating once because getting it wrong is what put a
blank strip under the navigation twice:

- **The pill owns the device inset**, as the distance it floats off the bottom
  edge (`--toolbar-gap`). On a screen with a home indicator that is the
  indicator's reach plus a little air — never the whole 34px, which is a region
  iOS asks apps to keep *controls* out of, not a margin it requires.
- **`--toolbar-height` is measured from the bar itself** at runtime, and is the
  pill only.
- **`--content-inset` is the only place those two are added together**, and
  `.app-main` is the only thing that spends it. No screen adds a spacer of its
  own. `scroll-margin-bottom` uses the same number, so a control scrolled to the
  bottom edge mid-page also clears the pill.
- **The pill is sized by its contents**: `--tab-w` per destination, so a seventh
  widens the bar rather than wrapping onto a second row. Seven is what the bar
  carries between a draft completing and week one, when Matchup has arrived and
  Draft has not left; the bar publishes `data-count` and one rule narrows the
  destination below 400px. The floor is 44px and it is hard — a destination
  narrower than a fingertip is not a destination, and `toolbar.spec.ts` asserts
  it at every width.
- **The selected destination is a lift in the material, not a control inside
  one.** `--toolbar-bloom` is a whole radial gradient rather than a colour and
  an alpha, because Light and Dark want different falloffs as well as different
  strengths, and it is painted by the active destination's own `::before` — so
  it is always exactly where the destination is, with nothing to measure and
  nothing to keep in step. It reaches the pill's padding on every side and the
  capsule clips its descendants, so it ends where the bar does. No pill, no
  tray, no underline: a filled shape behind one destination is a button inside a
  button, and a hard edge is the thing the dash under the selection was removed
  for. The fact is carried four times over — the lift, the accent colour, a
  heavier glyph stroke, a heavier label — and by `aria-current` for anything
  that cannot see any of them.
- **It holds no state.** The current destination is passed in from the app, so
  the highlight and the screen can never disagree — including on a nested screen
  or a destination the app chose on its own.
- **It leaves while the keyboard is up.** iOS shrinks the visual viewport and
  not the layout one, so a correctly pinned bar would hover over the field being
  typed into; `src/web/viewport.ts` reads the difference.

## Where the numbers are asserted

- `e2e/toolbar.spec.ts` — the floating toolbar: destinations, route-derived
  active state, shape, targets, label wrapping, content clearance, keyboard,
  modal layering, reduced motion — and the selected state, which is the part
  with the most ways to go wrong quietly: that the lift belongs to exactly one
  destination, takes no taps, adds no words, ends at the pill's inner edge,
  draws something in *both* themes, moves nothing, and leaves the selected label
  room inside its own column at the heavier weight.
- `e2e/draft-controls.spec.ts` — the folded search beside the position filters:
  collapsed shape, control-row height, expansion, query semantics, and that the
  filters are untouched by any of it.
- `e2e/draft-card.spec.ts` — the player card, collapsed and expanded: where the
  tier-cliff warning sits, that it costs no height, that the metrics never wrap
  to make room for it, that it takes no tap meant for the card — and the
  expanded card's **height budget**, asserted as a ratio against the board's own
  collapsed rows rather than as a pixel count. An opened player rests at under
  three rows; everything the card stopped resting on is behind its one control,
  and the second test there proves it is still reachable.
- `e2e/row-alignment.spec.ts` — the row's columns, and its two actions: that the
  way in and the row's own control are siblings rather than one nested in the
  other, that the control is 44×44 and answers at every point inside it, that
  the mark has not moved off its slot or grown with its target, that neither
  action does the other's job by pointer or by key, and that the row is the
  height it was. `e2e-production/smoke.spec.ts` reads the structure and the
  geometry back off the deployed site, where the 28×28 was measured.
- `e2e/density.spec.ts` — the compact lists: players per screen, row-height floor
  and ceiling, that the position is a pill and neither a rail nor a wash, that no column
  truncates a value, that a trade suggestion is a row rather than a card, and
  that neither list nor any section of the player page scrolls sideways.
- `e2e/shell.spec.ts` — navigation-bar height and stickiness, density per screen,
  touch targets, no sideways scroll in either theme, theme parity, reduced
  motion.
- `e2e/navigation.spec.ts` — pushed screens, the back gesture and everything it
  must not do, sheets, and the browser's own navigation.
- `e2e/app.spec.ts`, `e2e/setup.spec.ts`, `e2e/pwa.spec.ts` — what the screens
  say and do. Unchanged by the visual pass, which is the point.
- `tests/gestures.test.ts` — the gesture thresholds, as arithmetic.
- `tests/viewport.test.ts` — the keyboard threshold, likewise.

## Before a UI change is merge-ready

`e2e-production/smoke.spec.ts` keeps its **own copies** of assertions that
`e2e/` also makes — the draft row's metrics, the Team lineup, the player page,
the shell. CI does not run it: `ci.yml` runs `e2e/`, and the production suite
runs only in `smoke.yml`, *after* a deploy. So a UI change that invalidates an
assertion in there is not caught by a green PR; it is caught by production going
red minutes after the merge.

That has happened twice. Both times the change was correct and the test was
describing a UI that no longer existed; the second time it was missed because a
grep for the removed word returned two docblock comments and read as "clean".

So: **any change to UI text, structure, navigation, a card, a metric or an
interaction must be run against both suites before merge, and searching is not
proof.** The production suite runs against a local build:

```
npm run build && node scripts/build-server.mjs
FA_SEED=1 FA_INSECURE_COOKIES=1 APP_PASSPHRASE=… SESSION_SECRET=…   node scripts/dev-server.mjs --port 8794 &
PRODUCTION_URL=http://127.0.0.1:8794   npx playwright test --config playwright.production.config.ts   --project=chromium-iphone-390 --project=chromium-small-360
```

Two of its tests fail against the demo seed and pass against real production —
the Team `Starter` assertion and the waiver-advice test. A local run showing
exactly those two is clean. A third failure is real.
