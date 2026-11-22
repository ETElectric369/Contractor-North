import { describe, expect, it } from "vitest";
import { isSalesVisit, isWorkVisit, leadClosedAtFrom, visitSettled, type VisitLinks } from "./visit-settled";
import { bucketInspections } from "@/lib/inspections";
import { visitStands } from "@/lib/leads/new-intake";

/**
 * THE ONE VISIT RULE (cn-v1175, R1): every arm, the guard that only a visit dated BEFORE its lead closed
 * is settled by it, the win with no job (R8), and the three readers agreeing on one fixture. Made-up
 * records only.
 */

const DAY = "2026-11-10T18:00:00Z";
const v = (over: Record<string, unknown> = {}) => ({ type: "inspection", starts_at: DAY, inquiry_id: null, job_id: null, capture: null, outcome: null, ...over }) as Parameters<typeof visitSettled>[0];
const set = (...ids: string[]) => new Set(ids);

describe("visitSettled: the table", () => {
  const LINKS: VisitLinks = {
    estimateInquiryIds: set("lead-est"),
    estimateJobIds: set("job-est"),
    estimateQuoteIds: set("q-1"),
    billedJobIds: set("job-deposit", "job-billed"),
    finishedJobIds: set("job-billed"),
    closedJobIds: set("job-done"),
    leadClosedAt: new Map([["lead-won", "2026-11-12T18:00:00Z"]]),
  };
  const cases: [string, Record<string, unknown>, string | null][] = [
    ["nothing settles it", {}, null],
    ["answered Not Sold", { outcome: "lost" }, "answered"],
    ["answered with the old no_bid", { outcome: "no_bid" }, "answered"],
    ["won WITH its job", { outcome: "won", job_id: "job-x" }, "answered"],
    ["won with NO job is not an ending (R8)", { outcome: "won" }, null],
    ["an estimate for its lead (A1)", { inquiry_id: "lead-est" }, "estimate"],
    ["an estimate for its job (A1)", { job_id: "job-est", type: "quote" }, "estimate"],
    ["an estimate written from it (A1, the capture)", { capture: { quote_id: "q-1" } }, "estimate"],
    ["a capture whose estimate is gone", { capture: { quote_id: "q-gone" } }, null],
    ["its lead closed AFTER it (A2/B1)", { inquiry_id: "lead-won" }, "lead-closed"],
    ["its lead closed BEFORE it: an add-on bid keeps asking", { inquiry_id: "lead-won", starts_at: "2026-11-13T18:00:00Z" }, null],
    ["a visit with no day is never 'before'", { inquiry_id: "lead-won", starts_at: null }, null],
    ["a sales visit tied to a job", { job_id: "job-open" }, "on-a-job"],
    ["a sales visit on a job with a deposit (any real bill)", { job_id: "job-deposit" }, "job-over"],
    ["a job day on a closed job (A3)", { type: "job", job_id: "job-done" }, "job-over"],
    ["a service call on a finished-billed job (A3)", { type: "service_call", job_id: "job-billed" }, "job-over"],
    ["a job day on a job with only a deposit still asks", { type: "job", job_id: "job-deposit" }, null],
    ["a job day on a job still going still asks", { type: "job", job_id: "job-open" }, null],
    ["the city's final inspection on a closed job (A3)", { type: "final_inspection", job_id: "job-done" }, "job-over"],
    ["a work visit is never settled by its job's estimate or its lead", { type: "job", job_id: "job-est", inquiry_id: "lead-won" }, null],
    ["a call is settled only by an answer or its job being over", { type: "call", inquiry_id: "lead-est", job_id: "job-open" }, null],
    ["a call on a closed job", { type: "call", job_id: "job-done" }, "job-over"],
  ];
  for (const [name, over, why] of cases) it(name, () => expect(visitSettled(v(over), LINKS)).toBe(why));

  it("no links read: only an answer, or a sales visit's own job", () => {
    expect(visitSettled(v({ inquiry_id: "lead-est" }))).toBeNull();
    expect(visitSettled(v({ job_id: "job-x" }))).toBe("on-a-job");
    expect(visitSettled(v({ type: "job", job_id: "job-x" }))).toBeNull();
  });

  it("the kinds: sales is an inspection or an estimate visit; work is a job day, a service call, the city's", () => {
    expect(["inspection", "quote", null].map(isSalesVisit)).toEqual([true, true, true]);
    expect(["call", "meeting", "other", "job", "final_inspection"].map(isSalesVisit)).toEqual([false, false, false, false, false]);
    expect(["job", "service_call", "final_inspection"].map(isWorkVisit)).toEqual([true, true, true]);
    expect(["inspection", "call", null].map(isWorkVisit)).toEqual([false, false, false]);
  });

  it("when a lead closed: the earliest of its own stamp and the first job made from it", () => {
    const m = leadClosedAtFrom(
      [{ id: "l1", converted_at: "2026-11-15T00:00:00Z" }, { id: "l2", converted_at: null }],
      [{ inquiry_id: "l1", created_at: "2026-11-12T00:00:00Z" }, { inquiry_id: "l2", created_at: "2026-11-20T00:00:00Z" }, { inquiry_id: "l3", created_at: "nope" }],
    );
    expect(Object.fromEntries(m)).toEqual({ l1: "2026-11-12T00:00:00Z", l2: "2026-11-20T00:00:00Z" });
  });
});

describe("the three readers agree on one fixture (R1)", () => {
  const NOW = new Date("2026-11-20T18:00:00Z");
  // Each visit happened (completed) for a lead; what settles it is one link.
  const rows = [
    { id: "open", status: "completed", starts_at: DAY, inquiry_id: "l-open", job_id: null, outcome: null, type: "inspection" },
    { id: "answered", status: "completed", starts_at: DAY, inquiry_id: "l-ans", job_id: null, outcome: "lost", type: "inspection" },
    { id: "on-job", status: "completed", starts_at: DAY, inquiry_id: "l-job", job_id: "job-1", outcome: null, type: "inspection" },
    { id: "won-no-job", status: "completed", starts_at: DAY, inquiry_id: "l-won", job_id: null, outcome: "won", type: "inspection" },
  ];
  it("the write-up bucket, the close-out rule and the lead's standing say the same of each", () => {
    const b = bucketInspections(rows, new Set(), new Set(), NOW);
    const openOnList = new Set(b.toWriteUp.map((r) => r.id));
    for (const r of rows) {
      const settled = visitSettled(r) !== null;
      expect(openOnList.has(r.id), r.id).toBe(!settled);
      // A sales visit that happened keeps its lead off the Leads list exactly while it is open.
      expect(visitStands(r, NOW.getTime()), r.id).toBe(!settled);
    }
    expect([...openOnList].sort()).toEqual(["open", "won-no-job"]);
  });
});
