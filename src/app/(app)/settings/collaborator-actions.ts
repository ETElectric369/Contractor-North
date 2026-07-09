"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { sendEmail } from "@/lib/email";
import { rateLimited } from "@/lib/rate-limit";

/**
 * External site/content collaborators — an org's staff invite an outside SEO/content pro to manage
 * ONLY their public-site articles (see migration 0111 + /content). Grants are staff-managed and
 * RLS-scoped to the staff's own org; the collaborator claims the grant by signing up with the
 * invited email. Nothing here can grant access to anything but site_posts.
 */
export type Result = { ok: boolean; error?: string; link?: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function inviteSiteCollaborator(email: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = String(email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: "Enter a valid email address." };

  const { data: me } = await supabase.from("profiles").select("org_id").eq("id", ctx.userId).maybeSingle();
  const orgId = (me as { org_id?: string } | null)?.org_id;
  if (!orgId) return { ok: false, error: "No organization." };

  // Cap invites so a staff account can't turn the platform's sending domain into a spam cannon.
  if (await rateLimited(`collab-invite:${orgId}`, 20, 3600)) {
    return { ok: false, error: "Too many invites in the last hour — try again shortly." };
  }

  const { error } = await supabase
    .from("site_collaborators")
    .insert({ org_id: orgId, invited_email: clean, created_by: ctx.userId });
  if (error) {
    return {
      ok: false,
      error: /duplicate|unique/i.test(error.message)
        ? "That person is already invited to your site."
        : error.message,
    };
  }

  // Point them at signup; the /auth/callback + /onboarding routing claims the grant and lands them
  // on /content. The link is returned so staff can share it directly even if email lags.
  const base = process.env.NEXT_PUBLIC_SITE_URL || "";
  const link = `${base}/login?mode=signup&email=${encodeURIComponent(clean)}&next=/content`;
  const { data: org } = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  const orgName = (org as { name?: string } | null)?.name || "our team";
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  await sendEmail({
    to: clean,
    fromName: orgName,
    subject: `${orgName} invited you to manage their website articles`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 8px">You've been invited to write for ${esc(orgName)}</h2>
      <p style="color:#475569;line-height:1.6"><strong>${esc(orgName)}</strong> gave you access to publish articles on their website through Contractor North. Create your account with <strong>this email</strong> (${esc(clean)}) and you'll go straight to their content workspace — you'll only ever see their articles, nothing else.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#0b57c4;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Get started</a></p>
      <p style="color:#94a3b8;font-size:13px;word-break:break-all">Or open this link: ${link}</p>
    </div>`,
  }).catch(() => {}); // best-effort — the returned link is the guaranteed fallback

  revalidatePath("/settings");
  return { ok: true, link };
}

export async function revokeSiteCollaborator(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase.from("site_collaborators").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "That invite no longer exists." };
  revalidatePath("/settings");
  return { ok: true };
}
