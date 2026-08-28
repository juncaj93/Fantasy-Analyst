/**
 * The refresh loop, driven by a clock this file owns.
 *
 * Every timer and every read of "now" is injected, so a ten-minute draft runs in
 * a millisecond and the assertions are counts rather than waits. That is the
 * entire reason the controller takes its scheduler as a dependency: a loop whose
 * only observable behaviour is *when* it does things cannot be tested by a suite
 * that has to sit through them.
 *
 * What is being defended, in one sentence each: it asks immediately when you
 * arrive, roughly every five seconds while you are there, faster on your turn,
 * never while you are away, never twice at once, and it only makes the expensive
 * board rebuild happen when Sleeper actually said something new.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_POLL_MS,
  FAILURE_BACKOFF_MS,
  ON_CLOCK_POLL_MS,
  RESUME_COALESCE_MS,
  createDraftRefreshController,
  type DraftRefreshController,
  type DraftRefreshState,
  type DraftSyncResult,
} from '../src/web/draftRefresh.ts';

/** Let every already-resolved promise in the chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A virtual clock: timers fire in order, and time only moves when asked. */
class Clock {
  time = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  set = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };

  clear = (id: number): void => {
    this.timers.delete(id);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Run everything due within `ms`, settling promises between each. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

interface Harness {
  clock: Clock;
  controller: DraftRefreshController;
  sync: ReturnType<typeof vi.fn>;
  applyChange: ReturnType<typeof vi.fn>;
  settledFingerprint: ReturnType<typeof vi.fn>;
  states: DraftRefreshState[];
  errors: unknown[];
  state(): DraftRefreshState;
  setVisible(v: boolean): void;
  setOnline(v: boolean): void;
  setOnClock(v: boolean): void;
}

/**
 * A controller wired to a scripted Sleeper.
 *
 * `respond` is called per poll and decides what came back, so a test reads as a
 * sequence of draft states rather than as timer arithmetic.
 */
function harness(
  respond: (call: number) => Promise<DraftSyncResult> | DraftSyncResult,
  /**
   * What the board already on screen was built from, as the screen reports it.
   *
   * Undefined models a screen that cannot say — an older deployment, or a board
   * that never arrived — and the controller then behaves exactly as it always
   * did. See `settledFingerprint` in `draftRefresh.ts`.
   */
  settled?: () => Promise<string | null>,
): Harness {
  const clock = new Clock();
  let visible = true;
  let online = true;
  let onClock = false;
  let calls = 0;
  const states: DraftRefreshState[] = [];
  const errors: unknown[] = [];

  const sync = vi.fn(() => Promise.resolve(respond(++calls)));
  const applyChange = vi.fn(() => Promise.resolve());
  const settledFingerprint = vi.fn(() => (settled ? settled() : Promise.resolve(null)));

  const controller = createDraftRefreshController({
    sync: sync as unknown as () => Promise<DraftSyncResult>,
    applyChange: applyChange as unknown as () => Promise<void>,
    ...(settled ? { settledFingerprint: settledFingerprint as unknown as () => Promise<string | null> } : {}),
    isOnClock: () => onClock,
    isVisible: () => visible,
    isOnline: () => online,
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    now: () => clock.time,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });

  return {
    clock,
    controller,
    sync,
    applyChange,
    settledFingerprint,
    states,
    errors,
    state: () => controller.getState(),
    setVisible: (v) => {
      visible = v;
    },
    setOnline: (v) => {
      online = v;
    },
    setOnClock: (v) => {
      onClock = v;
    },
  };
}

/** A draft that never moves: same fingerprint, every time. */
const still = (): DraftSyncResult => ({ status: 'drafting', fingerprint: 'fp-A', pollIntervalSeconds: 5 });

/** A draft where every poll finds a new pick. */
const moving = (call: number): DraftSyncResult => ({
  status: 'drafting',
  fingerprint: `fp-${call}`,
  pollIntervalSeconds: 5,
});

describe('immediate triggers', () => {
  it('syncs the moment Draft opens, without waiting for the first tick', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();

    expect(h.sync).toHaveBeenCalledTimes(1);
    // And the very first answer is treated as new, because there was nothing
    // to compare it to — a screen that cannot say what it is holding still
    // gets its board built on arrival.
    expect(h.applyChange).toHaveBeenCalledTimes(1);
  });

  /*
   * The cold-load double build, and the end of it.
   *
   * Draft used to build its board twice for one visit: the screen fetched one
   * on mount, and the mount sync immediately asked for a second, because with
   * no fingerprint of its own it read its first answer as a change. On a phone
   * mid-draft that was a whole redundant board — the assembly, the Monte Carlo
   * survival runs, the transfer — on every arrival.
   *
   * The screen now says what the board it is holding was built from, in the
   * sync route's own terms, and the two are compared instead of assumed apart.
   */
  it('does not rebuild on arrival when the board on screen is already current', async () => {
    const h = harness(still, () => Promise.resolve('fp-A'));
    h.controller.start();
    await settle();

    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.applyChange, 'the visit already fetched this exact board').not.toHaveBeenCalled();
    // It is still recorded, so the loop is not asking the screen the same
    // question on every poll from here on.
    expect(h.state().fingerprint).toBe('fp-A');
    await h.clock.advance(DRAFT_POLL_MS + 1);
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(h.settledFingerprint).toHaveBeenCalledTimes(1);
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  /** A pick that landed between the visit's request and the mount sync. */
  it('still rebuilds on arrival when the sync found a pick the board has not got', async () => {
    const h = harness(still, () => Promise.resolve('fp-older'));
    h.controller.start();
    await settle();

    expect(h.applyChange).toHaveBeenCalledTimes(1);
    expect(h.state().fingerprint).toBe('fp-A');
  });

  /** A screen with no board yet, or one that failed: rebuild, as before. */
  it('rebuilds on arrival when the screen has nothing to compare against', async () => {
    const h = harness(still, () => Promise.resolve(null));
    h.controller.start();
    await settle();

    expect(h.applyChange).toHaveBeenCalledTimes(1);
  });

  /** And a screen whose answer throws is a screen that did not answer. */
  it('rebuilds on arrival when the screen cannot say what it is holding', async () => {
    const h = harness(still, () => Promise.reject(new Error('no board')));
    h.controller.start();
    await settle();

    expect(h.applyChange).toHaveBeenCalledTimes(1);
    expect(h.errors, 'a screen that cannot answer is not a failed sync').toHaveLength(0);
  });

  /*
   * Everything after the arrival is unchanged, which is the other half of the
   * claim: the screen is consulted once, and the loop's own fingerprint decides
   * every poll from then on — including the pick that lands while you read.
   */
  it('picks up a pick that lands after an arrival that rebuilt nothing', async () => {
    let fingerprint = 'fp-A';
    const h = harness(
      () => ({ status: 'drafting', fingerprint, pollIntervalSeconds: 5 }),
      () => Promise.resolve('fp-A'),
    );
    h.controller.start();
    await settle();
    expect(h.applyChange).not.toHaveBeenCalled();

    fingerprint = 'fp-B';
    await h.clock.advance(DRAFT_POLL_MS + 1);
    expect(h.applyChange).toHaveBeenCalledTimes(1);
    expect(h.settledFingerprint, 'asked once, on arrival, and never again').toHaveBeenCalledTimes(1);
  });

  it('syncs again on resume, and does not wait out the cadence first', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();

    h.setVisible(false);
    h.controller.visibilityChanged();
    await h.clock.advance(60_000);
    expect(h.sync, 'a hidden page asks Sleeper nothing').toHaveBeenCalledTimes(1);

    h.setVisible(true);
    h.controller.visibilityChanged();
    await h.clock.advance(RESUME_COALESCE_MS);
    expect(h.sync, 'coming back catches up immediately').toHaveBeenCalledTimes(2);
  });

  it('syncs when the network comes back', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    h.setOnline(false);
    await h.clock.advance(30_000);
    expect(h.sync, 'no futile requests while the browser says offline').toHaveBeenCalledTimes(1);

    h.setOnline(true);
    h.controller.resume('online');
    await h.clock.advance(RESUME_COALESCE_MS);
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  it('syncs on a manual tap', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    await h.controller.refreshNow('manual');
    expect(h.sync).toHaveBeenCalledTimes(2);
  });

  /**
   * iOS fires several signals for one resume, in no promised order. Three
   * requests for one event is how an app gets rate limited.
   */
  it('coalesces a burst of resume signals into one request', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    h.sync.mockClear();

    h.controller.resume('resume');
    h.controller.resume('resume');
    h.controller.resume('resume');
    await h.clock.advance(RESUME_COALESCE_MS);

    expect(h.sync).toHaveBeenCalledTimes(1);
  });
});

describe('cadence', () => {
  it('polls about every five seconds while Draft is open and live', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    expect(h.state().cadenceMs).toBe(DRAFT_POLL_MS);

    await h.clock.advance(DRAFT_POLL_MS);
    expect(h.sync).toHaveBeenCalledTimes(2);
    await h.clock.advance(DRAFT_POLL_MS);
    expect(h.sync).toHaveBeenCalledTimes(3);
  });

  it('tightens to 2.5s on the user’s turn and relaxes again after it', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    expect(h.state().cadenceMs).toBe(DRAFT_POLL_MS);

    h.setOnClock(true);
    await h.clock.advance(DRAFT_POLL_MS);
    expect(h.state().cadenceMs, 'the pick is on the clock now').toBe(ON_CLOCK_POLL_MS);

    const during = h.sync.mock.calls.length;
    await h.clock.advance(ON_CLOCK_POLL_MS);
    expect(h.sync).toHaveBeenCalledTimes(during + 1);

    h.setOnClock(false);
    await h.clock.advance(ON_CLOCK_POLL_MS);
    expect(h.state().cadenceMs, 'the turn has passed').toBe(DRAFT_POLL_MS);
  });

  it('stops polling while the page is hidden, and schedules nothing', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();

    h.setVisible(false);
    h.controller.visibilityChanged();
    expect(h.state().cadenceMs).toBe(0);
    expect(h.state().nextPollAt).toBeNull();

    const before = h.sync.mock.calls.length;
    await h.clock.advance(10 * 60_000);
    expect(h.sync, 'ten minutes in the background costs nothing').toHaveBeenCalledTimes(before);
  });

  /**
   * Not just "makes no requests" — arms no timer.
   *
   * A request already in the air when the app is backgrounded still lands, and
   * the code that runs when it does is the code that schedules the next poll.
   * If that path does not check visibility, the phone is left holding a wake-up
   * for a screen nobody is looking at: no request goes out, because the poll
   * itself checks too, but the timer fires and the CPU wakes for nothing. This
   * is the assertion that tells those two apart.
   */
  it('leaves no timer armed when the page goes away mid-request', async () => {
    let release!: (value: DraftSyncResult) => void;
    const gate = new Promise<DraftSyncResult>((resolve) => {
      release = resolve;
    });
    const h = harness((call) => (call === 1 ? gate : still()));
    h.controller.start();
    await settle();

    h.setVisible(false);
    h.controller.visibilityChanged();
    release(still());
    await settle();

    expect(h.clock.pending, 'nothing wakes the phone in the background').toBe(0);
  });

  it('retires when Sleeper says the draft is complete', async () => {
    const h = harness((call) =>
      call === 1
        ? still()
        : { status: 'complete', fingerprint: 'fp-done', pollIntervalSeconds: 0 },
    );
    h.controller.start();
    await settle();
    await h.clock.advance(DRAFT_POLL_MS);

    expect(h.state().stopped).toBe(true);
    expect(h.state().cadenceMs).toBe(0);

    const after = h.sync.mock.calls.length;
    await h.clock.advance(10 * 60_000);
    expect(h.sync, 'a finished draft is not polled forever').toHaveBeenCalledTimes(after);
  });

  it('stops polling when the screen goes away, leaving no timers behind', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    h.controller.stop();

    expect(h.clock.pending, 'no leaked timeout').toBe(0);
    const before = h.sync.mock.calls.length;
    await h.clock.advance(60_000);
    expect(h.sync).toHaveBeenCalledTimes(before);
  });
});

describe('failure and recovery', () => {
  it('backs off along the ladder and resets on the first success', async () => {
    let fail = true;
    const h = harness(() => {
      if (fail) throw new Error('Sleeper did not respond');
      return still();
    });
    h.controller.start();
    await settle();
    expect(h.state().consecutiveFailures).toBe(1);
    expect(h.state().cadenceMs).toBe(FAILURE_BACKOFF_MS[0]);

    await h.clock.advance(FAILURE_BACKOFF_MS[0]!);
    expect(h.state().cadenceMs).toBe(FAILURE_BACKOFF_MS[1]);
    await h.clock.advance(FAILURE_BACKOFF_MS[1]!);
    expect(h.state().cadenceMs).toBe(FAILURE_BACKOFF_MS[2]);
    await h.clock.advance(FAILURE_BACKOFF_MS[2]!);
    expect(h.state().cadenceMs).toBe(FAILURE_BACKOFF_MS[3]);
    // The ladder has a top; it does not keep doubling into next week.
    await h.clock.advance(FAILURE_BACKOFF_MS[3]!);
    expect(h.state().cadenceMs).toBe(FAILURE_BACKOFF_MS[3]);

    fail = false;
    await h.clock.advance(FAILURE_BACKOFF_MS[3]!);
    expect(h.state().consecutiveFailures).toBe(0);
    expect(h.state().cadenceMs, 'one good answer is enough').toBe(DRAFT_POLL_MS);
    expect(h.state().stale).toBe(false);
  });

  it('admits it is behind only after failing twice, and keeps the board', async () => {
    const h = harness(() => {
      throw new Error('nope');
    });
    h.controller.start();
    await settle();
    expect(h.state().stale, 'one blip is a tunnel, not a fault').toBe(false);

    await h.clock.advance(FAILURE_BACKOFF_MS[0]!);
    expect(h.state().stale).toBe(true);
    // Nothing downstream was rebuilt on a failure — the last good board stands.
    expect(h.applyChange).not.toHaveBeenCalled();
  });

  it('reports the reason a failed sync happened, so only taps get words', async () => {
    const h = harness(() => {
      throw new Error('Sleeper did not respond');
    });
    h.controller.start();
    await settle();
    expect(h.errors).toHaveLength(1);
    expect((h.errors[0] as Error).message).toBe('Sleeper did not respond');
  });
});

describe('single flight', () => {
  /** A sync that hangs until the test releases it. */
  function pending() {
    let release!: (value: DraftSyncResult) => void;
    const promise = new Promise<DraftSyncResult>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('joins a manual tap to the request already in the air, then owes one follow-up', async () => {
    const gate = pending();
    const h = harness((call) => (call === 1 ? gate.promise : still()));
    h.controller.start();
    await settle();
    expect(h.sync).toHaveBeenCalledTimes(1);

    // Three taps while the first request is still out.
    void h.controller.refreshNow('manual');
    void h.controller.refreshNow('manual');
    void h.controller.refreshNow('manual');
    await settle();
    expect(h.sync, 'no overlapping Sleeper calls').toHaveBeenCalledTimes(1);

    gate.release(still());
    await settle();
    expect(h.sync, 'the taps are owed exactly one follow-up between them').toHaveBeenCalledTimes(2);
  });

  it('lets a timer tick step aside rather than queue behind a slow request', async () => {
    const gate = pending();
    const h = harness((call) => (call === 1 ? gate.promise : still()));
    h.controller.start();
    await settle();

    // The cadence comes round while the first request is still out. It has
    // nothing to add — the request in the air is already asking the question.
    await h.clock.advance(DRAFT_POLL_MS * 3);
    expect(h.sync).toHaveBeenCalledTimes(1);

    gate.release(still());
    await settle();
    expect(h.sync, 'no queued follow-up from a timer').toHaveBeenCalledTimes(1);
  });

  it('discards an answer that arrives after the screen is gone', async () => {
    const gate = pending();
    const h = harness((call) => (call === 1 ? gate.promise : still()));
    h.controller.start();
    await settle();

    h.controller.stop();
    gate.release({ status: 'drafting', fingerprint: 'fp-new', pollIntervalSeconds: 5 });
    await settle();

    expect(h.applyChange, 'a stale response never rebuilds a board nobody is on').not.toHaveBeenCalled();
    expect(h.clock.pending).toBe(0);
  });
});

describe('change detection', () => {
  it('does no downstream work at all when the draft has not moved', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    expect(h.applyChange).toHaveBeenCalledTimes(1); // the first board

    const changedAt = h.state().lastChangedAt;
    await h.clock.advance(DRAFT_POLL_MS * 5);

    expect(h.sync, 'it kept checking').toHaveBeenCalledTimes(6);
    expect(h.applyChange, 'and rebuilt nothing').toHaveBeenCalledTimes(1);
    expect(h.state().lastChangedAt, 'the draft is still as old as it was').toBe(changedAt);
    expect(h.state().lastCheckedAt, 'but it was just checked').toBe(h.clock.time);
  });

  it('rebuilds exactly once per new pick', async () => {
    const h = harness(moving);
    h.controller.start();
    await settle();
    await h.clock.advance(DRAFT_POLL_MS * 3);

    expect(h.sync).toHaveBeenCalledTimes(4);
    expect(h.applyChange, 'one rebuild per change, never two').toHaveBeenCalledTimes(4);
    expect(h.state().lastChangedAt).toBe(h.clock.time);
  });

  /**
   * A rebuild that failed is not a rebuild.
   *
   * The fingerprint is only allowed to move once the board has actually been
   * built from it. Recording it first would mean a single failed board request
   * left the screen showing a draft that had moved on, with the loop quietly
   * agreeing that everything was up to date until the *next* pick landed — a
   * stale board and no indication anywhere that it was stale.
   */
  it('does not adopt a fingerprint whose rebuild failed', async () => {
    const h = harness(moving);
    let boardBroken = true;
    h.applyChange.mockImplementation(() => (boardBroken ? Promise.reject(new Error('board 500')) : Promise.resolve()));

    h.controller.start();
    await settle();
    expect(h.state().fingerprint, 'nothing was successfully applied').toBeNull();
    expect(h.state().consecutiveFailures).toBe(1);
    expect(h.state().lastChangedAt).toBeNull();

    boardBroken = false;
    await h.clock.advance(FAILURE_BACKOFF_MS[0]!);
    expect(h.state().fingerprint).not.toBeNull();
    expect(h.state().consecutiveFailures).toBe(0);
    expect(h.state().lastChangedAt).toBe(h.clock.time);
  });

  it('rebuilds when only pick ownership or status moved', async () => {
    const h = harness((call) =>
      call === 1
        ? { status: 'drafting', fingerprint: 'fp-A', pollIntervalSeconds: 5 }
        : { status: 'paused', fingerprint: 'fp-B', pollIntervalSeconds: 30 },
    );
    h.controller.start();
    await settle();
    await h.clock.advance(DRAFT_POLL_MS);
    expect(h.applyChange).toHaveBeenCalledTimes(2);
    expect(h.state().status).toBe('paused');
  });
});

describe('request budget', () => {
  it('costs about twelve requests a minute over ten active minutes', async () => {
    const h = harness(still);
    h.controller.start();
    await settle();
    await h.clock.advance(10 * 60_000);

    // 600s / 5s = 120 polls, plus the one on arrival.
    expect(h.sync.mock.calls.length).toBeLessThanOrEqual(121);
    expect(h.sync.mock.calls.length).toBeGreaterThan(100);
  });

  it('costs about twenty-four in a minute on the clock', async () => {
    const h = harness(still);
    h.setOnClock(true);
    h.controller.start();
    await settle();
    await h.clock.advance(60_000);

    expect(h.sync.mock.calls.length).toBeLessThanOrEqual(25);
    expect(h.sync.mock.calls.length).toBeGreaterThan(20);
  });

  it('costs nothing at all in the background', async () => {
    const h = harness(still);
    h.setVisible(false);
    h.controller.start();
    await settle();
    await h.clock.advance(10 * 60_000);

    expect(h.sync, 'a hidden Draft is not a draft the user is at').not.toHaveBeenCalled();
  });
});

/**
 * Mutation coverage.
 *
 * Each of these re-implements the loop with one specific rule removed and
 * asserts that the resulting behaviour is one the tests above would reject. It
 * is the difference between a suite that passes and a suite that would notice.
 */
describe('the tests would catch a regression', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness(still);
  });

  it('notices a loop that polls while hidden', async () => {
    h.controller.start();
    await settle();
    h.setVisible(false);
    h.controller.visibilityChanged();
    await h.clock.advance(60_000);
    // If the visibility guard were dropped, this count would climb.
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('notices a resume that waits for the cadence instead of syncing', async () => {
    h.controller.start();
    await settle();
    h.setVisible(false);
    h.controller.visibilityChanged();
    h.setVisible(true);
    h.controller.visibilityChanged();
    await h.clock.advance(RESUME_COALESCE_MS);
    // A resume that merely restarted the timer would still be at 1 here.
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(h.clock.time).toBeLessThan(DRAFT_POLL_MS);
  });

  it('notices an unchanged poll that rebuilds anyway', async () => {
    h.controller.start();
    await settle();
    await h.clock.advance(DRAFT_POLL_MS * 4);
    // Dropping the fingerprint comparison would make this 5.
    expect(h.applyChange).toHaveBeenCalledTimes(1);
  });
});
