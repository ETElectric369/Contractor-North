import { esMeridiem, fillSlots, type Words } from "@/lib/lang-words";
import { localeOf } from "@/lib/locale";

/**
 * A DATED AGE (2026-11-04: "140d ago" on a June estimate hid that it was June). The word and the day,
 * month and day, the year only when it isn't this year: "Accepted Jun 12", "Sent Dec 3, 2025". Same
 * hydration law as prettyWhen: the business timezone and the server's today, never the runtime's.
 *
 * IN THE READER'S LANGUAGE (the Needs You redraw, cn-v1161). The words come from the ny_ catalog
 * (lib/words/needs-you) through the caller's translator, the way lib/lang-words say() works: this
 * file imports no catalog, and with no language handed in every function here says exactly what it
 * said before, byte for byte. The English lives once, in DATED_EN, which row-words' table spreads.
 */

/** The English of the ny_ keys this file says. lib/action-items/row-words NY_EN holds them too (by
 *  spreading this), and a test pins every one of them to the catalog's English. */
export const DATED_EN = {
  ny_datedAccepted: "Accepted {day}",
  ny_datedSent: "Sent {day}",
  ny_datedStarted: "Started {day}",
  ny_ageOverdue: "{n}d overdue",
  ny_ageAgo: "{n}d ago",
  ny_ageYesterday: "Yesterday",
  ny_ageToday: "Today",
  ny_ageTomorrow: "Tomorrow",
} as const;

/** The language a caller hands in: "es" with its translator reads the catalog; anything else is English. */
export type DatedLang = { lang?: string | null; words?: Words };

/** The word a row's day is said with, and the key that says it in another language. */
const DATED_KEY: Record<string, keyof typeof DATED_EN> = {
  Accepted: "ny_datedAccepted",
  Sent: "ny_datedSent",
  Started: "ny_datedStarted",
};

const spanish = (o?: DatedLang): o is { lang: "es"; words: Words } => o?.lang === "es" && !!o.words;

/** One of this file's keys, filled: the catalog's for a Spanish reader whose caller handed its translator, else the English. */
function said(key: keyof typeof DATED_EN, o: DatedLang | undefined, vars?: Record<string, string | number>): string {
  return fillSlots(spanish(o) ? o.words(key) : DATED_EN[key], vars);
}

/** A stored value as an instant: a timestamp as itself, a bare day at noon UTC (so no zone moves it). */
function instant(when: string): { d: Date; hasTime: boolean } | null {
  const hasTime = when.includes("T");
  const d = hasTime ? new Date(when) : new Date(`${when}T12:00:00Z`);
  return isNaN(d.getTime()) ? null : { d, hasTime };
}

/**
 * The day alone, month and day, the year only when it isn't this year: "Jun 12", "Dec 3, 2025";
 * "12 jun", "3 dic 2025" for a Spanish reader (es-US, the formatter lib/come-back-days shortDay
 * uses). A timestamp is said in the company's timezone; a bare day is the day it names. Null when
 * there is no day or it is not one.
 */
export function dayWords(when: string | null | undefined, todayStr: string, tz: string, lang?: string | null): string | null {
  if (!when) return null;
  const at = instant(when);
  if (!at) return null;
  const zone = at.hasTime ? tz : "UTC";
  const year = at.d.toLocaleDateString("en-CA", { timeZone: zone }).slice(0, 4);
  const thisYear = year === todayStr.slice(0, 4);
  return at.d.toLocaleDateString(localeOf(lang), { timeZone: zone, month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) });
}

/**
 * "Accepted Jun 12". `word` is the row's `dated` word (Accepted, Sent, Started) or another caller's
 * own (the billing page's Since, which stays English: it has no key). A Spanish reader whose caller
 * handed `lang` and `words` reads the catalog's sentence for the three row words: "Se aceptó el 12 jun".
 */
export function datedWhen(word: string, when: string | null | undefined, todayStr: string, tz: string, o?: DatedLang): string | null {
  const day = dayWords(when, todayStr, tz, spanish(o) ? "es" : "en");
  if (day === null) return null;
  const key = DATED_KEY[word];
  if (key && spanish(o)) return said(key, o, { day });
  return `${word} ${day}`;
}

/**
 * THE RELATIVE AGE, said once for every reader (it was action-list's prettyWhen, English only).
 * "3d overdue" past a deadline, "Yesterday" / "3d ago" past the day a thing happened, "Today",
 * "Tomorrow", else the weekday and the day; a timestamp adds its time, alone when it is today.
 *
 * HYDRATION LAW: this runs during SSR (Vercel, UTC) AND in the browser (Pacific), and React #418s on
 * any text difference. So nothing here consults the runtime's clock or timezone: "today" is the
 * server-computed business-tz `todayStr`, date-only values are compared as noon-UTC instants, and all
 * formatting pins the business timezone. English with no language handed in, byte for byte what
 * prettyWhen printed.
 */
export function relativeWhen(when: string | null | undefined, todayStr: string, tz: string, deadline = true, o?: DatedLang): string | null {
  if (!when) return null;
  const at = instant(when);
  if (!at) return null;
  const { d, hasTime } = at;
  const es = spanish(o);
  const dayStr = hasTime ? d.toLocaleDateString("en-CA", { timeZone: tz }) : when;
  const diffDays = Math.round((Date.parse(`${dayStr}T12:00:00Z`) - Date.parse(`${todayStr}T12:00:00Z`)) / 86_400_000);
  // A day already past is OVERDUE only when it was a deadline (WHEN_IS_A_DEADLINE); the day a thing
  // happened is said as how long ago, so an inspection done yesterday never reads as a miss.
  const rel =
    diffDays < 0
      ? deadline
        ? said("ny_ageOverdue", o, { n: -diffDays })
        : diffDays === -1
          ? said("ny_ageYesterday", o)
          : said("ny_ageAgo", o, { n: -diffDays })
      : diffDays === 0
        ? said("ny_ageToday", o)
        : diffDays === 1
          ? said("ny_ageTomorrow", o)
          : d.toLocaleDateString(localeOf(es ? "es" : "en"), { timeZone: hasTime ? tz : "UTC", weekday: "short", month: "short", day: "numeric" });
  if (hasTime) {
    const raw = d.toLocaleTimeString(localeOf(es ? "es" : "en"), { timeZone: tz, hour: "numeric", minute: "2-digit" });
    // One spelling of a Spanish clock's half of the day on the server and in the browser (esMeridiem).
    const t = es ? esMeridiem(raw) : raw;
    return diffDays === 0 ? t : `${rel} · ${t}`;
  }
  return rel;
}
