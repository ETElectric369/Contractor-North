import { describe, it, expect, vi, beforeEach } from "vitest";
import { strictDb, type Row } from "@/test/strict-db";
import { readFiledPaperAgainWith, type ReadAgainDoors } from "./read-again-core";

// THE SERVER ACTION'S WIRING (the last describe): the real doors are these mocks.
const wired = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: wired.client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/ai-cost", () => ({ aiAllowed: vi.fn(async () => ({ ok: true })) }));
const real = vi.hoisted(() => ({
  undoPaperwork: vi.fn(async () => ({ ok: false, error: "Undo said no. Nothing was undone." })),
  readPaperworkItem: vi.fn(),
  fileItem: vi.fn(),
  billJobReceipt: vi.fn(),
}));
vi.mock("./actions", () => real);

/**
 * READ AGAIN ON A FILED PAPER (cn-v1181, lane T3). The doors (Undo, the tray's read and File It, the
 * job page's Record as Cost) are passed in, so each branch is proven here without a database; the
 * reads are made on a stand-in that honours filters and select lists (another company's bill or
 * paper is never found). Stand-ins: job Larkspur J-901, supplier Northline Supply, ticket INV-900.
 */

let db: ReturnType<typeof strictDb>;
let doors: { [K in keyof ReadAgainDoors]: ReturnType<typeof vi.fn> };

const BILL = (over: Row = {}): Row => ({
  id: "bill-1",
  org_id: "org-1",
  amount: 283,
  status: "unpaid",
  job_id: "job-901",
  category: "Bill",
  bill_date: "2026-11-02",
  scope_category: null,
  notes: "Bill filed by a person from the tray: Northline Supply INV-900",
  on_shelf: false,
  corrects_bill_id: null,
  superseded_by_bill_id: null,
  bill_number: "INV-900",
  ...over,
});
const PAPER = (over: Row = {}): Row => ({
  id: "oi-1",
  org_id: "org-1",
  status: "filed",
  bill_id: "bill-1",
  file_url: "org-1/organize/ticket.jpg",
  document_id: "doc-copy",
  source: null,
  payment: "on_account",
  line_items: [],
  ...over,
});
const PEN_LINES = [
  { description: "12-2 NM-B WIRE 250FT", quantity: 2, unit_price: 120, amount: 240, billable: false, pen: "struck", returned: true },
  { description: "WIRE NUTS", quantity: 1, unit_price: 43, amount: 43, billable: true },
];

function setup(bills: Row[], papers: Row[]) {
  db = strictDb({ bills, organized_items: papers });
  doors = {
    canRead: vi.fn(async () => ({ ok: true })),
    undo: vi.fn(async (id: string) => {
      // The real Undo: the bill comes down, the tray paper waits again (a job upload's link row goes).
      const p = db.tables.organized_items.find((r) => r.id === id)!;
      db.tables.bills = db.tables.bills.filter((b) => b.id !== p.bill_id);
      if (p.source === "job") db.tables.organized_items = db.tables.organized_items.filter((r) => r.id !== id);
      else Object.assign(p, { status: "needs_review", bill_id: null, document_id: null, job_id: null });
      return { ok: true, message: "Undone." };
    }),
    readTray: vi.fn(async (id: string) => {
      const p = db.tables.organized_items.find((r) => r.id === id)!;
      Object.assign(p, { line_items: PEN_LINES, amount: 283 });
      return { ok: true };
    }),
    fileTray: vi.fn(async (id: string) => {
      const p = db.tables.organized_items.find((r) => r.id === id)!;
      db.tables.bills.push(BILL({ id: "bill-2", amount: 283 }));
      Object.assign(p, { status: "filed", bill_id: "bill-2" });
      return { ok: true };
    }),
    billJob: vi.fn(async (documentId: string) => {
      db.tables.bills.push(BILL({ id: "bill-3", amount: 290.5 }));
      db.tables.organized_items.push(PAPER({ id: "oi-new", source: "job", document_id: documentId, bill_id: "bill-3", line_items: PEN_LINES, payment: "on_account" }));
      return { ok: true, amount: 290.5 };
    }),
  };
}
const run = (billId = "bill-1") => readFiledPaperAgainWith({ supabase: db.sb, orgId: "org-1" }, billId, doors as unknown as ReadAgainDoors);
const nothingMoved = () => {
  expect(doors.undo).not.toHaveBeenCalled();
  expect(db.writes).toEqual([]);
};

beforeEach(() => setup([BILL()], [PAPER()]));

describe("Read Again on a filed paper: refusals before anything changes", () => {
  it("another company's bill is never found", async () => {
    setup([BILL({ org_id: "org-2" })], [PAPER({ org_id: "org-2" })]);
    const res = await run();
    expect(res).toEqual({ ok: false, error: "That bill isn't on the books any more. Reload the page." });
    nothingMoved();
  });

  it("a bill with no paper, and a paper of another company, say there is no picture", async () => {
    setup([BILL()], [PAPER({ org_id: "org-2" })]);
    const res = await run();
    expect(res.error).toMatch(/wasn't made from a paper/);
    nothingMoved();
  });

  it("a paper with no picture (typed in) refuses in one sentence", async () => {
    setup([BILL()], [PAPER({ file_url: null })]);
    expect((await run()).error).toMatch(/no picture on it/);
    nothingMoved();
  });

  it("a file the reader can't open refuses before the Undo", async () => {
    setup([BILL()], [PAPER({ file_url: "org-1/organize/ticket.heic" })]);
    expect((await run()).error).toMatch(/isn't a photo or a PDF/);
    nothingMoved();
  });

  it("a credit memo filed under the bill is named, and nothing is undone", async () => {
    setup([BILL(), BILL({ id: "bill-cm", amount: -40, corrects_bill_id: "bill-1", bill_number: "CM-900" })], [PAPER()]);
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("a credit memo #CM-900 is filed under this bill");
    nothingMoved();
  });

  it("a bill that is itself a correction, or a copy set aside, refuses", async () => {
    setup([BILL({ corrects_bill_id: "bill-0" })], [PAPER()]);
    expect((await run()).error).toMatch(/is a correction/);
    setup([BILL({ superseded_by_bill_id: "bill-0" })], [PAPER()]);
    expect((await run()).error).toMatch(/set aside as a copy/);
    nothingMoved();
  });

  it("a paused reader refuses before the Undo", async () => {
    doors.canRead.mockResolvedValueOnce({ ok: false, why: "Reading is paused: the plan has ended." });
    const res = await run();
    expect(res).toEqual({ ok: false, error: "Reading is paused: the plan has ended. Nothing changed." });
    nothingMoved();
  });

  it("a failed read of the bill is said, never 'not on the books'", async () => {
    db = strictDb({ bills: [BILL()], organized_items: [PAPER()] }, { fail: (t) => (t === "bills" ? "timeout" : undefined) });
    const res = await run();
    expect(res.error).toMatch(/couldn't be read/);
    expect(res.error).not.toMatch(/isn't on the books/);
    nothingMoved();
  });

  it("Undo's own refusal comes back exactly as it is, and nothing is read", async () => {
    const said = "INV-900 already bills this receipt. Void that invoice, or take its materials lines off, then press Undo again. Nothing was undone.";
    doors.undo.mockResolvedValueOnce({ ok: false, error: said });
    expect(await run()).toEqual({ ok: false, error: said });
    expect(doors.readTray).not.toHaveBeenCalled();
    expect(doors.billJob).not.toHaveBeenCalled();
  });
});

describe("Read Again: the tray path", () => {
  it("undoes, reads, and files to the SAME job (with its part and a decided Different Purchase); says the totals and the pen marks", async () => {
    setup([BILL({ scope_category: "Service Upgrade", notes: "x\nA person checked: a different purchase from the one already on the books with this number." })], [PAPER()]);
    const res = await run();
    expect(doors.undo).toHaveBeenCalledWith("oi-1");
    expect(doors.readTray).toHaveBeenCalledWith("oi-1");
    expect(doors.fileTray).toHaveBeenCalledWith("oi-1", { type: "job", jobId: "job-901", scope: "Service Upgrade" }, { differentPurchase: true });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Read again and filed the same way.");
    expect(res.message).toContain("The total is $283.00, as before.");
    expect(res.message).toContain("Pen marks read: 1 line crossed out.");
    expect(res.message).toContain("credit expected from the supplier");
  });

  it("the door's own pen sentence is said once, never twice", async () => {
    const door = "Pen marks read: 1 line crossed out. $240.00 is marked returned: off the customer's bill, with a credit expected from the supplier. The total is kept as printed.";
    doors.fileTray.mockImplementationOnce(async (id: string) => {
      const p = db.tables.organized_items.find((r) => r.id === id)!;
      db.tables.bills.push(BILL({ id: "bill-2", amount: 283 }));
      Object.assign(p, { status: "filed", bill_id: "bill-2" });
      return { ok: true, message: `Filed. ${door}` };
    });
    const res = await run();
    expect(res.message!.split("Pen marks read").length - 1).toBe(1);
    expect(res.message).toContain(door);
  });

  it("a business cost goes back to its bucket", async () => {
    setup([BILL({ job_id: null, category: "Fuel" })], [PAPER()]);
    await run();
    expect(doors.fileTray).toHaveBeenCalledWith("oi-1", { type: "overhead", category: "Fuel" }, {});
  });

  it("a shop-stock ticket is read and left WAITING, and the answer says where", async () => {
    setup([BILL({ job_id: null, on_shelf: true, category: "Shop Stock" })], [PAPER()]);
    const res = await run();
    expect(doors.readTray).toHaveBeenCalled();
    expect(doors.fileTray).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.message).toContain("shop stock");
    expect(res.message).toContain("waiting in the tray on Bills");
  });

  it("a place that can't be told surely is never guessed", async () => {
    setup([BILL({ job_id: null, category: "Something Else" })], [PAPER()]);
    const res = await run();
    expect(doors.fileTray).not.toHaveBeenCalled();
    expect(res.message).toContain("isn't guessed");
  });

  it("the read fails after the Undo: the paper is WAITING and the answer says so, with the reader's words", async () => {
    doors.readTray.mockResolvedValueOnce({ ok: false, error: "The reader didn't answer." });
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("The old bill ($283.00) is down. Reading it again didn't work: The reader didn't answer. It is waiting in the tray on Bills, under Needs You.");
    expect(doors.fileTray).not.toHaveBeenCalled();
  });

  it("File It refuses after the read: the paper is WAITING, read from the row, not assumed", async () => {
    doors.fileTray.mockResolvedValueOnce({ ok: false, error: "That job isn't in your book. Nothing was filed." });
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("filing it didn't work: That job isn't in your book.");
    expect(res.error).toContain("waiting in the tray on Bills");
  });

  it("filed from another screen meanwhile: never called waiting", async () => {
    doors.fileTray.mockImplementationOnce(async () => {
      db.tables.organized_items[0].status = "filed";
      return { ok: false, error: "Someone else is filing this paper right now, or just did." };
    });
    const res = await run();
    expect(res.error).toContain("filed from another screen meanwhile");
    expect(res.error).not.toContain("waiting in the tray");
  });

  it("an old bill paid at the counter whose new bill is owed says so", async () => {
    // Paid at purchase is the one paid bill Read Again takes down (skeptic #84, S5): its payment is
    // the paper's own. Asked through isStillOwed, by the number, never by the status word.
    setup([BILL({ status: "paid", amount_paid: 283 })], [PAPER({ payment: "paid_at_purchase" })]);
    const res = await run();
    expect(res.message).toContain("mark it paid on Bills");
  });
});

describe("Read Again: money and the customer's invoice come first (skeptic #84, S2 and S5)", () => {
  const sentInvoice = (status: string, via: "bill" | "po" = "bill") => {
    db.tables.invoices = [{ id: "inv-1", invoice_number: "INV-900", status }];
    db.tables.invoice_items = [{ id: "ii-1", invoice_id: "inv-1", edited: false, source_ids: [via === "po" ? "po-1" : "bill-1"], import_key: null }];
  };

  it("a bill a sent invoice already bills is refused before the Undo, naming the invoice and the credit memo", async () => {
    sentInvoice("sent");
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^INV-900 has gone to the customer and already bills this bill.*credit memo/);
    nothingMoved();
  });

  it("the order the bill delivered, billed on a sent invoice, refuses the same way", async () => {
    setup([BILL({ po_id: "po-1" })], [PAPER()]);
    sentInvoice("paid", "po");
    expect((await run()).error).toMatch(/already bills the order this bill delivered/);
    nothingMoved();
  });

  it("a draft claimant is not a wall here: Undo decides, as before", async () => {
    sentInvoice("draft");
    expect((await run()).ok).toBe(true);
  });

  it("a supplier payment recorded against the bill refuses before the Undo, naming the way: mark the lines Returned", async () => {
    db.tables.supplier_payment_allocations = [{ id: "a-1", org_id: "org-1", bill_id: "bill-1", amount: 283 }];
    const res = await run();
    expect(res.error).toMatch(/A supplier payment is recorded against this bill.*Mark the lines that went back Returned on the bill instead/);
    nothingMoved();
  });

  it("another company's allocation on the same bill id is never read", async () => {
    db.tables.supplier_payment_allocations = [{ id: "a-9", org_id: "org-2", bill_id: "bill-1", amount: 283 }];
    expect((await run()).ok).toBe(true);
  });

  it("a bill paid on account (not at purchase) refuses: the payment record would go with it", async () => {
    setup([BILL({ status: "paid", amount_paid: 283 })], [PAPER({ payment: "on_account" })]);
    expect((await run()).error).toMatch(/This bill is marked paid, and reading it again would take that record down with it/);
    nothingMoved();
  });

  it("part paid on account refuses too: any money recorded counts", async () => {
    setup([BILL({ status: "unpaid", amount_paid: 50 })], [PAPER({ payment: "on_account" })]);
    expect((await run()).error).toMatch(/marked paid/);
    nothingMoved();
  });

  it("a failed read of the claims or of the payments refuses, never taken for none", async () => {
    db = strictDb(db.tables, { fail: (t) => (t === "invoice_items" ? "boom" : undefined) });
    expect((await run()).error).toMatch(/couldn't be checked/);
    db = strictDb(db.tables, { fail: (t) => (t === "supplier_payment_allocations" ? "boom" : undefined) });
    expect((await run()).error).toMatch(/payments recorded on this bill couldn't be checked/);
    nothingMoved();
  });
});

describe("Read Again: the job-upload path", () => {
  it("rebuilds what the person stated from the old bill and its paper; says old total, new total, the pen marks", async () => {
    setup(
      [BILL({ category: "Receipt", bill_date: "2026-11-03", scope_category: "Rough-In" })],
      [PAPER({ source: "job", document_id: "doc-job", payment: "paid_at_purchase" })],
    );
    const res = await run();
    expect(doors.readTray).not.toHaveBeenCalled();
    expect(doors.fileTray).not.toHaveBeenCalled();
    expect(doors.billJob).toHaveBeenCalledWith("doc-job", { paid: true, category: "Receipt", billDate: "2026-11-03", scope: "Rough-In" });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("The total was $283.00 and is $290.50 now.");
    expect(res.message).toContain("Pen marks read: 1 line crossed out.");
  });

  it("the read fails after the Undo: the receipt stays on its job, and the answer names Record as Cost", async () => {
    setup([BILL()], [PAPER({ source: "job", document_id: "doc-job" })]);
    doors.billJob.mockResolvedValueOnce({ ok: false, error: "AI could not read this receipt." });
    const res = await run();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("The old bill ($283.00) is down.");
    expect(res.error).toContain("Record as Cost");
  });

  it("a job upload with no document link refuses before the Undo", async () => {
    setup([BILL()], [PAPER({ source: "job", document_id: null })]);
    expect((await run()).error).toMatch(/link to its job is missing/);
    nothingMoved();
  });
});

describe("readFiledPaperAgain, the server action", () => {
  it("is no longer the stub: it hands the core the real Undo, whose refusal comes back as it is", async () => {
    setup([BILL()], [PAPER()]);
    wired.client = db.sb;
    const { readFiledPaperAgain } = await import("./read-again-actions");
    const res = await readFiledPaperAgain("bill-1");
    expect(real.undoPaperwork).toHaveBeenCalledWith("oi-1");
    expect(res).toEqual({ ok: false, error: "Undo said no. Nothing was undone." });
  });
});
