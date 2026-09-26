import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * WAITING ON A CREDIT IS HONORED ON THE JOB'S COSTS TAB (audit v1018, class 4).
 *
 * /bills folds a paper a person set aside for a credit, with Stop Waiting as its only door. The
 * job's Named On A Paper list used to offer Record It As A Bill on that same paper and say nothing
 * about the wait: one tap put a cost the supplier is taking back onto the customer's job. Here it
 * is a plain row: who the credit is from, since when, and the door to where Stop Waiting lives.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/app/(app)/bills/supplier-actions", () => ({
  recordSupplierInvoiceAsBill: vi.fn(),
  setSupplierInvoiceJob: vi.fn(),
}));

import { JobPaperList, type JobPaperView } from "./job-paper-list";

const CED = "6fae3d9c";
const paper = (over: Partial<JobPaperView>): JobPaperView => ({
  id: "p",
  invoiceNumber: "8802-1107139",
  invoiceDate: "2026-09-01",
  jobNameRaw: "13683 HILLSIDE",
  total: 59.17,
  filed: false,
  accountId: CED,
  onNeedsYou: false,
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("Named On A Paper, Not Recorded Yet: a paper waiting on a credit", () => {
  const html = renderToStaticMarkup(
    createElement(JobPaperList, {
      jobId: "j45",
      papers: [
        paper({ id: "wait", waitingOnCredit: true, waitingSince: "2026-09-26", supplier: "CED" }),
        paper({ id: "open", invoiceNumber: "8802-1107820", jobNameRaw: "85 WHITNEY", total: 187.64, onNeedsYou: true }),
      ],
    }),
  );
  const rows = html.split("<li").slice(1);
  const waitRow = rows.find((r) => r.includes("8802-1107139"))!;
  const openRow = rows.find((r) => r.includes("8802-1107820"))!;

  it("says who the credit is from and since when, and offers no Record", () => {
    expect(text(waitRow)).toContain("Waiting on a credit from CED since");
    expect(waitRow).not.toContain("Record It As A Bill");
    expect(waitRow).not.toContain("<button");
  });

  it("its one door lands on that supplier's Waiting On A Credit fold, where Stop Waiting is (44px)", () => {
    expect(waitRow).toContain(`href="/bills#supplier-waiting-credit-${CED}"`);
    expect(text(waitRow)).toContain("Open It On Bills");
    expect(waitRow).toMatch(/<a[^>]*min-h-11/);
  });

  it("a paper nobody set aside keeps its Record It As A Bill", () => {
    expect(openRow).toContain("Record It As A Bill");
  });

  it("the explainer is a Why? fold, so the header line and the rows lead", () => {
    expect(html).toContain("<details");
    expect(text(html)).toContain("Why?");
    expect(html.indexOf("Why?")).toBeLessThan(html.indexOf("8802-1107139"));
  });

  it("a wait with no supplier name still says it, in words", () => {
    const one = renderToStaticMarkup(
      createElement(JobPaperList, { jobId: "j45", papers: [paper({ waitingOnCredit: true, waitingSince: null, supplier: null })] }),
    );
    expect(text(one)).toContain("Waiting on a credit from the supplier");
    expect(one).not.toContain("<button");
  });
});
