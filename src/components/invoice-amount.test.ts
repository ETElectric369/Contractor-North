import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvoiceAmount, InvoiceAmountDetail } from "./invoice-amount";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

// Made-up figures only: this repo is public.
describe("the invoice row amount — the total inline with what is due (d103cb9f)", () => {
  it("reads '$D due of $T' on one line, with what is paid beneath, from sm up", () => {
    const out = html(createElement(InvoiceAmount, { total: 8318.62, paid: 6760 }));
    expect(text(out)).toContain("$1,558.62 due of $8,318.62");
    expect(text(out)).toContain("$6,760.00 paid");
    expect(out).toContain("hidden flex-col items-end text-right sm:flex");
    // The due and the total share one nowrap line: the total can't wrap away from its figure.
    expect(out).toMatch(/<span class="whitespace-nowrap text-sm"><span[^>]*>\$1,558\.62<\/span> <span[^>]*>due of \$8,318\.62<\/span><\/span>/);
  });

  it("shows the bill's size on a paid-in-full row, and on a row with nothing paid", () => {
    expect(text(html(createElement(InvoiceAmount, { total: 624.49, paid: 624.49 })))).toContain("$0.00 due of $624.49paid in full");
    const unpaid = text(html(createElement(InvoiceAmount, { total: 766.35, paid: 0 })));
    expect(unpaid).toBe("$766.35 due of $766.35");
  });

  it("puts the same line under the left-hand text on a phone, where the paid note truncates first", () => {
    const out = html(createElement(InvoiceAmountDetail, { total: 8318.62, paid: 6760, overdue: true }));
    expect(out).toContain("sm:hidden");
    expect(text(out)).toContain("$1,558.62 due of $8,318.62");
    expect(out).toMatch(/<span class="shrink-0 whitespace-nowrap">/);
    expect(out).toMatch(/<span class="min-w-0 truncate[^"]*">· \$6,760\.00 paid<\/span>/);
    expect(out).toContain("text-red-700");
  });

  it("says Void, never due, on a void row — on both halves", () => {
    for (const C of [InvoiceAmount, InvoiceAmountDetail]) {
      const t = text(html(createElement(C, { total: 766.35, paid: 0, status: "void" })));
      expect(t).toContain("Void · was $766.35");
      expect(t).not.toContain("due");
    }
  });

  it("is the one amount on the customer's and the job's Invoices tabs, and the AR page, too", () => {
    for (const f of ["src/app/(app)/crm/[id]/page.tsx", "src/app/(app)/jobs/[id]/page.tsx", "src/app/(app)/billing/ar/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toContain('from "@/components/invoice-amount"');
      expect(src, f).toContain("<InvoiceAmount ");
      expect(src, f).toContain("<InvoiceAmountDetail ");
    }
    // The lists that can hold a void invoice hand the row's status over, so it never reads "due".
    for (const f of ["src/app/(app)/crm/[id]/page.tsx", "src/app/(app)/jobs/[id]/page.tsx", "src/app/(app)/billing/page.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).toMatch(/<InvoiceAmount [^>]*status=\{/);
    }
  });
});
