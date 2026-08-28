/**
 * Flagging something, and getting the whole queue back out as text.
 *
 * Two halves, and the second is the one worth having. That an entry survives a
 * round trip through storage is table stakes; that the queue can never take a
 * screen down with it, can never carry an identity out to a chat window, and
 * can never lose the flag somebody just made in order to keep one from last
 * week — those are the reasons it is allowed to exist at all.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES,
  MAX_NOTE,
  MAX_QUEUE_CHARS,
  addFlag,
  buildFlag,
  cleanNote,
  clearQueue,
  describeWhen,
  formatQueue,
  noteFlag,
  readQueue,
  removeFlag,
  writeQueue,
  type CaptureEnv,
  type FlagEntry,
} from '../src/web/feedbackQueue.ts';
import type { StorageLike } from '../src/web/offlineCache.ts';

const KEY = 'fa.feedback.queue';

/** A `localStorage` that can be told to misbehave in each of the ways real ones do. */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  setThrows = false;
  getThrows = false;

  get length() {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.getThrows) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.setThrows) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  raw(): string | null {
    return this.map.get(KEY) ?? null;
  }
}

const AUGUST = Date.UTC(2026, 7, 28, 20, 41, 7);

const env = (over: Partial<CaptureEnv> = {}): CaptureEnv => ({
  id: 'flag-1',
  now: AUGUST,
  screen: 'Team',
  decision: 'Waivers',
  world: 'Live',
  theme: 'Dark',
  width: 390,
  height: 844,
  standalone: true,
  ...over,
});

const flag = (over: Partial<FlagEntry> = {}): FlagEntry => ({ ...buildFlag(env()), ...over });

describe('what one tap writes down', () => {
  it('records where the reader was, and how they were looking at it', () => {
    const entry = buildFlag(env());

    expect(entry).toEqual({
      id: 'flag-1',
      at: AUGUST,
      screen: 'Team',
      decision: 'Waivers',
      world: 'Live',
      theme: 'Dark',
      viewport: '390×844',
      display: 'Home Screen app',
      note: null,
    });
  });

  it('starts with no note, because the tap is the whole of the interaction', () => {
    expect(buildFlag(env()).note).toBeNull();
  });

  it('says which shell it was in, since half of what only happens to one person is that', () => {
    expect(buildFlag(env({ standalone: false })).display).toBe('Browser tab');
  });

  it('rounds the glass to whole pixels, because a fractional viewport is a zoom artefact', () => {
    expect(buildFlag(env({ width: 389.6, height: 843.2 })).viewport).toBe('390×843');
  });

  it('has no decision when the reader had not looked at one', () => {
    expect(buildFlag(env({ decision: null })).decision).toBeNull();
    expect(buildFlag(env({ decision: undefined })).decision).toBeNull();
  });

  /*
   * The property the whole design rests on: nothing that could identify a
   * league, a manager or a person can reach this record, because every field is
   * either a number about the glass or a word the app chose for itself.
   */
  it('carries no identity, because there is no field an identity could arrive in', () => {
    const entry = buildFlag(env());
    expect(Object.keys(entry).sort()).toEqual([
      'at',
      'decision',
      'display',
      'id',
      'note',
      'screen',
      'theme',
      'viewport',
      'world',
    ]);
  });
});

describe('the note', () => {
  it('is one line, whatever was pasted into the field', () => {
    expect(cleanNote('the top of\nthe board\tlooks wrong')).toBe('the top of the board looks wrong');
  });

  it('is null when it is empty, so skipping and typing spaces read the same', () => {
    expect(cleanNote('')).toBeNull();
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });

  it('is bounded, so a paste cannot turn the queue into something no clipboard takes', () => {
    expect(cleanNote('x'.repeat(1_000))).toHaveLength(MAX_NOTE);
  });

  it('is attached after the fact, to a flag that is already saved', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a' }), storage);

    expect(readQueue(storage)[0]?.note).toBeNull();
    noteFlag('a', '  DOG column is blank  ', storage);
    expect(readQueue(storage)[0]?.note).toBe('DOG column is blank');
  });

  it('can be taken off again', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a', note: 'wrong' }), storage);
    noteFlag('a', '', storage);
    expect(readQueue(storage)[0]?.note).toBeNull();
  });

  it('leaves the other flags alone', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a', at: 1_000 }), storage);
    addFlag(flag({ id: 'b', at: 2_000 }), storage);
    noteFlag('b', 'this one', storage);

    expect(readQueue(storage).map((e) => [e.id, e.note])).toEqual([
      ['b', 'this one'],
      ['a', null],
    ]);
  });
});

describe('the queue', () => {
  it('comes back newest first, whatever order it was written in', () => {
    const storage = new FakeStorage();
    writeQueue([flag({ id: 'old', at: 1_000 }), flag({ id: 'new', at: 9_000 })], storage);
    expect(readQueue(storage).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('puts the newest flag at the front', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a', at: 1_000 }), storage);
    addFlag(flag({ id: 'b', at: 2_000 }), storage);
    expect(readQueue(storage).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('forgets one entry without touching the rest', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a', at: 1_000 }), storage);
    addFlag(flag({ id: 'b', at: 2_000 }), storage);
    addFlag(flag({ id: 'c', at: 3_000 }), storage);

    expect(removeFlag('b', storage).map((e) => e.id)).toEqual(['c', 'a']);
    expect(readQueue(storage).map((e) => e.id)).toEqual(['c', 'a']);
  });

  it('forgetting something that is not there changes nothing', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a' }), storage);
    expect(removeFlag('nope', storage).map((e) => e.id)).toEqual(['a']);
  });

  it('clears entirely, and only when it is told to', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a' }), storage);
    clearQueue(storage);
    expect(readQueue(storage)).toEqual([]);
    expect(storage.raw()).toBeNull();
  });

  /*
   * The oldest fall off the end rather than the newest being refused: the flag
   * somebody just made is the one they are thinking about.
   */
  it('is capped, and it is the oldest that go', () => {
    const storage = new FakeStorage();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) addFlag(flag({ id: `f${i}`, at: 1_000 + i }), storage);

    const kept = readQueue(storage);
    expect(kept).toHaveLength(MAX_ENTRIES);
    expect(kept[0]?.id).toBe(`f${MAX_ENTRIES + 4}`);
    expect(kept.map((e) => e.id)).not.toContain('f0');
  });

  it('sheds the oldest until it fits the character cap, rather than refusing the write', () => {
    const storage = new FakeStorage();
    const long = 'x'.repeat(MAX_NOTE);
    for (let i = 0; i < MAX_ENTRIES; i++) {
      addFlag(flag({ id: `f${i}`, at: 1_000 + i, note: long }), storage);
    }

    const kept = readQueue(storage);
    expect(storage.raw()!.length).toBeLessThanOrEqual(MAX_QUEUE_CHARS);
    // Whatever fitted, the newest is in it — which is the property that matters.
    expect(kept[0]?.id).toBe(`f${MAX_ENTRIES - 1}`);
  });

  it('replaces an entry rather than doubling it, if an id somehow repeats', () => {
    const storage = new FakeStorage();
    addFlag(flag({ id: 'a', screen: 'Team' }), storage);
    addFlag(flag({ id: 'a', screen: 'Waivers' }), storage);

    expect(readQueue(storage)).toHaveLength(1);
    expect(readQueue(storage)[0]?.screen).toBe('Waivers');
  });
});

describe('the queue can never take the screen down with it', () => {
  it('reads an empty queue as empty rather than as a failure', () => {
    expect(readQueue(new FakeStorage())).toEqual([]);
  });

  it('throws away a payload it cannot parse', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, 'not json at all');
    expect(readQueue(storage)).toEqual([]);
    expect(storage.raw()).toBeNull();
  });

  it('throws away a shape from another schema', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, JSON.stringify({ schema: 99, entries: [flag()] }));
    expect(readQueue(storage)).toEqual([]);
    expect(storage.raw()).toBeNull();
  });

  it('throws away an envelope whose entries are not a list', () => {
    const storage = new FakeStorage();
    storage.setItem(KEY, JSON.stringify({ schema: 1, entries: { a: 1 } }));
    expect(readQueue(storage)).toEqual([]);
  });

  /*
   * One bad row must not cost the reader every flag they have made — which is
   * exactly what refusing the whole envelope on one malformed entry would do.
   */
  it('drops a malformed entry and keeps the ones around it', () => {
    const storage = new FakeStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 1,
        entries: [flag({ id: 'good', at: 2_000 }), { id: 'bad' }, flag({ id: 'also-good', at: 1_000 })],
      }),
    );
    expect(readQueue(storage).map((e) => e.id)).toEqual(['good', 'also-good']);
  });

  it('drops an entry whose theme or display is not one of the two it may be', () => {
    const storage = new FakeStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 1,
        entries: [{ ...flag({ id: 'x' }), theme: 'Sepia' }, { ...flag({ id: 'y' }), display: 'Kiosk' }],
      }),
    );
    expect(readQueue(storage)).toEqual([]);
  });

  it('answers empty when storage refuses to be read at all', () => {
    const storage = new FakeStorage();
    storage.getThrows = true;
    expect(readQueue(storage)).toEqual([]);
  });

  it('says so, silently, when storage refuses to be written', () => {
    const storage = new FakeStorage();
    storage.setThrows = true;
    expect(writeQueue([flag()], storage)).toBe(false);
    expect(() => addFlag(flag(), storage)).not.toThrow();
  });

  it('answers empty when there is no storage at all', () => {
    expect(readQueue(null)).toEqual([]);
    expect(writeQueue([flag()], null)).toBe(false);
  });
});

describe('how long ago it was', () => {
  const now = AUGUST;
  const ago = (ms: number) => describeWhen(now - ms, now);

  it('reads in the words a person uses', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(59_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(17 * 60_000)).toBe('17 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(5 * 60 * 60_000)).toBe('5 hours ago');
    expect(ago(24 * 60 * 60_000)).toBe('1 day ago');
    expect(ago(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  /*
   * A clock that moved backwards between writing and reading is a timezone
   * change or an NTP correction, not a fault, and certainly not something to
   * report to the reader as a negative age.
   */
  it('reads a backwards clock as just now rather than as a fault', () => {
    expect(describeWhen(now + 60_000, now)).toBe('just now');
  });
});

describe('the whole queue, as one block of text', () => {
  const now = AUGUST + 90 * 60_000;

  const two = [
    flag({
      id: 'zzq-alpha',
      at: AUGUST,
      screen: 'Team',
      decision: 'Waivers',
      note: 'the projection under Ike looks low',
    }),
    flag({
      id: 'zzq-beta',
      at: AUGUST - 60 * 60_000,
      screen: 'Players',
      decision: null,
      world: 'Demo: sunday-morning',
      theme: 'Light',
      viewport: '360×800',
      display: 'Browser tab',
      note: null,
    }),
  ];

  it('says what it is, where it came from, and that nothing was uploaded', () => {
    const text = formatQueue(two, now);
    expect(text).toContain('Fantasy Analyst — 2 things flagged while using the app');
    expect(text).toContain('nothing was uploaded');
  });

  it('numbers them in the order they are given, which is newest first', () => {
    const text = formatQueue(two, now);
    expect(text.indexOf('1. Team')).toBeGreaterThan(-1);
    expect(text.indexOf('2. Players')).toBeGreaterThan(text.indexOf('1. Team'));
  });

  it('stamps each one in UTC, with the age beside it', () => {
    expect(formatQueue(two, now)).toContain('1. Team — 2026-08-28 20:41 UTC (1 hour ago)');
  });

  it('quotes the note, and says out loud when there is not one', () => {
    const text = formatQueue(two, now);
    expect(text).toContain('"the projection under Ike looks low"');
    expect(text).toContain('No note.');
  });

  it('prints the context on one line, and leaves out the decision when there was none', () => {
    const text = formatQueue(two, now);
    expect(text).toContain('Last recommendation: Waivers · Live · Dark · 390×844 · Home Screen app');
    expect(text).toContain('Demo: sunday-morning · Light · 360×800 · Browser tab');
    expect(text).not.toContain('Last recommendation: null');
  });

  it('says so plainly when there is nothing in it', () => {
    expect(formatQueue([], now)).toBe('Fantasy Analyst — nothing is flagged.');
  });

  it('counts one thing as one thing', () => {
    expect(formatQueue([two[0]!], now)).toContain('1 thing flagged');
  });

  /*
   * It is pasted straight into a chat window, so it is prose rather than a
   * structure with a syntax: no braces, no fences, and it ends at its last
   * character rather than trailing blank lines.
   */
  it('is plain text, ready to paste, with no fence and no dangling blank lines', () => {
    const text = formatQueue(two, now);
    expect(text).not.toContain('```');
    expect(text).not.toContain('{');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('carries nothing that is not in the entries themselves', () => {
    const text = formatQueue(two, now);
    // The ids are bookkeeping for the delete control and have no business here.
    expect(text).not.toContain('flag-1');
    expect(text).not.toContain(two[0]!.id);
    expect(text).not.toContain('zzq-beta');
  });
});
