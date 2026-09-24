import { describe, expect, it } from "vitest";
import { isPdfBytes, isPdfText, joinPdfTextItems } from "./pdf-text";
import { sha256Hex, isSha256 } from "./content-hash";
import { parseCedInvoice } from "./ced-invoice-parse";
import { TIMBER_CREEK } from "@/test/ced-timber-creek";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("a PDF is known by its CONTENT, never its name", () => {
  it("the %PDF- signature at the start", () => {
    expect(isPdfBytes(bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBe(true);
  });
  it("the signature after leading junk inside the first kilobyte (the spec allows it)", () => {
    expect(isPdfBytes(bytes("﻿   \r\n%PDF-1.4"))).toBe(true);
  });
  it("a text file NAMED .pdf is not a PDF", () => {
    expect(isPdfBytes(bytes("INVOICE NO.\n8802-1101363"))).toBe(false);
    expect(isPdfText("INVOICE NO.\n8802-1101363")).toBe(false);
  });
  it("text read out of a file that was really PDF bytes is caught", () => {
    expect(isPdfText("%PDF-1.7\n1 0 obj << /Type /Catalog >>")).toBe(true);
  });
  it("nothing is not a PDF", () => {
    expect(isPdfBytes(null)).toBe(false);
    expect(isPdfBytes(new Uint8Array(0))).toBe(false);
  });
});

describe("joinPdfTextItems: pdfjs runs back into lines the CED parser reads", () => {
  it("a run that ends a line breaks it; runs on one line are joined with one space", () => {
    const items = [
      { str: "INVOICE NO.", hasEOL: true },
      { str: "8802-1101363", hasEOL: true },
      { str: "TR-34426", hasEOL: false },
      { str: "ERIK", hasEOL: false },
      { str: "TAYLOR", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "", hasEOL: true },
      { str: "TOTAL   162.45", hasEOL: false },
    ];
    expect(joinPdfTextItems(items)).toBe("INVOICE NO.\n8802-1101363\nTR-34426 ERIK TAYLOR\n\nTOTAL 162.45");
  });
  it("marked-content items with no string are skipped, not printed as 'undefined'", () => {
    expect(joinPdfTextItems([{ hasEOL: false }, { str: "A", hasEOL: true }, { str: undefined, hasEOL: true }])).toBe("A");
  });
  it("text laid out one run per line survives the join and still reconciles", () => {
    const items = TIMBER_CREEK.split("\n").map((str) => ({ str, hasEOL: true }));
    const result = parseCedInvoice(joinPdfTextItems(items));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.invoice.total).toBe(162.45);
  });
});

describe("the file's fingerprint", () => {
  it("SHA-256 of the bytes, lowercase hex", async () => {
    expect(await sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("the same bytes under two names are one fingerprint", async () => {
    const a = await sha256Hex(bytes("%PDF-1.7 same paper"));
    const b = await sha256Hex(bytes("%PDF-1.7 same paper").buffer as ArrayBuffer);
    expect(a).toBe(b);
    expect(isSha256(a)).toBe(true);
  });
  it("the shape check the database also makes", () => {
    expect(isSha256("ABC")).toBe(false);
    expect(isSha256("g".repeat(64))).toBe(false);
  });
});
