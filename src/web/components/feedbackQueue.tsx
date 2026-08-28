/**
 * Everything flagged, in one place, and the one action that gets it out.
 *
 * The row lives in Settings → This app, immediately beside the two things it
 * belongs with: `Data health`, which says whether what the app knew was current,
 * and `Copy support snapshot`, which captures the state behind one
 * recommendation. Those three are the support loop, and this is its inbox — the
 * only one of them that holds anything from *before* the reader arrived here.
 *
 * It is not a Review dashboard and must not become one. There is exactly one
 * verb per entry (forget it) and one for the queue (copy it out), because the
 * whole feature exists so that noticing something costs a tap and reporting it
 * costs a paste.
 *
 * ## Copy asks before it clears
 *
 * The clipboard is not a receipt. A copy that emptied the queue would be
 * irreversible on the strength of an operation that silently fails on iOS
 * outside a secure context, that a reader may well be running only to see what
 * the text looks like, and whose success the app cannot verify beyond the
 * promise resolving. So the copy copies, and then the row asks. Keeping is the
 * quiet answer and clearing is the deliberate one.
 */

import { useCallback, useEffect, useState } from 'react';
import { Empty, Notice } from './common.tsx';
import { FlagIcon, TrashIcon } from './icons.tsx';
import { ListGroup, ListRow, PushScreen } from './native.tsx';
import {
  clearQueue,
  describeWhen,
  formatQueue,
  readQueue,
  removeFlag,
  type FlagEntry,
} from '../feedbackQueue.ts';

/** How the count reads on the row, and in the pushed screen's subtitle. */
function describeCount(count: number): string {
  if (count === 0) return 'Nothing flagged';
  return `${count} ${count === 1 ? 'thing' : 'things'} flagged`;
}

/**
 * The row in Settings.
 *
 * It reads the queue on mount and whenever the screen is returned to, which is
 * every time the pushed panel closes — that is what keeps the count on the row
 * and the list behind it from disagreeing after a delete. There is no
 * subscription because there is nothing else in the app that can change this
 * while Settings is on screen: the control that writes to it is drawn by the
 * shell, and the shell's control is not reachable from a screen the reader is
 * standing on with the panel open.
 */
export function FlaggedRow({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(readQueue().length);
  }, []);

  return (
    <ListRow
      testId="setup-flagged"
      /*
       * `todo` rather than `warn`, and nothing at all on the toolbar.
       *
       * The Review row warns because what is in it is work the app is waiting
       * on somebody to do. A flag is the reader's own note to themselves, and a
       * queue of them is not a fault: it is what the feature working looks
       * like. So it is marked as something to come back to and it puts no dot
       * on the Settings destination — a personal list that nags is a list
       * people stop adding to.
       */
      dataState={count > 0 ? 'todo' : 'ok'}
      state={
        <span className="list-state-todo">
          <FlagIcon size={17} />
        </span>
      }
      label="Flagged"
      /*
       * The count is in the row's own words and nowhere else. A numeral in the
       * trailing slot beside a sentence that already says "3 things flagged" is
       * the same fact twice, once silently — the argument the Review row makes,
       * and it applies here for the same reason.
       */
      detail={
        count > 0
          ? `${describeCount(count)} while using the app. Copy them all to send somewhere.`
          : 'Nothing flagged. Tap the flag in the corner of any screen to mark something.'
      }
      chevron
      onClick={onOpen}
    />
  );
}

type CopyState = { done: 'copied' | 'saved'; count: number } | null;

/**
 * The queue itself, as a pushed screen.
 *
 * Newest first, which is both the order the queue is stored in and the order
 * somebody talks about their own list in: the thing they flagged five minutes
 * ago is the thing they came here about.
 */
export function FlaggedScreen({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<FlagEntry[]>(() => readQueue());
  const [copied, setCopied] = useState<CopyState>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /*
   * The clock the ages are measured against, read once when the screen opens.
   *
   * Not `Date.now()` inside the render: a list that recomputes "4 minutes ago"
   * on every keystroke elsewhere would be a screen whose text changes for
   * reasons the reader cannot see. It is a pushed screen with a short life, and
   * re-reading the clock when it is opened is exactly as fresh as it needs.
   */
  const [now] = useState(() => Date.now());

  const forget = useCallback((id: string) => {
    setEntries(removeFlag(id));
    setCopied(null);
  }, []);

  const copyAll = async () => {
    const text = formatQueue(entries, Date.now());
    setFailed(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ done: 'copied', count: entries.length });
    } catch {
      /*
       * What happened, not why — the same call the support snapshot's row
       * makes, and for the same reason: a clipboard write is refused for
       * several reasons this code cannot tell apart, so naming one would be a
       * guess presented as a diagnosis. What the reader needs is that the text
       * exists and where it went.
       */
      try {
        downloadText(`fantasy-analyst-flagged-${stampNow()}.txt`, text);
        setCopied({ done: 'saved', count: entries.length });
      } catch (err) {
        setFailed(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <PushScreen
      title="Flagged"
      subtitle={describeCount(entries.length)}
      backLabel="Setup"
      onBack={onBack}
      testId="flagged-screen"
    >
      {entries.length === 0 ? (
        <Empty>
          Nothing is flagged. The flag in the corner of every screen marks whatever you are looking
          at, so you can come back to it here.
        </Empty>
      ) : (
        <>
          <ListGroup
            testId="flagged-list"
            footer="Kept on this phone only. Nothing here has been sent anywhere."
          >
            {entries.map((entry) => (
              <ListRow
                key={entry.id}
                testId={`flag-entry-${entry.id}`}
                label={entry.screen}
                detail={
                  <>
                    {/*
                      The note first, because it is the reader's own sentence
                      and everything under it is the app's account of where they
                      were standing when they wrote it.
                    */}
                    <span className="flagged-note">{entry.note ?? 'No note'}</span>
                    {/*
                      The decision is named as one, not left as a bare word.

                      It read `just now · Team` under a row headed `Players`,
                      which is two screen names on one line saying different
                      things — and the smaller, quieter one is the one that is
                      not the row's subject. The copied block says
                      `Last recommendation:` for the same reason, and the two
                      now say it the same way.
                    */}
                    <span className="flagged-when">
                      {describeWhen(entry.at, now)}
                      {entry.decision ? ` · last recommendation: ${entry.decision}` : ''}
                      {entry.world === 'Live' ? '' : ` · ${entry.world}`}
                    </span>
                  </>
                }
                /*
                 * A row that carries its own control is a container with a
                 * sibling button in it, never one button wrapping another — the
                 * sixth rule of the design system. This row leads nowhere, so
                 * it is a plain container and the delete is the only control on
                 * it.
                 */
                value={
                  <button
                    type="button"
                    className="flagged-forget"
                    data-testid={`flag-forget-${entry.id}`}
                    aria-label={`Forget the flag on ${entry.screen}`}
                    onClick={() => forget(entry.id)}
                  >
                    <span aria-hidden="true">
                      <TrashIcon />
                    </span>
                  </button>
                }
              />
            ))}
          </ListGroup>

          <div className="btn-row" style={{ margin: '0 4px 12px' }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="flagged-copy-all"
              style={{ width: '100%' }}
              onClick={() => void copyAll()}
            >
              {`Copy all ${entries.length}`}
            </button>
          </div>

          {failed ? <Notice tone="error">{failed}</Notice> : null}

          {/*
            Copied, and then the question.

            Two controls, and the destructive one is not the primary: keeping is
            what somebody who tapped copy to *look* at the text wants, and it is
            what happens if they do nothing at all.
          */}
          {copied ? (
            <Notice tone="ok" data-testid="flagged-copied">
              <div>
                {copied.done === 'copied'
                  ? `Copied ${copied.count} ${copied.count === 1 ? 'flag' : 'flags'}. Paste it wherever you want to talk about them.`
                  : `This browser would not take it on the clipboard, so ${copied.count} ${copied.count === 1 ? 'flag was' : 'flags were'} saved as a file instead.`}
              </div>
              <div style={{ marginTop: 6 }}>Clear the queue now, or keep it?</div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="flagged-clear"
                  onClick={() => {
                    clearQueue();
                    setEntries([]);
                    setCopied(null);
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-testid="flagged-keep"
                  onClick={() => setCopied(null)}
                >
                  Keep
                </button>
              </div>
            </Notice>
          ) : null}
        </>
      )}
    </PushScreen>
  );
}

/** `2026-08-28T20:41:07.000Z` → `20260828-2041`. Sortable and filename-safe. */
function stampNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`;
}

/**
 * Hand the reader the text as a file, when the clipboard will not take it.
 *
 * A blob URL and a synthetic click, revoked on the next frame rather than
 * immediately because Safari has not finished reading the URL when `click()`
 * returns. `text/plain` rather than the support snapshot's `application/json`,
 * because what this copies is prose and a `.json` extension on a paragraph
 * would send it to the wrong application.
 */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
