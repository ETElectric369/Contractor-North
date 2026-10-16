import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNDO_PUNCH_MS, UNDO_PUNCH_SENTENCE } from "@/lib/long-shift";

/** THE 2026-10-15 ROUND (field-feedback-1015-round): the pins that keep each fix where it is. */
const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("the Time tab badge counts the shifts not yet billed", () => {
  it("is the one rule the Overview's figure uses, never a second count; nothing read = no badge", () => {
    const page = read("src/app/(app)/jobs/[id]/page.tsx");
    expect(page).toContain("count: timeOpen,");
    expect(page).toContain("const timeOpen = unbilled?.schemaReady ? unbilled.shifts : 0;");
    expect(read("src/lib/unbilled-work.ts")).toContain("const shifts = lines.reduce((n, l) => n + (l.quantity > 0 ? l.sourceIds.length : 0), 0);");
    expect(page).not.toContain("No badge: the number of shifts on a job is a total");
    expect(read("src/lib/unbilled-work.ts")).toMatch(/return \{\s*hours,\s*shifts,/);
  });
});

describe("a punch taken back", () => {
  it("is two minutes, by hand only, and every door says the one sentence and asks nothing after it", () => {
    expect(UNDO_PUNCH_MS).toBe(120_000);
    expect(UNDO_PUNCH_SENTENCE).toBe("That punch is gone — it was under two minutes old, so nothing was recorded and nothing is paid.");
    const door = read("src/app/(app)/timeclock/actions.ts");
    // By hand only, and only a punch nobody put work on (a Switch Job's second part, a note, miles, a lunch are a day).
    expect(door).toContain('const untouched = !ent?.split_from && !(ent?.notes ?? "").trim() && !input.miles && !(input.notes ?? "").trim() && !input.lunch_minutes && !input.lunch_on_entry_id;');
    expect(door).toContain('if (ent?.status === "open" && entClockIn && untouched && !input.auto && !input.at && !input.picked && !input.autoClosedReason) {');
    expect(door).toContain("if (Number.isFinite(ciMs) && age >= 0 && age < UNDO_PUNCH_MS) {");
    // ON THE SERVICE CLIENT (the only DELETE policy on time_entries is the office's): scoped by hand,
    // still under two minutes by the database's clock, rows read back; an error falls through to the close.
    expect(door).toMatch(/await createServiceClient\(\)\s*\.from\("time_entries"\)\s*\.delete\(\)\s*\.eq\("id", input\.entry_id\)\s*\.eq\("profile_id", user\.id\)\s*\.eq\("status", "open"\)\s*\.gt\("clock_in", new Date\(Date\.now\(\) - UNDO_PUNCH_MS\)\.toISOString\(\)\)\s*\.select\("id"\)/);
    expect(door).toContain('reportError("timeclock.clockOut.undo", undoErr, { entryId: input.entry_id });');
    expect(door).toContain("return { ok: true, id: input.entry_id, undone: true, warning: UNDO_PUNCH_SENTENCE };");
    // The three screens and Nort's door.
    expect(read("src/app/(app)/timeclock/timeclock-panel.tsx")).toMatch(/if \(res\.undone\) \{\s*toast\(res\.warning \?\? "That punch is gone\.", "success"\);\s*return;/);
    expect(read("src/app/(app)/planner/now-card.tsx")).toContain('else if (res.undone) {\n          toast(res.warning ?? "That punch is gone.", "success");');
    expect(read("src/app/(app)/jobs/[id]/job-time-button.tsx")).toContain('if (res.undone) toast(res.warning ?? "That punch is gone.", "success");');
    expect(read("src/lib/actions/entities/time.ts")).toContain("if ((res as { undone?: boolean }).undone) return { ...res, recorded:");
  });
});
