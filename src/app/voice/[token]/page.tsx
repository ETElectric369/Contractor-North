import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { CONSENT_TEXT, VOICE_PROMPTS } from "@/lib/voice-script";
import { VoiceRecorder } from "./voice-recorder";

export const dynamic = "force-dynamic";

// Private consent page — never indexed.
export const metadata: Metadata = {
  title: "A voice for Nort",
  robots: { index: false, follow: false },
};

export default async function VoicePortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = String(token || "").trim();
  if (t.length < 12) notFound();

  const sb = createServiceClient();
  const { data: invite } = await sb
    .from("voice_invites")
    .select("invitee_name, purpose, consented_at, completed_at, revoked_at, expires_at")
    .eq("token", t)
    .limit(1)
    .maybeSingle();
  // A withdrawn or lapsed invitation is simply not there. 404 rather than an explanation —
  // the token is the only thing identifying this page, and confirming that a token was once
  // valid tells a stranger more than it tells the invitee (0172).
  const inv = invite as { revoked_at: string | null; expires_at: string | null } | null;
  if (!inv) notFound();
  if (inv.revoked_at) notFound();
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) notFound();

  return (
    <VoiceRecorder
      token={t}
      inviteeName={(invite as { invitee_name: string }).invitee_name}
      purpose={(invite as { purpose: string | null }).purpose ?? ""}
      alreadyConsented={!!(invite as { consented_at: string | null }).consented_at}
      alreadyCompleted={!!(invite as { completed_at: string | null }).completed_at}
      consentText={[...CONSENT_TEXT]}
      prompts={VOICE_PROMPTS}
    />
  );
}
