import { describe, expect, it } from "vitest";
import { pdfPreviewBackHref } from "./pdf-preview-back";

/** The PDF viewer's Back on a direct open (no history to pop). It is the page's only exit in the
 *  iOS shell, so it must always name a real in-app page and never leave the app. */
describe("pdfPreviewBackHref", () => {
  const ID = "bb68b095-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("follows the caller's back= when it is an in-app path", () => {
    expect(pdfPreviewBackHref("invoice", ID, `/billing/${ID}`)).toBe(`/billing/${ID}`);
    expect(pdfPreviewBackHref("material-list", ID, `/jobs/${ID}?tab=materials`)).toBe(`/jobs/${ID}?tab=materials`);
  });

  it("refuses an off-site back= and falls back to the document's own page", () => {
    expect(pdfPreviewBackHref("invoice", ID, "//evil.tld")).toBe(`/billing/${ID}`);
    expect(pdfPreviewBackHref("invoice", ID, "https://evil.tld/billing")).toBe(`/billing/${ID}`);
    expect(pdfPreviewBackHref("quote", ID, "/\\evil.tld")).toBe(`/quotes/${ID}`);
  });

  it("with no back=, goes to each document's own page", () => {
    expect(pdfPreviewBackHref("invoice", ID, "")).toBe(`/billing/${ID}`);
    expect(pdfPreviewBackHref("quote", ID, "")).toBe(`/quotes/${ID}`);
    expect(pdfPreviewBackHref("work-order", ID, "")).toBe(`/work-orders/${ID}`);
    expect(pdfPreviewBackHref("material-list", ID, "")).toBe(`/materials/${ID}`);
    expect(pdfPreviewBackHref("change-order", ID, "")).toBe("/change-orders");
    expect(pdfPreviewBackHref("prelim-notice", ID, "")).toBe(`/jobs/${ID}`);
    expect(pdfPreviewBackHref("panel", ID, "")).toBe(`/jobs/${ID}?tab=panel`);
  });

  it("lands on My Day, never the marketing root, when nothing else is known", () => {
    expect(pdfPreviewBackHref("receipt", ID, "")).toBe("/planner");
    expect(pdfPreviewBackHref("invoice", "", "")).toBe("/planner");
    expect(pdfPreviewBackHref("toString", ID, "")).toBe("/planner");
  });

  it("never builds a path out of an id that isn't one", () => {
    expect(pdfPreviewBackHref("invoice", "../../evil", "")).toBe("/planner");
    expect(pdfPreviewBackHref("invoice", "x/y", "")).toBe("/planner");
  });
});
