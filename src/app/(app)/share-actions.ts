"use server";

import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user's personal "request an estimate" share link + QR.
 * The ?ref={profile_id} tags any lead that arrives through it as referred_by
 * this person ("Brian at the bar" → commission is a lookup, not a memory).
 * Available to EVERY role — techs are the street team. Uses the canonical
 * /inquire URL (not SPLASH_DOMAIN) so the ref param always survives.
 */
export async function getShareLink(): Promise<{ url: string; qr: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { url: "", qr: "", error: "Not signed in." };
  const { data: prof } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
  const orgId = (prof as { org_id?: string } | null)?.org_id;
  if (!orgId) return { url: "", qr: "", error: "No company on this account." };

  const site = process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app";
  const url = `${site}/inquire/${orgId}?ref=${user.id}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 480, color: { dark: "#0f172a" } });
  return { url, qr };
}
