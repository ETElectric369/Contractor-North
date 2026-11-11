import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, fillText, translator } from "@/lib/i18n";
import { formatDate, formatDateTime } from "@/lib/utils";
import { esTitleCase, titleCaseIn } from "../../../../../tests/title-case-words";

/**
 * THE VISIT PAGE IN SPANISH (the visit-page-in-Spanish wave, cn-v1144, vp_). The page a tech opens from
 * the schedule — its start card, its ending, its link picker, its ⋯ rows and Mark Complete — rendered
 * inside a LangProvider with "es": every door reads the catalog's Title Case Spanish, every line its
 * sentence, a clock reads "12:00 p. m.", a slot is filled, and no English door is left on it. The English
 * renders are each piece's own test (visit-start-card.test, visit-ending.test), untouched, with no
 * provider: English is the default, byte for byte — and the table at the bottom pins every vp_ key's
 * English to the literal it replaced. The page itself is a server component and its hear-actions a
 * server file, so their mechanism is pinned on the source and their words on the catalog (the unit
 * project has no DOM and no session).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../start-job-actions", () => ({ startJobFromVisit: vi.fn(), linkVisitInstead: vi.fn(), askOfficeToStartJob: vi.fn() }));
vi.mock("../../timeclock/actions", () => ({ clockIn: vi.fn(), switchJob: vi.fn(), deleteTimeEntry: vi.fn() }));
vi.mock("../actions", () => ({
  setAppointmentOutcome: vi.fn(),
  setAppointmentStatus: vi.fn(),
  putVisitBackOnSchedule: vi.fn(),
  wontHappenAppointment: vi.fn(),
  linkAppointmentTo: vi.fn(),
  linkAppointmentToNewLead: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-modal": title }, children, footer),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { VisitStartCard } = await import("./visit-start-card");
const { VisitEnding, outcomeWord } = await import("./visit-ending");
const { LinkPicker } = await import("./link-picker");
const { MarkDoneRow, PutBackRow, WontHappenRow } = await import("./visit-header-actions");
const { MarkCompleteButton } = await import("./mark-complete-button");

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const t = translator("es");

const TZ = "America/Los_Angeles";
const preview = {
  name: "12 Bayberry Ln",
  customer: "Pat Thistlewood",
  address: "12 Bayberry Ln, Thistlewood, CA 96100",
  scheduledStart: "2026-09-25T17:00:00.000Z", // 10:00 AM on the org's clock
};
const j55 = { id: "job-55", job_number: "J-055", name: "Twelve Bayberry Lane" };
const onJ50 = { id: "entry-50", job_id: "job-50", job_code: null, label: "J-050", clock_in: "2026-09-25T15:00:00.000Z" }; // 8:00 AM
const onJ55 = { id: "entry-55", job_id: "job-55", job_code: null, label: "J-055", clock_in: "2026-09-25T19:00:00.000Z" }; // 12:00 PM

type CardProps = Parameters<typeof VisitStartCard>[0];
const card = (p: Partial<CardProps>) =>
  es(
    createElement(VisitStartCard, {
      appointmentId: "appt-1",
      tz: TZ,
      isStaff: true,
      job: null,
      openEntry: null,
      linkInstead: null,
      preview,
      officePhone: "(530) 555-0133",
      ...p,
    }),
  );
/** Render with the clock at a fixed moment: whole-or-cut and the Visit Time chip turn on what time it is NOW. */
const atClock = (iso: string, p: Partial<CardProps>) => {
  vi.useFakeTimers({ now: Date.parse(iso) });
  try {
    return card(p);
  } finally {
    vi.useRealTimers();
  }
};
const NO_ENGLISH_DOORS = /Start the Job|Link To|Make a New Job|Ask the Office|Call the Office|Text the Office|Clock In On|Switch To|Open J-|Here to do the work|This visit is done|on the clock on/;

describe("the start card speaks Spanish to a Spanish reader", () => {
  it("office, no job yet: the question, the line with the customer, and the two doors in Title Case", () => {
    const html = card({});
    const body = text(html);
    expect(body).toMatch(/^¿Vienes a hacer el trabajo\?/);
    expect(body).toContain("Empieza un trabajo desde esta visita. Trae Pat Thistlewood, la dirección y la hora de la visita.");
    expect(html).toContain("Empezar el Trabajo y Marcar Entrada");
    expect(html).toContain("Empezar el Trabajo</button>");
    expect(html).toContain('aria-label="Empezar el trabajo"');
    expect(html).not.toMatch(NO_ENGLISH_DOORS);
  });

  it("on the clock on the very job the customer already has: the bold job, a Spanish clock, and the link door", () => {
    const html = card({ linkInstead: { ...j55, customer: "Pat Thistlewood" }, openEntry: onJ55 });
    expect(html).toContain('Desde 12:00 p. m. estás en el reloj en <span class="font-semibold">J-055</span> · Twelve Bayberry Lane. Pat Thistlewood ya lo tiene. Enlaza esta visita a él.');
    expect(html).toContain("Enlazar a J-055</button>");
    expect(html).toContain("Crear Nuevo Trabajo de Todos Modos");
    expect(html).not.toContain("12:00 PM");
    expect(html).not.toMatch(NO_ENGLISH_DOORS);
  });

  it("a same-day job on offer, finished, on a visit that is over: made that day and finished, the question, Link To leads", () => {
    const html = card({ visitOver: true, linkInstead: { ...j55, status: "complete", customer: "Pat Thistlewood" } });
    const body = text(html);
    expect(body).toMatch(/^Esta visita está hecha/);
    expect(body).toContain("Pat Thistlewood ya tiene J-055 · Twelve Bayberry Lane, hecho ese día y terminado. ¿Enlazar esta visita a él?");
    expect(html).toContain("Enlazar a J-055</button>");
    expect(html).not.toContain("En Su Lugar");
    const before = card({ visitOver: false, linkInstead: { ...j55, customer: "Pat Thistlewood" } });
    expect(before).toContain("Enlazar a J-055 en Su Lugar");
    expect(text(before)).toContain("hecho ese día. ¿Usarlo en vez de crear un segundo trabajo?");
  });

  it("a visit that is over with no job: the quiet door and the line that says it starts no clock", () => {
    const html = card({ visitOver: true });
    expect(text(html)).toContain("No tiene trabajo. Si el trabajo sigue, empieza uno desde ella: trae Pat Thistlewood, la dirección y la hora de la visita, y no empieza tu reloj.");
    expect(html).toContain("Empezar un Trabajo desde Esta Visita");
    expect(html).not.toContain("Marcar Entrada");
  });

  it("on the clock elsewhere: whole or cut, by the punch's age, in Spanish", () => {
    const young = atClock("2026-09-25T15:05:00.000Z", { openEntry: onJ50 });
    expect(text(young)).toContain("Desde 8:00 a. m. estás en el reloj en J-050. Empezar este trabajo pasa toda esta marcación a él — nada se queda atrás.");
    const older = atClock("2026-09-25T15:20:00.000Z", { openEntry: onJ50 });
    expect(text(older)).toContain("Desde 8:00 a. m. estás en el reloj en J-050. Empezar este trabajo cambia tu reloj aquí.");
    const sw = atClock("2026-09-25T15:20:00.000Z", { job: j55, openEntry: onJ50 });
    expect(sw).toContain('data-visit-start="switch"');
    expect(text(sw)).toContain("Desde 8:00 a. m. estás en el reloj en J-050. Al cambiar, esa parte termina ahora y empieza esta.");
    // A Spanish clock ends in a period, so no sentence ends on one: never "a. m.." on the card.
    expect(text(young) + text(older) + text(sw)).not.toContain("m..");
    expect(sw).toContain("Cambiar a J-055");
    expect(text(atClock("2026-09-25T15:05:00.000Z", { job: j55, openEntry: onJ50 }))).toContain("Al cambiar, toda esta marcación pasa a J-055 — nada se queda atrás.");
  });

  it("crew, no job yet: ask, call or text the office", () => {
    const html = card({ isStaff: false });
    const body = text(html);
    expect(body).toMatch(/^Pídele a la oficina que empiece el trabajo/);
    expect(body).toContain("Esta visita aún no tiene trabajo, y solo la oficina puede empezar uno. En cuanto lo haga, puedes marcar entrada aquí mismo.");
    for (const w of ["Pídele a la Oficina", "Llamar a la Oficina", "Enviar Mensaje a la Oficina"]) expect(html, w).toContain(w);
    expect(text(card({ isStaff: false, visitOver: true }))).toContain("Esta visita está hecha y no tiene trabajo. Si el trabajo sigue, pídele a la oficina que empiece uno.");
    expect(html).not.toMatch(NO_ENGLISH_DOORS);
  });

  it("a linked job: clock in, open; already on it; and a closed visit on a finished job", () => {
    const linked = card({ job: j55 });
    expect(text(linked)).toMatch(/^Esta visita es J-055 · Twelve Bayberry Lane/);
    expect(linked).toContain("Marcar Entrada en J-055");
    expect(linked).toContain("Abrir J-055");
    const here = card({ isStaff: false, job: j55, openEntry: onJ55 });
    expect(here).toContain("Estás en el Reloj Aquí");
    expect(here).not.toContain("Marcar Entrada En");
    const closed = card({ visitOver: true, job: { ...j55, status: "complete" } });
    expect(text(closed)).toContain("La visita está hecha y J-055 está terminado, así que no hay reloj que empezar aquí.");
    expect(closed).toContain("Abrir J-055");
    expect(closed).not.toContain("Marcar Entrada");
    expect(linked + here + closed).not.toMatch(NO_ENGLISH_DOORS);
  });

  it("the sheet: what the job will be, when the clock starts — the Visit Time chip carries a Spanish clock, and the Planned row a Spanish date", () => {
    const html = atClock("2026-09-25T22:32:00.000Z", {});
    expect(html).toContain('data-modal="Empezar el Trabajo y Marcar Entrada"');
    const body = text(html);
    for (const w of ["El trabajo será", "Nombre", "Cliente", "Dirección", "Planeado", "Hora de inicio", "Ahora", "Hora de la Visita · 10:00 a. m.", "Elegir una Hora", "Cancelar"]) expect(body, w).toContain(w);
    expect(body).toContain(formatDateTime(preview.scheduledStart, TZ, "es"));
    expect(body).not.toContain(formatDateTime(preview.scheduledStart, TZ, "en"));
    expect(html).toContain('aria-label="Hora de inicio"');
    expect(html).not.toMatch(/Visit Time|Pick a Time|Started at|The job will be/);
    // A job with no customer and no address yet: Ninguno for the customer, Ninguna for the address.
    const bare = text(atClock("2026-09-25T22:32:00.000Z", { preview: { ...preview, customer: null, address: null } }));
    expect(bare).toContain("Cliente Ninguno aún");
    expect(bare).toContain("Dirección Ninguna aún");
    // With a same-day job on offer the sheet is Make a New Job, and names the second job.
    const second = atClock("2026-09-25T22:32:00.000Z", { linkInstead: { ...j55, customer: "Pat Thistlewood" } });
    expect(second).toContain('data-modal="Crear Nuevo Trabajo"');
    expect(second).toContain('Pat Thistlewood ya tiene <span class="font-semibold">J-055</span>, hecho ese día. Esto crea un segundo trabajo.');
  });

  it("the card's source reads every word through t() and its clocks through formatTime for a Spanish reader", () => {
    const s = src("src/app/(app)/appointments/[id]/visit-start-card.tsx");
    expect(s).toContain('import { useLang } from "@/components/lang-provider";');
    expect(s).toContain('import { fillText, translator } from "@/lib/i18n";');
    expect(s).toContain('const clockAt = (iso: string) => (lang === "es" ? formatTime(iso, tz, "es") : clockWords(iso, tz));');
    expect(s).toContain("formatDateTime(preview.scheduledStart, tz, lang)");
    expect(s).not.toContain("formatDateTimeTz");
    expect(s).not.toContain('const OFFLINE = "');
  });
});

describe("how the visit ended, in Spanish", () => {
  const base = { appointmentId: "appt-1", isStaff: true, decidable: true, status: "completed", estimate: null, outcome: null, outcomeAt: null, job: null, tz: TZ };
  const ending = (o: Partial<Parameters<typeof VisitEnding>[0]>) => es(createElement(VisitEnding, { ...base, ...o }));

  it("the two honest endings: Perdida, and Ganada · Elegir el Trabajo on the attach door", () => {
    const html = ending({});
    expect(text(html)).toMatch(/^¿Cómo terminó esta\?/);
    expect(html).toContain(">Perdida<");
    expect(html).toContain("Ganada · Elegir el Trabajo");
    expect(html).not.toMatch(/Lost|Won · Pick the Job|How did this one end/);
  });

  it("the estimate it became, a dead one said so; the outcome with a Spanish day and Cambiar", () => {
    const dead = ending({ estimate: { id: "q1", number: "EST-0042", status: "declined", live: false } });
    // The estimate's status in the reader's language since cn-v1145 (lib/statuses estimateStatusLabel, qt_status_…).
    expect(text(dead)).toContain("Redactada como EST-0042 · rechazado — ese presupuesto terminó; se puede empezar uno nuevo abajo.");
    // An estimate with no number yet is linked by its name, a door (vp_btn_theEstimate).
    const unnumbered = ending({ estimate: { id: "q1", number: null, status: "draft", live: true } });
    expect(unnumbered).toContain(">El Presupuesto</a>");
    expect(unnumbered).not.toContain("The Estimate");
    const won = ending({ outcome: "won", outcomeAt: "2026-07-31T20:00:00.000Z", job: { id: "j1", job_number: "J-038", name: "The lake place" } });
    expect(won).toContain(">Ganada<");
    expect(won).toContain(formatDate("2026-07-31T20:00:00.000Z", TZ, "es"));
    expect(won).not.toContain("Jul 31, 2026");
    expect(won).toContain(">Cambiar<");
    expect(outcomeWord("won", t)).toBe("Ganada");
    expect(outcomeWord("no_bid", t)).toBe("Perdida");
    expect(outcomeWord("won")).toBe("Won"); // English by default, as the ending's own test pins
    expect(outcomeWord("archived", t)).toBe("archived"); // an unknown stored word is shown as stored
  });
});

describe("the link picker, in Spanish", () => {
  it("resting on a lead: the kind chip, the For label and Cambiar; the closed picker's default door", () => {
    const resting = es(createElement(LinkPicker, { appointmentId: "appt-1", linked: { kind: "lead", name: "Pat Thistlewood" }, seed: "" }));
    expect(resting).toContain(">prospecto<");
    expect(resting).toContain(">Para<");
    expect(resting).toContain(">Cambiar<");
    const closed = es(createElement(LinkPicker, { appointmentId: "appt-1", linked: null, seed: "" }));
    expect(text(closed)).toContain("Para Conectar esto a un prospecto, cliente o trabajo");
    // A caller's own words win, and label={null} draws no label (the ending card's door).
    const handed = es(createElement(LinkPicker, { appointmentId: "appt-1", linked: null, seed: "", kinds: ["job"], openLabel: t("vp_btn_wonPickTheJob"), label: null }));
    expect(text(handed)).toBe("Ganada · Elegir el Trabajo");
    expect(resting + closed).not.toMatch(/Connect this to|>For<|>Change<|>lead</);
  });

  it("the open state's words are the catalog's (a click cannot be driven here): the search box, the empty lines, the lead door", () => {
    const s = src("src/app/(app)/appointments/[id]/link-picker.tsx");
    expect(s).toContain('placeholder={seed.trim() ? fillText(t("vp_searchingSeed"), { seed: seed.trim() }) : t("vp_nameOrAddress")}');
    expect(s).toContain('{kinds?.length === 1 && kinds[0] === "job" ? t("vp_noJobMatchesYet") : offerLead ? t("vp_nobodyByThatName") : t("vp_nothingMatchesYet")}');
    expect(s).toContain('{fillText(t("vp_addressGoesOnLead"), { typed })}');
    expect(s).toContain("{t(KIND_KEY[r.kind])}");
    expect(fillText(t("vp_searchingSeed"), { seed: "12 Bayberry" })).toBe("Buscando “12 Bayberry” — o escribe un nombre");
    expect(fillText(t("vp_addressGoesOnLead"), { typed: "Pat Thistlewood" })).toBe("Pat Thistlewood — la dirección de esta visita va en el prospecto");
    expect(t("vp_noJobMatchesYet")).toBe("Ningún trabajo coincide aún — prueba con la calle o el nombre del cliente.");
    expect(t("vp_nobodyByThatName")).toBe("Nadie con ese nombre aún.");
    expect(t("vp_nothingMatchesYet")).toBe("Nada coincide aún — sigue, puedes conectar esto después.");
    expect(t("vp_noConnectionLink")).toBe("Sin conexión, así que eso no pasó. Inténtalo de nuevo cuando tengas una o dos barras de señal.");
  });
});

describe("the header's ⋯ rows and Mark Complete, in Spanish", () => {
  it("Marcar Hecha · Devolverla a la Agenda · No Se Hará, and the main button Marcar Inspección Hecha", () => {
    const rows = es(
      <>
        <MarkDoneRow id="appt-1" />
        <PutBackRow id="appt-1" />
        <WontHappenRow id="appt-1" deletes={false} afterHref="/schedule" />
      </>,
    );
    for (const w of ["Marcar Hecha", "Devolverla a la Agenda", "No Se Hará"]) expect(rows, w).toContain(w);
    expect(rows).not.toMatch(/Mark Done|Put It Back|Won't Happen/);
    const main = es(createElement(MarkCompleteButton, { id: "appt-1" }));
    expect(main).toContain("Marcar Inspección Hecha");
    expect(es(createElement(MarkCompleteButton, { id: "appt-1", label: t("vp_btn_markDone") }))).toContain("Marcar Hecha");
  });

  it("what the rows say afterwards, in Spanish, with the server's own note said as received", () => {
    expect(fillText(t("vp_markedDoneNote"), { note: "3 tareas pasaron a J-055." })).toBe("Marcada como Hecha. 3 tareas pasaron a J-055.");
    expect(t("vp_markedDone")).toBe("Marcada como Hecha");
    expect(fillText(t("vp_putBackNote"), { note: "x" })).toBe("Devuelta. x");
    expect(t("vp_btn_undo")).toBe("Deshacer");
    const s = src("src/app/(app)/appointments/[id]/visit-header-actions.tsx");
    expect(s).toContain('label: t("vp_btn_undo"),');
    // The library's words follow the reader too (builder D, the same wave): the row hands it the language and its translator.
    expect(s).toContain("toast(wontHappenToast(\"cancelled\", res.note, lang, t), \"success\", undo(res.previousStatus));");
  });
});

describe("the page and the voice fill (server side): the mechanism on the source, the words on the catalog", () => {
  it("the page reads the signed-in person's language once, hands it to the type badge and the date, and draws its own words through t()", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain('import { currentLangFor } from "@/lib/current-lang";');
    expect(page).toContain("const lang = await currentLangFor(viewerId);");
    expect(page).toContain("const t = translator(lang);");
    expect(page).toContain("{appointmentTypeLabel(a.type, lang, t)}");
    expect(page).toContain("formatDateTime(a.starts_at, tz, lang)");
    expect(page).not.toContain("formatDateTimeTz");
    for (const key of ["vp_btn_backToSchedule", "vp_btn_backToMyDay", "vp_btn_actions", "vp_pendingPick", "vp_doneBadge", "vp_cancelledBadge", "vp_btn_markInspectionDone", "vp_btn_editDetails", "vp_waitingForADay", "vp_noJob", "vp_crewLeadsAfterUpdate", "vp_customerToldUsOnline", "vp_theirWordsConfirm", "vp_noneMatchedSheet", "vp_couldntReadWebsiteForm", "vp_inspectionOrEstimate", "vp_inspection", "vp_thisJob"]) {
      expect(page, key).toContain(`t("${key}")`);
    }
    // The badges: the one Spanish each the agenda already says.
    expect(t("vp_pendingPick")).toBe(dict("es").ag_cal_pendingPick);
    expect(t("vp_doneBadge")).toBe(dict("es").ag_cal_doneLower);
    expect(t("vp_cancelledBadge")).toBe(dict("es").ag_srv_apptStatus_cancelled);
    expect(t("vp_waitingForADay")).toBe(dict("es").jb_waitingForADay);
  });

  it("hear-actions reads the caller's language once per call (wordsOf) and answers every refusal from the catalog, in both languages", () => {
    const s = src("src/app/(app)/appointments/hear-actions.ts");
    expect(s).toMatch(/^"use server";/);
    expect(s).toContain('import { callerLang } from "@/lib/lang-of";');
    expect(s).toContain("function wordsOf(supabase: Awaited<ReturnType<typeof createClient>>, userId?: string | null): Said {");
    expect(s).toContain("const ws = wordsOf(supabase, user.id);");
    expect(s).not.toMatch(/^export (?!async function)/m);
    const refusals: [string, string, string][] = [
      ["vp_signInFirst", "Sign in first.", "Inicia sesión primero."],
      ["vp_inspectionNoLongerExists", "That inspection no longer exists.", "Esa inspección ya no existe."],
      ["vp_pickAnInspectionFirst", "Pick an inspection first.", "Elige una inspección primero."],
      ["vp_couldntReadInspection", "Couldn't read the inspection just now. Try again.", "No se pudo leer la inspección ahora mismo. Inténtalo de nuevo."],
      ["vp_formIsntAnInspection", "That form isn't an inspection.", "Ese formulario no es una inspección."],
    ];
    for (const [key, en, esWord] of refusals) {
      expect(s, key).toContain(`say("${key}")`);
      expect(translator("en")(key)).toBe(en);
      expect(t(key)).toBe(esWord);
      expect(s).not.toContain(`error: "${en}"`);
    }
  });
});

describe("the visit page catalog (vp_)", () => {
  const vp = CATALOGS.find((c) => c.prefix === "vp_")!;
  /** English Title Case through the one judge (cn-v1148: significant words; tests/title-case-words). */
  const titleCase = (s: string) => titleCaseIn(s, "en");

  it("names the page, its five pieces and its hear-actions, then the pieces it draws and the server it taps (builder D), and nothing else", () => {
    expect(vp).toBeTruthy();
    expect(vp.files).toEqual([
      "src/app/(app)/appointments/[id]/page.tsx",
      "src/app/(app)/appointments/[id]/visit-start-card.tsx",
      "src/app/(app)/appointments/[id]/link-picker.tsx",
      "src/app/(app)/appointments/[id]/visit-ending.tsx",
      "src/app/(app)/appointments/[id]/visit-header-actions.tsx",
      "src/app/(app)/appointments/[id]/mark-complete-button.tsx",
      "src/app/(app)/appointments/hear-actions.ts",
      "src/app/(app)/appointments/appointment-button.tsx",
      "src/app/(app)/appointments/unschedule-button.tsx",
      "src/app/(app)/appointments/start-job-actions.ts",
      "src/app/(app)/leads/intake-files.tsx",
      // cn-v1157: the page when there is no visit to show (its own test: [id]/not-found.test.tsx).
      "src/app/(app)/appointments/[id]/not-found.tsx",
    ]);
  });

  it("every vp_btn_ key is Title Case in both languages; the two sheet titles are too", () => {
    const doors = Object.keys(vp.en).filter((k) => k.startsWith("vp_btn_"));
    expect(doors.length).toBeGreaterThanOrEqual(34);
    for (const k of [...doors, "vp_makeANewJob", "vp_youreOnTheClockHere"]) {
      expect(titleCase(vp.en[k]), `en:${k} "${vp.en[k]}"`).toBe(true);
      expect(esTitleCase(vp.es[k]), `es:${k} "${vp.es[k]}"`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
    // The closed picker's default door is a sentence in English today, so it is keyed as one, not vp_btn_.
    expect(vp.en.vp_connectThisTo).toBe("Connect this to a lead, customer or job");
    expect(titleCase(vp.en.vp_connectThisTo)).toBe(false);
  });

  it("the house words: one Spanish per English word across the catalogs", () => {
    const d = dict("es");
    expect(vp.es.vp_btn_cancel).toBe(d.tc_cancel);
    expect(vp.es.vp_btn_saving).toBe(d.jb_saving);
    expect(vp.es.vp_btn_undo).toBe(d.ag_btn_undo);
    expect(vp.es.vp_btn_now).toBe(d.md_now);
    expect(vp.es.vp_btn_linking).toBe(d.jb_linking);
    expect(vp.es.vp_btn_switchToThisJob).toBe(d.jb_switchToThisJob);
    expect(vp.es.vp_btn_keepIt).toBe(d.ag_cal_btn_keep);
    expect(vp.es.vp_name).toBe(d.ag_rail_name);
    expect(vp.es.vp_customer).toBe(d.ag_rail_customer);
    expect(vp.es.vp_address).toBe(d.ag_rail_address);
    expect(vp.es.vp_inspection).toBe(d.jb_apptInspection);
    expect(vp.es.vp_theOtherJob).toBe(d.jb_theOtherJob);
    expect(vp.es.vp_btn_clockInOn).toBe(`${d.tc_clockIn} en {job}`);
    expect(vp.es.vp_btn_backToSchedule).toBe(`Volver a la ${d.sh_dock_schedule}`);
    expect(vp.es.vp_btn_backToMyDay).toBe(`Volver a ${d.sh_myDay}`);
    expect(vp.es.vp_btn_startTheJob).toBe("Empezar el Trabajo"); // Start = Empezar (sh_help_startHere, tc_startingNow)
    expect(d.tc_startingNow).toMatch(/^Empezando/);
    expect(vp.es.vp_btn_linkTo).toMatch(/^Enlazar a /); // Link = Enlazar (jb_link)
    expect(d.jb_link).toBe("Enlazar");
    expect(vp.es.vp_btn_pickATime).toMatch(/^Elegir /); // Pick = Elegir (ag_rail_btn_pickADay)
    expect(vp.es.vp_btn_addAsANewLead).toContain("Prospecto"); // Lead = Prospecto (nv_page_leads)
    expect(vp.es.vp_btn_askTheOffice).toMatch(/^Pídele /); // Ask = Pídele (sh_askTheOwner)
    expect(vp.es.vp_noConnection).toMatch(/^Sin conexión/); // jb_noConnection
    expect(vp.es.vp_markedDone).toMatch(/^Marcada como/); // ag_srv_toastMarkedDone
    expect(vp.es.vp_putBack).toMatch(/^Devuelta/); // ag_srv_toastPutBack
    expect(vp.es.vp_btn_editDetails).toMatch(/^Editar Detalles/); // ag_srv_visitDidHappen
    expect(vp.es.vp_btn_theEstimate).toBe(`El ${d.nt_estimate}`);
    // The same word as a status and as a door: the status key stays, the button has its own vp_btn_ key (skeptic #50).
    expect(vp.en.vp_btn_lost).toBe(vp.en.vp_lost);
    expect(vp.es.vp_btn_lost).toBe(vp.es.vp_lost);
    expect(vp.es.vp_onClockSince).toContain("en el reloj"); // jb_switchCutBody
    // A Spanish clock ends in a period ("8:00 a. m."): no Spanish sentence ends on a clock slot.
    for (const [k, v] of Object.entries(vp.es)) expect(v, `es:${k}`).not.toMatch(/\{(since|at|clock)\}\.$/);
    expect(vp.es.vp_switchingMovesWhole).toContain("marcación"); // a punch, jb_switchedWhole
    // Two "None yet" rows: the customer's Ninguno, the address's Ninguna.
    expect(vp.en.vp_noCustomerYet).toBe(vp.en.vp_noAddressYet);
    expect(vp.es.vp_noCustomerYet).not.toBe(vp.es.vp_noAddressYet);
  });

  it("every English value is the literal it replaced, byte for byte", () => {
    const replaced: Record<string, string> = {
      vp_btn_backToSchedule: "Back to Schedule",
      vp_btn_backToMyDay: "Back to My Day",
      vp_btn_actions: "Actions",
      vp_pendingPick: "pending pick",
      vp_doneBadge: "done",
      vp_cancelledBadge: "cancelled",
      vp_btn_markInspectionDone: "Mark Inspection Done",
      vp_btn_editDetails: "Edit Details…",
      vp_waitingForADay: "Waiting for a Day",
      vp_noJob: "no job",
      vp_crewLeadsAfterUpdate: "Crew leads can fill this in once the office finishes an update. Until then only the office can change it.",
      vp_customerToldUsOnline: "What the customer told us online",
      vp_theirWordsConfirm: "Their words, not a finding — confirm on site.",
      vp_noneMatchedSheet: "None of these matched a question on your inspection sheet, so none of them could fill it in.",
      vp_couldntReadWebsiteForm: "Couldn't read the website form's questions just now, so the customer's answers aren't shown. Reload to try again.",
      vp_inspectionOrEstimate: "Inspection or Estimate",
      vp_inspection: "Inspection",
      vp_thisJob: "This job",
      vp_noConnection: "No connection. That didn't go through; try again when you have a bar or two.",
      vp_pickAStartTime: "Pick a start time.",
      vp_somethingWrongNothingChanged: "Something went wrong. Nothing was changed.",
      vp_doneDot: "Done.",
      vp_btn_undoClockIn: "Undo Clock-In",
      vp_clockInUndone: "Clock-in undone. {job} stays.",
      vp_theJob: "The job",
      vp_clockInNotUndone: "The clock-in could not be undone.",
      vp_movedWholePunch: "Moved your whole punch since {since} onto {job}.",
      vp_switchedClock: "Switched your clock to {job} from {from} at {at}.",
      vp_theOtherJob: "the other job",
      vp_clockedYouIn: "Clocked you in on {job} at {at}.",
      vp_officeAsked: "The office has been asked.",
      vp_startTheWorkAria: "Start the work",
      vp_thisVisitIsDone: "This visit is done",
      vp_hereToDoTheWork: "Here to do the work?",
      vp_onClockOnLinkJob: "You’re on the clock on {job} since {since}{name}. {customer} already has it. Link this visit to it.",
      vp_alreadyHasMadeThatDay: "{customer} already has {job}{name}, made that day.",
      vp_alreadyHasMadeThatDayFinished: "{customer} already has {job}{name}, made that day and finished.",
      vp_linkThisVisitToItQ: "Link this visit to it?",
      vp_useItInsteadQ: "Use it instead of making a second job?",
      vp_thisCustomer: "This customer",
      vp_theCustomer: "the customer",
      vp_overNoJobLine: "It has no job. If the work goes on, start one from it: it brings {customer}, the address and the visit time along, and it doesn’t start your clock.",
      vp_startAJobLine: "Start a job from this visit. It brings {customer}, the address and the visit time along.",
      vp_onClockSince: "You’re on the clock on {label} since {since}.",
      vp_startingMovesWhole: "Starting this job moves this whole punch onto it — none of it stays behind.",
      vp_startingSwitchesHere: "Starting this job switches your clock here.",
      vp_btn_linkTo: "Link to {job}",
      vp_btn_linkToInstead: "Link to {job} Instead",
      vp_btn_makeANewJobAnyway: "Make a New Job Anyway",
      vp_btn_startAJobFromThisVisit: "Start a Job from This Visit",
      vp_btn_startTheJobAndClockIn: "Start the Job and Clock In",
      vp_btn_startTheJob: "Start the Job",
      vp_askOfficeToStart: "Ask the office to start the job",
      vp_askOverNoJob: "This visit is done and has no job. If the work goes on, ask the office to start one.",
      vp_askNoJobYet: "This visit has no job yet, and only the office can start one. Once they do, you can clock in right here.",
      vp_btn_askTheOffice: "Ask the Office",
      vp_btn_callTheOffice: "Call the Office",
      vp_btn_textTheOffice: "Text the Office",
      vp_thisVisitIs: "This visit is {job}",
      vp_switchingMovesWhole: "Switching moves this whole punch onto {job} — none of it stays behind.",
      vp_switchingEndsPart: "Switching ends that part now and starts this one.",
      vp_closedLine: "The visit is done and {job} is finished, so there’s no clock to start here.",
      vp_youreOnTheClockHere: "You’re on the Clock Here",
      vp_btn_switchTo: "Switch to {job}",
      vp_btn_clockInOn: "Clock In on {job}",
      vp_btn_open: "Open {job}",
      vp_makeANewJob: "Make a New Job",
      vp_btn_cancel: "Cancel",
      vp_btn_linking: "Linking…",
      vp_btn_starting: "Starting…",
      vp_btn_switchToThisJob: "Switch to This Job",
      vp_alreadyHasSecondJob: "{customer} already has {job}, made that day. This makes a second job.",
      vp_theJobWillBe: "The job will be",
      vp_name: "Name",
      vp_customer: "Customer",
      vp_address: "Address",
      vp_planned: "Planned",
      vp_noCustomerYet: "None yet",
      vp_noAddressYet: "None yet",
      vp_onClockLinkInsteadSheet: "You’re on the clock on {job} since {since}. Link this visit to it instead; a new job here would take your clock off the job you are on.",
      vp_sheetMovesWhole: "You're on the clock on {label} since {since}. This moves this whole punch onto the new job, from {since} — none of it stays behind. No second clock is opened.",
      vp_sheetSwitchesNow: "You're on the clock on {label} since {since}. This switches your clock to the new job now: the part on {label} ends at this moment. No second clock is opened.",
      vp_startedAt: "Started at",
      vp_btn_now: "Now",
      vp_btn_visitTime: "Visit Time · {clock}",
      vp_btn_pickATime: "Pick a Time",
      vp_clockStartsAtTimeAbove: "Your clock starts at the time above.",
      vp_noConnectionLink: "No connection, so that didn't go through. Try again when you have a bar or two.",
      vp_connectThisTo: "Connect this to a lead, customer or job",
      vp_for: "For",
      vp_kind_lead: "lead",
      vp_kind_customer: "customer",
      vp_kind_job: "job",
      vp_btn_change: "Change",
      vp_searchingSeed: "Searching “{seed}” — or type a name",
      vp_nameOrAddress: "Name or address",
      vp_looking: "looking…",
      vp_noJobMatchesYet: "No job matches yet — try the street or the customer's name.",
      vp_nobodyByThatName: "Nobody by that name yet.",
      vp_nothingMatchesYet: "Nothing matches yet — carry on, you can connect this later.",
      vp_couldntMakeTheLead: "Couldn't make the lead.",
      vp_btn_addAsANewLead: "Add as a New Lead",
      vp_addressGoesOnLead: "{typed} — this visit’s address goes on the lead",
      vp_couldntConnectIt: "Couldn't connect it — try again.",
      vp_won: "Won",
      vp_lost: "Lost",
      vp_btn_lost: "Lost",
      vp_btn_wonPickTheJob: "Won · Pick the Job",
      vp_btn_clearTheAnswer: "Clear the Answer",
      vp_btn_keepIt: "Keep It",
      vp_writtenUpAs: "Written up as",
      vp_btn_theEstimate: "The Estimate",
      vp_estimateIsOver: "— that estimate is over; a new one can be started below.",
      vp_howDidThisOneEnd: "How did this one end?",
      vp_thatDidntSave: "That didn't save — try again.",
      vp_markedWon: "Marked Won.",
      vp_markedLost: "Marked Lost.",
      vp_answerCleared: "Answer cleared.",
      vp_btn_undo: "Undo",
      vp_putBack: "Put back.",
      vp_putBackNote: "Put back. {note}",
      vp_couldntPutItBack: "Couldn't put it back.",
      vp_couldntMarkItDone: "Couldn't mark it done — try again.",
      vp_markedDone: "Marked Done",
      vp_markedDoneNote: "Marked Done. {note}",
      vp_btn_saving: "Saving…",
      vp_btn_markDone: "Mark Done",
      vp_couldntPutBackOnSchedule: "Couldn't put it back on the schedule — try again.",
      vp_backOnTheSchedule: "Back on the schedule.",
      vp_btn_putItBackOnTheSchedule: "Put It Back on the Schedule",
      vp_thatVisitDidntChange: "That visit didn't change — try again.",
      vp_btn_wontHappen: "Won't Happen",
      vp_couldntUpdateStatus: "Couldn't update the status — try again.",
      vp_signInFirst: "Sign in first.",
      vp_inspectionNoLongerExists: "That inspection no longer exists.",
      vp_pickAnInspectionFirst: "Pick an inspection first.",
      vp_couldntReadInspection: "Couldn't read the inspection just now. Try again.",
      vp_formIsntAnInspection: "That form isn't an inspection.",
    };
    // The table is C's half of the catalog, whole; D's half (visit-pieces-spanish.test's table, 122 keys:
    // the Edit Details modal, Clear the Date, Start the Job's server, the shared libraries, the clock-in's
    // clash) is the rest. A key added to the catalog and to neither table is a hole.
    for (const k of Object.keys(replaced)) expect(vp.en, k).toHaveProperty(k);
    // + the five What Is This For? words (cn-v1157), pinned in visit-title-field.test
    // + the three words of the page with no visit to show (cn-v1157: vp_visitGone, vp_visitGoneTech, vp_btn_backToInspections), pinned in not-found.test
    expect(Object.keys(vp.en)).toHaveLength(Object.keys(replaced).length + 122 + 5 + 3);
    for (const [k, literal] of Object.entries(replaced)) expect(dict("en")[k], k).toBe(literal);
    // The sentences the old card assembled, re-assembled through the slots, are the old sentences.
    const en = dict("en");
    expect(fillText(en.vp_movedWholePunch, { since: "8:00 AM", job: "J-055" })).toBe("Moved your whole punch since 8:00 AM onto J-055.");
    expect(fillText(en.vp_switchedClock, { job: "J-055", from: en.vp_theOtherJob, at: "3:32 PM" })).toBe("Switched your clock to J-055 from the other job at 3:32 PM.");
    expect(fillText(en.vp_clockedYouIn, { job: "J-055", at: "12:00 PM" })).toBe("Clocked you in on J-055 at 12:00 PM.");
    expect(fillText(en.vp_clockInUndone, { job: en.vp_theJob })).toBe("Clock-in undone. The job stays.");
    expect(fillText(en.vp_btn_linkToInstead, { job: "J-055" })).toBe("Link to J-055 Instead");
    expect(fillText(en.vp_btn_visitTime, { clock: "10:00 AM" })).toBe("Visit Time · 10:00 AM");
    expect(fillText(en.vp_markedDoneNote, { note: "3 tasks joined J-055." })).toBe("Marked Done. 3 tasks joined J-055.");
    expect(fillText(en.vp_putBackNote, { note: "The pick-a-time link stays withdrawn — send a new one." })).toBe("Put back. The pick-a-time link stays withdrawn — send a new one.");
  });
});
