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

/** Review: a queue of decisions, ticked off. */
export function ReviewIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M3.75 6.5h7M3.75 12h7M3.75 17.5h5.5" />
      <path d="m14 12.6 2.6 2.6 4.4-5" />
    </svg>
  );
}

/** Setup: the settings gear, drawn as a simple cog. */
export function GearIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.2a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.94 1.94 0 1 1-3.89 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97h-.17a1.94 1.94 0 1 1 0-3.89h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.46v-.17a1.94 1.94 0 1 1 3.89 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.46.97h.17a1.94 1.94 0 1 1 0 3.89h-.09a1.6 1.6 0 0 0-1.46.97Z" />
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
