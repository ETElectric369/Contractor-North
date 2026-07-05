"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { computeDeckEstimate, buildDeckRates, DECK_ESTIMATE_CODES, type DeckAnswers } from "@/lib/estimate/deck";
import { createTriagedInquiry } from "@/lib/inquiries/create-triaged-inquiry";
import type { LeadIntake } from "@/lib/lead-triage";
import type { EstimatePayload, EstimateResult } from "./types";

const clamp = (x: unknown, lo: number, hi: number): number => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
};

/** Bound the numbers so a hand-crafted payload can't produce an absurd estimate. */
function sanitizeAnswers(a: DeckAnswers): DeckAnswers {
  return {
    projectType: String(a?.projectType ?? "new_deck"),
    material: a?.material === "composite" ? "composite" : "wood",
    lengthFt: clamp(a?.lengthFt, 0, 500),
    widthFt: clamp(a?.widthFt, 0, 500),
    heightFt: clamp(a?.heightFt, 0, 200),
    railingLf: a?.railingLf == null ? null : clamp(a.railingLf, 0, 5000),
    stairFlights: Math.round(clamp(a?.stairFlights, 0, 20)),
    stairRailingLf: clamp(a?.stairRailingLf, 0, 1000),
    shape: a?.shape === "irregular" ? "irregular" : "rectangle",
    wrapAround: !!a?.wrapAround,
    manDoors: Math.round(clamp(a?.manDoors, 0, 20)),
    sliderDoors: Math.round(clamp(a?.sliderDoors, 0, 20)),
    trpa: !!a?.trpa,
  };
}

/**
 * Public submit for the deck configurator. Re-computes the estimate SERVER-SIDE from the
 * org's own catalog (the client's numbers are never trusted), triages the lead, and drops it
 * into the office pipeline via the shared createTriagedInquiry. Returns only what the customer
 * should see — and only shows a firm price if the lead earned one (ready + under the gate).
 */
export async function submitEstimateLead(handle: string, payload: EstimatePayload): Promise<EstimateResult> {
  // Bot trap — pretend success, write nothing.
  if (payload?.hp) return { ok: true, showInstantPrice: false, siteInspectionRequired: false, total: 0 };

  const name = String(payload?.contact?.name ?? "").trim();
  if (!name) return { ok: false, error: "Please enter your name." };
  const phone = String(payload?.contact?.phone ?? "").trim();
  const email = String(payload?.contact?.email ?? "").trim();
  if (!phone && !email) return { ok: false, error: "Add a phone or email so we can reach you." };

  const supabase = createServiceClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, settings")
    .eq("settings->>public_handle", String(handle))
    .maybeSingle();
  if (!org) return { ok: false, error: "This estimator isn't available right now." };
  const orgId = (org as { id: string }).id;
  const settings = getOrgSettings((org as { settings?: unknown }).settings);

  // Authoritative pricing: rates come from the org's live price list, keyed by code.
  // Same query + rate-building as the public page (markup applied, deduped newest-first) so the
  // customer's live preview and this authoritative recompute can never disagree.
  const { data: catalog } = await supabase
    .from("price_list_items")
    .select("code, buy_price, markup_pct, updated_at")
    .eq("org_id", orgId)
    .eq("archived", false)
    .in("code", DECK_ESTIMATE_CODES as unknown as string[])
    .order("updated_at", { ascending: false });
  const rates = buildDeckRates((catalog ?? []) as { code: string | null; buy_price: number | null; markup_pct: number | null }[]);
  const answers = sanitizeAnswers(payload.answers);
  const est = computeDeckEstimate(answers, (code) => rates[code] ?? 0);

  const q = payload.qualifying ?? { hasPlans: false, plansApproved: null, noPlansPath: null };
  const gaveDimensions = answers.lengthFt > 0 && answers.widthFt > 0;
  const intake: LeadIntake = {
    projectType: answers.projectType as LeadIntake["projectType"],
    hasPlans: !!q.hasPlans,
    plansApproved: q.plansApproved ?? null,
    hasSketch: q.noPlansPath === "sketch",
    hasDimensions: q.noPlansPath === "dimensions" || gaveDimensions,
    needsDesignHelp: q.noPlansPath === "design_help" || answers.projectType === "unsure",
    estimateTotal: est.total,
    contact: { name, email: email || null, phone: phone || null, address: payload.contact?.address ?? null },
  };

  let triage;
  try {
    ({ triage } = await createTriagedInquiry(supabase, orgId, {
      name,
      email: email || null,
      phone: phone || null,
      address: payload.contact?.address ?? null,
      city: payload.contact?.city ?? null,
      state: payload.contact?.state ?? null,
      zip: payload.contact?.zip ?? null,
      type: "residential",
      source: "deck_configurator",
      intake,
      intakeJson: {
        project_type: answers.projectType,
        plans: { has_plans: q.hasPlans, plans_approved: q.plansApproved, no_plans_path: q.noPlansPath },
        deck: answers,
        estimate: { total: est.total, area: est.area, lines: est.lines, assumptions: est.assumptions },
      },
      inspectionThreshold: settings.site_inspection_threshold,
    }));
  } catch {
    return { ok: false, error: "Couldn't submit — please call us instead." };
  }

  // Office Leads page is force-dynamic; this is belt-and-suspenders so it's fresh on next load.
  revalidatePath("/leads");

  return {
    ok: true,
    showInstantPrice: triage.showInstantPrice,
    siteInspectionRequired: triage.siteInspectionRequired,
    bucket: triage.bucket,
    total: est.total,
    // Only itemize when we're actually showing a firm number.
    lines: triage.showInstantPrice ? est.lines : [],
    assumptions: triage.showInstantPrice ? est.assumptions : [],
  };
}
