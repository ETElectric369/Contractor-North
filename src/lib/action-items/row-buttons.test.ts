import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, KIND_GROUP, type ActionItem, type ActionKind } from "./types";
import { allDoors, doorVerb, rowButtons, type RowDoor } from "./row-buttons";
import { NOT_A_COST_CATEGORY, isCostableCategory, sortJobPapers } from "@/lib/job-photos";
import { TECH_DOCUMENT_CATEGORIES, documentsForViewer, isTechDocument } from "@/lib/tech-documents";
import { categoryIsShowable } from "@/lib/portal/doc-kinds";
import { dict, translator } from "@/lib/i18n";
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
  group: KIND_GROUP[kind],
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
      [row("quote_awaiting"), "Send Again"],
      [row("quote_accepted", { affordances: ["schedule", "open"], targetId: "job-1" }), "Pick a Day"],
      [row("inquiry"), "Schedule"],
      [row("appointment"), "Close Out"],
      // cn-v1175 (R7): Write It Up, boxed; it still opens the inspection (never an estimate).
      [row("inspection_writeup"), "Write It Up"],
      [row("inspection_writeup", { wonNoJob: true }), "Won · Start the Job"],
      [row("job_to_schedule"), "Pick a Day"],
      [row("materials_needed", { openToBuy: 6 }), "Buy Materials · 6 Open"],
      [row("materials_needed", { openToBuy: 1 }), "Buy Materials · 1 Open"],
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
    expect(labels(rowButtons(row("inquiry", { phone: "555-0100" }), staff).more)).toEqual(["Call", "Not Sold"]);
    expect(labels(rowButtons(row("quote_awaiting"), staff).more)).toEqual(["Won It", "Not Sold"]);
    expect(labels(rowButtons(row("quote_draft"), staff).more)).toEqual(["Not Needed"]);
    expect(labels(rowButtons(row("appointment"), staff).more)).toEqual(["Dismiss"]);
    expect(labels(rowButtons(row("visit_unbilled"), staff).more)).toEqual(["Cancel"]);
    expect(labels(rowButtons(row("invoice_draft"), staff).more)).toEqual(["Set Aside Until…"]);
    expect(labels(rowButtons(row("organize", { paper: "tray" }), staff).more)).toEqual(["Set Aside"]);
    for (const d of rowButtons(row("job_to_schedule"), staff).more.filter((x) => x.label !== "Assign")) expect(d.act.type).toBe("confirm");
  });

  it("the doors where the app can't know (2026-11-04): Already Invoiced, Not Sold on a win, Won It, Signed on Paper", () => {
    // A win with no job (the live case: nothing can settle it): its two doors behind ⋯.
    const win = row("quote_accepted", { alreadyInvoiced: { kind: "quote", id: "q1" } });
    expect(rowButtons(win, staff).primary?.label).toBe("Pick a Day");
    expect(labels(rowButtons(win, staff).more)).toEqual(["Already Invoiced", "Not Sold"]);
    expect(rowButtons(win, staff).more[1].act).toMatchObject({ title: "Not Sold After All?", button: "Mark It Not Sold" });
    expect(rowButtons(win, staff).more[0].act).toEqual({ type: "alreadyInvoiced", target: { kind: "quote", id: "q1" } });
    expect(rowButtons(win, staff).more[1].act).toMatchObject({ type: "confirm", verb: "dismiss" });
    // No answer yet: Won It, Already Invoiced, Not Sold.
    expect(labels(rowButtons(row("quote_awaiting", { alreadyInvoiced: { kind: "quote", id: "q2" } }), staff).more)).toEqual(["Won It", "Already Invoiced", "Not Sold"]);
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
    // a day written there would put it straight back on the list, so the door would be a dead end.
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

  // cn-v1172: an estimate has no follow-up day ("Closing is the reminder yes"). The row's button is the
  // Closing page's Send Again, the Send sheet; no Still Waiting and no Snooze anywhere on it.
  it("No Answer Yet: Send Again opens the Send sheet; no Still Waiting, no snooze", () => {
    const send = { kind: "quote" as const, id: "q9", number: "E-912", customerName: "Dana Rook", amount: 900, lineCount: null, openHref: "/quotes/q9" };
    expect(rowButtons(row("quote_awaiting", { send }), staff).primary).toEqual({ label: "Send Again", act: { type: "send" } });
    expect(AFFORDANCES.quote_awaiting).not.toContain("snooze");
    const all = [rowButtons(row("quote_awaiting", { send }), staff).primary, ...rowButtons(row("quote_awaiting", { send }), staff).more];
    expect(all.map((d) => d?.act.type)).not.toContain("comeBack");
  });

  // cn-v1170: a lead's doors are the Leads list's (Erik: "remove everything else except Schedule and
  // Not sold"). No Called, no Snooze. Schedule is the lead's file with its sheet open.
  it("a lead: Schedule, then Call and Not Sold behind ⋯ (Not Sold? / Mark It Not Sold, kept on file)", () => {
    const on = rowButtons(row("inquiry", { id: "lead-7", phone: "555-0100" }), staff);
    expect(on.primary).toEqual({ label: "Schedule", act: { type: "open", href: "/leads/lead-7?schedule=1" } });
    const notSold = on.more.find((d) => d.label === "Not Sold")!;
    expect(notSold.act).toMatchObject({ type: "confirm", verb: "dismiss", title: "Not Sold?", button: "Mark It Not Sold", keep: "Keep It" });
    expect((notSold.act as { body: string }).body).toContain("kept on file");
    expect(allDoors(on).map((d) => d.label)).not.toEqual(expect.arrayContaining(["Called"]));
    expect(allDoors(on).map((d) => d.label)).not.toContain("Snooze");
  });

  it("Leads off: Call Back stays the button, ⋯ Not Sold; no number, no button (the row still opens)", () => {
    const off = rowButtons(row("inquiry", { phone: "555-0100", chip: "Request" }), { leadsOn: false, isStaff: true });
    expect(off.primary).toEqual({ label: "Call Back", act: { type: "call", tel: "555-0100" } });
    expect(labels(off.more)).toEqual(["Not Sold"]);
    const bare = rowButtons(row("inquiry", { chip: "Request" }), { leadsOn: false, isStaff: true });
    expect(bare.primary).toBeNull();
    expect(labels(bare.more)).toEqual(["Not Sold"]);
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

  // THE ONE EXCEPTION (the owner, 2026-11-16, cn-v1166): a visit that isn't going ahead is Dismissed,
  // one name on every screen, and its confirm says plainly that an empty visit is deleted. Every
  // other row still says what its ending records (Lost, Not Needed, Cancel, Set Aside…).
  const visitDismiss = (item: ActionItem, d: RowDoor) =>
    d.act.type === "confirm" && item.kind === "appointment" && d.act.verb === "dismiss";
  it("the words Dismiss and Delete never appear but on a visit's Dismiss; every label is Title Case", () => {
    for (const item of every())
      for (const d of allDoors(rowButtons(item, staff))) {
        if (visitDismiss(item, d)) {
          expect(d.label).toBe("Dismiss");
        } else {
          expect(d.label).not.toMatch(/dismiss|delete/i);
          if (d.act.type === "confirm") expect(`${d.act.title} ${d.act.body} ${d.act.button}`).not.toMatch(/dismiss|delete/i);
        }
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
    // cn-v1175 (R7): the button says Write It Up, and it is still that page.
    const b = rowButtons(row("inspection_writeup", { id: "appt-9", href: "/appointments/appt-9" }), { leadsOn: true, isStaff: true });
    expect(b.primary).toEqual({ label: "Write It Up", act: { type: "open", href: "/appointments/appt-9" } });
    expect(b.more.map((d) => d.label)).toEqual(["Not Sold"]);
    // No second door, under any name, opens a page: exactly one "open" on the whole row.
    const opens = allDoors(b).filter((d) => d.act.type === "open");
    expect(opens).toHaveLength(1);
    expect(allDoors(b).map((d) => d.label)).not.toContain("Open the Visit");
    // …and the feeder really does point the row at the visit (the page the old ⋯ row named).
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const at = q.indexOf('kind: "inspection_writeup"');
    expect(q.slice(at, q.indexOf("writeUpApptIds.add", at))).toContain("href: `/appointments/${a.id}`");
  });

  it("Write It Up is the row's one button (cn-v1175, R7), and it opens the visit, never an estimate", () => {
    const item = row("inspection_writeup", { id: "appt-9", href: "/appointments/appt-9" });
    const b = rowButtons(item, staff);
    expect(b.primary).toEqual({ label: "Write It Up", act: { type: "open", href: "/appointments/appt-9" } });
  });

  it("NO DISMISS ON A SALES VISIT (cn-v1175, R8): ⋯ is Move to Another Day (while it has a day) and Not Sold", () => {
    const booked = rowButtons(row("inspection_writeup", { affordances: ["snooze", "dismiss", "open"], targetId: "14:30" }), staff);
    expect(booked.more.map((d) => d.label)).toEqual(["Move to Another Day…", "Not Sold"]);
    expect(booked.more[0].act).toMatchObject({ type: "comeBack", verb: "snooze", askWhy: false, button: "Move to Another Day" });
    const done = rowButtons(row("inspection_writeup", { affordances: ["dismiss", "open"] }), staff);
    expect(done.more.map((d) => d.label)).toEqual(["Not Sold"]);
    // The old verb is gone from the grammar (cn-v1175: no row sends it); no write-up row says Dismiss.
    expect(allDoors(done).map((d) => d.label)).not.toContain("Dismiss");
  });

  it("a WORK visit nobody closed out keeps Dismiss: the visit page's one door (cn-v1166)", () => {
    const plain = rowButtons(row("appointment"), staff).more[0];
    expect(plain.label).toBe("Dismiss");
    expect(plain.act).toMatchObject({ type: "confirm", verb: "dismiss", title: "Dismiss This Visit?", button: "Dismiss" });
    if (plain.act.type === "confirm") expect(plain.act.body).toMatch(/off the schedule\. It is deleted if nothing is on it, otherwise cancelled and kept on file\.$/);
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

/**
 * THE DOORS IN THE READER'S LANGUAGE (the Needs You redraw, cn-v1161). Every label goes through the
 * caller's translator (lib/words/needs-you, ny_btn_…); with no language handed in, the English is
 * byte for byte what the tests above pin. The confirm sheets' own titles and sentences stay English
 * for now (a later wave: they embed the row's server-built title).
 */
describe("the doors in Spanish", () => {
  const es = { leadsOn: true, isStaff: true, lang: "es", words: translator("es") };
  const esOff = { ...es, leadsOn: false };
  const every = (): ActionItem[] =>
    (Object.keys(AFFORDANCES) as ActionKind[]).flatMap((k) => [
      row(k, { phone: "555-0100", waitKey: `${k}:x`, holdReason: "Why", payee: "Bayberry Supply", openToBuy: 2, targetId: "job-1", alreadyInvoiced: { kind: "job", id: "j1" } }),
      row(k, { affordances: [...AFFORDANCES[k], "snooze", "schedule"] as ActionItem["affordances"], waitKey: `${k}:y`, chip: "Billed, Not Paid" }),
      row(k, { chip: "Clock Left Running", paper: "organize", send: { kind: "quote", id: "q1", number: "E-012", customerName: "Dana", amount: 1200, lineCount: 4, openHref: "/quotes/q1" } }),
    ]);

  it("every label is Title Case in Spanish too, read through the translator, and never a raw key", () => {
    let judged = 0;
    for (const item of every())
      for (const ctx of [es, esOff])
        for (const d of allDoors(rowButtons(item, ctx))) {
          judged++;
          expect(d.label, d.label).not.toMatch(/ny_|ld_btn|\{\w+\}/);
          expect(titleCaseIn(d.label.replace(/…/g, "").trim(), "es"), d.label).toBe(true);
          if (d.act.type === "comeBack") expect(titleCaseIn(d.act.button, "es"), d.act.button).toBe(true);
        }
    expect(judged).toBeGreaterThan(60);
  });

  it("every label differs from its English: nothing on a Spanish reader's row stays English", () => {
    for (const item of every()) {
      const eng = allDoors(rowButtons(item, staff)).map((d) => d.label);
      const spa = allDoors(rowButtons(item, es)).map((d) => d.label);
      expect(spa.length, item.kind).toBe(eng.length);
      spa.forEach((l, i) => expect(l, `${item.kind} ${eng[i]}`).not.toBe(eng[i]));
    }
  });

  it("each kind's one named button, in Spanish", () => {
    const cases: [ActionItem, string | null][] = [
      [row("supplier_pay", { payee: "Bayberry Supply" }), "Pagar a Bayberry Supply"],
      [row("supplier_pay"), "Pagar al Proveedor"],
      [row("time_stray", { chip: "Clock Left Running" }), "Corregir el Reloj"],
      [row("time_stray", { chip: "On No Job" }), "Poner en un Trabajo"],
      [row("visit_unbilled"), "Facturarlo"],
      [row("visit_unbilled", { chip: "Billed, Not Paid" }), "Cobrar"],
      [row("quote_draft"), "Enviarlo"],
      [row("invoice_draft"), "Enviarla"],
      [row("quote_awaiting"), "Enviar de Nuevo"],
      [row("inquiry"), "Agendar"],
      [row("appointment"), "Cerrar la Visita"],
      [row("inspection_writeup"), "Redactarla"],
      [row("job_to_schedule"), "Elegir un Día"],
      [row("materials_needed", { openToBuy: 6 }), "Comprar Materiales · 6 Pendientes"],
      // One is singular (the paired …One key).
      [row("materials_needed", { openToBuy: 1 }), "Comprar Materiales · 1 Pendiente"],
      [row("materials_needed"), "Comprar Materiales"],
      [row("job_unbilled_work"), "Agregar Costos"],
      [row("job_on_hold"), "Posponer"],
      [row("invoice_overdue"), "Cobrar"],
      [row("receipt_unbilled"), "Registrarlo"],
      [row("organize", { paper: "tray" }), "Clasificarlo"],
      [row("organize", { paper: "organize" }), "Archivarlo"],
      [row("stock_short"), "Ajustarlo"],
      [row("lien_deadline"), "Ver el Plazo"],
      [row("contract_unsigned"), "Ver el Contrato"],
      [row("permit_inspection", { chip: "To Book" }), "Agendarla"],
      [row("permit_inspection", { chip: "Not Written Up" }), "Registrar el Resultado"],
      [row("permit_inspection", { chip: "Failed" }), "Agendar Otra Visita"],
      [row("permit_inspection"), "Ver el Permiso"],
      [row("supplier_paper"), null],
    ];
    for (const [item, label] of cases) expect(rowButtons(item, es).primary?.label ?? null, item.kind).toBe(label);
    expect(labels(rowButtons(row("inquiry", { phone: "555-0100" }), es).more)).toEqual(["Llamar", "No Vendido"]);
    expect(rowButtons(row("inquiry", { phone: "555-0100" }), es).more[1].act).toMatchObject({ title: "¿No Vendido?", button: "Marcar como No Vendido" });
    expect(rowButtons(row("inquiry", { phone: "555-0100" }), esOff).primary?.label).toBe("Devolver la Llamada");
    // cn-v1175 (R8): no Dismiss on a sales visit; Move to Another Day and Not Sold.
    expect(labels(rowButtons(row("inspection_writeup", { affordances: ["snooze", "dismiss", "open"] }), es).more)).toEqual(["Mover a Otro Día…", "No Vendida"]);
    expect(labels(rowButtons(row("job_to_schedule"), es).more)).toEqual(["Asignar", "Terminar", "Cancelar"]);
    expect(rowButtons(row("invoice_draft"), es).more[0]).toMatchObject({ label: "Apartar hasta…", act: { type: "comeBack", button: "Apartar" } });
  });

  it("a pile's verb is its rows' word; Send It is told apart by the pile", () => {
    const pile = (name: "estimates_not_sent" | "invoices_not_sent" | "leads_to_call", verb: string, kind: ActionKind) =>
      row(kind, {
        id: `pile:${name}`,
        affordances: ["open"],
        pile: { name, label: "x", count: 2, capped: false, listHref: null, listLabel: null, verb },
        children: [row(kind, { phone: "555-0100" }), row(kind, { phone: "555-0100" })],
      });
    expect(rowButtons(pile("estimates_not_sent", "Send It", "quote_draft"), es).primary?.label).toBe("Enviarlo");
    expect(rowButtons(pile("invoices_not_sent", "Send It", "invoice_draft"), es).primary?.label).toBe("Enviarla");
    expect(rowButtons(pile("leads_to_call", "Call Back", "inquiry"), esOff).primary?.label).toBe("Devolver la Llamada");
    // English: the pile's own verb, as it always was.
    expect(rowButtons(pile("invoices_not_sent", "Send It", "invoice_draft"), staff).primary?.label).toBe("Send It");
  });

  it("the confirm sheets stay English for now (their sentences embed the server's title)", () => {
    const d = rowButtons(row("contract_unsigned", { title: "C-004" }), es).more[0];
    expect(d.label).toBe("Firmado en Papel");
    expect(d.act).toMatchObject({ type: "confirm", title: "Signed on Paper?", button: "Record It Signed", keep: "Keep It" });
  });

  it("Spanish asked for with no translator handed in reads English, never a raw key", () => {
    expect(rowButtons(row("lien_deadline"), { isStaff: true, lang: "es" }).primary?.label).toBe("See Deadline");
  });
});
