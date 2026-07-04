import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { classifyLead, DEFAULT_SITE_INSPECTION_THRESHOLD, type LeadIntake } from "@/lib/lead-triage";

export const runtime = "nodejs";

/**
 * Inbound lead webhook — the front door for a partner lead-generator (the Tahoe Deck deck
 * configurator) to drop a qualified lead into an org's Leads pipeline. Authenticated by a
 * per-org secret (organizations.settings.lead_inbound_secret), NOT a user session. The
 * readiness bucket / $-gate / priority are computed HERE (classifyLead) — the caller's own
 * bucket/priority, if any, are ignored, so a client can't game an instant big-ticket price.
 *
 *   POST /api/inbound/lead
 *   x-inbound-key: <the org's lead_inbound_secret>
 *   { customer:{name,email,phone,address,city,state,zip,type},
 *     project:{type,has_plans,plans_approved,has_sketch,has_dimensions,needs_design_help},
 *     estimate:{total, lines:[{description,quantity,unit,unit_price}]},
 *     message, source }
 *
 * Returns { ok, inquiry_id, bucket, show_instant_price, site_inspection_required, priority }
 * — the caller uses show_instant_price to decide whether to reveal a firm number to the customer.
 */
export async function POST(req: Request) {
  const key = req.headers.get("x-inbound-key") ?? "";
  if (!key) return NextResponse.json({ error: "Missing x-inbound-key." }, { status: 401 });

  let supabase;
  try {
    supabase = createServiceClient();
  } catch {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  // Resolve the org by its inbound secret. A random high-entropy token, matched whole.
  const { data: org } = await supabase
    .from("organizations")
    .select("id, settings")
    .eq("settings->>lead_inbound_secret", key)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Invalid key." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const customer = body.customer ?? {};
  const name = String(customer.name ?? body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "customer.name is required." }, { status: 400 });

  const project = body.project ?? {};
  const estimate = body.estimate ?? {};
  const total = Number(estimate.total ?? body.estimate_total ?? 0) || 0;

  const intake: LeadIntake = {
    projectType: project.type ?? null,
    hasPlans: !!project.has_plans,
    plansApproved: project.plans_approved ?? null,
    hasSketch: !!project.has_sketch,
    hasDimensions: !!project.has_dimensions,
    needsDesignHelp: !!project.needs_design_help,
    estimateTotal: total,
    contact: {
      name,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      address: customer.address ?? null,
    },
  };

  const threshold =
    Number((org as any).settings?.site_inspection_threshold) || DEFAULT_SITE_INSPECTION_THRESHOLD;
  const triage = classifyLead(intake, { inspectionThreshold: threshold });

  // org_id set explicitly — the set_org_id trigger has no auth context on a service call.
  const { data: inq, error } = await supabase
    .from("inquiries")
    .insert({
      org_id: (org as any).id,
      name,
      company_name: customer.company_name ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      address: customer.address ?? null,
      city: customer.city ?? null,
      state: customer.state ?? null,
      zip: customer.zip ?? null,
      type: customer.type ?? "residential",
      message: String(body.message ?? "").trim() || null,
      source: String(body.source ?? "tahoe_deck").slice(0, 40),
      project_type: project.type ?? null,
      lead_bucket: triage.bucket,
      estimate_total: total || null,
      site_inspection_required: triage.siteInspectionRequired,
      priority: triage.priority,
      intake: { ...project, estimate, reason: triage.reason },
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    inquiry_id: inq.id,
    bucket: triage.bucket,
    show_instant_price: triage.showInstantPrice,
    site_inspection_required: triage.siteInspectionRequired,
    priority: triage.priority,
  });
}
