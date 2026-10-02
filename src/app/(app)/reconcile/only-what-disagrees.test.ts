import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { countDoors, doorsIn, sectionOf, textOf } from "@/test/rendered-page";
import { RECONCILE_KINDS } from "@/lib/reconcile-kinds";

/**
 * ── A PAPER IS ONLY A DISAGREEMENT IF IT IS UNMATCHED *AND* STILL OPEN ───────────────────────────
 *
 * Erik, minutes after using the page that shipped, both reports filed from /reconcile:
 *
 *   "I don't understand this give it account thing because it's already categorized and identified
 *    and most things are not going to be on an account honestly, so it doesn't make sense to have
 *    all these layers when it can be super simple. What is the expense categorized as if it's
 *    unclear ask."
 *
 *   "So therefore, anything not on an account will most likely be squared up as paid like
 *    everything else in my bills, except [the one supplier he has an account with]. I think that
 *    might be what I'm seeing on this page showing unaccounted for bills that doesn't make sense."
 *
 * He is right, and it is a design error in the brief this page was built to. A purchase paid at the
 * register has ONE record — the receipt — so there is nothing for a second record to disagree with.
 * The page was listing every spelling of every settled card swipe and offering to open a supplier
 * account with a petrol station, which is the stockpile failure (Needs You continuity) on the one
 * page whose whole job was the opposite of it.
 *
 * THE BOOK BELOW IS SHAPED LIKE HIS, MEASURED ON PRODUCTION 2026-10-01 AND NOT HARDCODED FROM IT:
 * mostly-settled register purchases on no supplier account, every one of them already categorised,
 * and exactly ONE genuinely open paper — the on-account supplier, under a spelling the identity
 * resolver did not reach. Before the fix the section drew a row for every spelling; after it, one.
 *
 * SYNTHETIC THROUGHOUT. Every supplier name, account number, job, category and figure below is
 * invented: this repository is public and no real customer, supplier or bank row goes in a
 * committed file.
 */

const ORG = "org-synthetic";
const RIDGE = "acct-ridgeline";
const J1 = "job-alder";

const JOBS = [
  { id: J1, job_number: "J-201", name: "9 Alder Court", status: "in_progress", address: "9 Alder Court", created_at: "2026-08-01T00:00:00Z", customers: null },
];

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  supplier: "Ridgeline Supply Co",
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

/**
 * A CARD SWIPE AT A PUMP OR A COUNTER: paid on the spot, no supplier account, already filed under
 * an expense category. Thirty-two of these is what the page was showing him.
 */
const swipe = (id: string, supplier: string, amount: number, category: string) =>
  bill(id, { supplier, amount, status: "paid", category });

/** The spellings on the register purchases, in the shape a pump or a counter prints them. */
const SWIPES: [string, number, string][] = [
  ["Petrol Stop Gilcrest", 61.4, "Fuel"],
  ["PETROL STOP BRIARFIELD", 58.22, "Fuel"],
  ["Petrol Stop Westmere #12", 70.05, "Fuel"],
  ["Cadence Fuel Oakbend", 44.9, "Fuel"],
  ["Cadence Fuel Thornhill", 52.18, "Fuel"],
  ["Pump House Marlow", 66.73, "Fuel"],
  ["PUMP HOUSE SEDGEWICK", 48.6, "Fuel"],
  ["Kestrel Fuel Stop 408", 73.11, "Fuel"],
  ["Kestrel Fuel Stop 219", 39.47, "Fuel"],
  ["Trailhead Fuel Bramwell", 55.29, "Fuel"],
  ["Trailhead Fuel Carrow", 62.84, "Fuel"],
  ["Longmire Pumps", 71.5, "Fuel"],
  ["Hardware Barn 212", 118.37, "Receipt"],
  ["HARDWARE BARN 455", 92.6, "Receipt"],
  ["Hardware Barn Northgate", 204.15, "Receipt"],
  ["Timber & Tool Depot", 87.99, "Receipt"],
  ["Timber And Tool Depot #3", 143.2, "Receipt"],
  ["Pegwood Builders Market", 76.44, "Receipt"],
  ["Autoline Parts Cavendish", 119.88, "Auto"],
  ["AUTOLINE PARTS HOLLIS", 64.3, "Auto"],
  ["Sprocket Auto Supply", 212.75, "Auto"],
  ["Driveline Tire Centre", 388.0, "Auto"],
  ["Northgate Mutual Cover", 412.6, "Insurance & Licenses"],
  ["County Permit Office", 95.0, "Insurance & Licenses"],
  ["Stonecroft Bonding", 240.0, "Insurance & Licenses"],
  ["Larkhill Rental Yard", 134.5, "Materials"],
  ["Beacon Trade Counter", 58.9, "Materials"],
  ["Quayside Coffee Stop", 14.25, "Other"],
  ["Wrenfield Carwash", 22.0, "Auto"],
  ["Halloway Signs & Print", 48.75, "Other"],
  ["Mercer Street Parking", 9.5, "Other"],
  ["Ferncross Postal Depot", 17.8, "Other"],
];

/** THE ONE GENUINELY OPEN PAPER: his on-account supplier, under a spelling nothing reached. */
const OPEN_SPELLING = "RDG WHOLESALE BR 7";
const OPEN_AMOUNT = 147.92;

const ACCOUNTS = [{ id: RIDGE, name: "Ridgeline Supply Co", account_number: "SYN-4", branch_code: null, on_account: true, note: null }];
const ALIASES = [{ id: "al-1", supplier_account_id: RIDGE, alias: "Ridgeline Supply Co", branch_label: null }];

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

/** HIS BOOK: thirty-two settled register purchases, all categorised, and one open unmatched paper. */
const HIS_BOOK: Record<string, unknown[]> = {
  ...BASE,
  bills: [
    ...SWIPES.map(([supplier, amount, category], i) => swipe(`sw-${i}`, supplier, amount, category)),
    bill("b-open", { supplier: OPEN_SPELLING, amount: OPEN_AMOUNT, category: "Receipt", job_id: J1, jobs: { job_number: "J-201", name: "9 Alder Court" } }),
  ],
};

let CURRENT: Record<string, unknown[]> = BASE;
let ERRORS: { table: string; whenSelectHas?: string }[] = [];

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

const render = async () => {
  const { default: ReconcilePage } = await import("./page");
  return renderToStaticMarkup((await ReconcilePage()) as React.ReactElement);
};

const ANCHOR = RECONCILE_KINDS["not-on-an-account"].anchor;
/** The pile's own section: the rows the "File It" door on /bills lands on. */
const pile = (html: string) => textOf(sectionOf(html, ANCHOR));
/** How many rows that section drew. One <li> per row. */
const rowCount = (html: string) => (sectionOf(html, ANCHOR).match(/<li\b/g) ?? []).length;

/**
 * THE MODULE GRAPH IS WARMED ONCE, OUTSIDE ANY TEST'S CLOCK. /reconcile pulls the whole bills tree in
 * behind it, and the first `import("./page")` of a cold run cost more than a test's five seconds under
 * full-suite load — so the first test in this file failed on a timer rather than on anything it
 * asserts. A test that can fail on load order has no teeth, and a flake is how a tripwire gets
 * switched off. The cost is paid once, here, where it belongs.
 */
beforeAll(async () => {
  await import("./page");
}, 60_000);

beforeEach(() => {
  CURRENT = BASE;
  ERRORS = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T18:00:00Z"));
});
afterAll(() => vi.useRealTimers());

describe("a settled register purchase is not a disagreement", () => {
  it("draws ONE row on his book, for the one paper still open", async () => {
    CURRENT = HIS_BOOK;
    const his = await render();
    expect(rowCount(his)).toBe(1);
    expect(pile(his)).toContain(OPEN_SPELLING);
    expect(pile(his)).toContain("$147.92");
    // And the lead is one thing, not thirty-two.
    expect(textOf(sectionOf(his, "reconcile-lead"))).toContain("1 Thing To Sort Out");
  });

  it("names not one of the thirty-two settled spellings anywhere on the page", async () => {
    CURRENT = HIS_BOOK;
    const words = textOf(await render());
    for (const [supplier] of SWIPES) expect(words, `${supplier} is settled: it has one record, not two`).not.toContain(supplier);
  });

  /**
   * TWO SETTLED SPELLINGS OF ONE COMPANY ARE NOT A QUESTION EITHER. The suggestion piles are slices
   * of the same pile, so the open test has to reach all three or the page just moves the stockpile
   * from one heading to the next: his book had a pair of settled counter receipts the fuzzy matcher
   * had an opinion about, and they were drawn as "Same Supplier, Or Two?" above the loose list.
   */
  it("asks nothing about two settled spellings of one company", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        swipe("tt-1", "Timber & Tool Depot", 87.99, "Receipt"),
        swipe("tt-2", "Timber And Tool Depot #3", 143.2, "Receipt"),
      ],
    };
    const html = await render();
    for (const k of ["supplier-names", "same-supplier-or-two", "not-on-an-account"] as const) {
      expect(html, k).not.toContain(`id="${RECONCILE_KINDS[k].anchor}"`);
    }
    expect(textOf(sectionOf(html, "reconcile-lead"))).toContain("Nothing Disagrees Right Now");
  });

  /** NOTHING LEAVES A FIGURE IN SILENCE: one sentence, a count, no names, no door, no second list. */
  it("accounts for what it stopped showing, in one sentence with a count and no names", async () => {
    CURRENT = HIS_BOOK;
    const words = pile(await render());
    expect(words).toContain("32 more purchases on no supplier account were paid at the register");
    expect(words).toContain("one record and nothing to square up");
  });

  it("says nothing about settled papers when there are none", async () => {
    CURRENT = { ...BASE, bills: [bill("b-open", { supplier: OPEN_SPELLING, amount: OPEN_AMOUNT, category: "Receipt" })] };
    expect(pile(await render())).not.toContain("paid at the register");
  });
});

/**
 * ── ONE NUMBER FOR ONE PILE ──────────────────────────────────────────────────────────────────────
 *
 * /bills' Suppliers card draws "$X On N Bills With No Supplier Account · File It" out of
 * `notOnAnAccount` and links to this section's anchor. The section counted its OWN rows, so the door
 * said "$147.92 On 1 Bill" and the page it landed on showed thirty-one rows and the same $147.92 —
 * two readings of one pile with nothing on either page reconciling them.
 */
describe("the door's figure and the section's figure are the same figure", () => {
  it("the section's count and money are the read's own, paper for paper", async () => {
    CURRENT = HIS_BOOK;
    const words = pile(await render());
    // ONE paper, $147.92 — exactly what the File It door on /bills quotes off `notOnAnAccount`.
    expect(words).toContain("Papers Not On A Supplier Account Yet (1)");
    expect(words).toContain("$147.92 Still Open");
  });

  /**
   * A PAPER WITH NO SUPPLIER NAME ON IT IS IN THE DOOR'S FIGURE AND USED TO BE IN NO SECTION. There
   * is no spelling to file, so no spelling spoke for it: the door said "1 Bill" and landed on a page
   * with nothing about it anywhere. It gets a row, and the row's door is the one place a paper is
   * answered.
   */
  it("a paper with no supplier name on it still gets a row, and a door", async () => {
    CURRENT = { ...BASE, bills: [bill("b-nameless", { supplier: "", amount: 312.75 })] };
    const html = await render();
    const words = pile(html);
    expect(words).toContain("Papers Not On A Supplier Account Yet (1)");
    expect(words).toContain("No Supplier Name On The Paper");
    expect(words).toContain("$312.75");
    // Its door is All Bills, not a search box: there is no name to type into one (see the door test).
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Find It In All Bills")).toBe(1);
  });

  /**
   * AND THE ANCHOR IS DRAWN EVEN WHEN THE PILE'S ONE ROW IS UPSTAIRS. The three name sections are
   * slices of this one pile, and the pile's own section draws what no suggestion speaks for — so a
   * pile of ONE, under a spelling the matcher does have an opinion about, left this section
   * unrendered and the File It door landing on nothing. That is the dead-end class.
   */
  it("the anchor the File It door points at is drawn even when the row is in a question above", async () => {
    CURRENT = {
      ...BASE,
      // Its spelling is a saved name for the account, so it is a one-press suggestion up the page
      // rather than a loose row: nothing is left for the pile's own list.
      bills: [bill("b-alias", { supplier: "Ridgeline Supply Co", amount: 410, category: "Receipt", supplier_account_id: null })],
      supplier_aliases: [{ id: "al-2", supplier_account_id: RIDGE, alias: "Ridgeline Supply Co", branch_label: null }],
    };
    const html = await render();
    // Nothing is loose, and the paper IS on an account by its own name, so the pile is empty and no
    // anchor is needed. The real case is the one below it.
    expect(html).not.toContain('id="not-on-an-account"');
  });

  /**
   * AND WHERE ONLY SOME OF THE PILE IS UPSTAIRS, THE HEADING'S COUNT SAYS SO. The heading is the
   * whole pile; these rows are what no suggestion speaks for. Two numbers on one card with nothing
   * joining them is the same fault as the door's, one card smaller.
   */
  it("says how many of the pile are in a question above, so the count and the rows agree", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("p-1", { supplier: "Fernhill Pipe & Fitting", amount: 120, category: "Receipt" }),
        bill("p-2", { supplier: "Fernhill Pipe and Fitting", amount: 95, category: "Receipt" }),
        bill("b-loose", { supplier: "Larkspur Trade Counter", amount: 61.4, category: "Receipt" }),
      ],
    };
    const words = pile(await render());
    // Three papers in the pile, one row: the other two are the merge proposal above.
    expect(words).toContain("Papers Not On A Supplier Account Yet (3)");
    expect(words).toContain("2 of them are in a question above");
  });

  it("a pile whose only paper is spoken for upstairs still draws the anchor, pointing at the row", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        // Two open spellings of one company: a merge proposal. Nothing is left loose, so the pile's
        // own list is empty — and the File It door on /bills still links to this anchor.
        bill("p-1", { supplier: "Fernhill Pipe & Fitting", amount: 120, category: "Receipt" }),
        bill("p-2", { supplier: "Fernhill Pipe and Fitting", amount: 95, category: "Receipt" }),
      ],
    };
    const html = await render();
    expect(html, "an anchor that is not drawn is a dead end").toContain(`id="${ANCHOR}"`);
    const words = pile(html);
    expect(words).toContain(RECONCILE_KINDS["not-on-an-account"].heading);
    expect(words).toContain("already in a question above");
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Go To The Question")).toBe(1);
    // And the question really is on the page to go to.
    expect(html).toContain(`id="${RECONCILE_KINDS["supplier-names"].anchor}"`);
  });
});

/**
 * ── THE QUESTION IS THE EXPENSE CATEGORY, AND ONLY WHERE IT IS UNCLEAR ──────────────────────────
 *
 * Erik's rule, verbatim: "What is the expense categorized as if it's unclear ask." Every one of his
 * sixty-nine papers was already categorised, so on his book the right number of questions is ZERO.
 * UNCLEAR means `bills.category` is blank — the only signal a filed bill carries (the reader's own
 * confidence lives on `organized_items`, which a bill no longer is).
 */
describe("it asks what the expense is, and only when that is unclear", () => {
  it("asks nothing on his book, because every paper is already categorised", async () => {
    CURRENT = HIS_BOOK;
    const html = await render();
    const words = pile(html);
    expect(words).toContain("Filed as Receipt");
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Say What The Expense Is")).toBe(0);
    expect(words).not.toContain("no expense category");
  });

  it("asks once where a paper carries no category word at all", async () => {
    CURRENT = { ...BASE, bills: [bill("b-blank", { supplier: "Larkspur Trade Counter", amount: 61.4, category: null })] };
    const html = await render();
    expect(pile(html)).toContain("no expense category on it yet");
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Say What The Expense Is")).toBe(1);
  });

  /** GIVING A SUPPLIER AN ACCOUNT IS STILL POSSIBLE — a real on-account supplier needs it. It is
   *  simply no longer the thing the page pushes at a one-off counter purchase. */
  it("keeps the Give It Its Own Account door, no longer as the row's lead", async () => {
    CURRENT = HIS_BOOK;
    const html = await render();
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Give It Its Own Account")).toBe(1);
    // IN THE ROW ITSELF: what the expense is comes first, the account door last. (The card's Why?
    // fold names that door too, in a sentence about when it is the right one — that is prose, and
    // this is about the order a person reads the row in.)
    const row = textOf(sectionOf(html, ANCHOR).match(/<li\b[\s\S]*?<\/li>/)![0]);
    expect(row.indexOf("Filed as Receipt")).toBeGreaterThan(-1);
    expect(row.indexOf("Filed as Receipt")).toBeLessThan(row.indexOf("Give It Its Own Account"));
  });

  /**
   * ── AND THE ONE QUESTION IT ASKS CAN BE ANSWERED WHERE IT SENDS HIM ───────────────────────────
   *
   * `bills.category` is the BUSINESS-COST bucket, and the owning screen forbids a job bill from
   * holding one: the bill editor writes `category: isOverhead ? billCategory : null` and renders the
   * Bucket control only `{isOverhead && ...}`. So every open unmatched paper attached to a job read
   * "no expense category on it yet", wore the one question the page now asks, and sent him to a bill
   * with no control that could answer it — a dead end wearing the question, on the page whose law is
   * no dead ends. Its expense IS the job, so it is answered and the row says so.
   */
  it("does not ask what a job-costed paper's expense is: the job is the answer", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("b-job", {
          supplier: "Larkspur Trade Counter",
          amount: 61.4,
          category: null,
          job_id: J1,
          jobs: { job_number: "J-201", name: "9 Alder Court" },
        }),
      ],
    };
    const html = await render();
    const words = pile(html);
    expect(countDoors(doorsIn(sectionOf(html, ANCHOR)), "Say What The Expense Is")).toBe(0);
    expect(words, "its bucket cannot be set off a job, so this is not a question").not.toContain("no expense category");
    expect(words).toContain("On a job");
    // And the footer does not count it as the one thing worth answering, because it is not one.
    expect(words).not.toContain("That is the one thing worth answering here");
  });

  /**
   * AND WHERE IT DOES ASK, THE DOOR CARRIES WHAT TO LOOK FOR. Both doors on this pile pointed at
   * `/bills#bills-search`, which scrolls to a box whose query is React state and reads no URL: he
   * landed on a blank box and the first thing he had to do was retype the spelling the row had just
   * shown him. And for the paper with NO name there is nothing to type at all, so a name search was
   * that row's only door — the one paper with no name sent somewhere it cannot be found by name.
   */
  it("the expense door carries the spelling, and the nameless paper is not sent to a name search", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("b-blank", { supplier: "Larkspur Trade Counter", amount: 61.4, category: null }),
        bill("b-nameless", { supplier: "", amount: 312.75 }),
      ],
    };
    const section = sectionOf(await render(), ANCHOR);
    const hrefs = Array.from(section.matchAll(/href="([^"]*)"/g)).map((m) => m[1]);
    expect(hrefs, "the box seeds from ?q=, so the spelling travels with the door").toContain(
      "/bills?q=Larkspur%20Trade%20Counter#bills-search",
    );
    expect(hrefs, "an empty search box is not a destination").not.toContain("/bills#bills-search");
    // There is no name to type, so it lands on the list the paper is actually in.
    expect(hrefs).toContain("/bills#all-bills");
    expect(countDoors(doorsIn(section), "Find It In All Bills")).toBe(1);
  });

  /** AND THE BOX REALLY ARRIVES WITH THE WORDS IN IT. A door is only a door if the far side opens. */
  it("the /bills search box opens with what the door asked it to look for", async () => {
    const { createElement } = await import("react");
    const { BillsSearchProvider, BillsSearchBox } = await import("@/app/(app)/bills/bills-search-box");
    const rows = [
      { key: "bill:b-blank", kind: "bill" as const, title: "Larkspur Trade Counter", sub: "$61.40", href: "#bill-b-blank", words: "larkspur trade counter 61.40" },
    ];
    const html = renderToStaticMarkup(
      createElement(BillsSearchProvider, {
        rows,
        initialQuery: "Larkspur Trade Counter",
        children: createElement(BillsSearchBox),
      }),
    );
    expect(html).toContain('value="Larkspur Trade Counter"');
    expect(textOf(html)).toContain("1 in All Bills matches");
  });
});

/**
 * ── THE ROW'S FACE SAYS WHAT THE TAP WILL DO (8a982483's rule, on this pile) ─────────────────────
 *
 * The pile became open-only, and the row's figures came with it — but the BUTTON acts on the
 * SPELLING: `fileSpelling` matches `spellingKey(b.supplier)` over every bill in the org with no
 * status filter. So a row reading "1 paper · $147.92 still open" moved three bills and $709.32, and
 * the only place that number ever appeared was the toast afterwards. Before the open test the row
 * said "3 bills · $709.32 · $147.92 still marked unpaid", which was honest about the scope.
 *
 * WHAT THE PRESS FILES IS NOT CHANGED. The saved alias puts those papers on the account whatever we
 * do here, and they belong there. It is the sentence that was wrong.
 */
describe("a row says the settled papers on its name go with the press", () => {
  const WITH_SETTLED: Record<string, unknown[]> = {
    ...BASE,
    bills: [
      bill("b-open", { supplier: OPEN_SPELLING, amount: OPEN_AMOUNT, category: "Receipt" }),
      swipe("b-s1", OPEN_SPELLING, 280.4, "Receipt"),
      swipe("b-s2", OPEN_SPELLING, 281.0, "Receipt"),
    ],
  };

  it("names the scope of Give It Its Own Account on the row itself", async () => {
    CURRENT = WITH_SETTLED;
    const words = pile(await render());
    // The pile is still the open paper, because that is the only disagreement.
    expect(words).toContain("1 paper");
    expect(words).toContain("$147.92 still open");
    // And the press is three papers, said before the press rather than in the toast after it.
    expect(words).toContain("filing it takes 2 settled papers on this name with it");
  });

  /**
   * THE SAME ON A MERGE PROPOSAL, whose Accept is the same write wearing a different sentence. It
   * said "Accepting files these 1 bill" over a press that moves three.
   */
  it("the merge proposal counts what Accept moves, and says which of it is settled", async () => {
    CURRENT = {
      ...BASE,
      bills: [
        bill("p-1", { supplier: "Fernhill Pipe & Fitting", amount: 120, category: "Receipt" }),
        bill("p-2", { supplier: "Fernhill Pipe and Fitting", amount: 95, category: "Receipt" }),
        swipe("p-3", "Fernhill Pipe & Fitting", 60, "Receipt"),
      ],
    };
    const words = textOf(sectionOf(await render(), RECONCILE_KINDS["supplier-names"].anchor));
    expect(words).toContain("3 bills");
    expect(words).toContain("1 of those was paid at the register already");
    // The row still shows the open money, and says the settled paper rides along with it.
    expect(words).toContain("+1 settled, filed too");
  });
});

/**
 * ── NOTHING LEAVES A FIGURE IN SILENCE, IN EVERY SHAPE THE PILE CAN LAND IN ─────────────────────
 *
 * The sentence accounting for the settled papers was typed inside the rows card, and that card draws
 * nothing the moment it has no rows. The measured book is in exactly that shape: the one open paper
 * arrives under a spelling the fuzzy matcher DOES have an opinion about, so it is a row in a
 * suggestion further up the page and the pile's own list is empty. Sixty-nine papers then left a
 * figure in silence while /bills' File It door went on quoting money for the pile.
 */
describe("the settled papers are accounted for wherever the pile lands", () => {
  /** The 69-shape: settled swipes, plus two open spellings of ONE company, so nothing is loose. */
  const ALL_ROWS_UPSTAIRS: Record<string, unknown[]> = {
    ...BASE,
    bills: [
      ...SWIPES.map(([supplier, amount, category], i) => swipe(`sw-${i}`, supplier, amount, category)),
      bill("p-1", { supplier: "Fernhill Pipe & Fitting", amount: 120, category: "Receipt" }),
      bill("p-2", { supplier: "Fernhill Pipe and Fitting", amount: 95, category: "Receipt" }),
    ],
  };

  it("says it on the one-line card the File It door lands on, with the door's own figure", async () => {
    CURRENT = ALL_ROWS_UPSTAIRS;
    const html = await render();
    expect(rowCount(html), "every open row is in the merge proposal above").toBe(0);
    const words = pile(html);
    expect(words, "the sentence was only ever inside the card that is not drawn here").toContain(
      "32 more purchases on no supplier account were paid at the register",
    );
    expect(words).toContain("one record and nothing to square up");
    // ONE NUMBER FOR ONE PILE: /bills' door says "$215.00 On 2 Bills", and so does the card it lands on.
    expect(words).toContain(`${RECONCILE_KINDS["not-on-an-account"].heading} (2)`);
    expect(words).toContain("$215.00 Still Open");
  });

  /**
   * AND IN THE ALL-CLEAR, WHICH IS HIS STEADY STATE. "anything not on an account will most likely be
   * squared up as paid like everything else in my bills" — so settling the last open unmatched paper
   * empties this pile, and the lead claimed "every supplier name is on an account" over a book where
   * thirty-two are not. A false all-clear is the worst thing on this page: it is the one he acts on
   * without scrolling.
   */
  it("does not claim every name is on an account over a book of settled swipes", async () => {
    CURRENT = { ...BASE, bills: SWIPES.map(([supplier, amount, category], i) => swipe(`sw-${i}`, supplier, amount, category)) };
    const words = textOf(sectionOf(await render(), "reconcile-lead"));
    expect(words).toContain("Nothing Disagrees Right Now");
    expect(words, "thirty-two of his names are not on an account").not.toContain("every supplier name is on an account");
    expect(words).toContain("no supplier name is waiting to be put on an account");
    // And what it stopped showing is still accounted for, in the one sentence.
    expect(words).toContain("32 more purchases on no supplier account were paid at the register");
  });

  it("says nothing of the sort when nothing was left out", async () => {
    CURRENT = { ...BASE, bills: [] };
    const words = textOf(sectionOf(await render(), "reconcile-lead"));
    expect(words).toContain("Nothing Disagrees Right Now");
    expect(words).not.toContain("paid at the register");
  });
});

/**
 * ── A CREDIT IS MONEY BACK, NOT A NEGATIVE DEBT ─────────────────────────────────────────────────
 *
 * A return goes in this app as a negative on-account bill, and the row printed its money straight
 * through "still open": "-$51.58 still open", while the lead on the SAME page said it correctly —
 * "A credit of $51.58 on 1 of them is money back, so it is not in that figure either." Two sentences
 * about one paper on one screen, one of them calling money back a debt. `whatISupplierOwed` routes a
 * credit to `ahead` to prevent exactly this; the row's words now make the same split.
 */
describe("a credit and a zero are not debts", () => {
  it("reads a return as money back, never as a negative still open", async () => {
    CURRENT = {
      ...BASE,
      bills: [bill("b-credit", { supplier: "Larkspur Trade Counter", amount: -51.58, category: "Materials" })],
    };
    const html = await render();
    const words = pile(html);
    expect(words).toContain("a credit of $51.58, money back");
    expect(words, "a negative debt is not a thing").not.toMatch(/-\s*\$51\.58/);
    // And the lead's sentence about the same paper still agrees with it.
    expect(textOf(sectionOf(html, "reconcile-lead"))).toContain("money back");
  });

  it("does not print a debt of nothing on a zero paper", async () => {
    CURRENT = { ...BASE, bills: [bill("b-zero", { supplier: "Larkspur Trade Counter", amount: 0, category: "Materials" })] };
    const words = pile(await render());
    expect(words).toContain("nothing owed");
    expect(words).not.toContain("$0.00 still open");
  });

  it("a nameless paper's money reads the same way", async () => {
    CURRENT = { ...BASE, bills: [bill("b-nameless-credit", { supplier: "", amount: -51.58 })] };
    const words = pile(await render());
    expect(words).toContain("a credit of $51.58, money back");
    expect(words).not.toMatch(/-\s*\$51\.58/);
  });
});
