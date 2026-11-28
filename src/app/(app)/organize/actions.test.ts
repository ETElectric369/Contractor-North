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
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: async () => {}, modelFor: () => "test-model", aiAllowed: async () => ({ ok: true }), fallbacksFor: () => ({}) }));
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
const WEXLEY_RECEIPT = {
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
        or() { return chain; },
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
      { data: o.bill === undefined ? { id: WEXLEY_RECEIPT.bill_id, amount: 467.87, on_shelf: false, bill_line_items: [] } : o.bill, error: null },
      { data: o.copies ?? [], error: null },
    );
    add("organized_items.select", { data: o.tied ?? [], error: null });
  }
  add("documents.select", { data: o.doc === undefined ? { id: "doc-1", created_at: "2026-09-15T12:00:00Z", file_url: WEXLEY_RECEIPT.file_url } : o.doc, error: null });
  return script;
}

describe("fileItem — re-filing a receipt an invoice already bills", () => {
  it("refuses the whole move, names INV-069, and tells him what to do about it", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
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
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });

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
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(did("bills", "delete")?.selected).toBe(true);
  });

  it("an unclaimed receipt still moves: bill torn down, new one built on the new job", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WEXLEY_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );

    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
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
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: [], error: null }],
        "documents.delete": [{ data: [], error: null }],
        "documents.insert": [{ data: { id: "doc-2" }, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }, { bill: null }),
      calls,
    );
    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res).toEqual({ ok: true });
  });

  it("a claimant with no number ('another invoice') still opens the sentence like a sentence", async () => {
    // invoice_holding_claim coalesces a missing / cross-org invoice_number to the literal
    // "another invoice", so the trigger's message starts lower case. In a toast that reads as a
    // dropped word.
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{
          data: null,
          error: { code: "P0001", message: "another invoice already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt." },
        }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.error).toMatch(/^Another invoice already bills this receipt\. /);
    expect(res.error).toContain("Nothing was moved.");
  });

  it("an error the guard did not raise keeps its own sentence (RLS gets the plain-English one)", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: { message: 'new row violates row-level security policy for table "bills"' } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("don't have access");
    expect(res.error).not.toContain("Nothing was moved");
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("a failed document teardown stops the re-file instead of leaving two copies on the job", async () => {
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WEXLEY_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: null, error: { message: "boom" } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      }),
      calls,
    );
    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("still on the job");
    expect(did("documents", "insert")).toBeUndefined();
  });

  it("a failed petty-cash teardown stops the re-file (audit 9's double disbursement, said out loud)", async () => {
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WEXLEY_RECEIPT, bill_id: null, document_id: null, petty_cash_id: "pc-1" }, error: null }],
        "petty_cash.delete": [{ data: null, error: { message: "boom" } }],
        "organized_items.update": [{ data: [{ id: "oi" }], error: null }, { data: [{ id: "oi" }], error: null }],
      },
      calls,
    );
    const res = await fileItem(WEXLEY_RECEIPT.id, { type: "job", jobId: "job-047" });
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

describe("billJobReceipt — a paper whose number is already on the books is FILED with that bill", () => {
  /**
   * J-013 "ARR #56" (2026-09-30): one live bill, no supplier papers, and the Costs badge said 3 with
   * the receipts fold reading "Not on a Bill Yet". The second photo of the same CED ticket got
   * "Already on the books" and NO row, so the job page called it loose forever: counted on the chip,
   * flagged on its line, and its Record as Cost only ever answered the same sentence. Now the photo
   * is tied to the bill it names (tied_bill_id, the Same Purchase: Tie Them row), so it reads "On
   * that bill" and leaves the count; Different Purchase still writes its own bill and drops the tie.
   */
  const DOC = { id: "doc-11", name: "ced-1107820-again.jpg", file_url: "org-1/receipts/ced-1107820-again.jpg", size_bytes: 100_000, job_id: "job-013" };
  const OLD_BILL = {
    id: "bill-old",
    supplier: "Contractors Electrical Distributors",
    bill_number: "8802-1107820",
    supplier_invoice_number: null,
    supplier_account_id: null,
    superseded_by_bill_id: null,
    amount: 467.87,
    bill_date: "2026-09-15",
    job_id: "job-013",
    jobs: { job_number: "J-013", name: "ARR #56" },
  };
  const sameNumberScript = (tieResult: any): Record<string, any[]> => ({
    "documents.select": [{ data: DOC, error: null }],
    // In the order the action asks: the "already billed?" read (nothing), loadBooks' papers read
    // (nothing with a number), then the "already tied?" read (nothing).
    "organized_items.select": [
      { data: null, error: null },
      { data: [], error: null },
      { data: null, error: null },
    ],
    // loadBooks' numbered-bills read carries the live bill with this ticket's number; its two
    // no-number reads and every other table are unscripted, which the reader treats as empty.
    "bills.select": [{ data: [OLD_BILL], error: null }],
    "organized_items.insert": [tieResult],
  });

  beforeEach(() => {
    ai.parsed = { ...ai.clean(), document_number: "8802-1107820" };
  });

  it("writes the tie (tied_bill_id, never bill_id), no bill, and says the photo is filed with it", async () => {
    state.client = fakeSupabase(sameNumberScript({ data: [{ id: "oi-tie" }], error: null }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.already).toBe(true);
    expect(res.sameAs).toContain("Already on the books: Contractors Electrical Distributors #8802-1107820");
    expect(res.sameAs).toContain("This photo is filed with that bill");
    expect(did("bills", "insert")).toBeUndefined();
    const tie = did("organized_items", "insert");
    expect(tie?.selected).toBe(true);
    expect(tie?.payload).toMatchObject({ document_id: DOC.id, tied_bill_id: "bill-old", bill_id: null, status: "filed", job_id: "job-013" });
  });

  it("a tie that did not land is SAID: the Costs tab will keep calling the photo loose", async () => {
    state.client = fakeSupabase(sameNumberScript({ data: null, error: { message: "rls says no" } }), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.already).toBe(true);
    expect(res.warning).toContain("couldn't be filed with that bill");
    expect(reported.calls.map((c) => c.where)).toContain("organize:billJobReceipt.tie");
  });

  it("a photo already tied is not tied twice", async () => {
    const script = sameNumberScript({ data: [{ id: "oi-never" }], error: null });
    script["organized_items.select"][2] = { data: { id: "oi-tie-before" }, error: null };
    state.client = fakeSupabase(script, calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(res.sameAs).toContain("This photo is filed with that bill");
    expect(did("organized_items", "insert")).toBeUndefined();
  });

  it("Different Purchase writes its own bill and drops the same-purchase tie, asking for the row back", async () => {
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: DOC, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
        "organized_items.delete": [{ data: [{ id: "oi-tie" }], error: null }],
      },
      calls,
    );
    const res = await billJobReceipt(DOC.id, { differentPurchase: true });
    expect(res.ok).toBe(true);
    expect(res.already).toBeUndefined();
    expect(res.warning).toBeUndefined();
    expect(did("bills", "insert")).toBeDefined();
    expect(did("organized_items", "insert")?.payload).toMatchObject({ bill_id: "bill-new", document_id: DOC.id });
    expect(did("organized_items", "delete")?.selected).toBe(true);
  });

  it("a tie that would not come off is said, never silent", async () => {
    state.client = fakeSupabase(
      {
        "documents.select": [{ data: DOC, error: null }],
        "organized_items.select": [{ data: null, error: null }],
        "bills.insert": [{ data: { id: "bill-new" }, error: null }],
        "bill_line_items.insert": [{ data: [{ id: "bli-1" }], error: null }],
        "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
        "organized_items.delete": [{ data: null, error: { message: "rls says no" } }],
      },
      calls,
    );
    const res = await billJobReceipt(DOC.id, { differentPurchase: true });
    expect(res.ok).toBe(true);
    expect(res.warning).toContain("still filed with the other bill");
    expect(reported.calls.map((c) => c.where)).toContain("organize:billJobReceipt.untie");
  });

  it("a receipt already tied to a bill is on the books: no second read, no second bill", async () => {
    state.client = fakeSupabase(
      { "documents.select": [{ data: DOC, error: null }], "organized_items.select": [{ data: { id: "oi-tie", bill_id: null, tied_bill_id: "bill-old" }, error: null }] },
      calls,
    );
    const res = await billJobReceipt(DOC.id);
    expect(res).toEqual({ ok: true, already: true });
    expect(did("bills", "insert")).toBeUndefined();
    expect(did("organized_items", "insert")).toBeUndefined();
  });
});

describe("billJobReceipt — a number alone never says same purchase; the money must agree (cn-v1211)", () => {
  /**
   * Stand-ins only. A counter slip of Bayberry Lumber read as number "417" for $18.40 on J-901; a
   * bill "417" for $61.75, three weeks older, on J-902. "417" was the store's number, printed on every
   * slip. Filed with the old bill on the number alone, the slip's $18.40 never reached J-901.
   */
  const DOC = { id: "doc-901", name: "bayberry-slip.jpg", file_url: "org-1/receipts/bayberry-slip.jpg", size_bytes: 80_000, job_id: "job-901" };
  const bill = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    supplier: "Bayberry Lumber",
    bill_number: "417",
    supplier_invoice_number: null,
    supplier_account_id: null,
    superseded_by_bill_id: null,
    amount: 61.75,
    bill_date: "2026-11-02",
    job_id: "job-902",
    jobs: { job_number: "J-902", name: "Stand-in Deck" },
    ...over,
  });
  const NAMESAKE =
    "Recorded as its own purchase. A bill with the same number is already on the books at another total: Bayberry Lumber #417, $61.75, 2026-11-02, on J-902 Stand-in Deck.";

  beforeEach(() => {
    ai.parsed = {
      vendor: "Bayberry Lumber",
      amount: 18.40,
      date: "2026-11-23",
      document_number: "417",
      line_items: [
        { description: "2x4 stud", quantity: 2, unit_price: 4.70, amount: 9.40, category: "Materials" },
        { description: "Deck screws", quantity: 1, unit_price: 9, amount: 9, category: "Materials" },
      ],
      payment: "paid_at_purchase",
      confidence: "high",
    };
  });

  /** The reads every case makes: the "already billed?" read, loadBooks' papers read, the bills carrying 417. */
  const reads = (bills: any[]): Record<string, any[]> => ({
    "documents.select": [{ data: DOC, error: null }],
    "organized_items.select": [
      { data: null, error: null },
      { data: [], error: null },
    ],
    "bills.select": [{ data: bills, error: null }],
  });
  /** Ties: then the "already tied?" read and the tie's insert. */
  const tieScript = (bills: any[]): Record<string, any[]> => {
    const s = reads(bills);
    s["organized_items.select"].push({ data: null, error: null });
    s["organized_items.insert"] = [{ data: [{ id: "oi-tie" }], error: null }];
    return s;
  };
  /** Records: then the bill, its lines and the link row. */
  const writeScript = (bills: any[]): Record<string, any[]> => ({
    ...reads(bills),
    "bills.insert": [{ data: { id: "bill-new" }, error: null }],
    "bill_line_items.insert": [{ data: [{ id: "bli-1" }, { id: "bli-2" }], error: null }],
    "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
  });
  const inserts = () => calls.filter((c) => c.table === "organized_items" && c.verb === "insert");

  it("the stand-in story: one bill on ANOTHER job at another total: recorded on the paper's job, no tie, and said once", async () => {
    state.client = fakeSupabase(writeScript([bill("bill-902")]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.already).not.toBe(true);
    expect(res.sameAs).toBeUndefined();
    expect(res.sameBillId).toBeUndefined();
    expect(res.warning).toBe(NAMESAKE);
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", amount: 18.40, job_id: "job-901" });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({ bill_id: "bill-new", document_id: DOC.id });
    expect(inserts()[0].payload.tied_bill_id).toBeUndefined();
  });

  it("two bills carry the number and neither is the twin: the number repeats, recorded with no namesake line", async () => {
    state.client = fakeSupabase(writeScript([bill("bill-a"), bill("bill-b", { amount: 18.40, bill_date: "2026-11-02" })]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.already).not.toBe(true);
    expect(res.warning).toBeUndefined();
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", job_id: "job-901" });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({ bill_id: "bill-new" });
  });

  it("two bills carry the number and one is the twin by total and day: tied to the TWIN, the sentence unchanged", async () => {
    state.client = fakeSupabase(
      tieScript([bill("bill-a"), bill("bill-twin", { amount: 18.40, bill_date: "2026-11-23", job_id: "job-901", jobs: { job_number: "J-901", name: "Stand-in Porch" } })]),
      calls,
    );
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(res.sameAs).toBe("Already on the books: Bayberry Lumber #417, $18.40, 2026-11-23, on J-901 Stand-in Porch. This photo is filed with that bill; nothing was recorded twice.");
    expect(did("organized_items", "insert")?.payload).toMatchObject({ tied_bill_id: "bill-twin", bill_id: null, document_id: DOC.id });
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("one bill at the same total on another day, on another job: tied as before", async () => {
    state.client = fakeSupabase(tieScript([bill("bill-902", { amount: 18.40 })]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(res.sameAs).toContain("This photo is filed with that bill");
    expect(res.sameBillId).toBeUndefined();
    expect(did("organized_items", "insert")?.payload).toMatchObject({ tied_bill_id: "bill-902", job_id: "job-901" });
    expect(did("bills", "insert")).toBeUndefined();
  });

  it("a write that already warns, beside a namesake: both sentences, the write's own first", async () => {
    ai.parsed = { ...ai.parsed, line_items: [{ description: "2x4 stud", quantity: 2, unit_price: 4.70, amount: 9.40, category: "Materials" }] };
    state.client = fakeSupabase(writeScript([bill("bill-902")]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.warning?.endsWith(` ${NAMESAKE}`)).toBe(true);
    const own = res.warning!.slice(0, res.warning!.length - NAMESAKE.length - 1);
    expect(own).toContain("$9.00 less than");
    expect(own).not.toContain("Recorded as its own purchase");
  });

  it("the form's fallback date is never the paper's date, so it cannot make a twin", async () => {
    ai.parsed = { ...ai.parsed, date: null };
    state.client = fakeSupabase(writeScript([bill("bill-a"), bill("bill-b", { amount: 18.40, bill_date: "2026-11-27", job_id: "job-901" })]), calls);
    const res = await billJobReceipt(DOC.id, { fallbackBillDate: "2026-11-27" });
    expect(res.already).not.toBe(true);
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", bill_date: "2026-11-27" });
    expect(inserts()[0].payload.tied_bill_id).toBeUndefined();
  });

  // The reviewer's surviving mutants at the door (skeptic #105, D1-D12), each a fixture of its own.
  const TWIN_HERE = { amount: 18.4, bill_date: "2026-11-23", job_id: "job-901", jobs: { job_number: "J-901", name: "Stand-in Porch" } };
  /** An original with no 417 on it and a correction carrying 417: one purchase, on J-901. */
  const family = (correctionAmount: number, over: Record<string, unknown> = {}) => [
    bill("o1", { bill_number: "SO-88", amount: 10, bill_date: "2026-11-02", ...over }),
    bill("c1", { amount: correctionAmount, bill_date: "2026-11-03", corrects_bill_id: "o1", ...over }),
  ];

  it("D1: a date the person set beats the date read: only the person's date makes the twin, so it is tied", async () => {
    state.client = fakeSupabase(tieScript([bill("bill-a"), bill("bill-twin", { ...TWIN_HERE, bill_date: "2026-11-20" })]), calls);
    const res = await billJobReceipt(DOC.id, { billDate: "2026-11-20" });
    expect(res.already).toBe(true);
    expect(did("organized_items", "insert")?.payload).toMatchObject({ tied_bill_id: "bill-twin" });
  });

  it("D1: a date the person set beats the date read: only the read date would make the twin, so it is recorded", async () => {
    state.client = fakeSupabase(writeScript([bill("bill-a"), bill("bill-twin", TWIN_HERE)]), calls);
    const res = await billJobReceipt(DOC.id, { billDate: "2026-11-20" });
    expect(res.already).not.toBe(true);
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", bill_date: "2026-11-20" });
    expect(inserts()[0].payload.tied_bill_id).toBeUndefined();
  });

  it("D2: no printed total, the lines sum to the bill's total: the reading takes that sum, and the paper is filed with the bill", async () => {
    ai.parsed = { ...ai.parsed, amount: null };
    state.client = fakeSupabase(tieScript([bill("bill-902", { amount: 18.4 })]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(did("organized_items", "insert")?.payload).toMatchObject({ tied_bill_id: "bill-902", amount: 18.4 });
  });

  it("D2: no printed total, the lines sum to another total: the reading takes that sum, so it is recorded beside the namesake", async () => {
    ai.parsed = { ...ai.parsed, amount: null };
    state.client = fakeSupabase(writeScript([bill("bill-902")]), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).not.toBe(true);
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", amount: 18.4 });
    expect(res.warning).toBe(NAMESAKE);
  });

  it("D3, D4, D12: the tie goes to the ORIGINAL, the sentence names the purchase whole, and the tie row holds the PAPER's read", async () => {
    state.client = fakeSupabase(tieScript(family(8.4, { job_id: "job-901", jobs: { job_number: "J-901", name: "Stand-in Porch" } })), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(res.sameAs).toBe(
      "Already on the books: Bayberry Lumber #SO-88 corrected by 417, $18.40 together, 2026-11-02, on J-901 Stand-in Porch. This photo is filed with that bill; nothing was recorded twice.",
    );
    const tie = did("organized_items", "insert")?.payload;
    expect(tie).toMatchObject({ tied_bill_id: "o1", bill_id: null, amount: 18.4, item_date: "2026-11-23", doc_number: "417", vendor: "Bayberry Lumber" });
    expect(tie.line_items.map((l: any) => l.amount)).toEqual([9.4, 9]);
  });

  it("D5: the namesake line names the purchase whole, with what billLabel adds for corrections", async () => {
    state.client = fakeSupabase(writeScript(family(40)), calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).not.toBe(true);
    expect(res.warning).toBe(
      "Recorded as its own purchase. A bill with the same number is already on the books at another total: Bayberry Lumber #SO-88 corrected by 417, $50.00 together, 2026-11-02, on J-902 Stand-in Deck.",
    );
  });

  it("D6, D7: a tie that did not land hands the door the TWIN (on the paper's job), never the first bill (on another job)", async () => {
    const script = tieScript([bill("bill-a"), bill("bill-twin", TWIN_HERE)]);
    script["organized_items.insert"] = [{ data: null, error: { message: "rls says no" } }];
    state.client = fakeSupabase(script, calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.already).toBe(true);
    expect(res.warning).toContain("couldn't be filed with that bill");
    expect(res.sameBillId).toBe("bill-twin");
    expect(res.sameOnThisJob).toBe(true);
  });

  /** Different Purchase, scripted so that a door which DID enter the number block could tie cleanly. */
  const differentScript = (bills: any[]): Record<string, any[]> => ({
    "documents.select": [{ data: DOC, error: null }],
    "organized_items.select": [
      { data: null, error: null },
      { data: [], error: null },
      { data: null, error: null },
    ],
    "bills.select": [{ data: bills, error: null }],
    "bills.insert": [{ data: { id: "bill-new" }, error: null }],
    "bill_line_items.insert": [{ data: [{ id: "bli-1" }, { id: "bli-2" }], error: null }],
    "organized_items.insert": [{ data: [{ id: "oi-new" }], error: null }],
    "organized_items.delete": [{ data: [], error: null }],
  });

  it("D9: Different Purchase never enters the number block: with a twin on the books it still writes its own bill and ties nothing", async () => {
    state.client = fakeSupabase(differentScript([bill("bill-twin", TWIN_HERE)]), calls);
    const res = await billJobReceipt(DOC.id, { differentPurchase: true });
    expect(res.already).toBeUndefined();
    expect(did("bills", "insert")?.payload).toMatchObject({ bill_number: "417", job_id: "job-901" });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({ bill_id: "bill-new" });
    expect(inserts()[0].payload.tied_bill_id).toBeUndefined();
  });

  it("D9: Different Purchase beside a namesake carries NO namesake line", async () => {
    state.client = fakeSupabase(differentScript([bill("bill-902")]), calls);
    const res = await billJobReceipt(DOC.id, { differentPurchase: true });
    expect(did("bills", "insert")).toBeDefined();
    expect(res.warning).toBeUndefined();
  });

  it("D10: the namesake line survives the link-row failure: both sentences are in the warning, the link's first", async () => {
    const script = writeScript([bill("bill-902")]);
    script["organized_items.insert"] = [{ data: null, error: { message: "rls says no" } }];
    state.client = fakeSupabase(script, calls);
    const res = await billJobReceipt(DOC.id);
    expect(res.ok).toBe(true);
    expect(res.warning).toContain("did not get marked as billed");
    expect(res.warning?.endsWith(` ${NAMESAKE}`)).toBe(true);
  });
});

describe("the reader learns what a paper's number is (cn-v1211): both prompts, one sentence", () => {
  const SENTENCE =
    '"document_number": the number that belongs to THIS paper alone (its invoice, ticket, receipt or credit memo number), exactly as printed, or null. Never the store number, a register, terminal, cashier or clerk number, a customer or account number, a PO number, a phone number or a date: those are the same on every paper from that store. If the paper carries no number of its own, null';
  it("the job door's prompt and the tray's prompt carry the same sentence, and the old one is gone", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");
    const line = (text: string) => text.split("\n").filter((l) => l.includes('"document_number":'));
    for (const file of ["src/app/(app)/organize/actions.ts", "src/app/(app)/organize/paperwork-core.ts"]) {
      const text = src(file);
      expect(line(text)).toHaveLength(1);
      expect(line(text)[0].trim()).toBe(`${SENTENCE},`);
      expect(text).not.toContain("the invoice, ticket or receipt number printed on it");
    }
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
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
      }),
      calls,
    );
    const res = await deleteOrganizedItem(WEXLEY_RECEIPT.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("INV-069 already bills this receipt.");
    expect(res.error).toContain("Void that invoice, or take its materials lines off, then delete this receipt.");
    expect(res.error).toContain("Nothing was deleted.");
  });

  it("nothing else is touched: the photo, the job copy and the item all survive the refusal", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: null, error: GUARD }],
      }),
      calls,
      storage,
    );
    await deleteOrganizedItem(WEXLEY_RECEIPT.id);
    expect(did("documents", "delete")).toBeUndefined();
    expect(did("organized_items", "delete")).toBeUndefined();
    expect(storage.removed).toEqual([]);
  });

  it("an unclaimed receipt deletes: row first, THEN the photo", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      withTeardownReads({
        "organized_items.select": [{ data: WEXLEY_RECEIPT, error: null }],
        "bills.delete": [{ data: [{ id: WEXLEY_RECEIPT.bill_id }], error: null }],
        "documents.delete": [{ data: [{ id: "doc-1" }], error: null }],
        "organized_items.delete": [{ data: [{ id: WEXLEY_RECEIPT.id }], error: null }],
      }),
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WEXLEY_RECEIPT.id);
    expect(res).toEqual({ ok: true });
    expect(storage.removed).toEqual([[WEXLEY_RECEIPT.file_url]]);
    expect(did("organized_items", "delete")?.selected).toBe(true);
  });

  it("a zero-row item delete is a refusal said out loud, and the photo is NOT removed", async () => {
    const storage = { removed: [] as string[][] };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WEXLEY_RECEIPT, bill_id: null, document_id: null }, error: null }],
        "organized_items.delete": [{ data: [], error: null }],
      },
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WEXLEY_RECEIPT.id);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Nothing deleted.");
    expect(storage.removed).toEqual([]);
  });

  it("a photo that will not delete is an ops-log line, not a red box over a done deed", async () => {
    const storage = { removed: [] as string[][], error: { message: "storage offline" } };
    state.client = fakeSupabase(
      {
        "organized_items.select": [{ data: { ...WEXLEY_RECEIPT, bill_id: null, document_id: null }, error: null }],
        "organized_items.delete": [{ data: [{ id: WEXLEY_RECEIPT.id }], error: null }],
      },
      calls,
      storage,
    );
    const res = await deleteOrganizedItem(WEXLEY_RECEIPT.id);
    expect(res).toEqual({ ok: true });
    expect(reported.calls.map((c) => c.where)).toContain("organize:deleteOrganizedItem.storage");
  });
});
