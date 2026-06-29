import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Server-side speech-to-text for the assistant's hands-free voice loop. The browser records a turn's
 * audio (getUserMedia stays alive across turns, so iOS doesn't need a tap per turn) and POSTs the blob
 * here; we hand it to OpenAI Whisper and return the transcript. Uses the same OPENAI_API_KEY the TTS
 * fallback already uses, so no new provisioning.
 */
export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "Transcription not configured." }, { status: 503 });

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
  const oa = new FormData();
  oa.append("file", audio, name);
  oa.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
  oa.append("language", "en");
  oa.append("response_format", "json");

  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: oa,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json({ error: `Transcribe failed: ${t.slice(0, 160)}` }, { status: 502 });
    }
    const j = await r.json();
    return NextResponse.json({ text: String(j?.text ?? "").trim() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Transcribe error." }, { status: 502 });
  }
}
