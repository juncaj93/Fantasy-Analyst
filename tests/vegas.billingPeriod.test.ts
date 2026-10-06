/**
 * The odds provider's billing month, which is not the calendar month.
 *
 * On 6 October 2026 the provider's count was 352 while the ledger had booked 72
 * for "October": the count had not reset on the 1st, and the app, which kept its
 * own books by calendar month, said 72 whenever the provider could not be read.
 * Alex signed up on 13 August, so the billing month is taken to run from the
 * 13th to the 12th. That is an assumption, held in one constant
 * (`BILLING_RESET_DAY`), and these tests are written against the day as a
 * parameter wherever they can be, so changing it does not mean rewriting them.
 *
 * The dates that matter are the boundaries: the day before the 13th, the 13th
 * to the millisecond, the day after, and December running into January.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BILLING_RESET_BASIS,
  BILLING_RESET_CONFIRMED,
  BILLING_RESET_DAY,
  BILLING_RESET_NOTE,
  billingPeriodForKey,
  billingPeriodOf,
} from '../src/core/vegas/billingPeriod.ts';
import { budgetView, emptyLedger } from '../src/core/vegas/budget.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { VegasUsageRepo } from '../src/server/repos/vegasUsage.ts';
import { createTestDb } from './helpers/db.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('the reset day is one named setting', () => {
  it('is the 13th, from the signup date, and is not presented as confirmed', () => {
    expect(BILLING_RESET_DAY).toBe(13);
    expect(BILLING_RESET_BASIS).toContain('13 August 2026');
    expect(BILLING_RESET_CONFIRMED).toBe(false);
    expect(BILLING_RESET_NOTE).toMatch(/assumed/i);
    expect(BILLING_RESET_NOTE).toMatch(/signup/i);
    expect(BILLING_RESET_NOTE).toMatch(/not confirmed/i);
  });

  it('is the only place the day is written: a different day moves every boundary', () => {
    const now = at('2026-10-15T12:00:00Z');
    expect(billingPeriodOf(now).start).toBe('2026-10-13T00:00:00.000Z');
    expect(billingPeriodOf(now, 20).start).toBe('2026-09-20T00:00:00.000Z');
    expect(billingPeriodOf(now, 1).start).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('a date before the 13th is still in the period that began last month', () => {
  it('puts 6 October in the period that started on 13 September', () => {
    const p = billingPeriodOf(at('2026-10-06T12:00:00Z'));
    expect(p.key).toBe('2026-09');
    expect(p.start).toBe('2026-09-13T00:00:00.000Z');
    expect(p.end).toBe('2026-10-13T00:00:00.000Z');
    expect(p.label).toBe('13 Sep to 12 Oct');
  });

  it('puts the 1st, the day the calendar month rolls over, in the same period', () => {
    expect(billingPeriodOf(at('2026-10-01T00:00:00Z')).key).toBe('2026-09');
    expect(billingPeriodOf(at('2026-09-30T23:59:59.999Z')).key).toBe('2026-09');
  });

  it('puts the 12th, to the last millisecond, in the old period', () => {
    expect(billingPeriodOf(at('2026-10-12T23:59:59.999Z')).key).toBe('2026-09');
  });
});

describe('the 13th itself starts the new period', () => {
  it('belongs to the new period from 00:00:00.000 UTC', () => {
    const p = billingPeriodOf(at('2026-10-13T00:00:00.000Z'));
    expect(p.key).toBe('2026-10');
    expect(p.start).toBe('2026-10-13T00:00:00.000Z');
    expect(p.end).toBe('2026-11-13T00:00:00.000Z');
    expect(p.label).toBe('13 Oct to 12 Nov');
  });

  it('is the first millisecond of one period and the end, exclusive, of the other', () => {
    const before = billingPeriodOf(at('2026-10-13T00:00:00.000Z') - 1);
    const on = billingPeriodOf(at('2026-10-13T00:00:00.000Z'));
    expect(before.endMs).toBe(on.startMs);
    expect(before.key).not.toBe(on.key);
  });
});

describe('a date after the 13th is in the period that began this month', () => {
  it('puts 20 October in the period that started on 13 October', () => {
    const p = billingPeriodOf(at('2026-10-20T08:30:00Z'));
    expect(p.key).toBe('2026-10');
    expect(p.start).toBe('2026-10-13T00:00:00.000Z');
  });

  it('puts the end of the month in it too', () => {
    expect(billingPeriodOf(at('2026-10-31T23:59:59.999Z')).key).toBe('2026-10');
    expect(billingPeriodOf(at('2026-11-12T23:59:59.999Z')).key).toBe('2026-10');
  });
});

describe('December into January', () => {
  it('keeps 31 December and 5 January in one period, named for the year it began in', () => {
    const dec = billingPeriodOf(at('2026-12-31T12:00:00Z'));
    const jan = billingPeriodOf(at('2027-01-05T12:00:00Z'));
    expect(dec.key).toBe('2026-12');
    expect(jan.key).toBe('2026-12');
    expect(jan.start).toBe('2026-12-13T00:00:00.000Z');
    expect(jan.end).toBe('2027-01-13T00:00:00.000Z');
    expect(jan.label).toBe('13 Dec to 12 Jan');
  });

  it('keeps 1 January inside the December period, not the start of a new one', () => {
    expect(billingPeriodOf(at('2027-01-01T00:00:00Z')).key).toBe('2026-12');
  });

  it('starts the new year\'s first period on 13 January, to the millisecond', () => {
    expect(billingPeriodOf(at('2027-01-12T23:59:59.999Z')).key).toBe('2026-12');
    const p = billingPeriodOf(at('2027-01-13T00:00:00.000Z'));
    expect(p.key).toBe('2027-01');
    expect(p.start).toBe('2027-01-13T00:00:00.000Z');
    expect(p.end).toBe('2027-02-13T00:00:00.000Z');
  });

  it('reaches December from the other side: 12 December is still November\'s period', () => {
    const p = billingPeriodOf(at('2026-12-12T23:59:59.999Z'));
    expect(p.key).toBe('2026-11');
    expect(p.label).toBe('13 Nov to 12 Dec');
    expect(billingPeriodOf(at('2026-12-13T00:00:00.000Z')).key).toBe('2026-12');
  });

  it('works for a reset day in early January too, where "last month" is last year', () => {
    const p = billingPeriodOf(at('2027-01-05T00:00:00Z'), 20);
    expect(p.key).toBe('2026-12');
    expect(p.start).toBe('2026-12-20T00:00:00.000Z');
    expect(p.end).toBe('2027-01-20T00:00:00.000Z');
  });
});

describe('the periods tile the calendar', () => {
  it('leaves no gap and no overlap across two years, hour by hour at every boundary', () => {
    let previous = billingPeriodOf(at('2026-01-01T00:00:00Z'));
    for (let t = at('2026-01-01T00:00:00Z'); t < at('2028-01-01T00:00:00Z'); t += 3_600_000) {
      const p = billingPeriodOf(t);
      expect(p.startMs).toBeLessThanOrEqual(t);
      expect(t).toBeLessThan(p.endMs);
      if (p.key !== previous.key) expect(previous.endMs).toBe(p.startMs);
      previous = p;
    }
  });

  it('is the same answer for the same period from either end', () => {
    for (const probe of ['2026-10-13T00:00:00Z', '2026-11-12T23:59:59Z', '2027-01-13T00:00:00Z', '2027-02-12T00:00:00Z']) {
      const p = billingPeriodOf(at(probe));
      expect(billingPeriodForKey(p.key).start).toBe(p.start);
      expect(billingPeriodForKey(p.key).end).toBe(p.end);
    }
  });

  it('puts a reset day the month does not have on its last day, still with no gap', () => {
    // Day 31 in 2027: February has 28, so its period starts on the 28th.
    expect(billingPeriodOf(at('2027-02-10T00:00:00Z'), 31).start).toBe('2027-01-31T00:00:00.000Z');
    expect(billingPeriodOf(at('2027-02-28T00:00:00Z'), 31).start).toBe('2027-02-28T00:00:00.000Z');
    expect(billingPeriodOf(at('2027-02-28T00:00:00Z'), 31).end).toBe('2027-03-31T00:00:00.000Z');
  });
});

describe('the budget view says what it is counting', () => {
  it('names the period in words and says the start day is assumed', () => {
    const view = budgetView(emptyLedger('2026-09'));
    expect(view.month).toBe('2026-09');
    expect(view.period.label).toBe('13 Sep to 12 Oct');
    expect(view.period.resetDay).toBe(13);
    expect(view.period.confirmed).toBe(false);
    expect(view.period.note).toBe(BILLING_RESET_NOTE);
  });

  it('does not call the period a calendar month anywhere a reader would see it', () => {
    const view = budgetView(emptyLedger('2026-09'));
    expect(view.period.label).not.toMatch(/October|September|2026-/);
  });
});

// --------------------------------------------------------------- the ledger

describe('the ledger counts from the same day as the provider', () => {
  let db: NodeSqliteDatabase;
  let usage: VegasUsageRepo;

  /** A log row at an exact instant, filed under its calendar month as the real writer does. */
  async function spend(when: string, entities: number, outcome = 'fetched', reason: string | null = null, source = 'weekly') {
    await db
      .prepare(
        `INSERT INTO vegas_usage_log (month, at, source, event_id, entities, requests, outcome, reason)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(when.slice(0, 7), when, source, null, entities, entities, outcome, reason)
      .run();
  }

  async function reading(entities: number, readAt: string, limit = 2500) {
    await db
      .prepare(
        `INSERT INTO vegas_usage (month, entities, requests, provider_entities, provider_limit, provider_read_at, updated_at)
         VALUES (?,0,0,?,?,?,?)`,
      )
      .bind(readAt.slice(0, 7), entities, limit, readAt, readAt)
      .run();
  }

  beforeEach(async () => {
    db = await createTestDb();
    usage = new VegasUsageRepo(db);
  });

  it('counts a spend on 20 September on 6 October, which a calendar month would not', async () => {
    await spend('2026-09-20T15:00:00.000Z', 14);
    await spend('2026-10-03T15:00:00.000Z', 18);

    const ledger = await usage.ledger(at('2026-10-06T12:00:00Z'));
    expect(ledger.entities, 'both, because both are in the period that began 13 September').toBe(32);
    expect(ledger.month).toBe('2026-09');
  });

  it('starts counting on the 13th itself and not a moment before', async () => {
    await spend('2026-09-12T23:59:59.999Z', 100); // the previous period's last millisecond
    await spend('2026-09-13T00:00:00.000Z', 7); // the first millisecond of this one

    expect((await usage.ledger(at('2026-09-20T00:00:00Z'))).entities).toBe(7);
    expect((await usage.ledger(at('2026-09-12T23:59:59.999Z'))).entities).toBe(100);
  });

  it('stops counting at the 13th: the new period starts from nothing', async () => {
    await spend('2026-10-12T23:59:59.999Z', 40);
    await spend('2026-10-13T00:00:00.000Z', 5);

    expect((await usage.ledger(at('2026-10-12T23:59:59.999Z'))).entities).toBe(40);
    expect((await usage.ledger(at('2026-10-13T00:00:00.000Z'))).entities).toBe(5);
  });

  it('carries a period across the year end: 20 December and 5 January are one period', async () => {
    await spend('2026-12-20T10:00:00.000Z', 11);
    await spend('2027-01-05T10:00:00.000Z', 4);
    await spend('2027-01-13T00:00:00.000Z', 9);

    expect((await usage.ledger(at('2027-01-06T00:00:00Z'))).entities).toBe(15);
    expect((await usage.ledger(at('2027-01-13T12:00:00Z'))).entities).toBe(9);
  });

  it('never counts a refusal or a blocked call', async () => {
    await spend('2026-10-01T10:00:00.000Z', 9);
    await spend('2026-10-01T10:00:01.000Z', 1, 'refused');
    await spend('2026-10-01T10:00:02.000Z', 0, 'blocked');
    expect((await usage.ledger(at('2026-10-06T00:00:00Z'))).entities).toBe(9);
  });

  it('is the number the guard falls back to when the provider cannot be read', async () => {
    // 6 October 2026, as it really was: September 13th onwards is 293, October's
    // own share is 72, and with no provider reading the app must say 293 and not 72.
    await spend('2026-09-14T10:00:00.000Z', 221);
    await spend('2026-10-02T10:00:00.000Z', 72);

    const view = await usage.view(at('2026-10-06T12:00:00Z'));
    expect(view.source).toBe('ledger');
    expect(view.used).toBe(293);
    expect(view.period.label).toBe('13 Sep to 12 Oct');
  });

  it('believes the provider when it is higher, and only for the period it was read in', async () => {
    await spend('2026-10-02T10:00:00.000Z', 72);
    await reading(352, '2026-10-06T19:17:09.860Z');

    const view = await usage.view(at('2026-10-06T20:00:00Z'));
    expect(view.used).toBe(352);
    expect(view.source).toBe('provider');
  });

  it('does not reset on the 1st: a reading from 30 September is still believed on 5 October', async () => {
    await spend('2026-10-02T10:00:00.000Z', 14);
    await reading(279, '2026-09-30T18:06:34.068Z');
    expect((await usage.view(at('2026-10-05T00:00:00Z'))).used).toBe(279);
  });

  it('ignores a reading from the previous period, so a stale count cannot carry over the reset', async () => {
    await reading(352, '2026-10-06T19:17:09.860Z');
    await spend('2026-10-13T08:00:00.000Z', 3);

    const view = await usage.view(at('2026-10-13T09:00:00Z'));
    expect(view.source).toBe('ledger');
    expect(view.used).toBe(3);
  });

  it('keeps the provider\'s ceiling with the reading it came with', async () => {
    await reading(10, '2026-10-06T19:17:09.860Z', 5000);
    expect((await usage.view(at('2026-10-07T00:00:00Z'))).limit).toBe(5000);
    expect((await usage.view(at('2026-10-13T00:00:00Z'))).limit).toBe(2500);
  });

  it('files a new reading under the period it was taken in, and finds it again', async () => {
    await usage.recordProviderUsage({ entities: 352, limit: 2500 });
    const view = await usage.view();
    expect(view.used).toBeGreaterThanOrEqual(352);
    expect(view.source).toBe('provider');
  });

  it('reports the period\'s own activity, not the calendar month\'s', async () => {
    await spend('2026-09-20T10:00:00.000Z', 30, 'fetched', null, 'manual');
    await spend('2026-10-03T10:00:00.000Z', 9, 'fetched', null, 'weekly');

    expect(await usage.bySource(at('2026-10-06T00:00:00Z'))).toEqual({ manual: 30, weekly: 9 });
    expect(await usage.bySource(at('2026-10-14T00:00:00Z'))).toEqual({});
    const recent = await usage.recent(10, at('2026-10-06T00:00:00Z'));
    expect(recent.map((r) => r.entities)).toEqual([9, 30]);
  });

  it('a spend recorded now lands in the period now is in', async () => {
    await usage.record({ source: 'weekly', entities: 2, requests: 2, outcome: 'fetched' });
    expect((await usage.ledger()).entities).toBe(2);
    expect(iso(billingPeriodOf().startMs) <= iso(Date.now())).toBe(true);
  });
});
