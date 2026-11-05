import type { Lang } from "@/lib/locale";

/**
 * A REFUSAL IS AN ANSWER, SAID ONE WAY AT EVERY DOOR (cn-v1142, the SDK half).
 *
 * On the 5.5 line a request the safety classifiers decline comes back as a SUCCESSFUL HTTP 200
 * with `stop_reason: "refusal"`: the content is empty (declined before any output) or partial
 * (declined mid-stream). Nothing throws, so a door that reads `content[0].text` unguarded
 * parses nothing and says "the reader didn't answer" — or worse, treats a partial as whole.
 * The rule from the docs: branch on `stop_reason`, never on `stop_details` (informational,
 * and null even on some refusals); discard a partial rather than treating it as complete.
 *
 * Three names, so every door says the same thing:
 *   refused(message)      — the one check, before reading content.
 *   refusalWords(lang)    — Nort's sentence for it, in the asker's language.
 *   saidFailure(kind)     — the JSON doors' envelope ({ ok: false, error }, the shape every
 *                           reader returns today: organize, the panel reads, the vendor list
 *                           read, the site designer) with the words for what the model did.
 */

/** Anything that carries a stop reason: an SDK Message, a beta message, a stream's final message. */
export type StopReasonCarrier = { stop_reason?: string | null } | null | undefined;

/** True only when the model declined (stop_reason "refusal"). A missing message is not a refusal. */
export function refused(message: StopReasonCarrier): boolean {
  return message?.stop_reason === "refusal";
}

/** Nort's words for a refusal. One plain sentence, no apology, no category: the person asked for
 *  something Nort won't do, and the next move is theirs. */
export function refusalWords(lang: Lang = "en"): string {
  return lang === "es" ? "Nort no puede ayudar con eso." : "Nort can't help with that one.";
}

/**
 * A REFUSAL THAT HAS TO TRAVEL AS A THROW (parseAiJson's repair round trip declined): typed, so every
 * caller that reports errors can tell it from a fault and SAY it (its message is refusalWords), never
 * file it in error_events. `reason` matches saidFailure's.
 */
export class AiRefusedError extends Error {
  readonly reason = "refused" as const;
  constructor(lang: Lang = "en") {
    super(refusalWords(lang));
    this.name = "AiRefusedError";
  }
}

/** True for an AiRefusedError (by class, or by name across a module boundary). */
export function isAiRefused(e: unknown): e is AiRefusedError {
  return e instanceof AiRefusedError || (e instanceof Error && e.name === "AiRefusedError");
}

/** What the model did instead of answering: declined, ran past max_tokens, or answered in a
 *  shape the door could not parse. */
export type FailureKind = "refused" | "cut_off" | "unreadable";

/** The JSON doors' failure envelope, with `reason` for a caller that branches on it. */
export type SaidFailure = { ok: false; error: string; reason: FailureKind };

const FAILURE_WORDS: Record<FailureKind, Record<Lang, string>> = {
  refused: { en: "Nort can't help with that one.", es: "Nort no puede ayudar con eso." },
  cut_off: {
    en: "The answer ran past what one read can hold. Try a smaller piece.",
    es: "La respuesta pasó de lo que cabe en una lectura. Prueba con una parte más pequeña.",
  },
  unreadable: {
    en: "Nort answered, but not in a form the app could read. Try again.",
    es: "Nort respondió, pero no en una forma que la app pudiera leer. Inténtalo de nuevo.",
  },
};

/** The failure a JSON door returns, shaped the way its callers already read one. */
export function saidFailure(kind: FailureKind, lang: Lang = "en"): SaidFailure {
  return { ok: false, error: FAILURE_WORDS[kind][lang === "es" ? "es" : "en"], reason: kind };
}
