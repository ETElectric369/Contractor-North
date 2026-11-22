import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE OFFICE'S PAPER STATES THE DEPOSIT THE LINK STATES (cn-v1178, audit B6). The print page (and the PDF
 * and the customer's Download, which are its bytes) read the sale's live deposit request through
 * lib/payment-request liveRequestForQuote, the one reader: its ask, never the stored figure beside it, and
 * "Deposit received" once it is paid. With no request, the stored figure. A read that fails prints the
 * stored figure and is reported. Rendered over a client that answers what each read asks: the family from
 * rpc("quote_family_ids"), the request only when its estimate is in the read's in("quote_id", …) list.
 */
const w = vi.hoisted(() => ({
  quote: {} as Record<string, unknown>,
  family: [] as string[],
  request: null as null | { quote_id: string; invoice_number: string; total: number; amount_paid: number; status: string },
  familyFails: false,
}));
const REF = "id, invoice_number, public_token, title, total, amount_paid, status, job_id, quote_id";
function builder(table: string) {
  let sel = "";
  const inList: Record<string, unknown[]> = {};
  const answer = () => {
    if (table === "quotes") return { data: w.quote, error: null };
    if (table === "quote_line_items") return { data: [{ id: "l1", description: "Panel swap", quantity: 1, unit: "ea", unit_price: 4800, line_total: 4800, sort_order: 0, detail: null }], error: null };
    if (table === "organizations") return { data: { name: "Main Street Electric", settings: {} }, error: null };
    if (table === "invoices" && sel === REF) {
      const r = w.request;
      const hit = r && (inList.quote_id ?? []).includes(r.quote_id) && r.status !== "void";
      return { data: hit ? { id: "inv-900", public_token: "t", title: "Deposit", job_id: "j1", ...r } : null, error: null };
    }
    return { data: null, error: null };
  };
  const b: any = {
    select: (c: string) => ((sel = c), b),
    in: (col: string, v: unknown[]) => ((inList[col] = v), b),
    maybeSingle: async () => answer(),
    single: async () => answer(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, bad),
  };
  for (const m of ["eq", "neq", "is", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: async () => (w.familyFails ? { data: null, error: { message: "function public.quote_family_ids does not exist" } } : { data: w.family, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));
vi.mock("@/components/back-link", () => ({ BackLink: () => null }));
vi.mock("@/components/print-button", () => ({ PrintButton: () => null }));
const report = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observe", () => ({ reportError: report }));

const { default: QuotePrintPage } = await import("./page");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
const paper = async () => text(renderToStaticMarkup(await QuotePrintPage({ params: Promise.resolve({ id: "q-rev" }) })));

beforeEach(() => {
  w.quote = {
    id: "q-rev", org_id: "org-1", quote_number: "E-901", status: "sent", doc_type: "estimate", title: "Snowbell panel", created_at: "2026-11-20T18:00:00Z",
    valid_until: null, subtotal: 4800, tax_rate: 0, tax: 0, total: 4800, notes: null, deposit_amount: 480, customers: { name: "Sam Tillery" }, jobs: null, inquiries: null,
  };
  w.family = [];
  w.request = null;
  w.familyFails = false;
  report.mockClear();
});

describe("the print page's deposit line", () => {
  it("no request: the stored figure, due on acceptance", async () => {
    expect(await paper()).toContain("Deposit due on acceptance: $480.00");
  });

  it("a REVISION whose sale's request (on the original) is paid: that request's ask, received; never the revision's stored figure", async () => {
    w.quote.deposit_amount = 650;
    w.family = ["q-rev", "q-orig"];
    w.request = { quote_id: "q-orig", invoice_number: "INV-900", total: 480, amount_paid: 480, status: "paid" };
    const p = await paper();
    expect(p).toContain("Deposit received: $480.00");
    expect(p).not.toContain("Deposit due on acceptance");
    expect(p).not.toContain("$650.00");
  });

  it("a live unpaid request the office typed differently: the request's ask, still due", async () => {
    w.family = ["q-rev"];
    w.request = { quote_id: "q-rev", invoice_number: "INV-900", total: 300, amount_paid: 0, status: "sent" };
    expect(await paper()).toContain("Deposit due on acceptance: $300.00");
  });

  it("a family read that fails: the stored figure is printed and the failure reported", async () => {
    w.familyFails = true;
    expect(await paper()).toContain("Deposit due on acceptance: $480.00");
    expect(report).toHaveBeenCalledWith("print/quote:depositRequest", expect.anything(), { quoteId: "q-rev" });
  });
});
