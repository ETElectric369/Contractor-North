import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TYPED TAKE-OFF REACHES THE ESTIMATE AND THE JOB (cn-v1069). The rules are pure and pinned in
 * lib/inspection/capture.test.ts (seedLinesFromCapture, measuredOnSiteBlock) and the list writer in
 * materials/actions; this pins that the two doors actually CALL them — the rows were saved for weeks
 * with no reader, and a helper with no caller is how that happens again.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("Start the Estimate seeds the typed rows", () => {
  const src = read("src/app/(app)/quotes/new/page.tsx");
  it("reads the capture tolerantly, puts the typed rows AFTER the scope picks, and the measures into the scope text", () => {
    expect(src).toContain("typedCapture = parseInspectorCapture((appt as any).capture);");
    // The scope picks first, then HIS TASKS as lines (cn-v1074, one per task), then the typed rows: since
    // cn-v1176 through THE ONE builder (lib/estimate/visit-lines), which the Won sheet shows and approves.
    expect(src).toMatch(/const seededLines: DraftLineItem\[\] = visitEstimateLines\(\{\s*scopes: pickedScopes,\s*tasks: pickedTasks,\s*typedItems: typedCapture\?\.items,/);
    const builder = read("src/lib/estimate/visit-lines.ts");
    expect(builder).toMatch(/seedLinesFromCapture\(\[\.\.\.scopeRows\.map\(\(r\) => r\.line\), \.\.\.taskRows\.map\(\(r\) => r\.line\)\], seed\.typedItems\)/);
    expect(src).toContain("typedCapture?.items,");
    expect(src).toContain("measuredOnSiteBlock(typedCapture?.measures),");
  });
});

describe("Start the Job lists the typed rows on the job", () => {
  const src = read("src/app/(app)/appointments/actions.ts");
  it("selects the capture (projection law), writes through the one list writer, and says what could not be listed", () => {
    // The capture and the sheet's tasks are read by the ONE visit read (lib/appointments/visit-work,
    // cn-v1134), which selects the capture by name; the door's own select no longer carries it.
    expect(src).toContain("inquiry_id, notes\")");
    expect(src).toContain('const work = await visitWork(supabase, appointmentId, "job");');
    const rule = read("src/lib/appointments/visit-work.ts");
    expect(rule).toContain('.select("capture")');
    expect(rule).toContain("parseInspectorCapture(");
    // W3b: the visit's task parts join the typed rows on the same call.
    expect(rule).toContain("typedItems: [...items, ...partsAsCaptureItems(birth.parts)]");
    expect(src).toContain("const typedItems = work.typedItems;");
    expect(src).toContain("await addCaptureItemsToJobList(job.id, typedItems)");
    // The sentence lives in the catalog since the agenda-in-Spanish wave (ag_srv_, the caller's language).
    expect(src).toContain('ws.say("ag_srv_madeMaterialsUnlisted"');
    expect(read("src/lib/words/agenda-server.ts")).toContain("Add them on the Materials tab.");
    // Re-pinned on purpose (cn-v1176): the note now carries the sale's "inspection not marked done" too
    // (doneNote); the materials note is still in it. The listing has no asSale guard, so the typed rows
    // reach the job's list on the card's path and on the Won sheet's plain start alike.
    expect(src).toContain("const note = [absorbNote, ...work.notes, tasksNote, materialsNote].concat(doneNote ?? []).filter(Boolean).join(\" \");");
    const maker = src.slice(src.indexOf("export async function createJobFromAppointment("), src.indexOf("const note = [absorbNote"));
    const listing = maker.slice(maker.indexOf("const typedItems = work.typedItems;"));
    expect(listing.slice(0, listing.indexOf("await addCaptureItemsToJobList(job.id, typedItems)"))).not.toMatch(/asSale/);
    expect(maker.indexOf("const typedItems = work.typedItems;")).toBeGreaterThan(maker.indexOf("const asSale = opts?.asSale === true;"));
  });
  it("the list writer proves every row, prices nothing, and carries the book code as the part number", () => {
    const m = read("src/app/(app)/materials/actions.ts");
    const fn = m.slice(m.indexOf("export async function addCaptureItemsToJobList"), m.indexOf("export async function addMaterialItem("));
    expect(fn).toContain("ensureJobMaterialList(jobId)");
    expect(fn).toContain("insertMaterialLine(supabase, actor, list.id, {");
    expect(fn).toContain("part_number: i.code ?? null,");
    expect(fn).toContain("est_cost: null,");
    expect(fn).toContain("quantity: i.quantity ?? 1,");
    expect(fn).toContain("could not be listed");
    expect(fn).toContain("if (!rows.length) return { ok: true, added: 0, kept: 0, leftOff: 0 };"); // leftOff: a key he deleted from the list before (cn-v1134)
    // KEYED (cn-v1134): a typed row rides under "capture:<its id>", so a second press lists nothing twice.
    expect(fn).toContain("source_key: i.source_key ?? (i.id ? `capture:${i.id}` : null),");
  });
});

describe("cn-v1176 fix F10: a malformed ?capture= is no visit", () => {
  const src = read("src/app/(app)/quotes/new/page.tsx");
  it("the id is tested against the uuid shape before any read; a bad one opens the blank editor, a real read failure still throws", () => {
    expect(src).toContain("const capture = captureParam && CAPTURE_ID.test(captureParam.trim()) ? captureParam.trim() : undefined;");
    const shape = src.match(/const CAPTURE_ID = \/(.+)\/i;/)?.[1];
    expect(shape).toBeTruthy();
    const re = new RegExp(shape as string, "i");
    for (const bad of ["abc", "J-900", "11111111-1111-4111-8111", "'; drop table", ""]) expect(re.test(bad), bad).toBe(false);
    expect(re.test("11111111-1111-4111-8111-111111111111")).toBe(true);
    // The read on a well-formed id is the seed reader's, which throws on a failed read.
    expect(src).toContain("const seedRead = await readVisitEstimateSeed(supabase, capture);");
    expect(read("src/lib/estimate/visit-lines.ts")).toContain("if (apptErr) throw apptErr;");
  });
});
