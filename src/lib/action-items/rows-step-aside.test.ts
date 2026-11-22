import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { CLOSE_OUT_FILTER, CLOSE_OUT_DRAWN, CLOSE_OUT_READ, DRAFTS_DRAWN, DRAFTS_READ, keptCount, localTimeOfDay } = await import("./query");

/**
 * A ROW LEAVES WHEN ITS REASON IS OVER, BY CERTAIN LINKS ONLY (cn-v1175, lane ROWS). The owner: "ones
 * that close out with the job should already be closed out right?" What the board's feeders read and
 * hand the one rules (lib/appointments/visit-settled, quote-settled), pinned in the source; the rules
 * themselves are table-tested beside them, and the close-out and write-up piles are driven in
 * answered-visit-leaves-close-out.test.
 */
const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

describe("the reads", () => {
  it("Visits to Close Out reads the work and the lead-less visits, wider than it draws (R7, R6)", () => {
    expect(CLOSE_OUT_FILTER).toBe("type.in.(job,service_call,final_inspection),and(inquiry_id.is.null,type.not.in.(inspection,quote))");
    const read = q.slice(q.indexOf("const apptP"), q.indexOf("const inspP"));
    expect(read).toContain("if (isStaff) q = q.or(CLOSE_OUT_FILTER);");
    expect(read).toContain("jobs:job_id(status)");
    expect(read).toContain(".limit(isStaff ? CLOSE_OUT_READ : CLOSE_OUT_DRAWN)");
    expect([CLOSE_OUT_READ, CLOSE_OUT_DRAWN]).toEqual([200, 50]);
  });

  it("Inspections to Write Up reads the sales visits and leaves out in the query what the rule settles (R6)", () => {
    const read = q.slice(q.indexOf("const inspP"), q.indexOf("const inspLeadJobsP"));
    expect(read).toContain('.in("type", [...SALES_VISIT_TYPES])');
    expect(read).toContain('.neq("status", "cancelled")');
    expect(read).toContain('.is("job_id", null)');
    expect(read).toContain('.or("outcome.is.null,outcome.eq.won")');
    expect(read).toContain("inquiries(name, converted_at)");
    // The jobs made from those leads: the rule's lead-closed arm.
    expect(q).toMatch(/const inspLeadJobsP[\s\S]*?\.from\("jobs"\)\.select\("inquiry_id, created_at"\)\.in\("inquiry_id", chunk\)/);
    expect(q).toContain("{ leadClosedAt },");
  });

  it("a day passed and a visit that happened are one pile (R7)", () => {
    expect(q).toContain("const toWriteUp = [...buckets.toWriteUp, ...buckets.missed]");
  });

  it("the drafts and the sent estimates carry their lead's answer; no other estimate is read for them (skeptic #78); a contract asks no lead (R3)", () => {
    expect(q).toContain('inquiry_id, jobs:job_id(status), quote_line_items(count), customer_name_snapshot:customers(name), inquiries(name, status)');
    expect(q).toContain("customer_id, inquiry_id, customers(name), jobs:job_id(status), inquiries(status)");
    // No sibling rule: Keep Both's restored offer and a draft for extra work stay on the board.
    expect(q).not.toContain('.eq("status", "accepted").or(');
    expect(q).not.toContain("acceptedSiblings");
    expect(q).toContain("quoteInvoices: namingInvoices.get(id) ?? [],\n      lead,\n    });");
    expect(q).toMatch(/settledOf\(\{ id: `contract-\$\{cont\.id\}`[^\n]*\}, false\)\.settled/);
    expect(q).toContain(".limit(DRAFTS_READ)");
    expect([DRAFTS_READ, DRAFTS_DRAWN]).toEqual([150, 50]);
  });

  it("a job whose sale went away stops asking for a day; a failed read settles nothing (R3)", () => {
    expect(q).toContain('supabase.from("quotes").select("job_id, status").in("job_id", ids)');
    // cn-v1178 (E4): the kind and what was paid ride along, so an unpaid request is not money on the job.
    expect(q).toContain('supabase.from("invoices").select("job_id, invoice_kind, amount_paid").in("job_id", ids).neq("status", "void")');
    expect(q).toContain("((saleInvR.data ?? []) as any[]).filter(saleHasMoney)");
    expect(q).toContain("if (saleQuotesR.error || saleInvR.error) reportError(");
    expect(q).toContain("jobs: needDayPre.map((f) => f.job).filter((j) => !wentAway.has(String(j.id))),");
  });
});

describe("keptCount: a pile counts what it keeps, never rows nobody will see (R6)", () => {
  it.each([
    ["every candidate read, fewer kept than drawn", { data: new Array(30), count: 30 }, 10, 50, {}],
    ["every candidate read, more kept than drawn: the true number", { data: new Array(120), count: 120 }, 80, 50, { total: 80 }],
    ["the read did not bring every candidate: a floor", { data: new Array(200), count: 260 }, 80, 50, { capped: true }],
    ["no count: by what it kept", { data: new Array(10) }, 10, 50, {}],
  ] as const)("%s", (_n, r, kept, drawn, want) => {
    expect(keptCount(r as any, kept, drawn)).toEqual(want);
  });
});

describe("Move to Another Day keeps the time of day (R7)", () => {
  it("the visit's time in the company's zone, HH:mm; nothing for no day", () => {
    expect(localTimeOfDay("2026-11-20T17:30:00Z", "America/Los_Angeles")).toBe("09:30");
    expect(localTimeOfDay("2026-11-20T17:30:00Z", "UTC")).toBe("17:30");
    expect(localTimeOfDay(null, "UTC")).toBeNull();
    expect(localTimeOfDay("not a day", "UTC")).toBeNull();
  });
});
