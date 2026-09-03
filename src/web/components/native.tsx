/**
 * The native-feeling shell primitives: navigation bars, grouped lists,
 * segmented controls, search, sheets and pushed screens.
 *
 * These exist so that "what a screen looks like" is answered once. Draft,
 * Players, Trades, Team, Review and Setup are six different questions with six
 * different sets of numbers, and they should not also be six different opinions
 * about how a title, a row or a back gesture works.
 *
 * Nothing here knows anything about fantasy football. A component in this file
 * may not fetch, compute, rank or decide — it arranges what it is handed.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissesSheet, useEdgeSwipeBack, usePullToRefresh, useStandaloneMode } from '../gestures.ts';
import { useOverlay } from '../overlay.ts';
import { useKeyboardInset } from '../viewport.ts';
import { BackChevronIcon, ChevronIcon } from './icons.tsx';

/* ---------------------------------------------------------- navigation bar */

/**
 * The page's identity and its actions, in one compact bar.
 *
 * Deliberately not a hero header: a title line, whatever qualifies it, and the
 * one or two controls that belong to this screen. It sticks to the top so that
 * on a long list the answer to "where am I, and whose turn is it" never scrolls
 * away.
 */
export function NavBar({
  title,
  subtitle,
  leading,
  trailing,
  content,
  testId,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /**
   * A control that *is* the bar, in place of a title.
   *
   * One screen needs this: a list whose whole purpose is searching it. iOS puts
   * the search field in the bar there rather than under a title that repeats
   * the tab you just tapped, and doing the same is worth a row of players on
   * every phone.
   */
  content?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="nav-bar" data-testid={testId ?? 'nav-bar'}>
      {leading}
      {content ?? (
        <div className="nav-title-wrap">
          <div className="nav-title">{title}</div>
          {subtitle ? <div className="nav-subtitle">{subtitle}</div> : null}
        </div>
      )}
      {trailing ? <div className="nav-actions">{trailing}</div> : null}
    </div>
  );
}

/**
 * Back: a chevron and where it goes.
 *
 * It is navigation and only navigation. Nothing behind it is undone, reverted
 * or un-saved by pressing it — the same rule the swipe gesture inherits, since
 * the gesture calls this component's own handler.
 */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="nav-back" onClick={onClick} data-testid="back-button">
      <BackChevronIcon />
      {label}
    </button>
  );
}

/* --------------------------------------------------------------- push screen */

/**
 * A detail screen pushed on top of a list, and the gesture that leaves it.
 *
 * The gesture is offered only where the platform is not already using the
 * screen edge for its own back navigation — that is, in a Home Screen app and
 * not in a Safari tab. In a tab this is an ordinary screen with a Back control
 * and the browser's own edge gesture continues to work exactly as it always
 * did; nothing here calls `preventDefault` on a touch, anywhere.
 */
export function PushScreen({
  title,
  subtitle,
  backLabel,
  onBack,
  trailing,
  children,
  testId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  backLabel: string;
  onBack: () => void;
  trailing?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const standalone = useStandaloneMode();
  const swipe = useEdgeSwipeBack({ enabled: standalone, onBack });

  return (
    <>
      {standalone ? <div className="push-dim" ref={swipe.dimRef} style={{ opacity: 0 }} aria-hidden="true" /> : null}
      <div
        className="push-layer"
        ref={swipe.layerRef}
        data-testid={testId ?? 'push-screen'}
        data-swipe-back={standalone ? 'on' : 'off'}
        {...(standalone ? swipe.handlers : {})}
      >
        <NavBar
          title={title}
          {...(subtitle === undefined ? {} : { subtitle })}
          leading={<BackButton label={backLabel} onClick={onBack} />}
          {...(trailing === undefined ? {} : { trailing })}
        />
        {children}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ grouped lists */

/** A grouped list: one surface, rows divided by hairlines. */
export function ListGroup({
  children,
  header,
  footer,
  testId,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <>
      {header ? <div className="section-title">{header}</div> : null}
      <div className="list-group" data-testid={testId}>
        {children}
      </div>
      {footer ? <div className="faint" style={{ margin: '-4px 4px 12px' }}>{footer}</div> : null}
    </>
  );
}

/**
 * One row of a grouped list.
 *
 * Leading state, a label, a value on the trailing edge and a chevron when the
 * row leads somewhere — the shape a reader has seen in every settings screen
 * they have ever used, which is the entire argument for it.
 */
export function ListRow({
  label,
  detail,
  value,
  state,
  chevron,
  onClick,
  expanded,
  testId,
  dataState,
}: {
  label: ReactNode;
  detail?: ReactNode;
  value?: ReactNode;
  state?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  testId?: string;
  dataState?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={onClick ? 'list-row' : 'list-row list-row-static'}
      data-testid={testId}
      data-state={dataState}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
    >
      {state ? <span className="list-state">{state}</span> : null}
      <span className="list-row-body">
        <span className="list-row-label">{label}</span>
        {detail ? <span className="list-row-detail">{detail}</span> : null}
      </span>
      {value ? <span className="list-row-value">{value}</span> : null}
      {chevron ? (
        <span className="list-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      ) : null}
    </Tag>
  );
}

/* ------------------------------------------------------- segmented control */

export interface Segment<T extends string> {
  id: T;
  label: ReactNode;
  /** Only where the visible label is not a good accessible name on its own. */
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

/**
 * Two to seven exclusive modes, on one track.
 *
 * The selected segment is raised rather than filled, which is what keeps a row
 * of seven from shouting on a phone. It scrolls sideways when there are more
 * than fit; the choice logic is entirely the caller's — this control decides
 * nothing.
 *
 * **The button and the pill you can see are deliberately different sizes.** The
 * segment is a full 44px tap target; the tinted face inside it is 36px, which
 * is what a segmented control should look like sitting next to a search field.
 * Painting the button itself would force the row to be as tall as a thumb, and
 * that row is on the screen where every pixel is a fraction of a player.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  testId,
  compact = false,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  testId?: string;
  /**
   * Tighter type and tighter padding, for a control that has to share its row.
   *
   * **The tap target is not what shrinks.** The button stays 44px tall and the
   * pill inside it loses a few points of horizontal padding, which is the only
   * part of a segmented control that can be given up without giving up a thumb.
   * See the stylesheet: `.filter-row-compact` touches padding and type size and
   * nothing else.
   */
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'filter-row filter-row-compact' : 'filter-row'}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {segments.map((s) => (
        <button
          key={s.id}
          type="button"
          className={s.className ? `chip ${s.className}` : 'chip'}
          aria-pressed={value === s.id}
          {...(s.ariaLabel ? { 'aria-label': s.ariaLabel } : {})}
          {...(s.testId ? { 'data-testid': s.testId } : {})}
          onClick={() => onChange(s.id)}
        >
          <span className="chip-face">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- search */

/**
 * A search field with a magnifier and a clear control.
 *
 * The clear control exists only while there is something to clear, and clearing
 * is exactly that — it empties the field and nothing else. What the query then
 * matches, and in what order, is entirely the caller's business.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
  testId?: string;
}) {
  return (
    <div className="search">
      <ChevronlessSearchIcon />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        data-testid={testId}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          data-testid="search-clear"
          onClick={() => onChange('')}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** The magnifier, at field size. Kept separate so the field stays readable. */
function ChevronlessSearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.6 15.6 4.15 4.15" />
    </svg>
  );
}

/**
 * Search and the filters, on one row, with the search folded away until asked
 * for.
 *
 * A permanently open search field is a whole row of a phone spent on a control
 * that is used a few times a draft, sitting directly above the list it is
 * about — and on the one screen where a row is a player, that is the most
 * expensive row on the page. Collapsed, it is a glyph on the left of the
 * filters, which is where iOS puts it in a toolbar; expanded, it takes the row
 * and the filters step aside, which is what iOS does to a list's own search.
 *
 * **Presentation only.** What the query matches, how the filters behave and what
 * either does to the list are entirely the caller's; this component holds the
 * text and the open/closed state and nothing else. Closing is deliberately the
 * one thing that also clears — that is what a control labelled Cancel means,
 * and it is the only way the text can go away, so it can never be dropped
 * quietly.
 */
export function SearchFilterRow({
  value,
  onChange,
  expanded,
  onExpandedChange,
  placeholder,
  label,
  testId,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  placeholder: string;
  /** The accessible name of both the field and the button that opens it. */
  label: string;
  testId: string;
  /** The filters, shown beside the glyph while the search is folded away. */
  children: ReactNode;
}) {
  const close = () => {
    onChange('');
    onExpandedChange(false);
  };

  if (!expanded) {
    return (
      <div className="control-row" data-testid={`${testId}-controls`} data-search="closed">
        <button
          type="button"
          className="search-toggle"
          aria-label={label}
          aria-expanded={false}
          data-testid={`${testId}-open`}
          onClick={() => onExpandedChange(true)}
        >
          <ChevronlessSearchIcon />
        </button>
        {children}
      </div>
    );
  }

  return (
    <div className="control-row" data-testid={`${testId}-controls`} data-search="open">
      <div className="search search-inline">
        <ChevronlessSearchIcon />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
          placeholder={placeholder}
          aria-label={label}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          /*
           * Focused on arrival, and by the attribute rather than an effect: React
           * calls `focus()` during the commit that the tap itself triggered, so
           * Safari still counts it as user-initiated and actually raises the
           * keyboard. A focus deferred to a later frame is one iOS ignores.
           */
          autoFocus
          data-testid={testId}
        />
        {value ? (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            data-testid="search-clear"
            /* Empties the field and leaves it open, focused and ready — the
               way every native list search behaves. Leaving is Cancel's job. */
            onClick={() => onChange('')}
          >
            ✕
          </button>
        ) : null}
      </div>
      <button type="button" className="search-cancel" data-testid={`${testId}-close`} onClick={close}>
        Cancel
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------- sheets */

/**
 * A modal sheet.
 *
 * Rises from the bottom, dims what is behind it, and can be pulled back down
 * from anywhere on it — the grip, the header, or the middle of what you are
 * reading, as long as that content is already at its top. Escape, a tap above
 * it and Done close it too, because a gesture must never be the only way out of
 * anything.
 *
 * Everything a covering layer owes the app — the page behind held still, the
 * app behind taken out of the reading order, focus in and focus back, Escape
 * reaching the top layer and no other — belongs to `useOverlay` and is
 * identical here, on the draft board, and on anything added later.
 *
 * **There is no dismiss gesture in this file, and none in `gestures.ts`
 * either.** The layer is a scroller whose two ends are the card in place and
 * the card gone, so pulling it down is a scroll and the engine does all of it:
 * the tracking, the momentum, the snap back from a drag too small to count, and
 * the reader's ability to catch it halfway and change their mind. What is left
 * here is the arrangement of a grip, a title and a body, one scroll to open and
 * one observer to notice it has been closed. See `.sheet-scroller` in the
 * stylesheet for why, and for the two mechanisms this replaced.
 *
 * Nothing destructive is ever put in one of these: a sheet that can be flicked
 * away is for reference and for choices that can be made again.
 */
export function Sheet({
  title,
  accessibleLabel,
  onClose,
  children,
  testId,
}: {
  title: ReactNode;
  /**
   * What the dialog is *called*, when what it is *headed* by cannot be read.
   *
   * A modal owes assistive technology a name, and the name a sheet has always
   * used is its visible title — which works exactly as long as that title is a
   * string. The player card's is not: it is a cluster of a position pill, a
   * club mark, a name and an injury tag, because that is the identity grammar
   * every row in the app uses and the expanded card is the same object. So the
   * one sheet a reader opens most often announced itself as an unnamed dialog:
   * they arrived inside a modal without being told whose card had opened.
   *
   * Hence a string beside the title rather than a rule about the title. The
   * default below is unchanged and still covers every sheet headed by plain
   * words; a caller whose heading is composed passes the words it composes.
   * Give it the subject and nothing else — a name is what the dialog is, not a
   * summary of what is in it.
   */
  accessibleLabel?: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const { lift } = useOverlay({ container: surface, onDismiss: onClose });
  /*
   * The latest `onClose`, for an observer that is attached once.
   *
   * The observer must outlive re-renders — re-attaching it on every one would
   * make it fire again on whatever the layer happened to be doing at the time —
   * so it closes over this rather than over the prop.
   */
  const onDismiss = useRef(onClose);
  onDismiss.current = onClose;
  /*
   * The keyboard, and the room it takes.
   *
   * A sheet is pinned to the bottom of the *layout* viewport, and iOS does not
   * shrink that for the keyboard — it shrinks the visual one. So a sheet with a
   * field in it, which is two of Setup's, drew its own action button underneath
   * the keyboard the moment the reader tapped into the box: visible in a
   * screenshot, unreachable by a thumb. The inset shortens the scroller, and
   * every percentage in the layer resolves against that box, so the card comes
   * up with it. Nought on anything without a software keyboard, which is every
   * browser this app is tested in.
   */
  const keyboard = useKeyboardInset();

  /*
   * Opening puts the layer at the card's detent, in one step and before paint.
   *
   * **The card's position is simply the bottom of the layer**, which is why this
   * needs no measuring: the zone above the card is one screen and the card's own
   * box is one screen less the gap, so the furthest this box scrolls *is* where
   * the card belongs.
   *
   * **Instant, and the rise is a keyframe rather than a smooth scroll.** Putting
   * the card in place by animating this scroll looks like the obvious way to do
   * the entrance, and it fights whatever else is steering the box — it did so
   * visibly against a mandatory snap, where the two corrected each other and the
   * layer never settled. Playwright's word for what that does to anything inside
   * the card is *not stable*, which it stayed for thirty seconds; a reader's
   * word for it would be less kind.
   *
   * So the two are kept apart. The scroll is a position, set once with nothing
   * animating it, and the entrance is an animation on the card that moves no
   * scroller at all. Reduced motion is honoured by the stylesheet, where the
   * rest of this app's motion is already answered.
   */
  useLayoutEffect(() => {
    const root = scroller.current;
    if (root) root.scrollTop = root.scrollHeight;
  }, []);

  /*
   * Where the layer comes to rest, decided once, when it stops moving.
   *
   * The engine still owns the part that has to feel right — the card tracks the
   * finger, carries its momentum, rubber-bands, and can be caught halfway and
   * sent back — and this owns only the question the engine answers badly: given
   * that the reader has stopped, does the card stay or go?
   *
   * **`scroll-snap` was supposed to answer it and cannot.** Both settings were
   * measured on the layer, in WebKit, at the sizes this app runs at:
   *
   *  - `mandatory` advances a whole snap step whatever the scroll's size, so a
   *    ten-pixel nudge threw the card away — a sheet that cannot survive being
   *    brushed;
   *  - `proximity` moves proportionally and then never settles, leaving the card
   *    parked ten, forty, a hundred pixels down the screen.
   *
   * Neither is a resting place worth having, so the resting places are named
   * here instead: the card in place, or the card gone, and nothing between.
   *
   * **How far is not on its own enough, and that is the complaint this answers.**
   * A distance is all a scroll leaves behind once it has stopped, so a card
   * pushed slowly and uncertainly to the middle of the screen and one thrown
   * there arrived at the same place and were read the same way: measured on the
   * widest phone, a pull taking two and a half seconds to travel half the layer
   * dismissed the card exactly as a pull taking a sixth of a second did. A
   * dismissal is a thing a reader *means*, and a movement that never once got
   * above a walking pace is somebody deciding, not somebody deciding to leave.
   *
   * So a push is answered by how far it went **and** how fast it ever went, and
   * the three numbers are read together:
   *
   *  - short of `DISMISS_HOLD`, the card comes back, whatever the speed — the same
   *    "that was a nudge" it has always been;
   *  - past `DISMISS_COMMIT`, the card goes, whatever the speed. A card three-quarters
   *    off the screen is not an accident, and a reader who cannot flick — or
   *    who simply prefers to place it — must still be able to finish. Nothing
   *    in here may become the only way out of anything;
   *  - between the two, the card goes only if the movement reached
   *    `DISMISS_VELOCITY` at some point in it. That is the band where intent is
   *    genuinely ambiguous, and speed is what resolves it.
   *
   * The three numbers live with the app's other gesture thresholds, in
   * `gestures.ts`, where {@link dismissesSheet} states the rule and records what
   * each of them was measured at. They are meant to be turned by feel on a real
   * phone, which is the only place the question can honestly be asked; what is
   * owed here is the measuring, which is the part a scroller makes awkward.
   *
   * **The speed is a peak over the movement, not a reading at the end of it.**
   * A scroller always decelerates to a stop — that is what momentum is — so by
   * the time the debounce below has decided a movement is over, whatever speed
   * it had is gone. A hand that means to throw a card away is quick *somewhere*
   * in the push even when it starts gently and lands softly; a hand still making
   * its mind up never is. So the fastest moment is what is kept.
   *
   * Debounced on `scroll` rather than waiting for `scrollend`, which Safari only
   * learned recently and which this cannot be the first thing to require.
   */
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    /** How long the card takes to finish leaving once the outcome is settled. */
    const EXIT = 180;
    /*
     * How long a stillness counts as the movement having ended.
     *
     * Momentum delivers a scroll event every frame or so, which is a wide
     * margin, and this is time the reader spends looking at a card that has
     * stopped and not yet been answered — so it is kept short. It is not a
     * threshold on the gesture, only on the silence after it.
     */
    const SETTLE = 70;
    /** How far a pointer must travel before it is a drag rather than a tap. */
    const SLOP = 4;
    /*
     * How long after the reader's last input a scroll is still theirs.
     *
     * **This measures how late the engine may be, not how long a gesture is.**
     * Momentum outlives the finger and arrives as bare scroll events with no
     * input beside them, and every scroll that qualifies pushes the window out
     * again, so a movement stays the reader's for as long as it keeps moving.
     * What the window has to cover, then, is the gap before the *first* of
     * those — the delay between asking the layer to move and the layer moving.
     *
     * Sized at a frame, generously, it was too small by an order of magnitude.
     * WebKit's wheel scrolling is starved by a page doing per-frame work: the
     * pull-to-refresh specs install a watcher before they swipe, and the same
     * wheel that moves this layer 675px moves it 50 while that watcher runs.
     * The push then arrived after its own window had closed, the layer read the
     * reader's own movement as a stray and put the card back, and two dismissal
     * specs failed on the widest phone — the one with the furthest to scroll,
     * and only there.
     *
     * A second and more than covers that. It can be this generous because a tap
     * does not open it: the click case this whole rule exists for never gets a
     * window at all, however fast the clicks come, so nothing here has to
     * separate one click from the next.
     */
    const HANDS_OFF = 1500;
    /** The keys that scroll a box, and so can push this one. */
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    let timer: number | undefined;
    let leaving = false;

    /*
     * Whether the movement in front of us was made by a hand.
     *
     * The dismissal is a scroll, and scrolls are not made only by thumbs. Any
     * `scrollIntoView` — the browser revealing a focused control, a harness
     * bringing a row into view before clicking it, a reflow under an opening
     * keyboard — scrolls the nearest ancestor that can satisfy it, and when the
     * card's own body is already at its top that ancestor is this layer. So the
     * layer can be parked past `DISMISS_HOLD` with nobody having touched it, and
     * then whether the card survives is a race between the settle timer and what
     * scrolls it back. Measured on the compare sheet: one click on a candidate
     * moved this layer from its detent at 704 to 369, four times in ten.
     *
     * A gesture is therefore a precondition of a dismissal rather than an
     * assumption about one. What counts as a hand:
     *
     *  - a pointer that is down **and has moved** — a tap that lands and lets go
     *    is not a push, and the browser's scroll-to-reveal on focus arrives
     *    inside one, so a tap on a field near the top of a long card would
     *    otherwise throw the card away;
     *  - a pointer the engine took off us to pan with, which is what a
     *    `pointercancel` says and is the clearest statement of a drag WebKit
     *    makes — it sends one in place of the moves it would otherwise deliver;
     *  - a wheel, which is the same scroll a finger makes and the only one a
     *    desktop browser has;
     *  - the keys that scroll a box.
     *
     * Anything else is a scroll nobody asked for, and the answer to those is to
     * put the card back rather than to decide anything about it.
     */
    let pointerAt: { x: number; y: number } | null = null;
    let dragging = false;
    /*
     * When the reader last did something the layer could act on.
     *
     * Minus infinity rather than nought, and that is not decoration: `stamp()`
     * is time since the page loaded, so nought means "at load", and a sheet
     * opened inside the window would read the beginning of time as input that
     * had just happened — every stray scroll on it credited to a hand that was
     * never there. The honest initial value is that it has not happened.
     */
    let handsOn = Number.NEGATIVE_INFINITY;
    /*
     * Until when the settle's own smooth scroll is expected to still be running.
     *
     * A deadline rather than a flag, and the difference matters: a flag left
     * standing by an animation that was interrupted rather than finished would
     * make every later stray scroll look like this one's, and the correction
     * below would stop happening — which is the invisible-modal outcome the note
     * on re-arming calls worse than any amount of redundant work. A smooth
     * scroll across this layer takes a few hundred milliseconds; past the
     * deadline, whatever is moving the layer is somebody else's.
     */
    const SPRING = 700;
    let springUntil = 0;
    const stamp = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
    /*
     * The fastest this movement has travelled toward gone, and where it was
     * last seen, so the next scroll can be turned into a speed.
     *
     * **`sampled` is the honest answer to "and if we never found out?"** A speed
     * needs two positions and the gap between them, and there are movements this
     * layer is given only one position for: a single `scrollTop` write moves it
     * a whole screen inside one event, which is what a test does when its
     * subject is a stated distance, and what a page can do to itself. Guessing
     * "slow" there would withhold a dismissal on no evidence at all. So an
     * unmeasured movement is judged the way it was judged before any of this —
     * on distance — and the speed may only ever *withhold* a dismissal it has
     * actually watched being slow.
     */
    let peak = 0;
    let sampled = false;
    let lastTop = 0;
    let lastAt = 0;
    /** Begin reading a fresh movement, from wherever the layer is now. */
    const rewind = () => {
      peak = 0;
      sampled = false;
      lastTop = root.scrollTop;
      lastAt = stamp();
    };
    /**
     * One scroll's worth of speed.
     *
     * Only movement toward gone counts. A push that wanders back up the layer
     * mid-gesture is a reader changing their mind, and the speed of the changing
     * has nothing to say about whether they meant to leave.
     */
    const sample = (top: number) => {
      const at = stamp();
      const gap = at - lastAt;
      const travelled = lastTop - top;
      lastTop = top;
      lastAt = at;
      if (gap <= 0 || travelled <= 0) return;
      sampled = true;
      peak = Math.max(peak, travelled / gap);
    };
    /*
     * Real input: the reader has done something the layer can act on.
     *
     * **Only this cancels a spring-back, and that distinction is load-bearing.**
     * A second push arriving while the card is on its way home must be watched —
     * the note on re-arming below is about the invisible modal that results when
     * it is not — and a second push is *input*, not merely more scrolling. The
     * spring-back's own animation fires scroll events inside the window too, and
     * letting those count as a new push made `settle` re-issue its smooth scroll
     * every seventy milliseconds, restarting the ease from the top each time.
     * The card then crawled instead of springing, and stopped where it was left:
     * the scrim reading 0.699 on a push made to 0.7.
     */
    const gestured = () => {
      // A movement that begins out of stillness is a new one, and starts its
      // speed over. One already under way keeps the peak it has earned.
      if (!hands()) rewind();
      springUntil = 0;
      handsOn = stamp();
    };
    /** A scroll that belongs to a movement already under way. */
    const refresh = () => {
      handsOn = stamp();
    };
    const hands = () => dragging || stamp() - handsOn < HANDS_OFF;
    /** The point a pointer or touch event happened at, whichever kind it is. */
    const pointOf = (event: Event) => {
      const touch = 'touches' in event ? (event as TouchEvent).touches[0] : (event as PointerEvent);
      return touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onDown = (event: Event) => {
      pointerAt = pointOf(event);
      dragging = false;
      // A hand arriving on the layer starts a movement, and a movement's speed
      // is its own. Without this, two pushes a moment apart would share a peak
      // and the second would inherit whatever the first had earned.
      rewind();
    };
    const onMove = (event: Event) => {
      const at = pointOf(event);
      if (!pointerAt || !at) return;
      if (Math.abs(at.x - pointerAt.x) + Math.abs(at.y - pointerAt.y) < SLOP) return;
      dragging = true;
      gestured();
    };
    const onUp = () => {
      pointerAt = null;
      // The momentum this left behind is still the reader's; the window says
      // for how long, and each scroll it covers renews it.
      if (dragging) gestured();
      dragging = false;
    };
    const onTaken = () => {
      gestured();
      dragging = false;
      pointerAt = null;
    };
    const onWheel = () => gestured();
    const onKey = (event: Event) => {
      if (SCROLL_KEYS.has((event as KeyboardEvent).key)) gestured();
    };

    /*
     * The screen behind the card comes back as the card goes, rather than after.
     *
     * The scrim used to hold full strength for the whole of a dismissal and
     * vanish with the sheet, so once the card had slid past you were looking at
     * a solid grey screen with nothing on it — which reads as the app having
     * stopped rather than as a card leaving. Tied to the scroll it is the same
     * gesture as the card's: pull the card halfway down and the app behind is
     * half back, change your mind and it darkens again.
     *
     * One opacity write per scroll event, which the compositor takes without a
     * layout, and none at all while the layer is not moving.
     */
    const paint = (progress: number) => {
      const back = backdrop.current;
      if (back) back.style.opacity = String(Math.max(0, Math.min(1, progress)));
    };

    /*
     * Finishing the dismissal, rather than waiting for the scroll to.
     *
     * A scroll's duration belongs to the reader's flick: push the card gently
     * past the point of no return and it crawls the rest of a screen's height,
     * because there is nothing left driving it but the little momentum the push
     * had. The outcome is already decided by then, so what is left is not a
     * decision but an exit, and an exit should take the time an exit takes.
     *
     * So the layer stops taking input and the card covers whatever distance is
     * left under a transform, in `EXIT` milliseconds whatever that distance is.
     * `scrollTop` is exactly that distance: the card sits one screen down the
     * layer's content, so the amount it is still short of gone is how far the
     * layer is still scrolled.
     *
     * Reduced motion gets no exit at all, which is the same answer the
     * stylesheet gives the entrance.
     */
    const leave = () => {
      if (leaving) return;
      leaving = true;
      springUntil = 0;
      window.clearTimeout(timer);
      const remaining = root.scrollTop;
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      if (still || remaining < 1) {
        paint(0);
        onDismiss.current();
        return;
      }
      root.style.pointerEvents = 'none';
      /*
       * The card moves, not its detent — and that distinction is the one this
       * file already paid for once. A transformed box adds its travel to its
       * scroll container's scrollable overflow, so translating the detent would
       * lengthen the layer mid-dismissal, exactly as the entrance keyframe did
       * before it was clipped. The card is *inside* the detent, and the detent
       * clips, so its exit costs the layer nothing.
       */
      const card = surface.current;
      if (card) {
        card.style.transition = `transform ${EXIT}ms var(--ease)`;
        card.style.transform = `translate3d(0, ${remaining}px, 0)`;
      }
      const back = backdrop.current;
      if (back) back.style.transition = `opacity ${EXIT}ms var(--ease)`;
      paint(0);
      window.setTimeout(() => onDismiss.current(), EXIT);
    };

    const settle = () => {
      if (leaving) return;
      const detentTop = root.scrollHeight - root.clientHeight;
      if (detentTop <= 0) return;
      // How much of the push was given, and whether it was ever given quickly.
      if (dismissesSheet(1 - root.scrollTop / detentTop, peak, sampled)) {
        leave();
        return;
      }
      // Already where it belongs. A pixel of tolerance because a smooth scroll
      // lands on a fraction and `scrollTop` is not obliged to be an integer.
      if (root.scrollTop >= detentTop - 1) {
        rewind();
        return;
      }
      springUntil = stamp() + SPRING;
      root.scrollTo({ top: detentTop, behavior: 'smooth' });
      // The push has been answered. What the spring-back does from here is the
      // layer's own movement, and the next push starts its speed from nothing.
      rewind();
    };

    /*
     * Every scroll re-arms, including the ones this makes itself.
     *
     * The obvious economy is to ignore movement while the settle's own smooth
     * scroll is running, and it is a bug: a reader who pushes the card, lets the
     * spring-back begin and pushes again lands inside that window, and the
     * second push is the one nobody is watching. The card then comes to rest at
     * the dismissed position *without being dismissed* — scrolled entirely off
     * the screen, still open, still holding the page behind it still. An
     * invisible modal is a worse outcome than any amount of redundant work.
     *
     * Re-arming unconditionally costs nothing because the settle is idempotent:
     * during its own animation it finds the layer at the card's position and
     * returns, and if the reader has pushed again it finds where *they* left it.
     * The timer is only ever reset, so it fires once, after everything stops.
     *
     * **A card that has arrived at gone does not wait to be told.** The debounce
     * is there to find out where a movement ended, and a layer scrolled to its
     * far end has answered that already — there is no coming back from a card
     * that is entirely off the screen, and waiting to confirm it is a tenth of a
     * second of grey with nothing happening in it. That was most of what a
     * dismissal felt like.
     */
    const onScroll = () => {
      if (leaving) return;
      const detentTop = root.scrollHeight - root.clientHeight;
      const top = root.scrollTop;
      if (stamp() < springUntil) {
        /*
         * The settle's own smooth scroll, on its way back to the card's
         * position. Neither a gesture to act on nor a stray to correct — the
         * scrim tracks it home and nothing else here touches it, least of all
         * another `scrollTo`.
         *
         * **Asked first, and not last.** A reader who pushes again mid-flight is
         * still watched, because pushing is input and input clears `springUntil`
         * before the scroll it causes ever arrives here. What this order stops
         * is the animation being mistaken for that second push by nothing more
         * than its own scroll events landing inside the reader's window.
         */
        if (detentTop > 0) paint(top / detentTop);
        if (detentTop <= 0 || top >= detentTop - 1) springUntil = 0;
        // Not the reader's movement, so it earns no speed — but it does move the
        // layer, and a stale position would turn the next real push's first
        // scroll into a speed measured across the spring's travel as well.
        lastTop = top;
        lastAt = stamp();
        return;
      } else if (hands()) {
        // A movement already under way, which keeps its window open as it goes.
        refresh();
        sample(top);
      } else {
        /*
         * A scroll nobody made: put the card back where it belongs and decide
         * nothing.
         *
         * Instantly rather than smoothly, because this is a correction and not
         * a movement the reader began — and because a smooth one leaves a
         * window in which a second scroll-into-view can chain onto the first.
         * The write is a no-op when the layer is already at the detent, which
         * is what the entrance's own scroll is, so opening a sheet costs
         * nothing here.
         */
        window.clearTimeout(timer);
        if (detentTop > 0 && top < detentTop - 1) root.scrollTop = detentTop;
        paint(1);
        // Corrected, not travelled. The layer is back at the card's position and
        // whatever a hand does next starts from there.
        rewind();
        return;
      }
      if (detentTop > 0) paint(top / detentTop);
      /*
       * A card that has arrived at gone does not wait to be told.
       *
       * The debounce is there to find out where a movement ended, and a layer
       * scrolled to its far end has answered that already — there is no coming
       * back from a card entirely off the screen, and waiting to confirm it is a
       * tenth of a second of grey with nothing happening in it.
       *
       * **Anything short of that end waits, and that is not caution.** Deciding
       * the moment the card passes the threshold was tried, to spare a gentle
       * push the slow drift down the rest of the screen. It took the compare
       * sheet's card away in the middle of a click on one of its candidates, on
       * nine of twelve WebKit shards, and putting the wait back is what fixed
       * them. What exactly moved the layer far enough was never pinned down —
       * measured directly, bringing a candidate into view scrolls `.sheet-body`
       * and leaves this alone — so the honest statement is the narrow one: a
       * dismissal decided inside a single scroll event has nothing left that can
       * put the layer back, and this layer is scrolled by more things than a
       * thumb.
       *
       * **And a layer with nowhere to scroll has not arrived anywhere.** Nought
       * is the dismissed position only once there is a journey to have made:
       * while a card is still being laid out this box briefly has no travel in
       * it, and `scrollTop` is nought because it has never been anywhere else.
       * Reading that as "the card is gone" dismisses a sheet as it opens —
       * rarely, and only where a scroll event lands inside that window, which is
       * why it showed on one loaded CI shard and never once in isolation.
       */
      if (detentTop > 0 && top < 1) {
        leave();
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE);
    };
    rewind();
    root.addEventListener('scroll', onScroll, { passive: true });
    /*
     * The input listeners sit on the layer, which every part of a sheet is
     * inside — including `.sheet-body`, whose own scroll chains outward to this
     * one. Passive throughout: none of them cancels anything, they only watch.
     */
    const watched: [string, EventListener][] = [
      ['pointerdown', onDown],
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onTaken],
      ['touchstart', onDown],
      ['touchmove', onMove],
      ['touchend', onUp],
      ['touchcancel', onTaken],
      ['wheel', onWheel],
      ['keydown', onKey],
    ];
    for (const [type, listener] of watched) root.addEventListener(type, listener, { passive: true });
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener('scroll', onScroll);
      for (const [type, listener] of watched) root.removeEventListener(type, listener);
    };
  }, []);

  return createPortal(
    <>
      <div
        className="sheet-backdrop"
        data-testid="sheet-backdrop"
        ref={backdrop}
        style={{ ['--overlay-lift' as string]: String(lift) }}
        aria-hidden="true"
      />
      <div
        className="sheet-scroller"
        data-testid="sheet-scroller"
        ref={scroller}
        style={{
          ['--overlay-lift' as string]: String(lift),
          ['--sheet-keyboard' as string]: `${keyboard}px`,
        }}
      >
        {/*
          The screen-tall transparent zone above the card, and the tap that
          closes from outside it. This is what the backdrop's click handler used
          to be: the backdrop is underneath the scroller now and cannot be
          reached, so the part of the scroller you can see through is the part
          that answers a tap. Same gesture for the reader, same outcome.
        */}
        <div className="sheet-dismiss" data-testid="sheet-dismiss" onClick={onClose} />
        <div className="sheet-snap">
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={accessibleLabel ?? (typeof title === 'string' ? title : undefined)}
            data-testid={testId ?? 'sheet'}
            /*
             * Focusable by `useOverlay` and by nothing else. A dialog that takes
             * focus on its own container is announced as the dialog, with its
             * label; one that focuses its first button is announced as that
             * button, and the reader arrives without being told what has opened.
             */
            tabIndex={-1}
            ref={surface}
          >
            <div className="sheet-grip" aria-hidden="true" data-testid="sheet-grip" />
            <div className="sheet-header">
              <div className="sheet-title">{title}</div>
              <button type="button" className="btn btn-sm" onClick={onClose} data-testid="sheet-close">
                Done
              </button>
            </div>
            <div className="sheet-body">{children}</div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/* --------------------------------------------------------- pull to refresh */

/**
 * The screen, with the gesture that reloads it attached to the top of it.
 *
 * There is no button here and that is the point. A refresh control in a
 * navigation bar is a desktop idiom that iPhone apps abandoned years ago: the
 * gesture is already in the reader's hands, it costs no glass, and it cannot be
 * tapped by accident while scrolling. Two of them — a bar control *and* a
 * "Refresh data" button — is what this replaced.
 *
 * What is visible: a spinner that arrives with the finger, turns as it is
 * pulled, and spins while the request runs. What is not: any suggestion that
 * pulling harder does more, or a second refresh queued behind the first — see
 * the hook, which is single-flight.
 *
 * The keyboard fallback is real but deliberately unobtrusive: a control that is
 * off screen until it is focused. A pointer gesture must never be the only way
 * to do something, and on a phone it must never be the thing in the way.
 */
export function PullToRefresh({
  onRefresh,
  children,
  label = 'Refresh',
  testId = 'pull-to-refresh',
  enabled = true,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  children: ReactNode;
  label?: string;
  testId?: string;
  enabled?: boolean;
}) {
  const pull = usePullToRefresh({ onRefresh, enabled });
  const busy = pull.state === 'refreshing';

  return (
    <div
      className="pull-surface"
      data-testid={testId}
      data-pull-state={pull.state}
      {...pull.handlers}
    >
      <div
        className="pull-indicator"
        data-testid="pull-indicator"
        aria-hidden={pull.state === 'idle'}
        style={{ height: `${pull.distance}px`, opacity: pull.distance > 0 ? 1 : 0 }}
      >
        <span
          className={busy ? 'pull-spinner pull-spinner-busy' : 'pull-spinner'}
          style={busy ? undefined : { transform: `rotate(${pull.distance * 3}deg)` }}
        />
      </div>
      {/*
        Said once, out loud, for anything that is not looking at the spinner.
        `polite` because a refresh is never urgent enough to interrupt.
      */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {busy ? `Refreshing ${label.toLowerCase()}…` : ''}
      </div>
      <button
        type="button"
        className="visually-hidden focusable"
        data-testid="pull-refresh-fallback"
        disabled={busy}
        onClick={pull.refresh}
      >
        {label}
      </button>
      <div className="pull-content" style={{ transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : '' }}>
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- fold */

/**
 * A secondary section, folded away.
 *
 * The Team screen's bench and the Matchup screen's bench have folded like this
 * since the density pass — a quiet control carrying a label, a word about what
 * is inside, and a chevron — and this is that same control with the word
 * "bench" taken out of it, for the sections that are not one. It shares their
 * stylesheet rules rather than copying them (see `.bench, .fold`), so the
 * affordance cannot drift into two.
 *
 * **The children are not rendered while it is closed**, which is the difference
 * between this and a `<details>`: a fold holding a hundred rows of market
 * inventory would otherwise cost the page every one of them on first paint in
 * order to hide them. It also means there is nothing inside for a stray tab
 * stop to land on.
 *
 * ## Why the state is the caller's
 *
 * Because on some screens the fold has to outlive this component. Trades pushes
 * a player's own page by *returning a different tree* — the board is not
 * mounted while it is open — so a fold holding its own `useState` came back
 * closed from every Back, throwing away the reader's place in a list they had
 * asked to see. The screen keeps the flag, exactly as it already keeps the
 * query and the scroll for the same reason.
 *
 * `aria-expanded` is on the control and the region it names is the sibling
 * below it, which is the pattern the benches already publish. No nested
 * controls: the whole row is the button, and everything inside it is text.
 */
export function Fold({
  label,
  summary,
  open,
  onToggle,
  testId,
  children,
}: {
  /** The affordance's own words, and its accessible name: `Explore the market`. */
  label: string;
  /** One short phrase about what is inside, in the quietest type on the control. */
  summary?: string | null;
  open: boolean;
  onToggle: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="fold" data-testid={testId} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="fold-toggle"
        data-testid={testId ? `${testId}-toggle` : undefined}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="fold-label">{label}</span>
        {summary ? <span className="fold-summary">{summary}</span> : null}
        <span className="fold-chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? <div data-testid={testId ? `${testId}-body` : undefined}>{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ loading */

/**
 * Loading, at the shape of the thing that is coming.
 *
 * Rows the size of the rows that will replace them, so the page does not jump
 * when the data lands and the reader's thumb does not have to chase a control
 * that moved. Nothing about what is fetched, or when, is decided here.
 */
export function SkeletonRows({ rows = 6, testId }: { rows?: number; testId?: string }) {
  return (
    <div data-testid={testId ?? 'skeleton'} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton skeleton-row" key={i} />
      ))}
    </div>
  );
}
