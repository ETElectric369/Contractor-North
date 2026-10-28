import { asLang, type Lang } from "@/lib/locale";

/**
 * WHICH LANGUAGE THE TRANSCRIBER LISTENS FOR (cn-v1138). profiles.language is the one source of
 * truth, read on the signed-in session: a `lang` form field the client sends rides along
 * (voice-stream passes the page's) but never beats it — a stale bundle or a forged field must not
 * make Scribe hear a Spanish speaker as English. The field decides only when the profile has no
 * answer (no row, a failed read, a blank column); with neither, English. NEVER auto-detected: the
 * audio is noisy (a truck cab), and auto-detect guessed Portuguese on it.
 *
 * A plain module beside the route, because a route file exports only handlers and segment config.
 */
export type ProfileLang = Lang | null;

type Client = {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  from: (table: string) => any;
};

/** profiles.language for the signed-in person: "en" | "es", or null when there is no answer. */
export async function profileLang(sb: Client): Promise<ProfileLang> {
  try {
    const user = (await sb.auth.getUser())?.data?.user;
    if (!user?.id) return null;
    const { data, error } = await sb.from("profiles").select("language").eq("id", user.id).limit(1).maybeSingle();
    if (error) return null;
    const v = (data as { language?: string | null } | null)?.language;
    return v === "es" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

/** The profile wins; the field decides only when the profile gave no answer; else English.
 *  A BCP-47 field ("es-US") counts by its language part. */
export function transcribeLang(profile: ProfileLang, field: unknown): Lang {
  if (profile) return profile;
  return asLang(typeof field === "string" ? field.trim().toLowerCase().slice(0, 2) : field);
}

/** The provider codes for a language: ElevenLabs Scribe takes ISO 639-3, Whisper ISO 639-1. */
export function sttCodes(lang: Lang): { elevenlabs: "spa" | "eng"; whisper: "es" | "en" } {
  return lang === "es" ? { elevenlabs: "spa", whisper: "es" } : { elevenlabs: "eng", whisper: "en" };
}
