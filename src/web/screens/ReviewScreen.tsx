/**
 * Review queue.
 *
 * Two queues share this screen:
 *   1. evidence whose classification was not confident enough to auto-apply
 *   2. player mentions whose identity was ambiguous
 *
 * Every action is a visible, labelled button — nothing important is hidden
 * behind a gesture. Decisions here are authoritative and survive reprocessing.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type EvidenceItem, type IdentityReview } from '../api.ts';
import { Badge, Empty, Loading, Notice, formatDate } from '../components/common.tsx';

const POLARITIES = ['positive', 'negative', 'neutral', 'mixed'] as const;

/** Plain-language explanation of why an item is here, from the rule that fired. */
function reasonFor(item: EvidenceItem): string {
  if (item.contextSummary) return item.contextSummary;
  if (item.polarity === 'mixed') return 'This says both a good and a bad thing.';
  return 'Matched a news rule but was not clear enough to apply on its own.';
}

export function ReviewScreen({ onChanged }: { onChanged: () => void }) {
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [identity, setIdentity] = useState<IdentityReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'evidence' | 'identity' | 'applied'>('evidence');
  const [applied, setApplied] = useState<EvidenceItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, appliedRes] = await Promise.all([
        api.get<{ evidence: EvidenceItem[]; identity: IdentityReview[] }>('/api/review/queue'),
        api.get<{ evidence: EvidenceItem[] }>('/api/review/applied'),
      ]);
      setEvidence(res.evidence);
      setIdentity(res.identity);
      setApplied(appliedRes.evidence);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    setEvidence((prev) => prev.filter((e) => e.id !== id));
    try {
      await api.post(`/api/review/evidence/${id}`, { action, ...extra });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  const acceptAllHighConfidence = async () => {
    const targets = evidence.filter((e) => e.confidenceScore >= 0.6 && e.polarity !== 'mixed');
    for (const item of targets) await act(item.id, 'accept');
  };

  const resolveIdentity = async (id: number, playerId: string | null) => {
    setIdentity((prev) => prev.filter((i) => i.id !== id));
    try {
      await api.post(`/api/review/identity/${id}`, playerId ? { playerId } : { dismiss: true });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  if (loading) return <Loading what="review queue" />;

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="filter-row" role="group" aria-label="Review queues">
        <button className="chip" aria-pressed={tab === 'evidence'} onClick={() => setTab('evidence')}>
          Evidence ({evidence.length})
        </button>
        <button className="chip" aria-pressed={tab === 'identity'} onClick={() => setTab('identity')}>
          Wrong player? ({identity.length})
        </button>
        <button className="chip" aria-pressed={tab === 'applied'} onClick={() => setTab('applied')}>
          Already applied ({applied.length})
        </button>
      </div>

      {tab === 'applied' ? (
        applied.length === 0 ? (
          <Empty>Nothing has been applied yet.</Empty>
        ) : (
          <>
            <div className="faint" style={{ margin: '0 2px 6px' }}>
              These were clear enough to apply automatically. You can still change any of them.
            </div>
            {applied.map((item) => (
              <EvidenceReviewCard key={item.id} item={item} onAction={act} applied />
            ))}
          </>
        )
      ) : tab === 'evidence' ? (
        evidence.length === 0 ? (
          <Empty>Nothing to review. Ambiguous newsletter items land here.</Empty>
        ) : (
          <>
            <div className="card card-tight">
              <button className="btn btn-sm" onClick={() => void acceptAllHighConfidence()}>
                Accept all non-mixed ≥0.6 confidence
              </button>
            </div>
            {evidence.map((item) => (
              <EvidenceReviewCard key={item.id} item={item} onAction={act} />
            ))}
          </>
        )
      ) : identity.length === 0 ? (
        <Empty>No ambiguous player mentions.</Empty>
      ) : (
        identity.map((item) => (
          <div className="card" key={item.id} data-testid="identity-card">
            <div className="header-row">
              <strong>“{item.matchedText}”</strong>
              <Badge tone="warn">{item.proposedPolarity ?? 'unknown'}</Badge>
            </div>
            <div className="faint">{item.reason}</div>
            <div className="evidence-excerpt">“{item.excerpt}”</div>
            <div className="faint">{formatDate(item.sourceDate)}</div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              {item.candidates.map((c) => (
                <button key={c.playerId} className="btn btn-sm" onClick={() => void resolveIdentity(item.id, c.playerId)}>
                  {c.name} ({c.position} {c.team || 'FA'})
                </button>
              ))}
              <button className="btn btn-sm" onClick={() => void resolveIdentity(item.id, null)}>
                Dismiss
              </button>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function EvidenceReviewCard({
  item,
  onAction,
  applied = false,
}: {
  item: EvidenceItem;
  onAction: (id: string, action: string, extra?: Record<string, unknown>) => Promise<void>;
  applied?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [wrongPlayer, setWrongPlayer] = useState(false);
  return (
    <div className="card" data-testid={applied ? 'applied-card' : 'review-card'}>
      <div className="header-row">
        <div>
          <strong>{item.playerName ?? item.playerId}</strong>
          <span className="faint">
            {' '}
            {item.playerPosition} {item.playerTeam}
          </span>
        </div>
        <Badge tone={item.polarity === 'positive' ? 'pos' : item.polarity === 'negative' ? 'neg' : 'warn'}>
          {item.polarity === 'positive' ? '▲' : item.polarity === 'negative' ? '▼' : '◆'} {item.polarity}
        </Badge>
      </div>

      <div className="evidence-excerpt">“{item.excerpt}”</div>
      <div className="muted" data-testid="review-reason">
        Why: {reasonFor(item)}
      </div>
      <div className="evidence-meta">
        <span>{formatDate(item.sourceDate)}</span>
        <span>{item.category ?? 'general'}</span>
        <span>
          confidence: {item.confidence}
          {applied ? ` · ${item.reviewStatus.replace('_', ' ')}` : ''}
        </span>
      </div>

      <div className="btn-row" style={{ marginTop: 8 }}>
        {applied ? null : (
          <button className="btn btn-sm btn-primary" onClick={() => void onAction(item.id, 'accept')}>
            ✓ Accept
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setExpanded((v) => !v)}>
          ✎ Change
        </button>
        <button className="btn btn-sm" onClick={() => setWrongPlayer((v) => !v)}>
          ⇄ Wrong player
        </button>
        <button className="btn btn-sm" onClick={() => void onAction(item.id, 'ignore')}>
          ⊘ Ignore
        </button>
      </div>

      {wrongPlayer ? (
        <PlayerPicker
          onPick={async (playerId) => {
            setWrongPlayer(false);
            await onAction(item.id, 'correct', { playerId, polarity: item.polarity, magnitude: item.magnitude });
          }}
        />
      ) : null}

      {expanded ? (
        <div className="explain">
          <div className="faint" style={{ marginBottom: 4 }}>
            Your correction wins from now on, even if this newsletter is read again.
          </div>
          <div className="btn-row">
            {POLARITIES.map((p) => (
              <button
                key={p}
                className="btn btn-sm"
                onClick={() => void onAction(item.id, 'correct', { polarity: p, magnitude: item.magnitude })}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 4 }}>
            {[1, 2, 3].map((m) => (
              <button
                key={m}
                className="btn btn-sm"
                onClick={() => void onAction(item.id, 'correct', { polarity: item.polarity, magnitude: m })}
              >
                magnitude {m}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Type-ahead used by the "Wrong player" action. */
function PlayerPicker({ onPick }: { onPick: (playerId: string) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; position: string; team: string }[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      const res = await api.get<{ players: { id: string; name: string; position: string; team: string }[] }>(
        `/api/players?q=${encodeURIComponent(query)}`,
      );
      if (!cancelled) setResults(res.players.slice(0, 6));
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className="explain" data-testid="player-picker">
      <div className="field" style={{ marginBottom: 6 }}>
        <label htmlFor="wrong-player">Which player is this really about?</label>
        <input
          id="wrong-player"
          value={query}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a name"
        />
      </div>
      <div className="btn-row">
        {results.map((p) => (
          <button key={p.id} className="btn btn-sm" onClick={() => void onPick(p.id)}>
            {p.name} ({p.position} {p.team || 'FA'})
          </button>
        ))}
      </div>
    </div>
  );
}
