/** App shell: auth gate, bottom tab navigation, shared overview state. */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type LeagueSummary, type Overview } from './api.ts';
import { Loading, Notice, formatAge } from './components/common.tsx';
import { DraftScreen } from './screens/DraftScreen.tsx';
import { PlayersScreen } from './screens/PlayersScreen.tsx';
import { ReviewScreen } from './screens/ReviewScreen.tsx';
import { SetupScreen } from './screens/SetupScreen.tsx';
import { TeamScreen } from './screens/TeamScreen.tsx';

type Tab = 'draft' | 'team' | 'players' | 'review' | 'setup';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'draft', label: 'Draft', glyph: '◈' },
  { id: 'team', label: 'Team', glyph: '▤' },
  { id: 'players', label: 'Players', glyph: '⌕' },
  { id: 'review', label: 'Review', glyph: '✓' },
  { id: 'setup', label: 'Setup', glyph: '⚙' },
];

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('draft');
  /** First load only: land on Setup when there is nothing to show yet. */
  const [, setLanded] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      if (err instanceof ApiError && err.status === 401) setAuthenticated(false);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.get<{ authenticated: boolean }>('/api/auth/status');
        setAuthenticated(status.authenticated);
      } catch {
        setAuthenticated(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (authenticated) void refresh();
  }, [authenticated, refresh]);

  if (authenticated === null) return <Loading what="session" />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-row">
          <h1>Fantasy Analyst</h1>
          <span className="header-meta">
            {overview?.selectedLeague?.name ?? 'no league'}
            {overview?.vegas ? ` · vegas ${formatAge(overview.vegas.fetchedAt)}` : ''}
          </span>
        </div>
      </header>

      <main className="app-main">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {tab === 'draft' ? <DraftScreen leagues={leagues} /> : null}
        {tab === 'team' ? <TeamScreen leagues={leagues} onLeaguesChanged={() => void refresh()} /> : null}
        {tab === 'players' ? <PlayersScreen /> : null}
        {tab === 'review' ? <ReviewScreen onChanged={() => void refresh()} /> : null}
        {tab === 'setup' ? <SetupScreen leagues={leagues} onChanged={() => void refresh()} /> : null}
      </main>

      <nav className="tabbar" aria-label="Main navigation">
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

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { passphrase });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <h1 style={{ fontSize: '1.1rem', marginBottom: 12 }}>Fantasy Analyst</h1>
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
