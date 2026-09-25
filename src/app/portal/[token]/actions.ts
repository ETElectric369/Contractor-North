"use server";

import { cookies, headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { clientIp, rateLimited } from "@/lib/rate-limit";
import {
  IP_SENDS_PER_HOUR,
  IP_TRIES_PER_15_MIN,
  codeMatches,
  generateCode,
  hashCode,
  hashSecret,
  isSessionSecret,
  maskEmail,
  minutesUntil,
  newSalt,
  newSessionSecret,
  normalizeCode,
  type CheckRefusal,
  type SendRefusal,
} from "@/lib/portal/code";
import { deliverPortalCode } from "@/lib/portal/deliver-code";
import { PORTAL_COOKIE, isPortalToken, portalCookieOptions } from "@/lib/portal/session-cookie";

/**
 * THE PORTAL'S SIGN-IN, SERVER SIDE (0331). The link token is the only thing the page hands over;
 * the address a code goes to is read by the database off the customer's own row, never typed here.
 * Answers are reasons, not sentences: the sign-in screen says them in the business's name
 * (code-words), so the server and the page can't drift.
 */
export type SendCodeResult =
  | { ok: true; maskedEmail: string | null }
  | { ok: false; reason: SendRefusal; retryMinutes?: number };

export async function sendPortalCode(token: string): Promise<SendCodeResult> {
  if (!isPortalToken(token)) return { ok: false, reason: "no_link" };
  // Per-IP ceiling first. Fail CLOSED: this path sends email for anyone who holds a link.
  const ip = clientIp(await headers());
  if (await rateLimited(`portal-code-send:${ip}`, IP_SENDS_PER_HOUR, 3600, { failClosed: true })) {
    return { ok: false, reason: "busy" };
  }

  const code = generateCode();
  const salt = newSalt();
  const { data, error } = await createServiceClient().rpc("portal_code_issue", {
    p_token: token,
    p_channel: "email",
    p_salt: salt,
    p_hash: hashCode(code, salt),
  });
  if (error) {
    reportError("portal.codeIssue", error);
    return { ok: false, reason: "send_failed" };
  }
  const r = data as {
    ok?: boolean;
    reason?: string;
    retry_at?: string;
    code_id?: string;
    left_today?: number;
    customer_id?: string;
    channel?: "email" | "sms";
    to?: string;
    org?: { name?: string | null; phone?: string | null; email?: string | null; glass_tint?: string | null };
  } | null;
  if (!r?.ok) {
    const reason = (["no_link", "no_email", "too_many", "day_limit", "channel_unavailable"].includes(String(r?.reason))
      ? r!.reason
      : "send_failed") as SendRefusal;
    return reason === "too_many" || reason === "day_limit"
      ? { ok: false, reason, retryMinutes: minutesUntil(r?.retry_at) }
      : { ok: false, reason };
  }
  if (!r.to) {
    await voidCode(token, r.code_id);
    return { ok: false, reason: "send_failed" };
  }

  let sent: { ok: boolean; error?: string };
  try {
    sent = await deliverPortalCode({
      channel: r.channel ?? "email",
      to: r.to,
      code,
      org: { name: r.org?.name ?? "", phone: r.org?.phone, email: r.org?.email, glass_tint: r.org?.glass_tint },
    });
  } catch (e) {
    sent = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!sent.ok) {
    // Nothing silent: the office hears it (error_events), the customer reads "couldn't send". And the
    // code that never went out is taken back, so it doesn't cancel the one already in the inbox or
    // count toward the send limits.
    reportError("portal.codeSend", new Error(sent.error ?? "send failed"));
    await voidCode(token, r.code_id);
    return { ok: false, reason: "send_failed" };
  }
  if (r.left_today === 0) {
    // The day's last code for this link. Once a day at most: a customer being flooded with codes (or a
    // link someone is guessing at) is the office's to know about, never silent.
    reportError("portal.codeDayLimit", new Error("A portal link reached its daily limit of sign-in codes"), {
      customer_id: r.customer_id ?? null,
    });
  }
  return { ok: true, maskedEmail: maskEmail(r.to) };
}

/** Take back a code whose email didn't go out (0331 portal_code_void). Best effort: reported if it
 *  fails, and the customer still reads "couldn't send". */
async function voidCode(token: string, codeId: string | undefined): Promise<void> {
  if (!codeId) return;
  const { error } = await createServiceClient().rpc("portal_code_void", { p_token: token, p_code_id: codeId });
  if (error) reportError("portal.codeVoid", error);
}

export type CheckCodeResult = { ok: true } | { ok: false; reason: CheckRefusal; triesLeft?: number };

export async function checkPortalCode(token: string, typed: string): Promise<CheckCodeResult> {
  if (!isPortalToken(token)) return { ok: false, reason: "no_link" };
  const code = normalizeCode(typed);
  if (!code) return { ok: false, reason: "format" };
  const ip = clientIp(await headers());
  if (await rateLimited(`portal-code-try:${ip}`, IP_TRIES_PER_15_MIN, 900)) return { ok: false, reason: "busy" };

  const svc = createServiceClient();
  // The try is counted HERE, before the comparison, under the code's row lock (0331).
  const { data, error } = await svc.rpc("portal_code_try", { p_token: token });
  if (error) {
    reportError("portal.codeTry", error);
    return { ok: false, reason: "error" };
  }
  const t = data as { state?: string; code_id?: string; salt?: string; hash?: string; tries_left?: number } | null;
  if (t?.state !== "check" || !t.code_id || !t.salt || !t.hash) {
    const reason = (["expired", "used_up", "no_code", "no_link"].includes(String(t?.state)) ? t!.state : "error") as CheckRefusal;
    return { ok: false, reason };
  }
  if (!codeMatches(code, t.salt, t.hash)) return { ok: false, reason: "wrong", triesLeft: Math.max(0, Number(t.tries_left ?? 0)) };

  const secret = newSessionSecret();
  const { data: signedIn, error: redeemErr } = await svc.rpc("portal_code_redeem", {
    p_token: token,
    p_code_id: t.code_id,
    p_hash: hashCode(code, t.salt),
    p_session_hash: hashSecret(secret),
  });
  if (redeemErr) {
    reportError("portal.codeRedeem", redeemErr);
    return { ok: false, reason: "error" };
  }
  // Spent between the try and now (a second tab, a new code sent): say so, never a silent no.
  if (signedIn !== true) return { ok: false, reason: "spent" };
  (await cookies()).set(PORTAL_COOKIE, secret, portalCookieOptions(token));
  return { ok: true };
}

/** Sign Out on this device: the session ends in the database and the cookie goes. */
export async function signOutPortal(token: string): Promise<{ ok: boolean }> {
  if (!isPortalToken(token)) return { ok: false };
  const jar = await cookies();
  const secret = jar.get(PORTAL_COOKIE)?.value;
  if (isSessionSecret(secret)) {
    const { error } = await createServiceClient().rpc("portal_session_end", { p_token: token, p_session_hash: hashSecret(secret) });
    if (error) {
      reportError("portal.signOut", error);
      return { ok: false };
    }
  }
  jar.set(PORTAL_COOKIE, "", portalCookieOptions(token, 0));
  return { ok: true };
}
