import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sectionOf, textOf } from "@/test/rendered-page";
import { RECONCILE_KINDS } from "@/lib/reconcile-kinds";

/**
 * ── WHAT THE LEAD CARD IS ALLOWED TO SAY (cn-v1037 fix pass) ─────────────────────────────────────
 *
 * Erik reads this page's first card between jobs and then decides whether to ring the counter. So the
 * one number, and the sentence under it, are the whole page: a row further down that is merely untidy
 * costs him a scroll, and a lead card that asserts an all-clear it did not check costs him the money.
 *
 * Every test in this file is a SENTENCE THAT WAS FALSE on a rendered page:
 *
 *  1. A supplier whose own papers are all CLOSED disappeared from the comparison, because the gap was
 *     built from `whatISupplierOwed().lines` and a line only exists where an account is owed money.
 *     Their book says nothing is open; ours says four tickets are. That is the loudest disagreement
 *     there is, and the page said "No money gap".
 *  2. A failed supplier read was swallowed, and the lead then asserted the all-clear anyway.
 *  3. "Nothing for you to do here" printed directly above a pile of papers on no supplier account —
 *     which is where /bills' own "File It" door now sends him.
 *  4. With only the figures read lost, every correctly filed bill read as unfiled and the page offered
 *     to re-file it, with a button that says it cannot be undone.
 *  5. The money on papers with no supplier account was described as part of the dispute figure. None
 *     of it is in that figure.
 *  6. "...and no ticket is filed twice" printed above the ticket filed twice.
 *
 * SYNTHETIC THROUGHOUT. Every supplier name, account number, job and figure below is invented: this
 * repository is public and no real customer, supplier or bank row goes in a committed file.
 */

const ORG = "org-synthetic";
const RIDGE = "acct-ridgeline";
const J1 = "job-alder";
const J2 = "job-wren";

const JOBS = [
  { id: J1, job_number: "J-201", name: "9 Alder Court", status: "in_progress", address: "9 Alder Court", created_at: "2026-08-01T00:00:00Z", customers: null },
  { id: J2, job_number: "J-202", name: "31 Wren Street", status: "in_progress", address: "31 Wren Street", created_at: "2026-08-01T00:00:00Z", customers: null },
];

let lineSeq = 0;
const line = (description: string, amount: number) => ({
  id: `line-${++lineSeq}`,
  description,
  quantity: 1,
  unit_price: amount,
  amount,
  category: "Materials",
  sort_order: lineSeq,
});

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier: "Ridgeline Supply Co",
  bill_number: null,
  amount: 0,
  status: "unpaid",
  bill_date: "2026-09-01",
  job_id: J1,
  po_id: null,
  category: null,
  notes: null,
  supplier_account_id: null,
  supplier_invoice_number: null,
  is_statement: false,
  superseded_by_bill_id: null,
  pricing_provisional: false,
  jobs: { job_number: "J-201", name: "9 Alder Court" },
  bill_line_items: [],
  ...over,
});

const doc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier_account_id: RIDGE,
  invoice_number: "",
  kind: "invoice",
  invoice_date: "2026-09-02",
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

const ACCOUNTS = [{ id: RIDGE, name: "Ridgeline Supply Co", account_number: "SYN-4", branch_code: null, on_account: true, note: null }];
/** Both spellings are SAVED NAMES for that one account, so neither is ever a name to file. */
const ALIASES = [
  { id: "al-1", supplier_account_id: RIDGE, alias: "Ridgeline Supply Co", branch_label: null },
  { id: "al-2", supplier_account_id: RIDGE, alias: "Ridgeline Supply Company", branch_label: null },
];

const BASE: Record<string, unknown[]> = {
  profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" }, name: "Synthetic Electric" }],
  jobs: JOBS,
  bills: [],
  supplier_accounts: ACCOUNTS,
  supplier_aliases: ALIASES,
  supplier_payments: [],
  supplier_invoices: [],
  bill_supplier_invoices: [],
};

/** The book this render answers from, and which read (if any) is told to fail. */
let CURRENT: Record<string, unknown[]> = BASE;
let ERRORS: { table: string; whenSelectHas?: string }[] = [];
/** True while `readSupplierOwed` is told to THROW rather than to name a failed read. */
let owedThrows = false;

function chain(table: string) {
  let cols = "";
  const c: Record<string, unknown> = {};
  for (const m of ["eq", "neq", "in", "is", "not", "or", "order", "limit", "gte", "lte", "ilike", "filter", "range"]) c[m] = () => c;
  c.select = (s?: string) => {
    cols = String(s ?? "");
    return c;
  };
  const answer = () => {
    const hit = ERRORS.find((e) => e.table === table && (!e.whenSelectHas || cols.includes(e.whenSelectHas)));
    return hit ? { data: null, error: { message: "a read failed" } } : { data: CURRENT[table] ?? [], error: null };
  };
  c.maybeSingle = async () => {
    const a = answer();
    return { data: (a.data as unknown[] | null)?.[0] ?? null, error: a.error };
  };
  c.single = c.maybeSingle;
  c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(answer()).then(ok, err);
  return c;
}
const fake = {
  auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/reconcile",
  redirect: (to: string) => {
    throw new Error(`redirected to ${to}`);
  },
}));

/** The one read behind both supplier questions, with a switch that makes it THROW. */
vi.mock("@/lib/supplier-owed-read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/supplier-owed-read")>();
  return {
    ...real,
    readSupplierOwed: async (db: unknown, orgId: string) => {
      if (owedThrows) throw new Error("the supplier figures read blew up");
      return real.readSupplierOwed(db, orgId);
    },
  };
});

const render = async () => {
  const { default: ReconcilePage } = await import("./page");
  return renderToStaticMarkup((await ReconcilePage()) as React.ReactElement);
};

/** The first card: the one number and the sentence under it. Everything in this file is about it. */
const lead = (html: string) => textOf(sectionOf(html, "reconcile-lead"));

beforeEach(() => {
  CURRENT = BASE;
  ERRORS = [];
  owedThrows = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
});
afterAll(() => vi.useRealTimers());

/**
 * ── 1. THEIR BOOK SAYS NOTHING IS OPEN; OURS SAYS FOUR TICKETS ARE ──────────────────────────────
 *
 * The measured production case: one ticket's covering supplier paper is already closed, so that
 * account's own open balance is zero. A gap built from "what you owe your suppliers" cannot see it —
 * that function only emits a line for an account that is owed MONEY — and the page told him nothing
 * disagreed. Zero on their side is not "nothing to compare"; it is the biggest disagreement there is.
 */
describe("a supplier whose own papers are all closed is still compared", () => {
  beforeEach(() => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("b-1", { amount: 1200, supplier_account_id: RIDGE, bill_line_items: [line("Panel", 1200)] }),
        bill("b-2", { amount: 387, supplier_account_id: RIDGE, bill_date: "2026-09-08", bill_line_items: [line("Wire", 387)] }),
      ],
      // Their ONE paper, and it is closed: nothing open on their side. It names an invoice number none
      // of our tickets carries, so it covers neither of them.
      supplier_invoices: [doc("d-closed", { invoice_number: "7001", total: 900, open_balance: 0, closed: true })],
    };
  });

  it("draws the gap and leads with the money, rather than saying there is none", async () => {
    const html = await render();
    expect(html, "the gap section must be drawn").toContain(`id="${RECONCILE_KINDS["supplier-gap"].anchor}"`);
    // Ours: $1,587.00 on two open tickets. Theirs: $0.00, because their own paper is closed.
    expect(lead(html)).toContain("$1,587.00");
    expect(lead(html)).not.toContain("No money gap");
    expect(lead(html)).not.toContain("Nothing Disagrees Right Now");
    const gap = textOf(sectionOf(html, RECONCILE_KINDS["supplier-gap"].anchor));
    expect(gap).toContain("Ridgeline Supply Co Says");
    expect(gap).toContain("$0.00");
    expect(gap).toContain("$1,587.00 Apart");
  });
});

/**
 * ── 2. A READ THAT DID NOT LAND MAY NOT PRODUCE AN ALL-CLEAR ────────────────────────────────────
 *
 * audit v1018's class 2, on a new page: with the supplier half unread, a sentence like "every paper is
 * in your books" is a FALSE all-clear. The lead card is where he stops reading, so the failure has to
 * be in the lead card and the all-clear has to be unreachable without it.
 */
describe("nothing is claimed off a read that did not land", () => {
  it("a supplier read that throws is named in the lead, and no all-clear is printed", async () => {
    owedThrows = true;
    const html = await render();
    expect(lead(html)).toMatch(/Couldn't read/);
    expect(lead(html)).not.toContain("No money gap");
    expect(lead(html)).not.toContain("Nothing Disagrees Right Now");
    expect(lead(html)).not.toContain("Nothing for you to do here");
  });

  it("a lost read under the piles is said in the lead, which never claims there is no gap", async () => {
    CURRENT = { ...BASE, bills: [bill("b-1", { amount: 410, supplier_account_id: RIDGE })] };
    // Without the saved names a spelling could be on an account and still look loose, so the read
    // counts nothing — and "no money gap" is itself an all-clear that must wait on every read.
    ERRORS = [{ table: "supplier_aliases" }];
    const html = await render();
    expect(lead(html)).toContain("Couldn't Check Everything Just Now");
    expect(lead(html)).toContain("nothing below is counted");
    expect(lead(html)).not.toContain("No money gap");
    expect(lead(html)).not.toContain("Nothing To Sort Out Right Now");
  });

  it("a named failed read inside that one read is said in the lead too, with no all-clear", async () => {
    CURRENT = { ...BASE, bills: [bill("b-1", { amount: 410, supplier_account_id: RIDGE })] };
    ERRORS = [{ table: "supplier_payments" }];
    const html = await render();
    expect(lead(html)).toMatch(/Couldn't read/);
    expect(lead(html)).not.toContain("No money gap");
    expect(lead(html)).not.toContain("Nothing Disagrees Right Now");
  });
});

/**
 * ── 3. AND 5. THE PAPERS ON NO SUPPLIER ACCOUNT ─────────────────────────────────────────────────
 *
 * /bills' Suppliers card now sends "File It" to this page, so this pile is the reason a man arrives
 * here. Two sentences were wrong about it: the all-clear printed directly above it, and the sentence
 * naming it was written for the Suppliers card, where "this" means what you owe. Under a dispute
 * figure "of this" claims the money is part of the quarrel, and not one cent of it is.
 */
describe("the papers on no supplier account", () => {
  it("are not covered by an all-clear, even when the paper carries no supplier name to file", async () => {
    CURRENT = {
      ...BASE,
      // No supplier name at all, so it is not a SPELLING to file and no section speaks for it. It is
      // still money on no account, and /bills' File It door lands on this page because of it.
      bills: [bill("b-nameless", { supplier: "", amount: 312.75 })],
    };
    const html = await render();
    expect(lead(html)).toContain("$312.75");
    expect(lead(html)).not.toContain("Nothing Disagrees Right Now");
    expect(lead(html)).not.toContain("Nothing for you to do here");
    expect(lead(html)).not.toContain("every supplier name is on an account");
  });

  it("are never described as part of the dispute figure", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("b-on", { amount: 1200, supplier_account_id: RIDGE }),
        // A spelling on no account, carrying its own money. It is in NEITHER side of any gap.
        bill("b-off", { supplier: "Harbour Point Tool Rental", amount: 475.5, bill_date: "2026-07-21", job_id: J2, jobs: { job_number: "J-202", name: "31 Wren Street" } }),
      ],
      supplier_invoices: [doc("d-open", { invoice_number: "7002", total: 500, open_balance: 500 })],
    };
    const html = await render();
    const words = lead(html);
    // The gap is $700.00: $1,200.00 of our tickets against their $500.00. The $475.50 is in neither.
    expect(words).toContain("$700.00");
    expect(words).toContain("$475.50");
    // "of this" makes the off-account money a slice of the figure above it. It is not.
    expect(words).not.toMatch(/\$475\.50 of this/);
    expect(words).toMatch(/\$475\.50[^.]*not (?:on a supplier account|in)/);
  });
});

/**
 * ── 4. A LOST FIGURES READ MUST NOT RE-FILE A CORRECTLY FILED BOOK ──────────────────────────────
 *
 * The figures read hands the page the identity it resolved, and the page's own read PREFERS what it is
 * handed. When that read's bills query fails it still answers — with an identity map built over zero
 * bills — so every filed bill read as unfiled, and the page offered to move bills that were already
 * where they belong. One of those doors says "Can't Be Undone Here" and splits a good account in two.
 */
describe("a lost figures read does not invent work", () => {
  it("offers nothing to re-file when the only read that failed is the figures' own bills query", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        // Filed by its stored account, under the account's own name.
        bill("b-filed", { amount: 900, supplier_account_id: RIDGE }),
        // On no stored account, but its spelling is a SAVED NAME for that very account.
        bill("b-alias", { supplier: "Ridgeline Supply Company", amount: 600, bill_date: "2026-09-04" }),
      ],
    };
    // Only the figures read's bills query fails: its select is the one that carries `is_statement`.
    ERRORS = [{ table: "bills", whenSelectHas: "is_statement" }];
    const html = await render();
    expect(html, "nothing is unfiled, so there is nothing to propose").not.toContain(
      `id="${RECONCILE_KINDS["supplier-names"].anchor}"`,
    );
    expect(textOf(html)).not.toContain("Not The Same");
    expect(lead(html)).toMatch(/Couldn't read/);
  });
});

/**
 * ── 6. THE ALL-CLEAR SPEAKS ONLY OF WHAT IS OPEN ────────────────────────────────────────────────
 *
 * A pick he has already made keeps its row so he can change his mind, and it is correctly NOT counted
 * (badges show open). But the sentence claimed "no ticket is filed twice" while the card naming both
 * jobs was drawn underneath it. One screen stating a fact and showing the evidence against it is how a
 * man stops trusting the figure at the top.
 */
describe("the all-clear sentence claims only what it checked", () => {
  it("does not say no ticket is filed twice while a settled pick is on the page", async () => {
    const TICKET = [line("Lever connector 3-port", 7.25), line("1/2 conduit", 7.25), line("4in square box", 7.25)];
    CURRENT = {
      ...BASE,
      bills: [
        bill("b-dup-a", { amount: 21.75, supplier_account_id: RIDGE, notes: "counter-a.pdf", bill_line_items: TICKET }),
        bill("b-dup-b", {
          amount: 21.75,
          supplier_account_id: RIDGE,
          bill_date: "2026-08-28",
          job_id: J2,
          jobs: { job_number: "J-202", name: "31 Wren Street" },
          notes: "counter-b.pdf",
          bill_line_items: TICKET,
          // He has already answered this one.
          superseded_by_bill_id: "b-dup-a",
        }),
      ],
    };
    const html = await render();
    expect(textOf(html), "the answered pick keeps its row").toContain(RECONCILE_KINDS["same-ticket-two-jobs"].heading);
    expect(lead(html)).not.toContain("no ticket is filed twice");
  });
});

/**
 * ── 7. THE ALL-CLEAR IS SCOPED TO THE PAGE THAT COUNTED IT ──────────────────────────────────────
 *
 * The statement door is drawn on a quiet page on purpose — that is the moment the next download is in
 * his hand — so the lead stopped saying "Nothing for you to do here" above it. What replaced it was a
 * claim about the whole book: "Nothing is waiting on you". But the door directly underneath that
 * sentence CREATES waiting work — a dropped download waits as a card under Needs You on Bills — and
 * this page never reads that queue; it reads bills and suppliers' own papers. So after one drop the
 * lead told him nothing was waiting on him three inches above its own "Waiting under Needs You on
 * Bills", and went on telling him so on every later visit. One word, "here", keeps both true.
 */
describe("the all-clear is scoped to what this page counted", () => {
  it("says nothing HERE is waiting, over a door whose whole job is to make work elsewhere", async () => {
    CURRENT = { profiles: BASE.profiles, organizations: BASE.organizations };
    const html = await render();
    const words = lead(html);
    expect(words).toContain("Nothing Disagrees Right Now");
    // Scoped, and the door is still named: no flat "nothing to do" over a door, and no whole-book claim.
    expect(words).toContain("Nothing here is waiting on you");
    expect(words).toContain("drop it in below");
    expect(words).not.toContain("Nothing for you to do here");
    expect(words).not.toMatch(/Nothing is waiting on you/);
    expect(textOf(html)).toContain("Drop A Bank Or Supplier Download");
  });

  it("and the scope is required, because nothing on this page reads the paper queue", async () => {
    // THE TRIPWIRE FROM THE OTHER END. The day this page does read `organized_items` and counts what
    // waits under Needs You, the sentence above may be widened — and that happens here, on purpose,
    // rather than in a copy-edit that nobody checked the reads for.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["page.tsx", "reconcile-read.ts", "supplier-gap.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/app/(app)/reconcile", f), "utf8");
      expect(src, f).not.toContain('from("organized_items")');
    }
  });
});
