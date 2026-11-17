import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * MY PAY PERIODS: A READ THAT SHOWS NO FIGURE IS ALSO FILED (cn-v1166). The person is told "Your pay
 * can't be shown right now"; this proves the ops log is told too, once per call, under a title of its
 * own for each cause (a failed read, a read too long, paid hours whose runs could not be seen), and
 * never for an ok read or for someone paid by owner's draw. A stand-in client answers each read.
 */
const reportError = vi.fn();
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import { readMyPay } from "./my-pay-read";

const SAM = "11111111-1111-4111-8111-111111111111";
const O = { tz: "America/Los_Angeles", schedule: "biweekly" as const, anchor: "2026-01-05", today: "2026-02-10" };

type Answer = { data: any; error: unknown };
type Plan = {
  self?: Answer;
  /** One page of a table's rows, by table and the page's first row. */
  page?: (table: string, from: number) => Answer;
};

/** A stand-in Supabase client: every chain method returns the chain; range and maybeSingle answer. */
function client(plan: Plan) {
  const selected: string[] = [];
  return {
    selected,
    from(table: string) {
      const chain: any = {
        select: (cols: string) => {
          selected.push(`${table}: ${cols}`);
          return chain;
        },
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        gte: () => chain,
        order: () => chain,
        range: (from: number) => Promise.resolve(plan.page ? plan.page(table, from) : { data: [], error: null }),
        maybeSingle: () => Promise.resolve(plan.self ?? { data: { hourly_rate: 40, commute_baseline_miles: 0, paid_by_draw: false }, error: null }),
      };
      return chain;
    },
  };
}

const EMPTY: Answer = { data: [], error: null };

beforeEach(() => reportError.mockClear());

describe("readMyPay files a read that shows no figure, once, by its cause", () => {
  it("ok: nothing filed", async () => {
    const r = await readMyPay(client({}), SAM, O);
    expect(r.kind).toBe("ok");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("paid by owner's draw is not an error, even when the other reads failed", async () => {
    const r = await readMyPay(client({ self: { data: { hourly_rate: null, commute_baseline_miles: null, paid_by_draw: true }, error: null }, page: () => ({ data: null, error: { message: "boom" } }) }), SAM, O);
    expect(r.kind).toBe("draw");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a failed read: filed once as my-pay.read-failed", async () => {
    const r = await readMyPay(client({ page: (t) => (t === "time_entries" ? { data: null, error: { message: "boom" } } : EMPTY) }), SAM, O);
    expect(r.kind).toBe("cantShow");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("my-pay.read-failed");
  });

  it("his own pay row could not be read: filed as my-pay.read-failed", async () => {
    const r = await readMyPay(client({ self: { data: null, error: { message: "denied" } } }), SAM, O);
    expect(r.kind).toBe("cantShow");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("my-pay.read-failed");
  });

  it("a read longer than its bound: filed once as my-pay.read-too-long", async () => {
    const full = { data: Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}` })), error: null };
    const r = await readMyPay(client({ page: (t) => (t === "pay_payments" ? full : EMPTY) }), SAM, O);
    expect(r.kind).toBe("cantShow");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("my-pay.read-too-long");
  });

  it("hours marked paid and no locked period came back: filed once as my-pay.paid-hours-without-runs", async () => {
    const paid = {
      id: "e1",
      profile_id: SAM,
      clock_in: "2026-01-06T16:00:00.000Z",
      clock_out: "2026-01-07T00:00:00.000Z",
      status: "closed",
      lunch_minutes: 0,
      miles: 0,
      paid_at: "2026-01-20T00:00:00Z",
      mileage_paid_at: null,
      rate_override: null,
      split_from: null,
    };
    let served = false;
    const r = await readMyPay(
      client({
        page: (t, from) => {
          if (t === "time_entries" && from === 0 && !served) {
            served = true;
            return { data: [paid], error: null };
          }
          return EMPTY;
        },
      }),
      SAM,
      O,
    );
    expect(r.kind).toBe("cantShow");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("my-pay.paid-hours-without-runs");
  });

  it("the report carries no extra about the person: just the title and the cause", async () => {
    await readMyPay(client({ page: () => ({ data: null, error: { message: "boom" } }) }), SAM, O);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0].length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(reportError.mock.calls[0])).not.toContain(SAM);
  });

  it("the job's fields are read only when asked for (the one-period page)", async () => {
    const plain = client({});
    await readMyPay(plain, SAM, O);
    expect(plain.selected.filter((s) => s.startsWith("time_entries")).every((s) => !s.includes("job"))).toBe(true);
    const withJobs = client({});
    await readMyPay(withJobs, SAM, { ...O, withJobs: true });
    expect(withJobs.selected.filter((s) => s.startsWith("time_entries")).every((s) => s.includes("job:job_id(job_number, name, address, customers(name))"))).toBe(true);
  });
});
