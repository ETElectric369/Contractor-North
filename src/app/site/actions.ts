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
