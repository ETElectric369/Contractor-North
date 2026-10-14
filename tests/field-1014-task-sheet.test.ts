/**
 * THE TASK SHEET (field feedback 10-13, item 2b). Erik: "in the task itself is where we will be
 * needing photos, measurements, materials and labor and Lidar … pop up what we need when we need
 * it" and "i couldnt jump to what i needed when i needed it". The lib half: a task carries a note;
 * a measurement and a photo may be PLACED on a task (task_id) while the capture keeps its one
 * list of each; the Inspector page opens a task from `?task=`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { coerceTask, coerceTasks, taskLine } from "@/lib/playbook/tasks";
import { mergeCaptureSections, parseInspectorCapture } from "@/lib/inspection/capture";

const read = (p: string) => readFileSync(p, "utf8");

describe("a task carries its note", () => {
  it("kept when present, absent when empty, capped, read into the task's line for the estimator", () => {
    const t = coerceTask({ id: "t1", name: "Footings", hours: 2, units: 7, kit_id: null, materials: [], note: "  stucco wall,  core drill " })!;
    expect(t.note).toBe("stucco wall,  core drill");
    expect(coerceTask({ id: "t2", name: "Rail", hours: null, units: null, kit_id: null, materials: [], note: "   " })).not.toHaveProperty("note");
    expect(coerceTask({ id: "t3", name: "Rail", hours: null, units: null, kit_id: null, materials: [] })).not.toHaveProperty("note");
    expect(coerceTask({ id: "t4", name: "Rail", hours: 1, units: null, kit_id: null, materials: [], note: "x".repeat(5000) })!.note!.length).toBe(2000);
    expect(taskLine(t)).toBe("Footings — 2 h for ×7 · note: stucco wall, core drill");
    expect(taskLine({ ...t, note: null })).toBe("Footings — 2 h for ×7");
    expect(coerceTasks([t])![0].note).toBe("stucco wall,  core drill");
  });
});

describe("a measurement and a photo may be placed on a task; the lists stay one list", () => {
  it("task_id survives the parse on both, is dropped when blank or absurd, and rides a section merge", () => {
    const c = parseInspectorCapture({
      notes: "", measurements: "", materials: "",
      photos: ["org/a.jpg", "org/b.jpg", "org/c.pdf"],
      measures: [
        { id: "m1", label: "Run", value: 40, unit: "ft", task_id: "t1" },
        { id: "m2", label: "Drop", value: 8, unit: "ft" },
        { id: "m3", label: "Blank", value: 1, unit: "ft", task_id: "   " },
        { id: "m4", label: "Long", value: 1, unit: "ft", task_id: "x".repeat(200) },
      ],
      photo_meta: { "org/a.jpg": { task_id: "t1" }, "org/b.jpg": { caption: "panel", task_id: "" }, "org/gone.jpg": { task_id: "t1" }, "org/c.pdf": { about: "Plans", task_id: "t2" } },
    });
    expect(c.measures!.map((m) => m.task_id ?? null)).toEqual(["t1", null, null, "x".repeat(80)]);
    expect(c.photo_meta).toEqual({ "org/a.jpg": { task_id: "t1" }, "org/b.jpg": { caption: "panel" }, "org/c.pdf": { about: "Plans", task_id: "t2" } });
    // placement for a photo that is not on the list is noise that outlives its subject
    expect(c.photo_meta).not.toHaveProperty("org/gone.jpg");
    const merged = mergeCaptureSections(c, { photo_meta: { ...c.photo_meta, "org/b.jpg": { caption: "panel", task_id: "t1" } } });
    expect(merged.photo_meta!["org/b.jpg"]).toEqual({ caption: "panel", task_id: "t1" });
    expect(merged.measures![0].task_id).toBe("t1");
  });
  it("the page opens a task from ?task= — an id, never a sentence", () => {
    const page = read("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain('const openTask = typeof sp.task === "string" && /^[\\w-]{1,80}$/.test(sp.task) ? sp.task : null;');
    expect(page).toContain("initialOpenTaskId={openTask}");
  });
});
