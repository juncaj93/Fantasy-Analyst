/**
 * The indicator, and nothing else.
 *
 * §1 is explicit: Demo Mode is a data-source substitution layer, not a second
 * app. It does not get its own Draft, its own Team, its own cards or its own
 * sheets — it gets the product's, over different data. So the whole of its
 * interface is this bar and a panel in Settings for choosing a scenario, and
 * the two are in separate files because only this one is wanted on every page
 * load: the picker, and the scenario registry behind it, are fetched when
 * somebody opens Settings and never before (§17).
 */

import { useEffect, useState } from 'react';
import { demoSession, exitDemo, subscribeToDemo } from './session.ts';

/** Re-render whenever the demo is entered, changed or left. */
function useDemo() {
  const [, bump] = useState(0);
  useEffect(() => subscribeToDemo(() => bump((n) => n + 1)), []);
  return demoSession();
}

/**
 * The indicator.
 *
 * Pinned above everything, on every screen, for as long as a scenario is
 * running — because the failure this prevents is somebody reading a fixture as
 * if it were their league. It says the word DEMO, names the scenario and prints
 * the scenario's own clock, so the state is conveyed by text and structure and
 * not by colour alone (§4, §16). The exit is in it rather than three taps away
 * in Settings, for the same reason.
 */
export function DemoIndicator() {
  const session = useDemo();
  const [busy, setBusy] = useState(false);
  if (!session) return null;

  const { scenario } = session;
  const asOf = new Date(scenario.asOf);

  return (
    <div className="demo-bar" role="status" aria-live="polite" data-testid="demo-bar">
      <span className="demo-badge" data-testid="demo-badge">
        DEMO
      </span>
      {/*
        The scenario and its clock, on one line.

        This used to read `Sunday, 11:40am · Fixture data, as of Sun, Oct 11,
        03:40 PM UTC` and wrapped to three lines on a 390px phone — a hundred
        pixels of the most valuable strip on the screen, above every navigation
        bar in the app, spent on a caption. Two of those words did no work:
        `Fixture data` is what the DEMO badge to its left already says, and the
        weekday and month are in the scenario's own label.

        What is left is the pair a reader actually checks — which scenario, and
        what time it thinks it is — and the whole thing is one line that
        truncates rather than a paragraph that reflows. The full timestamp is in
        the `time` element's `dateTime` and in the tooltip, so nothing is lost
        to anything reading it properly.
      */}
      <span className="demo-what">
        <strong data-testid="demo-scenario">{scenario.label}</strong>
        <span className="faint">
          {' · '}
          <time dateTime={scenario.asOf} title={asOf.toUTCString()}>
            {asOf.toLocaleString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'UTC',
            })}{' '}
            UTC
          </time>
        </span>
      </span>
      <button
        type="button"
        className="btn demo-exit"
        data-testid="demo-exit"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void exitDemo().finally(() => setBusy(false));
        }}
      >
        {busy ? 'Leaving…' : 'Leave'}
      </button>
    </div>
  );
}

/**
 * Which world the app is looking at: a scenario id, or `'live'`.
 *
 * A string rather than a boolean, and that distinction is load-bearing. Two
 * scenarios are two different worlds — different week, different clock,
 * different wallet — but they share a league id, so a screen keyed on "which
 * league" would keep the previous scenario's board on screen while the
 * indicator above it named the new one. Keying the app shell on this instead
 * makes stepping from Tuesday to Wednesday a remount, which is what it actually
 * is.
 */
export function useDemoWorld(): string {
  const [, bump] = useState(0);
  useEffect(() => subscribeToDemo(() => bump((n) => n + 1)), []);
  return demoSession()?.scenario.id ?? 'live';
}
