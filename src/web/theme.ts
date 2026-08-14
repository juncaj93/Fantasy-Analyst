/**
 * Appearance: System, Light or Dark.
 *
 * The choice is a property of this phone, not of the account: it is stored in
 * `localStorage` rather than on the server, so it works for a view-only reader
 * who has never entered the passphrase, applies before the first paint, and
 * never costs a request. No new service is introduced for it.
 *
 * "System" is the default and stays live — if iOS flips to dark at sunset, so
 * does the app, without a reload.
 */

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'] as const;

/** Shared with the inline boot script in index.html — keep the two in step. */
export const STORAGE_KEY = 'fa.appearance';

/** The page background of each theme, used for the Safari toolbar tint. */
const THEME_COLOR: Record<'light' | 'dark', string> = {
  light: '#f4f6fa',
  dark: '#0d1116',
};

function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The stored preference, or System when nothing has been chosen. */
export function readAppearance(): Appearance {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isAppearance(stored) ? stored : 'system';
  } catch {
    // Private browsing can refuse storage entirely. Following the system is a
    // perfectly good answer to that, so it is not worth reporting.
    return 'system';
  }
}

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Which of the two palettes an appearance resolves to right now. */
export function resolveAppearance(mode: Appearance): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDark() ? 'dark' : 'light';
}

/**
 * Put the choice on the document.
 *
 * An explicit choice becomes `data-theme`, which the stylesheet lets win over
 * `prefers-color-scheme` in both directions. System removes the attribute
 * instead of writing the resolved value, so the media query stays in charge and
 * a later iOS change is picked up with no listener at all.
 */
export function applyAppearance(mode: Appearance): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolveAppearance(mode)]);
}

/** Persist the choice. Failure to store is not worth interrupting anyone over. */
export function storeAppearance(mode: Appearance): void {
  try {
    if (mode === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* the theme still applies for this session */
  }
}

/**
 * Watch the system appearance while System is selected, so the toolbar tint
 * follows iOS. The colours themselves are handled by CSS and need no listener.
 */
export function watchSystemAppearance(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
