import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE DOOR'S ROUTING (2026-10-02). A person drops the statement they were given; they never choose
 * a reader. This pins which lane each PDF goes down, because that choice is where this door can quietly
 * become a merry-go-round again:
 *
 *   · a PDF whose pages carry a table the existing readers RECOGNISE keeps the cn-v1049 lane exactly as
 *     it is — read on the device, deterministic, no model, no cost;
 *   · a PDF with no text on its pages at all (his July statement) comes back as a SCAN, for the reader
 *     that can see a picture;
 *   · a PDF whose text is there but tabulates into nothing a reader knows (his September statement: the
 *     only text on it is the back-page legal notice) comes back as a scan too, because the text proves
 *     nothing either way and only looking at the pages can answer it;
 *   · a file that would not open as a PDF at all is still a refusal — no reader can fix that.
 *
 * NO PDF IS OPENED HERE: the browser's pdfjs read is replaced by whatever each test says came off the
 * pages. Every figure and heading below is invented.
 */

const m = vi.hoisted(() => ({ readPdf: vi.fn() }));
vi.mock("@/lib/pdf-text", () => ({
  readPdf: (...args: unknown[]) => m.readPdf(...args),
  readPdfText: async () => ({ ok: false, error: "no text" }),
  isPdfBytes: () => true,
  isPdfText: () => false,
  noTextSaid: (name: string) => `${name} had no text in it.`,
  joinPdfTextItems: () => "",
}));

import { readStatementFile } from "./open-list-file";

const pdf = (name = "statement.pdf", bytes = 2048) => new File([new Uint8Array(bytes)], name, { type: "application/pdf", lastModified: Date.parse("2026-09-30T18:00:00Z") });

/** A bank's own statement as a table that READS: a day, a description, money in and money out. */
const BANK_TABLE = [
  ["DATE", "DESCRIPTION", "WITHDRAWAL", "DEPOSIT"],
  ["09/02/26", "CARD PURCHASE HARROWGATE FUEL", "142.08", ""],
  ["09/08/26", "DEPOSIT INVOICE PAYMENT", "", "3400.00"],
  ["09/30/26", "MONTHLY SERVICE CHARGE", "12.00", ""],
];

/**
 * THE SHAPE THAT MATTERS MOST, measured off his real September file: the pages' only text is the
 * back-of-statement legal notice, and a header-shaped row (DATE / TYPE / DESCRIPTION / AMOUNT) sits
 * INSIDE it. The text lane must not make a statement of that — and it does not (bankTableProof refuses
 * it) — so this is what falls through to the reader.
 */
const LEGAL_NOTICE_TABLE = [
  ["In Case of Errors or Questions About Your Electronic Transfers", "", "", ""],
  ["Telephone us at the number on the front of this statement or write to us at", "", "", ""],
  ["Riverbend Community Bank, PO Box 00000, tell us your name and account number,", "", "", ""],
  ["DATE", "TYPE", "DESCRIPTION", "AMOUNT"],
  ["Describe the error or the transfer you are unsure about and explain as clearly", "", "", ""],
  ["as you can why you believe it is an error or why you need more information.", "", "", ""],
];

beforeEach(() => m.readPdf.mockReset());

describe("a PDF whose table reads keeps the text lane, untouched", () => {
  it("a bank statement with text comes back as rows, with the pages said, and no scan", async () => {
    m.readPdf.mockResolvedValue({ ok: true, text: "RIVERBEND COMMUNITY BANK", table: BANK_TABLE, pages: 2 });
    const got = await readStatementFile(pdf());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table[0]).toEqual(["DATE", "DESCRIPTION", "WITHDRAWAL", "DEPOSIT"]);
    expect(got.pdf).toEqual({ pages: 2, rows: 4 });
    expect(got.listDate).toBe("2026-09-30");
  });
});

describe("a PDF the text lane cannot read goes to the reader, never to a dead end", () => {
  it("no text on the pages at all (his July statement) comes back as a scan, with its page count", async () => {
    m.readPdf.mockResolvedValue({ ok: false, error: "statement.pdf had no text in it.", noText: true, pages: 3 });
    const got = await readStatementFile(pdf());
    expect(got.ok).toBe(false);
    if (got.ok || !("scan" in got)) throw new Error("a scan should have come back");
    expect(got.scan.pages).toBe(3);
    expect(got.scan.listDate).toBe("2026-09-30");
    expect(got.scan.base64.length).toBeGreaterThan(0);
  });

  it("text that is only a legal notice — header-shaped row and all — is a scan, not a statement", async () => {
    const { tableReadsAsList } = await import("./pdf-table");
    // The text lane's own answer first: this is NOT a list, and that refusal is what must not change.
    expect(tableReadsAsList(LEGAL_NOTICE_TABLE)).toBeNull();
    m.readPdf.mockResolvedValue({ ok: true, text: "In Case of Errors", table: LEGAL_NOTICE_TABLE, pages: 3 });
    const got = await readStatementFile(pdf());
    expect(got.ok).toBe(false);
    if (got.ok || !("scan" in got)) throw new Error("a scan should have come back");
    expect(got.scan.pages).toBe(3);
  });

  it("a file that would not open as a PDF is a refusal in words, and no read is attempted", async () => {
    m.readPdf.mockResolvedValue({ ok: false, error: "statement.pdf wouldn't open as a PDF (bad XRef entry)." });
    const got = await readStatementFile(pdf());
    expect(got.ok).toBe(false);
    if (got.ok || "scan" in got) throw new Error("a refusal should have come back");
    expect(got.error).toContain("wouldn't open as a PDF");
  });

  it("a library, not a statement: a 240-page PDF is refused with the one thing to do about it", async () => {
    m.readPdf.mockResolvedValue({ ok: false, error: "catalogue.pdf had no text in it.", noText: true, pages: 240 });
    const got = await readStatementFile(pdf("catalogue.pdf"));
    expect(got.ok).toBe(false);
    if (got.ok || "scan" in got) throw new Error("a refusal should have come back");
    expect(got.error).toContain("240 pages");
    expect(got.error).toContain("Save just the statement pages");
  });

  it("too heavy to look at is said here, before 11 MB goes anywhere", async () => {
    m.readPdf.mockResolvedValue({ ok: false, error: "scan.pdf had no text in it.", noText: true, pages: 4 });
    const got = await readStatementFile(pdf("scan.pdf", 9 * 1024 * 1024));
    expect(got.ok).toBe(false);
    if (got.ok || "scan" in got) throw new Error("a refusal should have come back");
    expect(got.error).toContain("more than the reader can look at");
  });
});
