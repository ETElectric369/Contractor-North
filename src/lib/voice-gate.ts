import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimited } from "@/lib/rate-limit";
import { orgAccess } from "@/lib/org-access";
import { nortPausedWords } from "@/lib/lapse-words";
import { reportError } from "@/lib/observe";

/**
 * THE VOICE ENDPOINTS' GATE — /api/tts and /api/transcribe. Middleware already answers /api/*
 * without a session with a 401, but a rule at ONE layer is a convention, not a boundary (0173):
 * the routes check the session themselves. And nothing bounded spend per PERSON before — each
 * call is a paid ElevenLabs/OpenAI request, so a runaway client (or a leaked cookie) could bill
 * without limit. Per-user window; 429 says so out loud.
 *
 * AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3): a lapsed company gets no voice either way —
 * TTS and STT both ride this gate — answered 402 in the asker's words (orgAccess, which fails
 * OPEN on a failed read or with billing off). The profile read is one cheap trip before a paid one;
 * when IT fails the failure is filed and the gate falls open the same way (no company id, no
 * standing to refuse on) — a blip on a profile read must never silence a person's voice (skeptic
 * #43, N7).
 */
export async function voiceGate(kind: "tts" | "stt", maxPer10Min: number): Promise<Response | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Your session expired — please sign in again.", { status: 401 });
  if (await rateLimited(`${kind}:${user.id}`, maxPer10Min, 600)) {
    return new NextResponse("Too many voice requests in a row — give it a minute.", { status: 429 });
  }
  const { data: me, error: meErr } = await supabase.from("profiles").select("org_id, role").eq("id", user.id).maybeSingle();
  if (meErr) reportError("voice-gate:profile-read", meErr, { userId: user.id });
  const p = (meErr ? null : (me ?? null)) as { org_id?: string | null; role?: string | null } | null;
  const access = await orgAccess(p?.org_id);
  if (!access.state.active) {
    return new NextResponse(await nortPausedWords(access.state, p?.role, p?.org_id), { status: 402 });
  }
  return null;
}
