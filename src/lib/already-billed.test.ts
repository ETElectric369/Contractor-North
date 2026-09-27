import { describe, it, expect } from "vitest";
import {
  askUsedAll,
  billAlreadyBilledDoors,
  eligibleInvoice,
  eligibleLines,
  hoursByHand,
  hoursCompareWords,
  invoiceCanHoldNoJobHours,
  jobAlreadyBilledDoors,
  lineLabel,
  markedSentence,
  personOfLine,
  precheckHours,
  preselectLine,
  jobCanHold,
  jobReach,
  noJobCanHoldHours,
  noJobHandsShown,
  noJobListOrder,
  noJobPreticked,
  noJobStrayDoors,
  sortInvoicesFor,
  tickTogether,
  type AbEntry,
  type AbInvoice,
  type AbLine,
} from "./already-billed";

/**
 * ALREADY BILLED: WHAT THE SHEET OFFERS AND TICKS (lib/already-billed). ET's own invoices, as they
 * stand: INV-00023 (Purple Sage J-010, paid, written 6/22 and sent 9/6), INV-060 (Badger J-039),
 * INV-076's hand "Discount" (-$120), INV-078 (Andrew's running draft).
 */

const line = (o: Partial<AbLine> & { id: string }): AbLine => ({
  description: "TEST",
  quantity: 1,
  unit: "ea",
  unit_price: 0,
  line_total: 0,
  import_source: null,
  import_key: null,
  edited: false,
  line_kind: null,
  sort_order: 0,
  ...o,
});
const inv = (o: Partial<AbInvoice> & { lines: AbLine[] }): AbInvoice => ({
  id: "inv",
  invoice_number: "INV-00023",
  status: "paid",
  invoice_kind: "standard",
  job_id: "j-010",
  created_at: "2026-06-22T04:57:19.535Z",
  ...o,
});

const INV00023 = inv({
  lines: [
    line({ id: "brian", description: "Labor — Brian Taylor", quantity: 2, unit: "hr", line_total: 200, import_source: "labor", edited: true, sort_order: 0 }),
    line({ id: "materials", description: "Materials", line_total: 110, sort_order: 1 }),
    line({ id: "erik", description: "Labor — Erik Taylor", quantity: 6.5, unit: "hr", line_total: 780, import_source: "labor", edited: true, sort_order: 2 }),
  ],
});

describe("which invoices can hold it", () => {
  it("any status but draft or void, never a deposit (partial and overdue included)", () => {
    for (const status of ["sent", "partial", "paid", "overdue"]) expect(eligibleInvoice({ status, invoice_kind: "standard" })).toBe(true);
    expect(eligibleInvoice({ status: "draft", invoice_kind: "standard" })).toBe(false);
    expect(eligibleInvoice({ status: "void", invoice_kind: "standard" })).toBe(false);
    expect(eligibleInvoice({ status: "paid", invoice_kind: "deposit" })).toBe(false);
    // Herringbone's draws are claimants too: a sent progress or final draw can hold it.
    expect(eligibleInvoice({ status: "sent", invoice_kind: "progress" })).toBe(true);
    expect(eligibleInvoice({ status: "sent", invoice_kind: null })).toBe(true);
  });

  it("the bill written on or after the cost comes first, nearest first; older ones follow, never dropped", () => {
    const a = { id: "a", created_at: "2026-05-01T00:00:00Z" };
    const b = { id: "b", created_at: "2026-06-22T04:57:19Z" };
    const c = { id: "c", created_at: "2026-08-01T00:00:00Z" };
    const d = { id: "d", created_at: "2026-06-01T00:00:00Z" };
    expect(sortInvoicesFor([a, b, c, d], "2026-06-16").map((x) => x.id)).toEqual(["b", "c", "d", "a"]);
    expect(sortInvoicesFor([a, b, c, d], null).map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("which lines can hold it", () => {
  it("Purple Sage: the typed Materials line is offered first for a receipt, and preselected; the edited labor lines follow", () => {
    const lines = eligibleLines(INV00023, { kind: "bill" });
    expect(lines.map((l) => l.id)).toEqual(["materials", "brian", "erik"]);
    expect(preselectLine(INV00023, lines, "bill")).toBe("materials");
    expect(lineLabel(INV00023, lines[0])).toBe("INV-00023 · Materials · $110.00");
  });

  it("hours: labor lines first; two of them, so nothing is preselected", () => {
    const lines = eligibleLines(INV00023, { kind: "time" });
    expect(lines.map((l) => l.id)).toEqual(["brian", "erik", "materials"]);
    expect(preselectLine(INV00023, lines, "time")).toBeNull();
  });

  it("never an imported line nobody edited (the next import rewrites it), a credit, a contract line or $0", () => {
    const i = inv({
      invoice_kind: "progress",
      lines: [
        line({ id: "imported", description: "14-2 NM W/G 100 FT", line_total: 186.48, import_source: "costs", import_key: "bli:x" }),
        line({ id: "edited", description: "Supplies & tax — CED", line_total: 26.12, import_source: "costs", import_key: "bill:y:remainder", edited: true }),
        line({ id: "credit", description: "Less previous billings", line_total: -500, import_source: "draw_credit" }),
        line({ id: "milestone", description: "Rough-in", line_total: 2000, import_source: "milestone" }),
        line({ id: "zero", description: "Nothing", line_total: 0 }),
        line({ id: "extra", description: "Lift rental", line_total: 120 }),
      ],
    });
    expect(eligibleLines(i, { kind: "bill" }).map((l) => l.id)).toEqual(["edited", "extra"]);
  });

  it("a draw that bills none of the job's rows is a payment request: its lines are lump money, never offered", () => {
    const i = inv({ invoice_kind: "progress", lines: [line({ id: "lump", description: "50% of the contract", line_total: 5000 })] });
    expect(eligibleLines(i, { kind: "bill" })).toEqual([]);
  });

  it("a charge filed as Other (a fee, a referral) is not work", () => {
    const i = inv({ lines: [line({ id: "fee", description: "Card fee", line_total: 12, line_kind: "other" }), line({ id: "work", description: "Install", line_total: 400 })] });
    expect(eligibleLines(i, { kind: "bill" }).map((l) => l.id)).toEqual(["work"]);
  });

  it("a return goes only on a line typed by hand that takes money off (INV-076's Discount), never a credit line", () => {
    const i = inv({
      invoice_number: "INV-076",
      lines: [
        line({ id: "labor", description: "Labor, Erik (rewired kitchen switches)", unit: "hr", line_total: 875 }),
        line({ id: "discount", description: "Discount", line_total: -120 }),
        line({ id: "less", description: "Less previous billings", line_total: -300 }),
        line({ id: "returned", description: "Returned: LED housing", line_total: -40, import_source: "costs", import_key: "bill:r", edited: true }),
      ],
    });
    expect(eligibleLines(i, { kind: "bill", negative: true }).map((l) => l.id)).toEqual(["discount"]);
    expect(eligibleLines(i, { kind: "bill" }).map((l) => l.id)).toEqual(["labor"]);
  });
});

describe("Did J-010 Use All Of It?", () => {
  it("asked when Shop Stock is on, the receipt has lines, and the line is less than its cost ($110 against $186.93)", () => {
    expect(askUsedAll({ shopStock: true, billHasLines: true, billCost: 186.93, lineTotal: 110 })).toBe(true);
  });
  it("not asked with Shop Stock off, a receipt with no lines, or a line at or over the cost", () => {
    expect(askUsedAll({ shopStock: false, billHasLines: true, billCost: 186.93, lineTotal: 110 })).toBe(false);
    expect(askUsedAll({ shopStock: true, billHasLines: false, billCost: 186.93, lineTotal: 110 })).toBe(false);
    expect(askUsedAll({ shopStock: true, billHasLines: true, billCost: 186.93, lineTotal: 233.66 })).toBe(false);
    expect(askUsedAll({ shopStock: true, billHasLines: true, billCost: 110, lineTotal: 110 })).toBe(false);
  });
});

describe("the hours a line charged: its person, up to the day the bill was WRITTEN", () => {
  const TZ = "America/Los_Angeles";
  const e = (id: string, person: string, name: string, clockIn: string, hours = 8): AbEntry => ({ id, person, name, clockIn, hours });
  const entries = [
    e("b1", "p-brian", "Brian Taylor", "2026-06-16T15:00:00Z"),
    e("b2", "p-brian", "Brian Taylor", "2026-06-17T15:00:00Z", 4.5),
    // Worked after INV-00023 was written (6/22) and before it was sent (9/6): never ticked.
    e("b3", "p-brian", "Brian Taylor", "2026-07-01T15:00:00Z"),
    e("e1", "p-erik", "Erik Taylor", "2026-06-16T15:00:00Z"),
  ];

  it("a hand line 'Labor - Brian' ticks only Brian's shifts up to 6/22, not the 76 days until it was sent", () => {
    const r = precheckHours(entries, { import_key: null, description: "Labor - Brian" }, "2026-06-22T04:57:19.535Z", TZ);
    expect(r.person).toBe("p-brian");
    expect(r.checked).toEqual(["b1", "b2"]);
  });

  it("the written day is the company's day: 9:57 PM on 6/21 in Truckee is 6/21, so a 6/22 shift is not ticked", () => {
    const late = [e("x", "p-brian", "Brian Taylor", "2026-06-22T15:00:00Z")];
    expect(precheckHours(late, { import_key: null, description: "Labor - Brian" }, "2026-06-22T04:57:19.535Z", TZ).checked).toEqual([]);
  });

  it("an imported line names its person by key", () => {
    expect(personOfLine({ import_key: "labor:p-erik", description: "Labor — Erik" }, entries)).toBe("p-erik");
    expect(personOfLine({ import_key: "labor:p-erik:2", description: "Labor — Erik" }, entries)).toBe("p-erik");
  });

  it("words naming two people, or nobody, tick nothing: the office decides", () => {
    expect(personOfLine({ import_key: null, description: "Labor - Taylor crew" }, entries)).toBeNull();
    expect(personOfLine({ import_key: null, description: "Materials" }, entries)).toBeNull();
    expect(precheckHours(entries, { import_key: null, description: "Labor" }, "2026-06-22T04:57:19Z", TZ).checked).toEqual([]);
  });

  it("a split shift is ticked whole: to start, and when one piece is ticked or unticked", () => {
    const split = [
      { ...e("s1", "p-brian", "Brian Taylor", "2026-06-20T15:00:00Z", 4), family: "s1" },
      { ...e("s2", "p-brian", "Brian Taylor", "2026-06-20T19:00:00Z", 4), family: "s1" },
      e("other", "p-brian", "Brian Taylor", "2026-06-21T15:00:00Z", 2),
    ];
    expect(tickTogether(split, new Set(), "s2", true)).toEqual(new Set(["s1", "s2"]));
    expect(tickTogether(split, new Set(["s1", "s2", "other"]), "s1", false)).toEqual(new Set(["other"]));
    // A piece worked after the cutoff still goes with the piece before it.
    const late = [
      { ...e("a", "p-brian", "Brian Taylor", "2026-06-22T06:00:00Z", 1), family: "a" },
      { ...e("b", "p-brian", "Brian Taylor", "2026-06-22T08:00:00Z", 1), family: "a" },
    ];
    expect(precheckHours(late, { import_key: null, description: "Labor - Brian" }, "2026-06-22T06:30:00Z", TZ).checked).toEqual(["a", "b"]);
  });

  it("says the line's hours beside what is ticked: Line: 13 h · Checked: 12.5 h", () => {
    expect(hoursCompareWords({ unit: "hr", quantity: 13 }, 12.5)).toBe("Line: 13 h · Checked: 12.5 h");
    expect(hoursCompareWords({ unit: "ea", quantity: 1 }, 12.5)).toBe("Checked: 12.5 h");
    // What the line already holds, when it holds some (INV-069's hand-bumped "Labor — Erik").
    expect(hoursCompareWords({ unit: "hr", quantity: 30.5, heldHours: 27.5 }, 3)).toBe("Line: 30.5 h · Already Holds: 27.5 h · Checked: 3 h");
  });

  it("INV-069: a line of 30.5 h already holding 27.5 h ticks only the 3 h it has room for, oldest first", () => {
    const erik = [
      e("x1", "p-erik", "Erik Taylor", "2026-09-10T15:00:00Z", 3),
      e("x2", "p-erik", "Erik Taylor", "2026-09-11T15:00:00Z", 2),
      e("x3", "p-erik", "Erik Taylor", "2026-09-12T15:00:00Z", 4),
    ];
    const labor = { import_key: "labor:p-erik", description: "Labor — Erik", unit: "hr", quantity: 30.5, heldHours: 27.5 };
    const r = precheckHours(erik, labor, "2026-09-18T20:00:00Z", TZ);
    expect(r.checked).toEqual(["x1"]);
    expect(r.covered).toBe(false);
    // Already covered: nothing is ticked, and it says why.
    const full = precheckHours(erik, { ...labor, heldHours: 30.5 }, "2026-09-18T20:00:00Z", TZ);
    expect(full.checked).toEqual([]);
    expect(full.covered).toBe(true);
    // Holding nothing, the line's own hours are still the ceiling.
    expect(precheckHours(erik, { ...labor, quantity: 5, heldHours: 0 }, "2026-09-18T20:00:00Z", TZ).checked).toEqual(["x1", "x2"]);
    // A line not billed in hours that already holds some: how much it covers can't be told, so nothing.
    const lump = precheckHours(erik, { import_key: "labor:p-erik", description: "Labor — Erik", unit: "ea", quantity: 1, heldHours: 6 }, "2026-09-18T20:00:00Z", TZ);
    expect(lump.checked).toEqual([]);
    expect(lump.covered).toBe(true);
  });
});

describe("the Costs tab's doors, from what the page read", () => {
  const groups = { open: { ids: ["bill-open", "po-open", "stock:g1", "bill-return"] }, billed: [{ ids: ["bill-hand", "bill-imported", "stock:g2"] }] };
  const bills = [
    { id: "bill-open", supplier: "OSH", bill_number: null },
    { id: "bill-return", supplier: "CED", bill_number: "8802-R", amount: -40 },
    { id: "bill-hand", supplier: "Consolidated Electrical Distributors", bill_number: "8802-1101475" },
    { id: "bill-imported", supplier: "CED", bill_number: "8802-1" },
  ];
  const pos = [{ id: "po-open", po_number: "PO-00012", vendor: "CED" }];
  const takes = [
    { key: "stock:g1", moveIds: ["m1", "m2"], label: "From Stock · 12/2 NM-B, 40 ft" },
    { key: "stock:g2", moveIds: ["m3"], label: "From Stock · GFCI, 2 ea" },
  ];
  const hands = new Map([
    ["bill-hand", { lineId: "li-materials", invoiceNumber: "INV-00023" }],
    ["m3", { lineId: "li-x", invoiceNumber: "INV-00024" }],
  ]);

  const both = { charge: true, ret: true };
  it("Already Billed on every open row when a sent bill could hold it; a take marks every move", () => {
    const d = jobAlreadyBilledDoors({ groups, bills, pos, takes, hands, offer: both });
    expect(Object.keys(d.open)).toEqual(["bill-open", "po-open", "stock:g1", "bill-return"]);
    expect(d.open["stock:g1"]).toEqual({ kind: "stock", ids: ["m1", "m2"], what: "From Stock · 12/2 NM-B, 40 ft" });
    expect(d.open["po-open"].what).toBe("PO-00012 · CED");
  });

  it("no line on a sent bill could hold it: no door, not a door onto a sheet with nothing to pick", () => {
    expect(jobAlreadyBilledDoors({ groups, bills, pos, takes, hands, offer: { charge: false, ret: false } }).open).toEqual({});
    // Lines that can hold a charge but none that takes money off: the return gets no door.
    expect(Object.keys(jobAlreadyBilledDoors({ groups, bills, pos, takes, hands, offer: { charge: true, ret: false } }).open)).toEqual(["bill-open", "po-open", "stock:g1"]);
    // Only a line that takes money off: only the return.
    expect(Object.keys(jobAlreadyBilledDoors({ groups, bills, pos, takes, hands, offer: { charge: false, ret: true } }).open)).toEqual(["bill-return"]);
  });

  it("which bills can hold what: an invoice of imports nobody edited holds nothing; a typed Discount holds a return", () => {
    const imported = inv({ lines: [line({ id: "i1", description: "14-2 NM", line_total: 186.48, import_source: "costs", import_key: "bli:x" })] });
    expect(jobCanHold([imported])).toEqual({ charge: false, ret: false });
    expect(jobCanHold([INV00023])).toEqual({ charge: true, ret: false });
    const withDiscount = inv({ lines: [line({ id: "d", description: "Discount", line_total: -120 })] });
    expect(jobCanHold([imported, withDiscount])).toEqual({ charge: false, ret: true });
    // A draft holds nothing yet.
    expect(jobCanHold([{ ...INV00023, status: "draft" }])).toEqual({ charge: false, ret: false });
  });

  it("Not Billed After All only on rows a person marked, never on an importer's claim", () => {
    const d = jobAlreadyBilledDoors({ groups, bills, pos, takes, hands, offer: both });
    expect(d.hands).toEqual({
      "bill-hand": { lineId: "li-materials", ids: ["bill-hand"], invoiceNumber: "INV-00023", what: "Consolidated Electrical Distributors 8802-1101475" },
      "stock:g2": { lineId: "li-x", ids: ["m3"], invoiceNumber: "INV-00024", what: "From Stock · GFCI, 2 ea" },
    });
    expect(jobAlreadyBilledDoors({ groups, bills, pos, takes, hands: null, offer: both }).hands).toEqual({});
  });

  it("the hours a person marked, per line: INV-059's 'Labor - Brian' holds 2 shifts, 6.5 h", () => {
    const rows = hoursByHand(
      [
        { id: "t1", clock_in: "2026-08-10T15:00:00Z", clock_out: "2026-08-10T19:00:00Z", lunch_minutes: 0, profiles: { full_name: "Brian Taylor" } },
        { id: "t2", clock_in: "2026-08-11T15:00:00Z", clock_out: "2026-08-11T18:00:00Z", lunch_minutes: 30, profiles: { full_name: "Brian Taylor" } },
        { id: "t3", clock_in: "2026-08-12T15:00:00Z", clock_out: "2026-08-12T18:00:00Z", lunch_minutes: 0, profiles: { full_name: "Erik Taylor" } },
      ],
      new Map([
        ["t1", { lineId: "li-brian", invoiceNumber: "INV-059" }],
        ["t2", { lineId: "li-brian", invoiceNumber: "INV-059" }],
      ]),
    );
    expect(rows).toEqual([{ lineId: "li-brian", invoiceId: null, invoiceNumber: "INV-059", ids: ["t1", "t2"], hours: 6.5, what: "6.5 h of Brian Taylor's time" }]);
  });
});

describe("the sentence", () => {
  it("says what, where, and that nothing on the bill changed", () => {
    expect(markedSentence("CED 8802-1101475", { invoice_number: "INV-00023" }, { description: "Materials", line_total: 110 })).toBe(
      "CED 8802-1101475 is billed on INV-00023 (Materials $110.00). Nothing on INV-00023 changed.",
    );
  });
});

describe("one door rule: the sheet's own (New Invoice's nextInvoiceImportsActuals, then a line that could hold it)", () => {
  it("a job New Invoice bills by its contract gets no door, whatever its bills hold", () => {
    expect(jobReach(false, [INV00023])).toEqual({ charge: false, ret: false });
  });
  it("a job whose next New Invoice pulls its actuals gets the door where a sent bill could hold it", () => {
    expect(jobReach(true, [INV00023])).toEqual({ charge: true, ret: false });
    expect(jobReach(true, [inv({ status: "draft", lines: INV00023.lines })])).toEqual({ charge: false, ret: false });
  });
});

describe("the bill's own row on /bills (Erik: 'the Already Billed could connect to the bill on that screen too')", () => {
  const reach = new Map([
    ["j-010", { charge: true, ret: false }],
    ["j-039", { charge: true, ret: true }],
    ["j-fixed", { charge: false, ret: false }],
  ]);
  const b = (o: { id: string; job_id?: string | null; po_id?: string | null; amount?: number; superseded?: boolean }) => ({ what: `CED ${o.id}`, amount: 100, ...o });
  it("Already Billed on a bill on a job no invoice holds, where the job's sheet could hold it", () => {
    const doors = billAlreadyBilledDoors({ bills: [b({ id: "ps", job_id: "j-010", amount: 186.93 })], reach, hands: new Map(), claimed: new Set() });
    expect(doors).toEqual({ ps: { kind: "open", jobId: "j-010", what: "CED ps" } });
  });
  it("Billed By Hand On INV-x with its way back on a bill a person marked", () => {
    const doors = billAlreadyBilledDoors({
      bills: [b({ id: "ps", job_id: "j-010" })],
      reach,
      hands: new Map([["ps", { lineId: "li-mat", invoiceNumber: "INV-00023" }]]),
      claimed: new Set(["ps"]),
    });
    expect(doors).toEqual({ ps: { kind: "hand", jobId: "j-010", lineId: "li-mat", ids: ["ps"], invoiceNumber: "INV-00023", what: "CED ps" } });
  });
  it("nothing on a bill an invoice holds (or whose order it holds), a $0.00 one, a set-aside copy, one on no job, or one whose job bills by its contract", () => {
    const doors = billAlreadyBilledDoors({
      bills: [
        b({ id: "imported", job_id: "j-010" }),
        b({ id: "via-order", job_id: "j-010", po_id: "po-1" }),
        b({ id: "zero", job_id: "j-010", amount: 0 }),
        b({ id: "copy", job_id: "j-010", superseded: true }),
        b({ id: "shop", job_id: null }),
        b({ id: "fixed", job_id: "j-fixed" }),
        b({ id: "unread", job_id: "j-nobody-read" }),
      ],
      reach,
      hands: new Map(),
      claimed: new Set(["imported", "po-1"]),
    });
    expect(doors).toEqual({});
  });
  it("only what New Invoice would bill (the Costs tab's own test): never a receipt that is all the company's own, or a return with nothing the customer was billed for", () => {
    const own = [
      { id: "chips", description: "Kettle Chips", amount: 4.29, billable: false },
      { id: "bar", description: "Ice cream bar", amount: 3.5, billable: false },
    ];
    const part = [{ id: "gfci", description: "GFCI", amount: 60 }, ...own];
    const doors = billAlreadyBilledDoors({
      bills: [
        { ...b({ id: "snacks", job_id: "j-010", amount: 7.79 }), lines: own },
        { ...b({ id: "mixed", job_id: "j-010", amount: 67.79 }), lines: part },
        { ...b({ id: "lump", job_id: "j-010", amount: 186.93 }), lines: [] },
        { ...b({ id: "ret-own", job_id: "j-039", amount: -7.79 }), lines: own.map((l) => ({ ...l, amount: -l.amount })) },
        { ...b({ id: "ret-part", job_id: "j-039", amount: -60 }), lines: [{ id: "gfci-back", description: "GFCI", amount: -60 }] },
      ],
      reach,
      hands: new Map(),
      claimed: new Set(),
    });
    expect(Object.keys(doors).sort()).toEqual(["lump", "mixed", "ret-part"]);
  });
  it("a supplier return gets the door only where a line typed by hand takes money off", () => {
    const doors = billAlreadyBilledDoors({
      bills: [b({ id: "ret-010", job_id: "j-010", amount: -25 }), b({ id: "ret-039", job_id: "j-039", amount: -25 })],
      reach,
      hands: new Map(),
      claimed: new Set(),
    });
    expect(Object.keys(doors)).toEqual(["ret-039"]);
  });
});

describe("hours on NO job (TTUSD on INV-055, Ben Ebenezer on INV-058)", () => {
  const INV055 = inv({
    id: "inv-55",
    invoice_number: "INV-055",
    job_id: null,
    lines: [line({ id: "jp", description: "Labor - JP Prince", quantity: 23, unit: "hr", line_total: 2185 }), line({ id: "fee", description: "Card fee", line_total: 12, line_kind: "other" })],
  });
  it("a sent invoice with no job and a line of work typed by hand can hold them; a draft, a void, a job's invoice or an untouched import can't", () => {
    expect(noJobCanHoldHours([INV055])).toBe(true);
    expect(noJobCanHoldHours([{ ...INV055, status: "draft" }])).toBe(false);
    expect(noJobCanHoldHours([{ ...INV055, status: "void" }])).toBe(false);
    expect(noJobCanHoldHours([{ ...INV055, job_id: "j-010" }])).toBe(false);
    expect(noJobCanHoldHours([{ ...INV055, lines: [line({ id: "imp", line_total: 500, import_source: "labor", unit: "hr", quantity: 5 })] }])).toBe(false);
  });
  it("the invoice page's way in (Already Billed: Hours On No Job): a sent invoice with no job and a line of work typed by hand; never a draft, a void, a deposit, a job's invoice or one with only a fee", () => {
    const row = { id: "inv-55", invoice_number: "INV-055", status: "paid", invoice_kind: "standard", job_id: null, created_at: "2026-08-08T18:00:00Z" };
    const jp = { id: "jp", description: "Labor - JP Prince", quantity: 23, unit: "hr", unit_price: 95, line_total: 2185, import_source: null, edited: false, line_kind: null };
    const fee = { ...jp, id: "fee", description: "Card fee", quantity: 1, unit: "ea", unit_price: 12, line_total: 12, line_kind: "other" };
    expect(invoiceCanHoldNoJobHours(row, [jp, fee])).toBe(true);
    expect(invoiceCanHoldNoJobHours({ ...row, status: "draft" }, [jp])).toBe(false);
    expect(invoiceCanHoldNoJobHours({ ...row, status: "void" }, [jp])).toBe(false);
    expect(invoiceCanHoldNoJobHours({ ...row, invoice_kind: "deposit" }, [jp])).toBe(false);
    expect(invoiceCanHoldNoJobHours({ ...row, job_id: "j-010" }, [jp])).toBe(false);
    expect(invoiceCanHoldNoJobHours(row, [fee])).toBe(false);
  });
  it("the invoice page shows its Hours On No Job, Billed By Hand Here only on an invoice with no job that isn't void (a void one's Not Billed After All could only fail)", () => {
    expect(noJobHandsShown({ job_id: null, status: "sent" })).toBe(true);
    expect(noJobHandsShown({ job_id: null, status: "paid" })).toBe(true);
    expect(noJobHandsShown({ job_id: null, status: "void" })).toBe(false);
    expect(noJobHandsShown({ job_id: "j-010", status: "sent" })).toBe(false);
  });
  const e = (id: string, family?: string): AbEntry => ({ id, person: "p-jp", name: "JP Prince", clockIn: `2026-08-0${id.slice(-1)}T15:00:00Z`, hours: 8, family });
  it("ticks only the shift the door was pressed on, a split shift whole; a shift no longer open ticks nothing", () => {
    const entries = [e("t6"), e("t7a"), e("t7b", "t7a"), e("t8")];
    expect(noJobPreticked(entries, ["t6"])).toEqual(["t6"]);
    expect(noJobPreticked(entries, ["t7b"])).toEqual(["t7a", "t7b"]);
    expect(noJobPreticked(entries, ["gone"])).toEqual([]);
    expect(noJobPreticked(entries, [])).toEqual([]);
  });
  it("lists what he pressed on first (a split shift's pieces in order), then every other shift newest first", () => {
    const at = (id: string, clockIn: string, family?: string): AbEntry => ({ id, person: "p-jp", name: "JP Prince", clockIn, hours: 4, family });
    const entries = [
      at("jul16", "2026-07-16T15:00:00Z"),
      at("aug06", "2026-08-06T15:00:00Z"),
      at("sep25-pm", "2026-09-25T20:00:00Z", "sep25-am"),
      at("sep25-am", "2026-09-25T15:00:00Z"),
      at("aug07", "2026-08-07T15:00:00Z"),
    ];
    const ids = (pressed: string[]) => noJobListOrder(entries, pressed).map((x) => x.id);
    expect(ids(["sep25-am", "sep25-pm"])).toEqual(["sep25-am", "sep25-pm", "aug07", "aug06", "jul16"]);
    expect(ids(["aug06"])).toEqual(["aug06", "sep25-pm", "sep25-am", "aug07", "jul16"]);
    expect(ids([])).toEqual(["sep25-pm", "sep25-am", "aug07", "aug06", "jul16"]);
  });
  it("Needs You: a shift a live invoice holds is billed (no row); the rest get Already Billed where an invoice with no job could hold them", () => {
    expect(noJobStrayDoors(["a", "b"], { canHold: true, claimed: new Set(["a"]) })).toEqual({ billed: new Set(["a"]), door: new Set(["b"]) });
    expect(noJobStrayDoors(["a", "b"], { canHold: false, claimed: new Set() })).toEqual({ billed: new Set(), door: new Set() });
    // A lost read keeps every row and offers the door (the sheet says what it finds).
    expect(noJobStrayDoors(["a", "b"], null)).toEqual({ billed: new Set(), door: new Set(["a", "b"]) });
  });
});
