import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, mergeWords, translator } from "@/lib/i18n";
import type { WordCatalog } from "@/lib/words/types";
import { titleCaseIn } from "./title-case-words";

/**
 * EVERY WORD IN BOTH LANGUAGES (cn-v1138). The runtime lays Spanish over English so a missing key
 * never shows a person a raw key — which is exactly why the gap has to be refused HERE, before it
 * ships: a Spanish-speaking tech reading one English sentence on a Spanish screen is the leak the
 * wave exists to close. For every catalog: every key under its prefix, every English key in the
 * Spanish, a Spanish that differs from the English unless the key is declared the same in both (a
 * brand word, OK, a job number), no key in two catalogs, every named screen on disk. The floors
 * keep the scan honest.
 */

/** The thirty catalogs (lib/words; nv_ the office's map since cn-v1139, us_ the usage meter since cn-v1140, the agenda's four — ag_, ag_cal_, ag_rail_, ag_srv_ — since the agenda-in-Spanish wave, the visit page's three — su_ the Settle Up button, vi_ the Inspector, vp_ the visit page — since the visit-page-in-Spanish wave, cn-v1144, the estimates' four — qt_ the screens, qe_ the one editor, qb_ the task breakdown, qs_ the server and its libraries — since the estimates-in-Spanish wave, cn-v1145, Ventas-2's five — ld_ the leads, ld_srv_ their server, ip_ the inspections tab, cu_ the customers, cu_srv_ their server — since cn-v1146, sn_ the review sheet and the Sent Messages list since cn-v1155). */
export const CATALOG_FLOOR = 30;
/** The keys across every catalog at the grid-boxes wave's close (cn-v1151: 3,909 — the Modal's drag hint carried through ag_ (1), the schedule box's state and hours words in ag_ (11, ag_hClocked renamed ag_hWorked by the fixer) and the week line's dropped-figure sentence ag_cal_jobHoursDropped (1)), at the Ventas-2 wave's close (cn-v1146: 3,896 — the five Ventas-2 catalogs whole, ld_ 176, ld_srv_ 28, ip_ 17, cu_ 192, cu_srv_ 48 = 461 at 3,883, then the fixer's 13: ld_answersReady split One/Many, ld_srv_lib_ 10 for lib/inquiries/known-customer's note, cu_btn_newInvoice and cu_btn_deleteCustomer for the customer ⋯ rows), at its foundation (3,467 — the estimates wave's 3,422 + ld_ 34 (the lead status family's five, lib/lead-triage's fifteen, lib/leads/next-step's fourteen), ld_srv_ 1, ip_ 3 (lib/inspections' row tags), cu_ 6 (the customer status family's three, lib/crm-order's three), cu_srv_ 1), at the estimates wave's close (cn-v1145: 3,422 — the four estimates catalogs whole, qt_ 159, qe_ 136, qb_ 66, qs_ 188; the fixer took the editor's three copies of the type words (the editor reads qt_'s) and added qs_lib_text's five for the Text doors' refusals), at its foundation (2,951 — the status family's six in qt_ and the four shared libraries' 72 in qs_lib_, qe_ and qb_ still empty shelves), at the visit-page wave's close (cn-v1144: 2,873 — the visit page's three catalogs whole, su_ 125, vi_ 185, vp_ 260, and the shell's and Nort's additions; skeptic #50's fixes added nine to vp_: the Lost door's own vp_btn_ key and the clock-in clash's eight — recount with `CATALOGS.flatMap((c) => Object.keys(c.en)).length` and set the floor to the count, never below it), at that wave's foundation (2,406: su_ 125 whole and the shell's 7 for the off line and the directions link, vi_ and vp_ still empty shelves), at the agenda wave (2,274: the agenda's four catalogs whole — ag_ 89, ag_cal_ 122, ag_rail_ 175, ag_srv_ 155 = 541), at its foundation (1,825: the agenda's 93 + three placeholders, one per sub-catalog), at cn-v1140 (1,729 with the fixer's four — the shell's used-up line, the estimator's lighter line, the notice button, Ask The Owner — less the owner slot word; 1,726 with the plan card's words; 1,711 when the floor was set; 1,694 at cn-v1139; 1,562 at cn-v1138); raise it as keys land.; cn-v1152: 3,917 — jb_theJob retired in both languages with the Report Back card, its only reader; the one add box's nine qt_ words, two of them the asks for the words and the price; cn-v1153: 3,916 — ag_cal_orPickADate retired in both languages with the 14-day strip it captioned, every date box one DayField, the phone's own picker; cn-v1155: 3,950 — the sn_ catalog whole, the send sheet's and the Sent Messages list's words).; then 3,974 at the wave's close — the sheet's and the doors' twenty-four more (titles per kind, the confirm sentence's parts, the refusals, the greeting line sn_greetingPreview, the estimate's qt_btn_send, the jobs' review words).; cn-v1157: 4,013 — the field sweep's thirty-nine: the customer pick's Saving and Saved, the inspection row's doors and the Didn't Happen? group's, What Is This For?, Not a Cost and its refusals, the mic's closing line, its failed-request and signed-out lines, the weather's words, Preview and its still-saving sentence, the lead's doors on its row and on the estimate's card, the stamp-not-linked sentence reworded in place, and the deleted visit's page).; cn-v1158: 4,041 — twenty-eight net: the paper switch's ONE set of names for what prints under a task (Every Part, One Materials Line, Hidden) with its three company-default segments and Document Studio's heading, the Job Site line's and its sheet's words with the server's three refusals, the copy's lost-site sentence, the no-town pair and the short-list line, and Lost on the inspections page; less the nine they replace (Show and Hide, the old default pair, List Every Part, Document Studio's three choice words, the lead card's no-address line). */
export const KEYS_FLOOR = 4041;

/**
 * THE KEY FAMILIES THAT ARE CLICKABLES (Erik's law: Title Case in BOTH languages). English capitalizes
 * every word ("Price List", "Bills & POs"); Spanish, since cn-v1147, the SIGNIFICANT words, the RAE's way
 * ("Lista de Precios", "Cuentas y Órdenes"): a function word (a, de, la, y…) stays lowercase except as the
 * first word or the first after a separator (· — – / ( &). A sentence under one of these prefixes
 * (a help row's line, ending in a period) keeps sentence case and is not judged. The page titles
 * (nv_page_) are judged in SPANISH only: their English is byte for byte what each page says today,
 * and four of them ("Tax report", "Activity audit", "Employee documents", "Employee handbook") are
 * not Title Case — the pages' own words, not the catalog's to change.
 */
// The agenda's four catalogs key every clickable with `_btn_` right after the prefix (lib/words/agenda's header); so do
// the visit page's three (su_btn_, vi_btn_, vp_btn_) and, since that wave, the shell's new clickables (sh_btn_); so do the
// estimates' four (qt_btn_, qe_btn_, qb_btn_, qs_btn_), since the estimates-in-Spanish wave (cn-v1145); so do Ventas-2's
// (ld_btn_, ld_srv_btn_, cu_btn_, cu_srv_btn_, ip_btn_), since cn-v1146.
const TITLE_CASE_FAMILIES = [
  "sh_dock_", "sh_help_", "sh_btn_", "nv_add_", "nv_set_", "nv_role_", "nv_sched_", "us_door_",
  "ag_btn_", "ag_cal_btn_", "ag_rail_btn_", "ag_srv_btn_", "su_btn_", "vi_btn_", "vp_btn_", "nt_btn_",
  "qt_btn_", "qe_btn_", "qb_btn_", "qs_btn_",
  "ld_btn_", "ld_srv_btn_", "cu_btn_", "cu_srv_btn_", "ip_btn_",
  "sn_btn_",
];
const TITLE_CASE_ES_ONLY = ["nv_page_"];
/** The rule: tests/title-case-words titleCaseIn — the significant words in both languages (Spanish cn-v1147, English cn-v1148). */
const titleCase = titleCaseIn;

const ROOT = process.cwd();
const keysOf = (c: WordCatalog) => Object.keys(c.en);

describe("the catalogs", () => {
  it("there are thirty, each with a prefix of its own, and together they hold at least the floor's keys", () => {
    expect(CATALOGS.length).toBeGreaterThanOrEqual(CATALOG_FLOOR);
    const prefixes = CATALOGS.map((c) => c.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // Two letters, or two letters and a side of them (the agenda's ag_cal_, ag_rail_, ag_srv_).
    for (const p of prefixes) expect(p, p).toMatch(/^[a-z]{2}_(?:[a-z]+_)?$/);
    expect(CATALOGS.flatMap(keysOf).length).toBeGreaterThanOrEqual(KEYS_FLOOR);
  });

  it("every key starts with its catalog's prefix, in en and in es", () => {
    const strays: string[] = [];
    for (const c of CATALOGS) {
      // A longer prefix that begins with this one (ag_cal_ under ag_) is another catalog's: its keys live there.
      const others = CATALOGS.map((o) => o.prefix).filter((p) => p !== c.prefix && p.startsWith(c.prefix));
      for (const k of [...Object.keys(c.en), ...Object.keys(c.es)]) {
        if (!k.startsWith(c.prefix) || others.some((p) => k.startsWith(p))) strays.push(`${c.prefix} ${k}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("every English key exists in Spanish, and no Spanish key is without its English", () => {
    const missing: string[] = [];
    for (const c of CATALOGS) {
      for (const k of Object.keys(c.en)) if (typeof c.es[k] !== "string" || !c.es[k].trim()) missing.push(`${k} has no Spanish`);
      for (const k of Object.keys(c.es)) if (typeof c.en[k] !== "string" || !c.en[k].trim()) missing.push(`${k} has no English`);
    }
    expect(missing).toEqual([]);
  });

  it("the Spanish differs from the English unless the key is declared the same in both, and every such key exists", () => {
    const same: string[] = [];
    const stale: string[] = [];
    for (const c of CATALOGS) {
      for (const k of Object.keys(c.en)) if (c.es[k] === c.en[k] && !c.sameInBoth.includes(k)) same.push(k);
      for (const k of c.sameInBoth) if (!(k in c.en)) stale.push(k);
    }
    expect(same, "these keys read the same in both languages; translate them or list them in sameInBoth").toEqual([]);
    expect(stale, "sameInBoth names a key that is not in the catalog").toEqual([]);
  });

  it("no key is defined in two catalogs", () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const c of CATALOGS) {
      for (const k of keysOf(c)) {
        if (seen.has(k)) twice.push(`${k} (${seen.get(k)} and ${c.prefix})`);
        seen.set(k, c.prefix);
      }
    }
    expect(twice).toEqual([]);
  });

  it("every screen a catalog names is on disk, under src, as a .ts or .tsx file", () => {
    for (const c of CATALOGS) {
      for (const f of c.files) {
        expect(f, f).toMatch(/^src\/.+\.tsx?$/);
        expect(existsSync(join(ROOT, f)), `${c.prefix} names ${f}, which is not there`).toBe(true);
      }
    }
  });

  it("the Time Clock's and the shell's words are in: the two that were in lib/i18n.ts before the catalogs", () => {
    expect(dict("en").tc_clockIn).toBe("Clock In");
    expect(dict("es").tc_clockIn).toBe("Marcar Entrada");
    expect(dict("en").sh_language).toBe("Language");
    expect(dict("es").sh_language).toBe("Idioma");
    // The honesty line (cn-v1139): the crew's side and the office's MAP, named door by door — the dock, the + menu,
    // search, the account menu, the Settings sections, each page's title — never "every menu" (a page's own ⋯ menu
    // and tab strip stay English with its contents); the office pages' contents stay English.
    expect(dict("en").sh_spanishCovers).toMatch(/^Spanish covers the crew's side and the office's map today/);
    expect(dict("en").sh_spanishCovers).toContain("the dock, the + menu, search, the account menu, the Settings sections and each page's title");
    expect(dict("en").sh_spanishCovers).not.toContain("every menu");
    expect(dict("en").sh_spanishCovers).toMatch(/The office pages' contents stay in English for now\.$/);
    expect(dict("es").sh_spanishCovers).toMatch(/^El español cubre hoy el lado de la cuadrilla y el mapa de la oficina/);
    expect(dict("es").sh_spanishCovers).toContain("la barra, el menú +, la búsqueda, el menú de la cuenta, las secciones de Ajustes y el título de cada página");
    expect(dict("es").sh_spanishCovers).not.toContain("cada menú");
    expect(dict("es").sh_spanishCovers).toMatch(/siguen en inglés por ahora\.$/);
    expect(dict("en")).not.toHaveProperty("s_language");
  });

  it("the office's map is in (cn-v1139): the nav catalog, the dock's office rows, the help rows", () => {
    expect(CATALOGS.some((c) => c.prefix === "nv_")).toBe(true);
    expect(dict("es")["sh_dock_ma-payroll"]).toBe("Nómina");
    expect(dict("es").sh_help_startHere).toBe("Empieza Aquí");
    expect(dict("en").nv_page_leads).toBe("Leads");
    expect(dict("es").nv_page_leads).toBe("Prospectos");
  });

  it("the usage meter is in (cn-v1140): Usage = Uso, the two doors Title Case, no dollar and no estimate as a unit anywhere in it", () => {
    const us = CATALOGS.find((c) => c.prefix === "us_")!;
    expect(us).toBeTruthy();
    expect(us.files).toEqual(["src/components/usage-ring.tsx", "src/lib/usage-words.ts", "src/app/(app)/settings/plan-card.tsx"]);
    expect(dict("en").us_usage).toBe("Usage");
    expect(dict("es").us_usage).toBe("Uso");
    expect(dict("en").us_door_addUsage).toBe("Add Usage");
    expect(dict("es").us_door_addUsage).toBe("Agregar Uso");
    expect(dict("en").us_door_upgrade).toBe("Upgrade");
    expect(dict("es").us_door_upgrade).toBe("Mejorar Plan");
    for (const lang of ["en", "es"] as const) {
      for (const [k, v] of Object.entries(us[lang])) {
        expect(v, `${lang}:${k}`).not.toMatch(/\$|\d+ (full )?(estimates|presupuestos)|token|crédito|credit/i);
      }
    }
  });

  it("every clickable or title key family is Title Case — the significant words: English a / the / to / of lowercase in the middle of a segment (cn-v1148), Spanish de / y / del after the first word (cn-v1147)", () => {
    const offenders: string[] = [];
    let judged = 0;
    for (const c of CATALOGS) {
      for (const k of keysOf(c)) {
        const both = TITLE_CASE_FAMILIES.some((p) => k.startsWith(p));
        const esOnly = TITLE_CASE_ES_ONLY.some((p) => k.startsWith(p));
        if (!both && !esOnly) continue;
        for (const lang of both ? (["en", "es"] as const) : (["es"] as const)) {
          const text = c[lang][k];
          if (/[.]$/.test(text)) continue; // a sentence beside the door, not its words
          judged++;
          if (!titleCase(text, lang)) offenders.push(`${lang}:${k} "${text}"`);
        }
      }
    }
    expect(judged).toBeGreaterThanOrEqual(200);
    expect(offenders).toEqual([]);
    // The rule itself. English (cn-v1148, after Chicago and Apple): the articles, and / or, as and the short prepositions
    // lowercase in the middle of a segment; a particle (Sign In, Turn On, Set Up), a name's "A" and the first and last word of
    // a segment capital; a {slot} is a word, so the words around it are mid-title; a heading in capitals is judged word by word.
    expect(titleCase("Add to the Schedule", "en")).toBe(true);
    expect(titleCase("Bills & POs", "en")).toBe(true);
    expect(titleCase("Finish Setting Up · {n} Left", "en")).toBe(true);
    expect(titleCase("They Paid — Record It", "en")).toBe(true);
    expect(titleCase("Sign In with a Code", "en")).toBe(true);
    expect(titleCase("Turn It On from Their Contact Page", "en")).toBe(true);
    expect(titleCase("Swap Money In and Out", "en")).toBe(true);
    expect(titleCase("Set Up Card Payments", "en")).toBe(true);
    expect(titleCase("Who's on the Clock", "en")).toBe(true);
    expect(titleCase("Log {hours}h on This Job", "en")).toBe(true);
    expect(titleCase("Put It on {job} Instead", "en")).toBe(true);
    expect(titleCase("No Job: A Reminder for Me", "en")).toBe(true);
    expect(titleCase("Phase A Loads", "en")).toBe(true);
    expect(titleCase("Import a .vcf", "en")).toBe(true);
    expect(titleCase("SCOPE OF WORK", "en")).toBe(true);
    expect(titleCase("Add To The Schedule", "en")).toBe(false);
    expect(titleCase("Add to The Schedule", "en")).toBe(false);
    expect(titleCase("Sign in with a Code", "en")).toBe(false);
    expect(titleCase("Who's on the clock", "en")).toBe(false);
    expect(titleCase("Owed to", "en")).toBe(false);
    expect(titleCase("They Paid — record It", "en")).toBe(false);
    // Spanish (cn-v1147): the significant words; a function word lowercase after the first word of a segment.
    expect(titleCase("Lista de Precios", "es")).toBe(true);
    expect(titleCase("Cuentas y Órdenes", "es")).toBe(true);
    expect(titleCase("Mover a un Día", "es")).toBe(true);
    expect(titleCase("El Día de Todos", "es")).toBe(true);
    expect(titleCase("Ganada · Elegir el Trabajo", "es")).toBe(true);
    expect(titleCase("O una Cita", "es")).toBe(true);
    expect(titleCase("Nueva Cita a las {time}", "es")).toBe(true);
    expect(titleCase("Fijar Arriba (Se Queda hasta que lo Desfijes)", "es")).toBe(true);
    expect(titleCase("¿Cobrar Ahora?", "es")).toBe(true);
    expect(titleCase("Lista De Precios", "es")).toBe(false);
    expect(titleCase("Cuentas Y Órdenes", "es")).toBe(false);
    expect(titleCase("Mover A Un Día", "es")).toBe(false);
    expect(titleCase("Lista de precios", "es")).toBe(false);
    expect(titleCase("¿cobrar Ahora?", "es")).toBe(false);
    expect(titleCase("lista de Precios", "es")).toBe(false);
  });
});

describe("the runtime fallback", () => {
  it("dict(\"es\") holds every English key, so a key missing from a catalog's Spanish still reads in English", () => {
    const en = dict("en");
    const es = dict("es");
    for (const k of Object.keys(en)) expect(typeof es[k], k).toBe("string");
    // The rule itself, on a catalog of this test's own: the English shows through the gap.
    const merged = mergeWords([{ prefix: "zz_", files: [], sameInBoth: [], en: { zz_a: "Only English", zz_b: "Both" }, es: { zz_b: "Ambos" } }]);
    expect(merged.es).toEqual({ zz_a: "Only English", zz_b: "Ambos" });
    expect(merged.en).toEqual({ zz_a: "Only English", zz_b: "Both" });
    // A key no catalog holds comes back as itself (the translator never answers undefined).
    expect(translator("es")("zz_nothing")).toBe("zz_nothing");
    expect(translator("en")("zz_nothing")).toBe("zz_nothing");
    // Anything that is not "es" is English.
    expect(dict(null)).toBe(dict("en"));
    expect(dict("fr")).toBe(dict("en"));
  });
});
