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

const SMALL = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number, one: string, many: string) => `${n < SMALL.length ? SMALL[n] : String(n)} ${n === 1 ? one : many}`;

/** "Brian's daily report", "two daily reports", "three updates on things you reported", joined. */
export function holdingWords(h: NortHolding | null | undefined): string | null {
  if (!h || holdingCount(h) === 0) return null;
  const parts: string[] = [];
  const d = h.dailyReports;
  if (d.length === 1) parts.push(`${d[0].from}'s daily report`);
  else if (d.length === 2) parts.push(`${d[0].from}'s and ${d[1].from}'s daily reports`);
  else if (d.length > 2) parts.push(count(d.length, "daily report", "daily reports"));
  if (h.reports > 0)
    parts.push(
      `${count(h.reports, "update", "updates")} on things you reported${
        h.reportsBack ? (h.reports === 1 ? `, filed in ${h.reportsBack}` : `, filed as far back as ${h.reportsBack}`) : ""
      }`,
    );
  return parts.join(" and ");
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
 */
export function greetingPhrase(opts: { hour: number; name: string | null; holding?: NortHolding | null }): string {
  const tod = timeOfDay(opts.hour);
  const hello = tod === "morning" ? "Morning" : tod === "evening" ? "Evening" : "Hey";
  const who = opts.name ? `${hello}, ${opts.name}.` : `${hello}.`;
  const words = holdingWords(opts.holding);
  if (words) return `${who} I've got ${words} — want ${holdingPronoun(opts.holding)} now?`;
  return `${who} What do you need?`;
}

/** Bump when the voice or the phrasing changes, so every phone re-synthesizes its clips once. */
export const GREETING_CLIP_V = 1;
