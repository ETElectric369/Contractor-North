import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FILE WITH ITS BILL ON THE CREDIT'S OWN ROW (cn-v1184). The owner recorded a credit from the job page
 * (a bill below zero on J-901); its row carries the door and one slate line, on the Costs tab and on
 * the Bills page. Not on a purchase, not on a correction, not in the fold of an invoice that went out;
 * a draft's fold keeps it (the owner's exact case).
 */
vi.mock("@/app/(app)/jobs/actions", () => ({ deleteBill: vi.fn(), setBillStatus: vi.fn(), createBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/organize/credit-memo-actions", () => ({ returnBillHome: vi.fn(), fileReturnBillWithItsBill: vi.fn(), creditMemoHome: vi.fn(), fileCreditMemoWithItsBill: vi.fn() }));

const { JobBills } = await import("./job-bills");

const bill = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  supplier: "Northline Supply",
  bill_number: `N-${id}`,
  amount: -19.02,
  status: "unpaid",
  amount_paid: 0,
  bill_date: "2026-11-20",
  corrects_bill_id: null,
  bill_line_items: [{ description: "1/2 in EMT Connector Steel", amount: -19.02, billable: true }],
  ...o,
});
const bills = [
  bill("credit1"),
  bill("buy1", { amount: 50.74 }),
  bill("fixed1", { corrects_bill_id: "buy1" }),
  bill("nolines", { bill_line_items: [] }),
  bill("filed1", { bill_line_items: [{ description: "1/2 in EMT Connector Steel", amount: -19.02, billable: false }] }),
  bill("indraft"),
  bill("insent"),
];
const inv = (id: string, status: string) => ({ id, invoice_number: id.toUpperCase(), status, created_at: "2026-11-21T10:00:00Z" });
const groups = {
  open: { ids: ["credit1", "buy1", "fixed1", "nolines", "filed1"], bills: 5, pos: 0, takes: 0, total: 0 },
  openOwn: {},
  billed: [
    { ids: ["indraft"], bills: 1, pos: 0, takes: 0, total: -19.02, invoice: inv("inv-906", "draft"), draft: true, offJobNumber: null },
    { ids: ["insent"], bills: 1, pos: 0, takes: 0, total: -19.02, invoice: inv("inv-905", "sent"), draft: false, offJobNumber: null },
  ],
  nothing: [],
  stock: {},
};
const rowOf = (html: string, number: string) => {
  const at = html.indexOf(`#${number} `);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
};
const render = (o: Record<string, unknown>) => renderToStaticMarkup(createElement(JobBills, { jobId: "job-1", bills: bills as any, pos: [], correctionsReady: true, ...o } as any));

describe("the Costs tab row", () => {
  const html = render({ groups });
  it("a credit on the job: the slate line and the door", () => {
    const row = rowOf(html, "N-credit1");
    expect(row).toContain("Not filed with its bill yet.");
    expect(row).toMatch(/<button[^>]*>File With Its Bill<\/button>/);
  });
  it("its part lines off: the door leaves the row, and the row says only that (never 'Filed': skeptic #86, S5)", () => {
    const row = rowOf(html, "N-filed1");
    expect(row).not.toContain("File With Its Bill");
    expect(row).toContain("Its lines are off the customer&#x27;s bill.");
    expect(row).not.toContain("Filed with its bills.");
    expect(row).not.toContain("Not filed with its bill yet.");
  });
  it("held by a draft: still offered", () => {
    expect(rowOf(html, "N-indraft")).toContain("File With Its Bill");
  });
  it("not on a purchase, a correction, a credit with no lines, or one in a sent invoice's fold", () => {
    for (const n of ["N-buy1", "N-fixed1", "N-nolines", "N-insent"]) {
      expect(rowOf(html, n)).not.toContain("File With Its Bill");
      expect(rowOf(html, n)).not.toContain("Not filed with its bill yet.");
    }
  });
  it("the one plain list (claims not read) offers it: the server's sentence refuses where it must", () => {
    expect(rowOf(render({ groups: null }), "N-insent")).toContain("File With Its Bill");
  });
  it("not before the correction column is read", () => {
    expect(render({ groups, correctionsReady: false })).not.toContain("File With Its Bill");
  });
});

describe("the Bills page row", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-receipts.tsx"), "utf8");
  it("asks the one predicate and the one slate line, with the page's own facts, and draws the one door", () => {
    expect(src).toContain('import { returnRowLine, rowOffersFileWithItsBill } from "@/lib/return-bill-door";');
    expect(src).toMatch(/bill: \{ amount: b\.amount, job_id: b\.job_id, corrects_bill_id: b\.corrects_bill_id \?\? null, superseded: b\.superseded \?\? null \},\s*hasCorrections: \(correctionsOf\.get\(b\.id\)\?\.length \?\? 0\) > 0,\s*lines: b\.line_items,/);
    expect(src).toContain("{rowOffersFileWithItsBill(creditRow) && <ReturnBillDoor billId={b.id} />}");
    expect(src).toContain("{creditLine && <span className=\"block text-xs text-slate-600\">{creditLine}</span>}");
    expect(src.match(/<ReturnBillDoor billId=\{b\.id\} \/>/g)?.length).toBe(1);
  });
});
