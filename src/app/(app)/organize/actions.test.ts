import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A RECEIPT A LIVE INVOICE BILLS CANNOT VANISH — the Organize half (0278).
 *
 * The audit of cn-v951..v966 found the materials twin of 0261's "billed hours cannot vanish".
 * Three doors deleted a bill with no claim read and no result check; two of them are in this
 * file. Migration 0278 put the ceiling in (guard_billed_bill, a BEFORE DELETE trigger on bills
 * that refuses while a non-void invoice_items.source_ids names the row), and these tests pin the
 * app side of it: the teardown is CHECKED, the bill goes FIRST so a refusal costs nothing, and
 * the refusal is said in words that match the button that was tapped.
 *
 * The fixture is Erik's real row, straight out of the live database on 2026-09-20:
 * organized_items bf638150 -> bills c0535cdb, "Contractors Electrical Distributors", $467.87 on
 * J-046, claimed by eight lines of INV-069, which Jason has already part paid. 26 of the 30
 * receipts in his Organize archive are in the same state, so this is not a hypothetical.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
// Organize's own job guard (audit v994 TL2) answers yes here unless a test says otherwise, so the
// scripted jobs reads below stay the ones the filing itself makes.
const jobGuard = vi.hoisted(() => ({ jobInOrg: vi.fn(async (_s: unknown, _o: unknown, id: unknown) => !!id) }));
vi.mock("@/lib/job-in-org", () => jobGuard);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The receipt reader's outside world. None of it is what these tests are about — they are about
// what happens to the row AFTER the bill lands — so it is all pinned to one boring answer.
const ai = vi.hoisted(() => {
  const clean = () => ({
    vendor: "Contractors Electrical Distributors",
    amount: 467.87,
    date: "2026-09-15",
    line_items: [{ description: "1/2 in EMT", quantity: 1, unit_price: 467.87, amount: 467.87, category: "Materials" }],
    payment: "on_account",
    confidence: "high",
  });
  return { clean, parsed: clean() as any };
});
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({ messages: { create: async () => ({ model: "test-model", content: [{ type: "text", text: "{}" }], usage: {} }) } }),
}));
vi.mock("@/lib/ai-json", () => ({ parseAiJson: async () => ai.parsed }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model" }));
vi.mock("@/lib/analytics/job-profitability", () => ({ listJobScopes: async () => [] }));
const reported = vi.hoisted(() => ({ calls: [] as { where: string }[] }));
vi.mock("@/lib/observe", () => ({
  reportError: (where: string) => {
    reported.calls.push({ where });
  },
}));

import { fileItem, deleteOrganizedItem, billJobReceipt } from "./actions";

/** The exact sentence guard_billed_bill raises (0278), as PostgREST hands it back. */
const GUARD = {
  code: "P0001",
  message:
    "INV-069 already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt.",
};

/** The live row. `select("*")` hands the action the whole thing, so the fake does too. */
const WALDOW_RECEIPT = {
  id: "bf638150-21c9-4290-ae0f-d6608c31d331",
  kind: "receipt",
  status: "needs_review",
  title: "Contractors Electrical Distributors — $467.87",
  vendor: "Contractors Electrical Distributors",
  amount: 467.87,
  item_date: "2026-09-15",
  category: "Receipt",
  payment: "on_account",
  job_id: "job-046",
  document_id: "doc-1",
  bill_id: "c0535cdb-e485-4679-8e56-fd0918fd728b",
  petty_cash_id: null,
  file_url: "org-1/receipts/ced-467.jpg",
  line_items: [{ description: "1/2 in EMT", quantity: 10, unit_price: 4.5, amount: 45, category: "Materials" }],
};

type Call = { table: string; verb: string; payload?: any; selected?: boolean };

/** Minimal scriptable PostgREST-builder fake (the purchasing/actions.test.ts pattern), plus a
 *  storage stub and a `selected` flag — the silent-write law is a claim about whether
 *  `.select("id")` was actually chained onto the write, so the test has to be able to see it. */
function fakeSupabase(
  script: Record<string, any[]>,
  calls: Call[],
  storage: { removed: string[][]; error?: any } = { removed: [] },
) {
  const next = (key: string) => {
    const q = script[key];
    // What stands on a document (the customer's page, a panel's photo) is nothing unless a test
    // says otherwise.
    if ((!q || q.length === 0) && (key === "job_shared_documents.select" || key === "job_panels.select")) return { data: [], error: null };
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          storage.removed.push(paths);
          return { data: null, error: storage.error ?? null };
        },
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null }),
      }),
    },
    from(table: string) {
      let verb = "select";
      let mine: Call | null = null;
      const chain: any = {
        insert(payload: any) { verb = "insert"; mine = { table, verb, payload }; calls.push(mine); return chain; },
        update(payload: any) { verb = "update"; mine = { table, verb, payload }; calls.push(mine); return chain; },
        delete() { verb = "delete"; mine = { table, verb }; calls.push(mine); return chain; },
        select() {
          if (verb === "select") { mine = { table, verb }; calls.push(mine); }
          else if (mine) mine.selected = true;
          return chain;
        },
        eq() { return chain; },
        order() { return chain; },
        not() { return chain; },
        limit() { return chain; },
        is() { return chain; },
        neq() { return chain; },
        in() { return chain; },
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
beforeEach(() => {
  calls = [];
  reported.calls = [];
  ai.parsed = ai.clean();
});

const did = (table: string, verb: string) => calls.find((c) => c.table === table && c.verb === verb);

/**
 * THE READS A TEARDOWN MAKES BEFORE IT DELETES ANYTHING (audit v994, TD1-TD3): the bill as a person
 * left it, the copies set aside against it, the papers tied to it, then the document the row points
 * at. Appended after the script's own entries, in the order the teardown asks.
 */
function withTeardownReads(
  script: Record<string, any[]>,
  o: { bill?: any; copies?: any[]; tied?: any[]; doc?: any; noBill?: boolean } = {},
): Record<string, any[]> {
  const add = (k: string, ...v: any[]) => {
    script[k] = [...(script[k] ?? []), ...v];
  };
  if (!o.noBill) {
    add(
      "bills.select",
      { data: o.bill === undefined ? { id: WALDOW_RECEIPT.bill_id, amount: 467.87, on_shelf: false, bill_line_items: [] } : o.bill, error: null },
      { data: o.copies ?? [], error: null },
    );
    add("organized_items.select", { data: o.tied ?? [], error: null });
  }
  add("documents.select", { data: o.doc === undefined ? { id: "doc-1", created_at: "2026-09-15T12:00:00Z", file_url: WALDOW_RECEIPT.file_url } : o.doc, error: null });
  return script;
}

describe("fileItem — re-filing a receipt an invoice already bills", () => {
  it("refuses the whole move, names INV-069, and tells him what to do about it", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    // The invoice number is the DATABASE'S, never re-looked-up or guessed.
    expect(res.error).toContain("INV-069 already bills this receipt.");
    // The tail belongs to THIS door: he tapped a job name, not the trash.
    expect(res.error).toContain("file this again");
    expect(res.error).not.toContain("delete this receipt");
    expect(res.error).toContain("Nothing was moved.");
  });

  it("leaves the old filing completely standing — nothing torn down, no second bill built", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });

    // The bill goes first precisely so "Nothing was moved" is a fact.
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("petty_cash", "delete")).toBeUndefined();
    // THE MONEY BUG: the replacement bill would carry a new id no claim covers, so
    // importCostsIntoInvoice bills the same $467.87 purchase to a second customer.
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("documents", "insert")).toBeUndefined();
    // The only writes to the row are this press's claim and its release: it ends where it began.
    const rowWrites = calls.filter((c) => c.table === "organized_items" && c.verb === "update").map((c) => c.payload);
    expect(rowWrites).toEqual([{ status: "filed" }, { status: "needs_review" }]);
  });

  it("asks for the row back (.select('id')) so an RLS refusal can never read as a 204", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(did("bills", "delete")?.selected).toBe(true);
  });

  it("an unclaimed receipt still moves: bill torn down, new one built on the new job", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WALDOW_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res).toEqual({ ok: true });
    expect(did("bills", "insert")?.payload).toMatchObject({ job_id: "job-047", amount: 467.87 });
    const rowWrites = calls.filter((c) => c.table === "organized_items" && c.verb === "update");
    expect(rowWrites[rowWrites.length - 1]?.payload).toMatchObject({ job_id: "job-047", bill_id: "bill-new" });
  });

  it("a stale bill link (zero rows, no error) must not dead-end the move", async () => {
    // bill_id is ON DELETE SET NULL, and a half-finished retry lands right here. A zero-row
    // refusal on THIS door would leave the receipt permanently unfilable, which is the dead end
    // the no-dead-ends rule exists for. Only a real error stops the move.
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: [], error: null }],
        "documents.delete": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }, { bill: null }),
      calls,
    );
    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res).toEqual({ ok: true });
  });

  it("a claimant with no number ('another invoice') still opens the sentence like a sentence", async () => {
    // invoice_holding_claim coalesces a missing / cross-org invoice_number to the literal
    // "another invoice", so the trigger's message starts lower case. In a toast that reads as a
    // dropped word.
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{
          data: null,
          error: { code: "P0001", message: "another invoice already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt." },
        }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.error).toMatch(/^Another invoice already bills this receipt\. /);
    expect(res.error).toContain("Nothing was moved.");
  });

  it("an error the guard did not raise keeps its own sentence (RLS gets the plain-English one)", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: { message: 'new row violates row-level security policy for table "bills"' } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("don't have access");
    expect(res.error).not.toContain("Nothing was moved");
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("a failed document teardown stops the re-file instead of leaving two copies on the job", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WALDOW_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: null, error: { message: "boom" } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("still on the job");
    expect(did("documents", "insert")).toBeUndefined();
  });

  it("a failed petty-cash teardown stops the re-file (audit 9's double disbursement, said out loud)", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WALDOW_RECEIPT, bill_id: null, document_id: null, petty_cash_id: "pc-1" }, error: null }],
        "petty_cash.delete": [{ data: null, error: { message: "boom" } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const res = await fileItem(WALDOW_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("still in the drawer");
    expect(did("bills", "insert")).toBeUndefined();
  });
});

describe("billJobReceipt — the link row IS the idempotency", () => {
  /** A receipt already on the job, waiting for Record as Cost. */
  const DOC = { id: "doc-9", name: "ced-467.jpg", file_url: "org-1/receipts/ced-467.jpg", size_bytes: 120_000, job_id: "job-046" };

  const readerScript = (linkResult: any) => ({
    "documents.select": [{ data: DOC, error: null }],
    // the "already billed?" check — nothing yet
    "organized_items.select": [{ data: null, error: null }],
    "bills.insert": [{ data: { id: "bill-new" }, error: null }],
    "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
    "organized_items.insert": [linkResult],
  });

  it("writes the link row and asks for it back, so a refusal cannot read as success", async () => {
    state.client = fakeSupabase(readerScript({ data: [{ id: "oi-new" }], error: null }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(did("organized_items", "insert")?.selected).toBe(true);
  });

  it("a link row that did not land is SAID, because the next tap would write a second bill", async () => {
    // The idempotency check at the top of billJobReceipt reads this row and nothing else. Lost
    // silently, the receipt is un-billed in the app's eyes forever: Record as Cost reads the same
    // paper again and puts a second $467.87 on the job and on the customer's invoice.
    state.client = fakeSupabase(readerScript({ data: null, error: { message: "rls says no" } }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true); // the COST is real and must not be thrown away over a link row
    expect(res.warning).toContain("did not get marked as billed");
    expect(res.warning).toContain("second bill");
    expect(reported.calls.map((c) => c.where)).toContain("organize:billJobReceipt.link");
  });

  it("zero rows counts as not landed — the silent-write law's own case", async () => {
    state.client = fakeSupabase(readerScript({ data: [], error: null }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.warning).toContain("did not get marked as billed");
  });

  it("a receipt that also does not add up carries BOTH sentences, not the first one only", async () => {
    // reconcileReceipt flags the mismatch; the link warning rides beside it. Hiding one behind
    // the other is how the second one gets found in a month.
    ai.parsed = { ...ai.parsed, amount: 900, line_items: [{ description: "1/2 in EMT", quantity: 1, unit_price: 467.87, amount: 467.87 }] };
    state.client = fakeSupabase(readerScript({ data: null, error: { message: "rls says no" } }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.warning).toContain("did not get marked as billed");
    // The reconcile note is the other half; it names the gap the lines leave against the total.
    expect(res.warning).toContain("$432.13 less than");
  });
});

describe("billJobReceipt — whose date the bill carries", () => {
  // Made-up document; the date rule is what is under test (the Aug 29 receipt that landed as
  // the day it was photographed, because the form's seeded "today" outranked the paper).
  const DOC = { id: "doc-7", name: "hardware.jpg", file_url: "org-1/receipts/hardware.jpg", size_bytes: 90_000, job_id: "job-1" };
  const script = () => ({
    "documents.select": [{ data: DOC, error: null }],
    "organized_items.select": [{ data: null, error: null }],
    "bills.insert": [{ data: { id: "bill-new" }, error: null }],
    "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
    "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
  });
  const dates = () => ({
    bill: did("bills", "insert")?.payload?.bill_date,
    item: did("organized_items", "insert")?.payload?.item_date,
  });

  it("the paper's date beats the form's seeded day", async () => {
    state.client = fakeSupabase(script(), calls);
    await billJobReceipt(DOC.id, { billDate: null, fallbackBillDate: "2026-09-24" });
    expect(dates()).toEqual({ bill: "2026-09-15", item: "2026-09-15" });
  });

  it("a date the person set beats the paper", async () => {
    state.client = fakeSupabase(script(), calls);
    await billJobReceipt(DOC.id, { billDate: "2026-09-01", fallbackBillDate: "2026-09-24" });
    expect(dates()).toEqual({ bill: "2026-09-01", item: "2026-09-01" });
  });

  it("no legible date on the paper still lands the seeded day, never a dateless bill", async () => {
    ai.parsed = { ...ai.parsed, date: "smudged" };
    state.client = fakeSupabase(script(), calls);
    await billJobReceipt(DOC.id, { billDate: null, fallbackBillDate: "2026-09-24" });
    expect(dates()).toEqual({ bill: "2026-09-24", item: "2026-09-24" });
  });
});

describe("deleteOrganizedItem — throwing away a receipt an invoice bills", () => {
  it("refuses, and the trash door's own sentence is the trigger's own sentence", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
      }),
      calls,
    );
    const res = await deleteOrganizedItem(WALDOW_RECEIPT.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("INV-069 already bills this receipt.");
    expect(res.error).toContain("Void that invoice, or take its materials lines off, then delete this receipt.");
    expect(res.error).toContain("Nothing was deleted.");
  });

  it("nothing else is touched: the photo, the job copy and the item all survive the refusal", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
      }),
      calls,
      storage,
    );
    await deleteOrganizedItem(WALDOW_RECEIPT.id);
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("organized_items", "delete")).toBeUndefined();
    expect(storage.removed).toEqual([]);
  });

  it("an unclaimed receipt deletes: row first, THEN the photo", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WALDOW_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WALDOW_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.delete": [{ data: [{ id: WALDOW_RECEIPT.id }], error: null }],
      }),
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WALDOW_RECEIPT.id);
    expect(res).toEqual({ ok: true });
    expect(storage.removed).toEqual([[WALDOW_RECEIPT.file_url]]);
    expect(did("organized_items", "delete")?.selected).toBe(true);
  });

  it("a zero-row item delete is a refusal said out loud, and the photo is NOT removed", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WALDOW_RECEIPT, bill_id: null, document_id: null }, error: null }],
        "organized_items.delete": [{ data: [], error: null }],
      },
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WALDOW_RECEIPT.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Nothing deleted.");
    expect(storage.removed).toEqual([]);
  });

  it("a photo that will not delete is an ops-log line, not a red box over a done deed", async () => {
    const storage = { removed: [] as string[][], error: { message: "storage offline" } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WALDOW_RECEIPT, bill_id: null, document_id: null }, error: null }],
        "organized_items.delete": [{ data: [{ id: WALDOW_RECEIPT.id }], error: null }],
      },
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WALDOW_RECEIPT.id);
    expect(res).toEqual({ ok: true });
    expect(reported.calls.map((c) => c.where)).toContain("organize:deleteOrganizedItem.storage");
  });
});
