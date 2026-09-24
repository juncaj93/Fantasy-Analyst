/**
 * Settings → Demo Mode.
 *
 * Lazily imported by the Setup screen, and the scenario list with it, so a
 * reader who never opens it downloads none of it.
 *
 * Demo Mode is a placeholder now: one sample week, so there is something to
 * show, and a place for a future round to demo one new feature. See
 * `core/demo/placeholder/index.ts`. The list below renders whatever that module
 * declares, so a second scenario needs no change here.
 */

import { useCallback, useEffect, useState } from 'react';
import { DEMO_SHOWCASES, type DemoShowcase } from '../../core/demo/placeholder/index.ts';
import { Notice } from '../components/common.tsx';
import { demoSession, enterDemo, exitDemo, subscribeToDemo } from './session.ts';

/** Re-render whenever the demo is entered, changed or left. */
function useDemo() {
  const [, bump] = useState(0);
  useEffect(() => subscribeToDemo(() => bump((n) => n + 1)), []);
  return demoSession();
}

export function DemoPanel() {
  const session = useDemo();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(() => demoSession() != null);

  const choose = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await enterDemo(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const active = session?.scenario ?? null;

  return (
    <details
      className="card"
      data-testid="demo-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="section-title">
        Demo Mode
        {active ? <span className="demo-badge demo-badge-small">ON</span> : null}
      </summary>

      <div className="faint" style={{ margin: '8px 0 12px' }}>
        A read-only look at the app with a sample league instead of yours. Nothing in a demo can
        change a lineup, a claim, a bid or a trade, and nothing it shows is ever stored.
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <ul className="demo-list">
        {DEMO_SHOWCASES.map((scenario) => (
          <ScenarioRow
            key={scenario.id}
            scenario={scenario}
            active={active?.id === scenario.id}
            busy={busy === scenario.id}
            onChoose={choose}
          />
        ))}
      </ul>

      {active ? (
        <button
          type="button"
          className="btn"
          style={{ width: '100%', marginTop: 12 }}
          data-testid="demo-exit-panel"
          onClick={() => void exitDemo()}
        >
          Leave Demo Mode
        </button>
      ) : null}
    </details>
  );
}

function ScenarioRow({
  scenario,
  active,
  busy,
  onChoose,
}: {
  scenario: DemoShowcase;
  active: boolean;
  busy: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <li className="demo-row" data-active={active ? 'yes' : undefined}>
      <button
        type="button"
        className="demo-choose"
        data-testid={`demo-scenario-${scenario.id}`}
        disabled={busy}
        aria-current={active ? 'true' : undefined}
        onClick={() => onChoose(scenario.id)}
      >
        <span className="demo-row-head">
          <span className="demo-row-label">{scenario.label}</span>
          {/*
            State said in words as well as in a mark, because "which one is
            running" must not be a colour.
          */}
          {active ? <span className="demo-row-state">Running</span> : null}
        </span>
        <span className="demo-row-detail faint">{scenario.description}</span>
      </button>
    </li>
  );
}

export default DemoPanel;
