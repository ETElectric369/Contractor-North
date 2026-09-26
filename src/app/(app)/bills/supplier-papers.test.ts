import { describe, it, expect } from "vitest";
import { booksBeginOn, readSupplierDocuments, reconcileJobsOf, supplierDocumentRows, supplierPaperFeed } from "./supplier-papers";
import { creditWait, ET_BOOKS_BEGIN, shortSupplierName, supplierPaperLine, supplierPaperNeeds, supplierPapersWaitingOnCredit, supplierPaperTotals } from "./supplier-reconcile";
import { supplierPaperActionItem, SUPPLIER_PAPERS_ITEM_ID } from "@/lib/action-items/supplier-paper-item";
import { fold, searchBills, wordsOf, moneyWords, type BillsSearchRow } from "./bills-search";

/**
 * "HEY YOU, HERE'S A BILL, WHAT'S IT FOR?" ON HIS REAL PAPERS (Bills plan, Wave A, 2026-09-25).
 *
 * Every row below is shaped like ET's live rows the night this was built: the CED numbers, dates,
 * job names and totals are his, the jobs are his (ids shortened), the statement bill's lines are
 * the lines the receipt reader wrote ("Sales Tax 9.00 percent (Invoice 8802-1105868)"). The read-
 * only replay against ET that night listed 9 cards (8802-1107820 and 8802-1106969 had both just
 * been recorded by hand), none of them from before June 8 and none on Saddle Rd.
 */

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const CED = "acct-ced";

const JOB_ROWS = [
  { id: "j-002", job_number: "J-002", name: "Tao Zhu", status: "complete", address: "235 Timbercreek Court" },
  { id: "j-006", job_number: "J-006", name: "5659 Rhodesia", status: "complete", address: "5659 Rhodesia Road" },
  { id: "j-010", job_number: "J-010", name: "11301 Purple Sage", status: "complete", address: "11301 Purple Sage Rd, Truckee, CA 96161, USA" },
  { id: "j-011", job_number: "J-011", name: "13897 Herringbone", status: "in_progress", address: "13897 Herringbone Way" },
  { id: "j-013", job_number: "J-013", name: "TTP #56", status: "on_hold", address: "300 W Lake Blvd, Tahoe City, CA 96145, USA" },
  { id: "j-014", job_number: "J-014", name: "5659 Rhodesia", status: "to_be_scheduled", address: "5659 Rhodesia Rd, Carnelian Bay, CA 96140, USA" },
  { id: "j-028", job_number: "J-028", name: "85 Whitney Place", status: "in_progress", address: "85 Whitney Court" },
  { id: "j-030", job_number: "J-030", name: "13631 Northwoods", status: "complete", address: "13631 Northwoods Boulevard" },
  { id: "j-033", job_number: "J-033", name: "5659 Rhodesia", status: "complete", address: "5659 Rhodesia Rd, Carnelian Bay, CA 96140, USA" },
  { id: "j-034", job_number: "J-034", name: "5659 Rhodesia - Panel Upgrade", status: "on_hold", address: "5659 Rhodesia Road" },
  { id: "j-042", job_number: "J-042", name: "TTP #106", status: "complete", address: "300 West Lake Boulevard" },
  { id: "j-045", job_number: "J-045", name: "13683 Hillside", status: "complete", address: "13683 Hillside Drive" },
  { id: "j-050", job_number: "J-050", name: "3639 Saddle Road", status: "complete", address: "3639 Saddle Rd" },
  { id: "j-099", job_number: "J-099", name: "Old Cancelled Job", status: "cancelled", address: null },
];
const JOBS = reconcileJobsOf(JOB_ROWS);
const ACCOUNTS = [{ id: CED, name: "Consolidated Electrical Distributors" }];

let seq = 0;
const doc = (over: Record<string, unknown>) => ({
  id: `si-${++seq}`,
  supplier_account_id: CED,
  kind: "invoice",
  invoice_date: "2026-09-01",
  due_date: null,
  job_name_raw: null,
  job_id: null,
  open_balance: null,
  closed: false,
  discount_amount: null,
  discount_by: null,
  source_file: null,
  jobs: null,
  ...over,
});

/** His CED documents that matter to a card, in the shapes the database hands back. */
function hisDocuments() {
  seq = 0;
  return [
    // ── the ones a person still has to answer ───────────────────────────────────────────────
    doc({ id: "herringbone", invoice_number: "8802-1106969", invoice_date: "2026-09-04", job_name_raw: "13897 HERRINGBONE", total: "301.81" }),
    doc({ id: "whitney", invoice_number: "8802-1107820", invoice_date: "2026-09-16", job_name_raw: "85 WHITNEY", total: "187.64" }),
    doc({ id: "rhodesia", invoice_number: "8802-1105878", invoice_date: "2026-08-19", job_name_raw: "5659 RHODESIA", total: "216.44", closed: true }),
    doc({ id: "blank", invoice_number: "8802-1102291", invoice_date: "2026-06-29", job_name_raw: "CUSTOMER ORDER NO.", total: "451.75", closed: true }),
    doc({ id: "ttp56", invoice_number: "8802-1102103", invoice_date: "2026-06-25", job_name_raw: "TTP56", total: "523.47", closed: true }),
    doc({ id: "june8", invoice_number: "8802-1100911", invoice_date: "2026-06-08", job_name_raw: "5661 RHODESIA", total: "3.15", closed: true }),
    // ── covered by a bill already: never a card ─────────────────────────────────────────────
    doc({ id: "stmt-a", invoice_number: "8802-1105868", invoice_date: "2026-08-19", job_name_raw: "85 WHITNEY PLACE", total: "2950.17", closed: true }),
    doc({ id: "stmt-b", invoice_number: "8802-1105963", invoice_date: "2026-08-19", job_name_raw: "85 WHITNEY PL", total: "84.37" }),
    doc({ id: "taozhu", invoice_number: "8802-1101820", invoice_date: "2026-06-24", job_name_raw: "235 TIMBER CREEK", total: "1810.55", closed: true }),
    // ── never a card, each for its own reason ───────────────────────────────────────────────
    doc({ id: "returned", invoice_number: "8802-1107230", invoice_date: "2026-09-03", job_name_raw: "TTP 106", job_id: "j-042", total: "225.47" }),
    doc({ id: "return-memo", invoice_number: "8802-1107337", kind: "credit_memo", invoice_date: "2026-09-03", job_name_raw: "TTP 106", job_id: "j-042", total: "-225.47" }),
    doc({ id: "credit", invoice_number: "8802-1104645", kind: "credit_memo", invoice_date: "2026-08-06", job_name_raw: "13631 NORTHWOODS", total: "-31.86" }),
    doc({ id: "interest", invoice_number: "9019682437", kind: "service_charge", invoice_date: "2026-07-25", total: "31.26" }),
    doc({ id: "statement", invoice_number: "STATEMENT-082526", kind: "statement", invoice_date: "2026-08-25", total: "2587.66", closed: true }),
    doc({ id: "stock", invoice_number: "8802-1103061-X", invoice_date: "2026-07-13", job_name_raw: "STOCK", total: "114.40", closed: true }),
    doc({ id: "nothing", invoice_number: "8802-1109000", invoice_date: "2026-09-10", job_name_raw: "13897 HERRINGBONE", total: "0.00" }),
    // ── before June 8: the Saddle Rd pair already on J-050, and the two 5/28 Rhodesias ───────
    doc({ id: "saddle-1", invoice_number: "8802-1099048", invoice_date: "2026-05-28", job_name_raw: "3639 SADDLE RD", job_id: "j-050", total: "355.17", closed: true }),
    doc({ id: "saddle-2", invoice_number: "8802-1099868", invoice_date: "2026-05-28", job_name_raw: "3639 SADDLE", job_id: "j-050", total: "66.00", closed: true }),
    doc({ id: "rhod-528a", invoice_number: "8802-1100090", invoice_date: "2026-05-28", job_name_raw: "5659 RHODESIA", total: "744.96", closed: true }),
    doc({ id: "rhod-528b", invoice_number: "8802-1100166", invoice_date: "2026-05-28", job_name_raw: "5659 RHODESIA", total: "375.31", closed: true }),
  ];
}

/** The bills that cover papers above: a scanned statement naming two invoices on its own lines,
 *  and a photo linked by the Record button. */
function hisBills() {
  return [
    {
      id: "1812d1a3",
      supplier: "Consolidated Electrical Distributors, Inc. (CED)",
      supplier_account_id: CED,
      bill_number: null,
      supplier_invoice_number: null,
      amount: "3034.54",
      bill_date: "2026-08-28",
      job_id: "j-028",
      is_statement: false,
      superseded_by_bill_id: null,
      notes: "Receipt recorded as cost: 85 Whitney Pl - CED.pdf",
      jobs: { job_number: "J-028", name: "85 Whitney Place" },
      line_items: [
        { description: "5/6 in RL, 900/1200LM 5CCT D2W" },
        { description: "Sales Tax 9.00 percent (Invoice 8802-1105868)" },
        { description: "5/6 in RL, 900/1200LM 5CCT D2W (Invoice 8802-1105963)" },
        { description: "Sales Tax 9.00 percent (Invoice 8802-1105963)" },
      ],
    },
    {
      id: "64451b80",
      supplier: "Consolidated Electrical Dist.",
      supplier_account_id: CED,
      bill_number: null,
      supplier_invoice_number: null,
      amount: "1810.55",
      bill_date: "2026-06-22",
      job_id: "j-002",
      is_statement: false,
      superseded_by_bill_id: null,
      notes: "Receipt recorded as cost: image.jpg",
      jobs: { job_number: "J-002", name: "Tao Zhu" },
      line_items: [{ description: "SIEM Q2100 2P 100A 120/240V CB" }],
    },
  ];
}

const LINKS = [{ bill_id: "64451b80", supplier_invoice_id: "taozhu" }];

function feedTonight(over: { documents?: any[]; bills?: any[]; links?: any[] } = {}) {
  const bills = over.bills ?? hisBills();
  const { rows } = supplierDocumentRows({ documents: over.documents ?? hisDocuments(), bills, links: over.links ?? LINKS, aliasRows: [] });
  return supplierPaperFeed({ since: booksBeginOn(ET, bills), rows, jobs: JOBS, accounts: ACCOUNTS });
}
const card = (feed: ReturnType<typeof feedTonight>, number: string) => feed.cards.find((c) => c.invoiceNumber === number);

describe("the June 8 line (Erik: \"june 8 is good\")", () => {
  it("is ET's first-job day, named once, and only ET has one", () => {
    expect(ET_BOOKS_BEGIN).toBe("2026-06-08");
    expect(supplierPaperLine(ET)).toBe("2026-06-08");
    expect(supplierPaperLine("some-other-org")).toBeNull();
  });

  it("beats ET's earliest scanned bill (2026-04-20), and another org falls back to its own first bill", () => {
    expect(booksBeginOn(ET, [{ bill_date: "2026-04-20" }, { bill_date: "2026-09-01" }])).toBe("2026-06-08");
    expect(booksBeginOn("tahoe-deck", [{ bill_date: "2026-07-02" }, { bill_date: "2026-06-30" }])).toBe("2026-06-30");
    expect(booksBeginOn("tahoe-deck", [])).toBeNull();
  });

  it("no Saddle Rd card and nothing from before June 8, but June 8 itself counts", () => {
    const f = feedTonight();
    for (const n of ["8802-1099048", "8802-1099868", "8802-1100090", "8802-1100166"]) expect(card(f, n)).toBeUndefined();
    expect(f.cards.some((c) => /SADDLE/.test(c.said ?? ""))).toBe(false);
    expect(f.cards.every((c) => !c.date || c.date >= "2026-06-08")).toBe(true);
    expect(card(f, "8802-1100911")).toBeTruthy();
  });
});

describe("which papers make a card", () => {
  it("CED's 8802-1106969 reads the way Erik asked, and J-011 is the first button, never picked for him", () => {
    const c = card(feedTonight(), "8802-1106969")!;
    expect(c.supplier).toBe("CED");
    expect(c.total).toBe(301.81);
    expect(c.said).toBe("13897 HERRINGBONE");
    expect(c.state).toBe("needs_job");
    expect(c.verdict).toBe("one");
    expect(c.suggestion).toEqual({ id: "j-011", label: "J-011", name: "13897 Herringbone", status: "in progress" });
    expect(c.candidates).toEqual([]);
  });

  it("8802-1107820 (85 WHITNEY) suggests J-028", () => {
    expect(card(feedTonight(), "8802-1107820")!.suggestion?.label).toBe("J-028");
  });

  it("a Rhodesia paper asks: the close jobs are chips and none of them goes first", () => {
    const c = card(feedTonight(), "8802-1105878")!;
    expect(c.verdict).toBe("ask");
    expect(c.suggestion).toBeNull();
    const labels = c.candidates.map((j) => j.label);
    for (const j of ["J-033", "J-006", "J-014", "J-034"]) expect(labels).toContain(j);
    expect(labels.length).toBeLessThanOrEqual(5);
  });

  it("CUSTOMER ORDER NO. is no name at all: Pick A Job, nothing suggested", () => {
    const c = card(feedTonight(), "8802-1102291")!;
    expect(c.verdict).toBe("blank");
    expect(c.said).toBeNull();
    expect(c.suggestion).toBeNull();
    expect(c.candidates).toEqual([]);
  });

  it("quotes CED's own words verbatim: TTP56 stays TTP56", () => {
    const c = card(feedTonight(), "8802-1102103")!;
    expect(c.said).toBe("TTP56");
    expect(c.suggestion?.label).toBe("J-013");
  });

  it("the papers his books already cover never appear: a statement's lines, and a linked photo", () => {
    const f = feedTonight();
    for (const n of ["8802-1105868", "8802-1105963", "8802-1101820"]) expect(card(f, n)).toBeUndefined();
  });

  it("never a card: the reversed pair, a credit memo, interest, a statement, STOCK, and $0.00", () => {
    const f = feedTonight();
    for (const n of ["8802-1107230", "8802-1107337", "8802-1104645", "9019682437", "STATEMENT-082526", "8802-1103061-X", "8802-1109000"])
      expect(card(f, n)).toBeUndefined();
  });

  it("tonight's live-shaped book is exactly six cards, newest first", () => {
    expect(feedTonight().cards.map((c) => c.invoiceNumber)).toEqual([
      "8802-1107820",
      "8802-1106969",
      "8802-1105878",
      "8802-1102291",
      "8802-1102103",
      "8802-1100911",
    ]);
  });

  it("once a bill carries its number (recorded by hand tonight), 8802-1106969's card is gone", () => {
    const recorded = {
      id: "8199879b",
      supplier: "Consolidated Electrical Distributors",
      supplier_account_id: CED,
      bill_number: "8802-1106969",
      supplier_invoice_number: "8802-1106969",
      amount: "301.81",
      bill_date: "2026-09-04",
      job_id: "j-011",
      is_statement: false,
      superseded_by_bill_id: null,
      notes: "Recorded from Consolidated Electrical Distributors invoice 8802-1106969, the supplier's own document.",
      jobs: { job_number: "J-011", name: "13897 Herringbone" },
      line_items: [],
    };
    expect(card(feedTonight({ bills: [...hisBills(), recorded] }), "8802-1106969")).toBeUndefined();
  });

  it("a paper a person already put on a job, after the line, asks only for the bill", () => {
    const documents = [doc({ id: "saddle-late", invoice_number: "8802-1111111", invoice_date: "2026-06-20", job_name_raw: "3639 SADDLE", job_id: "j-050", total: "66.00" })];
    const c = feedTonight({ documents, bills: [], links: [] }).cards[0];
    expect(c.state).toBe("record");
    expect(c.onJob?.label).toBe("J-050");
    expect(c.suggestion).toBeNull();
  });

  it("a maybe-same-purchase bill rides on the card, for Same Purchase: Tie Them", () => {
    // A counter ticket on J-011 for the same money two days earlier: CED's number is never on it.
    const ticket = {
      id: "e2380fc9",
      supplier: "Consolidated Electrical Dist.",
      supplier_account_id: CED,
      bill_number: "8802-SO-257555",
      supplier_invoice_number: null,
      amount: "301.81",
      bill_date: "2026-09-02",
      job_id: "j-011",
      is_statement: false,
      superseded_by_bill_id: null,
      notes: null,
      jobs: { job_number: "J-011", name: "13897 Herringbone" },
      line_items: [],
    };
    const c = card(feedTonight({ bills: [...hisBills(), ticket] }), "8802-1106969")!;
    expect(c.samePurchase.map((s) => s.billId)).toEqual(["e2380fc9"]);
    expect(c.samePurchase[0].sentence).toContain("Maybe already on the books");
  });

  it("the pickers never offer a cancelled job", () => {
    expect(feedTonight().jobs.map((j) => j.label)).not.toContain("J-099");
  });
});

describe("review of Wave A", () => {
  it("a weak card still brings the nearest jobs, for the top of its picker (5661 RHODESIA)", () => {
    const c = card(feedTonight(), "8802-1100911")!;
    expect(c.verdict).toBe("weak");
    const closest = (c.closest ?? []).map((j) => j.label);
    expect(closest.length).toBeGreaterThan(0);
    expect(closest.length).toBeLessThanOrEqual(5);
    for (const j of closest.slice(0, 3)) expect(["J-006", "J-014", "J-033", "J-034"]).toContain(j);
    expect(closest).not.toContain("J-099"); // a cancelled job is never offered
  });

  it("a credit memo from one supplier never reverses another supplier's purchase (the Record button reads per account)", () => {
    const rows = supplierDocumentRows({
      documents: [
        doc({ id: "a-buy", supplier_account_id: "acct-a", invoice_number: "A-1", total: "120.00", job_name_raw: "13897 HERRINGBONE", invoice_date: "2026-09-10" }),
        doc({ id: "b-memo", supplier_account_id: "acct-b", invoice_number: "B-9", kind: "credit_memo", total: "-120.00", invoice_date: "2026-09-11" }),
      ],
      bills: [],
      links: [],
      aliasRows: [],
    }).rows;
    const cards = supplierPaperNeeds(rows, JOBS, { since: "2026-06-08" });
    expect(cards.map((c) => c.invoiceId)).toEqual(["a-buy"]);
    // On one account the same pair IS a return, and makes no card.
    const same = supplierDocumentRows({
      documents: [
        doc({ id: "a-buy", supplier_account_id: "acct-a", invoice_number: "A-1", total: "120.00", invoice_date: "2026-09-10" }),
        doc({ id: "a-memo", supplier_account_id: "acct-a", invoice_number: "A-9", kind: "credit_memo", total: "-120.00", invoice_date: "2026-09-11" }),
      ],
      bills: [],
      links: [],
      aliasRows: [],
    }).rows;
    expect(supplierPaperNeeds(same, JOBS, { since: "2026-06-08" })).toEqual([]);
  });
});

describe("one reading of 'is this paper already in his books?'", () => {
  it("counts a statement's bill once for each invoice it names, and a link and a named number once together", () => {
    const { rows } = supplierDocumentRows({
      documents: hisDocuments(),
      bills: hisBills(),
      links: [...LINKS, { bill_id: "1812d1a3", supplier_invoice_id: "stmt-a" }],
      aliasRows: [],
    });
    const byNumber = new Map(rows.map((r) => [r.invoiceNumber, r]));
    expect(byNumber.get("8802-1105868")!.billCount).toBe(1); // linked AND named: still one bill
    expect(byNumber.get("8802-1105963")!.billCount).toBe(1);
    expect(byNumber.get("8802-1101820")!.billCount).toBe(1);
    expect(byNumber.get("8802-1106969")!.billCount).toBe(0);
    expect(byNumber.get("8802-1106969")!.supplierAccountId).toBe(CED);
  });

  it("a bill set aside as a duplicate covers nothing", () => {
    const setAside = hisBills().map((b) => (b.id === "1812d1a3" ? { ...b, superseded_by_bill_id: "someone-else" } : b));
    const { rows } = supplierDocumentRows({ documents: hisDocuments(), bills: setAside, links: LINKS, aliasRows: [] });
    expect(rows.find((r) => r.invoiceNumber === "8802-1105868")!.billCount).toBe(0);
  });
});

describe("the supplier bills badge as ONE line (the BADGE INVARIANT)", () => {
  it("any number of cards is one item, in the money stream, open-only", () => {
    const f = feedTonight();
    const item = supplierPaperActionItem(f)!;
    expect(item.id).toBe(SUPPLIER_PAPERS_ITEM_ID);
    expect(item.kind).toBe("supplier_paper");
    expect(item.stream).toBe("money");
    expect(item.affordances).toEqual(["open"]);
    expect(item.title).toBe(`Supplier Bills · ${f.cards.length}`);
    expect(item.subtitle).toBe(`$${supplierPaperTotals(f.cards).total.toLocaleString("en-US", { minimumFractionDigits: 2 })} from CED, not in your books yet`);
    // Undated: no invented "98d overdue".
    expect(item.when).toBeNull();
    expect(item.supplierPapers?.cards).toHaveLength(f.cards.length);
  });

  it("nothing waiting is no item at all, never a line that says 0", () => {
    expect(supplierPaperActionItem({ cards: [], jobs: [] })).toBeNull();
    expect(supplierPaperActionItem(null)).toBeNull();
  });
});

describe("shortSupplierName", () => {
  it("says CED, keeps a short name, and prefers the short form an account carries", () => {
    expect(shortSupplierName("Consolidated Electrical Distributors")).toBe("CED");
    expect(shortSupplierName("Swigard's Hardware")).toBe("Swigard's Hardware");
    expect(shortSupplierName("Ace Mountain Hardware")).toBe("Ace Mountain Hardware");
    expect(shortSupplierName("Outdoor Supply Hardware (OSH - Cupertino)")).toBe("OSH - Cupertino");
    expect(shortSupplierName(null)).toBe("The Supplier");
  });

  it("supplierPaperNeeds without names still says who it is from", () => {
    const { rows } = supplierDocumentRows({ documents: hisDocuments(), bills: hisBills(), links: LINKS, aliasRows: [] });
    expect(supplierPaperNeeds(rows, JOBS, { since: "2026-06-08" })[0].supplier).toBe("The Supplier");
  });
});

describe("finding a paper on /bills by what he remembers", () => {
  const rows: BillsSearchRow[] = [
    {
      key: "paper:1",
      kind: "paper",
      title: "CED Invoice 8802-1107820",
      sub: "",
      words: wordsOf("8802-1107820", "85 WHITNEY", "CED", moneyWords(187.64), "J-028", "85 Whitney Place", "85 Whitney Court"),
      href: "/jobs/j-028",
    },
    {
      key: "bill:2",
      kind: "bill",
      title: "CED #8802-1106969",
      sub: "",
      words: wordsOf("8802-1106969", "Consolidated Electrical Distributors", moneyWords("301.81"), "J-011", "13897 Herringbone"),
      href: "/jobs/j-011",
    },
  ];
  const keys = (q: string) => searchBills(rows, q).hits.map((h) => h.key);

  it("by number, street, job, CED's words, or money", () => {
    expect(keys("1107820")).toEqual(["paper:1"]);
    expect(keys("8802-1106969")).toEqual(["bill:2"]);
    expect(keys("whitney")).toEqual(["paper:1"]);
    expect(keys("herringbone")).toEqual(["bill:2"]);
    expect(keys("J-028")).toEqual(["paper:1"]);
    expect(keys("$187.64")).toEqual(["paper:1"]);
    expect(keys("301.81")).toEqual(["bill:2"]);
  });

  it("every word he types has to match, and one character finds nothing", () => {
    expect(keys("whitney 301")).toEqual([]);
    expect(keys("8")).toEqual([]);
    expect(keys("8802")).toEqual(["paper:1", "bill:2"]);
  });

  it("says how many more matched than it shows", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...rows[0], key: `p${i}` }));
    const { hits, more } = searchBills(many, "whitney", 25);
    expect(hits).toHaveLength(25);
    expect(more).toBe(5);
  });

  it("folds money and numbers the way they get typed", () => {
    expect(fold("$1,062.18")).toBe("1062.18");
    expect(moneyWords("1062.18")).toBe("1062.18");
    expect(fold("CUSTOMER ORDER NO.")).toBe("customer order no");
  });
});

// ── WAITING ON A CREDIT (Erik, 2026-09-26; 0346) ─────────────────────────────────────────────────
//
// His real paper: 8802-1107139, $59.17, 13683 HILLSIDE, the replacement of a faulty switch that a
// CED credit memo for the same amount will take back off. The credit hadn't come in.

describe("Waiting On A Credit: 8802-1107139, $59.17, 13683 HILLSIDE", () => {
  const hillside = (over: Record<string, unknown> = {}) =>
    doc({ id: "hillside", invoice_number: "8802-1107139", invoice_date: "2026-09-01", job_name_raw: "13683 HILLSIDE", total: "59.17", ...over });
  const feedWith = (extra: any[], today: string) => {
    const bills = hisBills();
    const { rows } = supplierDocumentRows({ documents: [...hisDocuments(), ...extra], bills, links: LINKS, aliasRows: [] });
    return supplierPaperFeed({ since: booksBeginOn(ET, bills), rows, jobs: JOBS, accounts: ACCOUNTS, today });
  };
  // Tapped at 5pm in Truckee on Sep 26: still Sep 26 there, though it is Sep 27 in UTC.
  const TAPPED = "2026-09-27T00:10:00+00:00";

  it("today it is a card, suggesting J-045, with nothing waiting", () => {
    const f = feedWith([hillside()], "2026-09-26");
    const c = card(f, "8802-1107139")!;
    expect(c.suggestion?.label).toBe("J-045");
    expect(c.waitingCredit).toBeUndefined();
    expect(f.waiting).toEqual([]);
  });

  it("waiting, it leaves the cards (My Day and Needs You) and is listed as waiting, back in 30 days", () => {
    const f = feedWith([hillside({ waiting_credit_since: TAPPED })], "2026-10-25");
    expect(card(f, "8802-1107139")).toBeUndefined();
    expect(f.waiting?.map((c) => c.invoiceNumber)).toEqual(["8802-1107139"]);
    expect(f.waiting?.[0].waitingCredit).toEqual({ since: "2026-09-26", back: "2026-10-26", overdue: false });
    // My Day's one line counts the cards only.
    expect(supplierPaperActionItem(f)?.title).toBe("Supplier Bills · 6");
    // The other six are exactly where they were.
    expect(f.cards).toHaveLength(6);
  });

  it("with no credit after 30 days it comes back by itself and says so", () => {
    const f = feedWith([hillside({ waiting_credit_since: TAPPED })], "2026-10-26");
    const c = card(f, "8802-1107139")!;
    expect(c.stillNoCredit).toBe("Still no credit from CED after 30 days");
    expect(c.waitingCredit?.overdue).toBe(true);
    expect(f.waiting).toEqual([]);
  });

  it("once CED's credit memo for $59.17 on the same account lands, the pair is gone from both lists", () => {
    const memo = doc({ id: "hillside-credit", invoice_number: "8802-1109999", kind: "credit_memo", invoice_date: "2026-10-02", job_name_raw: "13683 HILLSIDE", total: "-59.17" });
    for (const today of ["2026-10-05", "2026-11-30"]) {
      const f = feedWith([hillside({ waiting_credit_since: TAPPED }), memo], today);
      expect(card(f, "8802-1107139")).toBeUndefined();
      expect(f.waiting).toEqual([]);
    }
  });

  it("a credit memo on ANOTHER supplier's account never pairs with it", () => {
    const other = doc({ id: "other-credit", supplier_account_id: "acct-other", invoice_number: "X-1", kind: "credit_memo", total: "-59.17" });
    const f = feedWith([hillside({ waiting_credit_since: TAPPED }), other], "2026-10-26");
    expect(card(f, "8802-1107139")?.stillNoCredit).toBe("Still no credit from CED after 30 days");
  });

  it("the /bills read and My Day's carry the stamp through (supplierDocumentRows)", () => {
    const { rows } = supplierDocumentRows({ documents: [hillside({ waiting_credit_since: TAPPED })], bills: [], links: [], aliasRows: [] });
    expect(rows[0].waitingCreditSince).toBe(TAPPED);
    expect(supplierPaperNeeds(rows, JOBS, { today: "2026-10-01" })).toEqual([]);
    expect(supplierPapersWaitingOnCredit(rows, JOBS, { today: "2026-10-01" }).map((c) => c.invoiceId)).toEqual(["hillside"]);
  });

  it("a stamp on a paper with no supplier account never hides it: it stays a card (nowhere to fold, nothing to pair)", () => {
    const { rows } = supplierDocumentRows({
      documents: [hillside({ waiting_credit_since: TAPPED, supplier_account_id: null })],
      bills: [],
      links: [],
      aliasRows: [],
    });
    const cards = supplierPaperNeeds(rows, JOBS, { today: "2026-10-01" });
    expect(cards.map((c) => c.invoiceId)).toEqual(["hillside"]);
    expect(cards[0].accountId).toBeNull();
    expect(cards[0].waitingCredit).toBeUndefined();
    expect(supplierPapersWaitingOnCredit(rows, JOBS, { today: "2026-10-01" })).toEqual([]);
  });

  it("creditWait: no stamp is not waiting; a bare date reads as itself", () => {
    expect(creditWait({ waitingCreditSince: null }, "2026-10-01")).toBeNull();
    expect(creditWait({ waitingCreditSince: "2026-09-01" }, "2026-09-30")).toEqual({ since: "2026-09-01", back: "2026-10-01", overdue: false });
    expect(creditWait({ waitingCreditSince: "2026-09-01" }, "2026-10-01")?.overdue).toBe(true);
  });
});

describe("readSupplierDocuments: safe before 0346 is applied", () => {
  const client = (answers: any[], seen: string[]) => ({
    from: () => {
      const chain: any = {
        select: (cols: string) => (seen.push(cols), chain),
        eq: (col: string, v: unknown) => (seen.push(`${col}=${v}`), chain),
        order: () => chain,
        limit: () => Promise.resolve(answers.shift()),
      };
      return chain;
    },
  });

  it("asks for the wait stamp, org-filtered", async () => {
    const seen: string[] = [];
    const res = await readSupplierDocuments(client([{ data: [{ id: "a" }], error: null }], seen), ET);
    expect(res).toEqual({ data: [{ id: "a" }], error: null, waitReady: true });
    expect(seen[0]).toContain("waiting_credit_since");
    expect(seen).toContain(`org_id=${ET}`);
  });

  it("without the column it asks again without it: every card is where it was", async () => {
    const seen: string[] = [];
    const res = await readSupplierDocuments(
      client([{ data: null, error: { code: "42703", message: "column supplier_invoices.waiting_credit_since does not exist" } }, { data: [{ id: "a" }], error: null }], seen),
      ET,
    );
    expect(res).toEqual({ data: [{ id: "a" }], error: null, waitReady: false });
    expect(seen.filter((s) => s.startsWith("id,"))[1]).not.toContain("waiting_credit_since");
  });

  it("any other failure is a failure, never retried into a quiet empty list", async () => {
    const res = await readSupplierDocuments(client([{ data: null, error: { code: "57014", message: "timeout" } }], []), ET);
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ code: "57014", message: "timeout" });
  });
});
