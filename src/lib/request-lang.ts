import type { Lang } from "@/lib/locale";

/**
 * THE LANGUAGE BEFORE A SESSION EXISTS (cn-v1138). Sign-in, Set A Password's one-time door and the
 * errors those doors answer have no profile to read yet, so they speak the language the phone asks
 * for: the Accept-Language header's FIRST tag ("es-MX,es;q=0.9,en" is Spanish; "en-US,es" is
 * English), or the `?lang=` a link carries, which wins over the header when it names a language the
 * app speaks (the crew import stamps an es row's link, so a Spanish speaker on an English phone still
 * reads Spanish). Once a session exists the profile is the one source of truth (lib/lang-of).
 * Pure: a header in, a language out; never throws on a blank or odd header.
 */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  const first = String(header ?? "").split(",")[0].split(";")[0].trim().toLowerCase();
  return first === "es" || first.startsWith("es-") ? "es" : "en";
}

/** `?lang=es` (or `en`) on the link wins; anything else falls back to the header. */
export function langBeforeSession(query: string | null | undefined, header: string | null | undefined): Lang {
  const q = String(query ?? "").trim().toLowerCase();
  if (q === "es" || q === "en") return q;
  return langFromAcceptLanguage(header);
}
