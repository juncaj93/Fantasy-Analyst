/**
 * Flagging something, from wherever you were standing when you noticed it.
 *
 * `captureDraftSnapshot` answers "why is the board recommending this" by
 * freezing the state behind one recommendation and handing it over as a file.
 * It is the right shape for a decision that can be replayed through an engine,
 * and it is far too much machinery for the other half of what goes wrong with
 * an app: a number that reads oddly on Team, a row that wraps at 360px, a
 * newsletter that scored something strangely, a screen that felt slow. Those
 * are noticed in passing, three taps from anywhere that could record them, and
 * by the evening they are "something looked wrong on one of the screens".
 *
 * So this is the same idea at a tenth of the weight: one tap says *here, this,
 * now*, the app writes down where "here" was, and the whole queue leaves later
 * as one block of text.
 *
 * ## What it records, and the one thing it deliberately does not
 *
 * The same philosophy the support snapshot is built on — enough that reading it
 * back explains what was happening, and nothing sensitive — but the material is
 * different, because this runs on a phone with no server and no round trip.
 * What is available for free is the destination the reader was on, the decision
 * they had last looked at, which world the data came from, the theme, the size
 * of the glass and whether this is a Home Screen app. That set answers most of
 * "what was I looking at" and every bit of "why does it only happen for me".
 *
 * **The screen's own title is not read, and that is on purpose.** The obvious
 * improvement here is to take the visible `NavBar` title, which would say
 * `Newsletter` rather than `Setup` when a panel is pushed. One of them is the
 * league's own name — `TeamScreen` heads itself with it — and this text is
 * written to be pasted into a chat window. A capture that is right seven times
 * and prints the league's name the eighth is not a capture that can be pasted
 * without reading it first, which defeats the whole point. The destination is
 * an enum in this repository, so it can never become an identity.
 *
 * Nothing else is collected either: no league id, no draft id, no manager, no
 * player, no request, no error text. This is a note about a moment, not a
 * diagnostic dump — the diagnostic dump already exists, one row further down
 * Settings, and it is the thing to reach for when a *recommendation* is wrong.
 *
 * ## Where it is kept
 *
 * `localStorage`, exactly as the theme, the install dismissal, the mock-draft
 * session and the offline board are — a preference of this phone rather than of
 * the account. It needs no passphrase, no request and no server, and it must
 * survive a reload, which is what rules out `sessionStorage` (the support
 * *context* uses that deliberately, because a context remembered from last
 * Tuesday would be worse than none; a flag from last Tuesday is exactly what
 * this is for).
 *
 * Every access is guarded the way `offlineCache.ts` guards its own: Safari in a
 * private window throws on the property rather than returning null, and a flag
 * control that cannot be tapped because the reader is browsing privately would
 * be a poor trade. A failure to store is silent — there is nothing the reader
 * could do about it and nothing worth interrupting them for.
 *
 * ## Nothing is uploaded
 *
 * There is no feedback endpoint, no telemetry and no background send. The queue
 * is on the device until the reader copies it out, and copying is a tap they
 * make.
 */

import type { StorageLike } from './offlineCache.ts';

/** Bumped when the stored shape changes. An older queue is dropped, not migrated. */
const SCHEMA = 1;

const KEY = 'fa.feedback.queue';

/**
 * How many flags are kept.
 *
 * A queue is a working list, not an archive: fifty is more than anybody clears
 * in one sitting and far less than a browser's quota cares about. The oldest
 * fall off the end rather than the newest being refused, because the flag
 * somebody just made is the one they are thinking about.
 */
export const MAX_ENTRIES = 50;

/**
 * How long a note may be.
 *
 * One line, which is what the field is. The cap exists so that a paste into the
 * field — which is what happens when somebody has copied an error from
 * somewhere else — cannot turn a queue into something no clipboard will take.
 */
export const MAX_NOTE = 200;

/** The whole queue, capped by characters as well as by count. */
export const MAX_QUEUE_CHARS = 64_000;

/** Whether the app was running from the Home Screen or inside a browser tab. */
export type Display = 'Home Screen app' | 'Browser tab';

/**
 * One flag: where the reader was, and what they wanted to say about it.
 *
 * Deliberately flat and deliberately strings. Everything in here is written for
 * a person to read months later in a chat window, so it is stored in the words
 * it will be printed in rather than in codes something would have to translate
 * back — there is no second reader of this data and no schema to keep in step.
 */
export interface FlagEntry {
  /** Unique within the queue, so one entry can be deleted without the rest. */
  id: string;
  /** When it was flagged, as epoch ms. */
  at: number;
  /** The destination the reader was on, in the toolbar's own word. */
  screen: string;
  /** The recommendation last looked at, when the app knew of one. */
  decision: string | null;
  /** `Live`, or the demo scenario running underneath. */
  world: string;
  /** Which of the two palettes was actually showing. */
  theme: 'Light' | 'Dark';
  /** The glass it was on, as `390×844`. */
  viewport: string;
  display: Display;
  /** The reader's own line, or null when they skipped it. */
  note: string | null;
}

/** What the browser has to be asked about, gathered by the caller. */
export interface CaptureEnv {
  id: string;
  now: number;
  screen: string;
  decision?: string | null;
  world: string;
  theme: 'Light' | 'Dark';
  width: number;
  height: number;
  standalone: boolean;
}

/**
 * The entry a tap makes, with no storage and no browser in sight.
 *
 * Separated from the gathering so the shape of a flag can be tested as
 * arithmetic — the same split `gestures.ts` makes between its thresholds and
 * its listeners, and for the same reason.
 */
export function buildFlag(env: CaptureEnv): FlagEntry {
  return {
    id: env.id,
    at: env.now,
    screen: env.screen,
    decision: env.decision ?? null,
    world: env.world,
    theme: env.theme,
    viewport: `${Math.round(env.width)}×${Math.round(env.height)}`,
    display: env.standalone ? 'Home Screen app' : 'Browser tab',
    note: null,
  };
}

/**
 * A note, as it will be stored: trimmed, one line, and bounded.
 *
 * Newlines become spaces rather than being refused. The field is one line, so
 * the only way one arrives is a paste, and throwing away somebody's paste
 * because it had a line break in it would be the app being clever at their
 * expense. An empty note is null — "they skipped it" and "they typed spaces"
 * are the same thing and must read the same way downstream.
 */
export function cleanNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const flat = note.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : flat.slice(0, MAX_NOTE);
}

interface Envelope {
  schema: number;
  entries: FlagEntry[];
}

function storageOf(explicit?: StorageLike | null): StorageLike | null {
  if (explicit) return explicit;
  try {
    // Safari in a private window throws on the property itself, not on the call.
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const isEntry = (value: unknown): value is FlagEntry => {
  if (value == null || typeof value !== 'object') return false;
  const e = value as Partial<FlagEntry>;
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'number' &&
    typeof e.screen === 'string' &&
    typeof e.world === 'string' &&
    typeof e.viewport === 'string' &&
    (e.theme === 'Light' || e.theme === 'Dark') &&
    (e.display === 'Home Screen app' || e.display === 'Browser tab') &&
    (e.decision === null || typeof e.decision === 'string') &&
    (e.note === null || typeof e.note === 'string')
  );
};

/**
 * The queue, newest first.
 *
 * An empty array means it for every reason: nothing flagged, a shape from a
 * previous deploy, a payload somebody edited by hand, or a storage that will
 * not answer. The caller cannot act differently on any of those and the screen
 * they all lead to is the same one, so they are not told apart. Anything
 * unreadable is thrown away rather than left to fail again on the next read.
 */
export function readQueue(storage?: StorageLike | null): FlagEntry[] {
  const store = storageOf(storage);
  if (!store) return [];

  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    drop(store);
    return [];
  }

  if (!envelope || envelope.schema !== SCHEMA || !Array.isArray(envelope.entries)) {
    drop(store);
    return [];
  }

  /*
   * Each entry is checked on its own, and a bad one is dropped rather than
   * taking the queue with it.
   *
   * The alternative — refusing the whole envelope on one malformed row — would
   * mean a single entry written by an older build costs the reader every flag
   * they have made. Sorting here rather than trusting the file is the same
   * argument: the order is a property of the queue, not of whoever wrote it.
   */
  return envelope.entries.filter(isEntry).sort((a, b) => b.at - a.at);
}

/**
 * Write the queue back, capped.
 *
 * Silent on failure, and the failure is survivable: the flag exists in the
 * screen's own state for as long as the composer is open, and the reader is not
 * told about a quota they cannot do anything about. Returns whether it landed,
 * for the one caller that wants to know — the tests.
 */
export function writeQueue(entries: FlagEntry[], storage?: StorageLike | null): boolean {
  const store = storageOf(storage);
  if (!store) return false;

  let kept = entries.slice(0, MAX_ENTRIES);
  let text = serialise(kept);
  /*
   * A queue over the character cap loses its oldest entries until it fits.
   *
   * Not a refusal: the cap is about `localStorage` being shared with the theme,
   * the install dismissal and the offline board, and the correct response to
   * "this is getting big" is the same one the count cap makes — the oldest
   * flags are the ones that have already been read or forgotten.
   */
  while (text.length > MAX_QUEUE_CHARS && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    text = serialise(kept);
  }

  try {
    store.setItem(KEY, text);
    return true;
  } catch {
    return false;
  }
}

function serialise(entries: FlagEntry[]): string {
  const envelope: Envelope = { schema: SCHEMA, entries };
  return JSON.stringify(envelope);
}

function drop(store: StorageLike): void {
  try {
    store.removeItem(KEY);
  } catch {
    /* nothing to do about it, and nothing worth saying */
  }
}

/** Add a flag to the front of the queue and hand back the queue it made. */
export function addFlag(entry: FlagEntry, storage?: StorageLike | null): FlagEntry[] {
  const next = [entry, ...readQueue(storage).filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  writeQueue(next, storage);
  return next;
}

/**
 * Attach — or clear — the note on one flag.
 *
 * Separate from adding it because the flag is saved the instant it is made and
 * the note arrives afterwards, if at all. That order is the whole interaction:
 * skipping the note is doing nothing, which cannot be made any easier.
 */
export function noteFlag(id: string, note: string | null, storage?: StorageLike | null): FlagEntry[] {
  const clean = cleanNote(note);
  const next = readQueue(storage).map((e) => (e.id === id ? { ...e, note: clean } : e));
  writeQueue(next, storage);
  return next;
}

/** Forget one flag. */
export function removeFlag(id: string, storage?: StorageLike | null): FlagEntry[] {
  const next = readQueue(storage).filter((e) => e.id !== id);
  writeQueue(next, storage);
  return next;
}

/** Forget all of them. Only ever from the control that says so, after a copy. */
export function clearQueue(storage?: StorageLike | null): void {
  const store = storageOf(storage);
  if (store) drop(store);
}

/**
 * When something was flagged, in the words a person uses.
 *
 * Coarse on purpose above the hour, precise below it: "seventeen minutes ago"
 * is how somebody finds the thing they flagged during this session, and "3 days
 * ago" is all anybody needs about one they did not. A negative age — the clock
 * moved backwards between writing and reading — reads as `just now` rather than
 * as a fault, because a timezone change is not something to report to anybody.
 */
export function describeWhen(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * `2026-08-28T20:41:07.000Z` → `2026-08-28 20:41 UTC`.
 *
 * UTC and a fixed layout rather than the reader's locale, for the same reason
 * the support snapshot stamps its filenames that way: this string is read in a
 * chat window, quite possibly by something that is not in the reader's timezone
 * and definitely not on the reader's phone.
 */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The whole queue as one block of text, ready to paste into a chat.
 *
 * The support snapshot's copy is a JSON file, because what reads it is a replay
 * harness. Nothing replays a flag: what reads this is a person or an assistant
 * being asked to look at a list, so it is prose with a shape rather than a
 * structure with a syntax. Numbered, newest first — the order the screen shows
 * and the order somebody talks about their own list in.
 *
 * The header says what the file is and where it came from, because it arrives
 * in a chat window with no context whatsoever, and it says out loud that
 * nothing was uploaded — the one property of this feature somebody reading it
 * six months later cannot check for themselves.
 */
export function formatQueue(entries: FlagEntry[], now: number): string {
  if (entries.length === 0) {
    return 'Fantasy Analyst — nothing is flagged.';
  }

  const lines: string[] = [
    `Fantasy Analyst — ${entries.length} ${entries.length === 1 ? 'thing' : 'things'} flagged while using the app`,
    'Newest first. Captured on the device as they were noticed; nothing was uploaded.',
    '',
  ];

  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.screen} — ${stamp(entry.at)} (${describeWhen(entry.at, now)})`);
    /*
     * The note, in quotes, or the absence of one said out loud.
     *
     * A silently missing line would read as a formatting slip in a list where
     * every other entry has one. "No note" is a fact about that flag: the
     * reader tapped and moved on, which is the interaction working.
     */
    lines.push(entry.note ? `   "${entry.note}"` : '   No note.');
    /*
     * The context, on one line, in the order it is most often wanted: which
     * recommendation was in view, whose data it was, and then the three
     * properties of the glass that only matter when a report is about layout.
     */
    const context = [
      entry.decision ? `Last recommendation: ${entry.decision}` : null,
      entry.world,
      entry.theme,
      entry.viewport,
      entry.display,
    ].filter((part): part is string => part != null);
    lines.push(`   ${context.join(' · ')}`);
    lines.push('');
  });

  /*
   * One trailing blank line, not two and not none. `join` leaves the last
   * entry's separator on the end, and a block that is pasted into a chat should
   * end at its last character.
   */
  return `${lines.join('\n').trimEnd()}\n`;
}
