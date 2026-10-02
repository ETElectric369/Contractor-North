import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { SupplierPaperLists, theirPapersCount } from "./supplier-invoices-card";
import { supplierDocumentRows, supplierPaperFeed } from "./supplier-papers";

/**
 * NOTHING HE SET ASIDE VANISHES (0346). A bill waiting on a credit is off Needs You and My Day; on
 * /bills it is ONE folded line under its supplier, "Waiting On A Credit (1)", with Stop Waiting,
 * and it is not listed a second time in Their Papers' Not Recorded Yet (W1-33: was Not In Your Books).
 */

const CED = "acct-ced";
const hazelnut = {
  id: "hazelnut",
  supplier_account_id: CED,
  invoice_number: "8802-1107139",
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: "13683 HAZELNUT",
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
  const { rows } = supplierDocumentRows({ documents: [hazelnut], bills: [], links: [], aliasRows: [] });
  const jobs = [{ id: "j-045", jobNumber: "J-045", name: "13683 Hazelnut", status: "complete", address: "13683 Hazelnut Drive", createdAt: null }];
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
    expect(html).toContain("13683 HAZELNUT");
    expect(html).toMatch(/waiting since Sep 26, 2026, back Oct 26, 2026/);
    expect(html).toContain("Stop Waiting");
  });

  it("is never listed twice: not in Not Recorded Yet, not in Invoices With No Job, and Their Papers counts nothing for it", () => {
    const html = render(async () => ({ ok: true }));
    expect(html).not.toContain("Not Recorded Yet");
    expect(html).not.toContain("Not In Your Books");
    expect(html).not.toContain("Invoices With No Job");
    // Their Papers is there (its reference is inside), with no number: nothing open is in it.
    expect(html).toContain("Their Papers");
    expect(html).not.toMatch(/Their Papers \(/);
  });

  it("stays in view: Waiting On A Credit is not inside Their Papers", () => {
    const html = render(async () => ({ ok: true }));
    const their = html.indexOf('id="supplier-their-papers-acct-ced"');
    expect(their).toBeGreaterThan(-1);
    expect(html.indexOf('id="supplier-waiting-credit-acct-ced"')).toBeLessThan(their);
  });

  it("without the Stop Waiting action there is no button that can only refuse", () => {
    expect(render()).not.toContain("Stop Waiting");
  });
});

describe("Their Papers counts each open paper once (badges count what is open, once each)", () => {
  it("a STOCK paper with no job and no bill sits in both lists and is counted as one", () => {
    const stock = { ...hazelnut, id: "stock-1", invoice_number: "8802-1103061", job_name_raw: "STOCK", waiting_credit_since: null };
    const { rows } = supplierDocumentRows({ documents: [stock], bills: [], links: [], aliasRows: [] });
    const jobs = [{ id: "j-045", jobNumber: "J-045", name: "13683 Hazelnut", status: "complete", address: "13683 Hazelnut Drive", createdAt: null }];
    const feed = supplierPaperFeed({ since: "2026-06-08", rows, jobs, accounts: [{ id: CED, name: "Consolidated Electrical Distributors" }], today: "2026-10-01" });
    // Stock with no job is not a Needs You card: it stays in the supplier's own lists.
    expect(feed.cards).toEqual([]);
    const html = renderToStaticMarkup(
      createElement(SupplierPaperLists, {
        accountId: CED,
        accountName: "CED",
        feed: { invoices: rows, jobs, recordsSince: "2026-06-08" },
        today: "2026-10-01",
        onNeedsYou: [],
        waitingOnCredit: feed.waiting ?? [],
        actions: { setInvoiceJob: async () => ({ ok: true }) },
      }),
    );
    expect(html).toContain("Invoices With No Job (1)");
    expect(html).toContain("Not Recorded Yet (1)");
    expect(html).toContain("Their Papers (1)");
    expect(html).not.toContain("Their Papers (2)");
  });

  it("theirPapersCount counts distinct paper ids across the two lists", () => {
    expect(theirPapersCount([{ invoice: { id: "a" } }, { invoice: { id: "b" } }], [{ id: "a" }, { id: "c" }])).toBe(3);
    expect(theirPapersCount([], [])).toBe(0);
  });
});
