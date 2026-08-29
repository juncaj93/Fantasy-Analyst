/**
 * Writing a note down, and the queue the notes go into.
 *
 * Both live in Settings → This app, beside the two things they belong with:
 * `Data health`, which says whether what the app knew was current, and `Copy
 * support snapshot`, which captures the state behind one recommendation. Those
 * are the support loop, and this is the part of it that is just words — the
 * place to say *the bench total looks wrong* when there is no recommendation to
 * capture and nothing for an engine to replay.
 *
 * ## The action is here, and only here
 *
 * There is no per-screen trigger and nothing floating over the app. Writing
 * feedback is a thing the owner sits down to do, in the one place the app keeps
 * its tools, next to the list it goes into — so the count on the row below
 * moves the moment a note is saved, which is the whole confirmation the
 * interaction needs.
 *
 * The composer unfolds under the row rather than opening a sheet or pushing a
 * screen. A sheet can be flicked away, and flicking away a half-typed sentence
 * is a bad trade for a modal nobody asked for; a pushed screen would put a
 * navigation transition around a single line of text. Unfolding in place is the
 * arrangement the newsletter's own two controls already use — see
 * `.list-row-actions` — and it keeps the queue's count visible one row down
 * while the note is being written.
 *
 * ## Nothing is captured but the words
 *
 * The entry carries the note, the time, and the session facts that stay true
 * wherever it was typed. It does not record which screen anybody was on,
 * because nothing asks them to be on one. See `feedbackQueue.ts`.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Notice } from './common.tsx';
import { FlagIcon, TrashIcon } from './icons.tsx';
import { ListGroup, ListRow, PushScreen } from './native.tsx';
import {
  MAX_NOTE,
  addFlag,
  buildFlag,
  clearQueue,
  describeWhen,
  formatQueue,
  readQueue,
  removeFlag,
  type FlagEntry,
} from '../feedbackQueue.ts';
import { LIVE_WORLD, currentWorld } from '../world.ts';
import { readAppearance, resolveAppearance } from '../theme.ts';
import { isStandalone } from '../standalone.ts';

/** How the count reads on the row, and in the pushed screen's subtitle. */
function describeCount(count: number): string {
  if (count === 0) return 'No feedback saved';
  return `${count} ${count === 1 ? 'note' : 'notes'} saved`;
}

/**
 * An entry's id.
 *
 * `crypto.randomUUID` is not on every browser this app supports, and the
 * uniqueness needed here is only "within one phone's queue of fifty" — so the
 * instant plus a little randomness is both sufficient and cheap. It never
 * leaves the device and nothing joins on it.
 */
function newId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `live` → `Live`; a scenario → the scenario, named as one. */
function describeWorld(world: string): string {
  return world === LIVE_WORLD ? 'Live' : `Demo: ${world}`;
}

/**
 * The two rows: write one down, and see the ones already written.
 *
 * One component rather than two, because they share a single number and two
 * components would be two reads of it — which is how a row says "2 notes saved"
 * above a queue holding three. The count is read on mount and moved by the only
 * thing on this screen that can change it, which is the composer directly above
 * it.
 *
 * `onOpen` pushes the queue screen; `onChanged` lets Settings re-read anything
 * of its own that cares. Nothing here writes outside the queue.
 */
export function FeedbackRows({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState(0);
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');
  /** The last note saved, so the row can confirm it without a banner. */
  const [saved, setSaved] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCount(readQueue().length);
  }, []);

  /*
   * Focus follows the unfold, because the reader has already said what they
   * want by opening it.
   *
   * The one place an auto-raised keyboard is right: they tapped a row called
   * `Add feedback`, and the only thing to do next is type. Guarded because the
   * field is not in the document until the unfold has rendered.
   */
  useEffect(() => {
    if (composing) field.current?.focus();
  }, [composing]);

  /** Whether there is anything worth saving. Whitespace is not. */
  const ready = note.trim().length > 0;

  const save = () => {
    const entry = buildFlag({
      id: newId(Date.now()),
      now: Date.now(),
      note,
      world: describeWorld(currentWorld()),
      theme: resolveAppearance(readAppearance()) === 'dark' ? 'Dark' : 'Light',
      width: window.innerWidth,
      height: window.innerHeight,
      standalone: isStandalone(window),
    });
    /*
     * `buildFlag` refuses a note with nothing in it, and this refuses to act on
     * the refusal. The control is already disabled in that state, so reaching
     * here means the two disagreed — and the queue's rule wins.
     */
    if (!entry) return;
    setCount(addFlag(entry).length);
    setSaved(entry.note);
    setNote('');
    setComposing(false);
  };

  const cancel = () => {
    setComposing(false);
    setNote('');
  };

  return (
    <>
      <ListRow
        testId="setup-add-feedback"
        state={
          <span className="list-state-todo">
            <FlagIcon size={17} />
          </span>
        }
        label="Add feedback"
        /*
         * What was just saved, in the row's own detail line, until the next
         * thing happens on this screen.
         *
         * A confirmation belongs where the action was, and this one is the
         * reader's own words handed back — which is the only confirmation that
         * proves the right thing was stored. The count on the row underneath
         * moves at the same moment and is the other half of it.
         */
        detail={
          saved
            ? `Saved: “${saved}”`
            : 'Write down anything that looks wrong. It is kept on this phone until you copy it out.'
        }
        onClick={() => {
          setSaved(null);
          setComposing((open) => !open);
        }}
        expanded={composing}
      />
      {composing ? (
        /*
         * Attached to the row above it, inside the same grouped surface — the
         * arrangement the unscored-newsletter controls already use. Temporary
         * by definition: it exists only while a note is being written, which is
         * the one thing `.list-row-actions` is for.
         */
        <div className="list-row-actions" data-testid="feedback-composer">
          <input
            className="feedback-note"
            data-testid="feedback-note"
            type="text"
            /*
             * One line, and the field says so rather than a label above it
             * saying so. There is one field: a label would be a row of chrome
             * explaining a box whose placeholder already explains it.
             */
            aria-label="What looks wrong"
            placeholder="What looks wrong?"
            maxLength={MAX_NOTE}
            value={note}
            ref={field}
            enterKeyHint="done"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') cancel();
            }}
          />
          <div className="btn-row btn-row-tight">
            <button
              type="button"
              className="btn btn-primary feedback-action"
              data-testid="feedback-save"
              disabled={!ready}
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              className="btn feedback-action"
              data-testid="feedback-cancel"
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ListRow
        testId="setup-flagged"
        /*
         * `todo` rather than `warn`, and nothing at all on the toolbar.
         *
         * The Review row warns because what is in it is work the app is waiting
         * on somebody to do. A note is the owner's own message to himself, and
         * a queue of them is not a fault: it is what the feature working looks
         * like. So it is marked as something to come back to and it puts no dot
         * on the Settings destination — a personal list that nags is a list
         * people stop adding to.
         */
        dataState={count > 0 ? 'todo' : 'ok'}
        state={<StateDot on={count > 0} />}
        label="Feedback"
        /*
         * The count is in the row's own words and nowhere else. A numeral in the
         * trailing slot beside a sentence that already says "3 notes saved" is
         * the same fact twice, once silently — the argument the Review row
         * makes, and it applies here for the same reason.
         */
        detail={
          count > 0
            ? `${describeCount(count)}. Read them back, delete any, or copy them all to send somewhere.`
            : 'Nothing saved yet. Anything you add above is listed here.'
        }
        chevron
        onClick={onOpen}
      />
    </>
  );
}

/** The queue's own mark: the same glyph, quiet whether or not anything is in it. */
function StateDot({ on }: { on: boolean }) {
  return (
    <span className={on ? 'list-state-todo' : 'list-state-todo feedback-state-empty'}>
      <FlagIcon size={17} />
    </span>
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
        downloadText(`fantasy-analyst-feedback-${stampNow()}.txt`, text);
        setCopied({ done: 'saved', count: entries.length });
      } catch (err) {
        setFailed(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <PushScreen
      title="Feedback"
      subtitle={describeCount(entries.length)}
      backLabel="Setup"
      onBack={onBack}
      testId="flagged-screen"
    >
      {entries.length === 0 ? (
        <Empty>
          Nothing saved yet. Add feedback from the row on the Settings screen and it is listed here.
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
                /*
                 * The note is the row's heading, because the note is the entry.
                 * There is nothing else it could be headed by: no screen was
                 * recorded, which is the point of the design.
                 */
                label={<span className="flagged-note">{entry.note}</span>}
                detail={
                  <span className="flagged-when">
                    {describeWhen(entry.at, now)}
                    {/*
                      Live is the ordinary case and says nothing; a demo
                      scenario is the one worth printing, because a note written
                      against fixture data is a note about fixture data.
                    */}
                    {entry.world === 'Live' ? '' : ` · ${entry.world}`}
                  </span>
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
                    aria-label={`Delete the note “${entry.note}”`}
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
              {entries.length === 1 ? 'Copy it' : `Copy all ${entries.length}`}
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
                  ? `Copied ${copied.count} ${copied.count === 1 ? 'note' : 'notes'}. Paste it wherever you want to talk about them.`
                  : `This browser would not take it on the clipboard, so ${copied.count} ${copied.count === 1 ? 'note was' : 'notes were'} saved as a file instead.`}
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
