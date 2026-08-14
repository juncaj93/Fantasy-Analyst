/**
 * Home Screen web app mode: is this a standalone launch, and should we offer
 * to become one?
 *
 * One module, because the answer is needed in two places (the shell's prompt
 * and Setup's instructions) and because iOS keeps changing how it is spelled.
 * A component asks a question here; it never sniffs a user agent itself.
 *
 * The distinction this file exists to draw:
 *
 *   normal Safari tab   the page gets the visual viewport, and Safari keeps its
 *                       URL field and button bar below it. Those pixels are the
 *                       browser's and no page CSS can claim them.
 *   Home Screen app     launched from the icon, with the manifest's
 *                       `display: standalone`. Safari's chrome is not part of
 *                       the window at all; the page gets the whole screen
 *                       minus the system status bar and home indicator.
 *
 * See docs/IOS_WEB_APP.md.
 */

/**
 * The parts of `window` this module touches.
 *
 * Written out rather than taking `Window` so the unit tests can hand it a
 * plain object: the behaviour worth testing is "which of these three signals
 * did we believe", and standing up a whole DOM to check that would test the
 * DOM instead.
 */
export interface WindowLike {
  matchMedia?: (query: string) => MediaQueryListLike;
  navigator: {
    userAgent?: string;
    maxTouchPoints?: number;
    /** iOS-only, and older than the display-mode media query. */
    standalone?: boolean;
  };
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
}

export interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

/** Set once when the prompt is dismissed. Dismissal is permanent on purpose. */
export const INSTALL_DISMISSED_KEY = 'fa.install.dismissed';

function matches(win: WindowLike, query: string): boolean {
  try {
    return win.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Running as an installed app rather than in a browser tab.
 *
 * `display-mode` is the standard signal and the one current iOS sets for a
 * Home Screen web app. `navigator.standalone` is Apple's original flag, kept
 * because it is what an older iPhone answers to, and because believing a stale
 * "no" here would mean showing install instructions to somebody who has
 * already installed. `fullscreen` counts too: it is the other display mode the
 * platform will grant, and everything this app does with the answer is equally
 * true of it.
 */
export function isStandalone(win: WindowLike): boolean {
  if (matches(win, '(display-mode: standalone)')) return true;
  if (matches(win, '(display-mode: fullscreen)')) return true;
  return win.navigator.standalone === true;
}

/**
 * An iPhone or iPad, where Add to Home Screen is a thing the user can do.
 *
 * Feature detection would be better and does not exist: there is no API that
 * reports "this device can install a web app from the share sheet", and the
 * `beforeinstallprompt` event Chrome fires is exactly the thing iOS does not
 * have. So this is a platform check, deliberately not a browser-version one —
 * it asks what the hardware is, which does not churn, rather than which Safari
 * this is, which does.
 *
 * iPadOS 13 and later claim to be a Macintosh; the touch points give it away,
 * and a real Mac reports none. The threshold is above one because a desktop
 * browser emulating touch reports exactly one — a real iPad reports five — and
 * a test browser being mistaken for an iPad would put an install prompt on top
 * of every screen in the suite.
 */
export function isIosDevice(win: WindowLike): boolean {
  const ua = win.navigator.userAgent ?? '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (win.navigator.maxTouchPoints ?? 0) > 2;
}

/** Whether the compact prompt has been dismissed on this device. */
export function installDismissed(win: WindowLike): boolean {
  try {
    return win.localStorage?.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    // Private browsing can refuse storage. Erring towards "not dismissed" would
    // mean nagging on every load, which is the failure the brief cares about.
    return true;
  }
}

/** Remember the dismissal. Failing to is not worth telling anyone about. */
export function dismissInstall(win: WindowLike): void {
  try {
    win.localStorage?.setItem(INSTALL_DISMISSED_KEY, '1');
  } catch {
    /* the prompt still closes for this session */
  }
}

/**
 * Whether to show the one-time prompt.
 *
 * Three conditions, all of them "would this help": there is something to
 * install onto, it is not installed already, and the user has not said no.
 */
export function shouldOfferInstall(win: WindowLike): boolean {
  return isIosDevice(win) && !isStandalone(win) && !installDismissed(win);
}

/**
 * Watch for the display mode changing under us.
 *
 * It does change without a reload: iOS can hand an existing page over when the
 * app is launched from the icon, and a desktop browser can install in place.
 * Returns an unsubscribe.
 */
export function watchStandalone(win: WindowLike, onChange: () => void): () => void {
  const query = win.matchMedia?.('(display-mode: standalone)');
  if (!query?.addEventListener || !query.removeEventListener) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}
