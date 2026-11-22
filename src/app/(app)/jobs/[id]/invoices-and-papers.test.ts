import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/actions", () => ({ deleteDocument: vi.fn(), updateDocument: vi.fn(), linkReceiptToBill: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));
vi.mock("@/app/(app)/bills/supplier-actions", () => ({ recordSupplierInvoiceAsBill: vi.fn(), setSupplierInvoiceJob: vi.fn() }));
vi.mock("../../billing/actions", () => ({ setPaymentSchedule: vi.fn(), requestNextPayment: vi.fn() }));

import { JobDocuments } from "./job-documents";
import { JobPaperList } from "./job-paper-list";
import { PaymentScheduleCard } from "./payment-schedule-card";

/**
 * cn-v1174, the owner's reports 3 and 5 on a job's Invoices and Costs tabs.
 *  3. "this time and material box seems like it might be unnecessary ... bring more attention to the
 *     invoices on the top": no Time & Material box on any time and material job; each invoice is a
 *     card of its own.
 *  5. "receipts and papers need to show a summary and total amount for identification": one line of
 *     what the paper is and its total on the right (paper-summary.ts), the supplier on a Named on a
 *     Paper row.
 */
const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the Invoices tab", () => {
  const tab = page.slice(page.indexOf('id: "invoices"'), page.indexOf("<ContractCard"));

  it("no schedule card on a time and material job (the box is not drawn, invoices or none)", () => {
    expect(page).toContain('const isTmJob = (j as any).billing_type === "tm";');
    expect(tab).toMatch(/\{!isTmJob && \(on\("contracts"\) \|\| \(paymentMilestones \?\? \[\]\)\.length > 0\) && \(\s*<PaymentScheduleCard/);
  });

  it("and the card itself answers nothing for one, so no caller can draw the box", () => {
    const html = renderToStaticMarkup(createElement(PaymentScheduleCard, { jobId: "job-900", billingType: "tm" }));
    expect(html).toBe("");
  });

  it("a fixed-price job's schedule card is still drawn", () => {
    const html = renderToStaticMarkup(createElement(PaymentScheduleCard, { jobId: "job-900", billingType: "fixed" }));
    expect(text(html)).toContain("Payment schedule");
  });

  it("each invoice is a card of its own, in the house look", () => {
    expect(tab).toContain('<ul className="space-y-3">');
    expect(tab).toContain('<li key={iv.id} className="flex flex-col gap-1.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">');
    expect(tab).not.toContain('divide-y divide-slate-100');
  });

  it("the Get Paid door sits inside the invoice's card", () => {
    const li = tab.slice(tab.indexOf("<li key={iv.id}"), tab.indexOf("</li>"));
    expect(li).toContain('t("jb_getPaid")');
  });
});

describe("the Costs tab: Receipts & Papers", () => {
  const doc = { id: "d1", name: "IMG_0412.jpg", category: "Receipt", file_url: "o/j/d1.jpg", size_bytes: 1000, created_at: "2026-11-18T18:00:00Z", signedUrl: null };

  it("the reader's own record is read: the organized_items select carries what the row shows", () => {
    expect(page).toMatch(/from\("organized_items"\)[\s\S]{0,800}title, summary, vendor, amount, item_date, doc_number/);
  });

  it("a paper with facts says what it is and its total, ahead of the kind chip", () => {
    const html = renderToStaticMarkup(
      createElement(JobDocuments, {
        orgId: "o1",
        jobId: "job-900",
        docs: [doc],
        looseIds: ["d1"],
        billOf: { d1: "the Northline Supply bill #INV-900" },
        facts: { d1: { what: "Wire, Box +2 more", total: 412.5 } },
      }),
    );
    const s = text(html);
    expect(s).toContain("IMG_0412.jpg");
    expect(s).toContain("Wire, Box +2 more");
    expect(s).toContain("On the Northline Supply bill #INV-900.");
    expect(html.indexOf("$412.50")).toBeGreaterThan(-1);
    expect(html.indexOf("$412.50")).toBeLessThan(html.indexOf(">Receipt<"));
  });

  it("a paper nobody read says nothing and shows no figure (never $0)", () => {
    const html = renderToStaticMarkup(createElement(JobDocuments, { orgId: "o1", jobId: "job-900", docs: [doc], looseIds: ["d1"], facts: {} }));
    expect(html).not.toContain("$");
  });

  it("the page hands facts to the office only", () => {
    expect(page).toContain("facts={viewerIsStaff ? paperFacts : null}");
    expect(page).toContain("billWhat={billWhat}");
  });
});

describe("the Costs tab: Named on a Paper, Not Recorded Yet", () => {
  it("each row names its supplier", () => {
    const html = renderToStaticMarkup(
      createElement(JobPaperList, {
        jobId: "job-900",
        papers: [{ id: "p1", invoiceNumber: "INV-900", invoiceDate: "2026-11-01", jobNameRaw: null, total: 59.17, filed: false, accountId: "a1", onNeedsYou: false, supplier: "Northline Supply" }],
      }),
    );
    expect(text(html)).toContain("Northline Supply · INV-900");
  });
});
