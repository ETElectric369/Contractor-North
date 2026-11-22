import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Row } from "@/test/fake-supabase";

/**
 * KEEP BOTH, AND THE JOB BEHIND IT, WITH THE RULES RUNNING FOR REAL (cn-v1168).
 *
 * Skeptic #71's blocker went through green because every job rule in keep-both.test.ts is a spy: the
 * first cut caught the job up through the acceptance door, whose take-off would have made the estimate
 * coming back a NEW materials list, and the newest list on a job is the one every reader shows, so
 * the crew's own list, bought marks and all, would have gone out of sight. Nothing ran the take-off,
 * so nothing saw it.
 *
 * Here keepBothEstimates is called on the duplex with NOTHING of the job's rules mocked: the figure
 * read (estimateLines), the task rule (syncJobTasks), the buy-list rule (syncJobMaterials) and the
 * billing guard's read all run against the stateful fake, and the tables are read back. What is
 * pinned is the outcome a person would look at: both estimates accepted, the job's tasks, its size,
 * its ONE list exactly as the crew left it, and the words about what is left to do. Names, numbers
 * and parts are stand-ins.
 */
const s = vi.hoisted(() => ({
  db: null as null | { sb: any; tables: Record<string, Record<string, any>[]>; inserted: Record<string, Record<string, any>[]> },
  reported: [] as { where: string; error: unknown }[],
}));
const sb = () => s.db!.sb;
const table = (name: string) => s.db!.tables[name] ?? [];
const quote = (id: string) => table("quotes").find((q) => q.id === id)!;
/** A task's status as the database would hold it: the birth's insert names none, and the column's default is open. */
const statusOf = (t: Record<string, any>) => t.status ?? "open";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => sb()), createServiceClient: vi.fn(() => sb()) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: sb(), userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string, error: unknown) => void s.reported.push({ where, error }) }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
// The guard's second read (which invoice holds a LINE) speaks PostgREST's overlaps, which the fake does
// not: no line here is on an invoice. Its first read (an invoice cut from the estimate) runs as it is.
vi.mock("@/lib/unbilled-work", async (importOriginal) => ({ ...(await importOriginal<object>()), claimedSourcesOnJob: vi.fn(async () => ({ owner: new Map() })) }));

const { keepBothEstimates } = await import("./actions");

const ORG = "org-1";
const WON = "2026-11-19T15:55:11.000Z";
const q = (over: Row): Row => ({
  org_id: ORG,
  revises_quote_id: null,
  job_id: "job-1",
  customer_id: "cust-1",
  title: "EV Charger Install",
  created_at: "2026-11-01T16:00:00.000Z",
  ...over,
});
/** A task line: four hours of it, a breaker and eleven feet of wire. */
const taskLine = (id: string, quote_id: string, description: string): Row => ({
  id,
  quote_id,
  org_id: ORG,
  description,
  quantity: 1,
  unit: "ea",
  unit_price: 733.84,
  sort_order: 0,
  detail: {
    task_id: `t-${id}`,
    hours: 4,
    rate: 100,
    units: null,
    kit_id: null,
    materials: [
      { code: "R1", name: "60 A breaker", qty: 1, cost: 40, sell: 50 },
      { code: "W9", name: "6/3 cable", qty: 11, cost: 4, sell: 5 },
    ],
  },
});
const plain = (id: string, quote_id: string): Row => ({ id, quote_id, org_id: ORG, description: "Permit fee", quantity: 1, unit: "ea", unit_price: 135.5, sort_order: 1, detail: null });
const row = (id: string, over: Row): Row => ({ id, list_id: "ml-1", org_id: ORG, part_number: null, quantity: 1, purchased: false, is_tool: false, vendor: "Northline Supply", est_cost: 1, unit: "ea", ...over });

/** The duplex as it stands after the customer accepted both: the second unit's quote was made with
 *  Revise, so its acceptance retired the first, took its task by name and adopted the crew's list. */
const duplex = (over: { taskStatus?: string; invoices?: Row[] } = {}) => {
  s.db = fakeDb({
    quotes: [
      q({ id: "unit-a", quote_number: "Q-0041", status: "superseded", accepted_at: WON }),
      q({ id: "unit-b", quote_number: "Q-0043", status: "accepted", accepted_at: "2026-11-19T15:55:53.000Z", revises_quote_id: "unit-a" }),
    ],
    quote_line_items: [taskLine("a1", "unit-a", "Unit A - EV Charger"), plain("a2", "unit-a"), taskLine("b1", "unit-b", "Unit B - EV Charger"), plain("b2", "unit-b")],
    jobs: [{ id: "job-1", org_id: ORG, planned_minutes: 240, dismissed_task_keys: [], description: "Two chargers" }],
    tasks: [{ id: "t-b", job_id: "job-1", org_id: ORG, source_key: "line:b1", title: "Unit B - EV Charger", status: over.taskStatus ?? "open", notes: null, photo_path: null, parent_id: null, planned_minutes: 240 }],
    material_lists: [{ id: "ml-1", org_id: ORG, job_id: "job-1", quote_id: "unit-b", name: "Materials — Q-0041", dismissed_keys: [] }],
    material_list_items: [
      row("r1", { source_key: "line:b1#R1", description: "60 A breaker", part_number: "R1", purchased: true, sort_order: 0 }),
      row("r2", { source_key: "line:b1#W9", description: "6/3 cable", part_number: "W9", quantity: 11, sort_order: 1 }),
      row("r3", { source_key: null, description: "Permit fee", sort_order: 2 }),
    ],
    price_list_items: [
      { org_id: ORG, code: "R1", description: "60 A breaker", supplier: "Northline Supply", buy_price: 40, unit: "ea", archived: false, price_list_item_options: [] },
      { org_id: ORG, code: "W9", description: "6/3 cable", supplier: "Northline Supply", buy_price: 4, unit: "ft", archived: false, price_list_item_options: [] },
    ],
    organizations: [{ id: ORG, settings: { default_markup_pct: 25 } }],
    profiles: [{ id: "office-1", org_id: ORG, language: "en" }],
    customers: [],
    invoices: over.invoices ?? [],
  });
  return JSON.parse(JSON.stringify({ lists: table("material_lists"), rows: table("material_list_items") })) as { lists: Row[]; rows: Row[] };
};
const PARTS_NOTE = "Q-0041's parts are not on the job's materials list. Add what it needs on the job's Materials tab.";

beforeEach(() => {
  s.reported = [];
});

describe("keepBothEstimates on the duplex, the job's own rules running", () => {
  it("both count, the first unit's task joins the job, the job is twice the size, and the crew's ONE list is exactly as they left it", async () => {
    const was = duplex();
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(s.reported).toEqual([]);
    // Both estimates stand, the day the first was won untouched.
    expect(quote("unit-a")).toMatchObject({ status: "accepted", accepted_at: WON });
    expect(quote("unit-b")).toMatchObject({ status: "accepted", revises_quote_id: null });
    // The job's tasks: the second unit's is the row it was, the first unit's is new and open, each four hours.
    expect(table("tasks").map((t) => [t.source_key, t.title, statusOf(t), t.planned_minutes]).sort()).toEqual([
      ["line:a1", "Unit A - EV Charger", "open", 240],
      ["line:b1", "Unit B - EV Charger", "open", 240],
    ]);
    expect(table("tasks").find((t) => t.source_key === "line:b1")!.id).toBe("t-b");
    // The size followed, because the box still held the figure read before anything was written.
    expect(table("jobs")[0].planned_minutes).toBe(480);
    // THE LIST. One, the one the crew has, row for row: nothing made, nothing taken, the bought mark kept.
    expect(table("material_lists")).toEqual(was.lists);
    expect(table("material_list_items")).toEqual(was.rows);
    expect(s.db!.inserted.material_lists).toBeUndefined();
    expect(s.db!.inserted.material_list_items).toBeUndefined();
    expect(s.db!.inserted.work_orders).toBeUndefined();
    expect(s.db!.inserted.jobs).toBeUndefined();
    // What it says, and the one thing left for a person.
    expect(res.said).toBe("Q-0043 stands on its own now. Q-0041 is accepted again. The job's list follows the estimate: 1 task added · the job's length is now 8 h.");
    expect(res.warning).toBe(PARTS_NOTE);
  });

  it("on a job with work already done, the done task stays the second unit's and that is said", async () => {
    duplex({ taskStatus: "done" });
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(table("tasks").map((t) => [t.source_key, statusOf(t)]).sort()).toEqual([
      ["line:a1", "open"],
      ["line:b1", "done"],
    ]);
    expect(res.warning).toBe(`${PARTS_NOTE} Tasks already done on the job stayed where they are. Q-0041's tasks are new and open: check off what is done.`);
  });

  it("an invoice already cut from the first unit is found by the billing guard's own read and named; both estimates still come to stand", async () => {
    // invoice_kind as the database always holds it (NOT NULL, default standard): the billing guard leaves a
    // payment request out by kind (cn-v1177), and a NULL kind fails that filter as it would in Postgres.
    duplex({ invoices: [{ id: "inv-1", org_id: ORG, invoice_number: "INV-0012", quote_id: "unit-a", job_id: "job-1", status: "sent", invoice_kind: "standard" }] });
    const res = await keepBothEstimates("unit-b");
    expect(res.ok).toBe(true);
    expect(quote("unit-a").status).toBe("accepted");
    expect(res.warning).toBe(`${PARTS_NOTE} Q-0041 is already billed on INV-0012, and Q-0043 can be billed beside it now. Bill Q-0043 only if it is separate work.`);
    // A void invoice bills nothing.
    duplex({ invoices: [{ id: "inv-1", org_id: ORG, invoice_number: "INV-0012", quote_id: "unit-a", job_id: "job-1", status: "void", invoice_kind: "standard" }] });
    expect((await keepBothEstimates("unit-b")).warning).toBe(PARTS_NOTE);
  });
});
