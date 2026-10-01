import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE REGISTRY ACTIONS NEEDS YOU'S ROWS RUN (Wave 1, lane 5): a hold's Snooze and Take Off Hold, a
 * draft's Set Aside Until…, an endless row's Snooze, and Nort's job.setStatus putting a job ON HOLD
 * through the hold (its reason and its day), refusing in words with no reason, as it always has.
 */
const m = vi.hoisted(() => ({
  setJobHold: vi.fn(async () => ({ ok: true })),
  snoozeJobHold: vi.fn(async () => ({ ok: true })),
  setJobStatus: vi.fn(async () => ({ ok: true })),
  parkInvoice: vi.fn(async () => ({ ok: true })),
  saveNeedsYouWait: vi.fn(async () => ({ ok: true })),
  savedReason: null as string | null,
  jobExists: true,
  invoiceJob: null as { job_number: string; name: string; status: string } | null,
}));

vi.mock("@/app/(app)/schedule/actions", () => ({
  setJobHold: m.setJobHold,
  snoozeJobHold: m.snoozeJobHold,
  scheduleJobWindow: vi.fn(),
  setJobCrew: vi.fn(),
  createJob: vi.fn(),
  moveJobDay: vi.fn(),
  createScheduleProposal: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/actions", () => ({ setJobStatus: m.setJobStatus, finishJob: vi.fn(), updateJobDescription: vi.fn(), createInvoiceForJob: vi.fn() }));
vi.mock("@/app/(app)/billing/actions", async (orig) => ({ ...(await orig<object>()), parkInvoice: m.parkInvoice }));
vi.mock("@/lib/org-local-time", async (orig) => ({ ...(await orig<object>()), orgTimezone: async () => "America/Los_Angeles" }));
vi.mock("@/lib/action-items/needs-you-waits", async (orig) => ({ ...(await orig<object>()), saveNeedsYouWait: m.saveNeedsYouWait }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: m.jobExists ? { id: "11111111-1111-4111-8111-111111111111", hold_reason: m.savedReason, jobs: m.invoiceJob } : null, error: null }),
      };
      return q;
    },
  }),
}));

import { jobActions } from "@/lib/actions/entities/job";
import { invoiceActions } from "@/lib/actions/entities/invoice";
import { todayStrInTz } from "@/lib/tz";

const JOB = "11111111-1111-4111-8111-111111111111";
const ctx = { userId: "u1", orgId: "org-1", role: "owner" };
const later = (days: number) => {
  const t = new Date(`${todayStrInTz("America/Los_Angeles")}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

beforeEach(() => {
  for (const f of [m.setJobHold, m.snoozeJobHold, m.setJobStatus, m.parkInvoice, m.saveNeedsYouWait]) f.mockClear();
  m.savedReason = null;
  m.jobExists = true;
  m.invoiceJob = null;
});

describe("job.setStatus puts a job on hold through the hold", () => {
  const run = (i: Record<string, unknown>) => jobActions["job.setStatus"].handler(jobActions["job.setStatus"].input.parse(i), ctx);

  it("with a reason and a day: setJobHold, the day as a date", async () => {
    await run({ id: JOB, status: "on_hold", reason: "Waiting on the permit", until: "2026-10-03" });
    expect(m.setJobHold).toHaveBeenCalledWith(JOB, "Waiting on the permit", { date: "2026-10-03" });
    expect(m.setJobStatus).not.toHaveBeenCalled();
  });

  it("with a reason and no day: setJobHold (the database gives it a week)", async () => {
    await run({ id: JOB, status: "on_hold", reason: "Customer traveling" });
    expect(m.setJobHold).toHaveBeenCalledWith(JOB, "Customer traveling", null);
  });

  it("no reason: as always, the saved one stands, or the plain write refuses in words", async () => {
    await run({ id: JOB, status: "on_hold" });
    expect(m.setJobStatus).toHaveBeenCalledWith(JOB, "on_hold");
    // A day but no reason: the saved reason carries the day; none saved, the refusal.
    m.savedReason = "Waiting on the utility";
    await run({ id: JOB, status: "on_hold", until: "2026-10-03" });
    expect(m.setJobHold).toHaveBeenLastCalledWith(JOB, "Waiting on the utility", { date: "2026-10-03" });
    m.savedReason = null;
    m.setJobStatus.mockClear();
    await run({ id: JOB, status: "on_hold", until: "2026-10-03" });
    expect(m.setJobStatus).toHaveBeenCalledWith(JOB, "on_hold");
  });

  it("any other status is the plain status write", async () => {
    await run({ id: JOB, status: "cancelled" });
    expect(m.setJobStatus).toHaveBeenCalledWith(JOB, "cancelled");
    expect(m.setJobHold).not.toHaveBeenCalled();
  });

  it("a day that isn't a calendar day never reaches the database", () => {
    expect(jobActions["job.setStatus"].input.safeParse({ id: JOB, status: "on_hold", reason: "x", until: "Monday" }).success).toBe(false);
  });
});

/**
 * NORT HAS ONE FINISH TOOL, NOT TWO (M2).
 *
 * "Mark the Tao job complete" could reach either job.finish — which bills the unbilled work into a
 * draft and asks Erik to confirm first — or job.setStatus {status: complete}, which wrote the word
 * alone and asked nobody. Same words, two consequences, and the cheap one is how Tao's 19.5 hours
 * went unbilled. job.setStatus now points at the one door instead, in words Nort can act on.
 */
describe("job.setStatus is not a second way to finish a job", () => {
  const run = (i: Record<string, unknown>) => jobActions["job.setStatus"].handler(jobActions["job.setStatus"].input.parse(i), ctx);

  it("complete is refused in words that name the one finish tool, and NOTHING is written", async () => {
    const r = await run({ id: JOB, status: "complete" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("job.finish");
    expect(r.error).toMatch(/bills its work first/);
    expect(m.setJobStatus).not.toHaveBeenCalled();
    expect(m.setJobHold).not.toHaveBeenCalled();
  });

  it("the tool stops offering complete, and says where finishing lives", () => {
    const d = jobActions["job.setStatus"].description;
    expect(d).not.toMatch(/to_be_scheduled, scheduled, in_progress, on_hold, complete, cancelled/);
    expect(d).toContain("job.finish");
  });

  it("finishing is still a confirmed, financial move — the thing a bare status write skipped", () => {
    expect(jobActions["job.finish"].confirm).toBe("financial");
    expect(jobActions["job.setStatus"].confirm).toBeUndefined();
  });
});

describe("a hold's two answers", () => {
  it("job.snoozeHold moves the day (the reason only when none is saved)", async () => {
    await jobActions["job.snoozeHold"].handler({ id: JOB, date: "2026-10-03", reason: "Waiting on the permit" }, ctx);
    expect(m.snoozeJobHold).toHaveBeenCalledWith(JOB, { date: "2026-10-03" }, "Waiting on the permit");
  });

  it("job.takeOffHold is setJobHold(id, null): back to scheduled or to be scheduled by its date", async () => {
    await jobActions["job.takeOffHold"].handler({ id: JOB }, ctx);
    expect(m.setJobHold).toHaveBeenCalledWith(JOB, null);
  });

  it("both are the office's writes, never a tech's", () => {
    for (const n of ["job.snoozeHold", "job.takeOffHold", "job.snoozeNeedsYou"]) {
      expect(jobActions[n].auth, n).toBe("staff");
      expect(jobActions[n].effect, n).toBe("write");
    }
    expect(invoiceActions["invoice.setAside"].auth).toBe("staff");
  });
});

describe("invoice.setAside", () => {
  it("parks a draft until a day today or later, with its reason, and says the day back", async () => {
    const day = later(6);
    const r = await invoiceActions["invoice.setAside"].handler({ id: "inv-1", date: day, reason: " Waiting on the change order " }, ctx);
    expect(m.parkInvoice).toHaveBeenCalledWith("inv-1", day, "Waiting on the change order");
    expect(r.ok).toBe(true);
    expect(r.speak).toMatch(/^Set aside until [A-Z][a-z]{2} \d{1,2}\. It comes back to Needs You that day\.$/);
  });

  it("a day already gone is refused in words, and nothing is parked", async () => {
    const r = await invoiceActions["invoice.setAside"].handler({ id: "inv-1", date: "2020-01-01" }, ctx);
    expect(r).toEqual({ ok: false, error: "Pick today or later" });
    expect(m.parkInvoice).not.toHaveBeenCalled();
  });

  it("a draft whose job is finished or cancelled is refused in words: it waits on nothing, so no day is written and no 'comes back' is said", async () => {
    m.invoiceJob = { job_number: "J-011", name: "Herringbone", status: "complete" };
    const r = await invoiceActions["invoice.setAside"].handler({ id: "inv-78", date: later(20) }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Herringbone · J-011 is finished, so this draft has nothing left to wait for and stays on Needs You. Send it, or void it if it won't be billed.");
    expect(r.speak).toBeUndefined();
    m.invoiceJob = { job_number: "J-011", name: "Herringbone", status: "cancelled" };
    expect((await invoiceActions["invoice.setAside"].handler({ id: "inv-78", date: later(20) }, ctx)).error).toMatch(/^Herringbone · J-011 is cancelled,/);
    expect(m.parkInvoice).not.toHaveBeenCalled();
    // A job still going: parked as before.
    m.invoiceJob = { job_number: "J-011", name: "Herringbone", status: "in_progress" };
    expect((await invoiceActions["invoice.setAside"].handler({ id: "inv-78", date: later(20) }, ctx)).ok).toBe(true);
    expect(m.parkInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("job.snoozeNeedsYou (an endless row)", () => {
  it("keeps the day under the row's key, for this company, from the company's today", async () => {
    await jobActions["job.snoozeNeedsYou"].handler({ id: JOB, kind: "materials_needed", date: "2026-10-03", reason: "Back-ordered" }, ctx);
    expect(m.saveNeedsYouWait).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      userId: "u1",
      key: `materials_needed:${JOB}`,
      date: "2026-10-03",
      reason: "Back-ordered",
      todayStr: todayStrInTz("America/Los_Angeles"),
    });
  });

  it("a job this person can't see is refused, and nothing is kept", async () => {
    m.jobExists = false;
    const r = await jobActions["job.snoozeNeedsYou"].handler({ id: JOB, kind: "job_unbilled_work", date: "2026-10-03" }, ctx);
    expect(r).toEqual({ ok: false, error: "That job isn't available." });
    expect(m.saveNeedsYouWait).not.toHaveBeenCalled();
  });

  it("only the endless kinds", () => {
    expect(jobActions["job.snoozeNeedsYou"].input.safeParse({ id: JOB, kind: "invoice_overdue", date: "2026-10-03" }).success).toBe(false);
  });
});
