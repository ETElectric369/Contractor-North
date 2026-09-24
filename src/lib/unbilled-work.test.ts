import { describe, it, expect } from "vitest";
import { claimantNumbers, claimedIdsOfLines, computeUnbilledWork, fixedBillingsToNet, foldClaims, joinNumbers, laborRowIds, type ClaimedSources } from "@/lib/unbilled-work";

/**
 * THE RUNNING TOTAL OF OPEN TIME AND MATERIALS (0255) — pure cores of unbilled-work.ts.
 *
 * The fetcher (unbilledWorkForJob) is a thin wrapper; the arithmetic that decides what a job can
 * still bill lives in these functions so it can be pinned without a database. The shape of the
 * 85 Whitney evening is the reference case: INV-061 (paid) holds nine entries and three bills;
 * Brian's 5.22 h on 09-10 and two CED bills ($467.37 + $1,062.18) are new; markup 25%.
 */

const brian = { id: "b", full_name: "Brian", bill_rate: 75 };
const erik = { id: "e", full_name: "Erik", bill_rate: 111 };
const punch = (id: string, profiles: any, hours: number) => ({
  id,
  clock_in: "2026-09-10T18:05:00Z",
  clock_out: new Date(Date.parse("2026-09-10T18:05:00Z") + hours * 3_600_000).toISOString(),
  lunch_minutes: 0,
  profiles,
});

const INV61 = { id: "i61", invoice_number: "INV-061", status: "paid", created_at: "2026-08-29T05:03:05Z" };

function claimsHolding(ids: string[], inv = INV61): ClaimedSources {
  return foldClaims([{ ...inv, invoice_items: [{ import_key: "labor:b", source_ids: ids }] }], true);
}

describe("foldClaims", () => {
  it("unions source_ids across the job's non-void invoices and maps each id to its claimant", () => {
    const c = foldClaims(
      [
        { id: "a", invoice_number: "INV-001", status: "paid", created_at: "2026-01-01T00:00:00Z", invoice_items: [{ import_key: "labor:b", source_ids: ["e1", "e2"] }] },
        { id: "b", invoice_number: "INV-002", status: "draft", created_at: "2026-02-01T00:00:00Z", invoice_items: [{ import_key: "labor:b", source_ids: ["e3"] }] },
      ],
      true,
    );
    expect([...c.owner.keys()].sort()).toEqual(["e1", "e2", "e3"]);
    expect(c.owner.get("e3")?.invoice_number).toBe("INV-002");
    expect(c.invoices.map((i) => i.invoice_number)).toEqual(["INV-002", "INV-001"]); // newest first
  });

  it("the EARLIEST invoice wins a contested id, whatever order the rows arrive in", () => {
    const rows = [
      { id: "late", invoice_number: "INV-009", status: "sent", created_at: "2026-03-01T00:00:00Z", invoice_items: [{ source_ids: ["x"] }] },
      { id: "early", invoice_number: "INV-001", status: "paid", created_at: "2026-01-01T00:00:00Z", invoice_items: [{ source_ids: ["x"] }] },
    ];
    expect(foldClaims(rows, true).owner.get("x")?.invoice_number).toBe("INV-001");
    expect(foldClaims([...rows].reverse(), true).owner.get("x")?.invoice_number).toBe("INV-001");
  });

  it("reads a materials claim from the import_key too (po:/bill:/bill:…:remainder/co:/quote:), never from bli:", () => {
    const u = "0af539c6-1111-4222-8333-444455556666";
    const c = foldClaims(
      [
        {
          id: "a", invoice_number: "INV-050", status: "paid", created_at: "2026-07-01T00:00:00Z",
          invoice_items: [
            { import_key: `bill:${u}:remainder` },
            { import_key: `bli:${u.replace("0af", "1af")}` },
            { import_key: `po:${u.replace("0af", "2af")}` },
          ],
        },
      ],
      false,
    );
    expect(c.owner.has(u)).toBe(true);
    expect(c.owner.has(u.replace("0af", "2af"))).toBe(true);
    expect(c.owner.has(u.replace("0af", "1af"))).toBe(false);
    expect(c.schemaReady).toBe(false);
  });

  it("CLAIMS ARE PER ROW, NOT PER JOB: an invoice found by id on ANOTHER job owns the entry but is not one of this job's invoices", () => {
    // e1 was billed on J-021's INV-058, then the entry was moved to J-028. J-028's own invoice list
    // says nothing about e1; the org-wide read by id does. It must be claimed, named with its job,
    // and NOT become J-028's "last invoice".
    const j28 = [{ id: "i61", invoice_number: "INV-061", status: "paid", created_at: "2026-08-29T00:00:00Z", invoice_items: [{ source_ids: ["e2"] }] }];
    const elsewhere = [{ id: "i58", invoice_number: "INV-058", status: "sent", created_at: "2026-07-01T00:00:00Z", job_id: "j21", jobs: { job_number: "J-021" }, invoice_items: [{ source_ids: ["e1"] }] }];
    const c = foldClaims(j28, true, elsewhere, "j28");
    expect(c.owner.get("e1")?.invoice_number).toBe("INV-058");
    expect(c.owner.get("e2")?.invoice_number).toBe("INV-061");
    expect(c.invoices.map((i) => i.invoice_number)).toEqual(["INV-061"]);
    expect(c.jobId).toBe("j28");
    expect(claimantNumbers(c, ["e1", "e2"])).toEqual(["INV-058 (J-021)", "INV-061"]);
    // An invoice on THIS job that the by-id read also returned keeps its fuller job-side lines.
    const both = foldClaims(j28, true, [{ ...j28[0], job_id: "j28", invoice_items: [{ source_ids: ["e2"] }] }], "j28");
    expect(both.invoices.length).toBe(1);
    expect(both.owner.get("e2")?.job_id).toBe("j28");
  });
});

describe("claimedIdsOfLines / laborRowIds — what a claim read asks about", () => {
  it("collects source_ids and the id a cost key names, once each, never a bli: line's key", () => {
    const u = "0af539c6-1111-4222-8333-444455556666";
    expect(claimedIdsOfLines([
      { import_key: "labor:b", source_ids: ["e1", "e2"] },
      { import_key: `bill:${u}:remainder`, source_ids: [u] },
      { import_key: `bli:${u.replace("0af", "1af")}`, source_ids: [u] },
      { import_key: null, source_ids: null },
    ]).sort()).toEqual([u, "e1", "e2"].sort());
    expect(claimedIdsOfLines(null)).toEqual([]);
  });

  it("names every entry on the job, once", () => {
    const labor = { jobEntries: [{ id: "e1" }, { id: "e2" }, { id: "e1" }, {}] };
    expect(laborRowIds(labor).sort()).toEqual(["e1", "e2"]);
  });
});

describe("claimantNumbers / joinNumbers", () => {
  it("names the invoices holding the given ids, oldest first, once each", () => {
    const c = foldClaims(
      [
        { id: "b", invoice_number: "INV-063", status: "sent", created_at: "2026-09-05T00:00:00Z", invoice_items: [{ source_ids: ["e3"] }] },
        { id: "a", invoice_number: "INV-061", status: "paid", created_at: "2026-08-29T00:00:00Z", invoice_items: [{ source_ids: ["e1", "e2"] }] },
      ],
      true,
    );
    expect(claimantNumbers(c, ["e3", "e1", "e2", "nope"])).toEqual(["INV-061", "INV-063"]);
    expect(joinNumbers(["INV-061"])).toBe("INV-061");
    expect(joinNumbers(["INV-061", "INV-063"])).toBe("INV-061 and INV-063");
    expect(joinNumbers(["INV-061", "INV-062", "INV-063"])).toBe("INV-061, INV-062 and INV-063");
    expect(joinNumbers([])).toBe("");
  });
});

describe("computeUnbilledWork — the 85 Whitney reference case", () => {
  const held = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "bill-a", "bill-b", "bill-c"];
  const base = {
    claims: claimsHolding(held),
    jobEntries: [...["e1", "e3", "e5", "e7", "e9"].map((id) => punch(id, erik, 4)), ...["e2", "e4", "e6", "e8"].map((id) => punch(id, brian, 4)), punch("e10", brian, 5.22)],
    nonBillableCodes: new Set<string>(),
    defaultRate: 0,
    levelRate: null,
    pos: [] as any[],
    bills: [
      { id: "bill-a", amount: 3034.54, po_id: null },
      { id: "bill-b", amount: 95.27, po_id: null },
      { id: "bill-c", amount: 376.86, po_id: null },
      { id: "bill-d", amount: 467.37, po_id: null },
      { id: "bill-e", amount: 1062.18, po_id: null },
    ],
    markupPct: 25,
  };

  it("bills only the new entry and the two new bills — ~$2,305, never the paid INV-061 rows", () => {
    const w = computeUnbilledWork(base);
    expect(w.hours).toBe(5.25);
    expect(w.laborAmount).toBe(393.75);
    expect(w.laborByPerson).toEqual([{ name: "Brian", hours: 5.25, amount: 393.75 }]);
    expect(w.billsCount).toBe(2);
    expect(w.billsAmount).toBe(1529.55);
    expect(w.markupPct).toBe(25);
    expect(w.billsBilled).toBe(1911.94); // 584.21 + 1327.73, marked up PER BILL like the importer
    expect(w.total).toBe(2305.69);
    expect(w.lastInvoiceNumber).toBe("INV-061");
    expect(w.lastInvoiceStatus).toBe("paid");
    expect(w.claimedCount).toBe(12);
    expect(w.claimedOn).toEqual(["INV-061"]);
    expect(w.schemaReady).toBe(true);
  });

  it("with everything claimed, total is 0 and the claimant is named — the 'Everything worked so far is already on INV-061' case", () => {
    const w = computeUnbilledWork({ ...base, claims: claimsHolding([...held, "e10", "bill-d", "bill-e"]) });
    expect(w.total).toBe(0);
    expect(w.hours).toBe(0);
    expect(w.billsCount).toBe(0);
    expect(w.claimedOn).toEqual(["INV-061"]);
    expect(w.claimedCount).toBe(15);
  });

  it("a brand-new job: nothing claimed, everything free, no last invoice", () => {
    const w = computeUnbilledWork({ ...base, claims: foldClaims([], true) });
    expect(w.hours).toBe(41.25); // 9 × 4h + 5.25h
    expect(w.billsCount).toBe(5);
    expect(w.lastInvoiceNumber).toBeNull();
    expect(w.claimedCount).toBe(0);
    expect(w.claimedOn).toEqual([]);
  });

  /**
   * HIS OSH RUN FOR JASON WALDOW (bills 905c9f3d on J-046, live row): $16.28 of receipt, two bags
   * of Kettle Chips and an ice cream bar switched off, ten bulk fasteners and $1.01 of tax on.
   * Nothing claims it. The card used to say $20.35 of unbilled material and the button beside it
   * wrote $8.13 - $12.22 of his own snacks with 25% on top, presented as money a customer owed.
   */
  const osh = {
    id: "bill-osh",
    amount: 16.28,
    po_id: null,
    bill_line_items: [
      { id: "o1", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
      { id: "o2", quantity: 1, unit_price: 2.09, amount: 2.09, category: "Other", billable: false },
      { id: "o3", quantity: 1, unit_price: 4.99, amount: 4.99, category: "Other", billable: false },
      { id: "o4", quantity: 10, unit_price: 0.61, amount: 6.1, category: "Fasteners", billable: true },
      { id: "o5", quantity: 1, unit_price: 1.01, amount: 1.01, category: "Tax", billable: true },
    ],
  };

  it("a receipt counts for what it BILLS, not what the box cost — the J-046 snacks", () => {
    const w = computeUnbilledWork({ ...base, claims: foldClaims([], true), jobEntries: [], bills: [osh] });
    expect(w.billsCount).toBe(1);
    expect(w.billsAmount).toBe(6.5); // 16.28 − 9.17 of snacks − their 0.61 share of the tax
    expect(w.excluded).toBe(9.78); // what he took off, so the card can say it rather than look wrong
    expect(w.billsBilled).toBe(8.13); // exactly what importCostsIntoInvoice writes
    expect(w.total).toBe(8.13);
  });

  it("a receipt that was ENTIRELY the company's own is not unbilled work at all", () => {
    const allOff = { ...osh, bill_line_items: osh.bill_line_items.map((l) => (l.category === "Tax" ? l : { ...l, billable: false })) };
    const w = computeUnbilledWork({ ...base, claims: foldClaims([], true), jobEntries: [], bills: [allOff] });
    expect(w.billsCount).toBe(0); // the importer emits no rows for it — "1 bill · $0.00" would be a lie
    expect(w.billsBilled).toBe(0);
    expect(w.excluded).toBe(16.28);
    expect(w.total).toBe(0);
  });

  it("a receipt with no lines read off it still bills its whole amount (hand-entered, unchanged)", () => {
    const w = computeUnbilledWork({ ...base, claims: foldClaims([], true), jobEntries: [], bills: [{ id: "b-hand", amount: 200, po_id: null }] });
    expect(w.billsAmount).toBe(200);
    expect(w.excluded).toBe(0);
    expect(w.billsBilled).toBe(250);
  });

  it("the PO a receipt supersedes is netted at the SUPPLIER'S charge, not at what the customer pays", () => {
    // A PO is an estimate of what the delivery COST; its bill supersedes it at cost. Netting only
    // the billable part would leave the snacks behind as an un-billed PO remainder.
    const w = computeUnbilledWork({
      ...base,
      claims: foldClaims([], true),
      jobEntries: [],
      pos: [{ id: "po-osh", total: 16.28, status: "sent" }],
      bills: [{ ...osh, po_id: "po-osh" }],
    });
    expect(w.billsCount).toBe(1); // the PO is fully superseded and gone; only the receipt is left
    expect(w.billsAmount).toBe(6.5);
  });

  it("a billed shift split on its own job adds nothing to bill, and says whose it is (0288)", () => {
    // split_time_entry appended the new piece's id to INV-061's line, so both pieces are held.
    const w = computeUnbilledWork({
      ...base,
      claims: claimsHolding(["e-brian", "e-brian-right"]),
      jobEntries: [punch("e-brian", brian, 1.5), punch("e-brian-right", brian, 0.5)],
      bills: [],
    });
    expect(w.hours).toBe(0);
    expect(w.laborAmount).toBe(0);
    expect(w.total).toBe(0);
    expect(w.claimedOn).toEqual(["INV-061"]);
  });

  it("the piece of an old split that no invoice billed is still billable — the J-013 half of the Jun 25 day", () => {
    // 0289 rebuilt Brian's Jun 25 shift as two entries: 1 h on J-016 (billed on INV-00032 by the
    // entry id it kept) and 2.5 h on J-013, a new entry nobody has billed.
    const w = computeUnbilledWork({
      ...base,
      claims: claimsHolding(["e-brian"], { id: "i32", invoice_number: "INV-00032", status: "paid", created_at: "2026-06-28T10:22:59.067Z" }),
      jobEntries: [punch("e-j013", brian, 2.5)],
      bills: [],
    });
    expect(w.hours).toBe(2.5);
    expect(w.laborAmount).toBe(187.5);
    expect(w.claimedOn).toEqual([]);
  });

  it("a live PO already billed elsewhere is skipped; its later supplier bill is left off and counted (never a double charge)", () => {
    const w = computeUnbilledWork({
      ...base,
      claims: claimsHolding(["po-1"]),
      pos: [{ id: "po-1", total: 500, status: "sent" }, { id: "po-2", total: 200, status: "sent" }],
      bills: [{ id: "bill-x", amount: 620, po_id: "po-1" }],
    });
    // po-1 is claimed → skipped; bill-x names po-1 → poCovered; po-2 is free.
    // livePurchaseOrders drops po-1 anyway (bill-x exceeds it), so the only material is po-2.
    expect(w.billsCount).toBe(1);
    expect(w.billsAmount).toBe(200);
    expect(w.poCoveredBills).toBe(1);
    expect(w.claimedOn).toEqual([]);
  });

  it("carries schemaReady:false through when 0255 hasn't landed, so callers can refuse rather than double-bill", () => {
    const w = computeUnbilledWork({ ...base, claims: foldClaims([], false) });
    expect(w.schemaReady).toBe(false);
  });
});

describe("fixedBillingsToNet — what a DELTA draw still credits", () => {
  it("nets a fixed deposit draw, minus the credit an earlier draw already issued", () => {
    const invoices = [
      { id: "dep", status: "paid", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: 10000 }] },
      { id: "d1", status: "paid", invoice_kind: "progress", invoice_items: [
        { import_source: "labor", line_total: 8000 },
        { import_source: "costs", line_total: 7000 },
        { import_source: "draw_credit", line_total: -10000 },
      ] },
    ];
    expect(fixedBillingsToNet(invoices)).toBe(0); // the deposit is fully netted → the next draw is pure delta
    expect(fixedBillingsToNet([invoices[0]])).toBe(10000); // nothing netted yet
  });

  it("NEVER nets a standard invoice — its hand lines are extras, not prepayments (the $400 referral on INV-061)", () => {
    const inv61 = { id: "i61", status: "paid", invoice_kind: "standard", invoice_items: [
      { import_source: "labor", line_total: 3162 },
      { import_source: "costs", line_total: 4870.15 },
      { import_source: null, line_total: 400 },
    ] };
    expect(fixedBillingsToNet([inv61])).toBe(0);
  });

  it("ignores drafts and void invoices; floors at $0", () => {
    expect(fixedBillingsToNet([
      { id: "a", status: "draft", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: 5000 }] },
      { id: "b", status: "void", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: 5000 }] },
      { id: "c", status: "paid", invoice_kind: "progress", invoice_items: [{ import_source: "draw_credit", line_total: -50 }] },
    ])).toBe(0);
  });

  it("a milestone draw is money against the job; a HAND LINE ON A DELTA DRAW is an extra, never a prepayment", () => {
    // "h" itemizes labor — it is a delta draw. The $300 typed under the hours ("Lift rental 4 hr")
    // is something the customer bought on that document, not money paid against the job. The old
    // rule netted it, which under-billed the next draw by $300.
    expect(fixedBillingsToNet([
      { id: "m", status: "sent", invoice_kind: "progress", invoice_items: [{ import_source: "milestone", line_total: 2500 }] },
      { id: "h", status: "sent", invoice_kind: "progress", invoice_items: [{ import_source: null, line_total: 300 }, { import_source: "labor", line_total: 900 }] },
    ])).toBe(2500);
  });

  it("a fixed-$ / %-of-estimate draw's OWN amount line is the lump — it carries no import_source, and nothing on the draw is itemized", () => {
    // createProgressInvoice writes exactly this shape: one unsourced line, no rows from the job.
    expect(fixedBillingsToNet([
      { id: "pct", status: "paid", invoice_kind: "progress", invoice_items: [{ import_source: null, line_total: 4000 }] },
      { id: "fix", status: "sent", invoice_kind: "final", invoice_items: [{ import_source: null, line_total: 1500 }] },
    ])).toBe(5500);
  });

  it("a deposit nets whatever it asked for, and a delta draw nets only its milestone / credit lines", () => {
    expect(fixedBillingsToNet([
      { id: "dep", status: "paid", invoice_kind: "deposit", invoice_items: [{ import_source: null, line_total: 2000 }, { import_source: null, line_total: 500 }] },
      { id: "delta", status: "sent", invoice_kind: "progress", invoice_items: [
        { import_source: "costs", line_total: 1200 },
        { import_source: null, line_total: 250 }, // hand extra on a delta draw — not netted
        { import_source: "draw_credit", line_total: -2500 },
      ] },
    ])).toBe(0); // 2500 asked for, 2500 credited; the $250 extra never entered the netting
  });
});
