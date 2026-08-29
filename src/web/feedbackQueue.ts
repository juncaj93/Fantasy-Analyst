/**
 * A note the owner wrote, and the queue of them Settings holds.
 *
 * `captureDraftSnapshot` answers "why is the board recommending this" by
 * freezing the state behind one recommendation and handing it over as a file.
 * It is the right shape for a decision that can be replayed through an engine,
 * and it is far too much machinery for the other half of what goes wrong with
 * an app: a number that reads oddly on Team, a row that wraps at 360px, a
 * newsletter that scored something strangely, a screen that felt slow. Those go
 * unwritten because there is nowhere to write them down, and by the evening
 * they have become "something looked wrong on one of the screens".
 *
 * So this is the same lane at a tenth of the weight: somewhere to write the
 * sentence, and one action that takes the whole list out as a paste.
 *
 * ## What an entry is, and what it deliberately is not
 *
 * **The note is the entry.** The action that makes one lives in Settings,
 * beside the queue it fills — there is no per-screen trigger, nothing floating
 * over the app, and nothing recording which screen anybody was on. That last
 * part is the design rather than a limitation: an entry is a sentence somebody
 * chose to write, not a recording of a moment they happened to be having.
 *
 * What is kept beside the words is only what stays true wherever they were
 * typed — the world the app is reading, the palette showing, the size of the
 * glass, and whether this is the Home Screen app or a browser tab. Those are
 * properties of the session rather than of a screen, and they are the
 * difference between a report that can be reproduced and one that cannot: half
 * of what only ever happens to one person is a width, a theme or a shell.
 *
 * Nothing else is collected: no screen name, no league id, no draft id, no
 * manager, no player, no request, no error text. There is therefore no field an
 * identity could arrive in, which is what lets the queue be pasted into a chat
 * window without being read first. The diagnostic dump already exists two rows
 * up in the same group, and it is the thing to reach for when a *recommendation*
 * is wrong.
 *
 * ## Where it is kept
 *
 * `localStorage`, exactly as the theme, the install dismissal, the mock-draft
 * session and the offline board are — a preference of this phone rather than of
 * the account. It needs no passphrase, no request and no server, and it must
 * survive a reload, which is what rules out `sessionStorage` (the support
 * *context* uses that deliberately, because a context remembered from last
 * Tuesday would be worse than none; a note from last Tuesday is exactly what
 * this is for).
 *
 * Every access is guarded the way `offlineCache.ts` guards its own: Safari in a
 * private window throws on the property rather than returning null, and a
 * feedback control that cannot be used because the reader is browsing privately
 * would be a poor trade. A failure to store is silent — there is nothing the
 * reader could do about it and nothing worth interrupting them for.
 *
 * ## Nothing is uploaded
 *
 * There is no feedback endpoint, no telemetry and no background send. The queue
 * is on the device until the reader copies it out, and copying is a tap they
 * make.
 */
import type { StorageLike } from './offlineCache.ts';

/**
 * Bumped when the stored shape changes. An older queue is dropped, not migrated.
 *
 * `2` is the move off a per-screen trigger. Entries written by `1` carried the
 * destination the reader was standing on and a note that might be absent; both
 * are gone, and an entry from the old shape would read as a note with no words
 * in it. Dropping is the honest answer — nothing was ever deployed under `1`,
 * and a half-read note is worse than a queue that starts empty.
 */
const SCHEMA = 2;

const KEY = 'fa.feedback.queue';

/**
 * How many flags are kept.
 *
 * A queue is a working list, not an archive: fifty is more than anybody clears
 * in one sitting and far less than a browser's quota cares about. The oldest
 * fall off the end rather than the newest being refused, because the note
 * somebody just wrote is the one they are thinking about.
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
 * One note: what the owner wrote, and the handful of session facts around it.
 *
 * **The note is the entry.** Nothing here describes where in the app the owner
 * was standing when they wrote it, because nothing asks them to be anywhere:
 * the action lives on the Settings page beside the queue it fills. That is a
 * deliberate narrowing — an entry is a sentence somebody chose to write, not a
 * recording of a moment — and it is why the note is required rather than
 * optional. An entry with no words in it would carry nothing at all.
 *
 * What is kept beside it is only what stays true wherever it was typed: which
 * world the app is reading, which palette is showing, the size of the glass,
 * and whether this is the Home Screen app or a browser tab. Those are
 * properties of the session rather than of a screen, and they are the
 * difference between a note that can be reproduced and one that cannot — half
 * of what only ever happens to one person is a width, a theme or a shell.
 *
 * Deliberately flat and deliberately strings. Everything in here is written for
 * a person to read months later in a chat window, so it is stored in the words
 * it will be printed in rather than in codes something would have to translate
 * back — there is no second reader of this data and no schema to keep in step.
 */
export interface FlagEntry {
  /** Unique within the queue, so one entry can be deleted without the rest. */
  id: string;
  /** When it was written, as epoch ms. */
  at: number;
  /** `Live`, or the demo scenario running underneath. */
  world: string;
  /** Which of the two palettes was showing. */
  theme: 'Light' | 'Dark';
  /** The glass it was written on, as `390×844`. */
  viewport: string;
  display: Display;
  /** The owner's own line. Never empty — see above. */
  note: string;
}

/** What the browser has to be asked about, gathered by the caller. */
export interface CaptureEnv {
  id: string;
  now: number;
  note: string;
  world: string;
  theme: 'Light' | 'Dark';
  width: number;
  height: number;
  standalone: boolean;
}

/**
 * The entry a saved note makes, with no storage and no browser in sight.
 *
 * Separated from the gathering so the shape of an entry can be tested as
 * arithmetic — the same split `gestures.ts` makes between its thresholds and
 * its listeners, and for the same reason.
 *
 * Returns null for a note with nothing in it. The control that calls this will
 * not offer to save an empty field, so this is the second answer to the same
 * question rather than the first — and a queue that can never hold an empty
 * entry is a property worth holding here, where it can be tested, rather than
 * only in a disabled button.
 */
export function buildFlag(env: CaptureEnv): FlagEntry | null {
  const note = cleanNote(env.note);
  if (note == null) return null;
  return {
    id: env.id,
    at: env.now,
    world: env.world,
    theme: env.theme,
    viewport: `${Math.round(env.width)}×${Math.round(env.height)}`,
    display: env.standalone ? 'Home Screen app' : 'Browser tab',
    note,
  };
}

/**
 * A note, as it will be stored: trimmed, one line, and bounded.
 *
 * Newlines become spaces rather than being refused. The field is one line, so
 * the only way one arrives is a paste, and throwing away somebody's paste
 * because it had a line break in it would be the app being clever at their
 * expense. An empty note is null — "they typed nothing" and "they typed
 * spaces" are the same thing and must read the same way downstream, which is
 * what stops a queue holding an entry with no words in it.
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
    typeof e.world === 'string' &&
    typeof e.viewport === 'string' &&
    (e.theme === 'Light' || e.theme === 'Dark') &&
    (e.display === 'Home Screen app' || e.display === 'Browser tab') &&
    // The note is the entry, so an entry without one is not an entry.
    typeof e.note === 'string' &&
    e.note !== ''
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

/** Add a note to the front of the queue and hand back the queue it made. */
export function addFlag(entry: FlagEntry, storage?: StorageLike | null): FlagEntry[] {
  const next = [entry, ...readQueue(storage).filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  writeQueue(next, storage);
  return next;
}

/** Forget one note. */
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
 * When a note was written, in the words a person uses.
 *
 * Coarse on purpose above the hour, precise below it: "seventeen minutes ago"
 * is how somebody finds the note they wrote during this session, and "3 days
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
 * harness. Nothing replays a note: what reads this is a person or an assistant
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
    return 'Fantasy Analyst — there is no feedback saved.';
  }

  const lines: string[] = [
    `Fantasy Analyst — ${entries.length} ${entries.length === 1 ? 'note' : 'notes'} from the owner`,
    'Newest first. Written in the app and kept on the device; nothing was uploaded.',
    '',
  ];

  entries.forEach((entry, index) => {
    /*
     * The date heads the entry, because the note is now the body rather than a
     * caption under a screen name. Nothing else can head it: there is no screen
     * to name, which is the point of the design.
     */
    lines.push(`${index + 1}. ${stamp(entry.at)} (${describeWhen(entry.at, now)})`);
    lines.push(`   "${entry.note}"`);
    /*
     * The session, on one line: whose data the app was reading, and then the
     * three properties of the device that only matter when a report is about
     * layout. None of it says where in the app the note was written, because
     * nothing records that any more.
     */
    lines.push(`   ${[entry.world, entry.theme, entry.viewport, entry.display].join(' · ')}`);
    lines.push('');
  });

  /*
   * One trailing blank line, not two and not none. `join` leaves the last
   * entry's separator on the end, and a block that is pasted into a chat should
   * end at its last character.
   */
  return `${lines.join('\n').trimEnd()}\n`;
}
