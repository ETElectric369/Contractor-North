import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * HOLDS ARE BACK (Wave 1, lane 5): the morning push's first decision line counts every job on hold
 * whose day has come or that has no day (company today, filtered to the company by hand: the cron's
 * service client reads every company). It joins the decisions, so a morning with only holds back
 * still pushes. Before 0366 (no hold_until) the read fails and counts 0: no line, never a guess.
 */
const { notifyPeople, reportError } = vi.hoisted(() => ({ notifyPeople: vi.fn(async () => undefined), reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError }));
vi.mock("@/lib/push", () => ({ pushConfigured: () => true, orgStaffIds: async () => ["owner-1"] }));
vi.mock("@/lib/notifications", () => ({ notifyPeople }));
// BILLING ON (cn-v1137): a company whose plan has ended gets no morning push (readActiveOrgs); with
// billing off nothing lapses, so the fixture carries a live status to be read at all.
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));

import { holdsBackCount, holdsBackLine, sendDayAheadDigests } from "./digest";

type Answer = { data?: unknown; error?: unknown; count?: number | null };

/** A pretend service client: each table answers once, and every filter it was given is kept. */
function fake(answers: Record<string, Answer | (() => Answer)>) {
  const filters: Record<string, unknown[][]> = {};
  const from = (table: string) => {
    filters[table] = filters[table] ?? [];
    let pageFrom = 0; // readAllOrgs pages organizations (cn-v1130): the rows at 0, an empty page after
    const q: any = {
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        const a = typeof answers[table] === "function" ? (answers[table] as () => Answer)() : (answers[table] as Answer | undefined);
        return Promise.resolve({ data: pageFrom > 0 ? [] : (a?.data ?? []), error: a?.error ?? null, count: a?.count ?? null }).then(res, rej);
      },
      range: (start: number, end: number) => {
        filters[table].push(["range", start, end]);
        pageFrom = start;
        return q;
      },
    };
    for (const m of ["select", "eq", "in", "is", "or", "lt", "lte", "order", "limit"]) {
      q[m] = (...args: unknown[]) => {
        filters[table].push([m, ...args]);
        return q;
      };
    }
    return q;
  };
  return { from, filters };
}

const ORG = { id: "org-1", settings: { timezone: "America/Los_Angeles" }, subscription_status: "active" };

beforeEach(() => {
  notifyPeople.mockClear();
  reportError.mockClear();
});

describe("the holds line", () => {
  it("says how many, in Title Case, one or many", () => {
    expect(holdsBackLine(1)).toBe("1 Hold Is Back");
    expect(holdsBackLine(3)).toBe("3 Holds Are Back");
  });

  it("a failed read (0366 not on the database) counts 0", () => {
    expect(holdsBackCount({ count: 4, error: { code: "42703" } })).toBe(0);
    expect(holdsBackCount({ count: 2, error: null })).toBe(2);
    expect(holdsBackCount(null)).toBe(0);
  });
});

describe("the morning push", () => {
  it("a morning with only holds back still pushes, and the line leads", async () => {
    const db = fake({ organizations: { data: [ORG] }, jobs: { count: 2 }, invoices: { count: 0 }, inquiries: { count: 0 }, tasks: { data: [] } });
    expect(await sendDayAheadDigests(db)).toEqual({ orgs: 1, pushed: 1, failed: 0, lapsed_skipped: 0 });
    expect(notifyPeople).toHaveBeenCalledWith("org-1", ["owner-1"], "day_ahead", { title: "Needs You: 2", body: "2 Holds Are Back", url: "/planner" });
    // Filtered to this company by hand; on hold; back today or earlier, or no day at all.
    const jobs = db.filters.jobs;
    expect(jobs).toContainEqual(["eq", "org_id", "org-1"]);
    expect(jobs).toContainEqual(["eq", "status", "on_hold"]);
    expect(jobs.find((f) => f[0] === "or")?.[1]).toMatch(/^hold_until\.is\.null,hold_until\.lte\.\d{4}-\d{2}-\d{2}$/);
  });

  it("the holds line stands for all of them; the rest of the decisions follow it", async () => {
    const db = fake({
      organizations: { data: [ORG] },
      jobs: { count: 3 },
      invoices: { data: [{ invoice_number: "INV-071" }], count: 1 },
      inquiries: { data: [{ name: "Dana" }], count: 2 },
      tasks: { data: [] },
    });
    await sendDayAheadDigests(db);
    expect(notifyPeople).toHaveBeenCalledWith("org-1", ["owner-1"], "day_ahead", {
      title: "Needs You: 6",
      body: "3 Holds Are Back · Invoice INV-071 overdue · +2 more",
      url: "/planner",
    });
  });

  it("a new lead snoozed to a later day waits for it: the lead read carries Needs You's due filter", async () => {
    const db = fake({ organizations: { data: [ORG] }, jobs: { count: 0 }, invoices: { count: 0 }, inquiries: { count: 0 }, tasks: { data: [] } });
    await sendDayAheadDigests(db);
    const leads = db.filters.inquiries;
    expect(leads).toContainEqual(["eq", "org_id", "org-1"]);
    expect(leads).toContainEqual(["eq", "status", "new"]);
    // next_follow_up_at empty, or on/before the company's today: the rule My Day and the Sales badge use.
    expect(leads.find((f) => f[0] === "or")?.[1]).toMatch(/^next_follow_up_at\.is\.null,next_follow_up_at\.lte\.\d{4}-\d{2}-\d{2}$/);
  });

  it("a company whose plan has ended gets no push and is counted; the standing company still gets its morning (cn-v1137)", async () => {
    const lapsed = { id: "org-2", settings: { timezone: "America/Los_Angeles" }, subscription_status: "canceled" };
    const db = fake({ organizations: { data: [ORG, lapsed] }, jobs: { count: 2 }, invoices: { count: 0 }, inquiries: { count: 0 }, tasks: { data: [] } });
    expect(await sendDayAheadDigests(db)).toEqual({ orgs: 1, pushed: 1, failed: 0, lapsed_skipped: 1 });
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    expect(notifyPeople).toHaveBeenCalledWith("org-1", ["owner-1"], "day_ahead", expect.anything());
  });

  it("before 0366 the holds read fails: no line, and nothing to push when nothing else waits", async () => {
    const db = fake({ organizations: { data: [ORG] }, jobs: { error: { code: "42703" }, count: null }, invoices: { count: 0 }, inquiries: { count: 0 }, tasks: { data: [] } });
    expect(await sendDayAheadDigests(db)).toEqual({ orgs: 1, pushed: 0, failed: 0, lapsed_skipped: 0 });
    expect(notifyPeople).not.toHaveBeenCalled();
  });
});

/**
 * A FAILED TASKS READ IS NOT "NO SIX", AND ONE COMPANY'S FAILURE IS ITS OWN (cn-v1130, skeptic #34).
 * The tasks read was a bare `.data`: a failed one read as an empty pool, and the company was pushed
 * only its decisions as if nothing else waited. Now it throws into the company's own catch: counted in
 * `failed`, filed as cron-day-ahead with the orgId, nothing pushed for it, and the next company still
 * gets its morning.
 */
describe("the morning push and a failed read", () => {
  const boom = { message: "boom" };

  it("a failed tasks read pushes nothing for the company (its decisions would have pushed), counts it, and files it with the orgId", async () => {
    const db = fake({ organizations: { data: [ORG] }, jobs: { count: 2 }, invoices: { count: 0 }, inquiries: { count: 0 }, tasks: { error: boom } });
    expect(await sendDayAheadDigests(db)).toEqual({ orgs: 1, pushed: 0, failed: 1, lapsed_skipped: 0 });
    expect(notifyPeople).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("cron-day-ahead", boom, { orgId: "org-1" });
  });

  it("one company failing costs the next none of its morning", async () => {
    let taskReads = 0;
    const db = fake({
      organizations: { data: [ORG, { id: "org-2", settings: { timezone: "America/Los_Angeles" }, subscription_status: "active" }] },
      jobs: { count: 2 },
      invoices: { count: 0 },
      inquiries: { count: 0 },
      tasks: () => (++taskReads === 1 ? { error: boom } : { data: [] }),
    });
    expect(await sendDayAheadDigests(db)).toEqual({ orgs: 2, pushed: 1, failed: 1, lapsed_skipped: 0 });
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    expect(notifyPeople).toHaveBeenCalledWith("org-2", ["owner-1"], "day_ahead", { title: "Needs You: 2", body: "2 Holds Are Back", url: "/planner" });
    expect(reportError).toHaveBeenCalledWith("cron-day-ahead", boom, { orgId: "org-1" });
  });
});
