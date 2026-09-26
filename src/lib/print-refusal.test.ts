import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printRefusal } from "@/lib/print-refusal";

const PATH = "/print/invoice/332ec51f-2d97-478c-914a-cc5d5531bbdb";

describe("what /api/pdf says when the print page did not answer with the document (audit v1018)", () => {
  it("the document, drawn: nothing to say", () => {
    expect(printRefusal("invoice", { status: 200, path: PATH }, PATH)).toBeNull();
  });

  it("a read that failed just now is a 503 that says so, never 'isn't available'", () => {
    expect(printRefusal("invoice", { status: 500, path: PATH }, PATH)).toEqual({
      status: 503,
      error: "This invoice couldn't be read in full just now. Try again in a moment.",
    });
    expect(printRefusal("quote", { status: 502, path: "/print/quote/x" }, "/print/quote/x")).toEqual({
      status: 503,
      error: "This document couldn't be read just now. Try again in a moment.",
    });
  });

  it("not there for this reader (the app's 404, the login redirect, no response) stays 'isn't available'", () => {
    const gone = { status: 404, error: "That document isn't available." };
    expect(printRefusal("invoice", { status: 404, path: PATH }, PATH)).toEqual(gone);
    expect(printRefusal("invoice", { status: 200, path: "/login" }, PATH)).toEqual(gone);
    expect(printRefusal("invoice", { status: 500, path: "/login" }, PATH)).toEqual(gone);
    expect(printRefusal("invoice", null, PATH)).toEqual(gone);
  });

  it("the route answers from it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/pdf/[doc]/[id]/route.ts"), "utf8");
    expect(src).toMatch(/const refusal = printRefusal\(doc,/);
    expect(src).toContain("{ status: refusal.status }");
  });
});
