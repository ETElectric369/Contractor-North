import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leadInspectionRow, LEAD_VISIT_KIND, LEAD_VISIT_TYPE } from "./lead-visit-row";
import { briefNote, carriedNote } from "./carry-intake-answers";
import { appointmentTypeFor, bookingTitle, workKind } from "@/lib/schedule/work-shape";

/**
 * ONE ROW SHAPE FOR A LEAD'S INSPECTION (cn-v1185). Book It's insert was a literal inside
 * convertInquiry; the website visitor's pick writes the same visit. The literal is copied here as it
 * stood at cn-v1184, and the lifted function must return exactly it, for every shape of lead.
 */
function bookItLiteralAtV1184(inq: any, id: string, carry: any, startsAtIso: string, opts: { customerId?: string | null }, userId: string | null) {
  const LEAD_VISIT_KIND = workKind({ kind: "lead", workKind: null });
  const LEAD_VISIT_TYPE = appointmentTypeFor(null);
  return {
    type: LEAD_VISIT_TYPE,
    title: bookingTitle(LEAD_VISIT_KIND, String(inq.name ?? "")),
    starts_at: startsAtIso,
    location: inq.address,
    notes:
      [inq.message ?? inq.notes ?? null, carriedNote(carry.carried), briefNote(carry.briefCarried)]
        .filter(Boolean)
        .join("\n\n") || null,
    inspection_template_id: carry.inspectionTemplateId,
    inspection_answers: carry.inspectionAnswers,
    customer_id: opts.customerId || inq.customer_id || null,
    inquiry_id: id,
    created_by: userId,
  };
}

const ID = "1a1a1a1a-0000-4000-8000-000000000011";
const AT = "2026-12-01T17:00:00.000Z";
const none = { inspectionTemplateId: null, inspectionAnswers: {}, carried: [], briefCarried: [] };
const full = { inspectionTemplateId: "form-1", inspectionAnswers: { project_type: "New deck" }, carried: ["Kind of project"], briefCarried: ["Height"] };

describe("leadInspectionRow is Book It's row", () => {
  it.each([
    ["a bare lead", { id: ID, name: "Sam Tillery", address: "1 Larkspur Way", message: null, notes: null, customer_id: null }, none, {}, "office-1"],
    ["a lead with notes, no message, a card of its own", { id: ID, name: "Dana Rook", address: null, message: null, notes: "Gate code at the side", customer_id: "c-1" }, full, {}, "office-1"],
    ["a message wins over notes; the office's chosen card wins", { id: ID, name: "", address: "2 Snowbell Ct", message: "Rot on the stairs", notes: "x", customer_id: "c-1" }, full, { customerId: "c-2" }, "office-2"],
    ["the public pick: nobody made it", { id: ID, name: "Sam Tillery", address: "1 Larkspur Way", message: "Deck", notes: null, customer_id: null }, full, {}, null],
  ])("%s", (_n, inq: any, carry: any, opts: { customerId?: string | null }, userId) => {
    const literal = bookItLiteralAtV1184(inq, ID, carry, AT, opts, userId);
    const lifted = leadInspectionRow({ lead: inq, carry, startsAtIso: AT, customerId: opts.customerId || inq.customer_id || null, createdBy: userId });
    expect(lifted).toEqual(literal);
    expect(Object.keys(lifted).sort()).toEqual(Object.keys(literal).sort());
    // No length and no end, ever ("will be determined in Inspector").
    for (const k of ["ends_at", "planned_minutes", "duration_minutes", "org_id"]) expect(lifted).not.toHaveProperty(k);
  });

  it("is an inspection, through the helpers a lead with no kind always took", () => {
    expect(LEAD_VISIT_TYPE).toBe("inspection");
    expect(LEAD_VISIT_KIND).toBe(workKind({ kind: "lead", workKind: null }));
  });

  it("Book It inserts what it returns, and no second literal is left in convertInquiry", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
    const at = src.indexOf('const { data: booked, error: aErr } = await supabase.from("appointments").insert(');
    expect(at).toBeGreaterThan(0);
    const insert = src.slice(at, src.indexOf('.select("id").single();', at));
    expect(insert).toContain("leadInspectionRow({");
    expect(insert).toContain("createdBy: ctx.userId");
    expect(insert).toContain("customerId: opts.customerId || inq.customer_id || null");
    expect(insert).not.toContain("inspection_template_id");
  });
});
