import { describe, expect, it } from "vitest";
import { pdfPreviewBackHref, pdfPreviewHref } from "./pdf-preview-back";

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
    // No list of change orders any more (W2-12): the id is the change order's, so Jobs, never a
    // path built from it. The job's own door passes back=, which wins.
    expect(pdfPreviewBackHref("change-order", ID, "")).toBe("/jobs");
    expect(pdfPreviewBackHref("change-order", ID, `/jobs/${ID}?tab=change-orders`)).toBe(`/jobs/${ID}?tab=change-orders`);
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

/** The header's Preview on an invoice and on an estimate (components/preview-button, 2026-11-10). */
describe("pdfPreviewHref", () => {
  const ID = "bb68b095-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("is the address the two ⋯ rows wrote by hand: the viewer, the document, and back= its own page", () => {
    expect(pdfPreviewHref("invoice", ID)).toBe(`/print/pdf-preview?doc=invoice&id=${ID}&back=/billing/${ID}`);
    expect(pdfPreviewHref("quote", ID)).toBe(`/print/pdf-preview?doc=quote&id=${ID}&back=/quotes/${ID}`);
  });

  it("names the page Back would fall back to anyway, so the way in and the way home agree", () => {
    for (const doc of ["invoice", "quote"] as const) {
      const q = new URLSearchParams(pdfPreviewHref(doc, ID).split("?")[1]);
      expect(q.get("doc")).toBe(doc);
      expect(q.get("id")).toBe(ID);
      expect(q.get("back")).toBe(pdfPreviewBackHref(doc, ID, ""));
      // ...and that back= is one the viewer follows as given.
      expect(pdfPreviewBackHref(doc, ID, q.get("back")!)).toBe(q.get("back"));
    }
  });
});
