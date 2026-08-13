# UI, UX, and Quality Bar

## Primary device

iPhone Safari portrait.

Design first for approximately:

- 390px
- 375px
- 360px

Desktop can be functional but is secondary.

## Main navigation

Keep navigation compact.

Suggested screens:

1. Draft
2. Team
3. Players
4. Review

During season, Draft can become less prominent.

## Draft screen

Above the fold:

- current pick state
- picks until user
- top recommendations

Each player row/card should prioritize:

- name
- position/team
- ADP
- value
- news signal
- survival estimate

Tap for explanation.

Do not overload the main board.

## Players screen

Searchable player intelligence.

Show:

- raw tally
- recent tally
- positive count
- negative count
- evidence categories
- evidence timeline

## Review screen

For uncertain newsletter processing.

Should be extremely fast to resolve.

Swipe or tap actions are fine, but do not hide essential meaning behind gesture-only controls.

## Team screen

Season mode:

- roster
- current starters
- bench
- decision flags
- start/sit compare

## Visual direction

- compact
- clean
- information-dense without spreadsheet ugliness
- strong hierarchy
- avoid dashboard filler
- avoid decorative cards with little information
- use color as a secondary signal, never the only signal

## Accessibility

- large enough touch targets
- readable text
- no color-only positive/negative state
- good contrast
- support system font scaling reasonably

## Tests

### Unit

- player normalization
- alias matching
- ADP import
- signal aggregation
- newsletter rules
- negation
- mixed evidence
- scoring components
- Vegas normalization

### Integration

- Sleeper league sync
- draft sync
- duplicate newsletter processing
- prop snapshot caching

### Browser

WebKit sizes:

- 390x844
- 375x812
- 360x800

Flows:

- select league
- import ADP
- watch draft update
- open recommendation
- review newsletter evidence
- compare start/sit
- degraded state with missing Vegas data
