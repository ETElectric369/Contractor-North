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
    .select("invitee_name, purpose, consented_at, completed_at")
    .eq("token", t)
    .limit(1)
    .maybeSingle();
  if (!invite) notFound();

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
