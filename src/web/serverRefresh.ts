/**
 * Round 22: one refresh behaviour for Team, Waivers, Matchup and Data health.
 *
 * A tap asks the server to start a refresh job (or join the one running) and
 * gets an answer at once. The work runs on the server, so it finishes whether
 * or not this page is still open. While the page is open and the job runs,
 * this asks for the job's one row every {@link POLL_MS}; when the phone comes
 * back to the app it asks once. Whenever it sees a job finish that this screen
 * has not drawn yet, it calls `onFinished`, which reloads the screen.
 *
 * Nothing here shows a message about a source. A failed source is in the job
 * row, and Data health lists it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RefreshJob, type RefreshKind } from './api.ts';

/** How often a running job is checked while the page is in front. */
export const POLL_MS = 1_500;

/** The longest a pull or tap waits for a job before letting go of its spinner. */
export const MAX_WAIT_MS = 60_000;

export interface ServerRefresh {
  /** The last job this screen knows about. */
  job: RefreshJob | null;
  /** A job is starting or running: spin, and do not take another tap. */
  busy: boolean;
  /** When the last finished job finished (ISO), for `Updated 7:15 AM`. */
  finishedAt: string | null;
  /**
   * Start (or join) a refresh and wait for it to finish. Resolves true when a
   * newly finished job was handed to `onFinished` (the screen reloaded).
   */
  start: () => Promise<boolean>;
}

export function useServerRefresh(
  kind: RefreshKind,
  opts: { onFinished: () => void | Promise<unknown>; onError?: (err: unknown) => void; enabled?: boolean },
): ServerRefresh {
  const enabled = opts.enabled ?? true;
  const [job, setJob] = useState<RefreshJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;
  const onError = useRef(opts.onError);
  onError.current = opts.onError;
  /** The finished job this screen last drew, so a job reloads the screen once. */
  const seen = useRef<string | null | undefined>(undefined);
  const reloads = useRef(0);
  const waiters = useRef<(() => void)[]>([]);
  const busyRef = useRef(false);

  const absorb = useCallback(async (next: RefreshJob | null, initial = false) => {
    setJob(next);
    if (!next || next.state === 'running') return;
    if (next.finishedAt) setFinishedAt(next.finishedAt);
    const stamp = `${next.id}:${next.finishedAt ?? 'cut'}`;
    if (initial) {
      // The screen is loading its data right now; this job is already in it.
      seen.current = stamp;
    } else if (seen.current !== stamp) {
      seen.current = stamp;
      reloads.current += 1;
      try {
        await onFinished.current();
      } catch {
        /* the screen's own loader reports its own failures */
      }
    }
    const list = waiters.current;
    waiters.current = [];
    for (const resolve of list) resolve();
  }, []);

  const check = useCallback(
    async (initial = false) => {
      try {
        const res = await api.get<{ job: RefreshJob | null }>(`/api/refresh/status?kind=${kind}`);
        await absorb(res.job, initial);
      } catch {
        /* quiet: an older server, Demo Mode, or no signal; the next look tries again */
      }
    },
    [kind, absorb],
  );

  // Once on open: the time for the header, and a job still running from before.
  useEffect(() => {
    if (enabled) void check(true);
  }, [enabled, check]);

  // While a job runs and the page is in front, look every POLL_MS.
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === 'visible') await check();
      if (alive) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [running, check]);

  // Back from another app or the lock screen: one look, and a reload if it finished meanwhile.
  useEffect(() => {
    if (!enabled) return;
    const onReturn = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, [enabled, check]);

  const waitForDone = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        window.setTimeout(resolve, MAX_WAIT_MS);
      }),
    [],
  );

  const start = useCallback(async (): Promise<boolean> => {
    const before = reloads.current;
    if (busyRef.current) {
      await waitForDone();
      return reloads.current > before;
    }
    busyRef.current = true;
    setStarting(true);
    try {
      const res = await api.post<{ job: RefreshJob; joined: boolean }>('/api/refresh', { kind });
      const waiting = res.job.state === 'running' ? waitForDone() : null;
      await absorb(res.job);
      if (waiting) await waiting;
    } catch (err) {
      onError.current?.(err);
    } finally {
      busyRef.current = false;
      setStarting(false);
    }
    return reloads.current > before;
  }, [kind, absorb, waitForDone]);

  return { job, busy: starting || running, finishedAt, start };
}

/**
 * `5:00 AM` today, `Tue 5:00 AM` this week, `Sep 23` before that.
 *
 * In the reader's own clock. The instant is the server's; the words are the
 * phone's.
 */
export function formatUpdated(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'recently';
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return time;
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 6) return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The later of two instants, either of which may be missing. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b! : null;
  if (!Number.isFinite(tb)) return a!;
  return ta >= tb ? a! : b!;
}
