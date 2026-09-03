/**
 * The app's glyphs, drawn rather than typed.
 *
 * These were text characters — `◈`, `⌕`, `✓`, `⚙` — and text characters are at
 * the mercy of whatever font the platform decides they belong to. On a phone
 * two of the six were being resolved to colour emoji: a blue gear and a green
 * tick sat in a row of grey ones, at a different weight and a different size,
 * and no amount of CSS could reach inside them. A drawn glyph inherits the
 * colour of the thing it is in, keeps its weight when the tab is selected, and
 * is the same shape on every device.
 *
 * They are deliberately generic shapes — a board, a roster, an exchange, a
 * magnifier, a tick, a gear — drawn here from scratch. No platform icon set is
 * copied or shipped.
 */

interface IconProps {
  /** Size in px. The tab bar and the list rows want different ones. */
  size?: number;
  className?: string;
}

/** Shared geometry: one stroke weight, round joins, no fill. */
function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
}

/** Draft: a ranked board. */
export function BoardIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="3.25" y="3.75" width="17.5" height="16.5" rx="4" />
      <path d="M7.5 9h9M7.5 12.5h6.5M7.5 16h4.5" />
    </svg>
  );
}

/**
 * The draft board itself: a grid of picks.
 *
 * Deliberately not {@link BoardIcon}, which is the Draft *tab* and is drawn as a
 * ranked list. This is the same board a fantasy drafter tapes to a wall —
 * rounds down, managers across — so the control that opens one looks like one.
 */
export function GridIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="3.25" y="3.75" width="17.5" height="16.5" rx="3.2" />
      <path d="M3.25 9.25h17.5M3.25 14.75h17.5M9.25 3.75v16.5M14.75 3.75v16.5" />
    </svg>
  );
}

/** Board: grow the cells to fit a name. Four arrows pushing outwards. */
export function ExpandIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2}>
      <path d="M9.5 4.5h-5v5M14.5 19.5h5v-5M19.5 9.5v-5h-5M4.5 14.5v5h5" />
    </svg>
  );
}

/** Board: back to positions only. The same four arrows, pulling in. */
export function CompressIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2}>
      <path d="M4.5 9.5h5v-5M19.5 14.5h-5v5M14.5 4.5v5h5M9.5 19.5v-5h-5" />
    </svg>
  );
}

/** Close: the same weight as the other glyphs, rather than a text ✕. */
export function CloseIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2.2}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

/** Team: a roster of people. */
export function RosterIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="9.5" cy="8" r="3.25" />
      <path d="M3.75 19.25c0-3.2 2.58-5.25 5.75-5.25s5.75 2.05 5.75 5.25" />
      <path d="M16.25 5.4a3 3 0 0 1 0 5.7M17.6 14.4c1.68.63 2.9 2.1 2.9 4.35" />
    </svg>
  );
}

/** Trades: two players moving the other way. */
export function TradeIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M4 8.5h13M13.5 5 17 8.5 13.5 12" />
      <path d="M20 15.5H7M10.5 12 7 15.5 10.5 19" />
    </svg>
  );
}

/** Players: search. */
export function SearchIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.6 15.6 4.15 4.15" />
    </svg>
  );
}

/**
 * Waivers: a player joining a list.
 *
 * Deliberately a *different* shape from Trades, which is two players crossing.
 * A claim is one-way — somebody comes in off the pool — and at 24px in a row of
 * six marks the difference between one arrow and two is the whole of what makes
 * a tab bar readable at a glance.
 */
export function WaiverIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M4 6.5h9M4 12h9M4 17.5h6" />
      <path d="M18 8.5v7M14.75 12h6.5" />
    </svg>
  );
}

/**
 * Matchup: two lineups facing each other across a divider.
 *
 * Still not a shield, a trophy or a football — every other mark in this bar is
 * a shape rather than a picture, and at 22px a football is a brown oval that
 * reads as a full stop.
 *
 * **This replaced `VS` in a ring, and the ring is why.** Two letters inside a
 * closed circle is a different kind of mark from everything beside it: the
 * other seven are open outlines that say what a screen is *about*, and a coin
 * with a wordmark stamped on it reads as a badge dropped into the row. It was
 * also the only glyph in the bar carrying text, which is the thing this file
 * exists to avoid — drawn letters are still letterforms, and a letterform has
 * to survive a weight change that a stroke drawing simply scales through.
 *
 * What is here instead is a bracket on each side, spine inwards, arms fanning
 * out — the shape a tournament draw uses for the two halves of a tie — with a
 * quiet centre line between them. Three strokes, all open, all in the same
 * rounded grammar as its neighbours, and the relationship rather than the word
 * for it: two sides, facing, with something between them to be settled.
 *
 * Deliberately not {@link TradeIcon}, which is two arrows crossing. A trade is
 * an exchange *between* the sides and points both ways; a matchup is the sides
 * held apart, and nothing in this glyph moves.
 *
 * The footprint is 16.6 across and 13 tall, against the draft board's 17.5 by
 * 16.5 and the roster's 16.75 by 14 — the family's width, and a little under
 * its height, which is what a pair of brackets wants: taller and they stop
 * being brackets and start being two frames with a line between them.
 * `toolbar.spec.ts` measures the rendered ink against Team and Waivers rather
 * than trusting these numbers, because what the eye compares is what the
 * browser drew at 22px and not what the viewBox says.
 *
 * Nothing here is sized off the stroke, so selecting the tab — which redraws
 * every glyph at `stroke-width: 2.15` — thickens all three marks at once and
 * the air either side of the centre line narrows in proportion rather than
 * closing. That gap is the one thing in this drawing that a heavier weight
 * could shut, so it is asserted at both weights.
 */
export function MatchupIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M3.7 5.5h4.5v13H3.7" />
      <path d="M20.3 5.5h-4.5v13h4.5" />
      <path d="M12 8.6v6.8" />
    </svg>
  );
}

/*
 * There is no Review glyph, because there is no Review destination.
 *
 * It was a list with a tick beside it and it was drawn for one place: the
 * toolbar. Review is maintenance and lives in Settings now, as a row whose
 * leading mark is the shared state glyph every other settings row uses — so the
 * queue is still one tap from the bar and nothing in this file draws it. Every
 * icon here is on screen somewhere, which is the only reason a file of hand-set
 * paths stays worth reading.
 */

/** Setup: the settings gear, drawn as a simple cog. */
export function GearIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.2a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.94 1.94 0 1 1-3.89 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97h-.17a1.94 1.94 0 1 1 0-3.89h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.46v-.17a1.94 1.94 0 1 1 3.89 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.46.97h.17a1.94 1.94 0 1 1 0 3.89h-.09a1.6 1.6 0 0 0-1.46.97Z" />
    </svg>
  );
}

/*
 * Light and Dark, as the two things everybody already draws them as.
 *
 * They sit beside {@link GearIcon} in the Setup bar, where the gear is not the
 * tab's glyph but the third appearance — "whatever this phone is set to". Three
 * shapes rather than three words because the control is in a navigation bar and
 * the words were costing a section of the screen underneath it; what each one
 * means is on the button as an `aria-label`, which is the only place a shape
 * can honestly be explained.
 */

/** Light: a sun. */
export function SunIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="12" r="4.1" />
      <path d="M12 2.6v2.3M12 19.1v2.3M4.35 4.35l1.63 1.63M18.02 18.02l1.63 1.63M2.6 12h2.3M19.1 12h2.3M4.35 19.65l1.63-1.63M18.02 5.98l1.63-1.63" />
    </svg>
  );
}

/**
 * Dark: a crescent.
 *
 * One closed path rather than a circle with a circle knocked out of it, because
 * these glyphs are stroked and not filled — a mask would draw the bite as a
 * second outline sitting inside the first.
 */
export function MoonIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M20.1 14.6A8.4 8.4 0 0 1 9.4 3.9a8.4 8.4 0 1 0 10.7 10.7Z" />
    </svg>
  );
}

/* ------------------------------------------------------ the Settings glyphs */

/*
 * One glyph per row, and one per group, on the Settings screen.
 *
 * A settings list is the one screen in this app where every line is a different
 * *kind* of thing — a connection, an import, a preference, a diagnostic — and a
 * column of identical text is the hardest possible way to find the one you came
 * for. A leading shape is what makes it scannable: the reader looks for the
 * envelope rather than reading five labels.
 *
 * They are drawn to the same rule as everything above — one stroke weight,
 * round joins, no fill, no platform icon set copied — and they are deliberately
 * the most ordinary shape for each idea. A settings glyph that needs learning
 * has failed at the only thing it is for.
 */

/** Data, as a group: a stack of records. */
export function DatabaseIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
    </svg>
  );
}

/** App behavior, as a group: the controls that tune it. */
export function SlidersIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2.2" />
      <circle cx="10" cy="16" r="2.2" />
    </svg>
  );
}

/** Account & support, as a group: the ring you are thrown when something sinks. */
export function LifebuoyIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5" />
    </svg>
  );
}

/** A connection to somewhere else: two links of a chain. */
export function LinkIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M10 13.5a3.6 3.6 0 0 0 5.3.4l2.6-2.6a3.65 3.65 0 0 0-5.16-5.16l-1.5 1.49" />
      <path d="M14 10.5a3.6 3.6 0 0 0-5.3-.4l-2.6 2.6a3.65 3.65 0 0 0 5.16 5.16l1.49-1.49" />
    </svg>
  );
}

/** The newsletter: an envelope. */
export function MailIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="2.75" y="5" width="18.5" height="14" rx="3" />
      <path d="m3.5 7.5 7.36 5.15a2 2 0 0 0 2.28 0L20.5 7.5" />
    </svg>
  );
}

/** A market price, moving: the line the book is quoting. */
export function TrendIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M3.5 16.5 9 11l3.5 3.5L20 7" />
      <path d="M15.5 7H20v4.5" />
    </svg>
  );
}

/** A projection, stored: bars of it. */
export function ChartIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M3.5 20.5h17" />
      <path d="M7 20.5v-6M12 20.5V6.5M17 20.5v-9" />
    </svg>
  );
}

/** What the app knows about one player: a card with a face and two lines. */
export function IdCardIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="3" />
      <circle cx="8.5" cy="11" r="2.1" />
      <path d="M5.2 16.3a3.6 3.6 0 0 1 6.6 0M14.5 10h4M14.5 14h4" />
    </svg>
  );
}

/** A queue of decisions waiting: a list with a tick against it. */
export function ChecklistIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M10 7h9.5M10 12h9.5M10 17h6" />
      <path d="m4 6.6 1.5 1.6L8 5.6" />
      <path d="M4.2 12h2.6M4.2 17h2.6" />
    </svg>
  );
}

/** A repair: the spanner. */
export function WrenchIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M15.2 3.5a5.5 5.5 0 0 0-4.62 8.44L3.9 18.6a2 2 0 0 0 2.83 2.83l6.66-6.66A5.5 5.5 0 0 0 20.2 8.2l-2.9 2.9-2.4-2.4 2.9-2.9a5.5 5.5 0 0 0-2.6-2.3Z" />
    </svg>
  );
}

/** Whether the inputs are alive: a trace with a beat in it. */
export function PulseIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M2.75 12.5h4l2-5.5 3.5 10 2.5-6 1.6 3h4.9" />
    </svg>
  );
}

/** How much your own research weighs against the market: a balance. */
export function ScalesIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M12 4.5v15M7 20h10M4.5 8h15" />
      <path d="M4.5 8 2 14h5ZM19.5 8 17 14h5Z" />
    </svg>
  );
}

/** Which recommendation a snapshot would be of: the thing being aimed at. */
export function TargetIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="0.9" />
    </svg>
  );
}

/** Taking the state away with you: a clipboard. */
export function ClipboardIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M9 4.75H7a2.25 2.25 0 0 0-2.25 2.25v12A2.25 2.25 0 0 0 7 21.25h10a2.25 2.25 0 0 0 2.25-2.25V7A2.25 2.25 0 0 0 17 4.75h-2" />
      <rect x="9" y="2.75" width="6" height="4" rx="1.4" />
    </svg>
  );
}

/**
 * The mark on a control that opens in place: a chevron, pointing at what it does.
 *
 * The last three `▾` in this app were here — the two benches and the generic
 * fold — and a text character is exactly what this file exists to stop. On a
 * phone the platform is free to resolve one to whatever font it likes, at
 * whatever weight and size, next to a column of drawn glyphs that have already
 * agreed on both; the fix for a gear was the fix for a triangle.
 *
 * Rotated rather than swapped for a second shape, so the transition between the
 * two states is a movement instead of a substitution — the same chevron the
 * pushed rows use, turned to face the way this one goes.
 */
export function DisclosureChevronIcon({ open, size = 15 }: IconProps & { open: boolean }) {
  return (
    <svg
      {...svgProps(size)}
      strokeWidth={2.4}
      style={{ transform: `rotate(${open ? -90 : 90}deg)`, transition: 'transform var(--dur-fast) var(--ease)' }}
    >
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </svg>
  );
}

/** The trailing mark on a row that leads somewhere. */
export function ChevronIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2.4}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </svg>
  );
}

/**
 * A control that opens a menu.
 *
 * The same chevron, pointing down. It replaced a board grid on the Draft
 * header: that glyph was honest while the button opened the board directly and
 * became a lie the moment it started opening a choice of three, because an icon
 * that draws its destination promises to go there. A chevron promises only that
 * something will unfold, which is what the button now does.
 */
export function MenuChevronIcon({ size = 19, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2.4}>
      <path d="M5.5 9.25 12 15.75l6.5-6.5" />
    </svg>
  );
}

/** Back: the same chevron, pointing the other way. */
export function BackChevronIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2.4}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}

/** A finished setup step. */
export function CheckCircleIcon({ size = 17, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="m8 12.3 2.7 2.7L16 9.5" />
    </svg>
  );
}

/** A step that needs attention. */
export function AlertCircleIcon({ size = 17, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.75v5M12 16.1v.1" />
    </svg>
  );
}

/** A step nobody has done yet. */
export function EmptyCircleIcon({ size = 17, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.75" />
    </svg>
  );
}

/** Add to Home Screen, on the one-time prompt. */
export function InstallIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M12 15.5V4.25M8.5 7.5 12 4l3.5 3.5" />
      <path d="M5 13.5v4.75a1.75 1.75 0 0 0 1.75 1.75h10.5A1.75 1.75 0 0 0 19 18.25V13.5" />
    </svg>
  );
}
