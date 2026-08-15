/**
 * Where the bottom of the screen actually is.
 *
 * This exists because "there is a grey bar under the navigation" has been
 * diagnosed wrong more than once, and every wrong diagnosis cost a round of
 * speculative CSS. The question is answerable, and it is one subtraction:
 *
 *     window.innerHeight - toolbarBottom
 *
 * What that number should be changed when the bar started floating, and the
 * change is worth stating plainly. It used to be zero: the bar reached the last
 * pixel the webpage was given, and everything visible below it belonged to
 * Safari — its URL field, its button bar, the home indicator. It is now
 * `--toolbar-gap`, a number the design chooses, because the toolbar
 * deliberately sits clear of the bottom edge; on a screen with a home indicator
 * that gap is what keeps the destinations off it. Anything *more* than the gap
 * is still the page holding space it should not, and still a real bug.
 *
 * Both numbers are reported, so the report says whether the space below the bar
 * is the design's or a mistake rather than leaving the reader to guess.
 *
 * Reported rather than asserted, and reachable on the phone itself (Setup ->
 * Install on iPhone -> Layout diagnostics), because the device that has the
 * problem is never the one running the tests.
 */

export interface ViewportReport {
  /** The layout viewport the page was given. */
  innerHeight: number;
  /** What is actually on screen right now; differs when the keyboard is up. */
  visualViewportHeight: number | null;
  /** `#root`, the one element that claims the viewport height. */
  rootHeight: number;
  /** The scrolling content area. */
  mainHeight: number;
  navTop: number;
  navBottom: number;
  navHeight: number;
  /**
   * Page-owned pixels below the floating toolbar. Should equal `toolbarGap`;
   * more than that is a real bug in this app, and it is NOT the Safari toolbar.
   */
  gapBelowNav: number;
  /** What the design asks that gap to be, resolved from `--toolbar-gap`. */
  toolbarGap: number;
  /** The measured bar height the page reserves for, from `--toolbar-height`. */
  reservedForNav: string;
  /** Everything the page holds back for the bar, from `--content-inset`. */
  contentInset: string;
  /** Resolved, not the `env()` expression: what the device actually offers. */
  safeAreaTop: number;
  safeAreaBottom: number;
  standalone: boolean;
  displayMode: string;
  /** Apple's older standalone flag, or null where it does not exist. */
  navigatorStandalone: boolean | null;
}

/** Resolve an `env()` inset, which cannot be read off a custom property. */
function resolveInset(doc: Document, side: 'top' | 'bottom'): number {
  const probe = doc.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:env(safe-area-inset-${side},0px)`;
  doc.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${side}`)) || 0;
  probe.remove();
  return Math.round(value);
}

/**
 * Resolve a length token to pixels.
 *
 * `--toolbar-gap` is a `max()` over an `env()`, so reading the custom property
 * gives back the expression rather than a number. Putting it on a real element's
 * padding and asking for the computed value is what makes the browser do the
 * arithmetic — the same trick as the insets above, for the same reason.
 */
function resolveLength(doc: Document, expression: string): number {
  const probe = doc.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-bottom:${expression}`;
  doc.body.appendChild(probe);
  const value = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return Math.round(value);
}

const displayModes = ['standalone', 'fullscreen', 'minimal-ui', 'browser'] as const;

export function describeViewport(win: Window = window, doc: Document = document): ViewportReport {
  const nav = doc.querySelector('.tabbar')?.getBoundingClientRect();
  const root = doc.getElementById('root')?.getBoundingClientRect();
  const main = doc.querySelector('.app-main')?.getBoundingClientRect();
  const navBottom = Math.round(nav?.bottom ?? 0);
  const mode = displayModes.find((m) => win.matchMedia?.(`(display-mode: ${m})`).matches);
  const legacy = (win.navigator as Navigator & { standalone?: boolean }).standalone;
  const rootStyle = getComputedStyle(doc.documentElement);

  return {
    innerHeight: Math.round(win.innerHeight),
    visualViewportHeight: win.visualViewport ? Math.round(win.visualViewport.height) : null,
    rootHeight: Math.round(root?.height ?? 0),
    mainHeight: Math.round(main?.height ?? 0),
    navTop: Math.round(nav?.top ?? 0),
    navBottom,
    navHeight: Math.round(nav?.height ?? 0),
    gapBelowNav: Math.round(win.innerHeight) - navBottom,
    toolbarGap: resolveLength(doc, 'var(--toolbar-gap)'),
    reservedForNav: rootStyle.getPropertyValue('--toolbar-height').trim() || '—',
    contentInset: `${resolveLength(doc, 'var(--content-inset)')}px`,
    safeAreaTop: resolveInset(doc, 'top'),
    safeAreaBottom: resolveInset(doc, 'bottom'),
    standalone: mode === 'standalone' || mode === 'fullscreen' || legacy === true,
    displayMode: mode ?? 'unknown',
    navigatorStandalone: typeof legacy === 'boolean' ? legacy : null,
  };
}

/** The report as lines of plain text, for showing on the phone. */
export function formatViewportReport(r: ViewportReport): [string, string][] {
  const surplus = r.gapBelowNav - r.toolbarGap;
  return [
    ['Page viewport', `${r.innerHeight}px${r.visualViewportHeight ? ` (visual ${r.visualViewportHeight}px)` : ''}`],
    ['Toolbar', `${r.navTop}–${r.navBottom}px, ${r.navHeight}px tall`],
    [
      'Below the toolbar',
      surplus <= 1
        ? `${r.gapBelowNav}px, the gap it floats by (correct)`
        : `${r.gapBelowNav}px — ${surplus}px more than the ${r.toolbarGap}px gap, a bug`,
    ],
    ['Reserved for it', `${r.reservedForNav} bar, ${r.contentInset} in total`],
    ['Device safe area', `top ${r.safeAreaTop}px, bottom ${r.safeAreaBottom}px`],
    ['Launched as', r.standalone ? 'Home Screen app' : 'browser tab'],
    ['Display mode', r.displayMode],
  ];
}
