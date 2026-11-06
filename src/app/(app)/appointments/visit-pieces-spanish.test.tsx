import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, fillText, translator } from "@/lib/i18n";
import { clockWords, jobShort, startedAtProblem, startedWords } from "@/lib/appointments/visit-start";
import { putBackPlan, visitDayWords, wontHappenConfirm, wontHappenToast, wontHappenUndo } from "@/lib/appointments/wont-happen";
import { inspectionUnreadWords, INSPECTION_UNREAD } from "@/lib/inspection/inspection-access";
import { kitsReadWords } from "@/lib/estimate/task-kits";
import { clockInClashWords } from "@/lib/overlap-refusal";
import { esTitleCase } from "../../../../tests/es-function-words";

/**
 * THE VISIT PAGE'S PIECES IN SPANISH (builder D of the visit-page-in-Spanish wave, cn-v1144, vp_): the
 * English a Spanish tech still met on the page after C's half, because it came from a piece the page
 * draws or a sentence its server returns — the Edit Details modal (appointment-button), the Clear The
 * Date row (unschedule-button), Start The Job's server (start-job-actions), and the pure libraries the
 * page and its server share (visit-start, wont-happen, inspection-access INSPECTION_UNREAD, task-kits
 * kitsReadWords). Rendered inside a LangProvider with "es": every door reads the catalog's Title Case
 * Spanish, every line its sentence, a clock reads "12:00 p. m.", and no English door is left. The
 * English renders are each piece's own test (appointment-button.test, unschedule.test, wont-happen.test,
 * start-job-actions.test), untouched, with no provider: English is the default, byte for byte — the
 * libraries say it inline unless handed "es" and a translator — and the table at the bottom pins every
 * vp_ key this half added to the literal it replaced. The server file's mechanism is pinned on its
 * source and its words on the catalog (the unit project has no DOM and no session).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/appointments/appt-1",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => null }));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: (p: { placeholder?: string }) => createElement("input", { placeholder: p.placeholder }) }));
vi.mock("./actions", () => ({
  createAppointment: vi.fn(),
  updateAppointment: vi.fn(),
  deleteAppointment: vi.fn(),
  createJobFromAppointment: vi.fn(),
  createAppointmentProposal: vi.fn(),
  unscheduleAppointment: vi.fn(),
}));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-modal": title }, children, footer),
  ModalActions: ({ saveLabel, extra }: { saveLabel?: string; extra?: ReactNode }) => createElement("div", { "data-actions": saveLabel }, extra),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { AppointmentButton, apptFormWords } = await import("./appointment-button");
const { UnscheduleButton } = await import("./unschedule-button");

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const en = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const t = translator("es");
const TZ = "America/Los_Angeles";

const appt = {
  id: "appt-1",
  type: "inspection",
  title: "Inspection: 41 Larkspur",
  starts_at: "2026-10-28T16:00:00.000Z",
  ends_at: null,
  job_id: null,
  customer_id: null,
  location: "41 Larkspur",
  notes: null,
  assigned_to: null,
};
const lists = {
  jobs: [{ id: "job-55", label: "J-055 · Twelve Bayberry Lane", address: "12 Bayberry Ln" }],
  customers: [{ id: "c1", label: "Pat Thistlewood", address: "12 Bayberry Ln" }],
  staff: [{ id: "p1", label: "Sam Catbird" }],
};
type FormProps = Partial<Parameters<typeof AppointmentButton>[0]>;
const form = (p: FormProps) => createElement(AppointmentButton, { ...lists, ...p });

describe("the Edit Details modal speaks Spanish to a Spanish reader", () => {
  it("editing an inspection: the sheet's title and Save, every field label, the two new-person doors, Convert To Job, Delete", () => {
    const html = es(form({ appointment: appt, rowLabel: t("vp_btn_editDetails"), triggerClassName: "row" }));
    const body = text(html);
    expect(html).toContain('data-modal="Editar Inspección"');
    expect(html).toContain('data-actions="Guardar Inspección"');
    expect(html).toContain(">Editar Detalles…</button>"); // the ⋯ row that opens it, the caller's words
    for (const w of ["Tipo", "Asignado a", "— Cualquiera —", "Título", "Fecha", "Inicio", "Fin", "Cliente", "Trabajo", "Ubicación", "Notas"]) expect(body, w).toContain(w);
    expect(html).toContain('placeholder="p. ej. Inspección en casa de los Smith, visita de seguimiento"');
    expect(html).toContain('placeholder="Dirección o sitio"');
    expect(html).toContain("Nuevo Prospecto</button>");
    expect(html).toContain("Cliente Nuevo</button>"); // the rail's order (ag_rail_btn_newCustomer)
    expect(body).toContain("¿No está en la lista? Agrégalo aquí.");
    expect(html).toContain("Convertir en Trabajo →</button>");
    expect(html).toContain(">Eliminar</button>");
    // The type options read the jobs catalog's words through appointmentTypeLabel(type, lang, t).
    expect(html).toContain(">Inspección</option>");
    expect(html).toContain(`>${dict("es").jb_apptJob}</option>`);
    expect(html).not.toMatch(/Edit Inspection|Save Inspection|Assigned to|Anyone|Convert To Job|New Lead|New Customer|Address or site|Not in the list|>Location<|>Notes<|>Type<|>Title</);
  });

  it("the pencil trigger is titled Editar; a new visit's sheet is Nueva Cita with Fijar una Hora · Proponer Horas; the closed trigger follows the kind", () => {
    expect(es(form({ appointment: appt }))).toContain('title="Editar"');
    const fresh = es(form({}));
    expect(fresh).toContain('data-modal="Nueva Cita"');
    expect(fresh).toContain('data-actions="Guardar Cita"');
    expect(fresh).toContain("Nueva Cita</button>");
    expect(fresh).toContain("Fijar una Hora");
    expect(fresh).toContain("Proponer Horas");
    expect(fresh).not.toMatch(/Set A Time|Propose Times|New Appointment|Save Appointment/);
    expect(es(form({ defaultType: "inspection" }))).toContain("Nueva Inspección</button>");
    expect(es(form({ defaultType: "inspection", buttonLabel: "Agendar una Inspección" }))).toContain("Agendar una Inspección</button>"); // a caller's own words first
  });

  it("the door words, as a pure function, in both languages (whole phrases: Cita and Inspección carry their own article)", () => {
    expect(apptFormWords({ kind: "inspection", editing: false, mode: "set", linkReady: false }, t)).toEqual({ title: "Nueva Inspección", saveLabel: "Guardar Inspección", trigger: "Nueva Inspección" });
    expect(apptFormWords({ kind: "inspection", editing: true, mode: "set", linkReady: false }, t)).toEqual({ title: "Editar Inspección", saveLabel: "Guardar Inspección", trigger: "Nueva Inspección" });
    expect(apptFormWords({ kind: "other", editing: false, mode: "propose", linkReady: false }, t)).toEqual({ title: "Nueva Cita", saveLabel: "Crear Enlace", trigger: "Nueva Cita" });
    expect(apptFormWords({ kind: "other", editing: false, mode: "propose", linkReady: true }, t).title).toBe("Enviar Estas Horas al Cliente por Mensaje");
    expect(apptFormWords({ kind: "job", editing: true, mode: "set", linkReady: false }, t)).toEqual({ title: "Editar Cita", saveLabel: "Guardar Cita", trigger: "Nueva Cita" });
    // No translator handed in: English, byte for byte, as appointment-button.test pins.
    expect(apptFormWords({ kind: "inspection", editing: true, mode: "set", linkReady: false })).toEqual({ title: "Edit Inspection", saveLabel: "Save Inspection", trigger: "New Inspection" });
  });

  it("without a provider the sheet is English, byte for byte", () => {
    const html = en(form({ appointment: appt }));
    const body = text(html);
    expect(html).toContain('title="Edit"');
    expect(html).toContain('data-modal="Edit Inspection"');
    expect(html).toContain('data-actions="Save Inspection"');
    expect(html).toContain("Convert To Job →</button>");
    expect(html).toContain(">Delete</button>");
    for (const w of ["Type", "Assigned to", "— Anyone —", "Title", "Date", "Start", "End", "Customer", "Job", "Location", "Notes", "Not in the list? Add them here."]) expect(body, w).toContain(w);
    expect(html.replace(/&#x27;|&#39;/g, "'")).toContain('placeholder="e.g. Inspection at the Smiths\', follow-up visit"');
    expect(html).toContain('placeholder="Address or site"');
    const fresh = en(form({}));
    expect(fresh).toContain("Set A Time");
    expect(fresh).toContain("Propose Times");
    expect(fresh).toContain("New Appointment</button>");
  });

  it("the screens a static render cannot reach (a tap, a state) read the catalog on the source: the link-ready face, the new-person box, the propose slots, the toasts and the confirm", () => {
    const s = src("src/app/(app)/appointments/appointment-button.tsx");
    expect(s).toContain('import { useLang } from "@/components/lang-provider";');
    expect(s).toContain('import { fillText, translator } from "@/lib/i18n";');
    expect(s).toContain("const lang = useLang();");
    expect(s).toContain("const t = translator(lang);");
    for (const key of [
      "vp_linkReadyAppointment", "vp_btn_copied", "vp_btn_copyLink", "vp_btn_textIt", "vp_textItNote", "vp_btn_done",
      "vp_newLeadName", "vp_newCustomerName", "vp_name", "vp_phone", "vp_optionalPlaceholder", "vp_leadGoesOnIt", "vp_someoneAlreadyYours",
      "vp_offerUpToThreeTimes", "vp_draftRestored", "vp_couldNotCreateJob", "vp_addAtLeastOneDateOption", "vp_couldNotCreateTheLink", "vp_couldNotSave",
      "vp_couldntDeleteAppointment", "vp_appointmentDeleted",
    ]) {
      expect(s, key).toContain(`t("${key}")`);
    }
    expect(s).toContain('aria-label={fillText(t("vp_optionDateAria"), { n: String(i + 1) })}');
    expect(s).toContain('aria-label={fillText(t("vp_optionTimeAria"), { n: String(i + 1) })}');
    expect(s).toContain('if (!confirm(fillText(t("vp_deleteAppointmentAsk"), { title: appointment.title }))) return;');
    expect(s).toContain('fillText(t("vp_zoneNote"), { zone: tz.split("/").pop()?.replace(/_/g, " ") ?? tz })');
    expect(s).toContain("{appointmentTypeLabel(type, lang, t)}");
    // The customer's own line (the sms: body) stays as it is, whatever language the tech reads.
    expect(s).toContain("Hi! Pick a time that works and we'll lock it in: ${pickLink}");
    expect(fillText(t("vp_optionDateAria"), { n: "2" })).toBe("Fecha de la opción 2");
    expect(fillText(t("vp_deleteAppointmentAsk"), { title: "Inspección: 41 Larkspur" })).toBe("¿Eliminar la cita \"Inspección: 41 Larkspur\"? No se puede deshacer.");
    expect(fillText(t("vp_zoneNote"), { zone: "Los Angeles" })).toBe("Las horas son hora de Los Angeles, el reloj del negocio.");
    expect(fillText(translator("en")("vp_zoneNote"), { zone: "Los Angeles" })).toBe("Times are Los Angeles time, the business's clock.");
  });
});

describe("the Clear The Date row, in Spanish", () => {
  it("Quitar la Fecha as a ⋯ row and as a button; English without a provider", () => {
    const row = es(createElement(UnscheduleButton, { id: "appt-1", menuItem: true }));
    expect(row).toContain("Quitar la Fecha</button>");
    expect(row).not.toContain("Clear The Date");
    expect(es(createElement(UnscheduleButton, { id: "appt-1" }))).toContain("Quitar la Fecha");
    expect(en(createElement(UnscheduleButton, { id: "appt-1", menuItem: true }))).toContain("Clear The Date</button>");
    // The calendar's own Clear The Date says the same Spanish (one word per English word).
    expect(t("vp_btn_clearTheDate")).toBe(dict("es").ag_cal_btn_clearTheDate);
    expect(t("vp_btn_clearing")).toBe("Quitando…");
    expect(t("vp_waitsUnderWaitingForADay")).toBe("Espera bajo Esperando un Día en la agenda. Ponla ahí cuando llamen.");
    expect(t("vp_waitsUnderWaitingForADay")).toContain(dict("es").vp_waitingForADay);
    expect(t("vp_couldntClearTheDate")).toBe("No se pudo quitar la fecha.");
  });
});

describe("Start The Job's server (start-job-actions): the mechanism on the source, the words on the catalog, in both languages", () => {
  const s = src("src/app/(app)/appointments/start-job-actions.ts");

  it("reads the caller's language once per call (wordsOf, hear-actions' shape) and exports only async functions", () => {
    expect(s).toMatch(/^"use server";/);
    expect(s).toContain('import { callerLang } from "@/lib/lang-of";');
    expect(s).toContain("function wordsOf(supabase: Awaited<ReturnType<typeof createClient>>, userId?: string | null): Said {");
    expect(s).toContain("const ws = wordsOf(ctx.supabase, ctx.userId);");
    expect(s).toContain("const ws = wordsOf(supabase, user.id);");
    expect(s).toContain("const lang = await ws.lang();");
    expect(s).not.toMatch(/^export (?!async function|type )/m); // only async functions and their result types
    // The pure rules take the same language: the problem, the job's short name, the sentence, the running clock's since.
    expect(s).toContain("startedAtProblem(startAt, Date.now(), tz, lang, words)");
    expect(s).toContain("startedWords({ jobNumber, customer, tz, clock, existing }, lang, words)");
    expect(s).toContain("since: clockWords(o.clock_in, tz, lang),");
    expect(s).toContain('say(lang, words, "vp_noJob", "no job")');
    // No English sentence is left as a returned literal.
    expect(s).not.toMatch(/error: "[A-Z]/);
    expect(s).not.toMatch(/message: "[A-Z]/);
    expect(s).not.toContain("warnings.push(`");
  });

  it("every returned sentence is a vp_ key, said in both languages", () => {
    const refusals: [string, string, string][] = [
      ["vp_onlyOfficeStartsJob", "Only the office can start a job. Ask the office to start it, then clock in here.", "Solo la oficina puede empezar un trabajo. Pídele a la oficina que lo empiece, y luego marca entrada aquí."],
      ["vp_visitNotFound", "That visit could not be found.", "No se encontró esa visita."],
      ["vp_visitCancelledNothingStarted", "This visit was cancelled. Nothing was started.", "Esta visita se canceló. No se empezó nada."],
      ["vp_nothingWasStarted", "Nothing was started.", "No se empezó nada."],
      ["vp_thisCustomerLower", "this customer", "este cliente"],
      ["vp_jobCouldNotBeStarted", "The job could not be started. Nothing was changed.", "No se pudo empezar el trabajo. No se cambió nada."],
      ["vp_jobMadeNotReadBack", "The job was made but could not be read back. Reload the page before trying again.", "El trabajo se creó pero no se pudo leer de vuelta. Recarga la página antes de intentar de nuevo."],
      ["vp_switchDidntGoThrough", "the switch did not go through.", "el cambio no pasó."],
      ["vp_tryAgainFromJobPage", "try again from the job page.", "inténtalo de nuevo desde la página del trabajo."],
      ["vp_onlyOfficeLinksVisit", "Only the office can link a visit to a job.", "Solo la oficina puede enlazar una visita a un trabajo."],
      ["vp_alreadyLinkedToThatJob", "This visit is already linked to that job.", "Esta visita ya está enlazada a ese trabajo."],
      ["vp_alreadyLinkedToAnotherJob", "This visit is already linked to another job. Nothing was changed.", "Esta visita ya está enlazada a otro trabajo. No se cambió nada."],
      ["vp_jobNoLongerOffered", "That job is no longer the one to offer here. Nothing was changed. Edit Details links any job by hand.", "Ese trabajo ya no es el que se ofrece aquí. No se cambió nada. Editar Detalles enlaza cualquier trabajo a mano."],
      ["vp_visitCouldNotBeLinked", "The visit could not be linked. Nothing was changed.", "No se pudo enlazar la visita. No se cambió nada."],
      ["vp_nothingNewWasMade", "Nothing new was made.", "No se creó nada nuevo."],
      ["vp_notSignedIn", "Not signed in.", "No has iniciado sesión."],
      ["vp_accountCantSendThat", "This account can't send that.", "Esta cuenta no puede enviar eso."],
      ["vp_visitAlreadyHasJobReload", "This visit already has a job. Reload the page to clock in on it.", "Esta visita ya tiene trabajo. Recarga la página para marcar entrada en él."],
      ["vp_nobodyInOfficeGetsMessages", "Nobody in the office gets messages in the app yet. Call them instead.", "Nadie en la oficina recibe mensajes en la app todavía. Mejor llámalos."],
      ["vp_didntReachOffice", "That didn't reach the office. Call them instead.", "Eso no llegó a la oficina. Mejor llámalos."],
      ["vp_officeAskedToStartJob", "The office has been asked to start a job for this visit.", "Ya se le pidió a la oficina que empiece un trabajo para esta visita."],
      ["vp_officeAskedClockInHere", "The office has been asked. Once they start the job, you can clock in right here.", "Ya se le pidió a la oficina. En cuanto empiece el trabajo, puedes marcar entrada aquí mismo."],
    ];
    for (const [key, english, spanish] of refusals) {
      expect(s, key).toContain(`"${key}"`);
      expect(translator("en")(key)).toBe(english);
      expect(t(key)).toBe(spanish);
    }
    // The slotted ones: the clock leads in Spanish, and a fragment the caller fills rides as received.
    expect(fillText(t("vp_onClockSwitchHere"), { label: "J-050", since: "8:00 a. m." })).toBe("Desde 8:00 a. m. estás en el reloj en J-050. Cambiar a Este Trabajo mueve tu reloj aquí ahora. Aún no se ha empezado nada.");
    expect(fillText(translator("en")("vp_onClockSwitchHere"), { label: "J-050", since: "8:00 AM" })).toBe("You're on the clock on J-050 since 8:00 AM. Switch To This Job moves your clock here now. Nothing was started yet.");
    expect(t("vp_onClockSwitchHere")).toContain(dict("es").vp_btn_switchToThisJob);
    expect(fillText(t("vp_onClockLinkInstead"), { job: "J-055", customer: "Pat Thistlewood" })).toBe("Estás en el reloj en J-055, el trabajo que Pat Thistlewood ya tiene de hoy. Mejor enlaza esta visita a J-055. No se empezó nada.");
    expect(fillText(t("vp_clockStillOn"), { from: "J-050", why: "el cambio no pasó." })).toBe("Tu reloj sigue en J-050: el cambio no pasó.");
    expect(fillText(t("vp_alreadyOnClockOn"), { job: "J-056" })).toBe("Ya estabas en el reloj en J-056.");
    expect(fillText(t("vp_clockInDidntGoThrough"), { why: "x" })).toBe("La entrada no pasó: x");
    expect(fillText(t("vp_clockAlreadyRunningOn"), { job: "J-055" })).toBe("Tu reloj ya está corriendo en J-055.");
    expect(fillText(t("vp_linkedThisVisitTo"), { job: "J-055", note: "No se creó nada nuevo.", onIt: " Tu reloj ya está corriendo en J-055." })).toBe("Esta visita se enlazó a J-055. No se creó nada nuevo. Tu reloj ya está corriendo en J-055.");
    expect(fillText(translator("en")("vp_linkedThisVisitTo"), { job: "J-055", note: "Nothing new was made.", onIt: "" })).toBe("Linked this visit to J-055. Nothing new was made.");
    expect(t("vp_jobNoLongerOffered")).toContain("Editar Detalles"); // ag_srv_visitDidHappen's word for Edit Details
  });

  it("the office's bell reads the catalog in the office's language — English today, the long-shift route's rule — so the file keeps no literal", () => {
    expect(s).toContain('const office_t = translator("en");');
    expect(s).toContain('const first = (prof.full_name ?? "").trim().split(/\\s+/)[0] || office_t("cs_aCrewMember");');
    expect(s).toContain('const place = visit.title?.trim() || office_t("vp_aVisitLower");');
    expect(s).toContain('title: fillSlots(office_t("vp_bellNeedsJobStarted"), { first, forWho: who ? ` ${fillSlots(office_t("vp_forCustomer"), { customer: who })}` : "" }),');
    expect(s).toContain('body: fillSlots(office_t(over ? "vp_bellVisitOverBody" : "vp_bellAtVisitBody"), { first, place }),');
    const en = translator("en");
    expect(fillText(en("vp_bellNeedsJobStarted"), { first: "Sam", forWho: ` ${fillText(en("vp_forCustomer"), { customer: "Pat Thistlewood" })}` })).toBe("Sam needs a job started for Pat Thistlewood");
    expect(fillText(en("vp_bellNeedsJobStarted"), { first: "Sam", forWho: "" })).toBe("Sam needs a job started");
    expect(fillText(en("vp_bellAtVisitBody"), { first: "Sam", place: "a visit" })).toBe("Sam is at a visit and can't clock in until it has a job. Start it from the visit.");
    expect(en("cs_aCrewMember")).toBe("A crew member");
    expect(fillText(t("vp_bellNeedsJobStarted"), { first: "Sam", forWho: ` ${fillText(t("vp_forCustomer"), { customer: "Pat Thistlewood" })}` })).toBe("Sam necesita que se empiece un trabajo para Pat Thistlewood");
    expect(fillText(t("vp_bellVisitOverBody"), { first: "Sam", place: "Inspección: 41 Larkspur" })).toBe("Sam pide un trabajo para Inspección: 41 Larkspur, una visita que ya terminó, para que el trabajo pueda seguir. Empiézalo desde la visita.");
    expect(t("vp_aVisitLower")).toBe("una visita");
  });
});

describe("the pure libraries: English inline by default, the catalog's Spanish when handed the language and a translator", () => {
  const NOON = "2026-09-25T19:00:00.000Z"; // 12:00 PM Pacific
  const NOW = Date.parse("2026-09-25T22:32:00Z"); // 3:32 PM Pacific

  it("visit-start: the start window's sentences, the job's fallback, the clock", () => {
    expect(startedAtProblem("2026-09-25T23:30:00Z", NOW, TZ, "es", t)).toBe("Esa hora todavía no ha llegado."); // cs_timeHasntHappened's words
    expect(startedAtProblem("2026-09-24T06:30:00Z", NOW, TZ, "es", t)).toBe("Elige una hora desde la medianoche de ayer. Para horas más antiguas, agrégalas en Tarjetas de Tiempo.");
    expect(startedAtProblem("nope", NOW, TZ, "es", t)).toBe("Elige una hora de inicio."); // vp_pickAStartTime, the card's own key
    expect(startedAtProblem("2026-09-25T23:30:00Z", NOW, TZ)).toBe("That time hasn't happened yet.");
    expect(startedAtProblem("2026-09-24T06:30:00Z", NOW, TZ)).toBe("Pick a time since midnight yesterday. For older hours, add them on Timecards.");
    expect(startedAtProblem("nope", NOW, TZ)).toBe("Pick a start time.");
    expect(startedAtProblem("2026-09-25T23:30:00Z", NOW, TZ, "en", t)).toBe("That time hasn't happened yet."); // "en" with a translator is still English
    expect(jobShort(null, "es", t)).toBe("el trabajo");
    expect(jobShort({ job_number: "J-055", name: "x" }, "es", t)).toBe("J-055");
    expect(jobShort(null)).toBe("the job");
    expect(clockWords(NOON, TZ, "es")).toBe("12:00 p. m.");
    expect(clockWords("2026-09-25T15:00:00.000Z", TZ, "es")).toBe("8:00 a. m.");
    expect(clockWords(NOON, TZ)).toBe("12:00 PM");
    expect(clockWords(NOON, TZ, "en")).toBe("12:00 PM");
  });

  it("visit-start: the one sentence after the tap, every shape, the clock first and the sentence ending on a word", () => {
    const base = { jobNumber: "J-056", customer: "Pat Thistlewood", tz: TZ };
    expect(startedWords({ ...base, clock: { kind: "in", at: NOON } }, "es", t)).toBe("Empezaste J-056 para Pat Thistlewood y a las 12:00 p. m. marcaste entrada.");
    expect(startedWords({ ...base, clock: { kind: "switch", at: NOON, from: "J-050" } }, "es", t)).toBe("Empezaste J-056 para Pat Thistlewood y a las 12:00 p. m. tu reloj cambió aquí desde J-050.");
    expect(startedWords({ ...base, clock: { kind: "switch", at: NOON, from: null } }, "es", t)).toBe("Empezaste J-056 para Pat Thistlewood y a las 12:00 p. m. tu reloj cambió aquí.");
    expect(startedWords({ ...base, clock: { kind: "move", since: "2026-09-25T15:00:00.000Z" } }, "es", t)).toBe("Empezaste J-056 para Pat Thistlewood y toda tu marcación desde 8:00 a. m. pasó a él.");
    expect(startedWords({ ...base, clock: null }, "es", t)).toBe("Empezaste J-056 para Pat Thistlewood.");
    expect(startedWords({ ...base, customer: null, clock: null }, "es", t)).toBe("Empezaste J-056.");
    expect(startedWords({ ...base, existing: true, clock: { kind: "in", at: NOON } }, "es", t)).toBe("Esta visita ya tenía J-056 para Pat Thistlewood. A las 12:00 p. m. marcaste entrada en él.");
    expect(startedWords({ ...base, existing: true, clock: { kind: "move", since: NOON } }, "es", t)).toBe("Esta visita ya tenía J-056 para Pat Thistlewood. Toda tu marcación desde 12:00 p. m. pasó a él.");
    expect(startedWords({ ...base, existing: true, clock: { kind: "switch", at: NOON, from: "J-050" } }, "es", t)).toBe("Esta visita ya tenía J-056 para Pat Thistlewood. A las 12:00 p. m. tu reloj cambió a él desde J-050.");
    expect(startedWords({ ...base, existing: true, clock: null }, "es", t)).toBe("Esta visita ya tenía J-056 para Pat Thistlewood.");
    // English, byte for byte what start-job-actions.test pins, with and without "en" handed in.
    expect(startedWords({ ...base, clock: { kind: "in", at: NOON } })).toBe("Started J-056 for Pat Thistlewood and clocked you in at 12:00 PM.");
    expect(startedWords({ ...base, clock: { kind: "switch", at: NOON, from: "J-050" } }, "en", translator("en"))).toBe("Started J-056 for Pat Thistlewood and switched your clock here from J-050 at 12:00 PM.");
    expect(startedWords({ ...base, clock: { kind: "move", since: "2026-09-25T15:00:00.000Z" } })).toBe("Started J-056 for Pat Thistlewood and moved your whole punch since 8:00 AM onto it.");
    expect(startedWords({ ...base, clock: null })).toBe("Started J-056 for Pat Thistlewood.");
    expect(startedWords({ ...base, existing: true, clock: { kind: "switch", at: NOON, from: "J-050" } })).toBe("This visit already had J-056 for Pat Thistlewood. Switched your clock to it from J-050 at 12:00 PM.");
  });

  it("wont-happen: the confirm, the toast, Undo's note, Put It Back's sentence", () => {
    expect(wontHappenConfirm("delete", "es", t)).toBe("¿Esta visita no se hará? No se capturó nada en ella, así que se eliminará.");
    expect(wontHappenConfirm("cancel", "es", t)).toBe("¿Esta visita no se hará? Sus notas, fotos y respuestas se quedan guardadas, marcada como Cancelada.");
    expect(wontHappenToast("deleted", null, "es", t)).toBe("Eliminada. No tenía nada.");
    expect(wontHappenToast("cancelled", null, "es", t)).toBe("Marcada como Cancelada. Todo lo que tiene se queda guardado.");
    expect(wontHappenToast("cancelled", "Se retiró el enlace.", "es", t)).toBe("Marcada como Cancelada. Todo lo que tiene se queda guardado. Se retiró el enlace."); // the server's note, as received
    expect(wontHappenUndo("proposed", "es", t)).toEqual({ status: "scheduled", note: "El enlace para elegir hora sigue retirado — envía uno nuevo." });
    expect(wontHappenUndo("scheduled", "es", t)).toEqual({ status: "scheduled", note: null });
    expect(visitDayWords("2026-10-01", "es")).toMatch(/^[a-zá-ú]{2,4}\.? 1 de oct\.?$/); // "jue 1 de oct", Intl es-US, the comma gone as in English
    expect(visitDayWords("2026-10-01")).toBe("Thu Oct 1");
    expect(putBackPlan("2026-10-01", "2026-10-01", "es", t)).toEqual({ keepDay: true, message: `De vuelta en la agenda para el ${visitDayWords("2026-10-01", "es")}.` });
    expect(putBackPlan("2026-09-20", "2026-10-01", "es", t)).toEqual({ keepDay: false, message: `De vuelta en la agenda, esperando un día: el ${visitDayWords("2026-09-20", "es")} ya pasó.` });
    expect(putBackPlan(null, "2026-10-01", "es", t)).toEqual({ keepDay: false, message: "De vuelta en la agenda, esperando un día." });
    // English defaults, byte for byte what wont-happen.test pins.
    expect(wontHappenConfirm("delete")).toBe("This visit won't happen? Nothing was captured on it, so it will be deleted.");
    expect(wontHappenToast("cancelled")).toBe("Marked Cancelled. Everything on it stays on file.");
    expect(wontHappenUndo("proposed")).toEqual({ status: "scheduled", note: "The pick-a-time link stays withdrawn — send a new one." });
    expect(putBackPlan("2026-10-01", "2026-10-01")).toEqual({ keepDay: true, message: "Back on the schedule for Thu Oct 1." });
  });

  it("inspection-access and task-kits: the sentence the page shows, in Spanish, and INSPECTION_UNREAD untouched", () => {
    expect(inspectionUnreadWords("es", t)).toBe("No se pudo leer esta inspección ahora mismo, así que no se muestra (nada en ella cambió). Recarga la página para intentar de nuevo.");
    expect(inspectionUnreadWords()).toBe(INSPECTION_UNREAD);
    expect(INSPECTION_UNREAD).toBe("Couldn't read this inspection just now, so it isn't shown (nothing on it changed). Reload the page to try again.");
    expect(kitsReadWords("failed", "es", t)).toBe("No se pudieron leer los kits — el selector de kit de una tarea está apagado hasta que recargues; sus propias horas se quedan.");
    expect(kitsReadWords("thin", "es", t)).toBe("Los kits se leyeron sin sus proveedores ni enlaces de piezas — los nombres de las piezas pueden diferir de los del presupuesto."); // a part = una pieza (vi_partsOne)
    expect(kitsReadWords("pre-0386", "es", t)).toBe("Los kits necesitan la actualización de la base de datos antes de que una tarea pueda elegir uno.");
    expect(kitsReadWords("ok", "es", t)).toBeNull();
    expect(kitsReadWords("failed")).toBe("The kits could not be read — a task's kit picker is off until you reload; its own hours stand.");
  });

  it("overlap-refusal: the clock-in's clash, said in Spanish when handed the language — the day and the clock with an article, de … a … between the clocks, Tarjetas de Tiempo, and no sentence ending on the clock; English by default, byte for byte the Timecards' own sentence", () => {
    const clash = { id: "e1", clockIn: "2026-09-25T16:00:00.000Z", clockOut: "2026-09-25T18:30:00.000Z", jobId: "j50", jobCode: null, jobLabel: "J-050", noJob: false, exact: false, lunchMinutes: 0, notes: null };
    const start = "2026-09-25T17:00:00.000Z"; // 10:00 AM Pacific, over a 9:00 to 11:30 shift
    // The day as Intl es-US spells it on this machine ("viernes 25 sept"), so the pin is not an ICU version's.
    const d0 = new Date(clash.clockIn);
    const day = `${d0.toLocaleDateString("es-US", { timeZone: TZ, weekday: "long" })} ${d0.toLocaleDateString("es-US", { timeZone: TZ, month: "short", day: "numeric" })}`;
    expect(day).toMatch(/^viernes 25 sept?\.?$/);
    const nothing = t("vp_nothingWasStarted");
    const staff = clockInClashWords({ clash, startIso: start, tz: TZ, isStaff: true, nothing }, "es", t);
    expect(staff).toBe(
      `Ya tienes horas registradas el ${day}, de 9:00 a. m. a 11:30 a. m. en J-050, así que un reloj que empiece a las 10:00 a. m. las contaría dos veces. No se empezó nada. Empieza el reloj a las 11:30 a. m. o más tarde, o corrige ese turno en Tarjetas de Tiempo.`,
    );
    const tech = clockInClashWords({ clash: { ...clash, jobLabel: null, noJob: true }, startIso: start, tz: TZ, isStaff: false }, "es", t);
    expect(tech).toBe(
      `Ya tienes horas registradas el ${day}, de 9:00 a. m. a 11:30 a. m. sin trabajo, así que un reloj que empiece a las 10:00 a. m. las contaría dos veces. No se registró nada. Empieza el reloj a las 11:30 a. m. o más tarde, o pídele a la oficina que corrija ese turno.`,
    );
    const running = clockInClashWords({ clash: { ...clash, clockOut: null }, startIso: start, tz: TZ, isStaff: true, nothing }, "es", t);
    expect(running).toBe(`Desde el ${day}, 9:00 a. m. en J-050 ya tienes un reloj corriendo. No se empezó nada.`);
    const runningNoJob = clockInClashWords({ clash: { ...clash, clockOut: null, jobLabel: null, noJob: true }, startIso: start, tz: TZ, isStaff: false }, "es", t);
    expect(runningNoJob).toBe(`Desde el ${day}, 9:00 a. m. sin trabajo ya tienes un reloj corriendo. No se registró nada.`);
    for (const s of [staff, tech, running, runningNoJob]) {
      expect(s).not.toMatch(/m\.\./); // a Spanish clock ends in a period; no sentence ends on one
      expect(s).not.toMatch(/AM|PM|Timecards|recorded/);
    }
    // English by default, and with "en" + a translator: the Timecards' own sentence, byte for byte (the Time Clock's clockIn hands no language).
    const english =
      "You already have hours recorded Friday Sep 25, 9:00 AM to 11:30 AM on J-050, so a clock started at 10:00 AM would count them twice. Nothing was started. Start the clock at 11:30 AM or later, or fix that shift on Timecards.";
    expect(clockInClashWords({ clash, startIso: start, tz: TZ, isStaff: true, nothing: "Nothing was started." })).toBe(english);
    expect(clockInClashWords({ clash, startIso: start, tz: TZ, isStaff: true, nothing: "Nothing was started." }, "en", translator("en"))).toBe(english);
    expect(clockInClashWords({ clash: { ...clash, jobLabel: null, noJob: true }, startIso: start, tz: TZ, isStaff: false })).toBe(
      "You already have hours recorded Friday Sep 25, 9:00 AM to 11:30 AM with no job, so a clock started at 10:00 AM would count them twice. Nothing was recorded. Start the clock at 11:30 AM or later, or ask the office to fix that shift.",
    );
    expect(clockInClashWords({ clash: { ...clash, clockOut: null }, startIso: start, tz: TZ, isStaff: false })).toBe(
      "You already have a clock running since Friday Sep 25, 9:00 AM on J-050. Nothing was recorded.",
    );
    // The English of every fragment is the catalog's (translator("en")), the way the lib keeps it inline.
    const en = translator("en");
    expect(fillText(en("vp_clashWhen"), { day: "Friday Sep 25", from: "9:00 AM", to: "11:30 AM" })).toBe("Friday Sep 25, 9:00 AM to 11:30 AM");
    expect(fillText(en("vp_clashRunning"), { when: "Friday Sep 25, 9:00 AM", where: " on J-050", nothing: en("vp_nothingWasRecorded") })).toBe(
      "You already have a clock running since Friday Sep 25, 9:00 AM on J-050. Nothing was recorded.",
    );
    // Start The Job hands the lib its caller's language; the Time Clock's own clockIn does not.
    const sja = src("src/app/(app)/appointments/start-job-actions.ts");
    expect(sja).toContain("clockInClashWords({ clash: overlap.clash, startIso: startAt, tz, isStaff: true, nothing }, lang, words)");
    expect(src("src/app/(app)/timeclock/actions.ts")).toContain("clockInClashWords({ clash: overlap.clash, startIso: clockInIso, tz, isStaff })");
  });

  it("the libraries import no catalog; the page and the pieces hand them the language", () => {
    for (const lib of ["src/lib/appointments/visit-start.ts", "src/lib/appointments/wont-happen.ts", "src/lib/inspection/inspection-access.ts", "src/lib/estimate/task-kits.ts", "src/lib/overlap-refusal.ts"]) {
      const s = src(lib);
      expect(s, lib).not.toMatch(/from\s+["'](@\/lib\/i18n|@\/lib\/words)/);
      expect(s, lib).toContain('import { say, type Words } from "@/lib/lang-words";');
    }
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("jobShort(oeJob, lang, t)");
    expect(page).toContain("{inspectionUnreadWords(lang, t)}");
    expect(page).toContain("kitsReadWords(taskKitsRead.state, lang, t)");
    expect(page.split('backLabel={t("sh_back")}').length - 1).toBe(2); // the two back links
    expect(page).not.toContain("INSPECTION_UNREAD");
    const card = src("src/app/(app)/appointments/[id]/visit-start-card.tsx");
    expect(card).toContain("startedAtProblem(startIso, nowMs, tz, lang, t)");
    expect(card).toContain("jobShort(job, lang, t)");
    expect(card).not.toContain("jobShort(linkInstead)");
    const rows = src("src/app/(app)/appointments/[id]/visit-header-actions.tsx");
    expect(rows).toContain('wontHappenConfirm(deletes ? "delete" : "cancel", lang, t)');
    expect(rows).toContain("wontHappenUndo(previousStatus, lang, t)");
    expect(rows).toContain('wontHappenToast("deleted", null, lang, t)');
    const acts = src("src/app/(app)/appointments/actions.ts");
    expect(acts).toContain("putBackPlan(startsAt ? todayStrInTz(tz, new Date(startsAt)) : null, todayStrInTz(tz), lang, translator(lang));");
    // Back: the shell's own word, handed in (the print pages draw this piece and carry no dictionary).
    const back = src("src/components/back-link.tsx");
    expect(back).toContain('backLabel = "Back",');
    expect(back).toContain("{canGoBack ? backLabel : fallbackLabel}");
    expect(back).not.toContain("@/lib/i18n");
    expect(dict("en").sh_back).toBe("Back");
    expect(dict("es").sh_back).toBe("Atrás");
    // The intake files row draws no words of its own: a file's name, and the server's own line as received.
    const files = src("src/app/(app)/leads/intake-files.tsx");
    expect(files).not.toMatch(/>[A-Z][a-z]+ [a-z]/);
  });
});

describe("the visit page catalog (vp_), builder D's half", () => {
  const vp = CATALOGS.find((c) => c.prefix === "vp_")!;
  const titleCase = (s: string) =>
    s
      .replace(/\{\w+\}/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => /^[¿¡]?[\p{Lu}\p{N}&\/+·(—–]/u.test(w));
  const D_BTN = [
    "vp_btn_newAppointment", "vp_btn_newInspection", "vp_btn_editAppointment", "vp_btn_editInspection", "vp_btn_saveAppointment", "vp_btn_saveInspection",
    "vp_btn_textTheCustomerTheseTimes", "vp_btn_createLink", "vp_btn_edit", "vp_btn_done", "vp_btn_delete", "vp_btn_copied", "vp_btn_copyLink", "vp_btn_textIt",
    "vp_btn_setATime", "vp_btn_proposeTimes", "vp_btn_anyone", "vp_btn_newLead", "vp_btn_newCustomer", "vp_btn_convertToJob", "vp_btn_clearTheDate", "vp_btn_clearing",
  ];

  it("names the four screens this half added, after C's seven", () => {
    expect(vp.files.slice(7)).toEqual([
      "src/app/(app)/appointments/appointment-button.tsx",
      "src/app/(app)/appointments/unschedule-button.tsx",
      "src/app/(app)/appointments/start-job-actions.ts",
      "src/app/(app)/leads/intake-files.tsx",
    ]);
  });

  it("every new vp_btn_ key is Title Case in both languages", () => {
    expect(D_BTN).toHaveLength(22);
    for (const k of D_BTN) {
      expect(vp.en[k], k).toBeTruthy();
      expect(titleCase(vp.en[k]), `en:${k} "${vp.en[k]}"`).toBe(true);
      expect(esTitleCase(vp.es[k]), `es:${k} "${vp.es[k]}"`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
  });

  it("the house words: one Spanish per English word across the catalogs, and no Spanish sentence ends on a clock", () => {
    const d = dict("es");
    expect(vp.es.vp_btn_newAppointment).toBe(d.nv_add_newAppointment);
    expect(vp.es.vp_btn_newInspection).toBe(d.nv_add_newInspection);
    expect(vp.es.vp_btn_newLead).toBe(d.nv_add_newLead);
    expect(vp.es.vp_btn_clearTheDate).toBe(d.ag_cal_btn_clearTheDate);
    expect(vp.es.vp_draftRestored).toBe(d.ag_rail_draftRestored);
    expect(vp.es.vp_btn_copied).toBe(d.su_btn_copied);
    expect(vp.es.vp_btn_copyLink).toBe(d.su_btn_copyLink);
    expect(vp.es.vp_btn_delete).toBe(d.tk_delete);
    expect(vp.es.vp_btn_done).toBe(d.su_btn_done);
    expect(vp.es.vp_btn_edit).toBe(d.tk_edit);
    expect(vp.es.vp_couldNotSave).toBe(d.tk_couldNotSave);
    expect(vp.es.vp_phone).toBe(d.ag_rail_phone);
    expect(vp.es.vp_date).toBe(d.ag_rail_date);
    expect(vp.es.vp_start).toBe(d.ag_cal_start);
    expect(vp.es.vp_end).toBe(d.ag_cal_end);
    expect(vp.es.vp_notes).toBe(d.jb_notes);
    expect(vp.es.vp_title).toBe(d.tk_titleLabel);
    expect(vp.es.vp_job).toBe(d.ag_job);
    expect(vp.es.vp_visitNotFound).toBe(d.ag_srv_apptGone);
    expect(vp.es.vp_btn_textIt).toMatch(/^Enviar .*por Mensaje$/); // su_btn_textReceipt's verb
    expect(vp.es.vp_pickSinceMidnightYesterday).toContain(d["sh_dock_ck-cards"]); // Tarjetas de Tiempo, the page's own name (nv_page_timecards too)
    expect(vp.es.vp_clashFixOnTimecards).toContain(d["sh_dock_ck-cards"]);
    expect(vp.es.vp_timeNotYet).toBe(d.cs_timeHasntHappened);
    expect(`+ ${vp.es.vp_btn_newCustomer}`).toBe(d.ag_rail_btn_newCustomer);
    expect(vp.es.vp_kitsThin).toContain("piezas"); // vi_partsOne, vi_partPlaceholder, ag_srv_partOne: pieza
    expect(vp.es.vp_kitsThin).not.toContain("partes");
    expect(vp.es.vp_clashWithNoJob).toBe(d.vp_noJob); // "with no job" / "no job": sin trabajo
    expect(vp.es.vp_nothingWasRecorded).toMatch(/^No se registró nada\.$/);
    expect(vp.es.vp_waitsUnderWaitingForADay).toContain(d.jb_waitingForADay);
    for (const k of Object.keys(vp.es).filter((k) => k in replaced)) expect(vp.es[k], `es:${k}`).not.toMatch(/\{(since|at|clock)\}\.$/);
  });

  /** Every vp_ key this half added, pinned to the English literal it replaced, byte for byte. */
  const replaced: Record<string, string> = {
    vp_btn_newAppointment: "New Appointment",
    vp_btn_newInspection: "New Inspection",
    vp_btn_editAppointment: "Edit Appointment",
    vp_btn_editInspection: "Edit Inspection",
    vp_btn_saveAppointment: "Save Appointment",
    vp_btn_saveInspection: "Save Inspection",
    vp_btn_textTheCustomerTheseTimes: "Text The Customer These Times",
    vp_btn_createLink: "Create Link",
    vp_btn_edit: "Edit",
    vp_btn_done: "Done",
    vp_btn_delete: "Delete",
    vp_btn_copied: "Copied",
    vp_btn_copyLink: "Copy Link",
    vp_btn_textIt: "Text It",
    vp_btn_setATime: "Set A Time",
    vp_btn_proposeTimes: "Propose Times",
    vp_btn_anyone: "— Anyone —",
    vp_btn_newLead: "New Lead",
    vp_btn_newCustomer: "New Customer",
    vp_btn_convertToJob: "Convert To Job",
    vp_draftRestored: "Draft restored — pick up where you left off",
    vp_zoneNote: "Times are {zone} time, the business's clock.",
    vp_couldNotCreateJob: "Could not create job.",
    vp_addAtLeastOneDateOption: "Add at least one date option.",
    vp_couldNotCreateTheLink: "Could not create the link.",
    vp_couldNotSave: "Could not save.",
    vp_deleteAppointmentAsk: "Delete the appointment \"{title}\"? This can't be undone.",
    vp_couldntDeleteAppointment: "Couldn't delete appointment — try again.",
    vp_appointmentDeleted: "Appointment deleted",
    vp_linkReadyAppointment: "Link ready — text it to the customer. The appointment confirms onto your calendar the moment they tap a time.",
    vp_textItNote: "Text It opens this phone’s own messaging app, so it sends from this phone’s number, not the business line. To send it from the business line, use Copy Link and paste it there.",
    vp_type: "Type",
    vp_assignedTo: "Assigned to",
    vp_title: "Title",
    vp_titlePlaceholder: "e.g. Inspection at the Smiths', follow-up visit",
    vp_date: "Date",
    vp_start: "Start",
    vp_end: "End",
    vp_offerUpToThreeTimes: "Offer up to 3 times — the customer taps one",
    vp_optionDateAria: "Option {n} date",
    vp_optionTimeAria: "Option {n} time",
    vp_job: "Job",
    vp_leadGoesOnIt: "A lead: this visit and its address go on it.",
    vp_someoneAlreadyYours: "Someone already yours who isn't in the list.",
    vp_notInTheList: "Not in the list? Add them here.",
    vp_newLeadName: "New lead name",
    vp_newCustomerName: "New customer name",
    vp_phone: "Phone",
    vp_optionalPlaceholder: "Optional",
    vp_location: "Location",
    vp_addressOrSite: "Address or site",
    vp_notes: "Notes",
    vp_btn_clearTheDate: "Clear The Date",
    vp_btn_clearing: "Clearing…",
    vp_couldntClearTheDate: "Couldn't clear the date.",
    vp_waitsUnderWaitingForADay: "It waits under Waiting For A Day on the schedule. Place it there when they call.",
    vp_onlyOfficeStartsJob: "Only the office can start a job. Ask the office to start it, then clock in here.",
    vp_visitNotFound: "That visit could not be found.",
    vp_visitCancelledNothingStarted: "This visit was cancelled. Nothing was started.",
    vp_nothingWasStarted: "Nothing was started.",
    vp_onClockSwitchHere: "You're on the clock on {label} since {since}. Switch To This Job moves your clock here now. Nothing was started yet.",
    vp_onClockLinkInstead: "You're on the clock on {job}, the job {customer} already has from today. Link this visit to {job} instead. Nothing was started.",
    vp_thisCustomerLower: "this customer",
    vp_jobCouldNotBeStarted: "The job could not be started. Nothing was changed.",
    vp_jobMadeNotReadBack: "The job was made but could not be read back. Reload the page before trying again.",
    vp_clockStillOn: "Your clock is still on {from}: {why}",
    vp_switchDidntGoThrough: "the switch did not go through.",
    vp_alreadyOnClockOn: "You were already on the clock on {job}.",
    vp_clockInDidntGoThrough: "The clock-in didn't go through: {why}",
    vp_tryAgainFromJobPage: "try again from the job page.",
    vp_onlyOfficeLinksVisit: "Only the office can link a visit to a job.",
    vp_alreadyLinkedToThatJob: "This visit is already linked to that job.",
    vp_alreadyLinkedToAnotherJob: "This visit is already linked to another job. Nothing was changed.",
    vp_jobNoLongerOffered: "That job is no longer the one to offer here. Nothing was changed. Edit Details links any job by hand.",
    vp_visitCouldNotBeLinked: "The visit could not be linked. Nothing was changed.",
    vp_clockAlreadyRunningOn: "Your clock is already running on {job}.",
    vp_linkedThisVisitTo: "Linked this visit to {job}. {note}{onIt}",
    vp_nothingNewWasMade: "Nothing new was made.",
    vp_notSignedIn: "Not signed in.",
    vp_accountCantSendThat: "This account can't send that.",
    vp_visitAlreadyHasJobReload: "This visit already has a job. Reload the page to clock in on it.",
    vp_nobodyInOfficeGetsMessages: "Nobody in the office gets messages in the app yet. Call them instead.",
    vp_didntReachOffice: "That didn't reach the office. Call them instead.",
    vp_officeAskedToStartJob: "The office has been asked to start a job for this visit.",
    vp_officeAskedClockInHere: "The office has been asked. Once they start the job, you can clock in right here.",
    vp_timeNotYet: "That time hasn't happened yet.",
    vp_pickSinceMidnightYesterday: "Pick a time since midnight yesterday. For older hours, add them on Timecards.",
    vp_theJobLower: "the job",
    vp_forCustomer: "for {customer}",
    vp_fromJob: "from {from}",
    vp_visitAlreadyHad: "This visit already had {job}{who}.",
    vp_clockedYouInOnIt: "Clocked you in on it at {at}.",
    vp_movedWholePunchOntoIt: "Moved your whole punch since {at} onto it.",
    vp_switchedClockToIt: "Switched your clock to it{from} at {at}.",
    vp_startedJob: "Started {job}{who}.",
    vp_startedAndClockedIn: "Started {job}{who} and clocked you in at {at}.",
    vp_startedAndMovedPunch: "Started {job}{who} and moved your whole punch since {at} onto it.",
    vp_startedAndSwitched: "Started {job}{who} and switched your clock here{from} at {at}.",
    vp_wontHappenDeleteAsk: "This visit won't happen? Nothing was captured on it, so it will be deleted.",
    vp_wontHappenCancelAsk: "This visit won't happen? Its notes, photos and answers stay on file, marked Cancelled.",
    vp_deletedNothingOnIt: "Deleted. Nothing was on it.",
    vp_markedCancelledStays: "Marked Cancelled. Everything on it stays on file.",
    vp_pickLinkStaysWithdrawn: "The pick-a-time link stays withdrawn — send a new one.",
    vp_backOnScheduleFor: "Back on the schedule for {day}.",
    vp_backWaitingDayPassed: "Back on the schedule, waiting for a day: {day} had passed.",
    vp_backWaitingForADay: "Back on the schedule, waiting for a day.",
    vp_inspectionUnread: "Couldn't read this inspection just now, so it isn't shown (nothing on it changed). Reload the page to try again.",
    vp_kitsThin: "The kits were read without their vendors or part links — part names may differ from the estimate's.",
    vp_kitsNeedUpdate: "Kits need the database update before a task can pick one.",
    vp_kitsCouldNotBeRead: "The kits could not be read — a task's kit picker is off until you reload; its own hours stand.",
    vp_bellNeedsJobStarted: "{first} needs a job started{forWho}",
    vp_bellVisitOverBody: "{first} asks for a job on {place}, a visit that is done, so the work can go on. Start it from the visit.",
    vp_bellAtVisitBody: "{first} is at {place} and can't clock in until it has a job. Start it from the visit.",
    vp_aVisitLower: "a visit",
    // The clock-in's clash (lib/overlap-refusal clockInClashWords, skeptic #50): the fragments of the Timecards' own sentence.
    vp_nothingWasRecorded: "Nothing was recorded.",
    vp_clashWhen: "{day}, {from} to {to}",
    vp_clashOnJob: "on {job}",
    vp_clashWithNoJob: "with no job",
    vp_clashFixOnTimecards: "fix that shift on Timecards",
    vp_clashAskOfficeToFix: "ask the office to fix that shift",
    vp_clashRecorded: "You already have hours recorded {when}{where}, so a clock started at {at} would count them twice. {nothing} Start the clock at {end} or later, or {fix}.",
    vp_clashRunning: "You already have a clock running since {when}{where}. {nothing}",
  };

  it("every English value this half added is the literal it replaced, byte for byte, and each has its own Spanish", () => {
    expect(Object.keys(replaced)).toHaveLength(122);
    for (const [k, v] of Object.entries(replaced)) {
      expect(vp.en[k], k).toBe(v);
      expect(vp.es[k], k).toBeTruthy();
      expect(vp.es[k], k).not.toBe(v);
    }
    // The whole catalog: C's 138 (the Lost door got its own vp_btn_ key, skeptic #50) and these 122.
    expect(Object.keys(vp.en)).toHaveLength(260);
  });
});
