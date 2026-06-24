// Neural text-to-speech so Claude speaks with a real, intelligence-grade voice instead of
// the OS robot. ElevenLabs is preferred (best quality + supports a cloned voice — Erik's
// "hero's voice"); OpenAI is the simpler fallback. Returns mp3 audio. 503 if neither key
// is set, which tells the client to fall back to the browser voice.

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  let text = "";
  try {
    text = String((await req.json())?.text ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  text = text.trim().slice(0, 800); // bound cost/latency
  if (!text) return new Response("No text", { status: 400 });

  // ElevenLabs — set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (a library voice id or a
  // cloned one you have rights to).
  const elKey = process.env.ELEVENLABS_API_KEY;
  const elVoice = process.env.ELEVENLABS_VOICE_ID;
  if (elKey && elVoice) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoice}`, {
      method: "POST",
      headers: { "xi-api-key": elKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5" }),
    });
    if (!r.ok || !r.body) return new Response("TTS failed", { status: 502 });
    return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  // OpenAI — set OPENAI_API_KEY (voice via OPENAI_TTS_VOICE, default a warm natural one).
  const oaKey = process.env.OPENAI_API_KEY;
  if (oaKey) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${oaKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "tts-1",
        voice: process.env.OPENAI_TTS_VOICE || "nova",
        input: text,
        response_format: "mp3",
      }),
    });
    if (!r.ok || !r.body) return new Response("TTS failed", { status: 502 });
    return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }

  return new Response("No neural TTS provider configured", { status: 503 });
}
