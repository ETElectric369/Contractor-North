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

describe("Start The Estimate seeds the typed rows", () => {
  const src = read("src/app/(app)/quotes/new/page.tsx");
  it("reads the capture tolerantly, puts the typed rows AFTER the scope picks, and the measures into the scope text", () => {
    expect(src).toContain("typedCapture = parseInspectorCapture((appt as any).capture);");
    expect(src).toMatch(/const seededLines: DraftLineItem\[\] = seedLinesFromCapture\(\s*pickedScopes\.flatMap/);
    expect(src).toContain("typedCapture?.items,");
    expect(src).toContain("measuredOnSiteBlock(typedCapture?.measures),");
  });
});

describe("Start The Job lists the typed rows on the job", () => {
  const src = read("src/app/(app)/appointments/actions.ts");
  it("selects the capture (projection law), writes through the one list writer, and says what could not be listed", () => {
    expect(src).toContain("inquiry_id, notes, capture\")");
    expect(src).toContain("const typedItems = parseInspectorCapture((appt as { capture?: unknown }).capture).items ?? [];");
    expect(src).toContain("await addCaptureItemsToJobList(job.id, typedItems)");
    expect(src).toContain("Add them on the Materials tab.");
    expect(src).toContain("const note = [absorbNote, materialsNote].filter(Boolean).join(\" \");");
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
    expect(fn).toContain("if (!rows.length) return { ok: true, added: 0 };");
  });
});
