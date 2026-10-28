import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNDO_PUNCH_MS, UNDO_PUNCH_SENTENCE } from "@/lib/long-shift";
import { dict } from "@/lib/i18n";

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
    // The clock's own sealed line (what a clock-in took off hold, carried-1123) is not a note a person wrote.
    expect(door).toContain('const untouched = !ent?.split_from && !withoutHeldCrumb(ent?.notes) && !input.miles && !withoutHeldCrumb(input.notes) && !input.lunch_minutes && !input.lunch_on_entry_id;');
    expect(door).toContain('if (ent?.status === "open" && entClockIn && untouched && !input.auto && !input.at && !input.picked && !input.autoClosedReason) {');
    expect(door).toContain("if (Number.isFinite(ciMs) && age >= 0 && age < UNDO_PUNCH_MS) {");
    // ON THE SERVICE CLIENT (the only DELETE policy on time_entries is the office's): scoped by hand,
    // still under two minutes by the database's clock, rows read back; an error falls through to the close.
    expect(door).toMatch(/await createServiceClient\(\)\s*\.from\("time_entries"\)\s*\.delete\(\)\s*\.eq\("id", input\.entry_id\)\s*\.eq\("profile_id", user\.id\)\s*\.eq\("status", "open"\)\s*\.gt\("clock_in", new Date\(Date\.now\(\) - UNDO_PUNCH_MS\)\.toISOString\(\)\)\s*\.select\("id"\)/);
    expect(door).toContain('reportError("timeclock.clockOut.undo", undoErr, { entryId: input.entry_id });');
    // cn-v1138: the sentence in the caller's language (undoPunchSentence("en") is UNDO_PUNCH_SENTENCE).
    expect(door).toContain("return { ok: true, id: input.entry_id, undone: true, warning: undoPunchSentence(lang) };");
    // The three screens and Nort's door.
    // The panel's words come through the catalog (cn-v1138): the key says the sentence.
    expect(read("src/app/(app)/timeclock/timeclock-panel.tsx")).toMatch(/if \(res\.undone\) \{\s*toast\(res\.warning \?\? t\("tc_punchGone"\), "success"\);\s*return;/);
    expect(dict("en").tc_punchGone).toBe("That punch is gone.");
    // My Day's card says the sentence in the person's language since cn-v1138 (md_punchGone is "That punch is gone." in English).
    expect(read("src/app/(app)/planner/now-card.tsx")).toContain('else if (res.undone) {\n          toast(res.warning ?? t("md_punchGone"), "success");');
    expect(read("src/app/(app)/jobs/[id]/job-time-button.tsx")).toContain('if (res.undone) toast(res.warning ?? t("jb_punchGone"), "success");');
    expect(dict("en").jb_punchGone).toBe("That punch is gone.");
    expect(read("src/lib/actions/entities/time.ts")).toContain("if ((res as { undone?: boolean }).undone) return { ...res, recorded:");
  });
});
