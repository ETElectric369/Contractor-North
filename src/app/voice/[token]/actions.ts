"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { createNotifications } from "@/lib/notifications";
import { CONSENT_VERSION, VOICE_PROMPTS, extForMime } from "@/lib/voice-script";

// Public, UNAUTHENTICATED actions for the /voice/[token] portal. The invitee has no account,
// so the unguessable token is the capability — every action resolves the invite by token first
// and does nothing if it's unknown. All writes go through the service client (RLS-bypassing);
// inputs are validated (known prompt keys, audio mime, size) so the token can't be abused to
// write arbitrary objects. No secrets leave; nothing here can touch another org's data.

const VALID_KEYS = new Set(VOICE_PROMPTS.map((p) => p.key));
const MAX_CLIP_BYTES = 50 * 1024 * 1024;

type Result = { ok: boolean; error?: string };

async function resolveInvite(token: string) {
  const t = String(token || "").trim();
  if (!t || t.length < 12) return null;
  const sb = createServiceClient();
  const { data } = await sb
    .from("voice_invites")
    .select("id, org_id, invitee_name")
    .eq("token", t)
    .limit(1)
    .maybeSingle();
  return data as { id: string; org_id: string; invitee_name: string } | null;
}

/** Record the invitee's typed signature + timestamp against the consent text version. */
export async function saveConsent(token: string, name: string): Promise<Result> {
  const invite = await resolveInvite(token);
  if (!invite) return { ok: false, error: "This link isn't valid." };
  const signature = String(name || "").trim().slice(0, 120);
  if (signature.length < 2) return { ok: false, error: "Please type your name to agree." };
  const sb = createServiceClient();
  const { error } = await sb
    .from("voice_invites")
    .update({ consent_name: signature, consent_version: CONSENT_VERSION, consented_at: new Date().toISOString() })
    .eq("id", invite.id);
  if (error) return { ok: false, error: "Couldn't save — please try again." };
  return { ok: true };
}

/** Upload one recorded clip (FormData: token, promptKey, file) to the private bucket. */
export async function uploadClip(formData: FormData): Promise<Result> {
  const token = String(formData.get("token") || "");
  const promptKey = String(formData.get("promptKey") || "");
  const file = formData.get("file");
  const invite = await resolveInvite(token);
  if (!invite) return { ok: false, error: "This link isn't valid." };
  if (!VALID_KEYS.has(promptKey)) return { ok: false, error: "Unknown prompt." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "No audio to upload." };
  if (file.size > MAX_CLIP_BYTES) return { ok: false, error: "That recording is too large — try a shorter take." };
  const mime = file.type || "audio/webm";
  if (!mime.startsWith("audio/")) return { ok: false, error: "That wasn't an audio recording." };

  const sb = createServiceClient();
  const path = `${token}/${promptKey}.${extForMime(mime)}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error } = await sb.storage.from("voice-clips").upload(path, bytes, { contentType: mime, upsert: true });
  if (error) return { ok: false, error: "Upload failed — please try again." };
  return { ok: true };
}

/** Mark the session complete, count the clips, and ping the inviting org's staff. */
export async function completeRecording(token: string, clipCount: number): Promise<Result> {
  const invite = await resolveInvite(token);
  if (!invite) return { ok: false, error: "This link isn't valid." };
  const sb = createServiceClient();
  await sb
    .from("voice_invites")
    .update({ completed_at: new Date().toISOString(), clip_count: Math.max(0, Math.min(99, Math.floor(clipCount || 0))) })
    .eq("id", invite.id);

  // Tell the office (all staff of the inviting org) it's ready to submit to ElevenLabs.
  const { data: staff } = await sb
    .from("profiles")
    .select("id")
    .eq("org_id", invite.org_id)
    .in("role", ["owner", "admin", "office"]);
  await createNotifications(
    invite.org_id,
    (staff ?? []).map((s: { id: string }) => s.id),
    {
      type: "voice_recording",
      title: `${invite.invitee_name} finished their voice recording`,
      body: "Their consent + clips are saved and ready to submit to ElevenLabs.",
      url: "/settings",
    },
  );
  return { ok: true };
}
