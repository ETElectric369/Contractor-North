import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimited } from "@/lib/rate-limit";

/**
 * THE VOICE ENDPOINTS' GATE — /api/tts and /api/transcribe. Middleware already answers /api/*
 * without a session with a 401, but a rule at ONE layer is a convention, not a boundary (0173):
 * the routes check the session themselves. And nothing bounded spend per PERSON before — each
 * call is a paid ElevenLabs/OpenAI request, so a runaway client (or a leaked cookie) could bill
 * without limit. Per-user window; 429 says so out loud.
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
  return null;
}
