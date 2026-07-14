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
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDayStartUtc, tzLocalHourUtc } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles } from "@/lib/push";
import { sendEmail } from "@/lib/email";
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
  const id = data.id as string;

  // A >$20k lead flagged for a site inspection gets one AUTO-BOOKED onto the Schedule, so a big
  // inbound lead never sits with no scheduled action. Service client → org_id explicit (no auth
  // session for the set_org_id trigger). Best-effort: a booking failure must not stop the lead.
  if (triage.siteInspectionRequired) {
    try {
      // 9 AM in the ORG's timezone, two days out — NOT server-local setHours(9), which on
      // Vercel (UTC) stored 9 AM UTC = 1-2 AM Pacific (the exact class cn-v498 fixed in
      // leads/actions.ts). Same tz idiom as recurring/actions' defaultDueDateIso.
      const { data: orgTz } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
      const tz = getOrgSettings((orgTz as { settings?: unknown } | null)?.settings).timezone;
      const todayStart = tzDayStartUtc(todayStrInTz(tz), tz);
      const dayStr = todayStrInTz(tz, new Date(todayStart.getTime() + 2 * 86_400_000));
      const when = tzLocalHourUtc(dayStr, 9, tz);
      await supabase.from("appointments").insert({
        org_id: orgId,
        type: "inspection",
        title: `Site inspection: ${input.name}`,
        starts_at: when.toISOString(),
        location: input.address ?? null,
        notes: input.message ?? null,
        status: "scheduled",
        // Provenance (0129): lets the customer's "schedule your site visit" tap
        // REUSE this tentative hold (flip to proposed + pick link) instead of
        // double-booking a second inspection onto the calendar.
        inquiry_id: id,
      });
    } catch {
      /* auto-booking is best-effort — the lead still lands even if it fails */
    }
  }

  // Fire the alarm — an inbound lead is money walking in the door, and speed-to-lead wins the
  // job. Alert the sales/office crew on THREE channels so it can't be missed: the in-app bell
  // (always works), web push (buzzes the phone), and an email to the office. All best-effort —
  // a notify failure must NEVER stop the lead from landing in the pipeline.
  try {
    const [{ data: staff }, { data: orgRow }] = await Promise.all([
      supabase.from("profiles").select("id, email").eq("org_id", orgId).in("role", ["owner", "admin", "office"]),
      supabase.from("organizations").select("email, name").eq("id", orgId).maybeSingle(),
    ]);
    const staffIds = ((staff ?? []) as { id: string }[]).map((s) => s.id);
    const money = input.intake.estimateTotal
      ? `est. $${Math.round(input.intake.estimateTotal).toLocaleString()}`
      : "quote request";
    const where = [input.city, input.state].filter(Boolean).join(", ");
    const title = `🔥 New lead — ${input.name}`;
    const body = [input.intake.projectType, money, where].filter(Boolean).join(" · ") || "New quote request";

    await createNotifications(orgId, staffIds, { type: "inquiry", title, body, url: "/leads" });
    await sendPushToProfiles(staffIds, "inquiry", { title, body, url: "/leads" });

    const to = (orgRow as { email?: string } | null)?.email
      || ((staff ?? []) as { email?: string }[]).map((s) => s.email).find(Boolean);
    if (to) {
      const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
      const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
      await sendEmail({
        to,
        fromName: (orgRow as { name?: string } | null)?.name || undefined,
        subject: `New lead: ${input.name}${input.intake.estimateTotal ? ` (est. $${Math.round(input.intake.estimateTotal).toLocaleString()})` : ""}`,
        html: `<div style="font-family:ui-sans-serif,system-ui,Arial,sans-serif;max-width:520px;color:#0f172a">
          <h2 style="margin:0 0 6px">🔥 New lead — ${esc(input.name)}</h2>
          <p style="color:#475569;margin:0 0 12px">${esc(body)}</p>
          ${input.email ? `<p style="margin:2px 0">📧 ${esc(input.email)}</p>` : ""}
          ${input.phone ? `<p style="margin:2px 0">📞 ${esc(input.phone)}</p>` : ""}
          ${input.message ? `<p style="color:#334155;margin:12px 0;border-left:3px solid #cbd5e1;padding-left:10px">${esc(input.message)}</p>` : ""}
          <p style="margin:18px 0"><a href="${site}/leads" style="background:#0b57c4;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">Open the lead →</a></p>
          <p style="color:#94a3b8;font-size:12px">Reach out fast — speed-to-lead wins the job.</p>
        </div>`,
      });
    }
  } catch {
    /* notifications are best-effort — the lead must still land even if alerts fail */
  }

  return { id, triage };
}
