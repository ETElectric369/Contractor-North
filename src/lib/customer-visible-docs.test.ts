import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { eachAppSource, liveFunctionBody } from "@/lib/migration-body.test-util";
import { CUSTOMER_VISIBLE_STATUSES, customerMayOpen, type CustomerDoc } from "@/lib/customer-visible-docs";

/**
 * WHICH PAPERS A CUSTOMER MAY OPEN: ONE APP LIST, AND THE DATABASE PINNED TO IT (W3).
 *
 * Reproduced before the fix: adding "void" to the portal page's own set alone gave a voided bill a
 * Pay button on the customer's job page, while the /i door and the stored-PDF door both refused
 * that same token — a tap that lands on "Not found." All 164 tests over the portal, the document
 * assembly and the PDF cache stayed green, because nothing compared the three lists.
 *
 * The three app copies are now one (lib/customer-visible-docs). The database keeps its own, because
 * public_invoice / public_quote / customer_portal / portal_job_view are reached by an anonymous
 * caller with a token and the gate has to be INSIDE them. This file is what makes that safe: it
 * reads the live migration bodies and fails the moment either side moves alone.
 */

const INVOICE_GATES: { fn: string; column: string; what: string }[] = [
  { fn: "public_invoice", column: "i", what: "the bill behind a customer's /i link" },
  { fn: "customer_portal", column: "i", what: "the bills listed on the customer's home page" },
  { fn: "portal_job_view", column: "i", what: "the bills on the customer's job page, and which carry a pay token" },
];

/** Every `<alias>.status in ('a','b',…)` list in a body, as sorted word arrays. */
function statusLists(body: string, alias: string): string[][] {
  const re = new RegExp(`\\b${alias}\\.status\\s+in\\s*\\(([^)]*)\\)`, "gi");
  return [...body.matchAll(re)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((w) => w[1]).sort());
}

describe("the customer's papers: the app's list and the database's never drift apart (W3)", () => {
  const wantInvoice = [...CUSTOMER_VISIBLE_STATUSES.invoice].sort();
  const wantQuote = [...CUSTOMER_VISIBLE_STATUSES.quote].sort();

  for (const g of INVOICE_GATES) {
    it(`${g.fn} opens exactly the bills the app opens — ${g.what}`, () => {
      const live = liveFunctionBody(g.fn);
      expect(live, `no migration creates public.${g.fn}`).not.toBeNull();
      const found = statusLists(live!.body, g.column);
      expect(
        found.length,
        `public.${g.fn} (live in ${live!.file}) no longer narrows invoices by status where this test looks. ` +
          `If the function was rewritten, re-point this test at the new gate — do not delete it.`,
      ).toBeGreaterThan(0);
      for (const list of found) {
        expect(list, `${g.fn} in ${live!.file} vs CUSTOMER_VISIBLE_STATUSES.invoice`).toEqual(wantInvoice);
      }
    });
  }

  it("public_quote opens exactly the quotes the app opens", () => {
    const live = liveFunctionBody("public_quote");
    expect(live, "no migration creates public.public_quote").not.toBeNull();
    const found = statusLists(live!.body, "q");
    expect(found.length, `public.public_quote (live in ${live!.file}) no longer narrows quotes by status`).toBeGreaterThan(0);
    for (const list of found) {
      expect(list, `public_quote in ${live!.file} vs CUSTOMER_VISIBLE_STATUSES.quote`).toEqual(wantQuote);
    }
  });

  // NOT asserted on purpose: customer_portal also counts quotes with `q.status in ('sent','accepted')`
  // and jobs with their own list. Those are different rules — how many quotes are WAITING on the
  // customer, and which jobs appear at all — not "which papers may be opened".

  it("the gate fails closed on anything that is not one of the words", () => {
    for (const doc of ["invoice", "quote"] as CustomerDoc[]) {
      expect(customerMayOpen(doc, null)).toBe(false);
      expect(customerMayOpen(doc, undefined)).toBe(false);
      expect(customerMayOpen(doc, "")).toBe(false);
      expect(customerMayOpen(doc, "draft")).toBe(false);
      expect(customerMayOpen(doc, "void")).toBe(false);
      expect(customerMayOpen(doc, 1)).toBe(false);
      expect(customerMayOpen(doc, "Sent")).toBe(false); // the stored words are lower case
      for (const ok of CUSTOMER_VISIBLE_STATUSES[doc]) expect(customerMayOpen(doc, ok)).toBe(true);
    }
    expect(customerMayOpen("invoice", "accepted")).toBe(false);
    expect(customerMayOpen("quote", "paid")).toBe(false);
  });

  /**
   * A DELIBERATE BYPASS TRIPWIRE (not the proof the behaviour works — the cases above are that).
   * A new customer-facing door that writes the list out again is exactly how the three copies
   * happened. It fails here instead of shipping a dead Pay or Download button.
   *
   * Only the customer-visible sets are matched, by their exact contents: the office's own "still
   * owed" reads (`['sent','partial','overdue']`, no 'paid') are a different rule and stay.
   */
  it("no other file writes the customer's list out again", () => {
    const targets = new Map<string, CustomerDoc>([
      [[...CUSTOMER_VISIBLE_STATUSES.invoice].sort().join("|"), "invoice"],
      [[...CUSTOMER_VISIBLE_STATUSES.quote].sort().join("|"), "quote"],
    ]);
    const arrays = /\[\s*(?:"[^"\n]*"|'[^'\n]*')(?:\s*,\s*(?:"[^"\n]*"|'[^'\n]*'))*\s*,?\s*\]/g;
    const offenders: string[] = [];
    eachAppSource((p, code) => {
      for (const m of code.matchAll(arrays)) {
        const words = [...m[0].matchAll(/["']([^"']*)["']/g)].map((w) => w[1]).sort();
        const hit = targets.get(words.join("|"));
        if (hit) offenders.push(`${p} (${hit})`);
      }
    }, [join("src", "lib", "customer-visible-docs.ts")]);
    expect(
      offenders,
      `these keep their own copy of which papers a customer may open — call customerMayOpen instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
