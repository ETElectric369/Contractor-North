import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { SupplierPaperLists } from "./supplier-invoices-card";
import { supplierDocumentRows, supplierPaperFeed } from "./supplier-papers";

/**
 * NOTHING HE SET ASIDE VANISHES (0346). A bill waiting on a credit is off Needs You and My Day; on
 * /bills it is ONE folded line under its supplier, "Waiting On A Credit (1)", with Stop Waiting,
 * and it is not listed a second time in Not In Your Books.
 */

const CED = "acct-ced";
const hillside = {
  id: "hillside",
  supplier_account_id: CED,
  invoice_number: "8802-1107139",
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: "13683 HILLSIDE",
  job_id: null,
  total: "59.17",
  open_balance: "59.17",
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: "invoice_8802-1107139.pdf",
  waiting_credit_since: "2026-09-27T00:10:00+00:00",
  jobs: null,
};

function render(stop?: () => Promise<{ ok: boolean }>) {
  const { rows } = supplierDocumentRows({ documents: [hillside], bills: [], links: [], aliasRows: [] });
  const jobs = [{ id: "j-045", jobNumber: "J-045", name: "13683 Hillside", status: "complete", address: "13683 Hillside Drive", createdAt: null }];
  const feed = supplierPaperFeed({ since: "2026-06-08", rows, jobs, accounts: [{ id: CED, name: "Consolidated Electrical Distributors" }], today: "2026-10-01" });
  expect(feed.cards).toEqual([]);
  return renderToStaticMarkup(
    createElement(SupplierPaperLists, {
      accountId: CED,
      accountName: "CED",
      feed: { invoices: rows, jobs, recordsSince: "2026-06-08" },
      today: "2026-10-01",
      onNeedsYou: [],
      waitingOnCredit: feed.waiting ?? [],
      actions: { setInvoiceJob: async () => ({ ok: true }), stopWaitingOnCredit: stop as never },
    }),
  );
}

describe("the Waiting On A Credit fold under CED", () => {
  it("is one line with its count and money, the paper, when it started and when it comes back", () => {
    const html = render(async () => ({ ok: true }));
    expect(html).toContain('id="supplier-waiting-credit-acct-ced"');
    expect(html).toContain("Waiting On A Credit (1)");
    expect(html).toContain("$59.17");
    expect(html).toContain("8802-1107139");
    expect(html).toContain("13683 HILLSIDE");
    expect(html).toMatch(/waiting since Sep 26, 2026, back Oct 26, 2026/);
    expect(html).toContain("Stop Waiting");
  });

  it("is never listed twice: not in Not In Your Books, not in Invoices With No Job", () => {
    const html = render(async () => ({ ok: true }));
    expect(html).not.toContain("Not In Your Books");
    expect(html).not.toContain("Invoices With No Job");
  });

  it("without the Stop Waiting action there is no button that can only refuse", () => {
    expect(render()).not.toContain("Stop Waiting");
  });
});
