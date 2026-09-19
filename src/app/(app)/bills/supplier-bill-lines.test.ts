import { describe, it, expect } from "vitest";
import { supplierBillLines } from "./supplier-bill-lines";
import { billItemisation, billLineCost } from "@/lib/bill-itemisation";

/**
 * THE FIXTURES ARE ERIK'S OWN CED DOCUMENTS, copied off the PDFs, because a fixture invented to
 * hit a number proves the number and nothing else (that mistake was caught by a reviewer one wave
 * ago and is not being made twice). Every case below is a real line on a real invoice.
 */
describe("supplierBillLines", () => {
  it("bills CED 8802-1107338 exactly as CED does", () => {
    // The ivory replacement on TTP 106. "50.00 C" on the plate is fifty dollars per HUNDRED.
    const out = supplierBillLines(
      [
        { description: "AC CHARGER/RCP", part_number: "R26USBAC6I", quantity: 5, unit_price: 40.47, extension: 202.35 },
        { description: "1 GANG DECORA PLATE", part_number: "TP26I", quantity: 5, unit_price: 50.0, extension: 2.5 },
      ],
      { invoiceNumber: "8802-1107338", tax: 18.44, shipping: 0, total: 223.29 },
    );
    expect(out.lines.map((l) => [l.description, l.quantity, l.unit_price, l.amount])).toEqual([
      ["AC CHARGER/RCP (R26USBAC6I)", 5, 40.47, 202.35],
      ["1 GANG DECORA PLATE (TP26I)", 5, 0.5, 2.5], // NOT 50.00
      ["Sales Tax (Invoice 8802-1107338)", 1, 18.44, 18.44],
    ]);
    expect(out.lineSum).toBe(223.29);
    expect(out.shortfall).toBe(0);
    expect(out.overshoot).toBe(false);
  });

  it("reads a per-thousand wire price as a price per foot", () => {
    // 8802-1103832: 55 feet of 6/3 at $4,321.03 per M. Read as each it is a $237,656 reel.
    const out = supplierBillLines(
      [{ description: "NMB 6/3 W/GND (1000' REEL)", part_number: "NMB6/3WGNDX1000", quantity: 55, unit_price: 4321.03, extension: 237.66 }],
      { invoiceNumber: "8802-1103832", total: 237.66 },
    );
    expect(out.lines[0].unit_price).toBe(4.32); // and numeric(12,2) is all the column keeps
    expect(out.lines[0].amount).toBe(237.66);
  });

  it("marks tax as Tax so the invoice arithmetic can find it, and freight as its own thing", () => {
    const out = supplierBillLines([{ description: "PART", quantity: 1, unit_price: 10, extension: 10 }], {
      invoiceNumber: "X-1",
      tax: 0.9,
      shipping: 12.5,
      total: 23.4,
    });
    expect(out.lines.map((l) => l.category)).toEqual(["Materials", "Tax", "Freight"]);
    expect(out.lineSum).toBe(23.4);
  });

  it("leaves tax and shipping off entirely when the document has none", () => {
    const out = supplierBillLines([{ description: "PART", quantity: 2, unit_price: 5, extension: 10 }], {
      invoiceNumber: "X-2",
      tax: 0,
      shipping: 0,
      total: 10,
    });
    expect(out.lines).toHaveLength(1);
    expect(out.shortfall).toBe(0);
  });

  it("names the gap when the lines do not reach the supplier's total", () => {
    // A line the reader missed. The cost is still the supplier's total; the difference rides in
    // the invoice's supplies-and-tax row, and the caller says so out loud.
    const out = supplierBillLines([{ description: "PART", quantity: 1, unit_price: 10, extension: 10 }], {
      invoiceNumber: "X-3",
      total: 25,
    });
    expect(out.lineSum).toBe(10);
    expect(out.shortfall).toBe(15);
    expect(out.overshoot).toBe(false);
  });

  it("refuses to itemise when the lines come to more than the supplier is charging", () => {
    const out = supplierBillLines(
      [
        { description: "PART", quantity: 1, unit_price: 90, extension: 90 },
        { description: "PART TWO", quantity: 1, unit_price: 90, extension: 90 },
      ],
      { invoiceNumber: "X-4", total: 100 },
    );
    expect(out.overshoot).toBe(true);
    expect(out.shortfall).toBe(0); // never a negative gap on a customer's invoice
  });

  it("keeps a back-ordered line and drops a row with nothing on it", () => {
    // CED's real back-order print: the part and its price, zeroes in shipped and in the extension.
    // Dropping it would leave nothing in the app saying the delivery was short.
    const out = supplierBillLines(
      [
        { description: "CHARGE 8010 5CCT 10W TRACK LUMINAIRE", part_number: "8010WH", quantity: 0, unit_price: 38.98, extension: 0 },
        { description: "", part_number: "", quantity: 0, unit_price: 0, extension: 0 },
      ],
      { invoiceNumber: "X-5", total: 0 },
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].unit_price).toBe(38.98); // the stated price, since the extension can't answer
    expect(out.lines[0].amount).toBe(0);
    expect(billLineCost({ id: "bo", ...out.lines[0] })).toBe(0); // and it costs the job nothing
  });

  it("does not repeat a part number the supplier already wrote into the description", () => {
    const out = supplierBillLines(
      [{ description: "WIRE NMB12/2WGNDX250 coil", part_number: "NMB12/2WGNDX250", quantity: 250, unit_price: 661.17, extension: 165.29 }],
      { invoiceNumber: "X-6", total: 165.29 },
    );
    expect(out.lines[0].description).toBe("WIRE NMB12/2WGNDX250 coil");
    expect(out.lines[0].unit_price).toBe(0.66);
  });

  it("falls back to the part number when the supplier printed no description", () => {
    // 8802-1101419 has a line with a part number (NMB6/3WGRD) and a blank description.
    const out = supplierBillLines(
      [{ description: "", part_number: "NMB6/3WGRD", quantity: 50, unit_price: 4593.73, extension: 229.69 }],
      { invoiceNumber: "8802-1101419", total: 229.69 },
    );
    expect(out.lines[0].description).toBe("NMB6/3WGRD");
  });

  it("handles a credit memo's negative signs without inventing a positive cost", () => {
    // The server action refuses a credit memo outright, but the arithmetic must not silently turn
    // one into a charge if it ever reaches here: negative qty x negative price multiplies back
    // POSITIVE, which is the shape that made the per-unit guard structurally dead one wave ago.
    const out = supplierBillLines(
      [{ description: "AC CHARGER/RCP", part_number: "R26USBAC6LA", quantity: -5, unit_price: -40.87, extension: -204.35 }],
      { invoiceNumber: "8802-1107337", tax: -18.62, total: -225.47 },
    );
    expect(out.lines[0].amount).toBe(-204.35);
    expect(out.lines[0].unit_price).toBe(40.87); // -204.35 / -5, the honest each price
    expect(out.lineSum).toBe(-222.97);
  });
});

describe("supplierBillLines, the things a reviewer broke it on", () => {
  it("does not let the food rule die because the caller already answered", () => {
    // CED does not sell snacks, which is the only reason passing a stated category was harmless.
    // Erik's rule is Food and Drink comes off the customer's bill, and it has to still be able to.
    const out = supplierBillLines(
      [{ description: "BODYARMOR SPORTS DRINK 12PK", quantity: 1, unit_price: 12, extension: 12 }],
      { invoiceNumber: "X-7", total: 12 },
    );
    expect(out.lines[0].category).toBe("Food & Drink");
    expect(out.lines[0].billable).toBe(false);
  });

  it("calls an ordinary supply-house line Materials", () => {
    const out = supplierBillLines(
      [{ description: "1G BRZ IN-USE CVR", quantity: 1, unit_price: 1458.96, extension: 14.59 }],
      { invoiceNumber: "X-8", total: 14.59 },
    );
    expect(out.lines[0].category).toBe("Materials");
    expect(out.lines[0].billable).toBe(true);
    expect(out.lines[0].unit_price).toBe(14.59);
  });

  it("never bills a back-ordered line, whatever price is printed beside it", () => {
    // "50.00 C" on a plate that did not ship. Read as each x qty that is $250 of merchandise the
    // supplier never handed over, and it used to reach the customer's invoice as a $312.50 row.
    const out = supplierBillLines(
      [
        { description: "AC CHARGER/RCP", part_number: "R26USBAC6I", quantity: 5, unit_price: 40.47, extension: 202.35 },
        { description: "1 GANG DECORA PLATE", part_number: "TP26I", quantity: 5, unit_price: 50.0, extension: 0 },
      ],
      { invoiceNumber: "8802-BO", tax: 18.44, shipping: 0, total: 220.79 },
    );
    const plate = out.lines.find((l) => l.description.includes("DECORA"))!;
    expect(plate.amount).toBe(0);
    expect(billLineCost({ id: "p", ...plate })).toBe(0);
    const rows = billItemisation({ id: "b", supplier: "CED", bill_number: "8802-BO", amount: 220.79 }, out.lines.map((l, i) => ({ id: `L${i}`, ...l, billed_amount: null })), 25);
    expect(rows.find((r) => r.description.includes("DECORA"))).toBeUndefined();
    expect(rows.every((r) => r.unit_price >= 0)).toBe(true);
    const total = rows.reduce((s, r) => Math.round((s + r.quantity * r.unit_price) * 100) / 100, 0);
    expect(total).toBe(275.99); // 220.79 x 1.25, and every cent of it real merchandise
  });
});
