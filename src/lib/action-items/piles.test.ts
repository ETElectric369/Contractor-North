import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, KIND_GROUP, sortActionItems, type ActionItem, type ActionKind } from "./types";
import { ORGANIZE_PILE_MIXED, PILE_DEFS, codeCount, isTrayPaper, pileOf, pileTitle, pileUnfoldsHere, rollUpPiles, sqlCount } from "./piles";
import { titleCaseIn } from "../../../tests/title-case-words";

/**
 * SAME-KIND PILES ROLL UP (Wave 1, W1-14): two or more open rows of a pile are one row that counts 1
 * on the badge; a lone row stays a plain row; the pile sits by its mark, its tile, then its oldest
 * child's own day (cn-v1162).
 */
const TODAY = "2026-09-27";
let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  group: KIND_GROUP[kind],
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
    expect(out[0].pile).toMatchObject({ verb: "Send It", listHref: "/quotes?status=draft", listLabel: "See All on Estimates" });
  });

  it("a lone row stays a plain row: never '· 1'", () => {
    const a = row("quote_draft");
    const out = roll([a, row("inquiry")]);
    expect(out.map((i) => i.id)).toContain(a.id);
    expect(out.some((i) => /· 1\b/.test(i.title))).toBe(false);
  });

  it("finished work and No Costs Yet share Done, Not Billed; papers and notes pile apart", () => {
    const out = roll([row("visit_unbilled"), row("job_unbilled_work"), row("organize", { paper: "tray" }), row("organize", { paper: "tray" }), row("organize", { paper: "organize", chip: "Note to Review" }), row("organize", { paper: "organize", chip: "Note to Review" })]);
    const titles = out.map((i) => i.title);
    expect(titles).toContain("Done, Not Billed · 2");
    expect(titles).toContain("Papers to Sort · 2");
    expect(titles).toContain("Notes to Review · 2");
  });

  it("the Organize pile says what it holds: notes, or papers filed there too", () => {
    const mixed = roll([row("organize", { paper: "organize", chip: "Note to Review" }), row("organize", { paper: "organize", chip: "To File" })]);
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
      expect(titleCaseIn(d.label, "en"), d.label).toBe(true);
      expect(d.verb).toMatch(/^[A-Z]/);
    }
  });
});

describe("the sort position", () => {
  it("a pile sits by its mark, its tile, then its oldest child's own day", () => {
    const lead = row("inquiry", { urgency: 2, when: "2026-09-01" });
    const quiet = row("quote_awaiting", { urgency: 1, level: "soon", when: "2026-09-20" });
    const dying = row("quote_awaiting", { urgency: 2, level: "soon", when: "2026-09-05" });
    const books = row("organize");
    const paid = row("invoice_draft");
    const out = roll([lead, quiet, dying, books, paid]);
    // Get Paid first; in Sales the SOON pile above the plain lead; Bookkeeping last.
    expect(out.map((i) => i.id)).toEqual([paid.id, "pile:no_answer_yet", lead.id, books.id]);
    expect(out[1].urgency).toBe(2);
    expect(out[1].level).toBe("soon");
    expect(out[1].when).toBe("2026-09-05");
    // The first child is the first in the one order (the unfold's first row): Due, then oldest.
    expect(out[1].children?.[0].id).toBe(dying.id);
  });

  it("a pile carries its oldest child's own day (since ?? when) as its since, and sits by it (cn-v1162)", () => {
    // Two holds with no day (their last touch is their since) and a job needing a day between them.
    const holdNew = row("job_on_hold", { since: "2026-09-20" });
    const needDay = row("job_to_schedule", { since: "2026-09-01" });
    const holdOld = row("job_on_hold", { since: "2026-08-01" });
    const out = roll([holdNew, needDay, holdOld]);
    expect(out.map((i) => i.id)).toEqual(["pile:holds_back", needDay.id]);
    expect(out[0].since).toBe("2026-08-01");
    expect(out[0].when).toBeNull();
    expect(out[0].children?.map((c) => c.id)).toEqual([holdOld.id, holdNew.id]);
    // A child with only a `when` counts by it; a pile whose children have no day carries none.
    const dated = roll([row("quote_draft", { when: "2026-09-10" }), row("quote_draft", { since: "2026-09-15" })]);
    expect(dated[0].since).toBe("2026-09-10");
    const undated = roll([row("organize"), row("organize")]);
    expect(undated[0].since).toBeUndefined();
  });
});

describe("a pile never hides a NOW row", () => {
  it("NOW children roll into pile:<name>:now; the rest keep pile:<name>", () => {
    const late = [row("invoice_overdue", { level: "now", when: "2026-07-01" }), row("invoice_overdue", { level: "now", when: "2026-07-10" })];
    const recent = [row("invoice_overdue", { level: "soon", when: "2026-09-10" }), row("invoice_overdue", { level: "soon", when: "2026-09-12" })];
    const out = roll([...recent, ...late]);
    expect(out.map((i) => i.id)).toEqual(["pile:late_invoices:now", "pile:late_invoices"]);
    expect(out[0].children?.map((c) => c.id)).toEqual(late.map((c) => c.id));
    expect(out[0].level).toBe("now");
    expect(out[0].pile?.name).toBe("late_invoices");
    expect(out[0].title).toBe("Late Invoices · 2");
    expect(out[1].children?.map((c) => c.id)).toEqual(recent.map((c) => c.id));
    expect(out[1].level).toBe("soon");
    expect(out.every((p) => p.group === "get_paid")).toBe(true);
  });

  it("a lone NOW row stays a plain row, and so does a lone row left behind", () => {
    const now = row("invoice_overdue", { level: "now" });
    const soon = row("invoice_overdue", { level: "soon" });
    const out = roll([soon, now]);
    expect(out.map((i) => i.id)).toEqual([now.id, soon.id]);
    expect(out.some((i) => i.pile)).toBe(false);
  });

  it("a capped read caps both halves", () => {
    const out = roll([row("invoice_overdue", { level: "now" }), row("invoice_overdue")], { counts: { late_invoices: { capped: true } } });
    expect(out.map((i) => i.id)).toEqual(["pile:late_invoices:now", "pile:late_invoices"]);
    expect(out.every((p) => p.pile?.capped && /\+$/.test(p.title))).toBe(true);
  });

  it("an exact count is the half that is not NOW", () => {
    const out = roll([row("inquiry"), row("inquiry"), row("inquiry", { level: "now" }), row("inquiry", { level: "now" })], { counts: { leads_to_call: { total: 9 } } });
    expect(out.find((p) => p.id === "pile:leads_to_call:now")?.pile?.count).toBe(2);
    expect(out.find((p) => p.id === "pile:leads_to_call")?.pile?.count).toBe(9);
  });

  it("a pile wears its most urgent child's mark: SOON if any child is, none if none is", () => {
    // Holds: a hold back on its day is Due (a quote_draft can no longer be: it has no clock).
    const mixed = roll([row("job_on_hold"), row("job_on_hold", { level: "soon" }), row("job_on_hold")]);
    expect(mixed[0].level).toBe("soon");
    const plain = roll([row("quote_draft"), row("quote_draft")]);
    expect(plain[0].level).toBe("none");
  });

  it("no pile with an exact SQL count holds a kind that can be NOW", async () => {
    const { NOW_KINDS } = await import("./needs-you-rule");
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const exact = [...query.matchAll(/counts\.(\w+) = [^;\n]*sqlCount\(/g)].map((m) => m[1]);
    expect(exact.length).toBeGreaterThan(0);
    for (const name of exact) {
      for (const kind of NOW_KINDS) expect(pileOf(row(kind)), `${name} holds ${kind}`).not.toBe(name);
    }
  });
});

describe("the Leads-off label", () => {
  it("Leads to Call becomes Requests to Call Back, its verb Call Back", () => {
    const on = roll([row("inquiry"), row("inquiry")]);
    expect(on[0].title).toBe("Leads to Call · 2");
    expect(on[0].pile?.verb).toBe("Called");
    const off = roll([row("inquiry"), row("inquiry")], { leadsOn: false });
    expect(off[0].title).toBe("Requests to Call Back · 2");
    expect(off[0].pile?.verb).toBe("Call Back");
  });
});

describe("real counts", () => {
  it("an exact count bigger than the rows read: the pile says it, and See All goes to the list page", () => {
    const out = roll([row("inquiry"), row("inquiry")], { counts: { leads_to_call: { total: 60 } } });
    expect(out[0].title).toBe("Leads to Call · 60");
    expect(pileUnfoldsHere(out[0].pile!, out[0].children!.length)).toBe(false);
  });

  it("a capped read that also drops rows in code says N+, and never unfolds as if that were all", () => {
    const out = roll([row("quote_draft"), row("quote_draft"), row("quote_draft")], { counts: { estimates_not_sent: { capped: true } } });
    expect(out[0].title).toBe("Estimates Not Sent · 3+");
    expect(pileUnfoldsHere(out[0].pile!, 3)).toBe(false);
    expect(pileTitle({ label: "Receipts Not on a Bill", count: 37, capped: true })).toBe("Receipts Not on a Bill · 37+");
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

  it("Done, Not Billed and Visits to Close Out have no list page holding their rows: a capped one unfolds every row read here", () => {
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
    expect(PILE_DEFS.late_invoices.listLabel).toBe("See All on Invoices");
    expect(PILE_DEFS.invoices_not_sent.listLabel).toBe("See All on Invoices");
    expect(Object.values(PILE_DEFS).some((d) => /Billing/.test(d.listLabel ?? ""))).toBe(false);
    // All Bills opens with the receipt files first on ?tab=receipts (bills-receipts.tsx, W1-32).
    expect(PILE_DEFS.receipts_not_on_a_bill.listHref).toBe("/bills?tab=receipts#all-bills");
  });

  it("a pile carries no '$X across N' subtitle: its sum is its amount, drawn once at its right edge (cn-v1161)", () => {
    const money = [row("invoice_draft", { amount: 1000 }), row("invoice_draft", { amount: 1340 })];
    expect(roll(money)[0].subtitle).toBeNull();
    expect(roll(money)[0].amount).toBe(2340);
    expect(roll(money, { isStaff: false })[0].subtitle).toBeNull();
    expect(roll(money, { counts: { invoices_not_sent: { capped: true } } })[0].subtitle).toBeNull();
  });

  it("a pile's amount is its children's sum: staff only, never capped, never short a child", () => {
    const money = [row("invoice_draft", { amount: 1000 }), row("invoice_draft", { amount: 1340 })];
    expect(roll(money)[0].amount).toBe(2340);
    expect(roll(money, { isStaff: false })[0].amount).toBeNull();
    expect(roll(money, { counts: { invoices_not_sent: { capped: true } } })[0].amount).toBeNull();
    expect(roll(money, { counts: { invoices_not_sent: { total: 3 } } })[0].amount).toBeNull();
    expect(roll([row("invoice_draft", { amount: 1000 }), row("invoice_draft")])[0].amount).toBeNull();
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
