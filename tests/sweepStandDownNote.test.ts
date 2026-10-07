/**
 * The line the sweep leaves on the tracking issue on a day it did not run.
 *
 * Three things are claimed and each is checked against the real script, run on
 * a fake GitHub:
 *
 *   - it says what happened, in the words the owner asked for;
 *   - it says it once a day, however many runs stand down;
 *   - it leaves the issue exactly as it found it. Not its body, not its state.
 *     An issue that was closed stays closed; one that lists a failure keeps it.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script, deliberately not part of the app build
import { NOTE_PREFIX, noteStandDown, noteText } from '../scripts/sweep-stand-down-note.mjs';

interface Issue {
  number: number;
  state: 'open' | 'closed';
  body: string;
}
interface Comment {
  body: string;
  created_at: string;
}

function fakeGithub(issue: Issue | null, comments: Comment[] = []) {
  const calls: string[] = [];
  const thread = [...comments];
  return {
    calls,
    thread,
    api: {
      findIssue: async () => issue,
      listComments: async () => thread,
      comment: async (_number: number, body: string) => {
        calls.push('comment');
        thread.push({ body, created_at: '2026-10-08T00:50:00Z' });
      },
      // None of these may ever be called by this script.
      updateIssue: async () => {
        calls.push('updateIssue');
      },
      createIssue: async () => {
        calls.push('createIssue');
      },
      ensureLabel: async () => {
        calls.push('ensureLabel');
      },
    },
  };
}

const NOW = new Date('2026-10-08T00:52:00Z');
const CLOSED: Issue = { number: 204, state: 'closed', body: 'Nothing is failing.' };

describe('the stand-down note', () => {
  it('says it in the owner’s words', () => {
    expect(noteText({ percent: '34.2', ceiling: '30' })).toBe(
      'Sweep did not run today: D1 reads at 34.2% (guard 30%).',
    );
  });

  it('adds one comment, and changes nothing else on the issue', async () => {
    const gh = fakeGithub(CLOSED);
    const result = await noteStandDown({ api: gh.api, percent: '34.2', ceiling: '30', now: NOW });
    expect(result).toEqual({ action: 'commented', number: 204 });
    expect(gh.calls, 'only a comment, never an update, a reopen or a new issue').toEqual(['comment']);
    expect(gh.thread.at(-1)!.body).toBe('Sweep did not run today: D1 reads at 34.2% (guard 30%).');
  });

  it('leaves a failing, open issue open, with its table alone', async () => {
    const gh = fakeGithub({ number: 204, state: 'open', body: '| job | failing since |' });
    await noteStandDown({ api: gh.api, percent: '41', ceiling: '30', now: NOW });
    expect(gh.calls).toEqual(['comment']);
  });

  it('says it once a day however many runs stand down', async () => {
    const gh = fakeGithub(CLOSED);
    const first = await noteStandDown({ api: gh.api, percent: '34.2', ceiling: '30', now: NOW });
    const second = await noteStandDown({ api: gh.api, percent: '36.0', ceiling: '30', now: NOW });
    expect(first.action).toBe('commented');
    expect(second.action).toBe('already-noted');
    expect(gh.thread.filter((c) => c.body.startsWith(NOTE_PREFIX))).toHaveLength(1);
  });

  it('says it again tomorrow', async () => {
    const yesterday = { body: noteText({ percent: '50', ceiling: '30' }), created_at: '2026-10-07T00:50:00Z' };
    const gh = fakeGithub(CLOSED, [yesterday]);
    const result = await noteStandDown({ api: gh.api, percent: '33', ceiling: '30', now: NOW });
    expect(result.action).toBe('commented');
  });

  it('is not fooled by an unrelated comment from today', async () => {
    const other = { body: '**Daily production sweep** failed at 2026-10-08', created_at: '2026-10-08T00:10:00Z' };
    const gh = fakeGithub(CLOSED, [other]);
    expect((await noteStandDown({ api: gh.api, percent: '33', ceiling: '30', now: NOW })).action).toBe('commented');
  });

  it('does nothing, and does not fail, when there is no issue to comment on', async () => {
    const gh = fakeGithub(null);
    expect(await noteStandDown({ api: gh.api, percent: '33', ceiling: '30', now: NOW })).toEqual({ action: 'no-issue' });
    expect(gh.calls).toEqual([]);
  });
});
