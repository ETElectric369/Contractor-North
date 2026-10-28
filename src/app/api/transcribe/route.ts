import { NextResponse } from "next/server";
import { voiceGate } from "@/lib/voice-gate";
import { reportError } from "@/lib/observe";
import { createClient } from "@/lib/supabase/server";
import { translator } from "@/lib/i18n";
import { profileLang, sttCodes, transcribeLang } from "./lang";

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
 *
 * PLAIN WORDS OUT (Wave 0): the person talking sees `error` (use-dictation shows it), so it never
 * names a provider, a key or a status code. The provider's own reply goes to reportError instead.
 *
 * IN THE PERSON'S LANGUAGE (cn-v1138): the profile says which language is being spoken (./lang —
 * the profile wins over any `lang` field the client sent, and nothing is ever auto-detected), Scribe
 * and Whisper are told it outright, and the words back are in it too. The gate already proved the
 * session; the profile read is the one more trip the language needs.
 */
export async function POST(req: Request) {
  const gate = await voiceGate("stt", 90);
  if (gate) return gate;
  const stored = await profileLang(await createClient());
  let t = translator(stored ?? "en");
  const elKey = process.env.ELEVENLABS_API_KEY;
  const oaKey = process.env.OPENAI_API_KEY;
  if (!elKey && !oaKey) {
    return NextResponse.json({ error: t("nt_voiceUnavailable") }, { status: 503 });
  }

  let audio: Blob | null = null;
  let field: unknown = null;
  try {
    const form = await req.formData();
    const a = form.get("audio");
    if (a instanceof Blob) audio = a;
    field = form.get("lang");
  } catch {
    return NextResponse.json({ error: t("nt_badUpload") }, { status: 400 });
  }
  const lang = transcribeLang(stored, field);
  t = translator(lang);
  const codes = sttCodes(lang);
  const HEAR_FAIL = t("nt_hearFail");
  if (!audio || audio.size < 800) return NextResponse.json({ text: "" });
  const name = (audio as any).name || "turn.webm";

  // 1) ElevenLabs Scribe — uses the key already set for TTS, so no new provisioning.
  if (elKey) {
    try {
      const fd = new FormData();
      fd.append("file", audio, name);
      fd.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1");
      // NEVER auto-detect: the language is the profile's (./lang), told to Scribe outright. Auto-detect
      // was guessing Portuguese on noisy audio, and a Spanish speaker heard as English would be the
      // same wrong guess the other way; so it is always named, never omitted.
      fd.append("language_code", codes.elevenlabs);
      fd.append("tag_audio_events", "false"); // don't emit "(applause)" / "(sound of water)" sound-effect tags
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
      reportError("transcribe.elevenlabs", new Error(`ElevenLabs STT ${r.status}: ${t.slice(0, 160)}`));
      if (!oaKey) return NextResponse.json({ error: HEAR_FAIL }, { status: 502 });
      // else fall through to OpenAI
    } catch (e: any) {
      reportError("transcribe.elevenlabs", e);
      if (!oaKey) return NextResponse.json({ error: HEAR_FAIL }, { status: 502 });
    }
  }

  // 2) OpenAI Whisper fallback.
  if (oaKey) {
    const oa = new FormData();
    oa.append("file", audio, name);
    oa.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
    oa.append("language", codes.whisper); // the profile's language, never guessed (see Scribe above)
    oa.append("response_format", "json");
    try {
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${oaKey}` },
        body: oa,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        reportError("transcribe.whisper", new Error(`Whisper ${r.status}: ${t.slice(0, 160)}`));
        return NextResponse.json({ error: HEAR_FAIL }, { status: 502 });
      }
      const j = await r.json();
      return NextResponse.json({ text: String(j?.text ?? "").trim() });
    } catch (e: any) {
      reportError("transcribe.whisper", e);
      return NextResponse.json({ error: HEAR_FAIL }, { status: 502 });
    }
  }

  return NextResponse.json({ error: HEAR_FAIL }, { status: 502 });
}
