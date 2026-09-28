import { describe, it, expect } from "vitest";
import { AFFORDANCES, KIND_STREAM, type ActionItem, type ActionKind } from "./types";
import { allDoors, doorVerb, rowButtons, type RowDoor } from "./row-buttons";

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
      [row("time_stray", { chip: "On No Job" }), "Put On A Job"],
      [row("time_stray", { chip: "Clock Left Running" }), "Fix The Clock"],
      [row("visit_unbilled"), "Bill It"],
      [row("visit_unbilled", { chip: "Billed, Not Paid" }), "Get Paid"],
      [row("quote_draft", { send: { kind: "quote", id: "q1", number: "E-012", customerName: "Dana", amount: 1200, lineCount: 4, openHref: "/quotes/q1" } }), "Send It"],
      [row("quote_awaiting"), "Still Waiting"],
      [row("quote_accepted", { affordances: ["schedule", "open"], targetId: "job-1" }), "Pick A Day"],
      [row("inquiry"), "Called"],
      [row("appointment"), "Close Out"],
      [row("inspection_writeup"), "Write It Up"],
      [row("job_to_schedule"), "Pick A Day"],
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
    expect(labels(rowButtons(row("quote_awaiting"), staff).more)).toEqual(["Lost"]);
    expect(labels(rowButtons(row("quote_draft"), staff).more)).toEqual(["Not Needed"]);
    expect(labels(rowButtons(row("appointment"), staff).more)).toEqual(["Didn't Happen"]);
    expect(labels(rowButtons(row("visit_unbilled"), staff).more)).toEqual(["Cancel"]);
    expect(labels(rowButtons(row("invoice_draft"), staff).more)).toEqual(["Set Aside Until…"]);
    expect(labels(rowButtons(row("organize", { paper: "tray" }), staff).more)).toEqual(["Set Aside"]);
    for (const d of rowButtons(row("job_to_schedule"), staff).more.filter((x) => x.label !== "Assign")) expect(d.act.type).toBe("confirm");
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
      pile: { name: "estimates_not_sent", label: "Estimates Not Sent", count: 6, capped: false, listHref: "/quotes?status=draft", listLabel: "See All On Estimates", verb: "Send It" },
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
      pile: { name: "visits_to_close_out", label: "Visits To Close Out", count: 2, capped: false, listHref: "/schedule", listLabel: "See All On Schedule", verb: "Close Out" },
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
        for (const w of d.label.replace(/…/g, "").split(/[\s·]+/).filter(Boolean)) expect(w, d.label).toMatch(/^[A-Z0-9$]/);
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
