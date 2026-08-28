/**
 * The control that says *here, this, now* — and the one line that qualifies it.
 *
 * ## Why it floats, and why it floats *there*
 *
 * Every other way of reaching this was worse, and the reasons are worth keeping
 * because they are the reasons it will be moved back by somebody one day.
 *
 * **Not in the taskbar.** Six destinations is the most that strip of glass
 * carries and it is at its width limit on a 360px phone; a seventh control in
 * it would be exactly the trade Settings' own diagnostic rows are placed to
 * avoid (§9, §16). Flagging is maintenance, and maintenance does not compete
 * with the decisions the bar is for.
 *
 * **Not in the navigation bar.** Four screens already put their own actions on
 * its trailing edge, so a shell-level control there would land on top of one of
 * them on the screens most likely to be flagged.
 *
 * **Not a gesture.** A long press or a two-finger tap is invisible, it is the
 * kind of thing `docs/brief/06_UI_AND_QA.md` rules out — "do not hide essential
 * meaning behind gesture-only controls" — and the app already spends its
 * gestures: an edge swipe for Back, a downward pull for refresh, a downward
 * drag on a sheet. Another one would have to be arbitrated against all three.
 *
 * **Not inside a screen.** The whole point is that it is reachable from every
 * one of them, including the ones nobody may edit this week. It is drawn by the
 * shell, exactly as the demo indicator is, so no screen knows it exists and no
 * screen can forget it.
 *
 * What is left is a small floating control in the trailing corner, in the same
 * material as the toolbar it sits above. It costs 44px of the corner of the
 * page and that is a real cost, honestly the largest thing wrong with this
 * design; everything else that could carry it costs more.
 *
 * ## What it does not interfere with
 *
 * - **Scrolling.** It is an ordinary `<button>`. Nothing here calls
 *   `preventDefault`, sets `touch-action` or attaches a `touchmove` listener,
 *   so a finger that lands on it and moves scrolls the page underneath exactly
 *   as it would anywhere else.
 * - **Back.** It is on the *trailing* edge. The edge-swipe gesture starts in a
 *   28px strip on the leading one, which is the whole width of the screen away.
 * - **Pull to refresh.** That begins at the top of the page; this is at the
 *   bottom.
 * - **Anything modal.** It leaves whenever a layer covers the app — a sheet,
 *   the draft board, a menu — so it can never take a tap meant for one, and it
 *   is not there to be tapped while a modal is the subject.
 * - **The keyboard.** It leaves while the keyboard is up, exactly as the
 *   toolbar does and for the same reason: a fixed element sits at the bottom of
 *   the layout viewport, which iOS does not shrink.
 *
 * ## The interaction, and why skipping the note is free
 *
 * The tap *is* the flag: the entry is written to the queue before anything is
 * drawn, so the reader has already succeeded by the time they see anything. The
 * composer that follows is an offer, not a step — it says what was flagged, and
 * puts a one-line field next to it. Doing nothing keeps the flag and the strip
 * takes itself away; typing attaches a note to the flag that is already there.
 *
 * That is what "skipping the note is as easy as adding one" has to mean to be
 * true: not a shorter form, but no form at all. It is also why the field is not
 * focused on arrival — an auto-raised keyboard is the opposite of a control you
 * can tap and walk away from.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FlagIcon } from './icons.tsx';
import { addFlag, buildFlag, noteFlag, MAX_NOTE, type FlagEntry } from '../feedbackQueue.ts';
import { CONTEXT_LABELS, readSupportContext } from '../supportContext.ts';
import { LIVE_WORLD, currentWorld } from '../world.ts';
import { readAppearance, resolveAppearance } from '../theme.ts';
import { isStandalone } from '../standalone.ts';
import { useAppIsCovered } from '../overlay.ts';
import { useKeyboardInset } from '../viewport.ts';

/**
 * How long the strip waits before taking itself away.
 *
 * Only ever while the reader has not touched it. Long enough to read four words
 * and decide, short enough that a flag made on the way past does not leave
 * something on screen to dismiss. The instant the field is touched this stops
 * mattering — a composer that closed itself under somebody's thumb would lose
 * the sentence they were in the middle of.
 */
export const DISMISS_AFTER_MS = 5_000;

/**
 * A flag's id.
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

export function FeedbackCapture({ screen }: { screen: string }) {
  /** The flag being offered a note, or null when the strip is away. */
  const [flagged, setFlagged] = useState<FlagEntry | null>(null);
  const [note, setNote] = useState('');
  /**
   * Whether the reader has engaged with the strip at all.
   *
   * The only thing the timer asks about. Focusing the field, typing in it, or
   * pressing anything on the strip all count — after any of those the strip
   * belongs to the reader and stays until they are finished with it.
   */
  const [touched, setTouched] = useState(false);
  const covered = useAppIsCovered();
  const keyboard = useKeyboardInset();

  const close = useCallback(() => {
    setFlagged(null);
    setNote('');
    setTouched(false);
  }, []);

  const capture = () => {
    const now = Date.now();
    const context = readSupportContext();
    const entry = buildFlag({
      id: newId(now),
      now,
      screen,
      decision: context ? CONTEXT_LABELS[context] : null,
      world: describeWorld(currentWorld()),
      theme: resolveAppearance(readAppearance()) === 'dark' ? 'Dark' : 'Light',
      width: window.innerWidth,
      height: window.innerHeight,
      standalone: isStandalone(window),
    });
    /*
     * Written first, drawn second.
     *
     * If the write is all that happens — the reader taps and immediately locks
     * the phone, or storage refuses and the strip never renders — the flag is
     * still made. Nothing about this interaction depends on the composer being
     * seen.
     */
    addFlag(entry);
    setFlagged(entry);
    setNote('');
    setTouched(false);
  };

  /** The note is attached on the way out, whichever way out is taken. */
  const save = useCallback(() => {
    if (flagged) noteFlag(flagged.id, note);
    close();
  }, [flagged, note, close]);

  /*
   * The strip takes itself away, but only from somebody who ignored it.
   *
   * Re-armed whenever `touched` changes so that the first touch cancels it
   * rather than leaving a timer to fire mid-sentence.
   */
  useEffect(() => {
    if (!flagged || touched) return;
    const timer = window.setTimeout(close, DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [flagged, touched, close]);

  /*
   * Escape leaves, and keeps whatever has been typed.
   *
   * Not a modal, so this is a plain document listener rather than the overlay
   * stack's — there is no layer under it to protect and nothing else on screen
   * is listening for Escape while the strip is up.
   */
  useEffect(() => {
    if (!flagged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') save();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flagged, save]);

  /*
   * A flag made on one screen belongs to that screen.
   *
   * Navigating away while the strip is open ends it: the note the reader was
   * about to type is about the screen they just left, and a composer that
   * followed them to the next one would attach it to a flag whose heading no
   * longer matches what is behind it. Whatever is typed is kept, because it was
   * typed about the flag it is being attached to.
   */
  const previous = useRef(screen);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (previous.current === screen) return;
    previous.current = screen;
    saveRef.current();
  }, [screen]);

  /*
   * A layer covering the app ends the strip too, and keeps what was typed.
   *
   * The strip is not modal, so a sheet, a menu or the draft board can open over
   * it — and the layer goes away when they do, because it must never take a tap
   * meant for one of them. Without this the words in the field would go with
   * it: the *flag* is safe either way, since it was written before the strip
   * was drawn, but the sentence somebody was halfway through would not be.
   */
  useEffect(() => {
    if (covered && flagged) saveRef.current();
  }, [covered, flagged]);

  /*
   * Away while something is covering the app, and away while the keyboard is
   * up — unless the strip is what the keyboard was opened for.
   */
  if (covered) return null;

  const hidden = keyboard > 0 && !flagged;

  return (
    <div
      className="flag-layer"
      data-testid="flag-layer"
      data-hidden={hidden ? 'yes' : 'no'}
      /*
       * Lifted by exactly what the keyboard is covering.
       *
       * The same arithmetic `Sheet` does, and the same reason: this is pinned
       * to the bottom of the layout viewport and iOS shrinks only the visual
       * one, so a composer with a field in it would draw its own field
       * underneath the keyboard the moment it was tapped into.
       */
      style={{ ['--flag-keyboard' as string]: `${keyboard}px` }}
    >
      {flagged ? (
        <div className="flag-strip" data-testid="flag-strip">
          <div className="flag-strip-said">
            {/*
              The confirmation is the live region, and the field beside it is
              not: a live region wrapped around a text box re-announces itself
              on every keystroke, which is the one thing somebody typing a
              sentence must not have happen.
            */}
            <span className="flag-strip-what" role="status" data-testid="flag-strip-what">
              Flagged {flagged.screen}
            </span>
            <button
              type="button"
              className="btn btn-sm flag-done"
              data-testid="flag-done"
              onClick={save}
            >
              Done
            </button>
          </div>
          <input
            className="flag-note"
            data-testid="flag-note"
            type="text"
            /*
             * One line, and the field says so rather than a label above it
             * saying so. There is one field: a label would be a row of chrome
             * explaining a box whose placeholder already explains it.
             */
            aria-label="Add a note about what you flagged (optional)"
            placeholder="Add a note (optional)"
            maxLength={MAX_NOTE}
            value={note}
            enterKeyHint="done"
            onChange={(e) => {
              setTouched(true);
              setNote(e.target.value);
            }}
            onFocus={() => setTouched(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="flag-button"
        data-testid="flag-button"
        /*
         * The name says what it does to *this* screen, because that is the only
         * thing a reader has to be sure of before pressing something that acts
         * without asking. The glyph is decoration and is drawn `aria-hidden`.
         */
        aria-label={`Flag ${screen} for a look later`}
        onClick={() => {
          if (flagged) save();
          else capture();
        }}
      >
        <span className="flag-glyph" aria-hidden="true">
          <FlagIcon />
        </span>
      </button>
    </div>
  );
}
