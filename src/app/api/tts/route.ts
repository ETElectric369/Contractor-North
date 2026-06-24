// Neural text-to-speech so Claude speaks with a real, intelligence-grade voice instead of
// the OS robot. ElevenLabs is preferred (best quality + supports a cloned voice — Erik's
// "hero's voice"); OpenAI is the simpler fallback. Returns mp3 audio. 503 if neither key
// is set, which tells the client to fall back to the browser voice.

export const runtime = "nodejs";
export const maxDuration = 30;

/** GET /api/tts?diag=1 — a human-readable check (open it in the browser while logged in).
 *  Tells us which provider is configured and whether a real test call actually works, so a
 *  "still robotic" report is server-vs-client decidable without log spelunking. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("diag") !== "1") {
    return new Response("POST text here, or GET ?diag=1 to check config.", { status: 200 });
  }
  const elKey = process.env.ELEVENLABS_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;
  const out: any = {
    provider: elKey ? "elevenlabs" : oaKey ? "openai" : "NONE — no key set",
    elevenLabsKeyPresent: !!elKey,
    openAiKeyPresent: !!oaKey,
  };
  try {
    if (elKey) {
      const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": elKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: "Test.", model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
      });
      out.testCall = {
        ok: r.ok,
        status: r.status,
        contentType: r.headers.get("content-type"),
        error: r.ok ? null : (await r.text().catch(() => "")).slice(0, 400),
      };
      out.verdict = r.ok
        ? "✅ KEY WORKS — the voice is being blocked on the device (iOS audio), not the key."
        : `❌ KEY/REQUEST REJECTED by ElevenLabs (HTTP ${r.status}) — see error. Likely the key lacks Text-to-Speech permission, or quota is exhausted.`;
    } else if (oaKey) {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${oaKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE || "nova", input: "Test." }),
      });
      out.testCall = { ok: r.ok, status: r.status, error: r.ok ? null : (await r.text().catch(() => "")).slice(0, 400) };
      out.verdict = r.ok ? "✅ KEY WORKS — device-side audio is the issue." : `❌ OpenAI rejected (HTTP ${r.status}).`;
    } else {
      out.verdict = "❌ No ELEVENLABS_API_KEY or OPENAI_API_KEY is set on this deployment.";
    }
  } catch (e: any) {
    out.testCall = { ok: false, error: String(e?.message || e).slice(0, 400) };
    out.verdict = "❌ The test call threw before getting a response.";
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
}

export async function POST(req: Request) {
  let text = "";
  try {
    text = String((await req.json())?.text ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  text = text.trim().slice(0, 800); // bound cost/latency
  if (!text) return new Response("No text", { status: 400 });

  // ElevenLabs — just set ELEVENLABS_API_KEY (the voice defaults to Rachel; override with
  // ELEVENLABS_VOICE_ID for a library pick or a cloned 'hero' voice you have rights to).
  const elKey = process.env.ELEVENLABS_API_KEY;
  if (elKey) {
    const elVoice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
    // Flash = ~75ms (ElevenLabs' real-time model); output_format is a QUERY param; the
    // smaller 64kbps mp3 halves the payload with no audible loss on a voice read-back.
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${elVoice}?output_format=mp3_44100_64`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": elKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 1.0 },
      }),
    });
    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("[tts] ElevenLabs failed:", r.status, detail.slice(0, 300));
      return new Response("TTS failed", { status: 502 });
    }
    return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  // OpenAI — set OPENAI_API_KEY (voice via OPENAI_TTS_VOICE, default a warm natural one).
  const oaKey = process.env.OPENAI_API_KEY;
  if (oaKey) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${oaKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: process.env.OPENAI_TTS_VOICE || "nova",
        input: text,
        // Steers tone — only honored by gpt-4o-mini-tts (ignored by tts-1).
        instructions: "Speak in a warm, calm, confident, natural conversational tone, like a helpful colleague. Relaxed pacing, clear enunciation; never robotic or rushed.",
        response_format: "mp3",
      }),
    });
    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("[tts] OpenAI failed:", r.status, detail.slice(0, 300));
      return new Response("TTS failed", { status: 502 });
    }
    return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  return new Response("No neural TTS provider configured", { status: 503 });
}
