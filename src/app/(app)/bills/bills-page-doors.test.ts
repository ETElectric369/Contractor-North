import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  bill("b-gas", { supplier: "Fuel", amount: 64.1, status: "paid", bill_date: "2026-09-10", category: "Fuel" }),
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

/** The database the fake answers from: the fixture, or a new company's (nothing yet). */
let CURRENT: Record<string, unknown[]> = TABLES;

/** A PostgREST chain whose every read answers with that table's rows. */
function chain(table: string) {
  const rows = CURRENT[table] ?? [];
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
// The ⋯ menus (a paper card's, a supplier's) run registry verbs only when tapped; the whole action
// registry is not this render's business.
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
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
  // 0. The header. Drop Paperwork is the one paper door now (W1-30): Snap Or Note, the same sheet
  // and queue as + on every page. Add By Hand (W1-32) is the one typed door: it took Add Business
  // Cost's place, and the ledger's Add A Bill By Hand and Add Bill with it.
  { door: "Snap Or Note", was: "header (Drop Paperwork)", home: "header", times: 1 },
  { door: "Add By Hand", was: "header (Add Business Cost; All Bills' Add A Bill By Hand and Add Bill)", home: "header", times: 1 },
  // Needs You (cn-v1014): the one place the paper decisions happen. Sort These folded in (W1-32): a
  // tray paper's card (the Home Depot receipt, no job, no guess) sits above the supplier cards and
  // answers in the same words (W1-31), so each answer's count is the supplier cards' plus the tray's.
  { door: "Put It On J-028", was: "Needs You", home: "needs-you" },
  { door: /^J-033 · /, was: "Needs You (ASK chips)", home: "needs-you" },
  { door: "Record It On J-050", was: "Needs You (and CED 3b Record It As A Bill)", home: "needs-you" },
  { door: "Pick A Job", was: "Needs You (and Sort These' job picker; File It)", home: "needs-you" },
  { door: "Another Job", was: "Needs You", home: "needs-you", times: 3 },
  { door: "Shop Stock", was: "Needs You (and CED 3b Record To Stock; and Sort These' Shop Stock option)", home: "needs-you", times: 5 },
  { door: "Business Cost", was: "Needs You (and Sort These' bucket picker)", home: "needs-you", times: 5 },
  { door: "Same Purchase: Tie Them", was: "Needs You (and CED 3b)", home: "needs-you" },
  // 2. What You Owe Your Suppliers -> one line per supplier, its detail
  { door: /^Consolidated Electrical Distributors Account TR-34426/, was: "account row tap", home: "suppliers" },
  { door: "Record A Payment", was: "account row AND the CED discount section", home: "suppliers", times: 1 },
  { door: "Turn On A Running Balance", was: "account row (now inside Check These)", home: "suppliers" },
  { door: "Undo", was: "account row (per payment)", home: "suppliers" },
  // W1-33: each account's live contradictions, one fold (CED's never-sent-paper bills; OSH's bills
  // marked On Account at a register supplier). Edit Account moved to the detail's ⋯ (a closed menu,
  // pinned below), and Names It's Filed Under to its sheet.
  { door: "Check These (1)", was: "the amber boxes under each account", home: "suppliers", times: 2 },
  { door: "Open In All Bills", was: "the never-sent-paper list's All Bills link", home: "suppliers", times: 1 },
  { door: /^\$615\.79 On 2 Bills With No Supplier Account File It$/, was: "amber 'not on a supplier account' line", home: "suppliers" },
  // 3. What CED Says You Owe -> short folded lists inside CED's detail
  { door: /^Their Papers \(\d+\)$/, was: "(new fold: Where This Comes From, Invoices With No Job, Not In Your Books)", home: "suppliers" },
  { door: /^Invoices With No Job \(\d+\)/, was: "CED 3a", home: "suppliers" },
  { door: "File It On This Job", was: "CED 3a (row picker)", home: "suppliers" },
  { door: /^Not Recorded Yet \(\d+\)/, was: "CED 3b (Not In Your Books)", home: "suppliers" },
  { door: "Record To Stock", was: "CED 3b", home: "suppliers" },
  { door: /^Discount Still On The Table/, was: "CED 3c", home: "suppliers" },
  { door: /^What Consolidated Electrical Distributors Has Open \(7\)$/, was: "CED 3d", home: "suppliers" },
  // CED 'Show The Other N' (x4): still each list's own switch past six rows. In this fixture no
  // list is longer than six once the papers on Needs You cards are left out of What CED Has Open.
  // 9 + 10. What Your Customers Get Billed + the tabs -> All Bills, one searchable list (W1-32). Its
  // line leads with what's open (Erik, 2026-09-27: "all badges only show whats open"): the 9 of 15
  // bills still unpaid and what they come to, never how many rows it holds. The tabs and the filter
  // chips went: the search box at the top narrows the list in place.
  { door: /^All Bills · 9 Unpaid \$4,801\.98$/, was: "the tabs under the page (All Bills (15) · $X)", home: "all-bills" },
  { door: /^(Settled|On Account) Switch$/, was: "Settled/On Account badge toggle", home: "all-bills", times: 15 },
  { door: "Edit", was: "pencil icon (bare 16px)", home: "all-bills", times: 15 },
  { door: "Delete", was: "trash icon (bare 16px)", home: "all-bills", times: 15 },
  { door: /^Bill Only What This Job Used$/, was: "receipt card, per line", home: "all-bills" },
  { door: "Put The Rest In Stock", was: "receipt card, per line", home: "all-bills" },
  { door: "Take It Out Of Stock", was: "receipt card, per line", home: "all-bills", times: 1 },
  { door: "New PO", was: "Purchase Orders tab (the list's ⋯ now)", home: "all-bills", times: 1 },
  { door: /^PO PO-001 · CED/, was: "Purchase Orders row (a PO chip in the one list now)", home: "all-bills" },
  { door: "IMG_0412.jpg", was: "Receipts tab file link (a File chip in the one list now)", home: "all-bills" },
  // 4-8. Housekeeping and the import -> More
  { door: /^More · /, was: "(new fold)", home: "more" },
  // Import Supplier Invoices is one line now (W1-30); Paste Text Instead and its Import Documents
  // went into Snap Or Note's note box. Choose Supplier PDFs stays one more release (three sentences
  // outside this lane still name it).
  { door: "Choose Supplier PDFs", was: "Import fold", home: "more" },
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

  /** A door listed in more than one home (a supplier paper's card and a tray paper's card answer in
   *  the same words, W1-31) is found in each; the page holds exactly the sum. */
  const sameDoor = (a: string | RegExp, b: string | RegExp) => String(a) === String(b);
  for (const h of HOMES) {
    it(`${String(h.door)} (was: ${h.was}) lives in ${h.home}`, () => {
      const inHome = count(doors(homeOf(h.home)), h.door);
      if (h.times != null) expect(inHome).toBe(h.times);
      else expect(inHome).toBeGreaterThanOrEqual(1);
      // And nowhere else on the page: the count over the whole page is the count in its homes.
      const inHomes = HOMES.filter((o) => sameDoor(o.door, h.door)).reduce((n, o) => n + count(doors(homeOf(o.home)), o.door), 0);
      expect(count(doors(html), h.door)).toBe(inHomes);
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

  it("the discount's figure is said once, on CED's closed line; its fold is a name and a count", () => {
    const ced = section(`supplier-invoices-${CED}`);
    const summaries = doors(ced).filter((d) => d.startsWith("Discount Still On The Table"));
    expect(summaries.length).toBe(1);
    for (const s of summaries) expect(s).toMatch(/^Discount Still On The Table \(\d+\)$/);
    // On the line itself, before he opens anything: money with a deadline is never behind a fold.
    const line = doors(ced).find((d) => d.startsWith("Consolidated Electrical Distributors Account TR-34426"));
    expect(line).toMatch(/comes off if they are paid by Oct 10, 2026/);
    // And nowhere else on the page.
    expect(text(html).match(/comes off if/g) ?? []).toHaveLength(1);
  });

  it("Shop Stock's Record To Shelf door lands on the fold that holds the button (shelf-plan waitingForShelf)", () => {
    const fold = section(`supplier-not-in-books-${CED}`);
    expect(count(doors(fold), "Record To Stock")).toBeGreaterThanOrEqual(1);
    expect(section(`supplier-invoices-${CED}`)).toContain(`id="supplier-not-in-books-${CED}"`);
    // Inside Their Papers, a nested <details> (never a menu), so FoldOpener still opens it.
    expect(section(`supplier-their-papers-${CED}`)).toContain(`id="supplier-not-in-books-${CED}"`);
  });

  it("the supplier homes (W1-33): Edit Account on each open detail's ⋯, no Names It's Filed Under, Check These, Their Papers counting open papers only", () => {
    const suppliers = section("suppliers");
    // The ⋯ is the section menu, labelled Actions, one per account with the Edit Account action.
    expect((suppliers.match(/<button[^>]*aria-label="Actions"/g) ?? []).length).toBe(2);
    expect(text(html)).not.toContain("Names It's Filed Under");
    // N To Check on each closed line, the money in the check's own row.
    const lines = doors(suppliers).filter((d) => / To Check/.test(d));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/\b1 To Check\b/);
    expect(text(suppliers)).not.toMatch(/\+ \$[\d,.]+ they never sent paper for/);
    expect(text(section(`supplier-checks-${CED}`))).toMatch(/\$[\d,.]+ on \d+ bills? Consolidated Electrical Distributors never sent paper for\. Still owed; mark (it|them) Settled when you pay\./);
    expect(text(section(`supplier-checks-${OSH}`))).toContain("1 bill marked On Account, $16.28, but you pay Outdoor Supply Hardware (OSH - Cupertino) at the register.");
    // The one slate line under Record A Payment, model B's own arithmetic.
    expect(text(section(`supplier-invoices-${CED}`))).toContain("You've sent $2,000.00 since Sep 5, 2026. It's already off their figure.");
    expect(text(html)).not.toContain("Why Don't These Subtract?");
    expect(text(html)).not.toContain("What Does Undo Do?");
    // Their Papers' number counts the open papers in Invoices With No Job and Not Recorded Yet, each
    // ONCE, never Where This Comes From. The fixture's STOCK paper 8802-1103061 has no job and no bill,
    // so it sits in both lists (2 + 1) and is still one paper: two papers in all.
    const ced = section(`supplier-their-papers-${CED}`);
    const noJob = Number(/Invoices With No Job \((\d+)\)/.exec(text(ced))![1]);
    const notRec = Number(/Not Recorded Yet \((\d+)\)/.exec(text(ced))![1]);
    expect(noJob + notRec).toBe(3);
    expect(text(ced).match(/8802-1103061/g)?.length).toBe(2);
    expect(text(ced)).toContain("Their Papers (2)");
    expect(text(ced)).toContain("Where This Comes From");
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
    const noJob = ced.slice(ced.indexOf("Invoices With No Job"), ced.indexOf("Not Recorded Yet"));
    expect(noJob).not.toContain("8802-1107820");
    expect(noJob).toContain("8802-1108541");
    expect(noJob).toContain("8802-1103061");
    expect(text(ced)).toContain("4 Are Waiting Under Needs You");
    // What CED Has Open counts everything CED has open, but a card's paper is not a row there.
    const open = ced.slice(ced.indexOf("Has Open ("));
    expect(open).not.toContain("8802-1107820");
    expect(text(open)).toMatch(/\d+ Of These (Is|Are) Waiting Under Needs You/);
  });
});

describe("one door for papers (Wave 0; W1-30)", () => {
  // The Receipts tab's Upload / Photo / drop box filed a picture and never recorded a cost, and its
  // drop box caught drops meant for the page's own drop. It is a list now; Snap Or Note reads papers.
  it("All Bills has no Upload or Photo door, and lists the receipt file no bill holds", () => {
    expect(count(doors(html), "Upload")).toBe(0);
    expect(count(doors(html), "Photo")).toBe(0);
    expect(count(doors(section("all-bills")), "IMG_0412.jpg")).toBe(1);
  });

  it("one paper door: Snap Or Note in the header, no Drop Paperwork, no Paste Text Instead, and the import is one line with a Why?", () => {
    expect(count(doors(html.slice(0, html.indexOf('id="bills-search"'))), "Snap Or Note")).toBe(1);
    expect(text(html)).not.toContain("Drop Paperwork");
    expect(count(doors(html), "Paste Text Instead")).toBe(0);
    expect(count(doors(html), "Import Documents")).toBe(0);
    expect(html).not.toContain('name="text"');
    const imp = section("ced-import");
    expect(text(imp)).toContain("Import Supplier Invoices");
    expect(text(imp)).toContain("Supplier PDFs, statements and open lists go in through Snap Or Note.");
    expect(count(doors(imp), "Why?")).toBe(1);
  });
});

/**
 * NEEDS YOU HOLDS SORT THESE (W1-32). One card: what was just dropped (the queue's lines, with Clear
 * Finished Lines), every dropped paper waiting for its answer (a receipt, a bill, a bank download, an
 * open list or a statement), then the supplier's bills not in the books. Its count is only what is
 * open; #sort-these stays an anchor inside it (My Day's Papers To Sort lands there).
 */
describe("Needs You holds Sort These (W1-32)", () => {
  it("one card: the papers waiting plus the supplier cards in its count, its line, and #sort-these inside it", () => {
    const ny = section("needs-you");
    const cards = Number(/Needs You \((\d+)\)/.exec(text(ny))?.[1] ?? 0);
    // The Home Depot receipt in the tray, and the supplier's cards (each offers Business Cost once).
    expect(cards).toBe(1 + (count(doors(ny), "Business Cost") - 1));
    expect(text(ny)).toContain("Paper to sort and supplier bills not in your books yet.");
    expect(ny).toContain('id="sort-these"');
    expect((html.match(/id="sort-these"/g) ?? []).length).toBe(1);
    // In order: the dropped paper's card, then the supplier's cards.
    expect(ny.indexOf("Home Depot")).toBeGreaterThan(-1);
    expect(ny.indexOf("Home Depot")).toBeLessThan(ny.indexOf("It Says 85 WHITNEY"));
    // Sort These is gone as a card and as a word; Add More's job is the header's and the page's drop.
    expect(text(html)).not.toContain("Sort These");
    expect(count(doors(html), "Add More")).toBe(0);
  });

  it("the bank card's Apply and Undo, and the open list's Apply, live on their cards in Needs You", async () => {
    const { NeedsYou } = await import("./bills-drop");
    const { createElement } = await import("react");
    const bank = {
      id: "tray-bank",
      kind: "receipt",
      status: "needs_review",
      title: "checking-sep.csv",
      created_at: "2026-09-26T12:00:00Z",
      signedUrl: null,
      file_url: null,
      proposal: { bankImport: { download: { lines: [] } } },
      bank: {
        headline: "Bank ••1234 · Aug 26–Sep 25 · 2 sorted · 1 need you",
        fingerprint: "fp",
        counts: { lines: 3, already: 0, matched: 2, ruled: 0, needLines: 1, needRows: 1 },
        rows: [{ id: "out:shell", title: "SHELL 123 ANYTOWN", money: "$40.00", dates: "Sep 2", direction: "out", single: true, guess: "cost:Fuel", buttons: [{ id: "cost:Fuel", label: "Fuel" }] }],
        otherOut: [],
        otherIn: [],
        otherInSingle: [],
        flow: [],
        inCents: 0,
        outCents: 4000,
        sorted: [{ label: "Payments Already Recorded", n: 2, cents: 8000 }],
        skipped: [],
        appliedSaid: "Applied: 2 lines counted.",
        canUndo: true,
        swapped: false,
        canSwap: false,
        askAccount: false,
        rules: [],
        problem: null,
      },
    };
    const list = {
      id: "tray-list",
      kind: "receipt",
      status: "needs_review",
      title: "open-items.xlsx",
      created_at: "2026-09-26T12:00:00Z",
      signedUrl: null,
      file_url: null,
      proposal: { openList: { list: { rows: [] } } },
      open_list: {
        supplier: "Consolidated Electrical Distributors",
        accountId: CED,
        accountFrom: "number",
        accounts: [{ id: CED, name: "Consolidated Electrical Distributors" }],
        needs: null,
        dateSaid: "Sep 26",
        problem: null,
        plan: {
          headline: "Consolidated Electrical Distributors' open list of Sep 26: 1 paper marked paid ($10.29).",
          discountLine: null,
          complete: { ok: true, said: "", overridable: false },
          fingerprint: "abc",
          nothing: false,
          closeBy: "2026-09-23",
          close: [{ id: "p1", number: "8802-1103832", date: "2026-07-22", open: 10.29 }],
          keepNewer: [],
          keepUndated: [],
          keepPartial: [],
          add: [],
          update: [],
          conflicts: [],
          payments: [],
          skipped: [],
          before: 10.29,
          after: 0,
          afterNet: 0,
          firstList: false,
        },
      },
    };
    const card = renderToStaticMarkup(createElement(NeedsYou, { items: [bank, list] as any, jobs: [], matches: {}, emptyLine: "Nothing waiting." }));
    expect(card).toMatch(/^<div[^>]*id="needs-you"/);
    expect(text(card)).toMatch(/Needs You \(2\)/);
    expect(count(doors(card), "Apply")).toBe(2);
    expect(count(doors(card), "Undo This Download")).toBe(1);
    expect(text(card)).not.toContain("Nothing waiting.");
  });

  it("the Waiting On A Credit lines stay on Needs You, and the page hands its papers to the one card", () => {
    const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(PAGE).toContain("{`Waiting On A Credit (${w.count}) · Under ${w.name}`}");
    expect(PAGE).toMatch(/<NeedsYou\s+items=\{paperItems\}/);
    expect(PAGE).not.toContain("<SortThese");
  });

  it("with nothing waiting it says so, dated from the day the books begin", () => {
    const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
    expect(PAGE).toContain("`Nothing waiting. Every paper${recordsSince ? ` since ${formatDateShort(recordsSince)}` : \"\"} is in your books.`");
  });
});

/**
 * ALL BILLS, ONE SEARCHABLE LIST (W1-32): every bill, every purchase order (a PO chip), and each
 * receipt file no bill holds yet (a File chip, its Delete behind its ⋯). The search box at the top
 * narrows it in place; a supplier's own paper is a hit that lands on its card.
 */
describe("All Bills is one list", () => {
  it("Already Billed stays on a bill's own row in the one list (0357), with its Billed By Hand · Not Billed After All", async () => {
    const { BillsReceipts } = await import("./bills-receipts");
    const { createElement } = await import("react");
    const row = (id: string) => ({ id, supplier: "Supply House", bill_number: null, amount: 40, status: "unpaid", bill_date: "2026-09-10", job_id: J011, category: null, jobs: { job_number: "J-011", name: "13897 Herringbone" } });
    const list = renderToStaticMarkup(
      createElement(BillsReceipts, {
        orgId: ORG,
        jobs: [],
        lists: [],
        pos: [],
        docs: [],
        bills: [row("b-open"), row("b-hand")] as any,
        alreadyBilled: {
          "b-open": { kind: "open", jobId: J011, what: "Supply House" },
          "b-hand": { kind: "hand", jobId: J011, lineId: "li-1", ids: ["b-hand"], invoiceNumber: "INV-060", what: "Supply House" },
        } as any,
      }),
    );
    const open = list.slice(list.indexOf('id="bill-b-open"'), list.indexOf('id="bill-b-hand"'));
    expect(count(doors(open), "Already Billed")).toBe(1);
    const hand = list.slice(list.indexOf('id="bill-b-hand"'));
    expect(text(hand)).toContain("Billed By Hand On INV-060");
    expect(count(doors(hand), "Not Billed After All")).toBe(1);
  });

  it("its line leads with what's open, never a count of rows", () => {
    const summary = doors(section("all-bills")).find((d) => d.startsWith("All Bills"))!;
    expect(summary).toBe("All Bills · 9 Unpaid $4,801.98");
    expect(summary).not.toMatch(/All Bills \(\d+\)/);
  });

  it("each kind in one list: bills, the order with its PO chip, the file with its File chip and its ⋯", () => {
    const ledger = section("all-bills");
    expect(ledger).not.toContain('role="tablist"');
    expect(ledger).toMatch(/>PO<\/span>[\s\S]*?PO-001 · CED/);
    expect(ledger).toMatch(/>File<\/span>[\s\S]*?IMG_0412\.jpg/);
    expect(ledger).toMatch(/aria-label="More For IMG_0412\.jpg"/);
    // New PO is on the list's own ⋯ (Purchase Orders is on in the fixture).
    expect(ledger).toMatch(/aria-label="More For All Bills"/);
  });

  it("the search box filters it in place and still finds a supplier's paper on its card", () => {
    const BOX = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-search-box.tsx"), "utf8");
    expect(BOX).toContain('const papers = useMemo(() => rows.filter((r) => r.kind === "paper"), [rows]);');
    const LIST = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-receipts.tsx"), "utf8");
    expect(LIST).toContain("const kept = (key: string) => !keys || keys.has(key);");
  });
});

describe("a one-tap write with no undo says so on screen, not only in a fold", () => {
  it("Not The Same and Keep Them Separate each carry their warning outside the Why? fold", () => {
    const more = section("more");
    expect(text(more)).toContain("Not The Same Can't Be Undone Here");
    expect(text(more)).toContain("Keeping Them Separate Can't Be Undone Here");
    // Not inside a Why? fold's body: the warning sits just above the buttons.
    for (const fold of more.match(/<div class="mb-2 space-y-1 leading-relaxed">[\s\S]*?<\/div>/g) ?? []) {
      expect(fold).not.toContain("Undone Here");
    }
    expect(text(more)).toContain("What Does Each Answer Do?");
  });
});

/**
 * WHAT A NEW COMPANY SEES (W1-32): the title, ONE primary button (Snap Or Note), a plain Add By Hand
 * link and the drop line. The search, Needs You, Suppliers, All Bills and More each appear once they
 * hold something. A company with data sees the same header.
 */
describe("the header, for a new company and one with data", () => {
  it("with data: Snap Or Note is the one primary button, Add By Hand a 44px text link, and the drop line", () => {
    const header = html.slice(0, html.indexOf('id="bills-search"'));
    expect(text(header)).toContain("Drop a receipt or bill anywhere on this page.");
    const hand = header.match(/<button[^>]*>\s*Add By Hand\s*<\/button>/);
    expect(hand).not.toBeNull();
    expect(hand![0]).toContain("min-h-11");
    expect(hand![0]).not.toContain("bg-brand");
    expect(count(doors(header), "Add Business Cost")).toBe(0);
  });

  it("a new company: the header and nothing else until something is in it", async () => {
    // Purchase Orders off, as every trade's preset starts (features.ts): nothing to hold New PO.
    const poOff = [{ ...(TABLES.organizations[0] as Record<string, unknown>), settings: { timezone: "America/Los_Angeles", features: { purchase_orders: false } } }];
    CURRENT = { profiles: TABLES.profiles, organizations: poOff };
    try {
      const { default: BillsPage } = await import("./page");
      const fresh = renderToStaticMarkup((await BillsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
      expect(text(fresh)).toContain("Drop a receipt or bill anywhere on this page.");
      expect(doors(fresh)).toEqual(["Snap Or Note", "Add By Hand"]);
      for (const id of ["bills-search", "needs-you", "suppliers", "all-bills", "more"]) expect(fresh, id).not.toContain(`id="${id}"`);
    } finally {
      CURRENT = TABLES;
    }
  });

  it("a new company with Purchase Orders on: All Bills is there, empty, saying so, with New PO on its ⋯", async () => {
    // The Bills & POs row, /purchasing (?tab=po) and "po" in Search Or Ask all land here: never a page
    // with no PO door and no word about orders.
    CURRENT = { profiles: TABLES.profiles, organizations: TABLES.organizations };
    try {
      const { default: BillsPage } = await import("./page");
      const fresh = renderToStaticMarkup((await BillsPage({ searchParams: Promise.resolve({}) })) as React.ReactElement);
      expect(fresh).toContain('id="all-bills"');
      expect(fresh).toMatch(/aria-label="More For All Bills"/);
      expect(doors(fresh)).toContain("New PO");
      expect(text(fresh)).toContain("No bills or purchase orders yet. Add a bill with Snap Or Note at the top of this page, or tap ⋯ here for New PO.");
      for (const id of ["bills-search", "needs-you", "suppliers", "more"]) expect(fresh, id).not.toContain(`id="${id}"`);
    } finally {
      CURRENT = TABLES;
    }
  });
});

describe("the doors Wave B retired, and why none of them was the only way to do its job", () => {
  it("W1-32: Sort These' Add More, the ledger's tabs and chips, its Add A Bill By Hand and Add Bill, and Add Business Cost", () => {
    // Add More: the header's Snap Or Note and the page-wide drop. The tabs and chips: one list the
    // search box narrows. Add A Bill By Hand, Add Bill, Add Business Cost: the header's Add By Hand.
    for (const gone of ["Add More", "Add A Bill By Hand", "Add Bill", "Add Business Cost", "Receipts", "All (15)"]) expect(count(doors(html), gone), gone).toBe(0);
    expect(count(doors(html), /^(Bills|Purchase Orders) \d+$/)).toBe(0);
    expect(count(doors(html), /^(Job Bills|Business Costs) \(\d+\)$/)).toBe(0);
  });

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
  it("no filter pills are left (the search box narrows the list), and the status toggle is at least 44px tall", () => {
    const ledger = section("all-bills");
    const pills = Array.from(ledger.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g)).map((m) => m[0]);
    expect(pills.length).toBe(0);
    const toggles = Array.from(ledger.matchAll(/<button[^>]*aria-label="How this bill was bought[^"]*"[^>]*>/g)).map((m) => m[0]);
    expect(toggles.length).toBe(15);
    for (const t of toggles) expect(t).toContain("min-h-11");
  });
  it("a paragraph is a one-line label with a Why? fold", () => {
    expect(count(doors(section("suppliers")), "Why?")).toBeGreaterThan(0);
    expect(html).not.toContain("These two do not subtract. What you have sent");
  });
});
