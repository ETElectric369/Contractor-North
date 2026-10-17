import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERMIT_PICKABLE_STATUSES, PERMIT_STATUSES, permitStatusLabel, permitStatusOptions } from "@/lib/permit-options";
import { PERMIT_STATUSES_OPEN_TO_VISITS, authorityWithoutRow, passedOnDay } from "@/lib/permit-inspections";

/**
 * PERMITS ON THE PHONE + ONE DOOR FOR AN INSPECTION'S RESULT (Erik, 2026-10-15, from J-012).
 * "the permits page on the phone is all crammed onto the left side lined up vertically, unreadable";
 * "I marked the permit inspection as passed, and it didn't save and didn't carry through to the
 * second inspection" — he had set the PERMIT's status (which offered Passed and carried nothing
 * forward); its Town of Truckee visit was not a row, only the TTPUD one was.
 */
const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const card = read("src/app/(app)/jobs/[id]/job-permits.tsx");
const rows = read("src/app/(app)/jobs/[id]/permit-inspections.tsx");

describe("what a person may pick on a permit", () => {
  it("is the paperwork only: what the inspections say is read, never picked", () => {
    expect(PERMIT_PICKABLE_STATUSES.map(([v]) => v)).toEqual(["not_submitted", "applied", "issued", "closed"]);
    // The words stay for reading a permit written before this.
    for (const v of ["inspection_scheduled", "passed", "failed"]) expect(PERMIT_STATUSES.some(([k]) => k === v)).toBe(true);
  });
  it("a select never reads blank: a status the rows wrote is shown, disabled", () => {
    expect(permitStatusOptions("applied").map((o) => o.value)).toEqual(["not_submitted", "applied", "issued", "closed"]);
    const derived = permitStatusOptions("inspection_scheduled");
    expect(derived[0]).toEqual({ value: "inspection_scheduled", label: "Inspection scheduled (from its inspections)", disabled: true });
    expect(derived.slice(1).every((o) => !o.disabled)).toBe(true);
    expect(permitStatusOptions("scheduled")[0].label).toBe("Inspection scheduled (from its inspections)"); // the legacy job-tab key
    expect(permitStatusOptions(null).length).toBe(4);
    expect(permitStatusLabel("some_new_word")).toBe("some new word");
  });
  it("every status select on a permit draws from the pickable list", () => {
    expect(card).toContain("PERMIT_PICKABLE_STATUSES as STATUSES");
    expect(card).toContain("permitStatusOptions(p.status).map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)");
    expect(read("src/app/(app)/permits/edit-permit-button.tsx")).toContain("permitStatusOptions(status).map(");
    expect(read("src/app/(app)/permits/add-permit-button.tsx")).toContain("PERMIT_PICKABLE_STATUSES as STATUSES");
    for (const f of ["src/app/(app)/jobs/[id]/job-permits.tsx", "src/app/(app)/permits/edit-permit-button.tsx", "src/app/(app)/permits/add-permit-button.tsx"]) {
      expect(read(f)).not.toContain("PERMIT_STATUSES as STATUSES");
    }
  });
});

describe("the permit card on a phone", () => {
  it("has nothing of fixed width beside its body: the controls are a wrapping row under the title", () => {
    expect(card).not.toContain("flex flex-col items-end"); // the old right column
    expect(card).not.toMatch(/className="h-7 w-40/); // the 160-px select that crushed the body
    expect(card).toContain('className="h-11 w-full text-sm sm:h-9 sm:w-48 sm:text-xs"');
    expect(card).toContain('<div className="mt-2 flex flex-wrap items-center gap-2">');
    // The body is still the one flex-1 column, and the inspections sit inside it.
    expect(card).toMatch(/<div className="min-w-0 flex-1">[\s\S]*<PermitInspections[\s\S]*authority=\{p\.authority\}[\s\S]*permitStatus=\{p\.status\}/);
    // Delete is a real tap target, named, still behind its confirm.
    expect(card).toContain('aria-label="Delete this permit"');
    expect(card).toContain('className="min-h-11 min-w-11 text-slate-400 hover:text-red-600"');
    expect(card).toContain('if (confirm("Delete this permit?"))');
  });
});

describe("an inspection's result is one door, in words", () => {
  it("Passed is one tap on the booked day once it has come, never a day still ahead", () => {
    expect(passedOnDay({ scheduled_for: "2026-10-15" }, "2026-10-15")).toBe("2026-10-15");
    expect(passedOnDay({ scheduled_for: "2026-10-13" }, "2026-10-15")).toBe("2026-10-13"); // written up two days late: the day they came
    expect(passedOnDay({ scheduled_for: "2026-10-20" }, "2026-10-15")).toBe("2026-10-15"); // booked ahead, passed today: today
    expect(passedOnDay({ scheduled_for: null }, "2026-10-15")).toBe("2026-10-15");
    expect(passedOnDay({ scheduled_for: "2026-10-15T07:00:00.000Z" }, "2026-10-15")).toBe("2026-10-15"); // a timestamp reads as its day
    expect(passedOnDay({ scheduled_for: "2026-10-13" }, "")).toBe("2026-10-13"); // no company today handed down: the booked day
  });
  it("the row offers Passed and Failed on an open visit, Change It on one written up", () => {
    expect(rows).toContain('recordInspectionResult({ id: r.id, result: "passed", result_on: passedOnDay(r, todayStr), inspector: null, why: null, expect_open: true })'); // open-only (audit v1120)
    expect(rows).toMatch(/isOpenInspection\(r\) \? \([\s\S]*>\s*Passed\s*<\/Button>[\s\S]*>\s*Failed\s*<\/Button>[\s\S]*\) : \([\s\S]*>\s*Change It\s*<\/Button>/);
    expect(rows).toContain('{ kind: "result", id: r.id, preset: "failed" }'); // Failed opens the form on Failed: a failure says why
    expect(rows).toContain('useState<string>(preset ?? row.result ?? "passed")');
    expect(rows).not.toContain("Record Inspection Status");
    expect(rows).toContain('<span className="flex flex-wrap items-center gap-1">'); // the buttons wrap under the line on a phone
    expect(rows).toContain("aria-label={`${r.authority}: passed`}"); // several rows: each verb names its visit
    expect(rows).toContain('useState((row.result_on ?? "").slice(0, 10) || passedOnDay(row, todayStr));'); // Failed's day defaults the same way as Passed
    // THE UNDO (the NOT-annoying rule: an undo trail, never a confirm): a written-up visit can go back to open.
    expect(rows).toContain('onReopen={r.result ? () => run(reopenInspection(r.id, permitId), "Couldn\'t reopen it — try again.") : undefined}');
    expect(rows).toContain("It Hasn&rsquo;t Happened Yet");
    const doors = read("src/app/(app)/permits/inspection-actions.ts");
    expect(doors).toContain("export async function reopenInspection(id: string, permitId: string): Promise<InspectionRecorded> {");
    expect(doors).toContain(".update({ result: null, result_on: null, inspector: null })");
    expect(doors).toContain("const head = `${row.authority} ${said}${onWords ? ` on ${onWords}` : \"\"}`;"); // the day is said, never silent
    // The edit modal starts from the permit as it is NOW (a Passed moved it under the open page).
    const modal = read("src/app/(app)/permits/edit-permit-button.tsx");
    expect(modal).toMatch(/onClick=\{\(\) => \{\s*seed\(\);\s*setOpen\(true\);/);
    expect(modal).toContain('aria-label="Edit this permit"');
  });
  it("the issuing authority's own visit is offered in one tap while it has no row and the permit is live", () => {
    const doors = read("src/app/(app)/permits/inspection-actions.ts");
    const rows3 = [{ authority: "TTPUD" }, { authority: "Liberty Utilities" }];
    expect(authorityWithoutRow("Town of Truckee", rows3)).toBe("Town of Truckee");
    expect(authorityWithoutRow("Town of Truckee", [...rows3, { authority: "town  of truckee " }])).toBeNull(); // case and spaces aside
    expect(authorityWithoutRow("Town of Truckee Building Dept", [{ authority: "Town of Truckee" }])).toBeNull(); // free text both sides: one contains the other
    expect(authorityWithoutRow("Truckee", [{ authority: "Town of Truckee" }])).toBeNull();
    const long = "Placer County Community Development Resource Agency Building Services Division Office";
    expect(long.length).toBeGreaterThan(80);
    expect(authorityWithoutRow(long, [{ authority: long.slice(0, 80) }])).toBeNull(); // the row's name was cut to AUTHORITY_MAX when saved
    expect(authorityWithoutRow("", rows3)).toBeNull();
    expect(authorityWithoutRow(null, [])).toBeNull();
    expect(authorityWithoutRow("Town of Truckee", null)).toBe("Town of Truckee");
    // Only while the permit is open to visits: not before it is issued, not once closed, not a legacy hand-marked pass.
    expect([...PERMIT_STATUSES_OPEN_TO_VISITS].sort()).toEqual(["failed", "inspection_scheduled", "issued", "scheduled"]);
    expect(rows).toContain('const missing = !unread && PERMIT_STATUSES_OPEN_TO_VISITS.has(permitStatus ?? "") && stand.state !== "clear" ? authorityWithoutRow(authority, ordered) : null;');
    expect(rows).toContain("Add The {missing} Inspection");
    expect(rows).toContain("saveInspection({ authority: missing, scheduled_for: null, scheduled_window: null, permit_id: permitId, first: true })"); // the town goes first in line
    expect(rows).toContain("{canWrite && missing && addedFor !== missing && ("); // a second tap in the refresh gap adds nothing
    expect(rows).toContain('className="h-auto min-h-11 whitespace-normal py-2 text-left"'); // a long authority wraps, never widens the phone
    expect(doors).toMatch(/if \(input\.first && have\.rows\.length\) \{[\s\S]*sort\(\(a, b\) => Number\(b\.position\) - Number\(a\.position\)\)[\s\S]*position = 1;/);
  });
});
