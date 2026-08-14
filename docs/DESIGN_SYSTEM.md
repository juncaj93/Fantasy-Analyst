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
| Material | `--nav-surface` `--tabbar-surface` `--blur` `--scrim` |
| Lines | `--separator` `--separator-soft` `--border-strong` |
| Text | `--text` `--text-dim` `--text-faint` |
| Semantic | `--accent` `--pos` `--neg` `--warn` and their `-tint` pairs |
| Injury | `.injury-caution` `.injury-serious` `.injury-out` |
| Position | `--pos-QB-line` / `--pos-QB-tint` … and `--pos-mix` for how much of it a card shows |
| State | `--selected` `--selected-tint` `--pressed` `--focus-ring` |
| Geometry | `--radius-sm: 8` `--radius: 12` `--radius-lg: 16` `--radius-sheet: 20` `--radius-pill` `--tap: 44` |
| Spacing | `--sp-0: 2` `--sp-1: 4` `--sp-2: 8` `--sp-3: 12` `--sp-4: 16` `--sp-5: 20` `--sp-6: 24` |
| Motion | `--dur-fast: 120ms` `--dur: 220ms` `--dur-slow: 320ms` `--ease` |
| Device | `--safe-top` `--safe-bottom` `--nav-inset` `--tabbar-height` |

`--text-faint` is the quietest text allowed: it reads at 4.5:1 against both the
page and a card. Anything greyer looked calmer on a desk and vanished on a phone
in daylight.

## Primitives

| Component | What it is |
| --- | --- |
| `NavBar` | A compact, sticky navigation bar: title, one line qualifying it, the screen's actions. Never a hero header. |
| `BackButton` / `PushScreen` | A pushed detail screen and its Back control, plus the edge-swipe gesture where the platform allows it (see [IOS_WEB_APP.md §9](./IOS_WEB_APP.md)). |
| `ListGroup` / `ListRow` | The grouped list: one surface, rows divided by hairlines, trailing value and chevron. |
| `SegmentedControl` | Two to seven exclusive modes on a sunken track; the selected one is raised, not filled. |
| `SearchField` | Magnifier, compact field, clear control that appears only when there is something to clear. |
| `Sheet` | A modal sheet: rounded top, grab handle, dimmed backdrop, swipe-to-dismiss, and a Done control because a gesture is never the only way out. |
| `SkeletonRows` | Loading at the shape of what is coming, so the page does not jump when it lands. |
| `Disclose` | Inline expand/collapse that animates height without mounting its children until it opens. |
| `PositionBadge` / `positionCardClass` | The position, as letters and as a card tint. |
| `CompactTally` / `SignedValue` / `Signal` | The research tally at three levels of loudness. |
| `Badge` / tags / `Confidence` | Status pills, ranked by how much attention each state deserves. |

## Where the numbers are asserted

- `e2e/shell.spec.ts` — navigation-bar height and stickiness, density per screen,
  touch targets, no sideways scroll in either theme, theme parity, reduced
  motion.
- `e2e/navigation.spec.ts` — pushed screens, the back gesture and everything it
  must not do, sheets, and the browser's own navigation.
- `e2e/app.spec.ts`, `e2e/setup.spec.ts`, `e2e/pwa.spec.ts` — what the screens
  say and do. Unchanged by the visual pass, which is the point.
- `tests/gestures.test.ts` — the gesture thresholds, as arithmetic.
