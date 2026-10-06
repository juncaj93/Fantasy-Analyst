/**
 * The odds provider's billing month, and the one place its reset day is written.
 *
 * ## What is known and what is assumed
 *
 * The provider counts entities per month and never says when the month starts:
 * its usage response carries no date and no period, its documentation gives the
 * allowance and not the reset, and the account endpoints that might hold it
 * answer 404. What the data does show is that it is **not the calendar month**.
 * The count did not reset on 1 October 2026 (327 on the 6th with only 47
 * entities of October's in the ledger), and it fell from 641 to 279 somewhere
 * between 30 August and 30 September.
 *
 * The reset day below is therefore an **assumption**, taken from the day the
 * account was opened: Alex signed up on 13 August 2026, so the billing month is
 * taken to run from the 13th to the 12th, last reset about 13 September, next
 * about 13 October. Nothing here is confirmed by the provider, and every surface
 * that shows the period says so ({@link BILLING_RESET_NOTE}).
 *
 * ## Changing it
 *
 * Change {@link BILLING_RESET_DAY}, and nothing else. The ledger is derived from
 * the log by date, never stored per period, so a different day re-derives every
 * number on the next read; there is no migration and nothing to backfill. After
 * 13 October `scripts/probe-vegas-count-gap.mjs` checks the assumption against
 * the provider's own count and says so loudly if the count did not fall.
 *
 * The reset is taken to be 00:00 UTC on that day. That is also an assumption.
 */

/** The day of the month the provider's billing month is assumed to start on, UTC. */
export const BILLING_RESET_DAY = 13;

/** Why that day. Shown, so nobody mistakes an assumption for a fact. */
export const BILLING_RESET_BASIS = 'signup date, 13 August 2026';

/** False until the provider (or an observed reset) says otherwise. */
export const BILLING_RESET_CONFIRMED = false;

export const BILLING_RESET_NOTE =
  `The reset day (the ${ordinal(BILLING_RESET_DAY)}) is assumed from the ${BILLING_RESET_BASIS}. ` +
  'The provider does not publish it, so it is a best estimate and not confirmed.';

export interface BillingPeriod {
  /** The month the period starts in, `YYYY-MM`. A label, not a calendar month. */
  key: string;
  startMs: number;
  /** Exclusive: the instant the next period starts. */
  endMs: number;
  start: string;
  end: string;
  /** Plain words for a screen: "13 Sep to 12 Oct". */
  label: string;
}

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/**
 * When the period that starts in this month starts.
 *
 * A reset day the month does not have (the 31st, in February) lands on the
 * month's last day, so the periods still tile the calendar with no gap and no
 * overlap whatever day is chosen.
 */
function startOf(year: number, month: number, resetDay: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(Math.max(1, Math.trunc(resetDay)), lastDay));
}

function describe(startMs: number, endMs: number): BillingPeriod {
  const s = new Date(startMs);
  const lastDay = new Date(endMs - DAY_MS);
  const key = `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    key,
    startMs,
    endMs,
    start: s.toISOString(),
    end: new Date(endMs).toISOString(),
    label: `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]} to ${lastDay.getUTCDate()} ${MONTHS[lastDay.getUTCMonth()]}`,
  };
}

/**
 * The billing period an instant falls in.
 *
 * The 13th itself, from 00:00:00.000 UTC, is the first moment of the new period;
 * the millisecond before it is the last of the old one. December runs into
 * January without a special case, because the arithmetic is on instants.
 */
export function billingPeriodOf(now: Date | number = Date.now(), resetDay: number = BILLING_RESET_DAY): BillingPeriod {
  const at = typeof now === 'number' ? now : now.getTime();
  const d = new Date(Number.isFinite(at) ? at : Date.now());
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  if (d.getTime() < startOf(year, month, resetDay)) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  const startMs = startOf(year, month, resetDay);
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  return describe(startMs, startOf(nextYear, nextMonth, resetDay));
}

/** The period a stored `YYYY-MM` key names, for a ledger that only carries the key. */
export function billingPeriodForKey(key: string, resetDay: number = BILLING_RESET_DAY): BillingPeriod {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return billingPeriodOf(Date.now(), resetDay);
  return billingPeriodOf(startOf(Number(match[1]), Number(match[2]) - 1, resetDay), resetDay);
}

/** What a screen or an API response carries about the period, assumption included. */
export interface BillingPeriodView {
  start: string;
  end: string;
  label: string;
  resetDay: number;
  basis: string;
  confirmed: boolean;
  note: string;
}

export function billingPeriodView(period: BillingPeriod): BillingPeriodView {
  return {
    start: period.start,
    end: period.end,
    label: period.label,
    resetDay: BILLING_RESET_DAY,
    basis: BILLING_RESET_BASIS,
    confirmed: BILLING_RESET_CONFIRMED,
    note: BILLING_RESET_NOTE,
  };
}
