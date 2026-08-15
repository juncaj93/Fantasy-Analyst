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

## Tokens

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg` `--surface` `--surface-raised` `--surface-sunken` `--surface-inset` |
| Material | `--nav-surface` `--toolbar-surface` `--toolbar-border` `--blur` `--scrim` |
| Lines | `--separator` `--separator-soft` `--border-strong` |
| Text | `--text` `--text-dim` `--text-faint` |
| Semantic | `--accent` `--pos` `--neg` `--warn` and their `-tint` pairs |
| Injury | `.injury-caution` `.injury-serious` `.injury-out`, over `--status-neutral` |
| Position | `--pos-QB-line` / `--pos-QB-tint` … and `--pos-mix` for how much of it a card shows |
| State | `--selected` `--selected-tint` `--pressed` `--focus-ring` |
| Geometry | `--radius-sm: 8` `--radius: 12` `--radius-lg: 16` `--radius-sheet: 20` `--radius-toolbar: 25` `--radius-pill` `--tap: 44` |
| Spacing | `--sp-0: 2` `--sp-1: 4` `--sp-2: 8` `--sp-3: 12` `--sp-4: 16` `--sp-5: 20` `--sp-6: 24` |
| Motion | `--dur-fast: 120ms` `--dur: 220ms` `--dur-slow: 320ms` `--ease` |
| Elevation | `--shadow-1` `--shadow-2` `--shadow-sheet` `--shadow-toolbar` |
| Toolbar | `--tab-w: 52` (48 under 375px) `--toolbar-pad: 5` `--toolbar-height` (measured) `--toolbar-gap` |
| Device | `--safe-top` `--safe-bottom` `--nav-inset` `--content-inset` |

`--text-faint` is the quietest text allowed: it reads at 4.5:1 against both the
page and a card. Anything greyer looked calmer on a desk and vanished on a phone
in daylight.

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
| `Disclose` | Inline expand/collapse that animates height without mounting its children until it opens. |
| `PositionBadge` / `positionCardClass` | The position, as letters and as a card tint. |
| `CompactTally` / `SignedValue` / `Signal` | The research tally at three levels of loudness. |
| `Badge` / tags / `Confidence` | Status pills, ranked by how much attention each state deserves. |

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
  would widen the bar rather than wrap onto a second row.
- **It holds no state.** The current destination is passed in from the app, so
  the highlight and the screen can never disagree — including on a nested screen
  or a destination the app chose on its own.
- **It leaves while the keyboard is up.** iOS shrinks the visual viewport and
  not the layout one, so a correctly pinned bar would hover over the field being
  typed into; `src/web/viewport.ts` reads the difference.

## Where the numbers are asserted

- `e2e/toolbar.spec.ts` — the floating toolbar: destinations, route-derived
  active state, shape, targets, label wrapping, content clearance, keyboard,
  modal layering, reduced motion.
- `e2e/draft-controls.spec.ts` — the folded search beside the position filters:
  collapsed shape, control-row height, expansion, query semantics, and that the
  filters are untouched by any of it.
- `e2e/shell.spec.ts` — navigation-bar height and stickiness, density per screen,
  touch targets, no sideways scroll in either theme, theme parity, reduced
  motion.
- `e2e/navigation.spec.ts` — pushed screens, the back gesture and everything it
  must not do, sheets, and the browser's own navigation.
- `e2e/app.spec.ts`, `e2e/setup.spec.ts`, `e2e/pwa.spec.ts` — what the screens
  say and do. Unchanged by the visual pass, which is the point.
- `tests/gestures.test.ts` — the gesture thresholds, as arithmetic.
- `tests/viewport.test.ts` — the keyboard threshold, likewise.
