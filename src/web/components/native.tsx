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

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEdgeSwipeBack, usePullToRefresh, useSheetDrag, useStandaloneMode } from '../gestures.ts';
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
 * Rises from the bottom, dims what is behind it, and can be pulled back down —
 * but only from the top of its own content, so scrolling inside it never turns
 * into dismissing it by accident. Escape and the backdrop close it too, because
 * a gesture must never be the only way out of anything.
 *
 * Nothing destructive is ever put in one of these: a sheet that can be flicked
 * away is for reference and for choices that can be made again.
 */
export function Sheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const drag = useSheetDrag({ onDismiss: onClose });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="sheet-backdrop" data-testid="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        data-testid={testId ?? 'sheet'}
        ref={drag.sheetRef}
        {...drag.handlers}
      >
        <div className="sheet-grip" aria-hidden="true" data-testid="sheet-grip" />
        <div className="sheet-header">
          <div className="sheet-title">{title}</div>
          <button type="button" className="btn btn-sm" onClick={onClose} data-testid="sheet-close">
            Done
          </button>
        </div>
        <div className="sheet-body" ref={drag.bodyRef}>
          {children}
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
