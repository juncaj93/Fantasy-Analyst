/**
 * Add to Home Screen.
 *
 * Two surfaces over one set of words: a compact prompt that appears once in a
 * Safari tab on an iPhone, and a permanent entry in Setup for anyone who
 * dismissed it or came back later. Neither appears once the app is installed.
 *
 * The page cannot trigger the install itself — iOS has no equivalent of
 * `beforeinstallprompt`, and the Share sheet is the user's, not ours. So this
 * is instructions, honestly labelled as such, and it is the only real answer to
 * "get rid of the browser bar at the bottom": standalone mode is where those
 * pixels come back. See docs/IOS_WEB_APP.md.
 */

import { useCallback, useEffect, useState } from 'react';
import { describeViewport, formatViewportReport, type ViewportReport } from '../diagnostics.ts';
import { dismissInstall, shouldOfferInstall, watchStandalone } from '../standalone.ts';

/** The three taps, written the way iOS words them. */
function InstallSteps() {
  return (
    <ol className="install-steps" data-testid="install-steps">
      <li>
        Tap the Share button in Safari — the square with an arrow, at the bottom of the screen.
      </li>
      <li>
        Choose <strong>Add to Home Screen</strong>.
      </li>
      <li>Open Fantasy Analyst from its new icon.</li>
    </ol>
  );
}

/**
 * The one-time prompt, shown above the current screen.
 *
 * Deliberately not a permanent banner: it costs a row of the page, and the user
 * of this app has said more than once that vertical space is the scarce thing.
 * Dismissing it is permanent, and Setup keeps the instructions forever.
 */
export function InstallPrompt() {
  const [offer, setOffer] = useState(() => shouldOfferInstall(window));
  const [open, setOpen] = useState(false);

  // Launching from the icon can hand over an already-open page, so the prompt
  // has to be able to notice it is no longer needed.
  useEffect(() => watchStandalone(window, () => setOffer(shouldOfferInstall(window))), []);

  const dismiss = useCallback(() => {
    dismissInstall(window);
    setOffer(false);
  }, []);

  if (!offer) return null;

  return (
    <div className="card card-tight install-prompt" data-testid="install-prompt">
      <div className="install-prompt-row">
        <span className="install-mark" aria-hidden="true">
          ◈
        </span>
        {/* Two lines at 360px. The app's own name is not in it: the user is
            already looking at the app. */}
        <span className="install-line">Add to your Home Screen to run without Safari&rsquo;s bars.</span>
        <button
          className="btn btn-sm"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid="install-how"
        >
          {open ? 'Close' : 'How'}
        </button>
        <button className="icon-btn" onClick={dismiss} aria-label="Not now" data-testid="install-dismiss">
          ✕
        </button>
      </div>
      {open ? <InstallSteps /> : null}
    </div>
  );
}

/**
 * The permanent Setup entry.
 *
 * Says what the browser owns as well as how to install, because the question
 * this answers is usually asked as "why is there a grey bar at the bottom".
 */
export function InstallPanel() {
  return (
    <details className="card card-tight disclosure" data-testid="panel-install">
      <summary>Install on iPhone</summary>

      <div className="faint" style={{ marginTop: 8 }}>
        In a normal Safari tab the address field and the row of browser buttons sit below the page.
        They belong to Safari, not to Fantasy Analyst, and no setting in this app can remove them.
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Adding the app to your Home Screen and opening it from that icon launches it as a standalone
        app: no address field, no browser buttons, just the app and iOS&rsquo;s own status bar and home
        indicator.
      </div>

      <InstallSteps />

      <LayoutDiagnostics />
    </details>
  );
}

/**
 * The numbers behind the claim.
 *
 * Collapsed, and inside the install panel rather than loose in Setup: it is not
 * a feature, it is the evidence, and it is here so that the next person to be
 * told "there is a black bar under the nav" can settle it from the phone that
 * has the bar instead of guessing at a stylesheet.
 */
function LayoutDiagnostics() {
  // Measured when the disclosure is opened, not on mount: it is a snapshot of a
  // moving thing (Safari's chrome collapses as you scroll) and it should be a
  // snapshot of the moment somebody asked.
  const [report, setReport] = useState<ViewportReport | null>(null);

  return (
    <details
      className="disclosure"
      data-testid="layout-diagnostics"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setReport(describeViewport());
      }}
    >
      <summary>Layout diagnostics</summary>
      {report ? (
        <table className="compact" data-testid="layout-diagnostics-table">
          <tbody>
            {formatViewportReport(report).map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="faint" style={{ marginTop: 6 }}>
        &ldquo;Below the tab bar&rdquo; counts pixels this app is holding. Anything Safari draws under the
        page is not included, because the page cannot see it.
      </div>
    </details>
  );
}
