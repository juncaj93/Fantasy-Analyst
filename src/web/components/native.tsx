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
import { useEdgeSwipeBack, usePullToRefresh, useStandaloneMode } from '../gestures.ts';
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
  const detent = useRef<HTMLDivElement | null>(null);
  const mark = useRef<HTMLDivElement | null>(null);
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
   * **Instant, and the rise is a keyframe rather than a smooth scroll.** Scrolling
   * the detent into view *is* the card coming up, so animating that scroll looks
   * like the obvious way to do the entrance — and it oscillates. A programmatic
   * smooth scroll and `scroll-snap-type: mandatory` are two things steering the
   * same box: the snap corrects the animation, the animation resumes, and the
   * layer never settles. Playwright's word for what that does to anything inside
   * the card is *not stable*, which it stayed for thirty seconds; a reader's
   * word for it would be less kind.
   *
   * So the two are kept apart. The scroll is a position, set once with nothing
   * animating it, and the entrance is an animation on the card that moves no
   * scroller at all. Reduced motion is honoured by the stylesheet, where the
   * rest of this app's motion is already answered.
   */
  useLayoutEffect(() => {
    detent.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, []);

  /*
   * And closing is a scroll arriving at the other end of the same box.
   *
   * The mark is two pixels inside the top of the detent; when the card has been
   * scrolled away it sits below the scrollport and stops intersecting. That
   * costs nothing per frame — which is the property this layer was rebuilt to
   * have, and the reason this is an observer rather than a `scroll` listener.
   *
   * **Which way it left is the whole of it, and leaving that out closed cards
   * the reader was reading.** A mark at the top of the card goes out of view in
   * both directions: downwards when the card is pushed away, and *upwards* the
   * moment somebody scrolls far enough down a long one. Asking only whether it
   * still intersects cannot tell those apart, so a card with more in it than
   * fits shut itself as soon as it was read past its own height.
   *
   * The entry already carries the answer, so this needs no extra reading of the
   * DOM: the mark has gone *below* the scrollport exactly when the card has
   * gone with it.
   *
   * `seen` is the other guard, and it makes this a *dismissal* rather than a
   * description of where the layer starts: the mark is out of view at mount,
   * because a sheet opens from its dismissed position, and only a departure
   * after an arrival means the reader pushed the card away.
   */
  useEffect(() => {
    const root = scroller.current;
    const target = mark.current;
    if (!root || !target) return;
    let seen = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            seen = true;
            continue;
          }
          if (!seen) continue;
          const below = entry.rootBounds ? entry.boundingClientRect.top >= entry.rootBounds.bottom : false;
          if (below) onDismiss.current();
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return createPortal(
    <>
      <div
        className="sheet-backdrop"
        data-testid="sheet-backdrop"
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
        <div className="sheet-snap" ref={detent}>
          <div className="sheet-dismissed-mark" ref={mark} aria-hidden="true" />
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
