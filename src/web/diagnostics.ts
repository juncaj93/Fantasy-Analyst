/**
 * Where the bottom of the screen actually is.
 *
 * This exists because "there is a grey bar under the navigation" has been
 * diagnosed wrong more than once, and every wrong diagnosis cost a round of
 * speculative CSS. The question is answerable, and it is one subtraction:
 *
 *     window.innerHeight - navBottom
 *
 * If that is zero, the app's bar reaches the last pixel the webpage was given
 * and everything visible below it belongs to Safari — its URL field, its button
 * bar, the home indicator. No stylesheet can reach those. If it is not zero,
 * the page really is holding space it should not, and that is a bug worth
 * fixing.
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
   * Page-owned pixels below the tab bar. Zero is correct. Anything else is a
   * real bug in this app; it is NOT the Safari toolbar.
   */
  gapBelowNav: number;
  /** The measured bar height the page reserves for, from `--tabbar-height`. */
  reservedForNav: string;
  /** Resolved, not the `env()` expression: what the device actually offers. */
  safeAreaTop: number;
  safeAreaBottom: number;
  /** What the bar spends of it — deliberately less. See `--nav-inset`. */
  navInsetUsed: number;
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

const displayModes = ['standalone', 'fullscreen', 'minimal-ui', 'browser'] as const;

export function describeViewport(win: Window = window, doc: Document = document): ViewportReport {
  const nav = doc.querySelector('.tabbar')?.getBoundingClientRect();
  const root = doc.getElementById('root')?.getBoundingClientRect();
  const main = doc.querySelector('.app-main')?.getBoundingClientRect();
  const navBottom = Math.round(nav?.bottom ?? 0);
  const mode = displayModes.find((m) => win.matchMedia?.(`(display-mode: ${m})`).matches);
  const legacy = (win.navigator as Navigator & { standalone?: boolean }).standalone;

  return {
    innerHeight: Math.round(win.innerHeight),
    visualViewportHeight: win.visualViewport ? Math.round(win.visualViewport.height) : null,
    rootHeight: Math.round(root?.height ?? 0),
    mainHeight: Math.round(main?.height ?? 0),
    navTop: Math.round(nav?.top ?? 0),
    navBottom,
    navHeight: Math.round(nav?.height ?? 0),
    gapBelowNav: Math.round(win.innerHeight) - navBottom,
    reservedForNav: getComputedStyle(doc.documentElement).getPropertyValue('--tabbar-height').trim() || '—',
    safeAreaTop: resolveInset(doc, 'top'),
    safeAreaBottom: resolveInset(doc, 'bottom'),
    navInsetUsed: nav
      ? Math.round(Number.parseFloat(getComputedStyle(doc.querySelector('.tabbar')!).paddingBottom) || 0)
      : 0,
    standalone: mode === 'standalone' || mode === 'fullscreen' || legacy === true,
    displayMode: mode ?? 'unknown',
    navigatorStandalone: typeof legacy === 'boolean' ? legacy : null,
  };
}

/** The report as lines of plain text, for showing on the phone. */
export function formatViewportReport(r: ViewportReport): [string, string][] {
  return [
    ['Page viewport', `${r.innerHeight}px${r.visualViewportHeight ? ` (visual ${r.visualViewportHeight}px)` : ''}`],
    ['Tab bar', `${r.navTop}–${r.navBottom}px, ${r.navHeight}px tall`],
    ['Below the tab bar', r.gapBelowNav === 0 ? 'nothing (correct)' : `${r.gapBelowNav}px of page — a bug`],
    ['Reserved for it', r.reservedForNav],
    ['Device safe area', `top ${r.safeAreaTop}px, bottom ${r.safeAreaBottom}px`],
    ['Bar spends', `${r.navInsetUsed}px of the bottom inset`],
    ['Launched as', r.standalone ? 'Home Screen app' : 'browser tab'],
    ['Display mode', r.displayMode],
  ];
}
