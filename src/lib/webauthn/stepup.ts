import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { getRpConfig, b64urlToBytes, actionHash } from "./server";
import { requiresStepUp } from "@/lib/actions/risk";
import type { ActionDef, ActionResult } from "@/lib/actions/types";

const TTL_MS = 5 * 60_000;

export type StepUpOutcome =
  | { kind: "skip" } // not a money action, or the user has no passkey → fall back to the confirm gate
  | { kind: "pass" } // a fresh assertion verified → proceed
  | { kind: "block"; result: ActionResult }; // needs the step-up, or a verification failure

/**
 * The unforgeable gate (framework C2). A MONEY action (confirm:'financial' or an explicit
 * tier-2+) invoked by the AGENT or VOICE, when the caller has enrolled a passkey, must
 * carry a FRESH WebAuthn assertion bound to THIS action+input — a Face ID / Touch ID tap
 * the AI cannot produce. Not enrolled → "skip" (the confirm read-back still applies).
 */
export async function stepUpGate(
  userId: string,
  def: ActionDef,
  input: unknown,
  source: "ui" | "voice" | "agent",
  assertion: unknown | undefined,
): Promise<StepUpOutcome> {
  if (!requiresStepUp(def) || source === "ui") return { kind: "skip" };

  const supabase = await createClient();
  const { data: creds } = await supabase
    .from("webauthn_credentials")
    .select("id, credential_id, public_key, counter, transports")
    .eq("user_id", userId);
  // Step-up is MANDATORY for money movement — a no-passkey caller is BLOCKED (never waved
  // through to a spoken-yes confirm), so the unforgeable invariant can't be opted out of.
  if (!creds || creds.length === 0) {
    return {
      kind: "block",
      result: { ok: false, error: "Enroll Face ID (Settings → Profile → Sign-in & security) before doing this by voice or assistant." },
    };
  }

  const hash = await actionHash(def.name, input);

  if (assertion) {
    const a = assertion as { id?: string };
    // ATOMIC single-use claim: delete-RETURNING so two concurrent replays of the same
    // assertion can't both pass before a separate delete commits (the counter is no
    // replay defense for platform passkeys that report counter=0). The second caller's
    // claim returns no row → blocked.
    const { data: ch } = await supabase
      .from("webauthn_challenges")
      .delete()
      .eq("user_id", userId)
      .select("challenge, purpose, action_hash, created_at")
      .maybeSingle();
    if (!ch || ch.purpose !== "stepup" || ch.action_hash !== hash) {
      return { kind: "block", result: { ok: false, error: "That confirmation didn't match this action." } };
    }
    if (Date.now() - new Date(ch.created_at).getTime() > TTL_MS) {
      return { kind: "block", result: { ok: false, error: "That confirmation expired — try again." } };
    }
    const cred = (creds as any[]).find((c) => c.credential_id === a.id);
    if (!cred) return { kind: "block", result: { ok: false, error: "Unknown passkey." } };

    const { rpID, origin } = await getRpConfig();
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: assertion as any,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.credential_id,
          publicKey: b64urlToBytes(cred.public_key) as Uint8Array<ArrayBuffer>,
          counter: Number(cred.counter),
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
    } catch (e: any) {
      return { kind: "block", result: { ok: false, error: e?.message ?? "Could not verify your passkey." } };
    }
    if (!v.verified) return { kind: "block", result: { ok: false, error: "Could not verify your passkey." } };

    // The challenge was already consumed by the atomic claim above. Bump the counter for
    // authenticators that report one (no-op for counter=0 platform passkeys).
    await supabase
      .from("webauthn_credentials")
      .update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
      .eq("id", cred.id);
    return { kind: "pass" };
  }

  // No assertion yet → issue an action-bound challenge and ask for the tap.
  const { rpID } = await getRpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: (creds as any[]).map((c) => ({ id: c.credential_id, transports: c.transports })),
    userVerification: "required",
  });
  await supabase
    .from("webauthn_challenges")
    .upsert({ user_id: userId, challenge: options.challenge, purpose: "stepup", action_hash: hash, created_at: new Date().toISOString() });
  return { kind: "block", result: { ok: false, needsStepUp: true, stepUpOptions: options, error: `${def.label} needs your Face ID.` } };
}
