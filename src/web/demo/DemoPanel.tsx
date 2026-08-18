/**
 * Settings → Demo Mode: the scenario picker.
 *
 * Lazily imported by the Setup screen, and the scenario registry with it. It is
 * the only part of Demo Mode that has to know every scenario exists, so it is
 * the only part a reader who never opens it should have to download.
 */

import { useCallback, useEffect, useState } from 'react';
import { DEMO_SCENARIOS, selectableScenarios } from '../../core/demo/registry.ts';
import type { DemoGroup, DemoScenario } from '../../core/demo/types.ts';
import { Notice } from '../components/common.tsx';
import { demoSession, enterDemo, exitDemo, subscribeToDemo } from './session.ts';

/** Re-render whenever the demo is entered, changed or left. */
function useDemo() {
  const [, bump] = useState(0);
  useEffect(() => subscribeToDemo(() => bump((n) => n + 1)), []);
  return demoSession();
}

const GROUP_LABELS: Record<DemoGroup, string> = {
  draft: 'Draft night',
  'post-draft': 'After the draft',
  weekly: 'The week',
  waivers: 'Waivers',
  matchup: 'Matchup',
  trades: 'Trades',
  season: 'Playoffs and rollover',
  degraded: 'When something is missing',
};

const GROUP_ORDER: DemoGroup[] = [
  'draft',
  'post-draft',
  'weekly',
  'waivers',
  'trades',
  'matchup',
  'season',
  'degraded',
];

/**
 * Settings → Demo Mode.
 *
 * Not a tab. §4 is explicit that Demo Mode must not take a permanent slot in
 * the bottom bar — six destinations is already the most that strip of glass can
 * carry, and a seventh spent on a preview tool would be a poor trade for
 * something used once a month.
 */
export function DemoPanel() {
  const session = useDemo();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /*
   * Open whenever a demo is running.
   *
   * Choosing a scenario replaces the world, and the app shell remounts every
   * screen so nothing carries the previous scenario's data — which includes
   * this panel. Left to itself the picker would therefore snap shut under the
   * hand of somebody stepping through a progression, taking the Previous button
   * with it. The initial state is recomputed on each mount from whether a demo
   * is running, so a step reopens it; toggling is still the reader's to do.
   */
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
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    scenarios: DEMO_SCENARIOS.filter((s) => s.group === group),
  })).filter((entry) => entry.scenarios.length > 0);

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
        A read-only walk through states that are hard to reach on demand — draft night, a Tuesday
        waiver run, a late injury, a rollover in March. These are the real screens and the real
        recommendations, computed from fixture data instead of your league. Nothing in a demo can
        change a lineup, a pick, a claim, a bid or a trade, and nothing it shows is ever stored.
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {active ? <ProgressionControls scenario={active} onChoose={choose} busy={busy} /> : null}

      {grouped.map(({ group, scenarios }) => (
        <div key={group} className="demo-group">
          <div className="demo-group-title">{GROUP_LABELS[group]}</div>
          <ul className="demo-list">
            {scenarios.map((scenario) => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                active={active?.id === scenario.id}
                busy={busy === scenario.id}
                onChoose={choose}
              />
            ))}
          </ul>
        </div>
      ))}

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

      <div className="faint" style={{ marginTop: 12 }}>
        {selectableScenarios().length} scenarios can be run. A scenario listed as “waiting” is one
        whose screen does not exist in the product yet; it is shown so the list is honest about what
        is missing rather than quietly short.
      </div>
    </details>
  );
}

function ScenarioRow({
  scenario,
  active,
  busy,
  onChoose,
}: {
  scenario: DemoScenario;
  active: boolean;
  busy: boolean;
  onChoose: (id: string) => void;
}) {
  const waiting = scenario.awaiting != null;
  return (
    <li className="demo-row" data-active={active ? 'yes' : undefined}>
      <button
        type="button"
        className="demo-choose"
        data-testid={`demo-scenario-${scenario.id}`}
        disabled={waiting || busy}
        aria-current={active ? 'true' : undefined}
        onClick={() => onChoose(scenario.id)}
      >
        <span className="demo-row-head">
          <span className="demo-row-label">{scenario.label}</span>
          {/*
            State said in words as well as in a mark, because "which one is
            running" must not be a colour. `aria-current` carries it to a
            screen reader; this carries it to everybody else.
          */}
          {active ? <span className="demo-row-state">Running</span> : null}
          {waiting ? <span className="demo-row-state demo-row-waiting">Waiting</span> : null}
        </span>
        <span className="demo-row-detail faint">{scenario.description}</span>
        {waiting ? <span className="demo-row-detail faint">{scenario.awaiting!.reason}</span> : null}
      </button>
    </li>
  );
}

/**
 * Previous and next, and nothing that moves on its own.
 *
 * §11 asks for progression and is explicit that it must be explicit: no timers,
 * no background jobs, no clock that advances while nobody is looking. A
 * scenario declares which state comes before and after it, and these two
 * buttons are the only way to get there.
 */
function ProgressionControls({
  scenario,
  onChoose,
  busy,
}: {
  scenario: DemoScenario;
  onChoose: (id: string) => void;
  busy: string | null;
}) {
  if (!scenario.previous && !scenario.next) return null;
  return (
    <div className="demo-progression" data-testid="demo-progression">
      <button
        type="button"
        className="btn"
        data-testid="demo-previous"
        disabled={!scenario.previous || busy != null}
        onClick={() => scenario.previous && onChoose(scenario.previous)}
      >
        ← Previous state
      </button>
      <button
        type="button"
        className="btn"
        data-testid="demo-next"
        disabled={!scenario.next || busy != null}
        onClick={() => scenario.next && onChoose(scenario.next)}
      >
        Next state →
      </button>
    </div>
  );
}

export default DemoPanel;
