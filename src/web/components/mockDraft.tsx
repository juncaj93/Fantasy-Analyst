/**
 * A practice draft, over the Draft page.
 *
 * The whole of this screen is a board and a list of players you can take. It
 * looks like the Draft page because it *is* the Draft page's parts: the same
 * rows, the same identity grammar, the same board grid, and a `DraftBoard`
 * built by the same assembly over a substituted pick stream. Nothing here
 * ranks, scores or prices anything — see `core/draft/mockBoard.ts`.
 *
 * Three properties this file is responsible for, and they are the whole design:
 *
 *  1. **It never writes.** Every request it makes is a read: the two mock
 *     routes are POSTs carrying a state, and everything else is a GET. While it
 *     is open the API client refuses anything that is not, which is the browser
 *     half of §4's two refusals — see `web/mock/session.ts`.
 *  2. **The state is the reader's.** It lives in this component and in
 *     `localStorage` under the draft it rehearses, is posted with every
 *     request, and comes back updated. The server keeps none of it.
 *  3. **It ends when the real draft starts.** The server refuses with a 409,
 *     and this screen deletes the stored rehearsal and says so rather than
 *     retrying.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, type DraftBoard, type MockBoardResponse } from '../api.ts';
import { useOverlay } from '../overlay.ts';
import { Empty, Loading, Notice } from './common.tsx';
import { CompactPlayerRow } from './playerRow.tsx';
import { CloseIcon } from './icons.tsx';
import { DraftBoardOverlay } from './draftBoard.tsx';
import { enterMock, exitMock, forgetMock, readMock, writeMock } from '../mock/session.ts';
import type { MockDraftState } from '../../core/draft/mockDraft.ts';

/** How many of the mock board's rows the list draws. The same as Draft's own. */
const MOCK_ROWS = 40;

type Phase = 'loading' | 'ready' | 'thinking' | 'gone' | 'failed';

export function MockDraftScreen({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const { lift } = useOverlay({ container: layerRef, onDismiss: onClose });

  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<MockBoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);

  /**
   * The rehearsal, and the one place it is kept.
   *
   * Held in a ref rather than in state because every request needs the *current*
   * state and a render is not a synchronisation point: two taps in quick
   * succession would otherwise both post the state as it was before the first
   * one landed, and the second pick would be made against a stale board.
   */
  const stateRef = useRef<MockDraftState | null>(null);

  const apply = useCallback((next: MockBoardResponse) => {
    stateRef.current = next.state;
    writeMock(next.state);
    setResult(next);
    setError(null);
    setPhase('ready');
  }, []);

  const ask = useCallback(
    async (action: { kind: 'start' } | { kind: 'resume' } | { kind: 'take'; playerId: string }) => {
      setPhase((current) => (current === 'loading' ? 'loading' : 'thinking'));
      setSnapshotNote(null);
      try {
        /*
         * `invalidates: false`, and it is not the exception it looks like.
         *
         * `api.post` empties the session cache because a write can change an
         * answer already held. This one cannot: it writes nothing anywhere, and
         * emptying the cache on every pick of a fifteen-round rehearsal would
         * mean every other tab in the app went back to the network for no
         * reason at all. See the note on `post` in `api.ts`.
         */
        const next = await api.post<MockBoardResponse>(
          `/api/drafts/${encodeURIComponent(draftId)}/mock/board`,
          { state: stateRef.current, action, limit: MOCK_ROWS },
          { invalidates: false },
        );
        apply(next);
      } catch (err) {
        /*
         * A 409 is the lifecycle rule arriving, not a failure.
         *
         * The real draft has started, so the mock for this draft does not exist
         * any more. The stored state goes immediately — deleted outright, per
         * §3, rather than kept against the chance that the reader wants it
         * back — and the screen says what happened instead of offering a retry
         * that cannot succeed.
         */
        if (err instanceof ApiError && err.status === 409) {
          forgetMock(draftId);
          stateRef.current = null;
          setError(err.message);
          setPhase('gone');
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setPhase('failed');
      }
    },
    [draftId, apply],
  );

  useEffect(() => {
    let live = true;
    stateRef.current = readMock(draftId);
    /*
     * The server is told before anything is asked of it.
     *
     * Awaited, so the marker is set before the first mock request goes out
     * rather than racing it — the cookie is what makes the server refuse a
     * write for the whole of this rehearsal, and a window in which it is not
     * set is the one thing this ordering exists to close.
     */
    void enterMock(draftId).then(() => {
      if (live) void ask(stateRef.current ? { kind: 'resume' } : { kind: 'start' });
    });
    return () => {
      live = false;
      void exitMock();
    };
  }, [draftId, ask]);

  const board: DraftBoard | null = result?.board ?? null;

  const capture = async () => {
    if (!stateRef.current) return;
    setSnapshotNote('Capturing…');
    try {
      const snapshot = await api.post<{ capturedAt: string }>(
        `/api/drafts/${encodeURIComponent(draftId)}/mock/support-snapshot`,
        { state: stateRef.current },
        { invalidates: false },
      );
      const text = JSON.stringify(snapshot, null, 2);
      const size = `${Math.round(text.length / 1024)} KB`;
      try {
        await navigator.clipboard.writeText(text);
        setSnapshotNote(`${size} on the clipboard, marked as a mock draft.`);
      } catch {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `junculator-mock-draft-${snapshot.capturedAt.slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setSnapshotNote(`${size}. This browser would not take it on the clipboard, so it was saved as a file.`);
      }
    } catch (err) {
      setSnapshotNote(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    forgetMock(draftId);
    stateRef.current = null;
    setPhase('loading');
    void ask({ kind: 'start' });
  };

  return createPortal(
    <div
      className="dboard-layer mock-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Mock draft"
      data-testid="mock-draft"
      data-phase={phase}
      style={{ ['--overlay-lift' as string]: String(lift) }}
      tabIndex={-1}
      ref={layerRef}
    >
      <div className="dboard-bar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Close mock draft"
          data-testid="mock-close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <div className="dboard-titles">
          <div className="dboard-title">Mock draft</div>
          <div className="dboard-sub" data-testid="mock-subtitle">
            {board
              ? result?.complete
                ? `Finished · ${board.rounds} rounds`
                : `R${board.round} #${board.currentPick} · ${result?.yourTurn ? 'your pick' : 'the room is picking'}`
              : 'Setting up the room…'}
          </div>
        </div>
        {board ? (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="mock-board-open"
            aria-haspopup="dialog"
            onClick={() => setBoardOpen(true)}
          >
            Board
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" data-testid="mock-reset" onClick={reset}>
          Reset
        </button>
      </div>

      {/*
        Said once, at the top, and never dismissible.

        Everything under this line is a rehearsal: the players who are "gone"
        are not gone, the roster is not the reader's roster, and none of it has
        reached Sleeper. On the one screen in this app where those two worlds
        look identical, saying so quietly would not be saying it.
      */}
      <div className="mock-banner" data-testid="mock-banner" role="status">
        Practice only. Nothing here reaches Sleeper, your real draft or your queue.
      </div>

      <div className="mock-body">
        {phase === 'gone' ? (
          <Notice tone="error" data-testid="mock-voided" role="alert">
            {error ?? 'The real draft has started, so this mock draft no longer exists.'}
          </Notice>
        ) : null}
        {phase === 'failed' && error ? (
          <Notice tone="error" data-testid="mock-error" role="alert">
            {error}
          </Notice>
        ) : null}
        {result?.refused ? (
          <Notice tone="warn" data-testid="mock-refused" role="status">
            {result.refused}
          </Notice>
        ) : null}
        {snapshotNote ? (
          <Notice tone="ok" data-testid="mock-snapshot-note" role="status">
            {snapshotNote}
          </Notice>
        ) : null}

        {board ? <MockRoster board={board} /> : null}
        {result && result.made.length > 0 ? <RoomSince made={result.made} /> : null}

        {phase === 'loading' ? (
          <Loading what="the room" />
        ) : board == null ? null : result?.complete ? (
          <Empty>This mock draft is finished. Reset to run it again.</Empty>
        ) : board.recommendations.length === 0 ? (
          <Empty>Nobody left to draft.</Empty>
        ) : (
          <div className="mock-list" data-testid="mock-list" aria-busy={phase === 'thinking'}>
            {board.recommendations.map((rec, index) => (
              <CompactPlayerRow
                key={rec.playerId}
                playerId={rec.playerId}
                name={rec.name}
                position={rec.position}
                team={rec.team}
                status={rec.status}
                rank={index + 1}
                /*
                  The three numbers a rehearsal is actually about.

                  Deliberately fewer than the live board's row. A mock is for
                  practising *when to take somebody*, so it carries the board's
                  own ranking, the market it is measured against, and the chance
                  he lasts — and leaves the rest on the card the live screen
                  already opens.
                */
                metrics={[
                  { label: 'Score', value: Math.round(rec.score) },
                  { label: 'ADP', value: rec.adp == null ? '—' : rec.adp.toFixed(1) },
                  {
                    label: 'Next',
                    value:
                      rec.survivalProbability == null ? '—' : `${Math.round(rec.survivalProbability * 100)}%`,
                  },
                ]}
                testId={`mock-row-${rec.playerId}`}
                /*
                  One tap, one pick, and the room answers in the same request.

                  A no-op rather than a removed control while the room is
                  picking: the list dims (`aria-busy`) and the rows stay rows,
                  because a list whose controls vanished for half a second would
                  read as a bug. The server refuses an out-of-turn pick anyway —
                  see `takeMockPick` — so this is the cheap half of a rule that
                  is enforced where it matters.
                */
                onOpen={() => {
                  if (phase === 'thinking' || !result?.yourTurn) return;
                  void ask({ kind: 'take', playerId: rec.playerId });
                }}
              />
            ))}
          </div>
        )}

        <div className="mock-foot">
          <button type="button" className="btn btn-sm" data-testid="mock-snapshot" onClick={() => void capture()}>
            Copy support snapshot
          </button>
        </div>
      </div>

      {/*
        The rehearsal's own grid, drawn by the production board.

        It is handed the mock's `DraftBoard` and nothing else — the same object
        the live board overlay is handed — which is the clearest statement
        available that a mock is a pick stream rather than a second app.
      */}
      {boardOpen && board ? <DraftBoardOverlay board={board} onClose={() => setBoardOpen(false)} /> : null}
    </div>,
    document.body,
  );
}

/** What the reader has built so far in this rehearsal. */
function MockRoster({ board }: { board: DraftBoard }) {
  if (board.myRoster.length === 0) {
    return (
      <div className="mock-roster" data-testid="mock-roster">
        <span className="mock-roster-empty">No picks yet</span>
      </div>
    );
  }
  return (
    <div className="mock-roster" data-testid="mock-roster">
      {board.myRoster.map((player) => (
        <span className="mock-roster-chip" key={player.playerId}>
          <b>{player.position}</b> {player.name}
        </span>
      ))}
    </div>
  );
}

/**
 * What the room did while the reader was deciding.
 *
 * The one thing a mock has to show that a live board does not: in a real draft
 * the reader watches the picks land, and here they all happen in the moment
 * between two taps. Without this the board simply has fewer players on it and
 * nothing says who took whom.
 */
function RoomSince({ made }: { made: { pickNo: number; slot: number; playerId: string; by: 'you' | 'bot' }[] }) {
  return (
    <div className="mock-since" data-testid="mock-since">
      {made.length} pick{made.length === 1 ? '' : 's'} just now — #{made[0]!.pickNo} to #
      {made[made.length - 1]!.pickNo}
    </div>
  );
}
