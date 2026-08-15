/**
 * The fingerprint decides what a five-second poll costs.
 *
 * If it moves when nothing happened, the app rebuilds the board — Monte Carlo
 * survival, tier bands, opportunity cost — twelve times a minute for no reason.
 * If it fails to move when a pick landed, the board is silently wrong for the
 * rest of the draft. Both failures are invisible on screen, which is why they
 * are asserted here rather than looked at.
 */

import { describe, expect, it } from 'vitest';
import { draftStateFingerprint, type FingerprintInput } from '../src/core/sleeper/draftFingerprint.ts';

const base: FingerprintInput = {
  draftId: 'draft-1',
  status: 'drafting',
  picks: [
    { pickNo: 1, playerId: '1001', rosterId: 1, pickedBy: 'me' },
    { pickNo: 2, playerId: '1002', rosterId: 2, pickedBy: 'rival' },
  ],
};

describe('draft state fingerprint', () => {
  it('is stable for the same draft state', () => {
    expect(draftStateFingerprint(base)).toBe(draftStateFingerprint(base));
  });

  it('ignores the order picks arrive in', () => {
    const reversed = { ...base, picks: [...base.picks].reverse() };
    expect(draftStateFingerprint(reversed)).toBe(draftStateFingerprint(base));
  });

  /**
   * The case this whole mechanism exists for.
   *
   * Sleeper rewrites per-pick metadata and carries transport fields that have
   * nothing to do with a draft. A fingerprint that noticed them would report a
   * change on every poll, which is the same as having no fingerprint at all.
   */
  it('ignores metadata that is not part of the draft', () => {
    const noisy: FingerprintInput = {
      ...base,
      picks: base.picks.map((p) => ({ ...p })),
    };
    // Fields outside the interface cannot reach the hash at all — the shape is
    // the guarantee. This asserts the extras are genuinely dropped rather than
    // spread into it.
    const withExtras = {
      ...base,
      picks: base.picks.map((p) => ({ ...p, metadata: { news_updated: Date.now() }, fetchedAt: 'now' })),
    } as FingerprintInput;
    expect(draftStateFingerprint(withExtras)).toBe(draftStateFingerprint(noisy));
  });

  it('changes when a new pick lands', () => {
    const next: FingerprintInput = {
      ...base,
      picks: [...base.picks, { pickNo: 3, playerId: '1003', rosterId: 3, pickedBy: 'other' }],
    };
    expect(draftStateFingerprint(next)).not.toBe(draftStateFingerprint(base));
  });

  it('changes when a pick is made in a slot that was empty', () => {
    const empty: FingerprintInput = {
      ...base,
      picks: [...base.picks, { pickNo: 3, playerId: null, rosterId: 3 }],
    };
    const filled: FingerprintInput = {
      ...base,
      picks: [...base.picks, { pickNo: 3, playerId: '1003', rosterId: 3 }],
    };
    expect(draftStateFingerprint(filled)).not.toBe(draftStateFingerprint(empty));
  });

  /**
   * Ownership, not the slot.
   *
   * A traded pick means the team on the clock is not the one the snake order
   * would name, and "whose turn is it" follows ownership. A fingerprint blind to
   * it would let the board go on saying YOUR PICK after the pick changed hands.
   */
  it('changes when pick ownership changes', () => {
    const traded: FingerprintInput = {
      ...base,
      picks: [base.picks[0]!, { ...base.picks[1]!, rosterId: 7, pickedBy: 'new-owner' }],
    };
    expect(draftStateFingerprint(traded)).not.toBe(draftStateFingerprint(base));
  });

  it('changes when the draft status changes', () => {
    expect(draftStateFingerprint({ ...base, status: 'paused' })).not.toBe(draftStateFingerprint(base));
    expect(draftStateFingerprint({ ...base, status: 'complete' })).not.toBe(draftStateFingerprint(base));
  });

  it('separates two drafts holding identical picks', () => {
    expect(draftStateFingerprint({ ...base, draftId: 'draft-2' })).not.toBe(draftStateFingerprint(base));
  });

  it('carries the pick count in the clear, so one more pick cannot collide', () => {
    const one = draftStateFingerprint(base);
    const two = draftStateFingerprint({
      ...base,
      picks: [...base.picks, { pickNo: 3, playerId: '1003', rosterId: 3 }],
    });
    expect(one.split(':')[2]).toBe('2');
    expect(two.split(':')[2]).toBe('3');
  });
});
