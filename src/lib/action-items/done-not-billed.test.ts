import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DONE_NOT_BILLED_RPC,
  DONE_UNREAD_ITEM,
  doneRowItems,
  doneRowsCount,
  isMissingDoneRpc,
  legacyDoneItems,
  type DoneRow,
} from "./done-not-billed";
import { isUnreadLine, pileOf } from "./piles";

/**
 * DONE, NOT BILLED, READ WHOLE (W1-FU-misc A, 0371). The function decides which finished work has no
 * bill (in SQL, over every row since the floors, oldest first, with its true count); the build keeps
 * only the two rules that depend on other rows. Row ids, chips, hrefs and words are exactly the old
 * ones. The database half is lib/done-not-billed.integration.test.ts.
 */
const none = { overdueEmitted: new Set<string>(), draftOnNowJobs: new Set<string>() };
const visit = (o: Partial<DoneRow> = {}): DoneRow => ({
  src: "visit",
  id: "a1",
  job_id: null,
  title: "Hot tub circuit",
  job_number: null,
  job_name: null,
  customer_name: "Rita Moss",
  at: "2026-07-02T17:00:00+00:00",
  open_invoice_id: null,
  total_count: 1,
  ...o,
});
const job = (o: Partial<DoneRow> = {}): DoneRow => ({
  src: "job",
  id: "j11",
  job_id: "j11",
  title: null,
  job_number: "J-011",
  job_name: "13897 Honeysuckle",
  customer_name: "Andrew Crake",
  at: "2026-09-20T16:00:00+00:00",
  open_invoice_id: null,
  total_count: 1,
  ...o,
});

describe("the function's rows as Needs You rows: the same ids, chips, hrefs and words as before", () => {
  it("a visit with no bill: Bill It on its job's Invoices tab, or on the visit when it has no job", () => {
    const [free] = doneRowItems([visit()], none);
    expect(free).toMatchObject({
      id: "unbilled-a1",
      kind: "visit_unbilled",
      title: "Hot tub circuit",
      subtitle: "Rita Moss",
      when: "2026-07-02T17:00:00+00:00",
      urgency: 1,
      href: "/appointments/a1",
      affordances: ["dismiss", "open"],
    });
    expect(free.chip).toBeUndefined();
    expect(doneRowItems([visit({ job_id: "j9" })], none)[0].href).toBe("/jobs/j9?tab=invoices");
    // A visit with no title is "Work done".
    expect(doneRowItems([visit({ title: "" })], none)[0].title).toBe("Work done");
  });

  it("a visit billed and waiting on the money: Billed, Not Paid, and Get Paid on its invoice", () => {
    const [billed] = doneRowItems([visit({ open_invoice_id: "inv-7", job_id: "j9" })], none);
    expect(billed).toMatchObject({ chip: "Billed, Not Paid", href: "/billing/inv-7" });
  });

  it("one balance, one row: a visit whose open invoice is already a Late Invoices row is left to that row", () => {
    const seen = { overdueEmitted: new Set(["inv-7"]), draftOnNowJobs: new Set<string>() };
    expect(doneRowItems([visit({ open_invoice_id: "inv-7" })], seen)).toEqual([]);
  });

  it("a finished job with no real invoice: its name first, the number second, Bill It on its Invoices tab", () => {
    expect(doneRowItems([job()], none)).toEqual([
      {
        id: "jdone-j11",
        kind: "visit_unbilled",
        title: "13897 Honeysuckle · J-011",
        subtitle: "Andrew Crake",
        who: null,
        when: "2026-09-20T16:00:00+00:00",
        urgency: 1,
        done: false,
        href: "/jobs/j11?tab=invoices",
        affordances: ["dismiss", "open"],
      },
    ]);
  });

  it("one fact, one row: a finished job whose bill is a draft on Now is that draft's row", () => {
    const seen = { overdueEmitted: new Set<string>(), draftOnNowJobs: new Set(["j11"]) };
    expect(doneRowItems([job()], seen)).toEqual([]);
  });

  it("the same answer as today's rules, row for row, for the same records", () => {
    // Today's reads, as PostgREST returned them, and the anchored invoices and billed jobs.
    const doneWork = [
      { id: "a1", title: "Hot tub circuit", starts_at: "2026-07-02T17:00:00+00:00", job_id: null, customers: { name: "Rita Moss" }, inquiries: null },
      { id: "a2", title: "Panel swap", starts_at: "2026-07-03T17:00:00+00:00", job_id: "j9", customers: null, inquiries: { name: "Sam Lee" } },
      { id: "a3", title: "Paid visit", starts_at: "2026-07-04T17:00:00+00:00", job_id: null, customers: null, inquiries: null },
      { id: "a4", title: "Billed job day", starts_at: "2026-07-05T17:00:00+00:00", job_id: "j-billed", customers: null, inquiries: null },
    ];
    const doneJobs = [
      { id: "j11", job_number: "J-011", name: "13897 Honeysuckle", updated_at: "2026-09-20T16:00:00+00:00", customers: { name: "Andrew Crake" } },
      { id: "j-billed", job_number: "J-012", name: "9 Pine", updated_at: "2026-09-21T16:00:00+00:00", customers: null },
    ];
    const settled = [
      { id: "inv-2", appointment_id: "a2", amount_paid: 0 },
      { id: "inv-3", appointment_id: "a3", amount_paid: 150 },
    ];
    const old = legacyDoneItems({ doneWork, doneJobs, settled, billedJobs: new Set(["j-billed"]), seen: none });
    // What the function hands back for the same records: the unbilled ones, oldest first.
    const rows: DoneRow[] = [
      visit({ id: "a1", title: "Hot tub circuit", customer_name: "Rita Moss", at: "2026-07-02T17:00:00+00:00", total_count: 3 }),
      visit({ id: "a2", title: "Panel swap", job_id: "j9", customer_name: "Sam Lee", at: "2026-07-03T17:00:00+00:00", open_invoice_id: "inv-2", total_count: 3 }),
      job({ total_count: 3 }),
    ];
    const byId = (xs: { id: string }[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(doneRowItems(rows, none))).toEqual(byId(old));
    expect(old.map((i) => i.id).sort()).toEqual(["jdone-j11", "unbilled-a1", "unbilled-a2"]);
  });
});

describe("the pile's count and the read's failures", () => {
  it("'N+' only when the function counted more than it handed back", () => {
    expect(doneRowsCount([visit({ total_count: 1 })])).toEqual({});
    expect(doneRowsCount([visit({ total_count: 201 })])).toEqual({ capped: true });
    expect(doneRowsCount([visit({ total_count: "201" })])).toEqual({ capped: true }); // bigint as text
    expect(doneRowsCount([])).toEqual({});
  });

  it("only the function missing (0371 not applied) falls back to the old reads", () => {
    expect(isMissingDoneRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingDoneRpc({ code: "42883" })).toBe(true);
    for (const e of [{ code: "42501" }, { code: "57014" }, { message: "boom" }, null]) expect(isMissingDoneRpc(e)).toBe(false);
  });

  it("any other failure is one Couldn't Check line, never a pile and never a quiet zero", () => {
    expect(DONE_UNREAD_ITEM.title).toBe("Done, Not Billed · Couldn't Check");
    expect(isUnreadLine(DONE_UNREAD_ITEM)).toBe(true);
    expect(pileOf(DONE_UNREAD_ITEM)).toBeNull();
    expect(DONE_UNREAD_ITEM.affordances).toEqual(["open"]);
  });
});

describe("query.ts reads it once, on the same floors, and keeps the rest", () => {
  const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

  it("one read: the function, on the org's midnight of the same two floors (visits 60, jobs 30)", () => {
    expect(DONE_NOT_BILLED_RPC).toBe("needs_you_done_not_billed");
    expect(q).toContain("Promise.all([floor(60), floor(30)]).then(async ([visitFrom, jobFrom]): Promise<DoneRead> => {");
    expect(q).toContain("supabase.rpc(DONE_NOT_BILLED_RPC, { p_visit_from: dayStartIso(visitFrom), p_job_from: dayStartIso(jobFrom) })");
    expect(q).toContain("if (!isMissingDoneRpc(r.error)) {");
    expect(q).toContain("counts.done_not_billed = doneRowsCount(doneR.rows);");
    expect(q).toContain("items.push(DONE_UNREAD_ITEM);");
    // Told once, not on every page's badge.
    expect(q).toContain("if (!doneRpcMissingSaid) {");
  });

  it("the anchored-invoice read runs only for the deploy window's old reads", () => {
    expect(q).toContain('const doneVisitIds = doneR.mode === "legacy" ?');
  });

  it("an untitled visit falls back to its TYPE'S LABEL, never to a word typed in here", () => {
    // Both feeders off this table: the write-up row and the not-closed-out row. A literal here is
    // what made My Day disagree with every other screen the day the word changed (visit-word.test).
    expect(q).toContain("title: a.title || appointmentTypeLabel(a.type),");
    expect(q).toContain('title: a.title || type || "Appointment",');
    expect(q).not.toContain('"Site inspection"');
  });
});
