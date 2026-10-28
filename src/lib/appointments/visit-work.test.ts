import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb } from "@/test/fake-supabase";

/**
 * THE ONE VISIT READ (cn-v1134): what a visit typed — its tasks (each with its minutes and parts,
 * through the kits a task picked) and its typed take-off — for every door that hands it to a job.
 * A failed read is SAID in the asking door's words and the rest still comes back; nothing is thrown.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}), errorMessage: (e: unknown) => String(e) }));
import { reportError } from "@/lib/observe";
import { visitWork } from "./visit-work";

type Row = Record<string, any>;
const PB = { needs: [{ key: "tasks", label: "Tasks", ask: "Tasks?", slot: { type: "tasks" } }] };
const ANSWERS = {
  tasks: [
    { id: "t1", name: "Set the sub panel", hours: 3, units: null, kit_id: null, materials: [{ code: "SP100", words: "100A sub panel", qty: 1 }] },
    { id: "t2", name: "Run the feeder", hours: 2.5, units: null, kit_id: null, materials: [{ code: null, words: "feeder wire", qty: null }] },
    { id: "t3", name: "Label the panel", hours: null, units: null, kit_id: null, materials: [] },
  ],
};
const CAPTURE = {
  items: [
    { id: "c-1", description: "12-2 NM-B", quantity: 200, unit: "ft" },
    { id: "c-2", description: "4-inch boxes", quantity: null, unit: "ea", code: "BX4" },
  ],
};
const tables = (): Record<string, Row[]> => ({
  appointments: [{ id: "a1", capture: CAPTURE }],
  appointment_answers: [{ id: "a1", inspection_answers: ANSWERS, inspection_template_id: "form-1" }],
  form_playbooks: [{ id: "form-1", schema: null, playbook: PB }],
  kits: [],
});

type Refusal = { table: string; /** only a read whose select names this; every read of the table otherwise */ select?: string; error: { code?: string; message: string } };
/** The fake's client with some reads answering an error instead (a refused view, a failed table). */
function refusing(sb: any, rules: Refusal[]) {
  return {
    ...sb,
    from(t: string) {
      const mine = rules.filter((r) => r.table === t);
      const real = sb.from(t);
      if (!mine.length) return real;
      let sel = "";
      const wrap: any = new Proxy(real, {
        get(target, k) {
          if (k === "then") {
            const hit = mine.find((r) => !r.select || sel.includes(r.select));
            if (hit) return (res: (v: unknown) => void) => Promise.resolve({ data: null, error: hit.error }).then(res);
            return target.then;
          }
          const v = target[k];
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (k === "select") sel = String(args[0] ?? "");
            const out = v.apply(target, args);
            return out === target ? wrap : out;
          };
        },
      });
      return wrap;
    },
  };
}

const TASKS_FAILED = "The job was made; the tasks typed on the visit could not be read. Add them on the job.";
const CAPTURE_FAILED = "The job was made; the materials typed on the visit could not be read. Add them on the Materials tab.";

describe("visitWork", () => {
  beforeEach(() => vi.mocked(reportError).mockClear());

  it("the happy path: the tasks keyed task:<id> with their own minutes, their parts keyed to them behind the typed take-off, no notes", async () => {
    const { sb } = fakeDb(tables());
    const w = await visitWork(sb, "a1");
    expect(w.notes).toEqual([]);
    expect(w.birth.tasks.map((t) => [t.source_key, t.title, t.planned_minutes])).toEqual([
      ["task:t1", "Set the sub panel", 180],
      ["task:t2", "Run the feeder", 150],
      ["task:t3", "Label the panel", null],
    ]);
    expect(w.birth.parts.map((p) => [p.source_key, p.code, p.name, p.qty])).toEqual([
      ["task:t1", "SP100", "100A sub panel", 1],
      ["task:t2", null, "feeder wire", null],
    ]);
    // The typed rows first (as typed, keyed by the list writer), then the tasks' parts (keyed here).
    expect(w.typedItems.map((i) => [i.id, i.description, i.quantity, i.code ?? null, i.source_key ?? null])).toEqual([
      ["c-1", "12-2 NM-B", 200, null, null],
      ["c-2", "4-inch boxes", null, "BX4", null],
      ["task:t1:0", "100A sub panel", 1, "SP100", expect.stringMatching(/^task:t1#/)],
      ["task:t2:1", "feeder wire", null, null, expect.stringMatching(/^task:t2#/)],
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a refused answers read is said, and the typed take-off still comes back", async () => {
    const { sb } = fakeDb(tables());
    const w = await visitWork(refusing(sb, [{ table: "appointment_answers", error: { code: "42501", message: "refused" } }]), "a1");
    expect(w.notes).toEqual([TASKS_FAILED]);
    expect(w.birth.tasks).toEqual([]);
    expect(w.typedItems.map((i) => i.id)).toEqual(["c-1", "c-2"]);
    expect(reportError).toHaveBeenCalledWith("visit-work:tasks", expect.anything(), { appointmentId: "a1", door: "job" });
  });

  it("a refused sheet read is said the same way", async () => {
    const { sb } = fakeDb(tables());
    const w = await visitWork(refusing(sb, [{ table: "form_playbooks", error: { code: "42501", message: "refused" } }]), "a1");
    expect(w.notes).toEqual([TASKS_FAILED]);
    expect(w.birth.tasks).toEqual([]);
    expect(w.typedItems).toHaveLength(2);
  });

  it("a failed kits read (every rung refused) is said in the page's own kit words; the tasks still carry his hours", async () => {
    const t = tables();
    t.appointment_answers[0].inspection_answers = { tasks: [{ id: "t1", name: "Footings", hours: 3, units: 7, kit_id: "k1", materials: [] }] };
    const w = await visitWork(refusing(fakeDb(t).sb, [{ table: "kits", error: { code: "42501", message: "refused" } }]), "a1");
    expect(w.notes).toEqual([
      "The job was made, sized from the hours typed. The kits could not be read — a task's kit picker is off until you reload; its own hours stand. Check the job's tasks.",
    ]);
    expect(w.birth.tasks.map((x) => [x.source_key, x.planned_minutes])).toEqual([["task:t1", 180]]);
    expect(reportError).toHaveBeenCalledWith("visit-work:kits", expect.anything(), { appointmentId: "a1", door: "job" });
  });

  it("a failed capture read is said, and the tasks still come back", async () => {
    const { sb } = fakeDb(tables());
    const w = await visitWork(refusing(sb, [{ table: "appointments", select: "capture", error: { code: "42501", message: "refused" } }]), "a1");
    expect(w.notes).toEqual([CAPTURE_FAILED]);
    expect(w.birth.tasks).toHaveLength(3);
    expect(w.typedItems.map((i) => i.id)).toEqual(["task:t1:0", "task:t2:1"]);
    expect(reportError).toHaveBeenCalledWith("visit-work:capture", expect.anything(), { appointmentId: "a1", door: "job" });
  });

  it("the link door says it in its own words", async () => {
    const { sb } = fakeDb(tables());
    const tasks = await visitWork(refusing(sb, [{ table: "appointment_answers", error: { message: "refused" } }]), "a1", "link");
    expect(tasks.notes).toEqual(["The visit is linked; its tasks could not be read. Add them on the job."]);
    const capture = await visitWork(refusing(sb, [{ table: "appointments", select: "capture", error: { message: "refused" } }]), "a1", "link");
    expect(capture.notes).toEqual(["The visit is linked; its materials could not be read. Add them on the Materials tab."]);
    const t = tables();
    t.appointment_answers[0].inspection_answers = { tasks: [{ id: "t1", name: "Footings", hours: 3, units: 7, kit_id: "k1", materials: [] }] };
    const kits = await visitWork(refusing(fakeDb(t).sb, [{ table: "kits", error: { message: "refused" } }]), "a1", "link");
    expect(kits.notes).toEqual(["The visit is linked. The kits could not be read — a task's kit picker is off until you reload; its own hours stand. Check the job's tasks."]);
    expect(reportError).toHaveBeenLastCalledWith("visit-work:kits", expect.anything(), { appointmentId: "a1", door: "link" });
  });

  it("a view not on this database yet falls back to the table (0366's rule); a pre-0165 table is simply no tasks, not a note", async () => {
    const t = tables();
    t.appointments[0] = { ...t.appointments[0], inspection_answers: ANSWERS, inspection_template_id: "form-1" };
    const { sb } = fakeDb(t);
    const viaTable = await visitWork(refusing(sb, [{ table: "appointment_answers", error: { code: "PGRST205", message: "no such view" } }]), "a1");
    expect(viaTable.notes).toEqual([]);
    expect(viaTable.birth.tasks).toHaveLength(3);
    const pre0165 = await visitWork(
      refusing(sb, [
        { table: "appointment_answers", error: { code: "PGRST205", message: "no such view" } },
        { table: "appointments", select: "inspection_answers", error: { code: "42703", message: "column does not exist" } },
      ]),
      "a1",
    );
    expect(pre0165.notes).toEqual([]);
    expect(pre0165.birth.tasks).toEqual([]);
    expect(pre0165.typedItems.map((i) => i.id)).toEqual(["c-1", "c-2"]);
  });

  it("no sheet, or nothing typed, is nothing — not a note", async () => {
    const t = tables();
    t.appointment_answers = [];
    t.appointments[0].capture = null;
    const w = await visitWork(fakeDb(t).sb, "a1");
    expect(w).toEqual({ birth: { tasks: [], plannedMinutes: null, parts: [] }, typedItems: [], notes: [] });
  });
});
