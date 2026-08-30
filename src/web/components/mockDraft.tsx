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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, type DraftBoard, type MockBoardResponse } from '../api.ts';
import { useOverlay } from '../overlay.ts';
import { Empty, Loading, Notice } from './common.tsx';
import { CloseIcon } from './icons.tsx';
import { DraftBoardOverlay } from './draftBoard.tsx';
import { ALL_FILTER, RecommendationRow, withTierDividers } from '../screens/DraftScreen.tsx';
import { Sheet, SegmentedControl } from './native.tsx';
import { FLX_FILTER, orderFilterChips } from '../../core/sleeper/eligibility.ts';
import { fillSlotRows } from '../../core/draft/liveRoster.ts';
import { enterMock, exitMock, forgetMock, readMock, writeMock } from '../mock/session.ts';
import type { MockDraftState } from '../../core/draft/mockDraft.ts';

/** How many of the mock board's rows the list draws. The same as Draft's own. */
const MOCK_ROWS = 40;

/**
 * How long one attempt may take before the reader is told instead.
 *
 * There was no deadline at all, and that turned out to be the whole of the
 * ten-second lockout the owner reported: a request with nothing to stop it,
 * three of them in a row behind a guard that swallowed every tap while they
 * ran. A slow trip is now a failed trip, quickly, which is what lets the screen
 * hand the decision back.
 *
 * Four seconds is well past any healthy answer — this route measured 76–173ms
 * against a production-scale pool — and well short of the pause that makes
 * somebody think the app has died.
 */
const MOCK_ATTEMPT_MS = 4_000;

/**
 * How long the whole thing may take, retries included.
 *
 * The number the owner actually feels, and the one the previous fix got wrong
 * by making it additive: three unbounded attempts plus their backoffs, with no
 * ceiling anywhere. It is a *budget* rather than a count — checked before each
 * retry — so a slow first attempt spends it and no second attempt is made,
 * while three fast flakes are all retried inside a second.
 */
const MOCK_BUDGET_MS = 6_000;

/** Attempts at one board request, when the budget allows them. */
const MOCK_ATTEMPTS = 3;

/**
 * How long two taps count as one gesture.
 *
 * Under this, a second tap is the stray half of a double and is ignored — the
 * bug that was silently throwing a pick away. Over it, the reader has watched
 * nothing happen and is asking again, and is answered: what is in the air is
 * cancelled and their tap takes its place.
 *
 * 700ms is longer than any double-tap and far shorter than the lockout it
 * replaces. It is the whole of what the screen will ever ignore.
 */
const MOCK_IMPATIENCE_MS = 700;

/** How many failed attempts the screen remembers, for the reader to send on. */
const MOCK_TRACE_KEEP = 12;

/**
 * Between attempts. Deliberately short, and growing.
 *
 * The reader is holding a phone with their finger on a player. Half a second of
 * dimmed list is a beat; three seconds is a bug.
 */
const MOCK_RETRY_MS = 300;

/** What one attempt did, kept so the reader can send it on. See `MockTrace`. */
export interface MockAttemptRecord {
  attempt: number;
  /** Wall time for this attempt alone, in ms. */
  ms: number;
  /** HTTP status, or 0 when nothing answered. */
  status: number;
  /** `network`, `protocol`, `server`, `client`, `auth` — or `timeout`. */
  failure: string;
  /** Cloudflare's request id, which is what makes an edge failure findable. */
  ray: string | null;
  at: string;
}

/**
 * One board request, retried while what went wrong was the trip, and bounded.
 *
 * **Retrying is safe here in a way it is almost nowhere else in this app**, and
 * that is why this exists at this seam and not in `api.ts`. The route writes
 * nothing — `DraftBoardSources` has no write on it — and it is a pure function
 * of the state posted to it: the same state and the same action produce the
 * same room, because every bot pick is drawn from a generator seeded by the
 * state and the pick number. So a second attempt is not a second pick. It
 * cannot double-draft anybody, and it cannot reach Sleeper. See
 * `core/draft/mockDraft.ts`.
 *
 * `retryable` is the client's own existing judgement, not a new rule: a dropped
 * connection, a 5xx, a 408 or a 429 are asked again; a refusal is not. That is
 * what keeps the 409 that ends a rehearsal arriving immediately rather than
 * three attempts later — see `retryableFor` in `apiResponse.ts`.
 *
 * Every attempt that fails is recorded through `onAttempt`, because a failure
 * that only reaches `console.warn` is a failure nobody holding a phone can
 * report. See `MockTrace`.
 */
async function postMockBoard(
  draftId: string,
  body: unknown,
  opts: { signal?: AbortSignal; onAttempt?: (record: MockAttemptRecord) => void } = {},
): Promise<MockBoardResponse> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const began = Date.now();
    /*
     * The caller's own cancellation and this attempt's deadline, as one signal.
     *
     * `AbortSignal.any` is what lets a tap cancel a request that is still
     * waiting on its four seconds — without it the reader would be told to wait
     * for a request they had already given up on.
     */
    const deadline = AbortSignal.timeout(MOCK_ATTEMPT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    try {
      return await api.post<MockBoardResponse>(
        `/api/drafts/${encodeURIComponent(draftId)}/mock/board`,
        body,
        /*
         * `invalidates: false`, and it is not the exception it looks like.
         *
         * `api.post` empties the session cache because a write can change an
         * answer already held. This one cannot: it writes nothing anywhere, and
         * emptying the cache on every pick of a fifteen-round rehearsal would
         * mean every other tab in the app went back to the network for no
         * reason at all. See the note on `post` in `api.ts`.
         */
        { invalidates: false, signal },
      );
    } catch (err) {
      /* The reader changed their mind. Not a failure, and not recorded as one. */
      if (opts.signal?.aborted) throw err;

      const timedOut = deadline.aborted;
      opts.onAttempt?.({
        attempt,
        ms: Date.now() - began,
        status: err instanceof ApiError ? err.status : 0,
        failure: timedOut ? 'timeout' : err instanceof ApiError ? err.failure : 'unknown',
        ray: err instanceof ApiError ? err.ray : null,
        at: new Date().toISOString(),
      });

      /*
       * A timeout is worth one more go — the trip is what failed, and the next
       * one may take a different route — but only if the budget can pay for it,
       * which after a four-second attempt it cannot.
       */
      const kind = timedOut || (err instanceof ApiError && err.retryable);
      const wait = MOCK_RETRY_MS * attempt;
      /*
       * What the next attempt could cost, not just what the last one did.
       *
       * Checking only the time already spent is how a budget stops bounding
       * anything: after a four-second timeout there was still "room" for
       * another four-second timeout, and the ceiling was twice what it said.
       * A retry has to be affordable in the worst case it can produce.
       */
      const affordable = Date.now() - startedAt + wait + MOCK_ATTEMPT_MS <= MOCK_BUDGET_MS;
      if (!kind || attempt >= MOCK_ATTEMPTS || !affordable) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * `setup` is the step before a rehearsal exists.
 *
 * Reached only when there is nothing to resume — a first run, or a reset. A mock
 * that dropped the reader straight into a running draft at whichever seat the
 * league happened to give them was answering a question it had never asked: the
 * turn at seat 1 and the round-turn at seat 12 are different drafts to practise,
 * and choosing which is the whole reason to rehearse twice.
 */
type Phase = 'setup' | 'loading' | 'ready' | 'thinking' | 'gone' | 'failed';

export function MockDraftScreen({
  draftId,
  teams,
  mySlot,
  onClose,
}: {
  draftId: string;
  /** Seats in this league, from the live board. Nothing is fetched for it. */
  teams: number;
  /** The reader's own seat, or null when the league does not say. */
  mySlot: number | null;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const { lift } = useOverlay({ container: layerRef, onDismiss: onClose });

  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<MockBoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);
  /**
   * The seat the setup step is offering, before it is committed to a state.
   *
   * Null means "my own seat", which is what the reader gets by starting without
   * touching anything — the behaviour every mock had before this step existed.
   */
  const [seat, setSeat] = useState<number | null>(null);
  /** Which card is open. The same one-at-a-time rule the live board uses. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * Which chip is pressed, and it narrows the same way the live board narrows.
   *
   * The rehearsal was the one board in this app with no way to ask "who is the
   * best receiver left", which on a phone mid-round means scrolling forty mixed
   * rows to find out. The row below is `SegmentedControl` over
   * `orderFilterChips` — the live screen's own control over the live screen's
   * own ordering — and the narrowing itself is `position` on the board request,
   * which is the same parameter the Draft page sends. Nothing here filters a
   * list on the client: `buildDraftBoard` cuts the pool, so the rehearsal's
   * filtered board *is* the Draft page's filtered board.
   */
  const [position, setPosition] = useState(ALL_FILTER);
  /**
   * The filter every request carries, read synchronously.
   *
   * Same reason `stateRef` exists: a pick taken while a chip is pressed has to
   * post the chip that is pressed *now*, not the one the last render saw.
   */
  const positionRef = useRef(position);
  positionRef.current = position;

  /**
   * The rehearsal, and the one place it is kept.
   *
   * Held in a ref rather than in state because every request needs the *current*
   * state and a render is not a synchronisation point: two taps in quick
   * succession would otherwise both post the state as it was before the first
   * one landed, and the second pick would be made against a stale board.
   */
  const stateRef = useRef<MockDraftState | null>(null);

  /**
   * Whether a request is already in the air, decided synchronously.
   *
   * `phase` cannot answer this. It is a render's opinion, and two taps
   * dispatched in the same frame — a thumb on a dimmed list, a browser that
   * fires a click twice — both read the render that came *before* either of
   * them. Both passed the `thinking` check, both posted `stateRef.current` as
   * it was, and the server answered each of them with a different room built
   * from the same starting state. The second answer overwrote the first, so the
   * pick the reader actually made and the whole round of bot picks that came
   * with it disappeared with no error anywhere: the request succeeded, the
   * board simply came back as though the tap had never happened.
   *
   * A ref is the only thing two taps in one frame agree on. The first tap wins,
   * which is the one the reader meant; the second is the no-op the dimmed list
   * already claims it is.
   *
   * It gates *taps* only. Starting and resuming are not picks — Reset has to
   * work while the room is thinking, or a request that never lands leaves the
   * screen with no way out — so those go regardless, and `generation` below is
   * what stops the request they overtook from landing on top of them.
   *
   * ## And it stops gating after a moment, deliberately
   *
   * `since` is when the in-flight request started. Past `MOCK_IMPATIENCE_MS` a
   * tap is not a stray second half of one gesture any more — it is somebody who
   * has watched nothing happen and is asking again — so it cancels what is in
   * the air and takes its place. That is the difference between a guard and the
   * lockout the owner reported: a tap is never swallowed for longer than it
   * takes to be sure it was a double.
   */
  const inFlight = useRef<{ since: number; abort: AbortController } | null>(null);

  /**
   * Which request the screen is currently waiting for.
   *
   * Bumped by every ask, checked before every apply, and the same device
   * `draftRefresh.ts` uses for the same reason: an answer to a question the
   * screen has stopped asking must not be drawn. Without it a Reset issued
   * while a pick was in the air would be overwritten by that pick's room.
   */
  const generation = useRef(0);

  /**
   * The last thing asked for, so a failure can be asked for again.
   *
   * Every attempt this screen makes is already retried three times when the
   * failure was the trip; this is for the reader whose trip failed all three.
   * Without it their pick is simply gone and the only way back is to find the
   * row again and hope — which is what the reported defect actually felt like.
   */
  const lastAction = useRef<
    { kind: 'start'; slot?: number | null } | { kind: 'resume' } | { kind: 'take'; playerId: string } | null
  >(null);

  /**
   * What actually failed, kept where somebody holding a phone can reach it.
   *
   * `apiResponse.ts` reports every failure to `console.warn`, which on an
   * iPhone is a place nobody can look. That is why the first report of this
   * defect took a day of inference to narrow and still could not name the
   * cause: there was no record of what the failing request had *done* — its
   * status, how long it took, or Cloudflare's own id for it.
   *
   * So the screen keeps its own. It goes into the support snapshot and is
   * printed under the banner, which turns the next occurrence into evidence
   * instead of another report of a sentence.
   */
  const trace = useRef<MockAttemptRecord[]>([]);

  /**
   * The chip the board on screen was actually built for.
   *
   * A tap on a chip does not itself make a request. It moves this away from
   * `position`, and the effect below closes the gap the moment nothing is in
   * flight — which is what stops a chip tapped while a pick is in the air from
   * cancelling that pick. The rehearsal's whole recent history is lost picks;
   * a filter is not worth another one.
   */
  const applied = useRef(ALL_FILTER);

  const apply = useCallback((next: MockBoardResponse) => {
    stateRef.current = next.state;
    writeMock(next.state);
    setResult(next);
    setError(null);
    setPhase('ready');
  }, []);

  const ask = useCallback(
    async (
      action:
        | { kind: 'start'; slot?: number | null }
        | { kind: 'resume' }
        | { kind: 'take'; playerId: string },
    ) => {
      /*
       * A second tap inside the double-tap window is the same gesture; after it
       * the reader has changed their mind, and what is in the air is abandoned
       * rather than allowed to answer over them.
       */
      const flight = inFlight.current;
      if (action.kind === 'take' && flight) {
        if (Date.now() - flight.since < MOCK_IMPATIENCE_MS) return;
        flight.abort.abort();
      }
      const abort = new AbortController();
      inFlight.current = { since: Date.now(), abort };
      const mine = ++generation.current;
      setPhase((current) => (current === 'loading' ? 'loading' : 'thinking'));
      setSnapshotNote(null);
      /*
       * Kept, so the banner below can offer the pick back rather than only
       * apologise for having lost it. See `mock-retry`.
       */
      lastAction.current = action;
      /*
       * The chip this request is being made under, captured before the trip.
       *
       * What comes back is a board for *this* filter, and `applied` is how the
       * screen knows whether the chip has moved on since — see the effect below
       * that re-asks. Reading it at apply time instead would read whatever the
       * reader had tapped by then and conclude the board already matched.
       */
      const requested = positionRef.current;
      try {
        const next = await postMockBoard(
          draftId,
          {
            state: stateRef.current,
            action,
            limit: MOCK_ROWS,
            /*
             * `ALL` is the absence of a filter rather than a value: the route
             * reads `null` as "the whole board", which is byte-identical to the
             * request every rehearsal made before this row existed.
             */
            position: requested === ALL_FILTER ? null : requested,
          },
          {
            signal: abort.signal,
            onAttempt: (record) => {
              trace.current = [...trace.current, record].slice(-MOCK_TRACE_KEEP);
            },
          },
        );
        if (mine !== generation.current) return;
        applied.current = requested;
        apply(next);
      } catch (err) {
        if (mine !== generation.current || abort.signal.aborted) return;
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
      } finally {
        if (mine === generation.current) inFlight.current = null;
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
      if (!live) return;
      /*
       * Resume what is there; otherwise ask where they want to sit.
       *
       * A stored rehearsal is already seated, so setup would be asking a
       * question that has an answer — and the reader who reopened the screen
       * came back to the draft they were in the middle of.
       */
      if (stateRef.current) void ask({ kind: 'resume' });
      else setPhase('setup');
    });
    return () => {
      live = false;
      void exitMock();
    };
  }, [draftId, ask]);

  /*
   * The board catches up with the chip, once there is nothing in the air.
   *
   * `ready` is the only phase in which a request is not outstanding, so this
   * waits for a pick to land rather than racing it, and runs again if the
   * reader tapped a third chip while the second was travelling. It cannot
   * loop: a board that arrives for the chip that is pressed leaves the two
   * equal, and the effect does nothing.
   */
  useEffect(() => {
    if (phase !== 'ready' || applied.current === position) return;
    void ask({ kind: 'resume' });
  }, [phase, position, ask]);

  const board: DraftBoard | null = result?.board ?? null;

  /**
   * Which of the two tier treatments this list gets — the live screen's rule,
   * applied to the same question.
   *
   * Filtered to one position the board is a ladder and the breaks in it can be
   * drawn where they fall. `ALL` and `FLX` are mixed-position lists, where a
   * line across two rows would claim a boundary that does not exist, so those
   * get the proximity tag on the players it is about instead. This used to be
   * hardcoded off, because a rehearsal had no filter to be single-position.
   */
  const isSinglePosition = position !== ALL_FILTER && position !== FLX_FILTER;

  /**
   * The live screen's own row annotations, over the rehearsal's board.
   *
   * `isSinglePosition` decides, exactly as it does on the live screen, and
   * `showCliffProximity` below is the same `!isSinglePosition` it passes.
   */
  const rows = useMemo(
    () => withTierDividers(board?.recommendations ?? [], isSinglePosition),
    [board?.recommendations, isSinglePosition],
  );

  const capture = async () => {
    if (!stateRef.current) return;
    setSnapshotNote('Capturing…');
    try {
      const snapshot = await api.post<{ capturedAt: string }>(
        `/api/drafts/${encodeURIComponent(draftId)}/mock/support-snapshot`,
        { state: stateRef.current },
        { invalidates: false },
      );
      /*
       * The attempts that were lost ride along with the capture.
       *
       * Added on the client, beside the server's snapshot rather than inside
       * it, because they are facts about *this browser's* trips — timings,
       * statuses and Cloudflare ray ids the server never saw, since by
       * definition these are the requests that did not arrive. It is the one
       * artefact that turns "it failed again" into something diagnosable.
       */
      const text = JSON.stringify(
        trace.current.length > 0 ? { ...snapshot, lostAttempts: trace.current } : snapshot,
        null,
        2,
      );
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

  /**
   * Back to the setup step, with the last seat still chosen.
   *
   * Reset used to start a new run immediately. It goes through setup now
   * because setup is where the seat lives and there is nowhere else to change
   * it — and it costs the reader who only wants another go at the same seat one
   * tap, on a control they reached for deliberately.
   */
  const reset = () => {
    forgetMock(draftId);
    stateRef.current = null;
    /*
     * A new rehearsal opens on the whole board, and `applied` moves with it so
     * the first board of the new run is not immediately asked for again.
     */
    setPosition(ALL_FILTER);
    positionRef.current = ALL_FILTER;
    applied.current = ALL_FILTER;
    setResult(null);
    setError(null);
    setSnapshotNote(null);
    setBoardOpen(false);
    setTeamOpen(false);
    /* Anything still in the air belongs to the run being thrown away. */
    generation.current += 1;
    inFlight.current?.abort.abort();
    inFlight.current = null;
    setPhase('setup');
  };

  const startWith = (slot: number | null) => {
    setSeat(slot);
    setPhase('loading');
    void ask({ kind: 'start', slot });
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
            {phase === 'setup'
              ? 'Choose where you are drafting from'
              : board
                ? result?.complete
                  ? `Finished · ${board.rounds} rounds`
                  : `R${board.round} #${board.currentPick} · ${result?.yourTurn ? 'your pick' : 'the room is picking'}`
                : 'Setting up the room…'}
          </div>
        </div>
        {board ? (
          <>
            {/*
              Your own team, in the slots it will actually be scored in.

              The list beside it is a ranking — it says who is worth taking, and
              says nothing about what you have already built. Two receivers into
              a league that starts three is a fact about your roster that a flat
              list of names cannot show, and it is the fact that decides the
              next pick.
            */}
            <button
              type="button"
              className="btn btn-sm"
              data-testid="mock-team-open"
              aria-haspopup="dialog"
              onClick={() => setTeamOpen(true)}
            >
              Team
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-testid="mock-board-open"
              aria-haspopup="dialog"
              onClick={() => setBoardOpen(true)}
            >
              Board
            </button>
          </>
        ) : null}
        {phase === 'setup' ? null : (
          <button type="button" className="btn btn-sm" data-testid="mock-reset" onClick={reset}>
            Reset
          </button>
        )}
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
          /*
            The pick is offered back, not just apologised for.

            Three attempts have already been made and all three lost the trip.
            Without this control the reader's pick is gone and the only way back
            is to find the row again — which is what the reported defect
            actually felt like from the other side of the screen.
          */
          <Notice tone="error" data-testid="mock-error" role="alert">
            {error}{' '}
            <button
              type="button"
              className="btn btn-sm"
              data-testid="mock-retry"
              onClick={() => {
                const again = lastAction.current;
                if (again) void ask(again);
              }}
            >
              Try again
            </button>
            {/*
              What actually happened, on the screen it happened on.

              One line per lost attempt: how long it took, what came back, and
              Cloudflare's own id for the request. It is the difference between
              "it says it couldn't save" and a report somebody can act on, and
              it costs nothing to anybody whose picks are landing — there is no
              line here until an attempt has been lost.
            */}
            {trace.current.length > 0 ? (
              <span className="mock-trace" data-testid="mock-trace">
                {trace.current.slice(-3).map((record) => (
                  <span className="mock-trace-line" key={`${record.at}:${record.attempt}`}>
                    try {record.attempt} · {record.ms}ms · {record.failure}
                    {record.status ? ` ${record.status}` : ''}
                    {record.ray ? ` · ${record.ray}` : ''}
                  </span>
                ))}
              </span>
            ) : null}
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

        {phase === 'setup' ? (
          <MockSetup teams={teams} mySlot={mySlot} seat={seat} onSeat={setSeat} onStart={startWith} />
        ) : null}

        {board ? <MockRoster board={board} /> : null}
        {result && result.made.length > 0 ? <RoomSince made={result.made} /> : null}

        {/*
          The Draft page's filter row, over the rehearsal's board.

          Drawn only once there is a board, because the chips are the league's
          own — `startablePositions` and `offersFlex` come down with the board
          rather than from a list here, so a league with no defence slot draws
          no DEF chip in a rehearsal either.

          The ★ queue chip is deliberately absent, and it is the one difference
          from the live row. A star is "remind me later" and there is no later
          in a rehearsal — the reader is the one picking, now, which is why the
          star's slot on these rows carries a `+` instead. A chip filtering to a
          list nobody can add to from this screen would be a control with no
          way to satisfy it.
        */}
        {board && phase !== 'setup' && !result?.complete ? (
          <SegmentedControl
            label="Filter by position"
            value={position}
            onChange={setPosition}
            segments={[ALL_FILTER, ...orderFilterChips(board.startablePositions ?? [], board.offersFlex === true)].map(
              (p) => ({
                id: p,
                label: p,
                ...(p === FLX_FILTER
                  ? {
                      ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends',
                      testId: 'mock-flx-filter',
                    }
                  : { testId: `mock-filter-${p}` }),
              }),
            )}
            testId="mock-filters"
          />
        ) : null}

        {phase === 'setup' ? null : phase === 'loading' ? (
          <Loading what="the room" />
        ) : board == null ? null : result?.complete ? (
          <Empty>This mock draft is finished. Reset to run it again.</Empty>
        ) : board.recommendations.length === 0 ? (
          <Empty>{position === ALL_FILTER ? 'Nobody left to draft.' : 'No available players match this filter.'}</Empty>
        ) : (
          <div className="mock-list" data-testid="mock-list" aria-busy={phase === 'thinking'}>
            {/*
              The board's own rows, not a simplified copy of them.

              This was a compact row with three numbers on it — no expansion, no
              Insight, no news, no outlook — which made a rehearsal a different
              object on the one screen whose whole claim is that it *is* the
              Draft screen with a different pick stream in it. The reader was
              practising against a board they would not be looking at on the day.

              `withTierDividers` and `RecommendationRow` are the live screen's
              own, imported rather than reimplemented, so the tier bands, the
              level-score runs and the score bands are the same computation over
              the mock's recommendations. The one difference is the slot at the
              end of the line: a `+` that takes the player, where the live board
              carries the star that bookmarks him. See `PickControl`.
            */}
            {rows.map((item) => (
              <div key={item.rec.playerId} data-testid={`mock-row-${item.rec.playerId}`}>
                {item.divider ? <div className="tier-divider" role="separator" /> : null}
                <RecommendationRow
                  rank={item.rank}
                  rec={item.rec}
                  level={item.level}
                  levelRun={item.levelRun}
                  band={item.band}
                  showCliffProximity={!isSinglePosition}
                  ptsPresent={false}
                  horizonPick={board.waitHorizonPick}
                  currentPick={board.currentPick}
                  marketSource={board.marketSource ?? null}
                  scoringLabel={board.league?.scoringLabel ?? null}
                  expanded={expanded === item.rec.playerId}
                  onToggle={() =>
                    setExpanded(expanded === item.rec.playerId ? null : item.rec.playerId)
                  }
                  /*
                    Never reached: `onPick` is what this row renders, and the
                    star it replaces is the only caller of `onQueue`. A mock
                    cannot write to the queue anyway — the guard refuses it at
                    the API seam and again at the server.
                  */
                  onQueue={() => {}}
                  /*
                    One tap, one pick, and the room answers in the same request.

                    Not gated on `thinking`, and that is the lockout fix rather
                    than an oversight: a tap has to reach `ask`, which is the
                    only thing that can tell a stray double from a person asking
                    again. The list keeps dimming through `aria-busy`, which is
                    the honest signal that something is happening.
                  */
                  onPick={(playerId) => {
                    if (!result?.yourTurn) return;
                    void ask({ kind: 'take', playerId });
                  }}
                  busy={false}
                />
              </div>
            ))}
          </div>
        )}

        {phase === 'setup' ? null : (
          <div className="mock-foot">
            <button type="button" className="btn btn-sm" data-testid="mock-snapshot" onClick={() => void capture()}>
              Copy support snapshot
            </button>
          </div>
        )}
      </div>

      {/*
        The rehearsal's own grid, drawn by the production board.

        It is handed the mock's `DraftBoard` and nothing else — the same object
        the live board overlay is handed — which is the clearest statement
        available that a mock is a pick stream rather than a second app.
      */}
      {boardOpen && board ? <DraftBoardOverlay board={board} onClose={() => setBoardOpen(false)} /> : null}
      {teamOpen && board ? <MockTeamSheet board={board} onClose={() => setTeamOpen(false)} /> : null}
    </div>,
    document.body,
  );
}

/**
 * Where you are drafting from, before the room is built.
 *
 * Deliberately the whole of the setup: one question, twelve answers and a
 * shortcut. A mock has one other input — the seed — and it is not offered,
 * because "which random draft" is not a decision anybody can make and Reset is
 * already the control for "give me a different one".
 *
 * The reader's real seat is marked rather than pre-imposed. Starting without
 * touching anything gives them that seat, which is what every mock did before
 * this step existed, so the default is the old behaviour and the choice is the
 * addition.
 */
function MockSetup({
  teams,
  mySlot,
  seat,
  onSeat,
  onStart,
}: {
  teams: number;
  mySlot: number | null;
  seat: number | null;
  onSeat: (slot: number | null) => void;
  onStart: (slot: number | null) => void;
}) {
  const seats = Array.from({ length: Math.max(1, teams) }, (_, i) => i + 1);
  const chosen = seat ?? mySlot;
  return (
    <div className="mock-setup" data-testid="mock-setup">
      <div className="mock-setup-title">Which seat?</div>
      <div className="mock-setup-seats" role="radiogroup" aria-label="Draft seat">
        {seats.map((slot) => (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={chosen === slot}
            className="mock-seat"
            data-state={chosen === slot ? 'chosen' : undefined}
            data-mine={slot === mySlot ? 'yes' : undefined}
            data-testid={`mock-seat-${slot}`}
            onClick={() => onSeat(slot)}
          >
            {slot}
            {slot === mySlot ? <span className="mock-seat-mine">yours</span> : null}
          </button>
        ))}
      </div>
      <div className="mock-setup-actions">
        <button
          type="button"
          className="btn btn-sm"
          data-testid="mock-seat-random"
          /*
           * A draw, not a shuffle of the list. `Math.random` is fine *here* and
           * only here: this is a reader asking to be surprised once, at the one
           * point in this feature that is not replayed. Everything downstream
           * of the seat — every bot pick in the rehearsal — is still seeded and
           * still deterministic; see `nextpick/rng.ts`.
           */
          onClick={() => onSeat(seats[Math.floor(Math.random() * seats.length)] ?? 1)}
        >
          Random seat
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="mock-start"
          onClick={() => onStart(chosen)}
        >
          Start mock draft
        </button>
      </div>
      <div className="mock-setup-note">
        {chosen == null
          ? 'Your seat in this league could not be identified, so the room will draft around you where it can.'
          : chosen === mySlot
            ? `Seat ${chosen} of ${teams} — the one you actually have.`
            : `Seat ${chosen} of ${teams}. Practice only: your real seat is unchanged.`}
      </div>
    </div>
  );
}

/**
 * Your own team, in the slots the league scores.
 *
 * The allocation is `fillSlotRows` over the board's own `rosterProgress` — the
 * same rows the header strip counts — so this sheet and `0/1 QB · 2/3 WR`
 * cannot disagree about what is filled. Nothing is fetched and nothing is
 * computed twice; see `core/draft/liveRoster.ts` for why the Team screen's
 * lineup was not the thing to reuse.
 */
function MockTeamSheet({ board, onClose }: { board: DraftBoard; onClose: () => void }) {
  const rows = useMemo(() => {
    const byId = new Map(board.myRoster.map((p) => [p.playerId, p]));
    return fillSlotRows(
      board.rosterProgress,
      board.myRoster.map((p) => ({ playerId: p.playerId, position: p.position })),
    ).map((row) => ({ ...row, held: row.players.map((p) => byId.get(p.playerId)).filter((p) => p != null) }));
  }, [board.rosterProgress, board.myRoster]);

  return (
    <Sheet title="Your team" onClose={onClose} testId="mock-team">
      <div className="mock-team-note faint">
        A rehearsal's roster. Nothing here is on your real team.
      </div>
      <div className="list-group">
        {rows.map((row) => (
          <div className="mock-team-slot" data-testid={`mock-team-slot-${row.slot}`} key={row.slot}>
            <div className="mock-team-slot-head">
              <span className="mock-team-slot-name">{row.slot}</span>
              <span className="mock-team-slot-count">
                {row.held.length}
                {row.required > 0 ? `/${row.required}` : ''}
              </span>
            </div>
            {row.held.length === 0 ? (
              /*
                An empty starting slot is the most useful line on this sheet, so
                it is drawn rather than skipped: the hole in the lineup is what
                the next pick is for.
              */
              <div className="mock-team-empty">{row.bench ? 'nobody yet' : 'still to fill'}</div>
            ) : (
              row.held.map((player) => (
                <div className="mock-team-player" key={player.playerId}>
                  <span className="mock-team-pos">{player.position}</span>
                  <span className="mock-team-name">{player.name}</span>
                  <span className="mock-team-pick">#{player.pickNo}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </Sheet>
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
