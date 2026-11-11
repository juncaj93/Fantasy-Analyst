/**
 * The preview of the rebuilt Trades screens (Round 19). Built only when the
 * preview workflow sets `VITE_PREVIEW=trades`; the live site never contains it.
 *
 * A PIN first. Then a calm start: only Trades, on the made-up preview league
 * (the same names every time), with a switch for light and dark and one for a
 * normal week and a quiet week (nothing fully fair, so the closest are shown).
 * The screens are the real ones, the same components the live site will draw.
 */

import { useEffect, useState } from 'react';
import { SegmentedControl } from '../components/native.tsx';
import { TradesScreenV2 } from '../screens/TradesScreenV2.tsx';
import { applyAppearance, readAppearance, resolveAppearance, storeAppearance } from '../theme.ts';

/** SHA-256 of the PIN, so the page carries no PIN in plain text. */
const PIN_HASH = '9cbc798b1a61514459ddaae0c12995e339d649e82ea0c2d257c11c48f2329e01';
const UNLOCK_KEY = 'fa.preview.unlocked';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wasUnlocked(): boolean {
  try {
    return window.sessionStorage.getItem(UNLOCK_KEY) === PIN_HASH;
  } catch {
    return false;
  }
}

export function PreviewApp() {
  const [unlocked, setUnlocked] = useState(wasUnlocked);
  if (!unlocked) return <PinGate onUnlock={() => setUnlocked(true)} />;
  return <PreviewTrades />;
}

function PinGate({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const submit = async () => {
    if ((await sha256(pin.trim())) === PIN_HASH) {
      try {
        window.sessionStorage.setItem(UNLOCK_KEY, PIN_HASH);
      } catch {
        /* unlocked for this page only */
      }
      onUnlock();
    } else {
      setWrong(true);
    }
  };
  return (
    <form
      className="t2-pin"
      data-testid="preview-pin"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="t2-question">Trades preview</h1>
      <input
        inputMode="numeric"
        autoComplete="off"
        aria-label="PIN"
        placeholder="PIN"
        value={pin}
        onChange={(e) => {
          setPin(e.target.value);
          setWrong(false);
        }}
        data-testid="preview-pin-input"
      />
      {wrong ? <div className="t2-note">That PIN is not right.</div> : null}
      <button type="submit" className="btn btn-primary" data-testid="preview-pin-go">
        Open
      </button>
    </form>
  );
}

function PreviewTrades() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveAppearance(readAppearance()));
  const [week, setWeek] = useState<'normal' | 'quiet'>('normal');
  useEffect(() => {
    applyAppearance(theme);
    storeAppearance(theme);
  }, [theme]);
  return (
    <main className="app-main" data-testid="preview-trades">
      <div className="t2-preview-bar">
        <SegmentedControl<'light' | 'dark'>
          label="Light or dark"
          value={theme}
          onChange={setTheme}
          testId="preview-theme"
          segments={[
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ]}
        />
        <SegmentedControl<'normal' | 'quiet'>
          label="Which week"
          value={week}
          onChange={setWeek}
          testId="preview-week"
          segments={[
            { id: 'normal', label: 'Normal' },
            { id: 'quiet', label: 'Quiet' },
          ]}
        />
      </div>
      <TradesScreenV2 key={week} resetNonce={0} query={week === 'quiet' ? 'week=quiet' : ''} />
    </main>
  );
}
