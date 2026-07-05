/**
 * THE one place a triaged lead is written to the inquiries pipeline. Both front doors call
 * it: the partner webhook (POST /api/inbound/lead) and the native public estimate
 * configurator (/estimate/[handle]). Triage (bucket / $-gate / priority) is computed HERE
 * from the intake, so no caller can hand-set a bucket or priority and game an instant price.
 *
 * org_id is ALWAYS passed explicitly because both callers use the service client (no auth
 * session → the set_org_id trigger has nothing to infer from). The intake jsonb keeps the
 * raw answers + the configurator estimate ({total, lines}) plus the triage reason, so the
 * office Leads row and the one-click convert→draft-quote path both read what they need.
 */
import { classifyLead, type LeadIntake, type LeadTriage } from "@/lib/lead-triage";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CreateTriagedInquiryInput {
  name: string;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  type?: string | null;
  message?: string | null;
  source: string;
  /** Drives triage + the project_type / estimate_total columns. */
  intake: LeadIntake;
  /** Persisted verbatim into the intake jsonb (raw project answers + estimate {total,lines});
   *  the triage `reason` is merged in. Must include `estimate` for the convert→quote path. */
  intakeJson: Record<string, unknown>;
  inspectionThreshold?: number;
}

export async function createTriagedInquiry(
  supabase: SupabaseClient,
  orgId: string,
  input: CreateTriagedInquiryInput,
): Promise<{ id: string; triage: LeadTriage }> {
  const triage = classifyLead(input.intake, { inspectionThreshold: input.inspectionThreshold });

  const { data, error } = await supabase
    .from("inquiries")
    .insert({
      org_id: orgId, // explicit — service client has no auth context for the set_org_id trigger
      name: input.name,
      company_name: input.company_name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      type: input.type ?? "residential",
      message: input.message ?? null,
      source: String(input.source).slice(0, 40),
      project_type: input.intake.projectType ?? null,
      lead_bucket: triage.bucket,
      estimate_total: input.intake.estimateTotal || null,
      site_inspection_required: triage.siteInspectionRequired,
      priority: triage.priority,
      intake: { ...input.intakeJson, reason: triage.reason },
    })
    .select("id")
    .single();

  if (error) throw error;
  return { id: data.id as string, triage };
}
