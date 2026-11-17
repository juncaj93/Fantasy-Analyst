# Design rules (Round 35)

Taken from the in-season Players card, the screen Alex says reads best
(`src/web/components/players2/seasonCard.tsx`, `players2.css`). Same colours
and fonts as today; the revamp tightens how they are used. Everything new
draws only with `UI_REVAMP` on (`data-ui="revamp"` on the page), in the last
block of `src/web/styles.css`.

## Type

| Role | Size / weight | Used for |
| --- | --- | --- |
| Big number | 1.9rem / 700, tabular | The one figure a surface is about: a card's projection, Matchup's scores, Compare's scores |
| Screen title | 1.18rem / 720 | The screen's own name in the top bar (Team, Matchup ...) |
| Row name | 0.97rem / 620 | A player's name on a row |
| Row number | 0.97rem / 700, tabular | The row's one number, right-aligned |
| Body | 0.95rem / 650 | The pick and its one reason |
| Secondary | 0.86rem / 400, dim | Season figure, "Updated 3:42 PM" |
| Label | 0.72rem / 700, uppercase, 0.03em, faint | Section headers, "This week", "Market" |

System font stack, as today. Numbers are always tabular. Compare keeps its
paper fonts.

## Spacing

4 / 8 / 12 / 16 (`--sp-1` to `--sp-4`). 12 between cards and sections, 8
inside a card, 4 between tiles. Sections open with a label 16 above, 8 below.

## Rows and cards

- A row is at least 44px: position pill, club mark, name, then the number on
  the right. Rows share one card and split on hairlines; no per-row boxes.
- A card is the page surface on the page grey: radius 12, the soft shadow,
  12 padding.
- Small figures sit in sunken tiles (`--surface-sunken`, radius 8, at least
  44px), side by side in equal columns, label over number.
- The pick, then one short reason, then a tap for the direct comparison.

## Chips and buttons

- Tags: 0.72rem / 700, radius 8, 1px 7px, tinted by meaning (green good,
  amber watch, red out, slate neutral). Colour never alone: the word is there.
- Bar actions are glyphs in the accent colour, no box. Setup's gear is dim.
- Buttons are at least 44px tall. Primary is the accent; secondary is sunken.

## Section headers and bars

- Every top bar is the same height and names its screen; what it is about
  (the league, the week) is the line under it. Actions on the right, the gear
  last. Pushed pages and Setup have Back on the left, labelled with where it
  goes.
- The tab bar carries the five game-day jobs. The current one sits on a crisp
  accent-tint pill with the accent label (not a soft glow, which was tried and
  read fuzzy).

## Colours in use

`--bg`, `--surface`, `--surface-sunken`, `--text`, `--text-dim`,
`--text-faint`, `--accent` / `--accent-text` / `--accent-tint`, `--pos`,
`--warn`, `--neg` and their tints, the position hues for pills only. Light
and dark are the same tokens. No new colours.

## Icons

24px line icons drawn in `components/icons.tsx` (stroke 2, 2.15 when
current), no emoji, no brand marks beyond club logos.

## Loading

Skeleton rows the height of the rows that replace them (44px), inside the
same card, so nothing jumps when data lands. No spinners, no "Loading..."
line.

## Part 2 (Round 36)

- **Waivers.** A pick is a card: pill, club, name, and the bid on the right
  in a tinted chip (`Waivers $9`, `Free agent`; green on Do this). One line
  under it: the gain in bold, the spot (`Drop: Priestley`, `Open spot`), one
  short reason. Stash, Cover and Block are the same card with the kind where
  the gain sits, and a tap opens Compare.
- **Trades.** An offer card: verdict and edge, Give and Get, one reason, then
  three sunken tiles (your week, your season, theirs). The Check result leads
  with the verdict word at the big-number size.
- **Players.** The board row's one number is the rest-of-season value, on the
  right; 7d, 30d and Pick under the name, who holds him at the end of that
  line. The column says "Value".
- **Setup.** Labelled sections instead of folds: League, News and lines,
  Health, App. Draft-only rows are not drawn (the new look draws only in
  season).
- **No explanatory sentences.** A help paragraph carries `blurb` (and a
  draft-only control `draft-only`); one rule hides both with the switch on.
  Labels, numbers, chips, tap reasons and errors stay. A sentence Alex needs
  becomes a label ("Closest to fair").
- **Empty and loading.** An empty answer is a quiet card where the rows would
  be. Loading draws placeholders the size of what lands (offer cards on
  Trades, 44px rows elsewhere).
- **Draft mode** keeps today's look while a draft is ahead.
<<<<<<< HEAD
- **Choosing players (Compare).** Picking never moves the list: a pick is a
  check on the row, and nothing above the list appears or grows. The one
  action is a bar fixed at the bottom: Compare, grey until two are picked,
  then green. The answer shows only on that tap; the X cancels and clears.
  (Alex's preview review, 17 November 2026.)
=======
>>>>>>> 61f28894ce878b45558e412b4e6bdaa5a9036609
