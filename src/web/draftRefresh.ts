/**
 * Keeping the Draft board level with Sleeper, without being asked.
 *
 * The board used to update only when somebody tapped the refresh glyph. The
 * automatic loop existed, but it was armed *by that tap* — `pollSeconds` started
 * at zero and the only thing that ever raised it was the manual handler — so
 * arriving on Draft and waiting produced a board that never moved. During a live
 * draft that is the difference between a tool and a screenshot: every pick made
 * the board a little more wrong, and the only way to find out was to keep
 * tapping.
 *
 * This module is the loop, written as a plain object with its timers and its
 * clock injected, so all of it can be driven by a test at a thousand times real
 * speed. Nothing about *what the board says* is here — the controller decides
 * only when to ask Sleeper and whether the answer was worth acting on, and hands
 * the acting to whatever the screen already does. That separation is deliberate:
 * the Next% model, the tier bands and the opportunity-cost arithmetic are all
 * moving under parallel work, and a refresh layer that reached into any of them
 * would be a merge conflict with teeth.
 *
 * The shape is a recursive timeout rather than an interval, for two reasons that
 * both bite on a phone: the next delay is chosen *after* the last request landed,
 * so requests can never stack up behind a slow network; and the cadence can
 * change between one poll and the next, which is what makes "faster while you are
 * on the clock" a two-line decision instead of a second timer.
 */

/** Ordinary cadence while Draft is open, visible, and the draft is live. */
export const DRAFT_POLL_MS = 5_000;

/**
 * Cadence while it is the user's pick.
 *
 * The one moment in a draft where five seconds is too long to learn that the
 * player you were about to take is gone. Deliberately not one second: at ~24
 * requests a minute this is already the most this app ever asks of Sleeper, and
 * the extra urgency of a 1s poll is imperceptible next to the cost.
 */
export const ON_CLOCK_POLL_MS = 2_500;

/**
 * What to do when Sleeper is not answering.
 *
 * Modest and short — the point is to stop hammering a service that is refusing,
 * not to give up. The ladder is walked one rung per consecutive failure and
 * abandoned entirely on the first success, so a single blip costs one slow poll
 * rather than a minute of degraded cadence.
 */
export const FAILURE_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

/**
 * How long a burst of lifecycle events counts as one resume.
 *
 * Coming back to a suspended iOS tab fires `visibilitychange`, `focus` and
 * sometimes `pageshow`, in an order that is not promised, within a few
 * milliseconds of each other. All three mean the same thing, and three requests
 * for one event is the sort of thing that gets an app rate-limited.
 */
export const RESUME_COALESCE_MS = 300;

/** Consecutive failures before the board admits, quietly, that it is behind. */
export const STALE_AFTER_FAILURES = 2;

/** Why a sync is happening. Diagnostics, and the timer/explicit distinction. */
export type RefreshReason = 'mount' | 'resume' | 'online' | 'manual' | 'timer';

/** What one Sleeper draft sync reports back. */
export interface DraftSyncResult {
  status: string;
  /** Semantic state of the draft — see core/sleeper/draftFingerprint.ts. */
  fingerprint: string;
  /** The server's own view of whether this draft is still worth polling. */
  pollIntervalSeconds: number;
}

/** Everything the controller cannot decide for itself. */
export interface DraftRefreshDeps {
  /** Pull the pick stream from Sleeper. Cheap; called on the cadence. */
  sync(): Promise<DraftSyncResult>;
  /**
   * Rebuild everything downstream of draft state.
   *
   * Called **only** when the fingerprint moved. This is the expensive path —
   * board, availability, rosters, tiers, Next%, opportunity cost — and the
   * controller neither knows nor cares what is in it.
   */
  applyChange(): Promise<void>;
  /**
   * The pick state the board already on screen was built from, once it has
   * landed. Null when there is none, or when it cannot be known.
   *
   * Consulted **only for the first sync of this controller's life**, which is
   * the one on mount. Without it that sync compared its answer against `null`,
   * concluded the draft had moved, and called `applyChange` — so every cold load
   * built the board twice: once for the visit, and once more, immediately, for
   * a change that had not happened. The screen has the answer, because it has
   * just fetched a board and the board says which picks it read.
   *
   * A promise rather than a value because the visit's own request is usually
   * still in the air when this sync lands, and guessing while it is would put
   * the race back. It is awaited once, so a screen that never resolves it
   * delays one poll and nothing else; anything unknown resolves null and the
   * rebuild happens exactly as it used to.
   */
  settledFingerprint?(): Promise<string | null>;
  /** Whether Sleeper currently says it is the user's pick. */
  isOnClock(): boolean;
  isVisible(): boolean;
  isOnline(): boolean;
  /** Called after every state transition, for the screen to render. */
  onState(state: DraftRefreshState): void;
  /**
   * A sync failed, with the reason it was made.
   *
   * The distinction matters more than it looks. Somebody who taps refresh has
   * asked a question and is owed the actual answer, including "Sleeper did not
   * respond"; a poll nobody asked for has no standing to interrupt them with
   * one. The controller therefore reports rather than decides, and the screen
   * chooses which failures are worth words.
   */
  onError?(error: unknown, reason: RefreshReason): void;
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

export interface DraftRefreshState {
  /** When Sleeper was last *asked*, whatever the answer was. */
  lastCheckedAt: number | null;
  /** When the draft last actually moved. Survives any number of quiet polls. */
  lastChangedAt: number | null;
  fingerprint: string | null;
  inFlight: boolean;
  consecutiveFailures: number;
  /** The delay currently being used, or 0 when nothing is scheduled. */
  cadenceMs: number;
  nextPollAt: number | null;
  /** Repeated failures, last-good board still on screen. */
  stale: boolean;
  /** The draft status Sleeper last reported. */
  status: string | null;
  /** True once the draft is finished and the loop has retired. */
  stopped: boolean;
  lastReason: RefreshReason | null;
}

export interface DraftRefreshController {
  /** Begin: one immediate sync, then the cadence. */
  start(): void;
  /** Cancel timers and disown any answer still in the air. */
  stop(): void;
  /** Force-sync now. Joins an in-flight request rather than racing it. */
  refreshNow(reason?: RefreshReason): Promise<void>;
  /** A coalesced "we came back" — visibility, focus, pageshow, online. */
  resume(reason?: RefreshReason): void;
  /** Visibility flipped; either park the loop or resume it. */
  visibilityChanged(): void;
  getState(): DraftRefreshState;
}

const IDLE: DraftRefreshState = {
  lastCheckedAt: null,
  lastChangedAt: null,
  fingerprint: null,
  inFlight: false,
  consecutiveFailures: 0,
  cadenceMs: 0,
  nextPollAt: null,
  stale: false,
  status: null,
  stopped: false,
  lastReason: null,
};

export function createDraftRefreshController(deps: DraftRefreshDeps): DraftRefreshController {
  let state: DraftRefreshState = { ...IDLE };
  let running = false;
  let timer: number | null = null;
  let coalesce: number | null = null;
  let flight: Promise<void> | null = null;
  /**
   * A follow-up owed to somebody who asked while a request was already out.
   *
   * At most one, and that is the point: a burst of taps on the refresh glyph
   * during a slow poll should cost one extra request, not one per tap. A timer
   * tick never sets it — a poll that arrives while a poll is running has already
   * been done by the poll that is running.
   */
  let queued: RefreshReason | null = null;
  /**
   * Bumped whenever an answer stops being wanted.
   *
   * Requests do not overlap, so this is not about two responses racing each
   * other — it is about the response that is still in the air when the user
   * leaves Draft, or when the draft ends. Without it, a two-second-late reply
   * would happily rebuild the board of a screen nobody is looking at, and on
   * unmount would write to a component that is gone.
   */
  let generation = 0;

  const publish = (next: Partial<DraftRefreshState>) => {
    state = { ...state, ...next };
    deps.onState(state);
  };

  const clearTimer = () => {
    if (timer != null) deps.clearTimer(timer);
    timer = null;
  };

  /**
   * How long until the next poll, or null for "do not schedule one".
   *
   * The single place cadence is decided, which is what keeps "five seconds"
   * from being written down in four files that then disagree.
   */
  const nextDelay = (): number | null => {
    if (!running || state.stopped) return null;
    // Hidden means suspended, not slow: a phone with the app in the background
    // must not be making requests at all, and iOS will not honour the timer
    // anyway. Coming back is handled by resume(), not by a timer that fires late.
    if (!deps.isVisible() || !deps.isOnline()) return null;
    if (state.consecutiveFailures > 0) {
      const rung = Math.min(state.consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
      return FAILURE_BACKOFF_MS[rung]!;
    }
    return deps.isOnClock() ? ON_CLOCK_POLL_MS : DRAFT_POLL_MS;
  };

  const schedule = () => {
    clearTimer();
    const delay = nextDelay();
    if (delay == null) {
      publish({ cadenceMs: 0, nextPollAt: null });
      return;
    }
    timer = deps.setTimer(() => {
      timer = null;
      void run('timer');
    }, delay);
    publish({ cadenceMs: delay, nextPollAt: deps.now() + delay });
  };

  /**
   * One sync, and the decision that follows it.
   *
   * `explicit` separates "somebody asked" from "the clock came round". An
   * explicit ask that lands mid-flight is owed a follow-up, because the request
   * in the air was started before the thing that prompted the ask — a pick
   * landing, the app coming back to the foreground — and may not contain it. A
   * timer tick has no such claim and simply steps aside.
   */
  const run = async (reason: RefreshReason): Promise<void> => {
    if (!running || state.stopped) return;
    /*
     * Hidden or offline, nothing is asked — not even for an explicit trigger.
     *
     * A backgrounded page making requests is the exact battery cost this module
     * exists to avoid, and a request made while the browser says there is no
     * network is a failure that will be counted, backed off from, and shown to
     * the user as "sync delayed" when the honest answer is "you are offline".
     * Both cases resolve themselves: coming back and coming online are triggers.
     */
    if (!deps.isVisible() || !deps.isOnline()) return;
    if (flight) {
      if (reason !== 'timer') queued = queued ?? reason;
      return flight;
    }

    const gen = ++generation;
    clearTimer();
    publish({ inFlight: true, lastReason: reason });

    const work = (async () => {
      try {
        const result = await deps.sync();
        if (gen !== generation) return;
        /*
         * What this controller is comparing against.
         *
         * Its own recorded fingerprint once it has one. Before that — the sync
         * on mount — the screen's, because the screen has already asked for a
         * board and a board says which picks it was built from. Comparing
         * against `null` there was what made the first sync always look like a
         * change and rebuild a board that had just been fetched.
         */
        const known = state.fingerprint ?? (await deps.settledFingerprint?.().catch(() => null)) ?? null;
        if (gen !== generation) return;
        const checkedAt = deps.now();
        const changed = result.fingerprint !== known;
        const finished = result.pollIntervalSeconds <= 0;

        if (changed) {
          /*
           * The expensive half, and the only path that reaches it.
           *
           * `lastChangedAt` moves here and nowhere else, which is what lets the
           * header say "checked a second ago" about a draft that last moved two
           * minutes back — two different facts that a single timestamp was
           * quietly conflating.
           */
          await deps.applyChange();
          if (gen !== generation) return;
          publish({
            fingerprint: result.fingerprint,
            lastChangedAt: deps.now(),
            lastCheckedAt: checkedAt,
            status: result.status,
            consecutiveFailures: 0,
            stale: false,
            stopped: finished,
          });
        } else {
          /*
           * Nothing happened. Say so, touch nothing else, and cost the phone
           * no more than the request that just landed.
           *
           * The fingerprint is recorded here as well as above, which used to be
           * redundant and no longer is: reaching this branch now also covers
           * "the board on screen already describes this state", and without
           * writing it down the controller would go on asking the screen the
           * same question on every poll.
           */
          publish({
            fingerprint: result.fingerprint,
            lastCheckedAt: checkedAt,
            status: result.status,
            consecutiveFailures: 0,
            stale: false,
            stopped: finished,
          });
        }
      } catch (err) {
        if (gen !== generation) return;
        deps.onError?.(err, reason);
        const failures = state.consecutiveFailures + 1;
        publish({
          lastCheckedAt: deps.now(),
          consecutiveFailures: failures,
          stale: failures >= STALE_AFTER_FAILURES,
        });
      }
    })();

    flight = work;
    try {
      await work;
    } finally {
      if (gen === generation) {
        flight = null;
        publish({ inFlight: false });
        const owed = queued;
        queued = null;
        if (owed && running && !state.stopped) void run(owed);
        else schedule();
      } else {
        flight = null;
      }
    }
  };

  const clearCoalesce = () => {
    if (coalesce != null) deps.clearTimer(coalesce);
    coalesce = null;
  };

  const resume = (reason: RefreshReason = 'resume') => {
    if (!running || state.stopped) return;
    if (!deps.isVisible() || !deps.isOnline()) return;
    // One request per burst — see RESUME_COALESCE_MS. A resume already being
    // coalesced absorbs the rest of its own storm.
    if (coalesce != null) return;
    coalesce = deps.setTimer(() => {
      coalesce = null;
      void run(reason);
    }, RESUME_COALESCE_MS);
  };

  return {
    start() {
      if (running) return;
      running = true;
      state = { ...IDLE };
      // Immediately, not on the first tick. Opening Draft to a board that is
      // five seconds behind Sleeper is the bug this whole module is about.
      void run('mount');
    },

    stop() {
      running = false;
      generation++;
      clearTimer();
      clearCoalesce();
      flight = null;
      queued = null;
      publish({ inFlight: false, cadenceMs: 0, nextPollAt: null });
    },

    refreshNow(reason: RefreshReason = 'manual') {
      if (!running) return Promise.resolve();
      clearCoalesce();
      return run(reason);
    },

    resume,

    visibilityChanged() {
      if (!running) return;
      if (!deps.isVisible()) {
        // Park. Anything in the air is disowned rather than applied to a screen
        // the user has left, and no timer is left holding a wake-up.
        clearTimer();
        clearCoalesce();
        publish({ cadenceMs: 0, nextPollAt: null });
        return;
      }
      resume('resume');
    },

    getState() {
      return state;
    },
  };
}

/**
 * The refresh loop, as one line of text.
 *
 * Not UI. It is reachable from the console on the device that has the problem,
 * which is the one place where "is it even polling?" is otherwise unanswerable —
 * the correct behaviour and the broken behaviour look identical on a board where
 * nobody has picked for a minute. Same reasoning as the layout probe in
 * diagnostics.ts, and the same read-only shape: it reports, and changes nothing.
 */
export interface DraftRefreshReport extends DraftRefreshState {
  draftId: string | null;
  routeActive: boolean;
  visible: boolean;
  online: boolean;
  onClock: boolean;
  /**
   * Whether a practice draft is over the screen.
   *
   * The loop is parked while one is, through the same `isVisible` a
   * backgrounded tab uses — so without this the probe would read
   * `visible: true, cadenceMs: 0` and look exactly like the bug it exists to
   * distinguish from. `visible` stays the browser's own fact; this is the other
   * reason the loop can be parked.
   */
  mockOpen?: boolean;
}

export function installDraftRefreshProbe(read: () => DraftRefreshReport): () => void {
  const target = window as unknown as { __draftRefresh?: () => DraftRefreshReport };
  target.__draftRefresh = read;
  return () => {
    delete target.__draftRefresh;
  };
}
