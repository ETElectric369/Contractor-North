import { describe, it, expect } from "vitest";
import { asciiFilename, contentDisposition } from "./content-disposition";

describe("content-disposition — a header can only carry bytes", () => {
  it("THE BADGER LANE FAILURE: an em-dash filename no longer throws, and still reads right", () => {
    const name = "Invoice INV-060 — 10410 Badger Lane.pdf";
    const value = contentDisposition(name);
    // The whole point: every code point must fit in a byte or the response dies on send.
    for (const ch of value) expect(ch.codePointAt(0)!).toBeLessThan(256);
    expect(value).toContain('filename="Invoice INV-060 - 10410 Badger Lane.pdf"');
    // …and a modern browser still gets the real name back.
    expect(decodeURIComponent(value.split("filename*=UTF-8''")[1])).toBe(name);
  });

  it("maps the typography a real document title carries", () => {
    expect(asciiFilename("Invoice — “Smith’s” job… .pdf")).toBe("Invoice - Smith's job... .pdf");
  });

  it("still strips header-injection characters", () => {
    expect(asciiFilename('bad"name\r\nX-Evil: 1.pdf')).not.toMatch(/["\r\n]/);
  });

  it("never returns an empty filename", () => {
    expect(asciiFilename("日本語")).toBe("document.pdf");
    expect(asciiFilename("")).toBe("document.pdf");
  });

  it("an all-ASCII name is untouched", () => {
    expect(asciiFilename("Invoice INV-058.pdf")).toBe("Invoice INV-058.pdf");
  });
});
