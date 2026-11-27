import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * IS THIS THE PERSON'S CURRENT PASSWORD? (cn-v1203). Settings › You › Change My Password asks for the
 * current password, and set-password/actions updateMyPassword checks it here before any save.
 *
 * THE PROBE IS A SEPARATE CLIENT, built from the same two env names lib/supabase/server.ts reads, with
 * no session kept: persistSession false keeps whatever it signs in with in memory only (auth-js
 * GoTrueClient: a memoryLocalStorageAdapter, no localStorage, no cookie), and it never touches the
 * caller's cookies or the SSR client. It sends exactly what was typed, one password sign-in. On a
 * match the probe's own new session is ended at once with signOut({ scope: "local" }) on the probe
 * client, which revokes only that one session on the server. A failure there is ignored. What that
 * leaves (cn-v1203, said true after skeptic #100): when the save then succeeds, the action's
 * sign-out of the person's other sessions ends the probe's session too; when the save is refused
 * (same, weak, too long), that session stays on the auth server until it expires, but its tokens
 * were only ever in this function's memory and are gone with it, so nobody can use it.
 *
 * ANSWERS: "ok" (it signed in); "wrong" (the auth server's invalid_credentials, and ONE fallback for
 * a server that names no code: no code at all, status 400 and the message "Invalid login
 * credentials", any letter case); "unknown" for anything else, every other 400 included
 * (email_not_confirmed, validation_failed, a 400 with no code and another message), a throw or
 * missing env too, with the code and status when there are any. It
 * never throws, logs nothing and reports nothing: neither the password nor the email leaves this
 * function except in that one request. The caller decides what to say and what to report.
 */
export type PasswordCheck = { result: "ok" | "wrong" | "unknown"; code: string | null; status: number | null };

export async function checkCurrentPassword(email: string, password: string): Promise<PasswordCheck> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { result: "unknown", code: null, status: null };
  try {
    const probe = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await probe.auth.signInWithPassword({ email, password });
    if (!error) {
      try {
        await probe.auth.signOut({ scope: "local" });
      } catch {
        // Ignored: a saved password's sign-out of the other sessions ends this one; a refused save
        // leaves it to expire, its tokens already gone with this function's memory.
      }
      return { result: "ok", code: null, status: null };
    }
    const o = error as { code?: unknown; status?: unknown; message?: unknown };
    const code = o.code == null || o.code === "" ? null : String(o.code);
    const status = typeof o.status === "number" ? o.status : null;
    if (code === "invalid_credentials") return { result: "wrong", code, status };
    // The one fallback (cn-v1203): a server that names no code, 400, and exactly its wrong-password sentence.
    if (code === null && status === 400 && typeof o.message === "string" && o.message.trim().toLowerCase() === "invalid login credentials") {
      return { result: "wrong", code, status };
    }
    return { result: "unknown", code, status };
  } catch (e) {
    const o = (e ?? {}) as { code?: unknown; status?: unknown };
    return {
      result: "unknown",
      code: o.code == null || o.code === "" ? null : String(o.code),
      status: typeof o.status === "number" ? o.status : null,
    };
  }
}
