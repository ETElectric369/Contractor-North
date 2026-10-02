import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { countDoors, doorsIn, sectionOf, textOf } from "@/test/rendered-page";
import { RECONCILE_ANSWERED_HERE, RECONCILE_KINDS } from "@/lib/reconcile-kinds";
import { LIST_ACCEPT } from "@/lib/open-list-file";

/**
 * EVERY DOOR THAT MOVED OFF /bills HAS A HOME HERE, AND NOWHERE ELSE (cn-v1037).
 *
 * The bottom fold of /bills held five things. Four of them moved to this page as one unit — the
 * merge proposals, the one question the matcher will not answer, the loose spellings and the ticket
 * filed to two jobs — because they are literally derived from each other: what is "loose" is what no
 * proposal and no question already speaks for. The fifth (an import picker) was DELETED, because it
 * was a second copy of Snap Or Note.
 *
 * A move like that is exactly how a door the office uses goes missing without anybody noticing. So
 * this renders THE PAGE ITSELF — the server component, with a fake database answering in live shapes
 * — and finds every door, in the section that is its home, exactly once. bills-page-doors.test.ts
 * asserts the mirror image: that none of them is still over there.
 *
 * SYNTHETIC THROUGHOUT. Every supplier name, account number, job and figure below is invented. This
 * repository is public and no real customer, supplier or bank row goes in a committed file.
 */

const ORG = "org-synthetic";
const NORTH = "acct-north";
const TILL = "acct-till";
const J1 = "job-sycamore";
const J2 = "job-bramble";
const J3 = "job-kestrel";

const job = (id: string, job_number: string, name: string, address: string) => ({
  id,
  job_number,
  name,
  status: "in_progress",
  address,
  created_at: "2026-08-01T00:00:00Z",
  customers: null,
});
const JOBS = [
  job(J1, "J-101", "12 Sycamore Row", "12 Sycamore Row"),
  job(J2, "J-102", "4 Bramble Lane", "4 Bramble Lane"),
  job(J3, "J-103", "88 Kestrel Way", "88 Kestrel Way"),
];
const jobRef = (id: string) => {
  const j = JOBS.find((x) => x.id === id)!;
  return { job_number: j.job_number, name: j.name };
};

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
const bill = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier: "Northside Wholesale Supply, Inc. (NWS)",
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

/** The identical ticket, line for line to the penny, that lands on two jobs. */
const SIX = ["Lever connector 3-port", "1/2 conduit", "1/2 conduit coupling", "4in square box", "4in square ring", "12 AWG black"];
const ticketLines = () => SIX.map((d) => line(d, 7.25));

const BILLS = [
  // ── ON THE ACCOUNT, so the page can draw their papers against ours ──
  bill("b-north-1", { amount: 1200, bill_date: "2026-09-02", job_id: J1, jobs: jobRef(J1), supplier_account_id: NORTH }),
  bill("b-north-2", { amount: 300, bill_date: "2026-09-08", job_id: J1, jobs: jobRef(J1), supplier_account_id: NORTH }),
  // ── TWO SPELLINGS ON NO ACCOUNT THAT LOOK LIKE ONE: the merge proposal ──
  // STILL OPEN, and that is load-bearing now (cn-v1041): a purchase paid at the register has ONE
  // record, so it is not a disagreement and no section here speaks for it. These used to be `paid`,
  // which is how the fixture drew a page Erik would never have been shown.
  bill("b-ridge-1", { supplier: "Ridgeway's Fastener Depot", amount: 61.4, category: "Receipt", bill_date: "2026-08-11", job_id: J2, jobs: jobRef(J2) }),
  bill("b-ridge-2", { supplier: "Ridgeways Fastener Depot", amount: 44.15, category: "Receipt", bill_date: "2026-08-19", job_id: J2, jobs: jobRef(J2) }),
  // ── A SPELLING THE MATCHER WILL NOT RULE ON: same initials as the account, first word differs ──
  bill("b-maybe", { supplier: "Northern Wholesale Supply", amount: 475.5, category: "Receipt", bill_date: "2026-07-21", job_id: J2, jobs: jobRef(J2) }),
  // ── A SPELLING WITH NO RELATIVE AT ALL: Give It Its Own Account, and nothing filed it under an
  //    expense category, so it is the one row that gets asked ("if it's unclear ask") ──
  bill("b-loose", { supplier: "Harbour Point Tool Rental", amount: 88.9, bill_date: "2026-06-30", job_id: J3, jobs: jobRef(J3) }),
  // ── THE SAME TICKET ON TWO JOBS ──
  bill("b-dup-a", { amount: 43.5, bill_date: "2026-07-29", job_id: J3, jobs: jobRef(J3), supplier_account_id: NORTH, notes: "portal-20260729-1.pdf", bill_line_items: ticketLines() }),
  bill("b-dup-b", { amount: 43.5, bill_date: "2026-08-28", job_id: J2, jobs: jobRef(J2), supplier_account_id: NORTH, notes: "bramble ticket.pdf", bill_line_items: ticketLines() }),
];

const doc = (id: string, over: Record<string, unknown>) => ({
  id,
  supplier_account_id: NORTH,
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
/** Their own book: ONE open invoice for $500.00. Our own four open tickets there come to $1,587.00
 *  (both copies of the twice-filed ticket count until he picks a job), so the two records are
 *  $1,087.00 apart — which is what the page must lead with. */
const SUPPLIER_INVOICES = [doc("d-open", { invoice_number: "9900-1", invoice_date: "2026-09-02", total: 500, open_balance: 500 })];

const TABLES: Record<string, unknown[]> = {
  profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }],
  organizations: [{ settings: { timezone: "America/Los_Angeles" }, name: "Synthetic Electric" }],
  bills: BILLS,
  jobs: JOBS,
  supplier_accounts: [
    { id: NORTH, name: "Northside Wholesale Supply", account_number: "SYN-7", branch_code: "4100", on_account: true, note: null },
    { id: TILL, name: "Lakeside Hardware", account_number: null, branch_code: null, on_account: false, note: null },
  ],
  supplier_aliases: [
    { id: "al-1", supplier_account_id: NORTH, alias: "Northside Wholesale Supply, Inc. (NWS)", branch_label: null },
    { id: "al-2", supplier_account_id: TILL, alias: "Lakeside Hardware", branch_label: null },
  ],
  supplier_payments: [],
  supplier_invoices: SUPPLIER_INVOICES,
  bill_supplier_invoices: [],
};

/** The database the fake answers from: the fixture, a tech's, or a new company's (nothing yet). */
let CURRENT: Record<string, unknown[]> = TABLES;

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
  auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  from: (t: string) => chain(t),
  rpc: async () => ({ data: null, error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake, createServiceClient: () => fake }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));

/** Where a redirect went, so the staff gate can be proved without a Next runtime. */
let redirectedTo: string | null = null;
class RedirectError extends Error {}
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/reconcile",
  redirect: (to: string) => {
    redirectedTo = to;
    throw new RedirectError(to);
  },
}));

const render = async () => {
  const { default: ReconcilePage } = await import("./page");
  return renderToStaticMarkup((await ReconcilePage()) as React.ReactElement);
};

let html = "";
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
  html = await render();
}, 30_000);
afterAll(() => vi.useRealTimers());

const section = (id: string) => sectionOf(html, id);
const doors = doorsIn;
const text = textOf;
const count = countDoors;

/**
 * EVERY DOOR THAT WAS IN /bills' "More" FOLD, AND WHERE IT LIVES NOW. `home` is the section id it
 * must be found in; `times` is how many of it that home must hold for this fixture, which is what
 * "exactly one home" means for a door that repeats per row.
 */
const HOMES: { door: string | RegExp; was: string; home: string; times?: number }[] = [
  { door: /^Accept And (File Them There|Make The Account)$/, was: "/bills More: Supplier Names That Look Like One Account", home: "supplier-names" },
  { door: "Not The Same", was: "/bills More: Supplier Names That Look Like One Account", home: "supplier-names" },
  { door: "Join Them Onto One Account", was: "/bills More: Same Supplier, Or Two?", home: "same-supplier-or-two" },
  { door: "Keep Them Separate", was: "/bills More: Same Supplier, Or Two?", home: "same-supplier-or-two" },
  { door: "Give It Its Own Account", was: "/bills More: Supplier Names Not On An Account Yet", home: "not-on-an-account" },
  { door: /^Keep It On /, was: "/bills More: The Same Ticket On Two Jobs", home: "same-ticket-two-jobs", times: 2 },
];

describe("the doors that moved off Bills each have exactly one home here", () => {
  for (const h of HOMES) {
    it(`${String(h.door)} (was: ${h.was}) lives in ${h.home}`, () => {
      const inHome = count(doors(section(h.home)), h.door);
      if (h.times != null) expect(inHome).toBe(h.times);
      else expect(inHome).toBeGreaterThanOrEqual(1);
      // And nowhere else on the page.
      expect(count(doors(html), h.door)).toBe(inHome);
    });
  }

  it("nothing it used to do has been lost: all six doors are on the page", () => {
    const all = doors(html);
    for (const h of HOMES) expect(count(all, h.door), String(h.door)).toBeGreaterThanOrEqual(1);
  });

  /**
   * THE SECOND COPY THAT WAS DELETED RATHER THAN MOVED. The import picker was a paper-intake door,
   * and a paper-intake door here would have made Reconcile the thing Erik's law forbids: a screen
   * that controls a system rather than one that fills in dots.
   */
  it("carries no paper-intake door of its own", () => {
    for (const gone of ["Choose Supplier PDFs", "Snap Or Note", "Add By Hand", "Paste Text Instead", "Import Documents"]) {
      expect(count(doors(html), gone), gone).toBe(0);
    }
  });
});

/**
 * ERIK'S LAW, AS A TEST: "reconcile is the bottom fold filling in dots not controlling systems, a
 * peace maker". The supplier gap is the page's lead and it is READ-ONLY — the figures belong to
 * lib/supplier-owed.ts and the screen that records a payment is the Suppliers card on /bills.
 */
describe("the page reads; it does not re-rule", () => {
  it("the supplier gap draws two sides against each other, names the difference, and offers a link, not a button", () => {
    const gap = section(RECONCILE_KINDS["supplier-gap"].anchor);
    // Ours and theirs, both named, with the supplier's own name on their side.
    expect(text(gap)).toContain("Your Tickets");
    expect(text(gap)).toContain("Northside Wholesale Supply Says");
    // $1,587.00 ours (four open tickets on that account) against $500.00 theirs: $1,087.00 apart.
    expect(text(gap)).toContain("$1,587.00");
    expect(text(gap)).toContain("$500.00");
    expect(text(gap)).toContain("$1,087.00 Apart");
    expect(text(gap)).toContain("4 bills bought on account and not squared up yet");
    // TEXT TO VISUAL: two bars, scaled against the bigger pile, not two paragraphs.
    expect((gap.match(/rounded-full/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Its one door is a LINK to the screen that owns those figures. No form, no button.
    expect(count(doors(gap), /^Open Northside Wholesale Supply On Bills$/)).toBe(1);
    expect(gap).toContain('href="/bills#supplier-invoices-acct-north"');
    expect(gap).not.toContain("<button");
    expect(gap).not.toContain("<form");
  });

  it("leads with ONE number, and it is the money in dispute rather than a count of rows", () => {
    // The lead is the sum of every supplier's gap, said before anything else on the page.
    const lead = text(html.slice(0, html.indexOf(`id="${RECONCILE_KINDS["supplier-gap"].anchor}"`)));
    expect(lead).toContain("$1,087.00");
    expect(lead).toContain("is the difference between what your own bills say you bought on account");
    expect(lead).not.toMatch(/^\s*\d+ Things/);
  });

  /**
   * THE STATEMENT DOOR IS AN INTAKE, NOT A CONTROL. Erik asked for it here twice ("i want to upload
   * my bank statement and supplier statement, every item will either match or need a category", and
   * of the line on Money: "this should be in reconcile too i imagine"), and it moved off /analytics
   * rather than being copied: one door. What it may NOT carry is the Apply — a paper is answered on
   * its own card under Needs You, or this page becomes the only door to a queued paper.
   */
  it("takes a statement in, says where it is answered, and carries no Apply", () => {
    expect(count(doors(html), "Drop A Bank Or Supplier Download")).toBe(1);
    expect(text(html)).toContain("Bring In A Statement");
    expect(text(html)).toContain("answered on its own card under Needs You on Bills");
    expect(count(doors(html), "Open Bills")).toBe(1);
    for (const gone of ["Apply", "Undo It", "Swap"]) expect(count(doors(html), gone), gone).toBe(0);
  });

  /**
   * AND IT NAMES WHAT IT ACTUALLY READS. LIST_ACCEPT (lib/open-list-file.ts) takes .csv .tsv .txt
   * .xlsx .xls .ofx .qfx .qbo and NOT a PDF, so copy that said "your statement" would send him to
   * the bank's Statements page for the PDF and hand him a refusal he had no reason to expect.
   */
  /**
   * AND THE DOOR THAT WAS NAMED "BELOW THIS CARD" ON MONEY NOW LANDS HERE. The Net Profit card's
   * Owner's Draw line said "Drop Your Bank Download below to change that" because the door was three
   * inches under it on /analytics. With the door moved, "below" pointed at nothing — so it is a link
   * now, and a link to an anchor that is not drawn is the same dead end from the other end.
   */
  it("the anchor the Net Profit card links to is drawn on this page, for either half of the gate", () => {
    const card = readFileSync(join(process.cwd(), "src/app/(app)/analytics/left-for-card.tsx"), "utf8");
    expect(card).toContain('href="/reconcile#bring-in-a-statement"');
    expect(card).not.toContain("Drop Your Bank Download");
    expect(html).toContain('id="bring-in-a-statement"');
  });

  it("the file types on the card are the file types the reader takes, PDF named as the one that is not", () => {
    const card = text(html.slice(html.indexOf("Bring In A Statement")));
    for (const said of ["CSV", "Excel", "OFX", "QFX", "QBO"]) expect(card, said).toContain(said);
    expect(card).toContain("A PDF can't be read as a list of lines");
    for (const ext of [".csv", ".tsv", ".txt", ".xlsx", ".xls", ".ofx", ".qfx", ".qbo"]) expect(LIST_ACCEPT, ext).toContain(ext);
    expect(LIST_ACCEPT).not.toContain(".pdf");
  });
});

/**
 * A ONE-TAP WRITE WITH NO UNDO SAYS SO ON SCREEN, NOT ONLY IN A FOLD. This travelled here with its
 * buttons: it is a safety test, and dropping it in a move would have been the quiet kind of loss.
 */
describe("a one-tap write with no undo says so on screen", () => {
  it("Not The Same and Keep Them Separate each carry their warning outside the Why? fold", () => {
    const names = section("supplier-names");
    const maybe = section("same-supplier-or-two");
    expect(text(names)).toContain("Not The Same Can't Be Undone Here");
    expect(text(maybe)).toContain("Keeping Them Separate Can't Be Undone Here");
    for (const fold of html.match(/<div class="mb-2 space-y-1 leading-relaxed">[\s\S]*?<\/div>/g) ?? []) {
      expect(fold).not.toContain("Undone Here");
    }
    expect(text(html)).toContain("What Does Each Answer Do?");
  });
});

/**
 * TECHS NEVER SEE PRICES. The dock row is staffOnly, which hides the door; this redirect is the
 * boundary. Two renders: staff gets the page, a tech gets sent to the Timeclock, and not one dollar
 * figure is serialized on the way.
 */
describe("staff only, and proved", () => {
  it("a tech is redirected to the Timeclock and no figure is rendered for him", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-tech", org_id: ORG, role: "tech", full_name: "A Tech" }] };
    redirectedTo = null;
    try {
      let out = "";
      await expect(async () => {
        out = await render();
      }).rejects.toThrow();
      expect(redirectedTo).toBe("/timeclock");
      expect(out).toBe("");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("an owner gets the page, with the figures on it", () => {
    expect(redirectedTo === "/timeclock" || redirectedTo === null).toBe(true);
    expect(text(html)).toContain("Reconcile");
    expect(text(html)).toContain("$1,087.00");
  });
});

/**
 * THE DROP DOOR IS THE OWNER'S MONEY, GATED BY THE OWNER'S ONE SWITCH (0286). A bank download is the
 * draw and the personal spending, line by line. /analytics gated this door on that switch; Reconcile
 * asks the SAME function (lib/bank-viewer.ts viewerSeesOwnerMoney) rather than deciding again, and
 * these two renders are the proof — a second copy of the condition would pass a source scan and fail
 * right here.
 */
describe("who may bring a bank download in", () => {
  const asOffice = (officeSees: boolean) => ({
    ...TABLES,
    profiles: [{ id: "user-owner", org_id: ORG, role: "office", full_name: "An Office Hand" }],
    organizations: [{ settings: { timezone: "America/Los_Angeles", office_sees_owner_money: officeSees }, name: "Synthetic Electric" }],
  });

  it("an office hand the owner has switched off gets no door, and is told which door is theirs", async () => {
    CURRENT = asOffice(false);
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Download")).toBe(0);
      expect(out).not.toContain('type="file"');
      // NOT A DEAD END: no control that could only refuse, and the door that IS theirs is named.
      expect(text(out)).toContain("The owner brings in bank downloads");
      expect(text(out)).toContain("Snap Or Note on Bills");
      expect(count(doors(out), "Open Bills")).toBe(1);
    } finally {
      CURRENT = TABLES;
    }
  });

  it("an office hand the owner has shared with gets the same door the owner has", async () => {
    CURRENT = asOffice(true);
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Download")).toBe(1);
      expect(text(out)).not.toContain("The owner brings in bank downloads");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("a company whose settings could not be read gets no door: the switch's default is never taken as a yes", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-owner", org_id: ORG, role: "office", full_name: "An Office Hand" }], organizations: [] };
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Download")).toBe(0);
    } finally {
      CURRENT = TABLES;
    }
  });

  /**
   * AND FAIL-CLOSED IS FOR THE VIEWER THE SWITCH IS ABOUT, NEVER FOR THE OWNER. The page read the
   * settings first and required the row, so a lost read — or an org_id that is still null, which
   * profiles allows — took the OWNER'S own door away and printed "The owner brings in bank downloads"
   * at the owner. The same owner stayed a yes through viewerSortsBank in every server action, which is
   * two answers to one question. The rule is asked in bank-viewer's own order now: the owner first,
   * and the read only where the switch can change the answer.
   */
  it("an owner whose settings could not be read keeps his own door: the switch was never his gate", async () => {
    CURRENT = { ...TABLES, profiles: [{ id: "user-owner", org_id: ORG, role: "owner", full_name: "A N Owner" }], organizations: [] };
    try {
      const out = await render();
      expect(count(doors(out), "Drop A Bank Or Supplier Download")).toBe(1);
      expect(text(out)).not.toContain("The owner brings in bank downloads");
    } finally {
      CURRENT = TABLES;
    }
  });
});

/**
 * A KIND WITH NOTHING OPEN DRAWS NOTHING, and a page with nothing open says so in plain words and is
 * NOT an error (badges show open; no dead ends).
 */
describe("a new company sees words, not an error", () => {
  it("nothing disagrees yet, said plainly, with no empty headings and no sections", async () => {
    CURRENT = { profiles: TABLES.profiles, organizations: TABLES.organizations };
    try {
      const fresh = await render();
      expect(text(fresh)).toContain("Reconcile");
      expect(text(fresh)).toContain("Nothing Disagrees Right Now");
      expect(text(fresh)).not.toContain("Couldn't");
      // No section of any kind, and no decision to press: nothing disagrees, so nothing is asked.
      for (const k of Object.values(RECONCILE_KINDS)) expect(fresh, k.anchor).not.toContain(`id="${k.anchor}"`);
      // THE ONLY TWO DOORS ON A QUIET PAGE ARE THE STATEMENT INTAKE AND THE LINK TO BILLS, and the
      // intake is drawn PRECISELY here: the book is quiet and the next download is in his hand. The
      // card used to be hidden on this page, which left an all-clear with no way to put anything on
      // it — a dead end. So the lead may not then print a flat "Nothing for you to do here" above a
      // door, and it does not: it names the door instead.
      expect(doors(fresh)).toEqual(["Drop A Bank Or Supplier Download", "Open Bills"]);
      expect(text(fresh)).toContain("drop it in below");
      expect(text(fresh)).not.toContain("Nothing for you to do here");
    } finally {
      CURRENT = TABLES;
    }
  });

  it("a book with names to sort but no money gap leads with what is waiting, not with $0.00", async () => {
    // The account's own papers agree with our tickets to the cent, so there is no gap to lead with.
    CURRENT = {
      ...TABLES,
      bills: BILLS.filter((b) => !String(b.id).startsWith("b-north")),
      supplier_invoices: [doc("d-open", { invoice_number: "9900-1", total: 87, open_balance: 87 })],
    };
    try {
      const fresh = await render();
      expect(text(fresh)).not.toContain("$0.00");
      expect(text(fresh)).toMatch(/\d+ Things To Sort Out/);
      expect(fresh).not.toContain(`id="${RECONCILE_KINDS["supplier-gap"].anchor}"`);
      // The decisions are still all there.
      expect(countDoors(doors(fresh), "Give It Its Own Account")).toBeGreaterThanOrEqual(1);
    } finally {
      CURRENT = TABLES;
    }
  });
});

/**
 * THE TYPED RECORD IS LOAD-BEARING, not documentation: the words it declares are the words on the
 * page, so a kind added to the union cannot ship with a heading nobody wrote.
 */
describe("the kinds Record is what the page is made of", () => {
  it("every kind answered here is drawn under the heading the Record gives it, with its own count", () => {
    for (const k of RECONCILE_ANSWERED_HERE) {
      const def = RECONCILE_KINDS[k];
      expect(html, k).toContain(`id="${def.anchor}"`);
      expect(text(section(def.anchor)), k).toContain(def.heading);
      // Its count is plain text in its own heading — never a dock number. ("(1)" on three of them,
      // "(1 Waiting)" on the duplicate picker, which keeps the picks he already made on the page.)
      const esc = def.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(text(section(def.anchor)), k).toMatch(new RegExp(`${esc}[^(]*\\(\\d+( Waiting)?\\)`));
    }
  });

  it("the sections run in the Record's order, the money reading first", () => {
    const order = Object.values(RECONCILE_KINDS)
      .sort((a, b) => a.order - b.order)
      .map((d) => html.indexOf(`id="${d.anchor}"`));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
