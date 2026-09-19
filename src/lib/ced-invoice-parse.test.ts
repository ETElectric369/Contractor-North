import { describe, it, expect } from "vitest";
import { parseCedDocuments, parseCedInvoice, perUnitDivisor } from "./ced-invoice-parse";

/**
 * THE FIXTURES ARE ERIK'S OWN INVOICES, TYPED OUT AS A PDF EXTRACTOR HANDS THEM OVER.
 *
 * Every one of these is a real document out of the CED portal download of 2026-09-19, down to the
 * product codes and the cents, because the whole risk in this file is a layout assumption that
 * reads beautifully against an invented invoice and silently off-by-one against his. The parser
 * was checked against all thirty-six PDFs he has on disk, sixty-four documents in total, and every
 * one of them reconciles twice: extensions to merchandise, and merchandise plus tax plus shipping
 * to the total. These tests keep the shapes that were hard.
 */

/** 8802-1101363, 235 Timber Creek, $162.45. Five lines, two of them priced per hundred. */
const TIMBER_CREEK = `
10338 RIVER PARK PL # 2
TRUCKEE, CA 96161
Invoice
SOLD TO:
E.T. ELECTRIC
SHIP TO:
E.T. ELECTRIC
INVOICE NO.
8802-1101363
INVOICE DATE
06/15/2026
PLEASE SHOW INVOICE NO. AND REMIT TO:
PO BOX 888835
LOS ANGELES, CA 90088-8835
ACCOUNT #/NAME
TR-34426 ERIK TAYLOR
JOB NAME
235 TIMBER CREEK
CUSTOMER ORDER NO.
235 TIMBER CREEK
SALESPERSON
6710 DH
SHIPPING INFORMATION
PREPAID
SHIP VIA
WILL CALL
SHIP DATE
06/15/2026
QTY
ORDERED
2
3
4
4
6
PRODUCT CODE
CPL
CPL
PVC
PVC
PVC
H2750RICAT
H245RICAT
ELL2 45D
ELL2 22-1/2D
CPL2
DESCRIPTION
6'' LED SHALLOW RMDL HOUSING
4'' LED SHALLOW REMODEL HSG
45D PVC ELL
2IN 22.5D STD ELBOW
CONDUIT CPLG
QTY
SHIPPED
2
3
4
4
6
PRICE
12.50
11.83
744.55
1239.20
153.31
E
E
C
C
C
DISC. EXTENSION
25.00
35.49
29.78
49.57
9.20
1.0
1.0
2.0
0.0
2.0
T
T
T
T
T
MERCHANDISE
SALES TAX 9.00000
SHIPPING CHARGE
149.04
13.41
0.00
TOTAL DUE 162.45
Page 1 of 1
TITLE TO MERCHANDISE AND RISK OF LOSS OR DAMAGE PASSES AT POINT OF SHIPMENT. CLAIMS
CASH DISCOUNT 1.38 OFF TOTAL DUE IF PAID BY THE 10TH
OF THE MONTH FOLLOWING PURCHASE
`;

/** The two lines out of 8802-1103832 that matter: a breaker each, and 55 feet of 6/3 per THOUSAND. */
const WIRE_REEL = `
INVOICE NO.
8802-1103832
INVOICE DATE
07/22/2026
PLEASE SHOW INVOICE NO. AND REMIT TO:
ACCOUNT #/NAME
TR-34426 ERIK TAYLOR
JOB NAME
13631 NORTHWOODS
CUSTOMER ORDER NO.
13631 NORTHWOODS
SALESPERSON
QTY
ORDERED
1
55
PRODUCT CODE
SIEM
WIRE
Q250
NMB6/3WGNDX1000
DESCRIPTION
2P 50A 120/240V CB
NMB 6/3 W/GND (1000' REEL)
QTY
SHIPPED
1
55
PRICE
19.91
4321.03
E
M
DISC. EXTENSION
19.91
237.66
1.0
1.0
T
T
MERCHANDISE
SALES TAX 9.00000
SHIPPING CHARGE
257.57
23.18
0.00
TOTAL DUE 280.75
Page 1 of 1
`;

/** 8802-1092311. One line, so CED merges the price onto its unit letter and the extension onto
 *  the DISC and tax codes: "-85.11 E" and "-85.11 1.0T". */
const CREDIT_MEMO = `
CED - TRUCKEE (*** CREDIT MEMO ***)
10338 RIVER PARK PLACE #2
INVOICE NO.
8802-1092311
INVOICE DATE
01/14/2026
PLEASE SHOW INVOICE NO. AND REMIT TO:
ACCOUNT #/NAME
TR-34426 ERIK TAYLOR
JOB NAME
TTP 66
CUSTOMER ORDER NO.
TTP 66
SALESPERSON
QTY
ORDERED
-1
PRODUCT CODE
PANIS
FV0510VS1
DESCRIPTION
VENTILATION FAN
QTY
SHIPPED
-1
PRICE
-85.11 E
DISC. EXTENSION
-85.11 1.0T
ORIGINAL INVOICE(S):
1092066
MERCHANDISE
SALES TAX 9.00000
SHIPPING CHARGE
-85.11
-7.66
0.00
TOTAL DUE -92.77
Page 1 of 1
CASH DISCOUNT -0.85 OFF TOTAL DUE IF PAID BY THE
10TH OF THE MONTH FOLLOWING PURCHASE
`;

describe("parseCedInvoice - a whole invoice off the portal", () => {
  const result = parseCedInvoice(TIMBER_CREEK);
  const invoice = result.ok ? result.invoice : null;

  it("reads the header the way CED prints it, label then value on the next line", () => {
    expect(result.ok).toBe(true);
    expect(invoice?.invoiceNumber).toBe("8802-1101363");
    expect(invoice?.kind).toBe("invoice");
    expect(invoice?.invoiceDate).toBe("2026-06-15");
    expect(invoice?.accountNumber).toBe("TR-34426");
    expect(invoice?.accountName).toBe("ERIK TAYLOR");
  });

  it("keeps the JOB NAME raw, because five of his jobs are on the same road", () => {
    expect(invoice?.jobNameRaw).toBe("235 TIMBER CREEK");
    expect(invoice?.customerOrderRaw).toBe("235 TIMBER CREEK");
  });

  /** THE TRAP THAT COST AN HOUR. The totals block is stacked: three labels, THEN three values. A
   *  regex expecting a number right after the word MERCHANDISE returns null on all 47 of his. */
  it("reads the stacked totals block", () => {
    expect(invoice?.merchandise).toBe(149.04);
    expect(invoice?.tax).toBe(13.41);
    expect(invoice?.shipping).toBe(0);
    expect(invoice?.total).toBe(162.45);
  });

  it("zips the column-wise line items back into rows", () => {
    expect(invoice?.lines).toHaveLength(5);
    expect(invoice?.lines[0]).toMatchObject({
      productCode: "CPL",
      partNumber: "H2750RICAT",
      description: "6'' LED SHALLOW RMDL HOUSING",
      quantity: 2,
      unitPrice: 12.5,
      perUnit: "E",
      extension: 25,
      sortOrder: 0,
    });
    // Priced per HUNDRED: 4 elbows at $1,239.20/C is $49.57, not $4,956.80.
    expect(invoice?.lines[3]).toMatchObject({
      partNumber: "ELL2 22-1/2D",
      quantity: 4,
      unitPrice: 1239.2,
      perUnit: "C",
      extension: 49.57,
    });
    expect(invoice?.lines.map((l) => l.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads the cash discount and works out the day it stops being available", () => {
    expect(invoice?.discountAmount).toBe(1.38);
    expect(invoice?.discountBy).toBe("2026-07-10");
  });

  it("does not claim the supplier called it paid when the supplier did not", () => {
    expect(invoice?.paidInFull).toBe(false);
  });
});

describe("per_unit is the difference between $237.66 and a four thousand dollar reel", () => {
  it("prices 55 feet of 6/3 at $4,321.03 per M as $237.66", () => {
    const result = parseCedInvoice(WIRE_REEL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = result.invoice.lines[1];
    expect(wire.perUnit).toBe("M");
    expect(wire.unitPrice).toBe(4321.03);
    expect(wire.quantity).toBe(55);
    expect(wire.extension).toBe(237.66);
    // The printed price is per thousand feet. Reading it as a piece price is the whole harm.
    expect(Math.round((wire.quantity * wire.unitPrice) / perUnitDivisor(wire.perUnit) * 100) / 100).toBe(237.66);
    expect(result.invoice.merchandise).toBe(257.57);
  });

  it("knows what each unit letter divides by", () => {
    expect(perUnitDivisor("E")).toBe(1);
    expect(perUnitDivisor("C")).toBe(100);
    expect(perUnitDivisor("M")).toBe(1000);
  });
});

describe("credit memos", () => {
  const result = parseCedInvoice(CREDIT_MEMO);

  it("is read as a credit memo, with its money negative", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.kind).toBe("credit_memo");
    expect(result.invoice.total).toBe(-92.77);
    expect(result.invoice.merchandise).toBe(-85.11);
    expect(result.invoice.discountAmount).toBe(-0.85);
  });

  /** With one line item CED puts the price and its unit letter on the same line, and the extension
   *  on the same line as the DISC value and the tax code. Read by token, not by line. */
  it("reads a single line item even when the columns share a line", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.lines).toHaveLength(1);
    expect(result.invoice.lines[0]).toMatchObject({
      partNumber: "FV0510VS1",
      description: "VENTILATION FAN",
      quantity: -1,
      unitPrice: -85.11,
      perUnit: "E",
      extension: -85.11,
    });
  });
});

describe("the self-check refuses rather than half-reads", () => {
  it("names the extensions when they do not add up to merchandise", () => {
    // One digit changed on one line: $35.49 becomes $35.40. Nothing else on the page moves.
    const result = parseCedInvoice(TIMBER_CREEK.replace("\n35.49\n", "\n35.40\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.invoiceNumber).toBe("8802-1101363");
    expect(result.error).toMatch(/extensions add up to 148\.95, but MERCHANDISE says 149\.04/);
  });

  it("names the totals when the parts do not add up to the total", () => {
    const result = parseCedInvoice(TIMBER_CREEK.replace("TOTAL DUE 162.45", "TOTAL DUE 172.45"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/is 162\.45, but TOTAL DUE says 172\.45/);
  });

  it("refuses text that is not a CED invoice at all, and says which it is", () => {
    const result = parseCedInvoice("a photo of a receipt, some words, no invoice number anywhere");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no CED invoice number/i);
    expect(parseCedDocuments("nothing here")).toEqual([]);
  });
});

describe("one download is usually several documents", () => {
  const twoOfThem = `${TIMBER_CREEK}\n${CREDIT_MEMO}`;

  it("returns every document in the text, in the order they are printed", () => {
    const results = parseCedDocuments(twoOfThem);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.invoice.invoiceNumber : null))).toEqual([
      "8802-1101363",
      "8802-1092311",
    ]);
  });

  /** The page header of the NEXT document sits a dozen lines above its invoice number. A split
   *  made at the number left "(*** CREDIT MEMO ***)" in the tail of the document before it, and
   *  his 01-14 download came back with a $217.46 invoice called a credit memo. */
  it("does not let the next page's credit memo stamp bleed onto this document", () => {
    const results = parseCedDocuments(twoOfThem);
    expect(results[0].ok && results[0].invoice.kind).toBe("invoice");
    expect(results[1].ok && results[1].invoice.kind).toBe("credit_memo");
  });

  it("does not leak the previous document's cash discount forward or back", () => {
    const results = parseCedDocuments(twoOfThem);
    expect(results[0].ok && results[0].invoice.discountAmount).toBe(1.38);
    expect(results[1].ok && results[1].invoice.discountAmount).toBe(-0.85);
  });

  it("refuses to pick one of several when the caller asked for one", () => {
    const result = parseCedInvoice(twoOfThem);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/holds 2 documents/);
    expect(result.error).toMatch(/8802-1101363/);
    expect(result.error).toMatch(/8802-1092311/);
  });

  /** Every page also says "PLEASE SHOW INVOICE NO. AND REMIT TO:". That is not a document. */
  it("does not mistake the remit-to line for a second invoice", () => {
    expect(parseCedDocuments(TIMBER_CREEK)).toHaveLength(1);
  });

  /** Whether the number lands on the heading's line or the next one is the EXTRACTOR's choice,
   *  not the document's, and a heading that failed to match would lose a whole invoice silently. */
  it("finds the document when the number shares a line with the heading", () => {
    const merged = TIMBER_CREEK.replace("INVOICE NO.\n8802-1101363", "INVOICE NO. 8802-1101363");
    const results = parseCedDocuments(merged);
    expect(results).toHaveLength(1);
    expect(results[0].ok && results[0].invoice.invoiceNumber).toBe("8802-1101363");
  });
});

describe("a two page invoice is one document", () => {
  // Page one carries rows and no totals; page two repeats the whole header, carries the rest of
  // the rows, and prints the totals. Reading both pages' columns as one run put page two's prices
  // under page one's row count and left his 16-line invoice $7.94 short of its own merchandise.
  const page = (rows: string, totals: string) => `
INVOICE NO.
8802-1080836
INVOICE DATE
07/08/2025
PLEASE SHOW INVOICE NO. AND REMIT TO:
ACCOUNT #/NAME
TR-34426 ERIK TAYLOR
JOB NAME
TTP 214
CUSTOMER ORDER NO.
TTP 214
SALESPERSON
${rows}${totals}`;

  const pageOne = page(
    `QTY
ORDERED
2
1
PRODUCT CODE
CPL
SIEM
H2750RICAT
Q120
DESCRIPTION
6'' LED SHALLOW RMDL HOUSING
SP 20A 120/240V CB
QTY
SHIPPED
2
1
PRICE
12.50
9.09
E
E
DISC. EXTENSION
25.00
9.09
1.0
1.0
T
T
`,
    "Page 1 of 2\nCASH DISCOUNT 0.68 OFF TOTAL DUE IF PAID BY THE 10TH\nOF THE MONTH FOLLOWING PURCHASE\n",
  );
  const pageTwo = page(
    `QTY
ORDERED
4
PRODUCT CODE
PVC
ELL2 45D
DESCRIPTION
45D PVC ELL
QTY
SHIPPED
4
PRICE
744.55
C
DISC. EXTENSION
29.78
2.0
T
`,
    `MERCHANDISE
SALES TAX 9.00000
SHIPPING CHARGE
63.87
5.75
0.00
TOTAL DUE 69.62
Page 2 of 2
`,
  );

  it("joins the pages and reconciles across both of them", () => {
    const results = parseCedDocuments(`${pageOne}\n${pageTwo}`);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    if (!results[0].ok) return;
    expect(results[0].invoice.lines).toHaveLength(3);
    expect(results[0].invoice.lines.map((l) => l.extension)).toEqual([25, 9.09, 29.78]);
    expect(results[0].invoice.lines.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
    expect(results[0].invoice.merchandise).toBe(63.87);
    expect(results[0].invoice.total).toBe(69.62);
  });
});

describe("the awkward ones", () => {
  /** CED stamps the header of a settled document. It is the only voice that can say this. */
  it("hears the supplier say PAID IN FULL", () => {
    const stamped = TIMBER_CREEK.replace("INVOICE NO.\n8802", "***PAID IN FULL*** INVOICE NO.\n8802");
    const result = parseCedInvoice(stamped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.paidInFull).toBe(true);
    expect(result.invoice.invoiceNumber).toBe("8802-1101363");
  });

  /** When the two columns say the same thing CED prints one value under both headings. Looking
   *  only for a heading that ENDS in "JOB NAME" left $1,513.71 of material with no job on it. */
  it("reads the job name when it shares a heading with the customer order number", () => {
    const merged = TIMBER_CREEK.replace(
      "JOB NAME\n235 TIMBER CREEK\nCUSTOMER ORDER NO.\n235 TIMBER CREEK",
      "JOB NAME CUSTOMER ORDER NO.\n235 TIMBER CREEK",
    );
    const result = parseCedInvoice(merged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.jobNameRaw).toBe("235 TIMBER CREEK");
  });

  it("carries a December invoice's discount deadline into January", () => {
    const december = TIMBER_CREEK.replace("06/15/2026", "12/15/2026");
    const result = parseCedInvoice(december);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.invoiceDate).toBe("2026-12-15");
    expect(result.invoice.discountBy).toBe("2027-01-10");
  });

  it("reads prices with four digits and no thousands comma", () => {
    // CED groups the totals ("2,558.98") and does not group the line prices ("1239.20"). A pattern
    // that required the comma refused 22 of his 64 documents.
    const result = parseCedInvoice(TIMBER_CREEK);
    expect(result.ok && result.invoice.lines[3].unitPrice).toBe(1239.2);
  });

  /** A SERVICE CHARGE INVOICE is a different template: no items, no merchandise, one figure. It is
   *  the 1.5% a month he paid while $123.46 of prompt-pay discount sat unclaimed, so it has to
   *  land in the ledger rather than be skipped. */
  it("reads a service charge invoice, which has no line items to check", () => {
    const serviceCharge = `
SERVICE CHARGE INVOICE
INVOICE NO.
8802-1105999
INVOICE DATE
09/01/2026
PLEASE SHOW INVOICE NO. AND REMIT TO:
ACCOUNT #/NAME
TR-34426 ERIK TAYLOR
INVOICE TOTAL - PAY THIS AMOUNT
$31.26
`;
    const result = parseCedInvoice(serviceCharge);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.kind).toBe("service_charge");
    expect(result.invoice.invoiceNumber).toBe("8802-1105999");
    expect(result.invoice.total).toBe(31.26);
    expect(result.invoice.lines).toEqual([]);
    expect(result.invoice.merchandise).toBeNull();
  });
});

describe("a credit memo is negative twice (cn-v965 review)", () => {
  /**
   * CED writes a credit with a negative quantity AND a negative price. They multiply back to a
   * positive, which meant the unit-letter check could never match on a credit memo and fell back
   * to "each" - putting a per-thousand wire price on a line as if it were a piece price.
   */
  const creditText = [
    "INVOICE NO.", "8802-1092311", "INVOICE DATE", "05/12/2026",
    "ACCOUNT #/NAME", "TR-34426", "JOB NAME", "5659 RHODESIA",
    "QTY", "ORDERED", "-55",
    "PRODUCT CODE", "WIRE", "NMB6/3WGNDX1000",
    "DESCRIPTION", "NMB 6/3 W/GND (1000' REEL)",
    "QTY", "SHIPPED", "-55",
    "PRICE", "-4321.03", "M",
    "DISC.", "EXTENSION", "-237.66", "2.0",
    "MERCHANDISE", "SALES TAX", "9.00000", "SHIPPING CHARGE",
    "-237.66", "-21.39", "0.00",
    "TOTAL DUE", "-259.05",
  ].join("\n");

  it("recovers the per-thousand unit on a credit, not each", () => {
    const doc = parseCedInvoice(creditText);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.invoice.lines[0]?.perUnit).toBe("M");
    expect(doc.invoice.lines[0]?.extension).toBe(-237.66);
  });
});
