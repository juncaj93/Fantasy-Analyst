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
import { Badge, Disclose, Empty, Notice, PositionBadge, formatDate } from '../components/common.tsx';
import { NavBar, SegmentedControl, Sheet, SkeletonRows } from '../components/native.tsx';

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
  /** The scoring key, which is reference rather than part of the queue. */
  const [keyOpen, setKeyOpen] = useState(false);

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

  const resolveIdentity = async (id: number, playerId: string | null, remember = true) => {
    setIdentity((prev) => prev.filter((i) => i.id !== id));
    try {
      await api.post(
        `/api/review/identity/${id}`,
        playerId ? { playerId, remember } : { dismiss: true },
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  if (loading) {
    return (
      <>
        <NavBar title="Review" subtitle="Loading the queue…" />
        <SkeletonRows rows={5} testId="review-skeleton" />
      </>
    );
  }

  return (
    <>
      <NavBar
        testId="review-nav"
        title="Review"
        subtitle={
          evidence.length + identity.length === 0
            ? 'Nothing waiting for you'
            : `${evidence.length + identity.length} waiting for you`
        }
        trailing={
          <button type="button" className="btn btn-sm" onClick={() => setKeyOpen(true)} data-testid="scoring-key-open">
            How it works
          </button>
        }
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <SegmentedControl
        label="Review queues"
        value={tab}
        onChange={setTab}
        segments={[
          { id: 'evidence', label: `Evidence (${evidence.length})` },
          { id: 'identity', label: `Wrong player? (${identity.length})` },
          // Shorter on the track, and still called what it is called to a
          // screen reader: three long labels do not fit one phone width.
          {
            id: 'applied',
            label: `Applied (${applied.length})`,
            ariaLabel: `Already applied (${applied.length})`,
          },
        ]}
      />

      {/*
        Reference material, in a sheet.

        How the score works is read once and then never again, which is exactly
        what a sheet is for: it costs nothing while it is closed, it can be
        flicked away with a thumb, and nothing behind it changed while it was
        open. Nothing destructive is ever put in one of these.
      */}
      {keyOpen ? (
        <Sheet title="How the score works" onClose={() => setKeyOpen(false)} testId="scoring-key">
          <ScoringKey />
        </Sheet>
      ) : null}

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
            <div className="btn-row" style={{ margin: '0 2px 10px' }}>
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
        <Empty>No unrecognised names.</Empty>
      ) : (
        <>
          <div className="faint" style={{ margin: '0 2px 6px' }}>
            These names could not be matched to exactly one player, so nothing was counted for them.
            Pick the right player and the app remembers the name for next time.
          </div>
          {identity.map((item) => (
            <IdentityReviewCard key={item.id} item={item} onResolve={resolveIdentity} />
          ))}
        </>
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
        <div className="pos-team" style={{ gap: 6 }}>
          <strong>{item.playerName ?? item.playerId}</strong>
          <PositionBadge position={item.playerPosition ?? null} team={item.playerTeam ?? null} />
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

      {/*
        Four actions, on one line.

        They used to carry a decorative glyph each — a tick, a pencil, a pair of
        arrows and a slashed circle — drawn from four different typographic
        families at four different weights, and between them they pushed the row
        past the width of a 390px phone. Every card in the queue therefore spent
        a whole extra row of the screen on a wrap, which on a queue of three is
        a third of a phone.

        The glyphs are gone and the words are not: it was the words carrying the
        meaning in every case. Accept keeps the filled treatment because it is
        the one action the queue exists to make easy; the other three are
        corrections and are quiet.
      */}
      <div className="btn-row btn-row-tight" style={{ marginTop: 8 }}>
        {applied ? null : (
          <button className="btn btn-sm btn-primary" onClick={() => void onAction(item.id, 'accept')}>
            Accept
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setExpanded((v) => !v)}>
          Change
        </button>
        <button className="btn btn-sm" onClick={() => setWrongPlayer((v) => !v)}>
          Wrong player
        </button>
        <button className="btn btn-sm" onClick={() => void onAction(item.id, 'ignore')}>
          Ignore
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

      <Disclose open={expanded}>
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
      </Disclose>
    </div>
  );
}

/** Type-ahead used by the "Wrong player" action. */
/**
 * How scoring works, stated where the decisions are actually made.
 *
 * The rule is deliberately simple: one piece of news counts once. Anything more
 * elaborate is hard to hold in your head while clicking through a queue, and a
 * tally you cannot predict is a tally you cannot trust.
 */
function ScoringKey() {
  return (
    <div data-testid="scoring-key-body">
      <table className="compact" style={{ marginTop: 6 }}>
        <tbody>
          <tr>
            <td>Good news</td>
            <td>+1</td>
          </tr>
          <tr>
            <td>Bad news</td>
            <td>−1</td>
          </tr>
          <tr>
            <td>Neutral, or good and bad in the same breath</td>
            <td>does not count</td>
          </tr>
        </tbody>
      </table>
      <div className="faint" style={{ marginTop: 6 }}>
        Every item counts once, however dramatic it is. A torn ACL and a missed practice are both
        one bad item — the app still shows you which is which, it just does not let one sentence
        outweigh three.
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        <strong>Accept</strong> counts it. <strong>Reject</strong> throws it out.{' '}
        <strong>Change</strong> lets you set it yourself. <strong>Wrong player</strong> moves it to
        someone else. Your decision always wins, and it survives the same newsletter being read
        again.
      </div>
    </div>
  );
}

/**
 * One unrecognised name.
 *
 * A search box is always offered, not just the candidate list: a name like
 * "JSN" produces no candidates at all, and without a search the only available
 * action would be to give up on it.
 */
function IdentityReviewCard({
  item,
  onResolve,
}: {
  item: IdentityReview;
  onResolve: (id: number, playerId: string | null, remember: boolean) => Promise<void>;
}) {
  const [remember, setRemember] = useState(true);

  return (
    <div className="card" data-testid="identity-card">
      <div className="header-row">
        <strong>“{item.matchedText}”</strong>
        <Badge tone="warn">{item.proposedPolarity ?? 'unknown'}</Badge>
      </div>
      <div className="faint">{item.reason}</div>
      <div className="evidence-excerpt">“{item.excerpt}”</div>
      <div className="faint">{formatDate(item.sourceDate)}</div>

      <label className="check-row" style={{ marginTop: 8, display: 'block' }}>
        <input
          type="checkbox"
          checked={remember}
          data-testid="remember-name"
          onChange={(e) => setRemember(e.target.checked)}
        />{' '}
        Remember “{item.matchedText}” for this player
      </label>

      {item.candidates.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 6 }}>
          {item.candidates.map((c) => (
            <button
              key={c.playerId}
              className="btn btn-sm"
              onClick={() => void onResolve(item.id, c.playerId, remember)}
            >
              {c.name} ({c.position} {c.team || 'FA'})
            </button>
          ))}
        </div>
      ) : null}

      <PlayerPicker
        fieldId={`identity-pick-${item.id}`}
        label={
          item.candidates.length > 0 ? 'Or search for someone else' : 'Search for the right player'
        }
        onPick={(playerId) => onResolve(item.id, playerId, remember)}
      />

      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn btn-sm" onClick={() => void onResolve(item.id, null, false)}>
          Not a player — ignore
        </button>
      </div>
    </div>
  );
}

export function PlayerPicker({
  onPick,
  fieldId = 'wrong-player',
  label = 'Which player is this really about?',
}: {
  onPick: (playerId: string) => Promise<void>;
  /** Ids must be unique when several pickers are on screen at once. */
  fieldId?: string;
  label?: string;
}) {
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
        <label htmlFor={fieldId}>{label}</label>
        <input
          id={fieldId}
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
