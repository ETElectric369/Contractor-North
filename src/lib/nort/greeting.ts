/**
 * NORT SPEAKS FIRST (Erik, 2026-10-13; 0394). The greeting IS the ready signal: it plays the
 * instant the mic stream is live, so the person knows they can talk — they used to wait an
 * unknown time, often driving. The words are Nort's, short, picked here on the phone (no model
 * call, no synthesis at open: lib/nort/greeting-player keeps each phrase's clip), by the time of
 * day and what the person asked to be called.
 *
 * WHEN NORT IS HOLDING SOMETHING he names it and asks ONE precise question. Erik: "if Nort says
 * 'good time?' then i will have to respond 'a good time for what?' … lets be clear, precise and
 * to the point." So: "I've got Brian's daily report and two updates on things you reported —
 * want them now?" Never "good time?", never the contents until they say yes.
 */
import { fillText, translator, type Lang } from "@/lib/i18n";

export type NortHolding = {
  /** Resolved bug reports of theirs they have not heard about yet. */
  reports: number;
  /** Crew-lead daily reports (the office's) not yet read, by who filed them. */
  dailyReports: { from: string }[];
  /**
   * Named when ANY held report is weeks old: the month the oldest was FILED ("July",
   * "July 2025"). Erik, the first night: "all of the things that you just mentioned to me are
   * old" — eight fixes he had reported weeks before, read as if they were news. An old update is
   * still his to hear, but the greeting says how far back the filing goes so he can skip it.
   */
  reportsBack?: string;
};

export const NO_HOLDING: NortHolding = { reports: 0, dailyReports: [] };

export function holdingCount(h: NortHolding | null | undefined): number {
  return (h?.reports ?? 0) + (h?.dailyReports.length ?? 0);
}

/** The small counts as words: "two daily reports", "dos reportes diarios". A report is masculine and
 *  an update feminine in Spanish ("un reporte", "una actualización"), so Spanish has a word for each. */
const SMALL: Record<Lang, { m: readonly string[]; f: readonly string[] }> = {
  en: {
    m: ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
    f: ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
  },
  es: {
    m: ["", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"],
    f: ["", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"],
  },
};
const countWord = (n: number, lang: Lang, gender: "m" | "f"): string => {
  const words = SMALL[lang]?.[gender] ?? SMALL.en.m;
  return n < words.length ? words[n] : String(n);
};

/** "Brian's daily report", "two daily reports", "three updates on things you reported", joined —
 *  in the person's language (cn-v1138; the chat route's prompt and the Bell read the English). */
export function holdingWords(h: NortHolding | null | undefined, lang: Lang = "en"): string | null {
  if (!h || holdingCount(h) === 0) return null;
  const t = translator(lang);
  const parts: string[] = [];
  const d = h.dailyReports;
  if (d.length === 1) parts.push(fillText(t("nt_dailyReportOf"), { from: d[0].from }));
  else if (d.length === 2) parts.push(fillText(t("nt_dailyReportsOfTwo"), { a: d[0].from, b: d[1].from }));
  else if (d.length > 2) parts.push(fillText(t("nt_dailyReportsN"), { n: countWord(d.length, lang, "m") }));
  if (h.reports > 0) {
    const back = h.reportsBack ? fillText(t(h.reports === 1 ? "nt_filedIn" : "nt_filedBack"), { month: h.reportsBack }) : "";
    parts.push(fillText(t(h.reports === 1 ? "nt_updateOne" : "nt_updatesMany"), { n: countWord(h.reports, lang, "f") }) + back);
  }
  return parts.join(t("nt_and"));
}

/** "it" for one thing, "them" for more. */
export function holdingPronoun(h: NortHolding | null | undefined): "it" | "them" {
  return holdingCount(h) === 1 ? "it" : "them";
}

/** The first word of a full name, or null. */
export function firstName(full: string | null | undefined): string | null {
  const w = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return w ? w : null;
}

/** What Nort calls this person: their chosen name, else their first name, else nothing. */
export function callName(nortName: string | null | undefined, fullName: string | null | undefined): string | null {
  const n = (nortName ?? "").trim();
  return n ? Array.from(n).slice(0, 40).join("") : firstName(fullName);
}

/** An electrician at 4:30 is starting his day, not ending one: the small hours are "early". */
export function timeOfDay(hour: number): "early" | "morning" | "afternoon" | "evening" {
  if (hour >= 0 && hour < 5) return "early";
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

/**
 * The line Nort speaks when the mic is live. Short on purpose: the person is about to talk.
 *   "Morning, Erik. What do you need?"
 *   "Evening, Boss. I've got Brian's daily report — want it now?"
 *   "Buenos días, Luis. ¿Qué necesitas?"  (lang "es", cn-v1138 — the words are the catalog's, lib/words/nort)
 * Nort's name and the person's are the same in both; so are the clip keys (greeting-player keys a
 * clip by its text, so a Spanish phrase gets its own clip and never replays an English one).
 */
export function greetingPhrase(opts: { hour: number; name: string | null; holding?: NortHolding | null; lang?: Lang }): string {
  const lang = opts.lang ?? "en";
  const t = translator(lang);
  const tod = timeOfDay(opts.hour);
  const hello = tod === "morning" ? t("nt_greetMorning") : tod === "evening" ? t("nt_greetEvening") : t("nt_greetHey");
  const who = opts.name ? `${hello}, ${opts.name}.` : `${hello}.`;
  const words = holdingWords(opts.holding, lang);
  if (words) return `${who} ${fillText(t(holdingCount(opts.holding) === 1 ? "nt_greetHoldingOne" : "nt_greetHoldingMany"), { words })}`;
  return `${who} ${t("nt_greetAsk")}`;
}

/** Bump when the voice or the phrasing changes, so every phone re-synthesizes its clips once. */
export const GREETING_CLIP_V = 1;
