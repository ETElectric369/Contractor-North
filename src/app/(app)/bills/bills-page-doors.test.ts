import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * EVERY DOOR ON /bills KEEPS EXACTLY ONE HOME (Bills plan, Wave B).
 *
 * Wave B rebuilt the page: title, search, Needs You, one line per supplier (its detail holds the
 * numbers, Record A Payment, its bills, payments, names, and the supplier's own papers as short
 * folded lists), All Bills (the ledger, folded, a receipt's switches in its own row), and More
 * (the import and supplier-name housekeeping). A rebuild like that is exactly how a door the
 * office uses goes missing without anybody noticing, so this renders THE PAGE ITSELF - the
 * server component, with a fake database answering in live shapes (ET's CED account and papers,
 * a register supplier, a receipt with a roll on the shelf, a duplicate ticket, four spellings) -
 * and finds every door in the one section that is its home.
 *
 * Everything below Needs You is a native <details>, so a folded door is still in the markup: the
 * static render sees every one without a tap.
 */

const ORG = "org-fixture";
const J028 = "job-028";
const J033 = "job-033";
const J006 = "job-006";
const J050 = "job-050";
const J011 = "job-011";
const J030 = "job-030";
const CED = "acct-ced";
const OSH = "acct-osh";

const job = (id: string, job_number: string, name: string, status: string, address: string, created_at: string) => ({
  id,
  job_number,
  name,
  status,
  address,
  created_at,
  customers: null,
});
const JOBS = [
  job(J028, "J-028", "85 Whitney Place", "in_progress", "85 Whitney Court", "2026-08-20T00:00:00Z"),
  job(J033, "J-033", "5659 Rhodesia", "complete", "5659 Rhodesia Rd", "2026-07-11T00:00:00Z"),
  job(J006, "J-006", "5659 Rhodesia", "complete", "5659 Rhodesia Rd", "2026-06-11T00:00:00Z"),
  job(J050, "J-050", "3639 Saddle Road", "complete", "3639 Saddle Rd", "2026-06-01T00:00:00Z"),
  job(J011, "J-011", "13897 Herringbone", "in_progress", "13897 Herringbone Way", "2026-06-20T00:00:00Z"),
  job(J030, "J-030", "13631 Northwoods", "complete", "13631 Northwoods Blvd", "2026-07-20T00:00:00Z"),
];
const jobRef = (id: string) => {
  const j = JOBS.find((x) => x.id === id)!;
  return { job_number: j.job_number, name: j.name };
};

let lineSeq = 0;
const line = (description: string, amount: number, over: Record<string, unknown> = {}) => ({
  id: `line-${++lineSeq}`,
  description,
  quantity: 1,
  unit_price: amount,
  amount,
  category: "Materials",
  billable: true,
  billed_amount: null,
  is_stock: false,
  sort_order: lineSeq,
  ...over,
});
const bill = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier: "Consolidated Electrical Distributors, Inc. (CED)",
  bill_number: null,
  amount: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
  job_id: null,
  po_id: null,
  category: null,
  notes: null,
  supplier_account_id: null,
  supplier_invoice_number: null,
  is_statement: false,
  superseded_by_bill_id: null,
  pricing_provisional: false,
  jobs: null,
  bill_line_items: [],
  ...over,
});

const EIGHT = ["WAGO 221-413", "1/2 EMT", "1/2 EMT CONN", "1/2 EMT CPLG", "4SQ BOX", "4SQ RING", "12 THHN BLK", "12 THHN WHT"];
const ticketLines = () => EIGHT.map((d, i) => line(d, i === 0 ? 11.91 : 11.91, {}));

const BILLS = [
  // The counter ticket that may be CED's 8802-1107820 (a sales-order number, never on CED's invoice).
  bill("b-ticket", { amount: 187.0, bill_date: "2026-09-16", job_id: J028, jobs: jobRef(J028), supplier_account_id: CED }),
  // A scanned statement carrying two CED invoices on its own lines: both papers are covered.
  bill("b-statement", {
    amount: 3034.54,
    bill_date: "2026-08-17",
    job_id: J028,
    jobs: jobRef(J028),
    supplier_account_id: CED,
    notes: "TR-34426_20260817_32136931_statement.pdf",
    bill_line_items: [line("Statement (Invoice 8802-1105868)", 2950.17), line("Statement (Invoice 8802-1105963)", 84.37)],
  }),
  // Herringbone's CED bill, recorded with its number.
  bill("b-herringbone", {
    amount: 301.81,
    bill_date: "2026-09-04",
    job_id: J011,
    jobs: jobRef(J011),
    supplier_account_id: CED,
    bill_number: "8802-1106969",
    bill_line_items: [line("H245ICAT 4in LED shallow IC housing", 301.81)],
  }),
  bill("b-1107088", { amount: 456.02, bill_date: "2026-09-01", job_id: J011, jobs: jobRef(J011), supplier_account_id: CED, supplier_invoice_number: "8802-1107088" }),
  // A receipt with a snack switched off and a wire-nut box billed whole: the switches' home.
  bill("b-osh", {
    supplier: "OSH - Cupertino",
    amount: 110.85,
    status: "paid",
    bill_date: "2026-09-17",
    job_id: J011,
    jobs: jobRef(J011),
    supplier_account_id: OSH,
    bill_line_items: [line("IDEAL 30641 Twister wire nuts 500ct", 108.36), line("Smartwater 1L", 2.49, { billable: false, category: "Snacks" })],
  }),
  // A coil with a roll on the shelf: Take It Off The Shelf.
  bill("b-coil", {
    amount: 180.17,
    status: "paid",
    bill_date: "2026-08-19",
    job_id: J011,
    jobs: jobRef(J011),
    supplier_account_id: CED,
    bill_line_items: [line("NMB 12/2 W/GND (250 ft Coil)", 180.17, { id: "line-coil", billed_amount: 0, is_stock: true })],
  }),
  // Marked On Account at a supplier he pays at the register: Turn On A Running Balance.
  bill("b-osh-unpaid", { supplier: "OSH - Cupertino", amount: 16.28, bill_date: "2026-09-18", job_id: J011, jobs: jobRef(J011), supplier_account_id: OSH }),
  // Spellings on no account: a saved alias (Accept And File Them There), a pair (Not The Same), the
  // Sunnyvale counter (the same-supplier question), and a till store (Give It Its Own Account).
  bill("b-dist", { supplier: "Consolidated Electrical Dist.", amount: 147.92, bill_date: "2026-09-23", job_id: J028, jobs: jobRef(J028) }),
  bill("b-swig1", { supplier: "Swigard's Hardware", amount: 19.18, status: "paid", bill_date: "2026-06-17", job_id: J011, jobs: jobRef(J011) }),
  bill("b-swig2", { supplier: "Swigards Hardware", amount: 25.4, status: "paid", bill_date: "2026-07-02", job_id: J011, jobs: jobRef(J011) }),
  bill("b-sunnyvale", { supplier: "Contractors Electrical Distributors", amount: 467.87, bill_date: "2026-07-14", job_id: J011, jobs: jobRef(J011) }),
  bill("b-depot", { supplier: "The Home Depot", amount: 47.44, status: "paid", bill_date: "2026-06-08", job_id: J030, jobs: jobRef(J030) }),
  // The same $95.27 ticket filed to two jobs.
  bill("b-dup-a", { amount: 95.27, bill_date: "2026-07-29", job_id: J030, jobs: jobRef(J030), supplier_account_id: CED, notes: "TR-34426_20260729_1.pdf", bill_line_items: ticketLines() }),
  bill("b-dup-b", { amount: 95.27, bill_date: "2026-08-28", job_id: J028, jobs: jobRef(J028), supplier_account_id: CED, notes: "85 Whit.pdf", bill_line_items: ticketLines() }),
  // A business cost with no job.
  bill("b-gas", { supplier: "Gas & Truck", amount: 64.1, status: "paid", bill_date: "2026-09-10", category: "Gas & Truck" }),
];

const doc = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier_account_id: CED,
  invoice_number: "",
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: null,
  job_id: null,
  total: 0,
  open_balance: null,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  jobs: null,
  ...over,
});
const SUPPLIER_INVOICES = [
  // The one he was hunting: a card, the matcher suggests J-028, a ticket may be the same purchase.
  doc("si-1107820", { invoice_number: "8802-1107820", invoice_date: "2026-09-16", job_name_raw: "85 WHITNEY", total: 187.64, open_balance: 187.64, discount_amount: 1.77, discount_by: "2026-10-10" }),
  // Only Erik knows which Rhodesia: chips.
  doc("si-1100090", { invoice_number: "8802-1100090", invoice_date: "2026-06-20", job_name_raw: "5659 RHODESIA", total: 744.96, open_balance: 0, closed: true }),
  // Already on J-050, no bill: Record It On J-050.
  doc("si-1099048", { invoice_number: "8802-1099048", invoice_date: "2026-06-12", job_name_raw: "3639 SADDLE RD", job_id: J050, jobs: { name: "3639 Saddle Road" }, total: 355.17, open_balance: 0, closed: true }),
  // Nothing to go on: Pick A Job.
  doc("si-1102291", { invoice_number: "8802-1102291", invoice_date: "2026-06-29", job_name_raw: "CUSTOMER ORDER NO.", total: 451.75, open_balance: 0, closed: true }),
  // CED booked it to STOCK: never a card; Record To Shelf in the supplier's own lists.
  doc("si-1103061", { invoice_number: "8802-1103061", invoice_date: "2026-07-21", job_name_raw: "STOCK", total: 114.4, open_balance: 0, closed: true }),
  // A credit memo on no job: never a card; File It On This Job in the supplier's own lists.
  doc("si-1108541", { invoice_number: "8802-1108541", kind: "credit_memo", invoice_date: "2026-09-18", job_name_raw: "13897 HERRINGBONE", total: -115.33, open_balance: -115.33 }),
  // Covered by the statement bill's lines, and by numbers on bills.
  doc("si-1105868", { invoice_number: "8802-1105868", invoice_date: "2026-08-12", job_name_raw: "85 WHITNEY", total: 2950.17, open_balance: 2950.17 }),
  doc("si-1105963", { invoice_number: "8802-1105963", invoice_date: "2026-08-13", job_name_raw: "85 WHITNEY", total: 84.37, open_balance: 84.37 }),
  doc("si-1106969", { invoice_number: "8802-1106969", invoice_date: "2026-09-04", job_name_raw: "13897 HERRINGBONE", total: 301.81, open_balance: 301.81, discount_amount: 5.54, discount_by: "2026-10-10" }),
  doc("si-1107088", { invoice_number: "8802-1107088", invoice_date: "2026-09-01", job_name_raw: "13897 HERRINGBONE", total: 456.02, open_balance: 456.02, discount_amount: 4.7, discount_by: "2026-10-10" }),
  doc("si-sc0901", { invoice_number: "8802-SC0901", kind: "service_charge", invoice_date: "2026-09-01", total: 23.21, open_balance: 23.21 }),
];

const TABLES: Record<string, unknown[]> = {
  profiles: [{ org_id: ORG, full_name: "Erik Taylor", organizations: { name: "ET Electric" } }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" }, name: "ET Electric" }],
  purchase_orders: [{ id: "po-1", po_number: "PO-001", vendor: "CED", status: "draft", total: 412.5, job_id: J011, jobs: { name: "13897 Herringbone" } }],
  bills: BILLS,
  documents: [
    { id: "doc-1", name: "IMG_0412.jpg", category: "Receipt", file_url: `${ORG}/${J011}/1-IMG_0412.jpg`, size_bytes: 1000, created_at: "2026-09-17T18:00:00Z", job_id: J011, jobs: { name: "13897 Herringbone" } },
  ],
  jobs: JOBS,
  material_lists: [{ id: "ml-1", name: "Herringbone rough-in" }],
  supplier_accounts: [
    { id: CED, name: "Consolidated Electrical Distributors", account_number: "TR-34426", branch_code: "8802", on_account: true, note: null },
    { id: OSH, name: "Outdoor Supply Hardware (OSH - Cupertino)", account_number: null, branch_code: null, on_account: false, note: null },
  ],
  supplier_aliases: [
    { id: "al-1", supplier_account_id: CED, alias: "Consolidated Electrical Distributors, Inc. (CED)", branch_label: null },
    { id: "al-2", supplier_account_id: CED, alias: "Consolidated Electrical Dist.", branch_label: null },
    { id: "al-3", supplier_account_id: OSH, alias: "OSH - Cupertino", branch_label: null },
  ],
  supplier_payments: [
    { id: "pay-1", supplier_account_id: CED, amount: 2000, paid_on: "2026-09-05", method: "check", reference: "1042", note: null, voided_at: null },
  ],
  supplier_invoices: SUPPLIER_INVOICES,
  bill_supplier_invoices: [{ bill_id: "b-herringbone", supplier_invoice_id: "si-1106969" }],
  organized_items: [
    {
      id: "tray-1",
      kind: "receipt",
      source: "bills_drop",
      status: "needs_review",
      doc_type: "receipt",
      vendor: "Home Depot",
      amount: 84.12,
      payment: "paid_at_purchase",
      title: "IMG_0413.jpg",
      created_at: "2026-09-24T12:00:00Z",
      file_url: null,
      jobs: null,
    },
  ],
  stock_lot_balance: [
    { lot_id: "lot-1", bill_line_id: "line-coil", item_id: "item-1", pieces: 250, unit: "ft", cost: 180.17, pieces_left: 250, cost_left: 180.17, live_moves: 0, cost_stale: false },
  ],
  inventory_items: [{ id: "item-1", name: "NMB 12/2 W/GND" }],
  invoice_items: [],
};

/** A PostgREST chain whose every read answers with that table's rows. */
function chain(table: string) {
  const rows = TABLES[table] ?? [];
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "filter", "range"]) c[m] = () => c;
  c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-erik" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
  storage: {
    from: () => ({
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}` })) }),
    }),
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/bills",
  redirect: () => {},
}));

let html = "";
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  const { default: BillsPage } = await import("./page");
  html = renderToStaticMarkup((await BillsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
}, 30_000);
afterAll(() => vi.useRealTimers());

/** The element carrying `id`, whole: from its opening tag to the tag that closes it. */
function section(id: string): string {
  const at = html.indexOf(` id="${id}"`);
  if (at < 0) throw new Error(`no element with id ${id}`);
  const open = html.lastIndexOf("<", at);
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(open))![1];
  const re = new RegExp(`<(/?)${tag}(?=[\\s>])[^>]*>`, "g");
  re.lastIndex = open;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}
/** What a person reads on a control: its text, tags and whitespace dropped. */
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
/** The words on every <button>, <a> and <summary> in a piece of the page. */
function doors(s: string): string[] {
  return Array.from(s.matchAll(/<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)).map((m) => text(m[2]).trim());
}
const count = (list: string[], label: string | RegExp) =>
  list.filter((d) => (typeof label === "string" ? d === label : label.test(d))).length;

describe("the page, in Wave B's order", () => {
  it("reads Bills, search, Needs You, Suppliers, All Bills, More, top to bottom", () => {
    expect(text(html)).toContain("Bills");
    expect(html).not.toContain("Bills &amp; purchasing");
    const order = ['id="bills-search"', 'id="needs-you"', 'id="sort-these"', 'id="suppliers"', 'id="all-bills"', 'id="more"'].map((k) => html.indexOf(k));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

/**
 * BEFORE AND AFTER, EVERY DOOR THE PAGE HAD (recon of cn-v1015, section by section) and where it
 * lives now. `home` is the section id it must be found in; `times` is how many of it that home
 * must hold for this fixture, which is what "exactly one home" means for a door that repeats per
 * row.
 */
const HOMES: { door: string | RegExp; was: string; home: string; times?: number }[] = [
  // 0. The header
  { door: "Drop Paperwork", was: "header", home: "header" },
  { door: "Add Business Cost", was: "header", home: "header" },
  // Needs You (cn-v1014): the one place the supplier-paper decisions happen.
  { door: "Put It On J-028", was: "Needs You", home: "needs-you" },
  { door: /^J-033 · /, was: "Needs You (ASK chips)", home: "needs-you" },
  { door: "Record It On J-050", was: "Needs You (and CED 3b Record It As A Bill)", home: "needs-you" },
  { door: "Pick A Job", was: "Needs You", home: "needs-you" },
  { door: "Another Job", was: "Needs You", home: "needs-you", times: 3 },
  { door: "Shop Stock", was: "Needs You (and CED 3b Record To Shelf)", home: "needs-you", times: 4 },
  { door: "Business Cost", was: "Needs You", home: "needs-you", times: 4 },
  { door: "Same Purchase: Tie Them", was: "Needs You (and CED 3b)", home: "needs-you" },
  // 1. Sort These
  { door: "Add More", was: "Sort These", home: "sort-these" },
  { door: "File It", was: "Sort These (per paper)", home: "sort-these" },
  // 2. What You Owe Your Suppliers -> one line per supplier, its detail
  { door: /^Consolidated Electrical Distributors Account TR-34426/, was: "account row tap", home: "suppliers" },
  { door: "Record A Payment", was: "account row AND the CED discount section", home: "suppliers", times: 1 },
  { door: "Turn On A Running Balance", was: "account row", home: "suppliers" },
  { door: "Undo", was: "account row (per payment)", home: "suppliers" },
  { door: "Edit Account", was: "account row", home: "suppliers", times: 2 },
  { door: /^Names It's Filed Under \(\d+\)$/, was: "account row ('Filed under:' text)", home: "suppliers", times: 2 },
  { door: /^\$615\.79 On 2 Bills With No Supplier Account File It$/, was: "amber 'not on a supplier account' line", home: "suppliers" },
  // 3. What CED Says You Owe -> short folded lists inside CED's detail
  { door: /^Invoices With No Job \(\d+\)/, was: "CED 3a", home: "suppliers" },
  { door: "File It On This Job", was: "CED 3a (row picker)", home: "suppliers" },
  { door: /^Not In Your Books \(\d+\)/, was: "CED 3b", home: "suppliers" },
  { door: "Record To Shelf", was: "CED 3b", home: "suppliers" },
  { door: /^Discount Still On The Table/, was: "CED 3c", home: "suppliers" },
  { door: /^What Consolidated Electrical Distributors Has Open \(7\)$/, was: "CED 3d", home: "suppliers" },
  { door: /^Show The Other 1, Holding/, was: "CED 'Show The Other N' (x4)", home: "suppliers" },
  // 9 + 10. What Your Customers Get Billed + the tabs -> All Bills
  { door: /^All Bills \(\d+\)/, was: "the tabs under the page", home: "all-bills" },
  { door: "Bills 15", was: "tab", home: "all-bills" },
  { door: "Purchase Orders 1", was: "tab (the default, and empty)", home: "all-bills" },
  { door: "Receipts 1", was: "tab", home: "all-bills" },
  { door: "Add A Bill By Hand", was: "the always-open Add Bill form", home: "all-bills" },
  { door: "Add Bill", was: "Bills tab (size sm)", home: "all-bills" },
  { door: "All (15)", was: "filter pill (~26px)", home: "all-bills" },
  { door: /^Job Bills \(\d+\)$/, was: "filter pill", home: "all-bills" },
  { door: /^Business Costs \(\d+\)$/, was: "filter pill", home: "all-bills" },
  { door: /^(Settled|On Account) Switch$/, was: "Settled/On Account badge toggle", home: "all-bills", times: 15 },
  { door: "Edit", was: "pencil icon (bare 16px)", home: "all-bills", times: 15 },
  { door: "Delete", was: "trash icon (bare 16px)", home: "all-bills", times: 15 },
  { door: /^Bill Only What This Job Used$/, was: "receipt card, per line", home: "all-bills" },
  { door: "Put The Rest On The Shelf", was: "receipt card, per line", home: "all-bills" },
  { door: "Take It Off The Shelf", was: "receipt card, per line", home: "all-bills", times: 1 },
  { door: "New PO", was: "Purchase Orders tab", home: "all-bills" },
  { door: /^PO-001 · CED/, was: "Purchase Orders row", home: "all-bills" },
  { door: "Upload", was: "Receipts tab", home: "all-bills" },
  { door: "Photo", was: "Receipts tab", home: "all-bills" },
  { door: "IMG_0412.jpg", was: "Receipts tab file link", home: "all-bills" },
  // 4-8. Housekeeping and the import -> More
  { door: /^More · /, was: "(new fold)", home: "more" },
  { door: "Import Supplier Invoices", was: "Import fold", home: "more" },
  { door: "Choose CED PDFs", was: "Import fold", home: "more" },
  { door: "Paste Text Instead", was: "Import fold", home: "more" },
  { door: "Import Documents", was: "Import fold", home: "more" },
  { door: /^Accept And (File Them There|Make The Account)$/, was: "Supplier Names That Look Like One Account", home: "more" },
  { door: "Not The Same", was: "Supplier Names That Look Like One Account", home: "more" },
  { door: "Give It Its Own Account", was: "Supplier Names Not On An Account Yet", home: "more" },
  { door: "Join Them Onto One Account", was: "Same Supplier, Or Two?", home: "more" },
  { door: "Keep Them Separate", was: "Same Supplier, Or Two?", home: "more" },
  { door: /^Keep It On /, was: "The Same Ticket On Two Jobs", home: "more", times: 2 },
];

describe("every door keeps exactly one home", () => {
  const header = () => html.slice(0, html.indexOf('id="bills-search"'));
  const homeOf = (id: string) => (id === "header" ? header() : section(id));

  for (const h of HOMES) {
    it(`${String(h.door)} (was: ${h.was}) lives in ${h.home}`, () => {
      const inHome = count(doors(homeOf(h.home)), h.door);
      if (h.times != null) expect(inHome).toBe(h.times);
      else expect(inHome).toBeGreaterThanOrEqual(1);
      // And nowhere else on the page: the count over the whole page is the count in its home.
      expect(count(doors(html), h.door)).toBe(inHome);
    });
  }

  it("the per-line billing switch lives in the bill's own row, one per unlocked line", () => {
    const ledger = section("all-bills");
    // Every line of every live receipt on a job (2 + 1 + 2 + 8 + 8), except the coil's: a roll from
    // it is on the shelf, so its switch never renders (Take It Off The Shelf is the way back).
    expect((ledger.match(/role="switch"/g) ?? []).length).toBe(21);
    expect((html.match(/role="switch"/g) ?? []).length).toBe(21);
    expect(section("bill-b-coil")).not.toContain('role="switch"');
    expect(section("bill-b-osh")).toContain('role="switch"');
  });

  it("the search box is on the page once, and a bill it finds opens in All Bills", () => {
    expect((html.match(/id="bills-search"/g) ?? []).length).toBe(1);
    expect(section("all-bills")).toContain('id="bill-b-ticket"');
  });

  it("the same ticket on two jobs is pointed at from Needs You and answered under More", () => {
    const pointer = doors(html).filter((d) => d.includes("Sort It Out"));
    expect(pointer).toHaveLength(1);
    expect(html).toMatch(/href="#same-ticket-two-jobs"/);
    expect(section("more")).toContain('id="same-ticket-two-jobs"');
  });

  it("a paper on a Needs You card is never listed a second time in the supplier's own lists", () => {
    const ced = section(`supplier-invoices-${CED}`);
    // 85 WHITNEY is a card; the only no-job rows left in CED's lists are the credit memo and STOCK.
    expect(text(section("needs-you"))).toContain("It Says 85 WHITNEY");
    const noJob = ced.slice(ced.indexOf("Invoices With No Job"), ced.indexOf("Not In Your Books"));
    expect(noJob).not.toContain("8802-1107820");
    expect(noJob).toContain("8802-1108541");
    expect(noJob).toContain("8802-1103061");
    expect(text(ced)).toContain("4 Are Waiting Under Needs You");
  });
});

describe("the doors Wave B retired, and why none of them was the only way to do its job", () => {
  it("See What {Account} Says and See What They Say: the lists they pointed at are inside the supplier's own detail", () => {
    expect(count(doors(html), /^See What .* Says$/)).toBe(0);
    expect(count(doors(html), /See What They Say/)).toBe(0);
  });
  it("the discount's second Record A Payment: the account's own sits right above the lists", () => {
    expect(count(doors(html), "Record A Payment")).toBe(1);
  });
  it("the 46-row receipt card and its inner scroll box: each receipt's switches are in its own bill row", () => {
    expect(html).not.toContain("What Your Customers Get Billed");
    expect(html).not.toContain("max-h-[30rem]");
  });
});

describe("Title Case and 44px on the old controls the recon named", () => {
  it("no lowercase clickables or dead words left", () => {
    for (const bad of ["Pick a Job", "Pick a Bucket", "— Pick a job —", "Bill date", "Click “New PO”", "Click &quot;New PO&quot;", "Edit bill"]) {
      expect(html).not.toContain(bad);
    }
  });
  it("the filter pills and the status toggle are at least 44px tall", () => {
    const ledger = section("all-bills");
    const pills = Array.from(ledger.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g)).map((m) => m[0]);
    expect(pills.length).toBe(3);
    for (const p of pills) expect(p).toContain("min-h-11");
    const toggles = Array.from(ledger.matchAll(/<button[^>]*aria-label="How this bill was bought[^"]*"[^>]*>/g)).map((m) => m[0]);
    expect(toggles.length).toBe(15);
    for (const t of toggles) expect(t).toContain("min-h-11");
  });
  it("a paragraph is a one-line label with a Why? fold", () => {
    expect(count(doors(section("suppliers")), "Why?")).toBeGreaterThan(0);
    expect(html).not.toContain("These two do not subtract. What you have sent");
  });
});
