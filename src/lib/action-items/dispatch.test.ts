import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, KIND_STREAM, type ActionItem, type ActionKind, type Affordance } from "./types";
import { allDoors, doorVerb, rowButtons } from "./row-buttons";
import { recordId, resolveRowVerb } from "./dispatch-map";
import { REGISTRY } from "@/lib/actions/registry";

/**
 * EVERY ROW VERB MAPS (Wave 1, W1-15). dispatchAction's one caller is ActionList (there is no
 * act_on_item anywhere in the code), so this walks the WHOLE row table (row-buttons.ts): every
 * (kind, verb) any row can send resolves to a real registry action, with a real record id (never a
 * prefixed row id, which would write zero rows and report success). Retired verbs and kinds go
 * together: nothing here sends job_needs_return, a lead's Schedule, or inquiry.delete.
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
/** A row as the build makes it: its id shaped the way its feeder writes it. */
const built = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => {
  const ids: Partial<Record<ActionKind, string>> = {
    visit_unbilled: "unbilled-appt-1",
    quote_draft: "qdraft-quote-1",
    job_on_hold: "onhold-job-1",
    job_unbilled_work: "nocosts-job-1",
    materials_needed: "materials-job-1",
  };
  return row(kind, { id: ids[kind] ?? `${kind}-rec-1`, ...o });
};
const PAYLOAD = { date: "2026-10-03", assignee: "person-1", reason: "Waiting on the permit" };

describe("every (kind, verb) the row table can send maps to a registry action", () => {
  const rows: ActionItem[] = (Object.keys(AFFORDANCES) as ActionKind[]).flatMap((k) => [
    built(k, { phone: "555-0100", holdReason: null, targetId: "job-9", openToBuy: 3, payee: "Metro Supply" }),
    built(k, { affordances: [...new Set([...AFFORDANCES[k], "snooze", "schedule"])] as Affordance[], waitKey: `${k}:job-1`, targetId: "job-9" }),
  ]);
  const sent: [ActionKind, Affordance, string][] = [];
  for (const item of rows)
    for (const ctx of [
      { leadsOn: true, isStaff: true },
      { leadsOn: false, isStaff: true },
    ])
      for (const d of allDoors(rowButtons(item, ctx))) {
        const v = doorVerb(d);
        if (v) sent.push([item.kind, v, item.id]);
      }

  it("walks a real table (every verbed door of every kind)", () => {
    const pairs = new Set(sent.map(([k, v]) => `${k}:${v}`));
    for (const want of [
      "inquiry:do",
      "inquiry:snooze",
      "inquiry:dismiss",
      "appointment:do",
      "appointment:dismiss",
      "inspection_writeup:dismiss",
      "organize:dismiss",
      "quote_awaiting:snooze",
      "quote_awaiting:dismiss",
      "quote_accepted:schedule",
      "invoice_draft:snooze",
      "visit_unbilled:dismiss",
      "quote_draft:dismiss",
      "job_to_schedule:schedule",
      "job_to_schedule:assign",
      "job_to_schedule:do",
      "job_to_schedule:dismiss",
      "job_on_hold:snooze",
      "job_on_hold:do",
      "job_unbilled_work:snooze",
      "materials_needed:snooze",
    ])
      expect(pairs, want).toContain(want);
  });

  it("each one resolves, to an action the registry has, never with a prefixed id", () => {
    for (const [kind, verb, id] of sent) {
      const item = rows.find((r) => r.id === id && r.kind === kind)!;
      const m = resolveRowVerb(kind, verb, id, PAYLOAD, item.targetId);
      expect(m, `${kind} ${verb}`).not.toBeNull();
      expect(REGISTRY[m!.name], `${kind} ${verb} → ${m!.name}`).toBeDefined();
      expect(REGISTRY[m!.name].effect).toBe("write");
      expect(String(m!.input.id), `${kind} ${verb}`).not.toMatch(/^(unbilled|jdone|qdraft|onhold|nocosts|materials)-/);
      // The registry's own schema takes what the map hands it.
      expect(REGISTRY[m!.name].input.safeParse(m!.input).success, `${kind} ${verb} → ${m!.name} ${JSON.stringify(m!.input)}`).toBe(true);
    }
  });
});

describe("the mappings that matter", () => {
  const map = (kind: ActionKind, verb: Affordance, id: string, target?: string) => resolveRowVerb(kind, verb, id, PAYLOAD, target ?? null);

  it("a snooze never writes contacted; the lead's ending writes lost, never a deletion", () => {
    expect(map("inquiry", "snooze", "lead-1")).toEqual({ name: "inquiry.snooze", input: { id: "lead-1", date: "2026-10-03" } });
    expect(map("inquiry", "dismiss", "lead-1")).toEqual({ name: "inquiry.markLost", input: { id: "lead-1" } });
    const dispatch = readFileSync(join(process.cwd(), "src/lib/action-items/dispatch-map.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(dispatch).not.toContain("inquiry.delete");
    expect(dispatch).not.toContain('"convert"');
    expect(dispatch).not.toContain("job_needs_return");
  });

  it("job.snoozeHold and invoice.setAside resolve (with the reason when one is given)", () => {
    expect(map("job_on_hold", "snooze", "onhold-job-1")).toEqual({ name: "job.snoozeHold", input: { id: "job-1", date: "2026-10-03", reason: "Waiting on the permit" } });
    expect(map("job_on_hold", "do", "onhold-job-1")).toEqual({ name: "job.takeOffHold", input: { id: "job-1" } });
    expect(map("invoice_draft", "snooze", "inv-1")).toEqual({ name: "invoice.setAside", input: { id: "inv-1", date: "2026-10-03", reason: "Waiting on the permit" } });
    expect(resolveRowVerb("invoice_draft", "snooze", "inv-1", { date: "2026-10-03" })).toEqual({ name: "invoice.setAside", input: { id: "inv-1", date: "2026-10-03" } });
    for (const n of ["job.snoozeHold", "job.takeOffHold", "invoice.setAside", "job.snoozeNeedsYou"]) expect(REGISTRY[n], n).toBeDefined();
  });

  it("Still Waiting sets the follow-up day only; the endless rows keep their day in needs_you_waits", () => {
    expect(map("quote_awaiting", "snooze", "q-1")).toEqual({ name: "quote.followUp", input: { id: "q-1", date: "2026-10-03" } });
    expect(map("materials_needed", "snooze", "materials-job-1")).toMatchObject({ name: "job.snoozeNeedsYou", input: { id: "job-1", kind: "materials_needed", date: "2026-10-03" } });
    expect(map("job_unbilled_work", "snooze", "nocosts-job-1")).toMatchObject({ name: "job.snoozeNeedsYou", input: { id: "job-1", kind: "job_unbilled_work" } });
  });

  it("derived rows write their REAL record: a visit, a job, an estimate", () => {
    expect(map("visit_unbilled", "dismiss", "unbilled-appt-1")).toEqual({ name: "appointment.setStatus", input: { id: "appt-1", status: "cancelled" } });
    expect(map("visit_unbilled", "dismiss", "jdone-job-1")).toEqual({ name: "job.setStatus", input: { id: "job-1", status: "cancelled" } });
    expect(map("quote_draft", "dismiss", "qdraft-quote-1")).toEqual({ name: "quote.setStatus", input: { id: "quote-1", status: "declined" } });
    // A row id that doesn't carry its prefix maps to nothing (never a guess at the record).
    expect(map("visit_unbilled", "dismiss", "appt-1")).toBeNull();
    expect(recordId("qdraft-", "qdraft-")).toBeNull();
  });

  it("a won estimate's day goes on its job; with no job, there is no day to set here", () => {
    expect(map("quote_accepted", "schedule", "quote-1", "job-9")).toEqual({ name: "job.scheduleDay", input: { id: "job-9", date: "2026-10-03" } });
    expect(map("quote_accepted", "schedule", "quote-1")).toBeNull();
  });

  it("Finish and Cancel on a job needing a day are the job's own endings", () => {
    expect(map("job_to_schedule", "do", "job-1")).toEqual({ name: "job.finish", input: { id: "job-1" } });
    expect(map("job_to_schedule", "dismiss", "job-1")).toEqual({ name: "job.setStatus", input: { id: "job-1", status: "cancelled" } });
  });

  it("an open-only kind sends nothing", () => {
    for (const kind of ["invoice_overdue", "lien_deadline", "contract_unsigned", "time_stray", "stock_short", "supplier_paper", "supplier_pay", "receipt_unbilled"] as ActionKind[])
      for (const verb of ["do", "dismiss", "assign"] as Affordance[]) expect(map(kind, verb, "x"), `${kind} ${verb}`).toBeNull();
  });
});

describe("dispatchAction, the thin shim", () => {
  it("runs the mapped action from the ui and says what the action said it did", async () => {
    const executeAction = vi.fn(async () => ({ ok: true, speak: "Drafted INV-081 from the job's record." }));
    vi.doMock("@/lib/actions/execute", () => ({ executeAction }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    const { dispatchAction } = await import("./dispatch");
    expect(await dispatchAction({ kind: "job_to_schedule", id: "job-1", verb: "do" })).toEqual({ ok: true, error: undefined, note: "Drafted INV-081 from the job's record." });
    expect(executeAction).toHaveBeenLastCalledWith("job.finish", { id: "job-1" }, { source: "ui" });
    // A day-less snooze or schedule is refused before anything runs; so is the crew-wiping assign.
    expect(await dispatchAction({ kind: "job_on_hold", id: "onhold-job-1", verb: "snooze" })).toEqual({ ok: false, error: "Pick a date." });
    expect(await dispatchAction({ kind: "job_to_schedule", id: "job-1", verb: "assign", payload: { assignee: "" } })).toEqual({ ok: false, error: "Pick a person." });
    vi.doUnmock("@/lib/actions/execute");
    vi.doUnmock("next/cache");
  });
});
