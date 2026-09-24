/**
 * A screen that arrives as its own chunk, and what happens when it cannot.
 *
 * The Draft screen is fetched on demand (see `App.tsx`), which adds a failure a
 * statically bundled screen never had: the fetch itself. Two real ways it
 * fails, and neither may take the whole app down with it:
 *
 * - **No signal.** A phone in a basement mid-draft. "Try again" re-requests the
 *   chunk once the signal is back.
 * - **A deploy happened under an open tab.** Chunk names are content hashes,
 *   so the old page asks for a file the new deployment no longer has, and the
 *   Worker answers with the app's HTML instead. Retrying cannot fix that;
 *   reloading picks up the new page and its new chunk names.
 *
 * Without this boundary a rejected `lazy()` import is an uncaught render error,
 * and React unmounts everything: a blank page, toolbar included.
 *
 * React caches a lazy component's result, rejection included, for the life of
 * that component object, so `onRetry` has to hand the boundary a new one; see
 * `App.tsx`.
 */

import { Component, type ReactNode } from 'react';
import { Notice } from './common.tsx';

export class ScreenLoadBoundary extends Component<
  { what: string; onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Notice tone="error" data-testid="screen-load-error">
        <div>
          {this.props.what} could not be loaded. Check your connection and try again. If it keeps
          failing, the app was probably updated since you opened it: reload to get the new version.
        </div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="screen-load-retry"
            onClick={() => {
              this.props.onRetry();
              this.setState({ failed: false });
            }}
          >
            Try again
          </button>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </Notice>
    );
  }
}
