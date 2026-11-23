import type { Answers } from "@/lib/playbook/types";
import { appointmentTypeFor, bookingTitle, workKind } from "@/lib/schedule/work-shape";
import { briefNote, carriedNote } from "./carry-intake-answers";

/**
 * ONE ROW SHAPE FOR A LEAD'S INSPECTION (cn-v1185). The office's Book It (convertInquiry) and the
 * website visitor's own pick (publicPickInspectionTime) write the SAME visit: a pick that wrote a
 * different row would be a second kind of inspection on the calendar, and the inspector would open
 * a sheet the office's booking would have pre-filled and this one left blank.
 *
 * Pure: no read, no clock. What it returns is exactly the literal Book It inserted before cn-v1185
 * (its test compares against that literal). No length and no end, by the owner's rule ("Remove how
 * long (will be determined in Inspector)"): the calendar draws its default block. The caller adds
 * what only it knows: the public door adds `org_id` (the service client has no auth context for the
 * set_org_id trigger) and `status`.
 *
 * The kind and type come through the same helpers a lead with no kind always took (cn-v1170: Schedule
 * on a lead always books an INSPECTION), never a second literal.
 */
export const LEAD_VISIT_KIND = workKind({ kind: "lead", workKind: null });
export const LEAD_VISIT_TYPE = appointmentTypeFor(null);

export type LeadForVisit = {
  id: string;
  name?: string | null;
  address?: string | null;
  message?: string | null;
  notes?: string | null;
};

export type VisitCarry = {
  inspectionTemplateId: string | null;
  inspectionAnswers: Answers;
  carried: string[];
  briefCarried: string[];
};

export function leadInspectionRow(a: {
  lead: LeadForVisit;
  carry: VisitCarry;
  startsAtIso: string;
  customerId: string | null;
  createdBy: string | null;
}) {
  const { lead, carry } = a;
  return {
    type: LEAD_VISIT_TYPE,
    title: bookingTitle(LEAD_VISIT_KIND, String(lead.name ?? "")),
    starts_at: a.startsAtIso,
    location: lead.address ?? null,
    notes:
      [lead.message ?? lead.notes ?? null, carriedNote(carry.carried), briefNote(carry.briefCarried)]
        .filter(Boolean)
        .join("\n\n") || null,
    // The customer's own answers, on the inspection, so the inspector CONFIRMS rather than re-asks.
    inspection_template_id: carry.inspectionTemplateId,
    inspection_answers: carry.inspectionAnswers,
    customer_id: a.customerId || null,
    inquiry_id: lead.id, // provenance: the calendar entry knows its lead
    created_by: a.createdBy,
  };
}
