"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { createTriagedInquiry } from "@/lib/inquiries/create-triaged-inquiry";
import { rateLimited, clientIp } from "@/lib/rate-limit";

export type ContactResult = { ok: boolean; error?: string };

/**
 * Public "contact / request an estimate" submit from an org's marketing homepage. Drops a
 * triaged lead straight into that org's pipeline via the shared createTriagedInquiry (source
 * "website_contact"). No auth — same trust model as the existing /inquire form; honeypot +
 * required contact guard the obvious spam. orgId comes from the server-rendered page.
 */
export async function submitSiteContact(
  orgId: string,
  payload: { name?: string; phone?: string; email?: string; message?: string; hp?: string },
): Promise<ContactResult> {
  if (payload?.hp) return { ok: true }; // bot trap
  const name = String(payload?.name ?? "").trim();
  if (!name) return { ok: false, error: "Please enter your name." };
  const phone = String(payload?.phone ?? "").trim();
  const email = String(payload?.email ?? "").trim();
  if (!phone && !email) return { ok: false, error: "Add a phone or email so we can reach you." };

  const ip = clientIp(await headers());
  if (await rateLimited(`contact:${ip}`, 10, 60)) {
    return { ok: false, error: "Too many requests — please try again in a moment." };
  }

  const supabase = createServiceClient();
  const { data: org } = await supabase.from("organizations").select("id, settings").eq("id", orgId).maybeSingle();
  if (!org) return { ok: false, error: "Something went wrong — please call us." };
  const settings = getOrgSettings((org as { settings?: unknown }).settings);

  // ── THE ORG COMES FROM THE CALLER, SO IT HAS TO EARN IT (audit 6) ────────────────────────
  //
  // This is an exported server action on an unauthenticated page, so it is POST-able directly
  // with the Next-Action header and whatever org uuid the caller likes. The only test was "does
  // this org exist" — every org exists. So any tenant's id accepted unlimited leads, each one
  // costing a push to every office phone and an email.
  //
  // TWO GATES. First: the door must actually BE a door. A site with no public_handle renders
  // nowhere, so it has no contact form and cannot be receiving submissions — the same test
  // toPublicOrg applies, so no live site loses anything.
  if (!settings.public_handle) return { ok: false, error: "Something went wrong — please call us." };
  // Second: the per-org daily ceiling the per-IP check cannot provide. rateLimited fails OPEN by
  // default, which is right here — refusing a real customer because a limiter hiccuped is the
  // worse failure, and no per-call money is spent.
  if (await rateLimited(`contact-org:${orgId}`, 50, 86_400))
    return { ok: false, error: "We've had a lot of messages today — please call us instead." };

  try {
    await createTriagedInquiry(supabase, orgId, {
      name,
      phone: phone || null,
      email: email || null,
      message: String(payload?.message ?? "").trim() || null,
      source: "website_contact",
      intake: { projectType: null, contact: { name, email: email || null, phone: phone || null, address: null } },
      intakeJson: { source: "website_contact", message: String(payload?.message ?? "").trim() || null },
      inspectionThreshold: settings.site_inspection_threshold,
    });
  } catch {
    return { ok: false, error: "Couldn't send — please call us instead." };
  }
  revalidatePath("/leads");
  return { ok: true };
}
