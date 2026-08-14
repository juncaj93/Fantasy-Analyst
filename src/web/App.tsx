/**
 * App shell: bottom tab navigation and shared overview state.
 *
 * There is no login wall — reading is public. Only changing settings needs the
 * passphrase, and that prompt lives inside Setup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type LeagueSummary, type Overview } from './api.ts';
import { Loading, Notice } from './components/common.tsx';
import { DraftScreen } from './screens/DraftScreen.tsx';
import { PlayersScreen } from './screens/PlayersScreen.tsx';
import { ReviewScreen } from './screens/ReviewScreen.tsx';
import { SetupScreen } from './screens/SetupScreen.tsx';
import { TradesScreen } from './screens/TradesScreen.tsx';
import { TeamScreen } from './screens/TeamScreen.tsx';

type Tab = 'draft' | 'team' | 'trades' | 'players' | 'review' | 'setup';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'draft', label: 'Draft', glyph: '◈' },
  { id: 'team', label: 'Team', glyph: '▤' },
  { id: 'trades', label: 'Trades', glyph: '⇄' },
  { id: 'players', label: 'Players', glyph: '⌕' },
  { id: 'review', label: 'Review', glyph: '✓' },
  { id: 'setup', label: 'Setup', glyph: '⚙' },
];

export function App() {
  /** Whether changes are allowed. Reading never requires this. */
  const [unlocked, setUnlocked] = useState(false);
  const [canUnlock, setCanUnlock] = useState(true);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('draft');
  /** First load only: land on Setup when there is nothing to show yet. */
  const [, setLanded] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tabbar = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ov, lg] = await Promise.all([
        api.get<Overview>('/api/overview'),
        api.get<{ leagues: LeagueSummary[] }>('/api/leagues'),
      ]);
      setOverview(ov);
      setLeagues(lg.leagues);
      setError(null);
      setLanded((already) => {
        if (!already && !ov.selectedLeague) setTab('setup');
        return true;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const checkLock = useCallback(async () => {
    try {
      const status = await api.get<{ unlocked: boolean; canUnlock: boolean }>('/api/auth/status');
      setUnlocked(status.unlocked);
      setCanUnlock(status.canUnlock);
    } catch {
      setUnlocked(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void checkLock();
    void refresh();
  }, [checkLock, refresh]);

  useTabbarHeight(tabbar);

  if (!ready) return <Loading what="Fantasy Analyst" />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-row">
          <h1>Fantasy Analyst</h1>
          <span className="header-meta">
            {overview?.selectedLeague?.name ?? 'no league'}
            {unlocked ? '' : ' · view only'}
          </span>
        </div>
      </header>

      <main className="app-main">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {tab === 'draft' ? <DraftScreen leagues={leagues} unlocked={unlocked} /> : null}
        {tab === 'team' ? <TeamScreen leagues={leagues} onLeaguesChanged={() => void refresh()} /> : null}
        {tab === 'trades' ? <TradesScreen /> : null}
        {tab === 'players' ? <PlayersScreen /> : null}
        {tab === 'review' ? <ReviewScreen onChanged={() => void refresh()} /> : null}
        {tab === 'setup' ? (
          <SetupScreen
            leagues={leagues}
            onChanged={() => void refresh()}
            unlocked={unlocked}
            canUnlock={canUnlock}
            onUnlocked={() => {
              setUnlocked(true);
              void refresh();
            }}
          />
        ) : null}
      </main>

      <nav className="tabbar" aria-label="Main navigation" ref={tabbar}>
        {TABS.map((t) => {
          const badge =
            t.id === 'review' && overview
              ? overview.pendingEvidence + overview.pendingIdentity
              : 0;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              data-testid={`tab-${t.id}`}
            >
              <span className="tab-glyph" aria-hidden="true">
                {t.glyph}
              </span>
              {t.label}
              {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Reserve exactly the space the tab bar occupies — no more, no less.
 *
 * The page used to reserve a guessed constant plus the home-indicator inset.
 * A guess is wrong in both directions: too small and the last row hides behind
 * the bar, too large and there is a strip of empty page above it that reads as
 * a black bar at the bottom of the screen. The bar knows its own height,
 * including whatever the safe-area inset added to it, so it is asked — on
 * mount, and again whenever it changes, which is what happens when Safari's
 * chrome collapses and the inset changes with it.
 */
function useTabbarHeight(ref: React.MutableRefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    /*
     * Written only when it actually changes.
     *
     * A custom property on the root element is inherited by everything, so
     * setting it invalidates the whole document's style — and the property it
     * sets changes the page's height, which is the kind of thing that makes a
     * resize observer fire again. Writing unconditionally turns that into a
     * loop that costs a repaint of every card for no change at all.
     */
    let last = -1;
    const apply = () => {
      const height = Math.round(node.getBoundingClientRect().height);
      if (height <= 0 || height === last) return;
      last = height;
      document.documentElement.style.setProperty('--tabbar-height', `${height}px`);
    };

    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
}

/** Inline unlock, shown in Setup. Nothing is hidden behind it — only changes. */
export function UnlockCard({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { passphrase });
      setPassphrase('');
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="unlock-card">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Unlock to make changes
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>
        Anyone can look at this page. Changing settings needs your passphrase — that stops a
        stranger from editing your data. You only need to do this once on this phone.
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="passphrase">Passphrase</label>
          <input
            id="passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !passphrase} style={{ width: '100%' }}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
