import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Server-side speech-to-text for Nort's hands-free voice loop. The browser records a turn's audio
 * (getUserMedia stays alive across turns, so iOS doesn't need a tap per turn) and POSTs the blob here.
 *
 * PROVIDER ORDER — ElevenLabs FIRST: its key (ELEVENLABS_API_KEY) is already provisioned for the TTS
 * voice, so transcription works with NO new setup. OpenAI Whisper is the fallback if an OPENAI_API_KEY
 * happens to be set. (The original version only used Whisper, so on a deploy with just the ElevenLabs
 * key it 503'd → "transcription error".)
 */
export async function POST(req: Request) {
  const elKey = process.env.ELEVENLABS_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;
  if (!elKey && !oaKey) {
    return NextResponse.json({ error: "Transcription not configured (no ElevenLabs or OpenAI key)." }, { status: 503 });
  }

  let audio: Blob | null = null;
  try {
    const form = await req.formData();
    const a = form.get("audio");
    if (a instanceof Blob) audio = a;
  } catch {
    return NextResponse.json({ error: "Bad upload." }, { status: 400 });
  }
  if (!audio || audio.size < 800) return NextResponse.json({ text: "" });
  const name = (audio as any).name || "turn.webm";

  // 1) ElevenLabs Scribe — uses the key already set for TTS, so no new provisioning.
  if (elKey) {
    try {
      const fd = new FormData();
      fd.append("file", audio, name);
      fd.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1");
      const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": elKey },
        body: fd,
      });
      if (r.ok) {
        const j = await r.json();
        return NextResponse.json({ text: String(j?.text ?? "").trim() });
      }
      const t = await r.text().catch(() => "");
      if (!oaKey) return NextResponse.json({ error: `ElevenLabs STT ${r.status}: ${t.slice(0, 160)}` }, { status: 502 });
      // else fall through to OpenAI
    } catch (e: any) {
      if (!oaKey) return NextResponse.json({ error: `ElevenLabs STT: ${e?.message ?? "error"}` }, { status: 502 });
    }
  }

  // 2) OpenAI Whisper fallback.
  if (oaKey) {
    const oa = new FormData();
    oa.append("file", audio, name);
    oa.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
    oa.append("language", "en");
    oa.append("response_format", "json");
    try {
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${oaKey}` },
        body: oa,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return NextResponse.json({ error: `Whisper ${r.status}: ${t.slice(0, 160)}` }, { status: 502 });
      }
      const j = await r.json();
      return NextResponse.json({ text: String(j?.text ?? "").trim() });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? "Transcribe error." }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Transcription failed." }, { status: 502 });
}
