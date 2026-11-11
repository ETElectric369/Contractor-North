import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, KIND_STREAM, type ActionItem, type ActionKind } from "./types";
import { allDoors, doorVerb, rowButtons, type RowDoor } from "./row-buttons";
import { NOT_A_COST_CATEGORY, isCostableCategory, sortJobPapers } from "@/lib/job-photos";
import { TECH_DOCUMENT_CATEGORIES, documentsForViewer, isTechDocument } from "@/lib/tech-documents";
import { categoryIsShowable } from "@/lib/portal/doc-kinds";
import { dict } from "@/lib/i18n";
import { titleCaseIn } from "../../../tests/title-case-words";

/**
 * ONE NAMED BUTTON PER ROW, AND ⋯ (Wave 1, W1-13): the row table. Each row says its verb; ⋯ holds
 * only what is real for that row; the honest endings sit behind a confirm; Dismiss and Delete are
 * never said; a tech's visit only opens; no door sends a verb its row can't take.
 */
let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  stream: KIND_STREAM[kind],
  title: `Row ${seq}`,
  when: null,
  urgency: 1,
  done: false,
  href: `/x/${seq}`,
  affordances: AFFORDANCES[kind],
  ...o,
});
const staff = { leadsOn: true, isStaff: true };
const labels = (ds: (RowDoor | null)[]) => ds.filter(Boolean).map((d) => d!.label);

describe("the table", () => {
  it("each kind's one named button", () => {
    const cases: [ActionItem, string | null][] = [
      [row("supplier_pay", { payee: "Metro Supply" }), "Pay Metro Supply"],
      [row("time_stray", { chip: "On No Job" }), "Put on a Job"],
      [row("time_stray", { chip: "Clock Left Running" }), "Fix the Clock"],
      [row("visit_unbilled"), "Bill It"],
      [row("visit_unbilled", { chip: "Billed, Not Paid" }), "Get Paid"],
      [row("quote_draft", { send: { kind: "quote", id: "q1", number: "E-012", customerName: "Dana", amount: 1200, lineCount: 4, openHref: "/quotes/q1" } }), "Send It"],
      [row("quote_awaiting"), "Still Waiting"],
      [row("quote_accepted", { affordances: ["schedule", "open"], targetId: "job-1" }), "Pick a Day"],
      [row("inquiry"), "Called"],
      [row("appointment"), "Close Out"],
      [row("inspection_writeup"), "Open the Inspection"],
      [row("job_to_schedule"), "Pick a Day"],
      [row("materials_needed", { openToBuy: 6 }), "Buy Materials · 6 Open"],
      [row("job_unbilled_work"), "Add Costs"],
      [row("job_on_hold"), "Snooze"],
      [row("invoice_overdue"), "Get Paid"],
      [row("invoice_draft"), "Send It"],
      [row("receipt_unbilled"), "Record It"],
      [row("organize", { paper: "tray" }), "Sort It"],
      [row("organize", { paper: "organize" }), "File It"],
      [row("stock_short"), "Settle It"],
      [row("lien_deadline"), "See Deadline"],
      [row("contract_unsigned"), "See Contract"],
      [row("supplier_paper"), null],
    ];
    for (const [item, label] of cases) expect(rowButtons(item, staff).primary?.label ?? null, item.kind).toBe(label);
  });

  it("a hold whose day has come shows Snooze and Take Off Hold, both on the row; Snooze asks why only when none is saved", () => {
    const saved = rowButtons(row("job_on_hold", { holdReason: "Waiting on the permit" }), staff);
    expect(labels([saved.primary, saved.also])).toEqual(["Snooze", "Take Off Hold"]);
    expect(saved.primary?.act).toMatchObject({ type: "comeBack", verb: "snooze", askWhy: false });
    expect(saved.also?.act).toEqual({ type: "run", verb: "do" });
    expect(rowButtons(row("job_on_hold", { holdReason: null }), staff).primary?.act).toMatchObject({ askWhy: true });
    // Before 0366 (no day's column): no Snooze; Take Off Hold still works.
    const old = rowButtons(row("job_on_hold", { affordances: ["do", "open"] }), staff);
    expect(labels([old.primary, old.also])).toEqual(["Take Off Hold"]);
  });

  it("behind ⋯: Snooze, Assign, and the honest endings behind a confirm", () => {
    expect(labels(rowButtons(row("job_to_schedule"), staff).more)).toEqual(["Assign", "Finish", "Cancel"]);
    expect(labels(rowButtons(row("inquiry", { phone: "555-0100" }), staff).more)).toEqual(["Call", "Snooze", "Lost"]);
    expect(labels(rowButtons(row("quote_awaiting"), staff).more)).toEqual(["Won It", "Lost"]);
    expect(labels(rowButtons(row("quote_draft"), staff).more)).toEqual(["Not Needed"]);
    expect(labels(rowButtons(row("appointment"), staff).more)).toEqual(["Didn't Happen"]);
    expect(labels(rowButtons(row("visit_unbilled"), staff).more)).toEqual(["Cancel"]);
    expect(labels(rowButtons(row("invoice_draft"), staff).more)).toEqual(["Set Aside Until…"]);
    expect(labels(rowButtons(row("organize", { paper: "tray" }), staff).more)).toEqual(["Set Aside"]);
    for (const d of rowButtons(row("job_to_schedule"), staff).more.filter((x) => x.label !== "Assign")) expect(d.act.type).toBe("confirm");
  });

  it("the doors where the app can't know (2026-11-04): Already Invoiced, Lost on a win, Won It, Signed on Paper", () => {
    // A win with no job (the live case: nothing can settle it): its two doors behind ⋯.
    const win = row("quote_accepted", { alreadyInvoiced: { kind: "quote", id: "q1" } });
    expect(rowButtons(win, staff).primary?.label).toBe("Pick a Day");
    expect(labels(rowButtons(win, staff).more)).toEqual(["Already Invoiced", "Lost"]);
    expect(rowButtons(win, staff).more[0].act).toEqual({ type: "alreadyInvoiced", target: { kind: "quote", id: "q1" } });
    expect(rowButtons(win, staff).more[1].act).toMatchObject({ type: "confirm", verb: "dismiss" });
    // No answer yet: Won It, Already Invoiced, Lost.
    expect(labels(rowButtons(row("quote_awaiting", { alreadyInvoiced: { kind: "quote", id: "q2" } }), staff).more)).toEqual(["Won It", "Already Invoiced", "Lost"]);
    expect(rowButtons(row("quote_awaiting"), staff).more[0].act).toMatchObject({ type: "confirm", verb: "do" });
    // Done, Not Billed: Already Invoiced beside Cancel; a technician never sees it.
    const done = row("visit_unbilled", { alreadyInvoiced: { kind: "job", id: "j1" } });
    expect(labels(rowButtons(done, staff).more)).toEqual(["Already Invoiced", "Cancel"]);
    expect(labels(rowButtons(done, { leadsOn: true, isStaff: false }).more)).toEqual(["Cancel"]);
    // An unsigned contract: Signed on Paper behind a confirm.
    const c = rowButtons(row("contract_unsigned"), staff);
    expect(labels(c.more)).toEqual(["Signed on Paper"]);
    expect(c.more[0].act).toMatchObject({ type: "confirm", verb: "do" });
  });

  it("a draft whose job is finished ('Honeysuckle · J-011 Finished · Send INV-078') has no Set Aside Until…: it waits on nothing", () => {
    // The build leaves snooze off a draft whose job is complete or cancelled (draftInvoiceState):
    // a day written there would put it straight back on top, so the door would be a dead end.
    const finished = rowButtons(row("invoice_draft", { title: "Honeysuckle · J-011 Finished · Send INV-078", affordances: AFFORDANCES.invoice_draft.filter((v) => v !== "snooze") }), staff);
    expect(finished.primary?.label).toBe("Send It");
    expect(labels(finished.more)).toEqual([]);
    expect(allDoors(rowButtons(row("invoice_draft", { affordances: ["open"] }), staff)).map((d) => d.label)).not.toContain("Set Aside Until…");
  });

  it("an endless row gets a Snooze only when its wait can be kept (0367): the build sets its key", () => {
    expect(rowButtons(row("materials_needed"), staff).more).toEqual([]);
    const snoozable = rowButtons(row("materials_needed", { waitKey: "materials_needed:j1", affordances: ["snooze", "open"] }), staff);
    expect(labels(snoozable.more)).toEqual(["Snooze"]);
    expect(snoozable.more[0].act).toMatchObject({ type: "comeBack", verb: "snooze", askWhy: true });
    expect(labels(rowButtons(row("job_unbilled_work", { waitKey: "job_unbilled_work:j1", affordances: ["snooze", "open"] }), staff).more)).toEqual(["Snooze"]);
  });

  it("Still Waiting picks a day and asks no why; before 0366 it isn't drawn", () => {
    expect(rowButtons(row("quote_awaiting"), staff).primary?.act).toEqual({ type: "comeBack", verb: "snooze", askWhy: false, button: "Still Waiting" });
    expect(rowButtons(row("quote_awaiting", { affordances: ["dismiss", "open"] }), staff).primary).toBeNull();
  });

  it("Leads off: Call Back stays the button, ⋯ Called and Lost; no number, Called", () => {
    const off = rowButtons(row("inquiry", { phone: "555-0100", chip: "Request" }), { leadsOn: false, isStaff: true });
    expect(off.primary).toEqual({ label: "Call Back", act: { type: "call", tel: "555-0100" } });
    expect(labels(off.more)).toEqual(["Called", "Lost"]);
    expect(rowButtons(row("inquiry", { chip: "Request" }), { leadsOn: false, isStaff: true }).primary?.label).toBe("Called");
  });

  it("a pile carries its pile's verb, which only opens it", () => {
    const pile = row("quote_draft", {
      id: "pile:estimates_not_sent",
      affordances: ["open"],
      pile: { name: "estimates_not_sent", label: "Estimates Not Sent", count: 6, capped: false, listHref: "/quotes?status=draft", listLabel: "See All on Estimates", verb: "Send It" },
      children: [row("quote_draft"), row("quote_draft")],
    });
    const b = rowButtons(pile, staff);
    expect(b.primary).toEqual({ label: "Send It", act: { type: "unfold" } });
    expect(b.more).toEqual([]);
    expect(allDoors(b).map(doorVerb).filter(Boolean)).toEqual([]);
  });

  it("a tech's pile of his own visits has no verb: his visits only open", () => {
    const visit = () => row("appointment", { affordances: ["open"] });
    const pile = row("appointment", {
      id: "pile:visits_to_close_out",
      affordances: ["open"],
      pile: { name: "visits_to_close_out", label: "Visits to Close Out", count: 2, capped: false, listHref: null, listLabel: null, verb: "Close Out" },
      children: [visit(), visit()],
    });
    expect(rowButtons(pile, { leadsOn: true, isStaff: false })).toEqual({ primary: null, also: null, more: [] });
  });
});

describe("the laws", () => {
  const every = (): ActionItem[] =>
    (Object.keys(AFFORDANCES) as ActionKind[]).flatMap((k) => [
      row(k, { phone: "555-0100", waitKey: `${k}:x`, holdReason: "Why", payee: "Metro Supply", openToBuy: 2, targetId: "job-1" }),
      row(k, { affordances: [...AFFORDANCES[k], "snooze", "schedule"] as ActionItem["affordances"], waitKey: `${k}:y` }),
    ]);

  it("no door sends a verb its row can't take", () => {
    for (const item of every())
      for (const ctx of [staff, { leadsOn: false, isStaff: true }])
        for (const d of allDoors(rowButtons(item, ctx))) {
          const v = doorVerb(d);
          if (v) expect(item.affordances, `${item.kind} ${d.label}`).toContain(v);
        }
  });

  it("the words Dismiss and Delete never appear; every label is Title Case", () => {
    for (const item of every())
      for (const d of allDoors(rowButtons(item, staff))) {
        expect(d.label).not.toMatch(/dismiss|delete/i);
        if (d.act.type === "confirm") expect(`${d.act.title} ${d.act.body} ${d.act.button}`).not.toMatch(/dismiss|delete/i);
        expect(d.label, d.label).toMatch(/^[A-Z0-9]/);
        expect(titleCaseIn(d.label.replace(/…/g, "").trim(), "en"), d.label).toBe(true);
      }
  });

  it("a tech's visit has no button: it only opens", () => {
    const b = rowButtons(row("appointment", { affordances: ["open"] }), { leadsOn: true, isStaff: false });
    expect(b).toEqual({ primary: null, also: null, more: [] });
  });

  it("Pay <Supplier> is the office's: a tech is never handed a money door", () => {
    expect(rowButtons(row("supplier_pay", { payee: "Metro Supply" }), { leadsOn: true, isStaff: false }).primary).toBeNull();
  });

  it("a Couldn't Check line only opens", () => {
    expect(rowButtons(row("receipt_unbilled", { id: "receipts-unread" }), staff)).toEqual({ primary: null, also: null, more: [] });
  });
});


describe("an inspection to write up can be OPENED, not only written up or called lost (cn-v1071)", () => {
  it("ONE door opens it (zero duplicate doors): the button goes to the visit's own page, where the attach door marks it won; ⋯ holds the endings only", () => {
    // cn-v1071 put "Open the Visit" under ⋯ when every door on this row led to a NEW estimate. Since
    // cn-v1157 the row's one button is that same page (the feeder's href is /appointments/<id>), so
    // the ⋯ row was the same door twice under a second name (skeptic #60): it is gone.
    const b = rowButtons(row("inspection_writeup", { id: "appt-9", href: "/appointments/appt-9" }), { leadsOn: true, isStaff: true });
    expect(b.primary).toEqual({ label: "Open the Inspection", act: { type: "open", href: "/appointments/appt-9" } });
    expect(b.more.map((d) => d.label)).toEqual(["Lost"]);
    // No second door, under any name, opens a page: exactly one "open" on the whole row.
    const opens = allDoors(b).filter((d) => d.act.type === "open");
    expect(opens).toHaveLength(1);
    expect(allDoors(b).map((d) => d.label)).not.toContain("Open the Visit");
    // …and the feeder really does point the row at the visit (the page the old ⋯ row named).
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const at = q.indexOf('kind: "inspection_writeup"');
    expect(q.slice(at, q.indexOf("writeUpApptIds.add", at))).toContain("href: `/appointments/${a.id}`");
  });

  it("Write It Up is gone from the row; the primary button goes to the row's own href (the visit)", () => {
    const item = row("inspection_writeup", { id: "appt-9", href: "/appointments/appt-9" });
    const b = rowButtons(item, staff);
    expect(b.primary).toEqual({ label: "Open the Inspection", act: { type: "open", href: "/appointments/appt-9" } });
    expect(allDoors(b).map((d) => d.label)).not.toContain("Write It Up");
  });

  it("⋯ gains Didn't Happen only when the row carries the wontHappen verb (a visit not yet completed)", () => {
    const withIt = rowButtons(row("inspection_writeup", { affordances: ["dismiss", "wontHappen", "open"] }), staff);
    expect(withIt.more.map((d) => d.label)).toEqual(["Didn't Happen", "Lost"]);
    const door = withIt.more.find((d) => d.label === "Didn't Happen")!;
    expect(door.act).toMatchObject({ type: "confirm", verb: "wontHappen" });
    const without = rowButtons(row("inspection_writeup", { affordances: ["dismiss", "open"] }), staff);
    expect(without.more.map((d) => d.label)).not.toContain("Didn't Happen");
  });
});

/**
 * A RECEIPT THAT NEVER WAS A COST (the owner, 2026-11-10: "it's a quote from my supplier not a bill,
 * everything is closed"). The row had one door, Record It, which leads to adding a cost nobody paid.
 * Its ⋯ now holds Not a Cost: the same two words a tray paper's type uses, behind the list's own
 * confirm, on this kind of row only.
 */
describe("a receipt row's Not a Cost", () => {
  const receipt = (o: Partial<ActionItem> = {}) =>
    row("receipt_unbilled", { id: "receipt-doc-1", title: "Receipt · Jun 18", subtitle: "Larkspur · J-014", href: "/jobs/job-1?tab=costs", ...o });

  it("Record It stays the row's one button; ⋯ holds Not a Cost and nothing else", () => {
    const b = rowButtons(receipt(), staff);
    expect(b.primary).toEqual({ label: "Record It", act: { type: "open", href: "/jobs/job-1?tab=costs" } });
    expect(b.also).toBeNull();
    expect(labels(b.more)).toEqual(["Not a Cost"]);
    expect(AFFORDANCES.receipt_unbilled).toEqual(["notACost", "open"]);
  });

  it("it asks first, with the list's own confirm, and says what it does and the way back", () => {
    const door = rowButtons(receipt(), staff).more[0];
    expect(door.act).toEqual({
      type: "confirm",
      verb: "notACost",
      title: "Not a Cost?",
      body: "Files Receipt · Jun 18 as Not a Cost, so it stops asking to be recorded. It stays with the job's papers for the office, and the crew does not see it. No cost is recorded or removed. To change it back, use the pencil under Receipts & Papers on the job's Costs tab.",
      button: "Not a Cost",
      keep: "Keep It",
    });
    expect(doorVerb(door)).toBe("notACost");
    const said = door.act.type === "confirm" ? `${door.act.title} ${door.act.body} ${door.act.button}` : "";
    expect(said).not.toMatch(/delet|dismiss|shelf/i);
    // It never says the crew sees the paper, and never names Other: that was the door's first draft,
    // which would have handed a supplier's prices to the crew.
    expect(said).not.toMatch(/\bOther\b|shows to the crew/);
    // A bill photo reads by its own title.
    const bill = rowButtons(receipt({ title: "Bill from Sam · Sep 27" }), staff).more[0];
    expect(bill.act).toMatchObject({ body: expect.stringMatching(/^Files Bill from Sam · Sep 27 as Not a Cost, so it stops asking to be recorded\./) });
  });

  it("the words are true in code: Not a Cost is its own category, the office's alone as the Receipt was, and the pencil is the way back", () => {
    expect(NOT_A_COST_CATEGORY).toBe("Not a Cost");
    // "so it stops asking to be recorded": not costable, so no Record as Cost and no row.
    expect(isCostableCategory(NOT_A_COST_CATEGORY)).toBe(false);
    // "the crew does not see it": the crew's list names what it lets through, and this is not on it.
    expect(isTechDocument({ category: NOT_A_COST_CATEGORY })).toBe(false);
    expect(TECH_DOCUMENT_CATEGORIES as readonly string[]).not.toContain(NOT_A_COST_CATEGORY);
    const paper = { id: "doc-1", name: "IMG_0412.jpg", file_url: "org/job-1/IMG_0412.jpg" };
    const crewIsHanded = (category: string) => documentsForViewer([{ ...paper, category }], false).map((d) => d.id);
    expect(crewIsHanded("Receipt")).toEqual([]);
    expect(crewIsHanded(NOT_A_COST_CATEGORY)).toEqual([]);
    // "Other" is what the crew IS handed, which is why the door never files a paper under it.
    expect(crewIsHanded("Other")).toEqual(["doc-1"]);
    // Nor the customer: the page's allow-list, and the database's twin of it (0326), leave it out.
    expect(categoryIsShowable(NOT_A_COST_CATEGORY)).toBe(false);
    const shown = readFileSync(join(process.cwd(), "supabase/migrations/0326_the_customer_sees_the_latest_drawing.sql"), "utf8");
    expect(shown).toContain("select coalesce(p_category in ('Photo', 'Plan', 'Permit', 'Other'), false)");
    // "stays with the job's papers for the office": for the office it is on neither Photos list, so it
    // stays on the Costs tab's own, where "the pencil under Receipts & Papers" re-files it.
    const office = sortJobPapers([{ ...paper, category: NOT_A_COST_CATEGORY }], [], []);
    expect([...office.photos, ...office.pictures]).toEqual([]);
    expect(office.loose).toEqual([]);
    const list = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-documents.tsx"), "utf8");
    expect(list).toContain('const CATEGORIES = ["Receipt", "Bill", "Invoice", NOT_A_COST_CATEGORY, "Photo", "Plan", "Permit", "Other"];');
    expect(list).toContain('title={t("jb_renameRecategorize")}');
    expect(dict("en").jb_receiptsPapers).toBe("Receipts & Papers");
    expect(dict("en").jb_tabCosts).toBe("Costs");
    // File a Paper (Not a Cost)'s Other Paper is a person choosing Other on purpose: left as it was.
    expect(readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-cost-capture.tsx"), "utf8")).toContain('{ category: "Other", label: "Other Paper" }');
  });

  it("only where the row carries the verb: the Couldn't Check line, and a row built without it, have no ⋯", () => {
    expect(rowButtons(receipt({ affordances: ["open"] }), staff)).toEqual({ primary: { label: "Record It", act: { type: "open", href: "/jobs/job-1?tab=costs" } }, also: null, more: [] });
    expect(rowButtons(receipt({ id: "receipts-unread", affordances: ["open"] }), staff)).toEqual({ primary: null, also: null, more: [] });
    expect(rowButtons(receipt({ id: "receipts-unread" }), staff)).toEqual({ primary: null, also: null, more: [] });
  });

  it("the office's door: a tech is never handed one that only refuses", () => {
    expect(rowButtons(receipt(), { leadsOn: true, isStaff: false }).more).toEqual([]);
  });

  it("on receipt rows only: no other kind draws it, even handed the verb", () => {
    for (const k of (Object.keys(AFFORDANCES) as ActionKind[]).filter((x) => x !== "receipt_unbilled")) {
      const handed = row(k, { affordances: [...AFFORDANCES[k], "notACost"], phone: "555-0100", waitKey: `${k}:x`, payee: "Metro Supply", targetId: "job-1" });
      for (const ctx of [staff, { leadsOn: false, isStaff: true }]) {
        const doors = allDoors(rowButtons(handed, ctx));
        expect(doors.map((d) => d.label), k).not.toContain("Not a Cost");
        expect(doors.map(doorVerb), k).not.toContain("notACost");
      }
    }
  });

  it("a pile of receipts keeps its one verb, which only opens it: Not a Cost is each row's own", () => {
    const pile = row("receipt_unbilled", {
      id: "pile:receipts_not_on_a_bill",
      affordances: ["open"],
      pile: { name: "receipts_not_on_a_bill", label: "Receipts Not on a Bill", count: 2, capped: false, listHref: "/bills?tab=receipts#all-bills", listLabel: "See All on Bills", verb: "Record It" },
      children: [receipt(), receipt({ id: "receipt-doc-2" })],
    });
    expect(rowButtons(pile, staff)).toEqual({ primary: { label: "Record It", act: { type: "unfold" } }, also: null, more: [] });
    expect(labels(rowButtons(pile.children![1], staff).more)).toEqual(["Not a Cost"]);
  });
});
