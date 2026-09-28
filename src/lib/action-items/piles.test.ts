import { describe, it, expect } from "vitest";
import { AFFORDANCES, KIND_STREAM, sortActionItems, type ActionItem, type ActionKind } from "./types";
import { ORGANIZE_PILE_MIXED, PILE_DEFS, codeCount, isTrayPaper, pileAges, pileOf, pileTitle, pileUnfoldsHere, rollUpPiles, sqlCount } from "./piles";

/**
 * SAME-KIND PILES ROLL UP (Wave 1, W1-14): two or more open rows of a pile are one row that counts 1
 * on the badge; a lone row stays a plain row; the pile sits where its most pressing child would.
 */
const TODAY = "2026-09-27";
let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  stream: KIND_STREAM[kind],
  title: `${kind} ${seq}`,
  when: null,
  urgency: 1,
  done: false,
  href: `/x/${seq}`,
  affordances: AFFORDANCES[kind],
  ...o,
});
const roll = (items: ActionItem[], o: Partial<Parameters<typeof rollUpPiles>[1]> = {}) =>
  rollUpPiles(sortActionItems(items, TODAY), { todayStr: TODAY, isStaff: true, ...o });

describe("grouping", () => {
  it("two or more of a pile are ONE row, id pile:<name>, open only, holding its children", () => {
    const a = row("quote_draft");
    const b = row("quote_draft");
    const out = roll([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("pile:estimates_not_sent");
    expect(out[0].title).toBe("Estimates Not Sent · 2");
    expect(out[0].affordances).toEqual(["open"]);
    expect(out[0].children?.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(out[0].pile).toMatchObject({ verb: "Send It", listHref: "/quotes?status=draft", listLabel: "See All On Estimates" });
  });

  it("a lone row stays a plain row: never '· 1'", () => {
    const a = row("quote_draft");
    const out = roll([a, row("inquiry")]);
    expect(out.map((i) => i.id)).toContain(a.id);
    expect(out.some((i) => /· 1\b/.test(i.title))).toBe(false);
  });

  it("finished work and No Costs Yet share Done, Not Billed; papers and notes pile apart", () => {
    const out = roll([row("visit_unbilled"), row("job_unbilled_work"), row("organize", { paper: "tray" }), row("organize", { paper: "tray" }), row("organize", { paper: "organize", chip: "Note To Review" }), row("organize", { paper: "organize", chip: "Note To Review" })]);
    const titles = out.map((i) => i.title);
    expect(titles).toContain("Done, Not Billed · 2");
    expect(titles).toContain("Papers To Sort · 2");
    expect(titles).toContain("Notes To Review · 2");
  });

  it("the Organize pile says what it holds: notes, or papers filed there too", () => {
    const mixed = roll([row("organize", { paper: "organize", chip: "Note To Review" }), row("organize", { paper: "organize", chip: "To File" })]);
    expect(mixed[0].title).toBe(`${ORGANIZE_PILE_MIXED} · 2`);
  });

  it("never piled: the supplier bills, hours on no job, each Pay By line, a bank download, a Couldn't Check line", () => {
    for (const kind of ["supplier_paper", "time_stray", "supplier_pay"] as ActionKind[]) expect(pileOf(row(kind))).toBeNull();
    expect(pileOf(row("organize", { paper: "bank" }))).toBeNull();
    expect(pileOf(row("receipt_unbilled", { id: "receipts-unread" }))).toBeNull();
    const out = roll([row("supplier_pay"), row("supplier_pay")]);
    expect(out).toHaveLength(2);
  });

  it("every kind that piles has its words, its verb and a Title Case label", () => {
    for (const d of Object.values(PILE_DEFS)) {
      expect(d.label).toMatch(/^([A-Z][\w-]*,?)( [A-Z][\w-]*,?)*$/);
      expect(d.verb).toMatch(/^[A-Z]/);
    }
  });
});

describe("the sort position", () => {
  it("a pile sits where its most pressing child sat: highest urgency, earliest when", () => {
    const lead = row("inquiry", { urgency: 2 });
    const quiet = row("quote_awaiting", { urgency: 1, when: "2026-09-20" });
    const dying = row("quote_awaiting", { urgency: 2, when: "2026-09-25" });
    const other = row("contract_unsigned");
    const out = roll([lead, quiet, dying, other]);
    // money first: the No Answer Yet pile (money) above the lead, the contract last.
    expect(out.map((i) => i.id)).toEqual(["pile:no_answer_yet", lead.id, other.id]);
    expect(out[0].urgency).toBe(2);
    expect(out[0].when).toBe("2026-09-20");
    // The first child is the most pressing one (the unfold's first row).
    expect(out[0].children?.[0].id).toBe(dying.id);
  });
});

describe("the Leads-off label", () => {
  it("Leads To Call becomes Requests To Call Back, its verb Call Back", () => {
    const on = roll([row("inquiry"), row("inquiry")]);
    expect(on[0].title).toBe("Leads To Call · 2");
    expect(on[0].pile?.verb).toBe("Called");
    const off = roll([row("inquiry"), row("inquiry")], { leadsOn: false });
    expect(off[0].title).toBe("Requests To Call Back · 2");
    expect(off[0].pile?.verb).toBe("Call Back");
  });
});

describe("real counts", () => {
  it("an exact count bigger than the rows read: the pile says it, and See All goes to the list page", () => {
    const out = roll([row("inquiry"), row("inquiry")], { counts: { leads_to_call: { total: 60 } } });
    expect(out[0].title).toBe("Leads To Call · 60");
    expect(pileUnfoldsHere(out[0].pile!, out[0].children!.length)).toBe(false);
  });

  it("a capped read that also drops rows in code says N+, and never unfolds as if that were all", () => {
    const out = roll([row("quote_draft"), row("quote_draft"), row("quote_draft")], { counts: { estimates_not_sent: { capped: true } } });
    expect(out[0].title).toBe("Estimates Not Sent · 3+");
    expect(pileUnfoldsHere(out[0].pile!, 3)).toBe(false);
    expect(pileTitle({ label: "Receipts Not On A Bill", count: 37, capped: true })).toBe("Receipts Not On A Bill · 37+");
  });

  it("the read facts: an exact count only for a SQL-only read, capped for one filtered in code", () => {
    expect(sqlCount({ data: [1, 2], count: 2 })).toEqual({});
    expect(sqlCount({ data: [1, 2], count: 9 })).toEqual({ total: 9 });
    expect(codeCount({ data: [1, 2], count: 2 })).toEqual({});
    expect(codeCount({ data: [1, 2], count: 9 })).toEqual({ capped: true });
    expect(codeCount({ data: [1, 2] }, 2)).toEqual({ capped: true });
    expect(codeCount({ data: [1] }, 2)).toEqual({});
  });

  it("a lone row whose feeder counts its own rule stays a plain row: never '· 1' and never '· 1+'", () => {
    // The feeders that read a wide set (every accepted estimate, all open A/R, every sent estimate)
    // count their row's own rule now (due-filters.ts), so one late invoice among 51 open ones, or one
    // new win among 180 accepted estimates, hands rollUpPiles no cap.
    for (const [kind, pile] of [["quote_accepted", "won_needs_a_day"], ["invoice_overdue", "late_invoices"], ["quote_awaiting", "no_answer_yet"]] as const) {
      const lone = row(kind);
      const out = roll([lone, row("contract_unsigned")], { counts: { [pile]: {} } });
      expect(out.map((i) => i.id), kind).toContain(lone.id);
      expect(out.some((i) => /· 1\b/.test(i.title) || /· 1\+/.test(i.title)), kind).toBe(false);
    }
  });

  it("Done, Not Billed read whole (0371): 'N+' only when the function counted more rows than it handed back", async () => {
    const { doneRowsCount } = await import("./done-not-billed");
    const done = (n: number, total: number) =>
      Array.from({ length: n }, (_, i) => ({
        src: "visit" as const,
        id: `a${i}`,
        job_id: null,
        title: null,
        job_number: null,
        job_name: null,
        customer_name: null,
        at: `2026-07-0${i + 1}T17:00:00Z`,
        open_invoice_id: null,
        total_count: total,
      }));
    expect(doneRowsCount(done(3, 3))).toEqual({});
    expect(doneRowsCount(done(3, 240))).toEqual({ capped: true });
    expect(doneRowsCount([])).toEqual({});
    const rows = (n: number) => Array.from({ length: n }, () => row("visit_unbilled"));
    expect(roll(rows(3), { counts: { done_not_billed: doneRowsCount(done(3, 3)) } })[0].title).toBe("Done, Not Billed · 3");
    expect(roll(rows(3), { counts: { done_not_billed: doneRowsCount(done(3, 240)) } })[0].title).toBe("Done, Not Billed · 3+");
  });

  it("Done, Not Billed and Visits To Close Out have no list page holding their rows: a capped one unfolds every row read here", () => {
    expect(PILE_DEFS.done_not_billed.listHref).toBeNull();
    expect(PILE_DEFS.visits_to_close_out.listHref).toBeNull();
    const out = roll([row("visit_unbilled"), row("visit_unbilled"), row("job_unbilled_work")], { counts: { done_not_billed: { capped: true } } });
    expect(out[0].title).toBe("Done, Not Billed · 3+");
    expect(out[0].pile?.listHref).toBeNull();
    // Never a page that doesn't list them (/billing has no finished visits; /schedule is a calendar).
    expect(out[0].href).toBe(out[0].children![0].href);
  });

  it("See All names the page the way its menu does and lands on the rows: Invoices, and the receipt files on Bills", () => {
    // /billing is titled Invoices (W1-29): no pile names a Billing page.
    expect(PILE_DEFS.late_invoices.listLabel).toBe("See All On Invoices");
    expect(PILE_DEFS.invoices_not_sent.listLabel).toBe("See All On Invoices");
    expect(Object.values(PILE_DEFS).some((d) => /Billing/.test(d.listLabel ?? ""))).toBe(false);
    // All Bills opens with the receipt files first on ?tab=receipts (bills-receipts.tsx, W1-32).
    expect(PILE_DEFS.receipts_not_on_a_bill.listHref).toBe("/bills?tab=receipts#all-bills");
  });

  it("money across the pile is staff only, and never on a capped pile (a short sum)", () => {
    const money = [row("invoice_draft", { amount: 1000 }), row("invoice_draft", { amount: 1340 })];
    expect(roll(money)[0].subtitle).toBe("$2,340.00 across 2");
    expect(roll(money, { isStaff: false })[0].subtitle).toBeNull();
    expect(roll(money, { counts: { invoices_not_sent: { capped: true } } })[0].subtitle).toBeNull();
  });
});

describe("the pips", () => {
  it("one per child up to nine, then +; amber past a week, aged from the server's today", () => {
    const kids = Array.from({ length: 11 }, (_, i) => ({ since: i < 3 ? "2026-09-01" : "2026-09-25", when: null }));
    const { pips, more } = pileAges(kids, TODAY);
    expect(pips).toHaveLength(9);
    expect(more).toBe(true);
    expect(pips.slice(0, 3)).toEqual(["old", "old", "old"]);
    expect(pips[3]).toBe("new");
  });
});

describe("which papers sort in the /bills tray", () => {
  it("a receipt, anything dropped on Bills, a cost paper, or a paper nothing has read yet", () => {
    expect(isTrayPaper({ kind: "receipt" })).toBe(true);
    expect(isTrayPaper({ kind: "job_document", source: "bills_drop" })).toBe(true);
    expect(isTrayPaper({ kind: "job_document", doc_type: "bill" })).toBe(true);
    expect(isTrayPaper({ kind: "job_document", file_url: "org/organize/x.jpg" })).toBe(true);
  });

  it("a note, and a paper read as not a cost, file in Organize", () => {
    expect(isTrayPaper({ kind: "note", file_url: null })).toBe(false);
    expect(isTrayPaper({ kind: "job_document", doc_type: "not_a_cost", file_url: "org/organize/plan.pdf" })).toBe(false);
    expect(isTrayPaper({ kind: "job_document", file_url: "org/organize/x.jpg", summary: "A panel label" })).toBe(false);
  });
});
