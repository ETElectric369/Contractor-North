// THE ONE DICTIONARY (cn-v1138). The words a Spanish-speaking person reads live in twenty-nine catalogs,
// one per side of the app (lib/words/*: tc_ the Time Clock, cs_ its server, gf_ the geofence, nb_
// the texts and pushes, au_ sign-in, md_ My Day, tk_ tasks, jb_ jobs, mt_ materials, sh_ the shell,
// nt_ Nort, nv_ the office's map — cn-v1139, us_ the usage meter — cn-v1140; the agenda's four, ag_ / ag_cal_ /
// ag_rail_ / ag_srv_, since the agenda-in-Spanish wave; the visit page's three, su_ the Settle Up
// button / vi_ the Inspector / vp_ the visit page, since the visit-page-in-Spanish wave, cn-v1144; the estimates' four, qt_ the screens /
// qe_ the one editor / qb_ the task breakdown / qs_ the server and its libraries, since the estimates-in-Spanish
// wave, cn-v1145; Ventas-2's five, ld_ the leads / ld_srv_ their server / ip_ the inspections tab / cu_ the
// customers / cu_srv_ their server, since cn-v1146), each English beside
// Spanish under its own prefix. This file merges them: dict("en") is
// every catalog's English; dict("es") is every catalog's Spanish laid over the English, so a key
// missing from a catalog's Spanish still reads in English at runtime and a person never sees a raw
// key (tests/words-parity.test.ts is what refuses the gap before it ships). profiles.language is
// the one source of truth: a server component asks translator(profile.language), a server action
// callerLang(sb) (lib/lang-of), a client component useLang() (components/lang-provider), and a
// sender that writes one line per person notifyPeople(orgId, ids, (lang) => ({ … })).
// Client components import this file, so it carries no server-only import.
//
// The old nav-label dictionary (English-text keys for a sidebar that would "translate in place")
// was dead data and went in the 2026-07-16 churn audit; the flat tc_/s_ dicts that lived here went
// into the catalogs in cn-v1138 (s_language / s_languageDesc are sh_language / sh_languageDesc).
//
// The Lang type and its three small readers (localeOf, asLang, langFromWord) live in lib/locale,
// which imports no catalog, and are re-exported here: a module that needs no words (lib/utils, the
// voice files, a route that only reads a language) imports from there and carries no dictionary;
// every existing `import { asLang } from "@/lib/i18n"` keeps compiling.

import type { WordCatalog } from "@/lib/words/types";
import { type Lang } from "@/lib/locale";
export { localeOf, asLang, langFromWord } from "@/lib/locale";
export type { Lang, Locale } from "@/lib/locale";
import { words as timeclock } from "@/lib/words/timeclock";
import { words as clockserver } from "@/lib/words/clockserver";
import { words as geofence } from "@/lib/words/geofence";
import { words as messages } from "@/lib/words/messages";
import { words as auth } from "@/lib/words/auth";
import { words as myday } from "@/lib/words/myday";
import { words as tasks } from "@/lib/words/tasks";
import { words as jobs } from "@/lib/words/jobs";
import { words as materials } from "@/lib/words/materials";
import { words as shell } from "@/lib/words/shell";
import { words as nort } from "@/lib/words/nort";
import { words as nav } from "@/lib/words/nav";
import { words as usage } from "@/lib/words/usage";
import { words as agenda } from "@/lib/words/agenda";
import { words as agendaCalendar } from "@/lib/words/agenda-calendar";
import { words as agendaRail } from "@/lib/words/agenda-rail";
import { words as agendaServer } from "@/lib/words/agenda-server";
import { words as settleUp } from "@/lib/words/settle-up";
import { words as visitInspector } from "@/lib/words/visit-inspector";
import { words as visitPage } from "@/lib/words/visit-page";
import { words as quotes } from "@/lib/words/quotes";
import { words as quotesEditor } from "@/lib/words/quotes-editor";
import { words as quotesBreakdown } from "@/lib/words/quotes-breakdown";
import { words as quotesServer } from "@/lib/words/quotes-server";
import { words as leads } from "@/lib/words/leads";
import { words as leadsServer } from "@/lib/words/leads-server";
import { words as inspections } from "@/lib/words/inspections";
import { words as customers } from "@/lib/words/customers";
import { words as customersServer } from "@/lib/words/customers-server";
import { words as send } from "@/lib/words/send";

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

/** The thirty catalogs, by name, in the order they are merged (the agenda's four since the
 *  agenda-in-Spanish wave: ag_ the libraries + shared doors, ag_cal_ the calendar, ag_rail_ the rail
 *  and sheets, ag_srv_ the server messages; the visit page's three since the visit-page-in-Spanish
 *  wave: su_ the Settle Up button, vi_ the Inspector, vp_ the visit page and its hear-actions; the
 *  estimates' four since the estimates-in-Spanish wave, cn-v1145: qt_ the screens and the status
 *  family, qe_ the one estimate editor, qb_ the task breakdown, qs_ quotes/actions and its libraries; Ventas-2's five since cn-v1146: ld_ the leads
 *  and their libraries, ld_srv_ leads/actions, ip_ the inspections tab, cu_ the customers, cu_srv_ crm/actions
 *  and the share and portal-look actions; the review sheet's one since cn-v1155: sn_ the send sheet and the Sent Messages list). */
export const CATALOGS: readonly WordCatalog[] = [
  timeclock, clockserver, geofence, messages, auth, myday, tasks, jobs, materials, shell, nort, nav, usage,
  agenda, agendaCalendar, agendaRail, agendaServer,
  settleUp, visitInspector, visitPage,
  quotes, quotesEditor, quotesBreakdown, quotesServer,
  leads, leadsServer, inspections, customers, customersServer,
  send,
];

type Dict = Record<string, string>;

/** The merge rule, on its own so the parity test can prove the fallback on a catalog of its own:
 *  en is every catalog's English; es is every catalog's Spanish laid over that English. */
export function mergeWords(catalogs: readonly WordCatalog[]): { en: Dict; es: Dict } {
  const en: Dict = Object.assign({}, ...catalogs.map((c) => c.en));
  // English under Spanish: the runtime fallback, so a key no catalog translated still reads.
  const es: Dict = Object.assign({}, en, ...catalogs.map((c) => c.es));
  return { en, es };
}

const { en, es } = mergeWords(CATALOGS);

/** The whole dictionary for a language: Spanish over English, or English. */
export function dict(lang: string | null | undefined): Dict {
  return lang === "es" ? es : en;
}

/** Convenience translator bound to a language. */
export function translator(lang: string | null | undefined) {
  const d = dict(lang);
  return (key: string) => d[key] ?? key;
}

/** A translated string with its {name} slots filled: fillText(t("tc_lunchOnPrev"), { job }). */
export function fillText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
