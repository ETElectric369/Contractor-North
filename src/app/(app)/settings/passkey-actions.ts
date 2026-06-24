"use server";

import { revalidatePath } from "next/cache";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { getRpConfig, bytesToB64url } from "@/lib/webauthn/server";

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Begin enrolling a passkey: issue a registration challenge bound to this user. */
export async function startPasskeyRegistration(): Promise<{ ok: boolean; error?: string; options?: any }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
  const { rpID, rpName } = await getRpConfig();
  const { data: existing } = await supabase
    .from("webauthn_credentials")
    .select("credential_id, transports")
    .eq("user_id", user.id);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email ?? prof?.full_name ?? "user",
    userDisplayName: prof?.full_name ?? user.email ?? "user",
    attestationType: "none",
    excludeCredentials: (existing ?? []).map((c: any) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });

  await supabase
    .from("webauthn_challenges")
    .upsert({ user_id: user.id, challenge: options.challenge, purpose: "register", action_hash: null, created_at: new Date().toISOString() });
  return { ok: true, options };
}

/** Finish enrollment: verify the attestation against the issued challenge, store the key. */
export async function finishPasskeyRegistration(
  response: RegistrationResponseJSON,
  label: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: ch } = await supabase
    .from("webauthn_challenges")
    .select("challenge, purpose, created_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ch || ch.purpose !== "register") return { ok: false, error: "No enrollment in progress — start again." };
  if (Date.now() - new Date(ch.created_at).getTime() > CHALLENGE_TTL_MS) return { ok: false, error: "That expired — try again." };

  const { rpID, origin } = await getRpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Could not verify the passkey." };
  }
  if (!verification.verified || !verification.registrationInfo) return { ok: false, error: "Could not verify the passkey." };

  const cred = verification.registrationInfo.credential;
  const { error } = await supabase.from("webauthn_credentials").insert({
    user_id: user.id,
    credential_id: cred.id,
    public_key: bytesToB64url(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports ?? [],
    label: (label || "Passkey").slice(0, 40),
  });
  await supabase.from("webauthn_challenges").delete().eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function listPasskeys(): Promise<{ id: string; label: string | null; created_at: string; last_used_at: string | null }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("webauthn_credentials")
    .select("id, label, created_at, last_used_at")
    .order("created_at");
  return (data ?? []) as any;
}

export async function removePasskey(id: string): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  await supabase.from("webauthn_credentials").delete().eq("id", id);
  revalidatePath("/settings");
  return { ok: true };
}
