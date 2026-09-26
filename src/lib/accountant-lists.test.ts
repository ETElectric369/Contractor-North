import { describe, it, expect } from "vitest";
import {
  ACCOUNTANT_LISTS,
  HEADERS,
  accountantList,
  dataRowCount,
  exportWindow,
  onHandList,
  parseWindow,
  stockBoughtList,
  stockUsedList,
  toCsv,
  toolsBilledList,
  toolsList,
  type AccountantInputs,
} from "@/lib/accountant-lists";

const TZ = "America/Los_Angeles";

/**
 * Herringbone's 8/19 coil on the shelf ($180.17 for 250 ft), and a September of upkeep on it:
 * 60 ft onto another job, 10 ft ruined, 50 ft back to CED against a $30.00 credit filed to the
 * shelf, 10 ft of the take brought back. A Twister box counted in at $0. Two tool tickets.
 */
const inputs = (): AccountantInputs => ({
  items: [
    { id: "i-122", name: "12/2 NM-B", unit: "ft" },
    { id: "i-tw", name: "Twister 341-Tan", unit: "ea" },
  ],
  lots: [
    { lot_id: "L1", item_id: "i-122", kind: "line", bill_id: "h1", pieces: "250", unit: "ft", cost: "180.17", bought_on: "2026-08-19", live: true, note: null },
    { lot_id: "L2", item_id: "i-tw", kind: "opening", bill_id: null, pieces: "440", unit: "ea", cost: "0", bought_on: "2026-09-25", live: true, note: "The rest of Waldow's box (INV-069 paid)" },
    // Taken back off the shelf: never stock bought, never on hand.
    { lot_id: "L0", item_id: "i-122", kind: "line", bill_id: "h0", pieces: "250", unit: "ft", cost: "180.17", bought_on: "2026-07-31", live: false, note: null },
  ],
  moves: [
    { id: "d1", item_id: "i-122", lot_id: "L1", job_id: "J13", kind: "draw", qty: "60", cost: "43.24", note: null, created_at: "2026-09-10T18:00:00Z", undone_at: null, settled_by: null },
    { id: "w1", item_id: "i-122", lot_id: "L1", job_id: null, kind: "write_off", qty: "10", cost: "7.21", note: "Ruined in the rain", created_at: "2026-09-12T18:00:00Z", undone_at: null, settled_by: null },
    { id: "w0", item_id: "i-122", lot_id: "L1", job_id: null, kind: "write_off", qty: "5", cost: "3.60", note: "oops", created_at: "2026-09-12T19:00:00Z", undone_at: "2026-09-12T19:05:00Z", settled_by: null },
    { id: "r1", item_id: "i-122", lot_id: "L1", job_id: null, kind: "supplier_return", qty: "50", cost: "36.03", note: null, created_at: "2026-09-15T18:00:00Z", undone_at: null, settled_by: null, credit_bill_id: "cr1" },
    { id: "b1", item_id: "i-122", lot_id: "L1", job_id: "J13", kind: "job_return", qty: "10", cost: "7.21", note: null, created_at: "2026-09-16T18:00:00Z", undone_at: null, settled_by: null },
  ],
  bills: [
    { id: "h1", supplier: "Consolidated Electrical Dist.", bill_number: null, bill_date: "2026-08-19", created_at: "2026-09-11T18:20:07Z", job_id: "J11", amount: "199.48", category: "Receipt", on_shelf: false },
    { id: "cr1", supplier: "Consolidated Electrical Dist.", bill_number: "8802-CM1", bill_date: "2026-09-15", created_at: "2026-09-15T20:00:00Z", job_id: null, amount: "-30", category: "Credit", on_shelf: true },
    { id: "ts", supplier: "Consolidated Electrical Dist.", bill_number: "8802-TS", bill_date: "2026-09-24", created_at: "2026-09-24T20:00:00Z", job_id: null, amount: "44.44", category: "Tools & Supplies", on_shelf: false },
    { id: "hd", supplier: "The Home Depot", bill_number: null, bill_date: "2026-06-12", created_at: "2026-06-12T20:00:00Z", job_id: "J02", amount: "545", category: "Receipt", on_shelf: false },
  ],
  lines: [
    { id: "ts1", bill_id: "ts", description: "SANT 3000CED Ultimate AC Sensor Tester", quantity: 1, unit_price: 19.62, amount: 19.62, category: "Tools", billable: true, billed_amount: null },
    { id: "ts2", bill_id: "ts", description: "SANT 3115CED AC Sensor", quantity: 1, unit_price: 21.15, amount: 21.15, category: "Tools", billable: true, billed_amount: null },
    { id: "ts3", bill_id: "ts", description: "Sales Tax", quantity: 1, unit_price: 3.67, amount: 3.67, category: "Tax", billable: true, billed_amount: null },
    { id: "hd1", bill_id: "hd", description: "MKE 18V GEN2 SUPERHAWG", quantity: 1, unit_price: 400, amount: 400, category: "Tools", billable: true, billed_amount: null },
    { id: "hd2", bill_id: "hd", description: "AUGER BIT, 1 IN.", quantity: 1, unit_price: 100, amount: 100, category: "Tools", billable: false, billed_amount: null },
    { id: "hd3", bill_id: "hd", description: "Tax", quantity: 1, unit_price: 45, amount: 45, category: "Tax", billable: true, billed_amount: null },
  ],
  jobs: [
    { id: "J11", job_number: "J-011", name: "13897 Herringbone" },
    { id: "J13", job_number: "J-013", name: "Another Job" },
    { id: "J02", job_number: "J-002", name: "The SuperHawg Job" },
  ],
  claims: [{ source_ids: ["hd"], import_key: "bli:hd1", invoice_number: "INV-050" }],
});

const SEPT = { from: "2026-09-01", to: "2026-09-30" };
const col = (key: keyof typeof HEADERS, name: string) => HEADERS[key].indexOf(name);

describe("the CSV: plain column names, and nothing a spreadsheet would run", () => {
  it("every list's header row is exactly its plain column names", () => {
    expect(HEADERS.stock_bought).toEqual(["Date Bought", "Item", "Quantity", "Unit", "Cost", "Supplier", "Ticket Number", "Bought On Job", "How It Came In", "Note"]);
    expect(HEADERS.stock_used).toEqual(["Date", "Item", "Quantity", "Unit", "Cost", "Went To", "Job Number", "Job", "Note", "Supplier Credit"]);
    expect(HEADERS.on_hand).toEqual(["Item", "Unit", "On Hand", "Cost On Hand", "Date Bought", "Supplier", "Ticket Number", "Note"]);
    expect(HEADERS.tools).toEqual(["Date", "Supplier", "Ticket Number", "What", "Cost", "Filed As", "Job Number"]);
    for (const l of ACCOUNTANT_LISTS) {
      const csv = toCsv(accountantList(l.key, inputs(), SEPT, TZ));
      expect(csv.split("\r\n")[0]).toBe(HEADERS[l.key].join(","));
      for (const row of csv.trimEnd().split("\r\n")) expect(row.split(",").length).toBeGreaterThanOrEqual(HEADERS[l.key].length);
    }
    expect(ACCOUNTANT_LISTS.map((l) => l.title)).toEqual(["Stock Bought", "Stock Used", "On Hand", "Tools Bought"]);
    expect(ACCOUNTANT_LISTS.find((l) => l.key === "tools")!.says).toContain("Depreciation is your accountant's call.");
  });

  it("quotes commas, quotes and line breaks, and defuses a formula", () => {
    const csv = toCsv({ header: ["A", "B", "C", "D"], rows: [['4" RND, LS', "=HYPERLINK(1)", -12.5, null], ["line\nbreak", "@sum", 0, "-x"]] });
    expect(csv).toBe('A,B,C,D\r\n"4"" RND, LS",\'=HYPERLINK(1),-12.5,\r\n"line\nbreak",\'@sum,0,\'-x\r\n');
  });
});

describe("Stock Bought: every roll that went on the shelf, at its ticket's cost", () => {
  it("August holds the 8/19 coil at $180.17, bought on J-011; a roll taken back off never counts", () => {
    const t = stockBoughtList(inputs(), { from: "2026-07-01", to: "2026-08-31" });
    expect(dataRowCount(t)).toBe(1);
    expect(t.rows[0]).toEqual(["2026-08-19", "12/2 NM-B", 250, "ft", 180.17, "Consolidated Electrical Dist.", null, "J-011", "Rest of a job's receipt", null]);
    expect(t.rows[1][0]).toBe("Total");
    expect(t.rows[1][col("stock_bought", "Cost")]).toBe(180.17);
  });
  it("a box counted in says so, at the $0 it was counted at, with its note", () => {
    const t = stockBoughtList(inputs(), SEPT);
    expect(t.rows[0]).toEqual(["2026-09-25", "Twister 341-Tan", 440, "ea", 0, null, null, null, "Counted in, no receipt", "The rest of Waldow's box (INV-069 paid)"]);
  });
});

describe("Stock Used: where every piece went, and what the supplier gave back", () => {
  const t = stockUsedList(inputs(), SEPT, TZ);
  const rows = t.rows.filter((r) => r[0] !== "Total");
  it("a take, a write-off, a return and pieces back from a job, at their stamped cost; an undone write-off never happened", () => {
    expect(rows.map((r) => [r[col("stock_used", "Went To")], r[2], r[4]])).toEqual([
      ["Job", 60, 43.24],
      ["Written off (Shop Stock Lost)", 10, 7.21],
      ["Returned to supplier", 50, 36.03],
      ["Supplier credit for returned stock", null, null],
      ["Back from a job", -10, -7.21],
    ]);
    expect(rows[0][col("stock_used", "Job Number")]).toBe("J-013");
    expect(rows[1][col("stock_used", "Note")]).toBe("Ruined in the rain");
    expect(rows.some((r) => r[col("stock_used", "Note")] === "oops")).toBe(false);
  });
  it("the credit is its own row in its own column, and the totals add up to the cent", () => {
    const credit = rows.find((r) => r[5] === "Supplier credit for returned stock")!;
    expect(credit[col("stock_used", "Supplier Credit")]).toBe(30);
    expect(credit[col("stock_used", "Note")]).toBe("Consolidated Electrical Dist. #8802-CM1");
    const total = t.rows[t.rows.length - 1];
    expect(total[0]).toBe("Total");
    expect(total[col("stock_used", "Cost")]).toBe(79.27); // 43.24 + 7.21 + 36.03 - 7.21
    expect(total[col("stock_used", "Supplier Credit")]).toBe(30);
  });
  it("a window before any of it is empty", () => {
    expect(stockUsedList(inputs(), { from: "2026-08-01", to: "2026-08-31" }, TZ).rows).toEqual([]);
  });
});

describe("On Hand: the shelf at the end of a day, at cost", () => {
  it("on 9/13: 250 - 60 taken - 10 written off, and every dollar that left is gone from it", () => {
    const t = onHandList(inputs(), "2026-09-13", TZ);
    expect(t.rows[0]).toEqual(["12/2 NM-B", "ft", 180, 129.72, "2026-08-19", "Consolidated Electrical Dist.", null, null]);
    expect(dataRowCount(t)).toBe(1); // the Twister box was counted in on 9/25
  });
  it("on 9/30 the roll adds up: cost = taken + lost + returned + on hand, to the cent", () => {
    const t = onHandList(inputs(), "2026-09-30", TZ);
    const coil = t.rows.find((r) => r[0] === "12/2 NM-B")!;
    expect(coil[2]).toBe(140);
    expect(coil[3]).toBe(100.9);
    // 180.17 = (43.24 - 7.21) on jobs + 7.21 written off + 36.03 returned + 100.90 on hand
    expect(Math.round((43.24 - 7.21 + 7.21 + 36.03 + 100.9) * 100)).toBe(18017);
    expect(t.rows.find((r) => r[0] === "Twister 341-Tan")![2]).toBe(440);
    expect(t.rows[t.rows.length - 1]).toEqual(["Total", null, null, 100.9, null, null, null, null]);
  });
});

describe("Tools: Tools & Supplies tickets, and tools the company kept off other tickets", () => {
  it("a Tools & Supplies ticket is one row at what it cost; a tool kept off a job receipt carries its tax share", () => {
    const t = toolsList(inputs(), { from: "2026-06-01", to: "2026-09-30" }, TZ);
    const rows = t.rows.filter((r) => r[0] !== "Total");
    expect(rows).toEqual([
      ["2026-06-12", "The Home Depot", null, "AUGER BIT, 1 IN.", 109, "Kept off a job's receipt (not billed)", "J-002"], // 100 + 45 x 100/500
      ["2026-09-24", "Consolidated Electrical Dist.", "8802-TS", "SANT 3000CED Ultimate AC Sensor Tester; SANT 3115CED AC Sensor", 44.44, "Tools & Supplies ticket", null],
    ]);
    expect(t.rows[t.rows.length - 1][col("tools", "Cost")]).toBe(153.44);
  });
  it("a tool billed to the customer is not the company's: it is on the report-only list, with its invoice, never changed", () => {
    const b = toolsBilledList(inputs(), TZ);
    expect(b.header).toEqual(["Date", "Supplier", "Job Number", "Job", "What", "Billed To Customer (At Cost)", "Invoice"]);
    expect(b.rows).toEqual([["2026-06-12", "The Home Depot", "J-002", "The SuperHawg Job", "MKE 18V GEN2 SUPERHAWG", 400, "INV-050"]]);
    const t = toolsList(inputs(), { from: "2026-06-01", to: "2026-06-30" }, TZ);
    expect(t.rows.some((r) => String(r[3]).includes("SUPERHAWG"))).toBe(false);
  });
});

describe("the window", () => {
  it("defaults to this month to today, and refuses a reversed or bad range", () => {
    expect(parseWindow(undefined, undefined, "2026-09-26")).toEqual({ from: "2026-09-01", to: "2026-09-26" });
    expect(parseWindow("2026-09-20", "2026-09-01", "2026-09-26")).toEqual({ from: "2026-09-01", to: "2026-09-26" });
    expect(parseWindow("2026-13-40", "x", "2026-09-26")).toEqual({ from: "2026-09-01", to: "2026-09-26" });
    expect(parseWindow("2026-08-01", "2026-08-31", "2026-09-26")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });
  it("a download records the instants it covered in the org's days; On Hand covers everything before its day ends", () => {
    expect(exportWindow("stock_used", SEPT, TZ)).toEqual({ from_at: "2026-09-01T07:00:00.000Z", to_at: "2026-10-01T07:00:00.000Z" });
    expect(exportWindow("on_hand", SEPT, TZ)).toEqual({ from_at: null, to_at: "2026-10-01T07:00:00.000Z" });
  });
});
