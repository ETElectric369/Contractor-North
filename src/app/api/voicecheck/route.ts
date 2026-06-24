// Temporary, token-gated, PUBLIC diagnostic so the dev can confirm — without a logged-in
// session — whether the neural-TTS key actually works. It only makes a 5-character test
// call and reports the upstream status; no audio, no secrets returned. Delete once the
// "still robotic" issue is resolved.

export const runtime = "nodejs";
export const maxDuration = 30;

const TOKEN = "cn-voicecheck-7f3a9c2e"; // server-only; not shipped to the client bundle

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return new Response("nope", { status: 404 });
  }
  const elKey = process.env.ELEVENLABS_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;
  const out: any = {
    provider: elKey ? "elevenlabs" : oaKey ? "openai" : "NONE",
    elevenLabsKeyPresent: !!elKey,
    openAiKeyPresent: !!oaKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM (default Rachel)",
    model: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
  };
  try {
    if (elKey) {
      const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
        method: "POST",
        headers: { "xi-api-key": elKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: "Test.", model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
      });
      out.status = r.status;
      out.contentType = r.headers.get("content-type");
      out.ok = r.ok;
      if (!r.ok) out.error = (await r.text().catch(() => "")).slice(0, 500);
    } else if (oaKey) {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${oaKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: process.env.OPENAI_TTS_VOICE || "nova", input: "Test." }),
      });
      out.status = r.status;
      out.ok = r.ok;
      if (!r.ok) out.error = (await r.text().catch(() => "")).slice(0, 500);
    }
  } catch (e: any) {
    out.threw = String(e?.message || e).slice(0, 500);
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
}
