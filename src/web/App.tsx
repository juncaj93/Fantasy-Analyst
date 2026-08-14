/**
 * App shell: bottom tab navigation and shared overview state.
 *
 * There is no login wall — reading is public. Only changing settings needs the
 * passphrase, and that prompt lives inside Setup.
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { api, type LeagueSummary, type Overview } from './api.ts';
import { Loading, Notice } from './components/common.tsx';
import { BoardIcon, GearIcon, ReviewIcon, RosterIcon, SearchIcon, TradeIcon } from './components/icons.tsx';
import { InstallPrompt } from './components/install.tsx';
import { DraftScreen } from './screens/DraftScreen.tsx';
import { PlayersScreen } from './screens/PlayersScreen.tsx';
import { ReviewScreen } from './screens/ReviewScreen.tsx';
import { SetupScreen } from './screens/SetupScreen.tsx';
import { TradesScreen } from './screens/TradesScreen.tsx';
import { TeamScreen } from './screens/TeamScreen.tsx';

type Tab = 'draft' | 'team' | 'trades' | 'players' | 'review' | 'setup';

/*
 * The six destinations, unchanged.
 *
 * The glyphs are drawn rather than typed — see components/icons.tsx. Two of the
 * six characters this used to print were being resolved to colour emoji on a
 * phone, which put a blue gear and a green tick in a row of grey marks at a
 * size and weight no stylesheet could reach.
 */
const TABS: { id: Tab; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'draft', label: 'Draft', Icon: BoardIcon },
  { id: 'team', label: 'Team', Icon: RosterIcon },
  { id: 'trades', label: 'Trades', Icon: TradeIcon },
  { id: 'players', label: 'Players', Icon: SearchIcon },
  { id: 'review', label: 'Review', Icon: ReviewIcon },
  { id: 'setup', label: 'Setup', Icon: GearIcon },
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
  const measureTabbar = useTabbarHeight();

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

  if (!ready) return <Loading what="Fantasy Analyst" />;

  /*
   * No banner.
   *
   * A two-line header saying "Fantasy Analyst" and the league name sat above
   * every page, and both halves were already somewhere better: the product name
   * is the app the user opened, and the league name is printed by the one screen
   * that is actually talking about a league. On a phone it cost ~40px of every
   * screen to repeat what the screen underneath was about to say.
   *
   * The one thing it carried that nothing else did is whether changes are
   * possible at all, and that has moved to the Setup tab — where unlocking
   * happens — as a mark rather than a sentence.
   */
  const viewOnly = !unlocked && canUnlock;

  return (
    <div className="app">
      <main className="app-main">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {/* Once, on an iPhone, in a Safari tab. Silent everywhere else. */}
        <InstallPrompt />
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

      <nav className="tabbar" aria-label="Main navigation" ref={measureTabbar}>
        {TABS.map((t) => {
          const badge =
            t.id === 'review' && overview
              ? overview.pendingEvidence + overview.pendingIdentity
              : 0;
          // Where unlocking happens is where "you cannot change anything yet"
          // belongs. A dot, not a word, because it is a state and not a task.
          const locked = t.id === 'setup' && viewOnly;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              aria-label={locked ? `${t.label} — view only, unlock to make changes` : undefined}
              data-testid={`tab-${t.id}`}
            >
              <span className="tab-glyph" aria-hidden="true">
                <t.Icon />
              </span>
              {t.label}
              {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
              {locked ? <span className="tab-lock" data-testid="view-only" aria-hidden="true" /> : null}
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
 *
 * **A callback ref, not an effect over a ref object, and that is the whole
 * point.** This was written as `useEffect(..., [ref])`, which runs once after
 * the first render — and on the first render the app is still showing its
 * loading state, so there is no bar in the document and `ref.current` is null.
 * The effect bailed, its dependency never changed, and it never ran again: the
 * measurement had simply never happened. The page spent every session
 * reserving the 50px fallback for a bar that is 45px without a home indicator
 * and 62px with one — over-reserving on a desktop, and hiding the last row
 * behind the bar on a phone.
 *
 * A callback ref runs when the node actually arrives, which is the event this
 * cares about.
 */
function useTabbarHeight(): (node: HTMLElement | null) => void {
  const dispose = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    dispose.current?.();
    dispose.current = null;
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
      dispose.current = () => window.removeEventListener('resize', apply);
      return;
    }
    /*
     * Observed as a border box, which is the difference between working and
     * not.
     *
     * A ResizeObserver watches the *content* box unless told otherwise, and
     * everything that changes this bar's height changes its padding: the whole
     * mechanism is `padding-bottom: var(--nav-inset)`. The content box — a row
     * of 44px buttons — never moves. So the observer sat there, correctly
     * reporting that nothing had changed, through exactly the event it exists
     * to catch: Safari's chrome collapsing, the inset going from 0 to 34, and
     * the bar growing by 17px that the page then failed to reserve.
     */
    const observer = new ResizeObserver(apply);
    observer.observe(node, { box: 'border-box' });
    dispose.current = () => observer.disconnect();
  }, []);
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
