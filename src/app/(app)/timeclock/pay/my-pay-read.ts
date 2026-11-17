import { isPaidByDraw } from "@/lib/profile-columns";
import { reportError } from "@/lib/observe";
import { tzDayStartUtc } from "@/lib/tz";
import {
  balanceWindowStartYmd,
  myPayPeriods,
  toPayPaymentRow,
  type MyPay,
  type MyPayRun,
  type PaySchedule,
  type PayPaymentRow,
} from "@/lib/payroll-math";

/**
 * MY PAY PERIODS: THE READS (cn-v1166). The signed-in person's OWN rows, and nothing else: every read
 * below names `.eq("profile_id", userId)` (or `.eq("id", userId)` on profile_pay), and row-level security
 * holds the same line underneath (time_entries and pay_payments since long ago, payroll_runs since 0410).
 *
 * THE SAME INPUTS THE OFFICE'S PAYROLL PAGE READS FOR THAT PERSON: his entries over BALANCE_MONTHS (the
 * closed ones and the running ones, read apart exactly as the office reads them), ALL his payroll runs,
 * ALL his payments. So myPayPeriods, which is the office's own math, gives him the office's figures.
 *
 * WHAT IS NEVER SELECTED, and a test reads this file for it: bill_rate, cost_rate, a payment's or a
 * run's note, created_by, and any figure of a job. A job comes with its number, its name, its street and
 * its customer's name, the fields the My timecard card already shows him, and nothing priced.
 *
 * THE READS COME BACK WHOLE OR NO FIGURE IS SHOWN, the Payroll page's rule: every list is paged to an
 * empty page, a failed or too-long read is "cantShow", and the page says one plain line. The person is
 * told, and so is the ops log: each failing call files ONE report (a failed read, a read too long, or
 * paid hours whose runs could not be seen), and none for someone paid by owner's draw, which is not an
 * error. The report carries nothing about the person beyond what the reporter itself attaches.
 */

/** profile_pay, for his own row: the rate his live hours are priced at, the commute allowance the
 *  office nets his miles by, and whether he is paid by owner's draw. Never bill_rate, never cost_rate. */
const SELF_PAY_COLS = "hourly_rate, commute_baseline_miles, paid_by_draw";

/** Every field the office's balance math reads off an entry. */
const MY_ENTRY_COLS = "id, profile_id, clock_in, clock_out, status, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, split_from";

/** The same, with the job's own label fields: read ONLY for one period's page, the one place a job's
 *  name is shown. Its number, name, street and customer's name; nothing priced. */
const MY_ENTRY_JOB_COLS =
  "id, profile_id, clock_in, clock_out, status, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, split_from, job:job_id(job_number, name, address, customers(name))";

/** A payment as he reads it: never the office's note. */
const MY_PAYMENT_COLS = "id, profile_id, amount, paid_on, method, reference, needs_check, voided_at, created_at";

/** A run as he reads it: never the note, never who wrote it. */
const MY_RUN_COLS = "kind, period_start, period_end, hours, gross, miles, mileage_amount";

const PAGE_ROWS = 1000;
/** 12,000 rows per read: a bound, not a target (the Payroll page's). */
const MAX_PAGES = 12;

/** Paged to an EMPTY page, advancing by the rows actually returned (the Payroll page's readAll):
 *  PostgREST stops at its row cap with status 200 and no error, so a bare limit cannot see a cut.
 *  A failed page is "failed"; more than MAX_PAGES of rows is "tooLong". */
async function readWhole<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[] | "failed" | "tooLong"> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error || !data) return "failed";
    if (!data.length) return out;
    out.push(...data);
    from += data.length;
  }
  return "tooLong";
}

/** The three ways a read shows no figure, each its own title in the ops log. */
const REPORT_TITLE = {
  failed: "my-pay.read-failed",
  tooLong: "my-pay.read-too-long",
  unreadable: "my-pay.paid-hours-without-runs",
} as const;

export type MyPayData =
  /** Paid by owner's draw: there are no pay periods to show. */
  | { kind: "draw" }
  /** A read failed, came back too long, or the runs could not be seen: no figure may be drawn. */
  | { kind: "cantShow" }
  | {
      kind: "ok";
      pay: MyPay;
      /** His entries in the window (closed and running); with the job's label fields only when asked. */
      entries: any[];
      /** His payroll runs, both kinds, as read: one period's page lists its entries by them. */
      runs: MyPayRun[];
      /** Newest first, as the office's list. */
      payments: PayPaymentRow[];
    };

export async function readMyPay(
  supabase: any,
  userId: string,
  o: { tz: string; schedule: PaySchedule; anchor: string; today: string; withJobs?: boolean },
): Promise<MyPayData> {
  if (!userId) return { kind: "cantShow" };
  /** Says no figure, and files it once: the first cause found is the one reported. */
  let reported = false;
  const cantShow = (why: keyof typeof REPORT_TITLE, e?: unknown): MyPayData => {
    if (!reported) {
      reported = true;
      reportError(REPORT_TITLE[why], e ?? new Error(REPORT_TITLE[why]));
    }
    return { kind: "cantShow" };
  };
  const entryCols = o.withJobs ? MY_ENTRY_JOB_COLS : MY_ENTRY_COLS;
  const windowIso = tzDayStartUtc(balanceWindowStartYmd(o.today), o.tz).toISOString();
  try {
    const [selfRes, closed, open, paymentRows, runs] = await Promise.all([
      supabase.from("profile_pay").select(SELF_PAY_COLS).eq("id", userId).maybeSingle(),
      readWhole<any>((from, to) =>
        supabase
          .from("time_entries")
          .select(entryCols)
          .eq("profile_id", userId)
          .eq("status", "closed")
          .not("clock_out", "is", null)
          .gte("clock_in", windowIso)
          .order("id")
          .range(from, to),
      ),
      readWhole<any>((from, to) =>
        supabase.from("time_entries").select(entryCols).eq("profile_id", userId).is("clock_out", null).gte("clock_in", windowIso).order("id").range(from, to),
      ),
      readWhole<any>((from, to) =>
        supabase
          .from("pay_payments")
          .select(MY_PAYMENT_COLS)
          .eq("profile_id", userId)
          .order("paid_on", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      ),
      readWhole<MyPayRun>((from, to) => supabase.from("payroll_runs").select(MY_RUN_COLS).eq("profile_id", userId).order("id").range(from, to)),
    ]);
    const self = selfRes?.data as { hourly_rate?: unknown; commute_baseline_miles?: unknown; paid_by_draw?: unknown } | null;
    if (selfRes?.error || !self) return cantShow("failed", selfRes?.error);
    if (isPaidByDraw(self)) return { kind: "draw" };
    if ([closed, open, paymentRows, runs].includes("failed")) return cantShow("failed");
    // Anything still not a list came back longer than MAX_PAGES.
    if (typeof closed === "string" || typeof open === "string" || typeof paymentRows === "string" || typeof runs === "string") return cantShow("tooLong");

    // The rate rides on each entry's profile, the way the office's attachRates puts it there, so
    // payRateForEntry and the mileage netting read exactly what they read on the Payroll page.
    const rate = { hourly_rate: (self.hourly_rate as number | null) ?? null, commute_baseline_miles: (self.commute_baseline_miles as number | null) ?? null };
    const entries = [...closed, ...open].map((e) => ({ ...e, profiles: { ...rate } }));
    const payments = paymentRows.map(toPayPaymentRow);
    const pay = myPayPeriods({
      profileId: userId,
      name: "",
      entries,
      runs,
      payments,
      tz: o.tz,
      schedule: o.schedule,
      anchor: o.anchor,
      fallbackRate: Number(rate.hourly_rate ?? 0),
    });
    if (pay.unreadable) return cantShow("unreadable");
    return { kind: "ok", pay, entries, payments, runs };
  } catch (e) {
    return cantShow("failed", e);
  }
}
