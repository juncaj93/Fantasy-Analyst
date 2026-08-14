/**
 * Home Screen mode detection.
 *
 * Three signals, and the reason each of them is read is a different iOS. The
 * tests hand the module a fake window rather than standing up a DOM, because
 * what is worth pinning down is which signal was believed and what happens when
 * they disagree.
 */

import { describe, expect, it } from 'vitest';
import {
  INSTALL_DISMISSED_KEY,
  dismissInstall,
  installDismissed,
  isIosDevice,
  isStandalone,
  shouldOfferInstall,
  watchStandalone,
  type WindowLike,
} from '@web/standalone.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC = IPAD_AS_MAC;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile';

/** A window with the bits the module reads, and nothing else. */
function fakeWindow(options: {
  ua?: string;
  touchPoints?: number;
  displayMode?: string;
  legacyStandalone?: boolean;
  storage?: Record<string, string> | 'refuses';
} = {}): WindowLike & { store: Record<string, string> } {
  const store = options.storage && options.storage !== 'refuses' ? { ...options.storage } : {};
  const refuses = options.storage === 'refuses';
  return {
    store,
    matchMedia: (query: string) => ({
      matches: options.displayMode ? query === `(display-mode: ${options.displayMode})` : false,
    }),
    navigator: {
      userAgent: options.ua ?? IPHONE,
      maxTouchPoints: options.touchPoints ?? 5,
      ...(options.legacyStandalone === undefined ? {} : { standalone: options.legacyStandalone }),
    },
    localStorage: {
      getItem: (key) => {
        if (refuses) throw new Error('storage is not available');
        return store[key] ?? null;
      },
      setItem: (key, value) => {
        if (refuses) throw new Error('storage is not available');
        store[key] = value;
      },
    },
  };
}

describe('isStandalone', () => {
  it('believes the display-mode media query', () => {
    expect(isStandalone(fakeWindow({ displayMode: 'standalone' }))).toBe(true);
    expect(isStandalone(fakeWindow({ displayMode: 'browser' }))).toBe(false);
  });

  it('counts fullscreen as installed too', () => {
    expect(isStandalone(fakeWindow({ displayMode: 'fullscreen' }))).toBe(true);
  });

  it("believes older iOS's own flag when the media query says nothing", () => {
    expect(isStandalone(fakeWindow({ legacyStandalone: true }))).toBe(true);
    expect(isStandalone(fakeWindow({ legacyStandalone: false }))).toBe(false);
  });

  it('is false in a plain browser tab with neither signal', () => {
    expect(isStandalone(fakeWindow())).toBe(false);
  });

  it('survives a window with no matchMedia at all', () => {
    const win: WindowLike = { navigator: { userAgent: IPHONE } };
    expect(isStandalone(win)).toBe(false);
  });
});

describe('isIosDevice', () => {
  it('recognises an iPhone', () => {
    expect(isIosDevice(fakeWindow({ ua: IPHONE }))).toBe(true);
  });

  it('recognises an iPad pretending to be a Mac', () => {
    expect(isIosDevice(fakeWindow({ ua: IPAD_AS_MAC, touchPoints: 5 }))).toBe(true);
  });

  it('does not mistake a real Mac for one', () => {
    expect(isIosDevice(fakeWindow({ ua: MAC, touchPoints: 0 }))).toBe(false);
  });

  /*
   * The e2e browsers emulate touch on a desktop user agent, and reported one
   * touch point while doing it. Treating that as an iPad would have put an
   * install prompt on top of every screen in the suite.
   */
  it('does not mistake a desktop browser emulating touch for one', () => {
    expect(isIosDevice(fakeWindow({ ua: MAC, touchPoints: 1 }))).toBe(false);
  });

  it('says no to Android, where these instructions would be wrong', () => {
    expect(isIosDevice(fakeWindow({ ua: ANDROID }))).toBe(false);
  });
});

describe('the install prompt', () => {
  it('is offered on an iPhone in a browser tab', () => {
    expect(shouldOfferInstall(fakeWindow())).toBe(true);
  });

  it('is never offered once the app is installed', () => {
    expect(shouldOfferInstall(fakeWindow({ displayMode: 'standalone' }))).toBe(false);
    expect(shouldOfferInstall(fakeWindow({ legacyStandalone: true }))).toBe(false);
  });

  it('is not offered where Add to Home Screen is not the gesture', () => {
    expect(shouldOfferInstall(fakeWindow({ ua: ANDROID }))).toBe(false);
  });

  it('stays dismissed', () => {
    const win = fakeWindow();
    expect(installDismissed(win)).toBe(false);
    dismissInstall(win);
    expect(win.store[INSTALL_DISMISSED_KEY]).toBe('1');
    expect(installDismissed(win)).toBe(true);
    expect(shouldOfferInstall(win)).toBe(false);
  });

  /*
   * Private browsing refuses storage, so a dismissal cannot be remembered.
   * Showing it anyway would mean showing it on every single load, which is the
   * one behaviour the prompt must not have — so a device that cannot remember
   * saying no is treated as having said it.
   */
  it('does not nag a device that cannot remember the dismissal', () => {
    const win = fakeWindow({ storage: 'refuses' });
    expect(installDismissed(win)).toBe(true);
    expect(shouldOfferInstall(win)).toBe(false);
    expect(() => dismissInstall(win)).not.toThrow();
  });
});

describe('watchStandalone', () => {
  it('subscribes and unsubscribes', () => {
    const listeners: (() => void)[] = [];
    const win: WindowLike = {
      navigator: { userAgent: IPHONE },
      matchMedia: () => ({
        matches: false,
        addEventListener: (_type, listener) => listeners.push(listener),
        removeEventListener: (_type, listener) => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        },
      }),
    };
    let fired = 0;
    const stop = watchStandalone(win, () => fired++);
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(fired).toBe(1);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('is a no-op where the media query cannot be watched', () => {
    const win: WindowLike = { navigator: { userAgent: IPHONE }, matchMedia: () => ({ matches: false }) };
    expect(() => watchStandalone(win, () => {})()).not.toThrow();
  });
});
