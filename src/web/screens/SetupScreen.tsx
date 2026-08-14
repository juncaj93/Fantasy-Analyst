/**
 * Setup — the whole configuration experience in plain language.
 *
 * Deliberately free of developer vocabulary: no endpoints, no JSON, no
 * bindings. Anything that genuinely needs a terminal lives in the docs, not
 * here; this screen only shows what the user can do from their phone.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type NewsletterMessage,
  type NewsletterStatus,
  type RepairStatus,
  type ReprocessPreview,
  type SetupStatus,
} from '../api.ts';
import { Badge, Empty, Loading, Notice, formatAge, formatDate } from '../components/common.tsx';
import { PlayerPicker } from './ReviewScreen.tsx';
import { UnlockCard } from '../App.tsx';
import {
  APPEARANCES,
  APPEARANCE_LABELS,
  applyAppearance,
  readAppearance,
  storeAppearance,
  watchSystemAppearance,
  type Appearance,
} from '../theme.ts';

type Panel = 'sleeper' | 'league' | 'adp' | 'newsletter' | 'vegas' | null;

const STATE_ICON: Record<string, string> = { ok: '✅', warn: '⚠️', todo: '○', off: '○' };

export function SetupScreen({
  leagues,
  onChanged,
  unlocked,
  canUnlock,
  onUnlocked,
}: {
  leagues: LeagueSummary[];
  onChanged: () => void;
  unlocked: boolean;
  canUnlock: boolean;
  onUnlocked: () => void;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [open, setOpen] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<SetupStatus>('/api/setup/status'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = () => {
    void load();
    onChanged();
  };

  if (!status) return error ? <Notice tone="error">{error}</Notice> : <Loading what="your setup" />;

  return (
    <>
      <div className="card card-tight">
        <strong>Fantasy Analyst Setup</strong>
        <div className="faint">
          {status.readyForDraft
            ? 'Everything needed for draft day is ready.'
            : 'Work through anything marked below. Tap a row to open it.'}
        </div>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {unlocked ? null : canUnlock ? (
        <UnlockCard onUnlocked={onUnlocked} />
      ) : (
        <Notice>
          This site is view-only: no passphrase has been set up, so settings cannot be changed here.
        </Notice>
      )}

      <AppearanceCard />

      {status.steps.map((step) => (
        <button
          key={step.id}
          className="player-row"
          data-testid={`setup-step-${step.id}`}
          data-state={step.state}
          aria-expanded={open === step.id}
          onClick={() => setOpen(open === step.id ? null : (step.id as Panel))}
        >
          <div className="player-row-top">
            <span className="rank" aria-hidden="true">
              {STATE_ICON[step.state] ?? '○'}
            </span>
            <span className="player-name">{step.title}</span>
            <span className="row-action">{open === step.id ? 'Close' : 'Open'}</span>
          </div>
          <div className="player-row-metrics">
            <span className="metric">{step.summary}</span>
          </div>
          {step.action ? <div className="faint">{step.action}</div> : null}
        </button>
      ))}

      {open === 'sleeper' ? <SleeperPanel status={status} onDone={refreshAll} /> : null}
      {open === 'league' ? <LeaguePanel leagues={leagues} onDone={refreshAll} /> : null}
      {open === 'adp' ? <AdpPanel status={status} onDone={refreshAll} /> : null}
      {open === 'newsletter' ? <NewsletterPanel onDone={refreshAll} /> : null}
      {open === 'vegas' ? <VegasPanel status={status} /> : null}

      <HelpMyScores onChanged={refreshAll} />
    </>
  );
}

/**
 * Appearance: System, Light or Dark.
 *
 * A preference of this phone rather than of the account, so it is kept on the
 * device: it works for a view-only reader, needs no passphrase, and costs no
 * request. Choosing one applies immediately — no reload, and nothing else on
 * screen changes state.
 */
function AppearanceCard() {
  const [mode, setMode] = useState<Appearance>(() => readAppearance());

  useEffect(() => {
    applyAppearance(mode);
    // While System is selected the stylesheet follows the phone on its own;
    // this only keeps the Safari toolbar tint in step when iOS flips.
    return watchSystemAppearance(() => applyAppearance(mode));
  }, [mode]);

  return (
    <div className="card card-tight" data-testid="appearance">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Appearance
      </div>
      <div className="segmented" role="group" aria-label="Appearance">
        {APPEARANCES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            data-testid={`appearance-${option}`}
            onClick={() => {
              storeAppearance(option);
              setMode(option);
            }}
          >
            {APPEARANCE_LABELS[option]}
          </button>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        System follows your phone, and keeps following it when your phone changes at sunset. Light and
        Dark stay exactly as you set them here, on this phone.
      </div>
    </div>
  );
}

/**
 * Help My Scores.
 *
 * Names the matcher would not guess at, and what they are costing. Deliberately
 * placed at the bottom of Setup and self-hiding when there is nothing to fix:
 * it should be impossible to miss when it matters and invisible when it does
 * not.
 */
function HelpMyScores({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<RepairStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<RepairStatus>('/api/repair'));
    } catch {
      // Nothing to show is the same as nothing to fix, as far as this card goes.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = async (alias: string, playerId: string) => {
    const result = await api.post<{ alias: string; resolved: number; net: number }>('/api/repair/assign', {
      alias,
      playerId,
    });
    setMessage(
      `${result.alias} matched — ${result.resolved} ${result.resolved === 1 ? 'item' : 'items'} now count, ` +
        `lifetime tally ${result.net > 0 ? '+' : ''}${result.net}.`,
    );
    await load();
    onChanged();
  };

  if (!status || status.summary.names === 0) return null;

  return (
    <>
      <button
        className="player-row"
        data-testid="help-my-scores"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <div className="player-row-top">
          <span className="rank" aria-hidden="true">
            !
          </span>
          <span className="player-name">Help my scores</span>
          <span className="row-action">{open ? 'Close' : 'Fix'}</span>
        </div>
        <div className="player-row-metrics">
          <span className="metric">{status.summary.headline}</span>
        </div>
      </button>

      {open ? (
        <div className="card">
          {message ? <Notice tone="ok">{message}</Notice> : null}
          <div className="faint" style={{ marginBottom: 8 }}>
            These names appeared in your newsletters but could not be matched to a Sleeper player, so their
            news is not counting for anyone. Pick who each one is.
          </div>

          {status.groups.map((group) => (
            <div key={group.normalizedAlias} className="card card-tight" data-testid={`repair-${group.normalizedAlias}`}>
              <div className="header-row">
                <strong>{group.alias}</strong>
                <span className="faint">
                  {group.items} {group.items === 1 ? 'item' : 'items'} ·{' '}
                  {group.net > 0 ? '+' : ''}
                  {group.net} net
                  {group.net30 !== 0 ? ` (${group.net30 > 0 ? '+' : ''}${group.net30} in 30d)` : ''}
                </span>
              </div>
              <div className="faint" style={{ margin: '4px 0 8px' }}>
                “{group.example}”
              </div>

              {status.suspicions.some((sus) => sus.alias === group.alias) ? (
                <Notice>
                  Likely {status.suspicions.find((sus) => sus.alias === group.alias)!.candidate.name}, who currently
                  has no tally at all.
                </Notice>
              ) : null}

              {group.candidates.slice(0, 3).map((candidate) => (
                <button
                  key={candidate.playerId}
                  className="btn"
                  style={{ marginRight: 6, marginBottom: 6 }}
                  onClick={() => void assign(group.alias, candidate.playerId)}
                >
                  {candidate.name} · {candidate.position} {candidate.team}
                </button>
              ))}

              <PlayerPicker
                fieldId={`repair-${group.normalizedAlias}`}
                label="Or search for the right player"
                onPick={(playerId) => assign(group.alias, playerId)}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Shared busy/message handling for the panels. */
function usePanelAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const banner = message ? (
    <Notice tone={message.tone === 'ok' ? 'ok' : 'error'}>{message.text}</Notice>
  ) : null;

  return { busy, run, banner };
}

function SleeperPanel({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [username, setUsername] = useState(status.sleeper.username ?? '');
  const [season, setSeason] = useState(String(new Date().getFullYear()));

  return (
    <div className="card" data-testid="panel-sleeper">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Connect Sleeper
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>
        Fantasy Analyst reads your league from Sleeper. It never makes picks or changes your lineup.
      </div>
      {banner}

      <div className="field">
        <label htmlFor="setup-username">Your Sleeper username</label>
        <input
          id="setup-username"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. alexfootball"
        />
      </div>
      <div className="field">
        <label htmlFor="setup-season">Season</label>
        <input id="setup-season" value={season} inputMode="numeric" onChange={(e) => setSeason(e.target.value)} />
      </div>

      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={!username || busy != null}
          onClick={() =>
            run('connect', async () => {
              const res = await api.post<{ leaguesImported: number }>('/api/sleeper/connect', { username, season });
              onDone();
              return res.leaguesImported > 0
                ? `Connected. Found ${res.leaguesImported} league${res.leaguesImported === 1 ? '' : 's'} for ${season}.`
                : `Connected, but no leagues were found for ${season}. Try a different season.`;
            })
          }
        >
          {status.sleeper.connected ? 'Reconnect' : 'Connect'}
        </button>
        <button
          className="btn"
          disabled={busy != null}
          onClick={() =>
            run('players', async () => {
              const res = await api.post<{ total: number }>('/api/sleeper/sync-players');
              onDone();
              return `Player list updated — ${res.total} players available.`;
            })
          }
        >
          {busy === 'players' ? 'Updating…' : 'Update player list'}
        </button>
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        The player list is how Fantasy Analyst recognises names in your newsletter. Update it once
        before your draft, and occasionally during the season.
        {status.sleeper.playersSynced > 0 ? ` Currently ${status.sleeper.playersSynced} players.` : ''}
      </div>
    </div>
  );
}

function LeaguePanel({ leagues, onDone }: { leagues: LeagueSummary[]; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();

  return (
    <div className="card" data-testid="panel-league">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Choose your league
      </div>
      {banner}
      {leagues.length === 0 ? (
        <Empty>Connect Sleeper first, then your leagues appear here.</Empty>
      ) : (
        leagues.map((l) => (
          <div className="card card-tight" key={l.id} data-testid="setup-league-card">
            <div className="header-row">
              <div>
                <strong>{l.name}</strong>
                <div className="faint">
                  {l.season} · {l.teams} teams · {l.scoringLabel}
                </div>
              </div>
              <button
                className={l.isSelected ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
                disabled={l.isSelected || busy != null}
                onClick={() =>
                  run(`select-${l.id}`, async () => {
                    await api.post(`/api/leagues/${l.id}/select`);
                    onDone();
                    return `Using ${l.name}.`;
                  })
                }
              >
                {l.isSelected ? '✓ In use' : 'Use this'}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function AdpPanel({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [content, setContent] = useState('');
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<{
    created: boolean;
    matched: number;
    ambiguous: number;
    unmatched: number;
    skipped: { rowNumber: number; reason: string }[];
  } | null>(null);

  const importNow = () =>
    run('adp', async () => {
      const res = await api.post<{
        created: boolean;
        matched: number;
        ambiguous: number;
        unmatched: number;
        skipped: { rowNumber: number; reason: string }[];
      }>('/api/adp/import', { content, label: label || undefined });
      setResult(res);
      setContent('');
      onDone();
      return res.created
        ? `Imported ${res.matched} players.`
        : 'That exact file was already imported, so nothing changed.';
    });

  return (
    <div className="card" data-testid="panel-adp">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Draft order
      </div>
      <div className="card card-tight" data-testid="adp-source">
        <strong>{status.adp.imported ? `Using ${status.adp.label}` : 'No rankings imported yet'}</strong>
        <div className="faint">
          Sleeper does not publish average draft position, so the draft order has to come from a
          rankings file you import here.
        </div>
        <div className="faint" style={{ marginTop: 4 }}>
          Without one, the draft board still ranks by news and roster need — it just cannot tell you
          whether a player is likely to last until your next pick.
        </div>
      </div>
      {banner}

      {status.adp.imported ? (
        <div className="card card-tight">
          <strong>In use: {status.adp.label}</strong>
          <div className="faint">
            Captured {formatDate(status.adp.capturedAt)} · {status.adp.matched} of {status.adp.totalRows} players
            matched
            {status.adp.unresolved > 0 ? ` · ${status.adp.unresolved} not recognised` : ''}
          </div>
        </div>
      ) : null}

      <details style={{ marginTop: 10 }} open={!status.adp.imported}>
        <summary className="muted">Import rankings</summary>
        <div className="faint" style={{ margin: '6px 0' }}>
          A CSV with player names and a rank or ADP column. The newest import is the one used.
        </div>

      <div className="field">
        <label htmlFor="adp-file">Choose a file</label>
        <input
          id="adp-file"
          type="file"
          accept=".csv,.json,text/csv,application/json,text/plain"
          data-testid="adp-file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setContent(await file.text());
            if (!label) setLabel(file.name.replace(/\.[a-z]+$/i, ''));
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="adp-label">Name this snapshot (optional)</label>
        <input id="adp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My rankings — today" />
      </div>

      <div className="field">
        <label htmlFor="adp-content">…or paste the file contents</label>
        <textarea
          id="adp-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"name,position,team,adp\nJa'Marr Chase,WR,CIN,1.4"}
        />
      </div>

      <button className="btn btn-primary" disabled={!content || busy != null} onClick={importNow}>
        {busy === 'adp' ? 'Importing…' : status.adp.imported ? 'Replace rankings' : 'Import rankings'}
      </button>

      {result ? (
        <div className="card card-tight" data-testid="adp-result" style={{ marginTop: 8 }}>
          <table className="compact">
            <tbody>
              <tr>
                <td>Matched to a player</td>
                <td>{result.matched}</td>
              </tr>
              <tr>
                <td>Needs a decision (more than one match)</td>
                <td>{result.ambiguous}</td>
              </tr>
              <tr>
                <td>Not recognised</td>
                <td>{result.unmatched}</td>
              </tr>
              <tr>
                <td>Rows skipped</td>
                <td>{result.skipped.length}</td>
              </tr>
            </tbody>
          </table>
          {result.skipped.length > 0 ? (
            <div className="faint" style={{ marginTop: 6 }}>
              Skipped rows: {result.skipped.slice(0, 5).map((s) => `row ${s.rowNumber} (${s.reason})`).join(', ')}
              {result.skipped.length > 5 ? '…' : ''}
            </div>
          ) : null}
          <div className="faint" style={{ marginTop: 6 }}>
            Unrecognised players are kept, not thrown away — they simply have no ranking until you
            match them.
          </div>
        </div>
      ) : null}
      </details>
    </div>
  );
}

function NewsletterPanel({ onDone }: { onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [status, setStatus] = useState<NewsletterStatus | null>(null);
  const [sender, setSender] = useState('');
  /** True when the saved rule is the wildcard rather than a specific sender. */
  const acceptsAll = (status?.expectedSenders ?? []).includes('*');
  const [subject, setSubject] = useState('');
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const next = await api.get<NewsletterStatus>('/api/setup/newsletter');
    setStatus(next);
    setSender(next.expectedSenders.find((s) => s !== '*' && !s.includes('example')) ?? '');
    setSubject(next.subjectFilters[0] ?? '');
    setAddress(next.address ?? '');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return <Loading what="newsletter status" />;

  const copy = async () => {
    if (!status.address) return;
    try {
      await navigator.clipboard.writeText(status.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="card" data-testid="panel-newsletter">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Newsletter intelligence
      </div>
      {banner}

      {/* --- the address ------------------------------------------------ */}
      {status.addressConfigured ? (
        <div className="card card-tight">
          <div className="faint">Your Fantasy Analyst email address</div>
          <div style={{ fontSize: '1rem', fontWeight: 650, wordBreak: 'break-all' }} data-testid="newsletter-address">
            {status.address}
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => void copy()}>
              {copied ? '✓ Copied' : 'Copy address'}
            </button>
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            Subscribe your FF Newsletter to this address. Every future issue is read automatically —
            you never need to forward anything.
          </div>
        </div>
      ) : (
        <Notice>
          <strong>Email address not ready yet.</strong>
          <div style={{ marginTop: 4 }}>
            This needs a one-time email setup on your domain (about 10 minutes, done once). The
            written steps are in the project's SETUP guide under “Turn on the newsletter address”.
            Once it is done, the address appears here.
          </div>
        </Notice>
      )}

      {/* --- which sender to trust -------------------------------------- */}
      <div className="section-title">Which newsletter to accept</div>
      <div className="faint" style={{ marginBottom: 6 }}>
        Only mail from this sender is read. Anything else that arrives is ignored and never affects
        your players.
      </div>
      {/* Subscribing is easier than looking up a sender address: the first
          issue arrives, is ignored because no sender is expected yet, and its
          real address is right there to accept in one tap. */}
      {ignoredSender(status) ? (
        <div className="card card-tight" data-testid="offer-sender">
          <div>
            Mail arrived from <strong>{ignoredSender(status)}</strong> and was ignored, because you have
            not said it is expected.
          </div>
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 6 }}
            disabled={busy != null}
            data-testid="accept-sender"
            onClick={() =>
              run('accept-sender', async () => {
                const from = ignoredSender(status)!;
                const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { senderEmail: from });
                setStatus(next);
                setSender(from);
                onDone();
                return `Saved. Mail from ${from} will be read from now on.`;
              })
            }
          >
            Accept mail from this sender
          </button>
          <div className="faint" style={{ marginTop: 4 }}>
            Only do this if you recognise it as your newsletter. The issue that was ignored is not
            read retrospectively; the next one will be.
          </div>
        </div>
      ) : null}

      {/*
        Offered first, and recommended: this address is dedicated and
        unpublished, so taking whatever arrives is both true and safer than a
        filter that can drop a week of evidence without saying anything.
      */}
      <div className="faint" style={{ marginBottom: 6 }}>
        Nothing else uses this address, so anything arriving here is your newsletter. A sender filter can miss
        issues silently — Substack sends from a different address for every subscriber.
      </div>
      <button
        className="btn btn-primary"
        style={{ marginBottom: 12 }}
        disabled={busy != null || acceptsAll}
        data-testid="accept-any-sender"
        onClick={() =>
          run('sender', async () => {
            const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { senderEmail: '*' });
            setStatus(next);
            onDone();
            return 'Every email sent to this address will now be read.';
          })
        }
      >
        {acceptsAll ? 'Accepting every sender' : 'Accept every email sent here'}
      </button>

      <div className="field">
        <label htmlFor="nl-sender">Or only accept one sender (address or domain)</label>
        <input
          id="nl-sender"
          value={sender}
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="email"
          onChange={(e) => setSender(e.target.value)}
          placeholder="e.g. newsletter@theirsite.com"
        />
      </div>
      <div className="field">
        <label htmlFor="nl-subject">Only if the subject contains (optional)</label>
        <input id="nl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="leave blank to accept every issue" />
      </div>
      <button
        className="btn btn-primary"
        disabled={!sender || busy != null}
        onClick={() =>
          run('sender', async () => {
            const next = await api.post<NewsletterStatus>('/api/setup/newsletter', {
              senderEmail: sender,
              subjectContains: subject,
            });
            setStatus(next);
            onDone();
            return 'Saved. Mail from that sender will now be read.';
          })
        }
      >
        Save sender
      </button>

      {/* --- manual address override ------------------------------------ */}
      <details style={{ marginTop: 10 }}>
        <summary className="muted">Set the address manually</summary>
        <div className="faint" style={{ margin: '6px 0' }}>
          Only needed if you finished the email setup with a different address than the one shown.
        </div>
        <div className="field">
          <label htmlFor="nl-address">Fantasy Analyst email address</label>
          <input
            id="nl-address"
            value={address}
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="email"
            onChange={(e) => setAddress(e.target.value)}
            placeholder="fantasy-news@yourdomain.com"
          />
        </div>
        <button
          className="btn btn-sm"
          disabled={busy != null}
          onClick={() =>
            run('address', async () => {
              const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { inboundAddress: address });
              setStatus(next);
              onDone();
              return address ? `Address set to ${address}.` : 'Address cleared.';
            })
          }
        >
          Save address
        </button>
      </details>

      {/* --- activity ---------------------------------------------------- */}
      <div className="section-title">Activity</div>
      <table className="compact" data-testid="newsletter-activity">
        <tbody>
          <tr>
            <td>Last email received</td>
            <td>
              {status.lastReceivedAt ? (
                <>
                  {formatAge(status.lastReceivedAt)}
                  <div className="faint">
                    {status.lastReceivedFrom} · {status.lastReceivedStatus}
                  </div>
                </>
              ) : (
                'nothing yet'
              )}
            </td>
          </tr>
          <tr>
            <td>Last newsletter read</td>
            <td>{status.lastProcessedAt ? formatAge(status.lastProcessedAt) : 'none yet'}</td>
          </tr>
          <tr>
            <td>News items found</td>
            <td>{status.totals.evidenceItems}</td>
          </tr>
          <tr>
            <td>Good news applied</td>
            <td>{status.totals.autoAppliedPositive}</td>
          </tr>
          <tr>
            <td>Bad news applied</td>
            <td>{status.totals.autoAppliedNegative}</td>
          </tr>
          <tr>
            <td>Waiting for your review</td>
            <td>{status.totals.needsReview}</td>
          </tr>
          <tr>
            <td>Ignored (unexpected sender)</td>
            <td>{status.totals.quarantined}</td>
          </tr>
        </tbody>
      </table>

      {status.lastProcessedDetail ? (
        <div className="faint" style={{ marginTop: 6 }}>
          Last issue: {status.lastProcessedDetail}
        </div>
      ) : null}
      {status.lastError ? (
        <Notice tone="error">Last problem: {status.lastError}</Notice>
      ) : null}

      <NewsletterHistory />
    </div>
  );
}

/**
 * Recent emails plus how much of each one the parser understood.
 *
 * Unread sentences are not failures — they are usually ordinary prose. Showing
 * them is how the rule list gets better over time.
 */
function NewsletterHistory() {
  const [messages, setMessages] = useState<NewsletterMessage[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ messages: NewsletterMessage[] }>('/api/newsletter/messages');
      setMessages(res.messages);
    })();
  }, []);

  if (!messages) return null;

  return (
    <>
      <div className="section-title">Recent emails</div>
      {messages.length === 0 ? (
        <div className="faint">Nothing has arrived at this address yet.</div>
      ) : (
        messages.map((m) => {
          const c = m.coverage ?? {};
          const understood = c.classifiedSentences ?? 0;
          const missed = c.unclassifiedSentences ?? 0;
          return (
            // The row header is the button; the detail is a sibling, because a
            // button may not contain the buttons the reprocess panel needs.
            <div key={m.messageId} data-testid="newsletter-message" data-status={m.status}>
              <button
                className="player-row"
                data-testid="newsletter-message-toggle"
                aria-expanded={open === m.messageId}
                onClick={() => setOpen(open === m.messageId ? null : m.messageId)}
              >
                <div className="player-row-top">
                  <span className="player-name">{m.subject || '(no subject)'}</span>
                  <span className="row-action">{formatDate(m.receivedAt)}</span>
                </div>
                <div className="player-row-metrics">
                  <Badge tone={m.status === 'processed' ? 'pos' : m.status === 'quarantined' ? 'warn' : 'neg'}>
                    {m.status === 'processed' ? 'read' : m.status === 'quarantined' ? 'ignored' : m.status}
                  </Badge>
                  <span className="metric">{m.evidenceCount} news item(s)</span>
                  {m.pendingCount > 0 ? <span className="metric">{m.pendingCount} to review</span> : null}
                </div>
              </button>
              {open === m.messageId ? (
                <div className="explain">
                  {m.detail ? <div className="muted">{m.detail}</div> : null}
                  {m.rejectReason ? <div className="muted">{m.rejectReason}</div> : null}
                  {m.status === 'processed' ? (
                    <>
                      <table className="compact" style={{ marginTop: 6 }}>
                        <tbody>
                          <tr>
                            <td>Sentences about your players</td>
                            <td>{c.sentencesWithPlayers ?? 0}</td>
                          </tr>
                          <tr>
                            <td>Turned into a signal</td>
                            <td>{understood}</td>
                          </tr>
                          <tr>
                            <td>Read but no rule matched</td>
                            <td>{missed}</td>
                          </tr>
                          <tr>
                            <td>Unclear which player</td>
                            <td>{c.ambiguousIdentitySentences ?? 0}</td>
                          </tr>
                        </tbody>
                      </table>
                      {(c.samples ?? []).length > 0 ? (
                        <>
                          <div className="section-title">Sentences no rule matched</div>
                          <ul style={{ paddingLeft: 16, margin: 0 }}>
                            {(c.samples ?? []).map((sample, i) => (
                              <li key={i} className="faint" style={{ marginBottom: 4 }}>
                                “{sample.excerpt}” — {sample.players.join(', ')}
                              </li>
                            ))}
                          </ul>
                          <div className="faint" style={{ marginTop: 4 }}>
                            These are usually ordinary sentences with no news in them. If you spot real
                            news here, it means a rule is missing.
                          </div>
                        </>
                      ) : null}
                      {(c.unknownNames ?? []).length > 0 ? (
                        <>
                          <div className="section-title">Names not in the player list</div>
                          <div className="faint">{(c.unknownNames ?? []).join(', ')}</div>
                          <div className="faint" style={{ marginTop: 4 }}>
                            Mostly coaches and reporters. If a real player is listed here, update the
                            player list on the Sleeper step.
                          </div>
                        </>
                      ) : null}
                      {m.bodyRetained ? <ReprocessPanel messageId={m.messageId} /> : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </>
  );
}

/**
 * Re-run the current rules over one stored newsletter.
 *
 * Always previewed first. The preview is careful about one thing in
 * particular: reprocessing only ever *adds* what the rules now find, so a
 * stored item the rules would now read differently stays exactly as it is.
 * Saying that plainly matters more than making the button look powerful.
 */
function ReprocessPanel({ messageId }: { messageId: string }) {
  const [preview, setPreview] = useState<ReprocessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.get<ReprocessPreview>(`/api/newsletter/messages/${encodeURIComponent(messageId)}/preview`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ evidenceInserted: number }>(
        `/api/newsletter/messages/${encodeURIComponent(messageId)}/reprocess`,
      );
      setDone(`Added ${result.evidenceInserted} new item(s). Your corrections were left as they are.`);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }} data-testid="reprocess-panel">
      <div className="section-title">Re-read this email</div>
      {done ? <Notice tone="ok">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {!preview ? (
        <>
          <button className="btn btn-sm" onClick={load} disabled={busy} data-testid="reprocess-preview">
            {busy ? 'Checking…' : 'Check what would change'}
          </button>
          <div className="faint" style={{ marginTop: 4 }}>
            Nothing changes until you say so.
          </div>
        </>
      ) : (
        <>
          <div className="muted">{preview.detail}</div>

          {preview.tallyDelta.length > 0 ? (
            <table className="compact" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Tally change</th>
                </tr>
              </thead>
              <tbody>
                {preview.tallyDelta.map((d) => (
                  <tr key={d.playerId}>
                    <td>{d.playerId}</td>
                    <td>{d.net > 0 ? `+${d.net}` : d.net}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {preview.stale.length > 0 ? (
            <>
              <div className="section-title">Read differently now, but left alone</div>
              <ul style={{ paddingLeft: 16, margin: 0 }}>
                {preview.stale.map((s, i) => (
                  <li key={i} className="faint" style={{ marginBottom: 4 }}>
                    “{s.excerpt}” — stored as {s.storedPolarity} {s.storedMagnitude}, now read as {s.newPolarity}{' '}
                    {s.newMagnitude}
                  </li>
                ))}
              </ul>
              <div className="faint" style={{ marginTop: 4 }}>
                Re-reading only adds news it did not have before. To change one of these, edit it in Review.
              </div>
            </>
          ) : null}

          {preview.protectedByUser.length > 0 ? (
            <div className="faint" style={{ marginTop: 6 }}>
              {preview.protectedByUser.length} item(s) you corrected stay exactly as you set them.
            </div>
          ) : null}

          <div style={{ marginTop: 8 }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={apply}
              disabled={busy || preview.wouldAdd === 0}
              data-testid="reprocess-apply"
            >
              {preview.wouldAdd === 0 ? 'Nothing to add' : `Add ${preview.wouldAdd} item(s)`}
            </button>
            <button className="btn btn-sm" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The address of mail that arrived and was ignored, when it is worth offering
 * to accept.
 *
 * Only offered when the sender is genuinely not covered yet. `senderConfigured`
 * is the authority on whether the expected-sender list is the user's or still
 * the placeholder the app ships with — guessing that from the text of an
 * address would misjudge any domain that happened to contain the wrong word.
 */
function ignoredSender(status: NewsletterStatus): string | null {
  const from = status.lastReceivedFrom?.trim();
  if (!from) return null;
  if (status.lastReceivedStatus !== 'quarantined') return null;
  if (!status.senderConfigured) return from;

  const covered = status.expectedSenders.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    const f = from.toLowerCase();
    return p.startsWith('@') ? f.endsWith(p) : f === p;
  });
  return covered ? null : from;
}

function VegasPanel({ status }: { status: SetupStatus }) {
  return (
    <div className="card" data-testid="panel-vegas">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Vegas lines
      </div>
      <div className="badge-row">
        <Badge tone={status.vegas.live ? 'pos' : 'warn'}>
          {status.vegas.live ? 'Live lines connected' : 'Not connected yet'}
        </Badge>
        <Badge>source: {status.vegas.provider}</Badge>
      </div>
      <div className="faint" style={{ marginTop: 8 }}>
        {status.vegas.note}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Nothing to do here yet. Real betting lines are switched on later, once a free source has been
        confirmed. Until then, start/sit advice uses your news signal and clearly says when a line is
        missing rather than guessing.
      </div>
      {status.vegas.lastRefreshedAt ? (
        <div className="faint" style={{ marginTop: 6 }}>
          Practice data last updated {formatAge(status.vegas.lastRefreshedAt)} across {status.vegas.events} game(s).
        </div>
      ) : null}

      {/*
        Season-long markets are what the draft would use. They are reported
        separately from the weekly game lines because they are a different
        question with a different answer — and today, for this provider, the
        answer is that it does not publish them.
      */}
      <div className="section-title">Season outlook ({status.vegas.season.season})</div>
      <div className="faint" data-testid="season-market-health">
        {status.vegas.season.quotes > 0 ? (
          <>
            {status.vegas.season.quotes} market line{status.vegas.season.quotes === 1 ? '' : 's'} across{' '}
            {status.vegas.season.players} player{status.vegas.season.players === 1 ? '' : 's'}
            {status.vegas.season.unresolved > 0
              ? `, ${status.vegas.season.unresolved} on names that could not be matched to a player`
              : ''}
            . Updated {formatAge(status.vegas.season.fetchedAt)}
            {status.vegas.season.stale ? ' — out of date, so the draft is not using it' : ''}.
          </>
        ) : (
          <>Nothing stored. {status.vegas.season.reason}</>
        )}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        When a season line exists for a player, the draft shows it on his card and lets it nudge the ranking
        a little. When it does not, the card says nothing rather than guessing.
      </div>
    </div>
  );
}
