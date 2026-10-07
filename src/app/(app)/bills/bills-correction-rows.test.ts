import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A CORRECTION ON ALL BILLS (0381). The supplier's later paper for a purchase is its own bill, drawn
 * directly under the bill it corrects, indented, saying "Corrects 8802-SO-257899"; the original says
 * "Corrected by 8802-1109100 · $709.18 together". The paper order the page read (cn-v1063, newest
 * first) keeps the pair together. Correct This Bill is on a bill that is not a correction and not set
 * aside, once the page could read the column; a correction names the bill it follows instead of a
 * toggle the database would refuse. Totals and badges are untouched: two rows already sum right.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/bills",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ createBill: vi.fn(), deleteDocument: vi.fn(), setBillStatus: vi.fn(), deleteBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/app/(app)/purchasing/new-po-button", () => ({ NewPoButton: () => null }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn() }));
vi.mock("./receipt-billing-card", () => ({ ReceiptLines: () => null }));

import { BillsReceipts } from "./bills-receipts";

const JOB = { job_number: "J-011", name: "TEST Job" };
// Paper order, newest first: the correction (dated the day after) reads before its ticket.
const BILLS = [
  { id: "c", supplier: "CED", bill_number: "8802-1109100", shownNumber: "8802-1109100", amount: 95.99, status: "unpaid", bill_date: "2026-09-30", job_id: "j", category: "Materials", jobs: JOB, corrects_bill_id: "o" },
  { id: "x", supplier: "OSH", bill_number: null, shownNumber: null, amount: 16.28, status: "paid", bill_date: "2026-09-29", job_id: "j", category: "Receipt", jobs: JOB, corrects_bill_id: null },
  { id: "o", supplier: "CED", bill_number: "8802-SO-257899", shownNumber: "8802-SO-257899", amount: 613.19, status: "unpaid", bill_date: "2026-09-29", job_id: "j", category: "Receipt", jobs: JOB, corrects_bill_id: null },
  { id: "s", supplier: "CED", bill_number: "8802-1", shownNumber: "8802-1", amount: 95.27, status: "paid", bill_date: "2026-09-01", job_id: "j", category: "Receipt", jobs: JOB, superseded: true, corrects_bill_id: null },
];
const render = (correctionsReady: boolean) =>
  renderToStaticMarkup(createElement(BillsReceipts, { orgId: "org", jobs: [], lists: [], pos: [], bills: BILLS as never, docs: [], correctionsReady }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)).map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

describe("All Bills draws a correction under its original", () => {
  it("each half names the other, and the original says what the purchase comes to", () => {
    const t = text(render(true));
    expect(t).toContain("Corrects 8802-SO-257899");
    expect(t).toContain("Corrected by 8802-1109100 · $709.18 together");
  });

  it("the correction sits directly under its original, indented, and everything else keeps the paper order", () => {
    const html = render(true);
    const at = (id: string) => html.indexOf(`id="bill-${id}"`);
    expect(at("x")).toBeLessThan(at("o"));
    expect(at("o")).toBeLessThan(at("c"));
    expect(at("c")).toBeLessThan(at("s"));
    expect(html).toMatch(/<li class="border-l-4[^"]*"><details id="bill-c"/);
    expect(html).not.toMatch(/<li class="border-l-4[^"]*"><details id="bill-o"/);
  });

  it("Correct This Bill: on bills that are not corrections and not set aside, once the column is read", () => {
    // The ticket and the OSH run; not the correction, not the set-aside copy.
    expect(buttons(render(true)).filter((w) => w === "Correct This Bill")).toHaveLength(2);
    expect(buttons(render(false)).filter((w) => w === "Correct This Bill")).toHaveLength(0);
  });

  it("a correction's row says which bill it follows, never a toggle the database refuses", () => {
    const html = render(true);
    expect(Array.from(html.matchAll(/aria-label="Whether this bill is paid/g))).toHaveLength(3);
    expect(text(html)).toContain("Follows 8802-SO-257899");
  });

  it("the page reads the column on the newest rung of its ladder, says when it could not, and passes that down", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(page).toContain('${o.corrects ? ", corrects_bill_id, amount_paid" : ""}');
    expect(page).toContain("{ billable: true, supplierAccount: true, supersede: true, corrects: true },");
    expect(page).toContain("correctionsReady: !attempt.error && ladder[rung].corrects");
    expect(page).toContain("correctionsReady={correctionsReady}");
    const job = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(job).toContain('(withCorrects ? ", corrects_bill_id, amount_paid" : "")');
    expect(job).toContain("correctionsReady={correctionsReady}");
  });
});
