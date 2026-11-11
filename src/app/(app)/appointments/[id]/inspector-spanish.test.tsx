import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, fillText, translator } from "@/lib/i18n";

/**
 * THE INSPECTOR IN SPANISH (the visit-page-in-Spanish wave, cn-v1144, vi_). The sheet a tech opens from
 * the schedule, rendered inside a LangProvider with "es": its headings, its doors and their aria-labels,
 * its placeholders, chips and tooltips, the bar's counts, the plans card and the office's own lines read
 * the catalog's Spanish; a question's own words, a stored answer, a kit's name and unit and a file's name
 * stay as stored; and no English door is left on it. The English renders are the sheet's own test
 * (inspector.test), untouched and drawn with no provider: English is the default, byte for byte — and
 * the table at the bottom pins every vi_ key's English to the literal it replaced. The unit project is
 * node with no DOM, so what needs a tap (a confirm, a located note, a save's refusal) is pinned on the
 * source and the catalog.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../actions", () => ({
  addInspectionPhotos: vi.fn(),
  removeInspectionPhoto: vi.fn(),
  saveInspectionAnswers: vi.fn(),
  saveInspectionCapture: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  searchLinkTargets: vi.fn(async () => []),
}));
vi.mock("../hear-actions", () => ({ hearIntoPlaybook: vi.fn() }));
vi.mock("../../forms/actions", () => ({ createStarterInspectionSheet: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: () => createElement("input", { "data-address-box": "yes" }),
}));

import { Inspector, measuredRowLabel, measureLabelWords } from "./inspector";
import { LangProvider } from "@/components/lang-provider";
import type { InspectionAccess } from "@/lib/inspection/inspection-access";
import type { PlanBrief } from "@/lib/plan-brief";
import { esTitleCase, titleCaseIn } from "../../../../../tests/title-case-words";

const SHEET = {
  id: "sheet-1",
  name: "Site walk",
  schema: [],
  playbook: {
    needs: [
      { key: "work", label: "Work", ask: "What kind of work is this?", slot: { type: "select", options: ["Deck", "Remodel"], other: true } },
      { key: "scope", label: "Scope", ask: "Which scopes?", slot: { type: "scopes" } },
      { key: "panel", label: "Panel", ask: "Which panel is it?", slot: { type: "text" } },
      { key: "tasks", label: "Tasks", ask: "What are the tasks?", slot: { type: "tasks" } },
    ],
  },
};
const ANSWERS = {
  work: "Remodel",
  scope: [{ code: "R1", qty: 2, price: 517.25 }],
  tasks: [
    { id: "t1", name: "Transfer switch", hours: 3, units: null, kit_id: null, materials: [{ code: "R1", words: null, qty: 2 }] },
    { id: "t2", name: "Hot tub wires", hours: null, units: null, kit_id: null, materials: [] },
  ],
};
const BOOK = [
  { code: "R1", description: "Remodel scope", unit: "EA", price: 517.25 },
  { code: "R2", description: "Demo", unit: "EA", price: 243.5 },
];
const PHOTO = { path: "org-1/appointments/appt-1/1-panel.jpg", url: "https://example.invalid/1-panel.jpg" };
const KIT = {
  id: "k1",
  name: "Footing",
  labor_minutes: 120,
  unit: "footing",
  items: [
    { id: "i1", description: "Concrete, 80 lb", quantity: 4, unit: "ea", sort_order: 0 },
    { id: "i2", description: "Rebar stake", quantity: 2, unit: "ea", sort_order: 1 },
  ],
};
const KIT_ANSWERS = { ...ANSWERS, tasks: [{ id: "t1", name: "Footings", hours: null, units: 7, kit_id: "k1", materials: [] }, ANSWERS.tasks[1]] };

/** The sheet, drawn for a Spanish reader (inside the provider) or an English one (none: the default). */
const render = (access: InspectionAccess, over: Record<string, unknown> = {}, lang: "es" | "en" = "es") => {
  const sheet = createElement(Inspector, {
    appointmentId: "appt-1",
    orgId: "org-1",
    userId: "u-1",
    templates: [SHEET],
    priceBook: access === "office" ? BOOK : [],
    initialTemplateId: "sheet-1",
    initialAnswers: ANSWERS as never,
    initialCapture: { notes: "Meter base pulling off the wall", photos: [PHOTO.path], measures: [{ id: "m1", label: "Run", value: 40, unit: "ft" }] },
    initialPhotos: [PHOTO],
    initialLocation: "12 Larkspur Ln",
    linked: { kind: "lead", name: "Snowbell Plumbing" },
    estimateHref: access === "office" ? "/quotes/new?capture=appt-1" : null,
    access,
    initialOpenTaskId: "t1",
    ...over,
  });
  return renderToStaticMarkup(lang === "es" ? <LangProvider lang="es">{sheet}</LangProvider> : sheet);
};
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => textOf(m[0]));
const vi_ = CATALOGS.find((c) => c.prefix === "vi_")!;
const es = dict("es");
const en = dict("en");

describe("a crew lead's sheet speaks Spanish", () => {
  const html = render("crewLead");
  const t = textOf(html);
  const doors = buttons(html);

  it("says whose it is, and every heading, door and jump chip is the catalog's Spanish", () => {
    expect(t).toContain("Eres el líder de cuadrilla de esta visita: llénala aquí. La oficina le pone precio.");
    for (const d of ["Guardar", "Tomar", "Agregar", "Solo Dile a Nort", "Otra Cosa", "Agregar una Medida", "Agregar una Tarea", "Agregar un Material", "Hecho", "Deck", "Remodel"]) expect(doors, d).toContain(d);
    const bar = html.slice(html.indexOf('aria-label="Ir a"'), html.indexOf("Inspección"));
    expect(buttons(bar)).toEqual(["Tareas", "Fotos", "Notas"]);
    for (const h of [">Inspección<", ">Para<", ">Materiales<", ">Fotos<", ">Medidas<", ">Nota<", ">Horas<", ">Respondidas<"]) expect(html, h).toContain(h);
    // The visit's own address and link read as stored; the price stays the office's.
    expect(t).toContain("12 Larkspur Ln");
    expect(t).toContain("Snowbell Plumbing");
    expect(t).toContain("R1 × 2");
    expect(t).toContain("La oficina los elige y les pone precio.");
  });

  it("the placeholders, the aria-labels and the chips", () => {
    for (const p of ["La parte del trabajo, en tus palabras", "cuántas", "qué mediste", "ft", "Lo que hay que saber de esta parte — la pared, el acceso, el detalle."]) {
      expect(html, p).toContain(`placeholder="${p}"`);
    }
    for (const a of ["Quitar Esta Tarea", "Quitar Este Material", "Quitar Esta Medida", "Ir a"]) expect(html, a).toContain(`aria-label="${a}"`);
    expect(html).toContain(">¿horas?<"); // the hot tub task still asks
    expect(t).toContain("Hot tub wires ¿horas?");
  });

  it("no English door, heading or line is left on it", () => {
    for (const d of ["Save", "Take", "Add", "Just Tell Nort", "Something Else", "Add a Measurement", "Add a Task", "Add a Material", "Done", "Where", "Tasks", "Photos", "Notes"]) expect(doors, d).not.toContain(d);
    expect(html).not.toMatch(/aria-label="(Remove This|Jump To|Kit)/);
    expect(html).not.toMatch(/>(Materials|Photos|Measurements|Note|Hours|Answered|Inspection)</);
    expect(t).not.toContain("crew lead on this visit");
    expect(t).not.toContain("The office picks and prices these.");
    expect(html).not.toMatch(/placeholder="[^"]*(words|measured|many)/);
  });

  it("the bar's counts: Spanish for the Spanish reader, and byte for byte the old English for the English one", () => {
    expect(t).toContain("1 sin responder · 1 medidas · 1 fotos");
    expect(textOf(render("crewLead", {}, "en"))).toContain("1 still open · 1 measurements · 1 photos");
  });
});

describe("the office's sheet speaks Spanish too", () => {
  it("Where, Use My Location, the sheet picker, the price-book door, the scope row's Remove, Start the Estimate", () => {
    const two = [SHEET, { ...SHEET, id: "sheet-2", name: "Service call" }];
    const html = render("office", { templates: two });
    expect(html).toContain(">Dónde<");
    expect(buttons(html)).toContain("Usar Mi Ubicación");
    expect(html).toContain(">Elegir una Hoja…<");
    expect(html).toContain(">Agregar una Partida…<");
    expect(html).toContain('aria-label="Quitar Remodel scope"');
    expect(buttons(html)).toContain("Empezar el Presupuesto");
    expect(html).toContain('href="/quotes/new?capture=appt-1"');
    expect(buttons(html)).not.toContain("Start the Estimate");
    expect(html).not.toContain("Pick a Sheet");
  });

  it("an estimate that stands opens as Abrir el Presupuesto", () => {
    const html = render("office", { estimate: { id: "q-1", number: "EST-7", live: true } });
    expect(buttons(html)).toContain("Abrir el Presupuesto");
    expect(buttons(html)).not.toContain("Empezar el Presupuesto");
    expect(html).not.toContain("Open the Estimate");
  });

  it("a task kit: the picker's rows, the Units box, the preview from the kit, the gone and unread kits", () => {
    const html = render("office", { taskKits: [KIT], initialAnswers: KIT_ANSWERS });
    expect(html).toContain('aria-label="Kit"'); // the word Spanish uses too
    expect(html).toContain(">Sin Kit<");
    expect(html).toContain(">Unidades<");
    expect(html).toContain('placeholder="unidades"');
    expect(textOf(html)).toContain("Del kit, para ×7 footing: 14 h · Concrete, 80 lb ×28, Rebar stake ×14");
    const hours = render("office", { taskKits: [KIT], initialAnswers: { ...KIT_ANSWERS, tasks: [{ ...KIT_ANSWERS.tasks[0], hours: 3 }, KIT_ANSWERS.tasks[1]] } });
    expect(textOf(hours)).toContain("Del kit, para ×7 footing: tus 3 h se quedan (el kit dice 14 h)");
    const gone = render("office", { taskKits: [], initialAnswers: KIT_ANSWERS });
    expect(gone).toContain(">¿kit?<");
    expect(gone).toContain(">Kit que Ya No Está en la Lista de Precios<");
    expect(gone).toContain('title="Ese kit ya no está en la lista de precios — elige otro o dale sus horas a la tarea"');
    const unread = render("office", { taskKits: [], kitsUnread: true, kitsNote: "The page's own note.", initialAnswers: KIT_ANSWERS });
    expect(textOf(unread)).toContain("Kit sin leer");
    expect(unread).toContain(">kit sin leer<");
    expect(textOf(unread)).toContain("The page's own note."); // the page's words, handed in: not the sheet's to translate
    expect(unread).not.toContain("not read");
  });

  it("the task rows, collapsed: the counts and the kit's hours in Spanish, the task's own words as typed", () => {
    const cap = { notes: "", photos: [PHOTO.path], photo_meta: { [PHOTO.path]: { task_id: "t2" } }, measures: [{ id: "m2", label: "Drop", value: 8, unit: "ft", task_id: "t2" }] };
    const html = render("office", { taskKits: [KIT], initialAnswers: KIT_ANSWERS, initialOpenTaskId: null, initialCapture: cap });
    const t = textOf(html);
    expect(t).toContain("Footings horas del kit · ×7 footing · Footing");
    expect(t).toContain("Hot tub wires 1 foto · 1 medida ¿horas?");
    expect(buttons(html)).toContain("Agregar una Tarea");
    expect(buttons(html)).not.toContain("Hecho");
  });

  it("the plans card: its title, its rows, the one sentence with the bold heading inside it, and the Fill door — in Spanish, and byte for byte in English", () => {
    const brief: PlanBrief = {
      v: 1,
      status: "ready",
      at: "2026-11-05T00:00:00Z",
      files: [],
      skipped: [],
      summary: "Two new circuits.",
      scope_included: ["Panel"],
      scope_excluded: ["Trenching"],
      cautions: ["Check the feed"],
      observations: ["o1", "o2"],
      answers: { work: "Remodel", panel: "Main" },
    };
    const html = render("office", { planBrief: brief });
    const t = textOf(html);
    expect(t).toContain("Informe preliminar — de los planos del cliente");
    expect(t).toContain("Incluye: Panel");
    expect(t).toContain("Excluye: Trenching");
    expect(t).toContain("Verificar en el sitio: Check the feed");
    expect(t).toContain("Más de los planos (2)");
    // The heading's own name, still bold, inside the one sentence — the key split at its {answered} slot.
    expect(html).toContain(
      'Work — están abajo en <span class="font-medium">Respondidas</span>; corrige lo que esté mal. Las preguntas que siguen aquí son las que los planos no pudieron responder.',
    );
    expect(t).toContain("Ya llenado desde los planos: Work");
    expect(buttons(html)).toContain("Llenar 1 Respuesta desde los Planos");
    const e = textOf(render("office", { planBrief: brief }, "en"));
    expect(e).toContain("Already filled from the plans: Work — they're under Answered below, edit anything that's off. The questions still showing here are the ones the plans couldn't answer.");
    expect(e).toContain("Fill 1 Answer from the Plans");
    expect(e).toContain("More from the plans (2)");
  });

  it("everything answered, a hold, retired answers", () => {
    const hold = { ...SHEET, playbook: { needs: SHEET.playbook.needs.map((n) => (n.key === "panel" ? { ...n, hold: true } : n)) } };
    const html = render("office", { templates: [hold], initialAnswers: { ...ANSWERS, old_question: "a kept answer" } });
    const t = textOf(html);
    expect(t).toContain("antes de ponerle precio");
    expect(t).toContain("De preguntas que cambiaste después");
    expect(t).toContain("Respondiste esto en el sitio y luego editaste tus preguntas. No se perdió nada — copia lo que valga la pena conservar en las casillas de arriba.");
    expect(t).toContain("a kept answer");
    expect(textOf(render("office", { initialAnswers: { ...ANSWERS, panel: "Main" } }))).toContain("Eso es todo lo que este trabajo necesita.");
  });

  it("a file question: Agregar Archivos, the office's Quitar, the file by its name", () => {
    const withFile = { ...SHEET, playbook: { needs: [...SHEET.playbook.needs, { key: "plans", label: "Plans", ask: "Upload the plans", slot: { type: "file", multi: true } }] } };
    const html = render("office", { templates: [withFile], initialAnswers: { ...ANSWERS, plans: ["org-1/appointments/appt-1/1700000000000-plans.pdf"] } });
    expect(textOf(html)).toContain("Agregar Archivos");
    expect(buttons(html)).toContain("Quitar");
    expect(textOf(html)).toContain("plans.pdf");
    expect(html).not.toContain("Add Files");
  });
});

describe("a plain tech and an empty sheet, in Spanish", () => {
  it("a plain tech reads one line and no door; the page's own note, handed in, stands as it came", () => {
    const html = render("view");
    expect(textOf(html)).toContain("Solo la oficina puede cambiar la inspección.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    for (const d of ["Guardar", "Tomar", "Agregar", "Save", "Take", "Add"]) expect(buttons(html), d).not.toContain(d);
    const note = textOf(render("view", { viewNote: "Los líderes de cuadrilla pueden llenarla cuando la oficina termine." }));
    expect(note).toContain("Los líderes de cuadrilla pueden llenarla cuando la oficina termine.");
    expect(note).not.toContain("Solo la oficina puede cambiar la inspección.");
  });

  it("no questions yet: the office is told to set them up (two doors); a crew lead that notes still save; a tech only that there are none", () => {
    const office = render("office", { templates: [], initialTemplateId: null, initialAnswers: {} });
    expect(textOf(office)).toContain("Aún no tienes un conjunto de preguntas de inspección. Empieza con las de tu oficio — una pregunta a la vez, y solo lo que aplica al trabajo que tienes enfrente.");
    expect(buttons(office)).toContain("Configurar Mis Preguntas");
    expect(office).toContain(">O Armar las Mías<");
    expect(textOf(render("crewLead", { templates: [], initialTemplateId: null, initialAnswers: {} }))).toContain(
      "La oficina aún no ha configurado las preguntas de inspección. Las notas, medidas y fotos de abajo sí se guardan.",
    );
    const tech = textOf(render("view", { templates: [], initialTemplateId: null, initialAnswers: {} }));
    expect(tech).toContain("La oficina aún no ha configurado las preguntas de inspección.");
    expect(tech).not.toContain("Las notas, medidas y fotos");
  });

  it("the empty photo grid, the section label, and the reach-for chips under their one-word label", () => {
    const html = render("crewLead", { initialPhotos: [], initialCapture: { notes: "", photos: [], measures: [] } });
    const t = textOf(html);
    expect(t).toContain("Lo que quieras volver a ver desde la oficina.");
    expect(t).toContain("Fotos y documentos");
    expect(html).toContain('<span class="text-[11px] uppercase tracking-wide text-slate-400">Agregar</span>');
    expect(buttons(html)).toEqual(expect.arrayContaining(["Medida", "Material", "Nota"]));
    expect(buttons(html)).not.toEqual(expect.arrayContaining(["Measurement"]));
  });
});

describe("the sheet's source reads every word through t()", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/appointments/[id]/inspector.tsx"), "utf8");
  it("the mechanism: useLang + translator, one t per render, the task card's loop variable renamed so it cannot shadow it", () => {
    expect(src).toContain('import { useLang } from "@/components/lang-provider";');
    expect(src).toContain('import { fillText, translator } from "@/lib/i18n";');
    expect(src).toContain("const lang = useLang();");
    expect(src).toContain("const t = translator(lang);");
    expect(src).toContain("{tasks.map((task, i) => {");
    expect(src).not.toContain("{tasks.map((t, i) => {");
  });
  it("no literal placeholder, aria-label, title, heading or confirm is left in it; the server's words are shown as received", () => {
    expect(src).not.toMatch(/placeholder="[^"]*\p{L}/u);
    expect(src).not.toMatch(/aria-label="[^"]*\p{L}/u);
    expect(src).not.toMatch(/\btitle="[^"]*\p{L}/u);
    expect(src).not.toMatch(/<SectionLabel>\p{L}/u);
    expect(src).not.toMatch(/confirm\("/);
    expect(src).not.toMatch(/setLocatedNote\(\s*["`]/);
    // A refusal from the server is said as it came (appointments/actions and hear-actions already speak the reader's language).
    expect(src).toContain('setError(r.error ?? t("vi_couldntSavePhotos"));');
    expect(src).toContain('if (!r.ok) setError(r.error ?? t("vi_couldntSetThatUp"));');
    // The library sentences the sheet shows are handed the sheet's language (builder E): the libraries keep their English
    // inline and say the vi_ catalog's Spanish through lib/lang-words say; the Discard door is the catalog's own key.
    expect(src).toContain('{t("vi_btn_discardKept3dModel")}');
    expect(src).toContain("offerLabel(word, offer.length, lang, t)");
    expect(src).toContain("retiredLabel(k, lang, t)");
    expect(src).toContain("measureNative(mode, lang, t)");
    expect(src).toContain("scan3dNative(Date.now(), lang, t)");
    expect(src).toContain("keptWords(true, lang, t)");
    expect(src).toContain("keptWords(false, lang, t)");
    expect(src).toContain("jobFilingWords(copyErr, lang, t)");
    expect(src.split("<DropTarget ").length - 1).toBe(2);
    expect(src.split(" words={t} className=").length - 1).toBe(2); // both drop zones, the translator in hand
  });

  it("a measured row's stored label is the English literal whatever the tech reads (a record the office and the estimate open); the box draws the catalog's word for it, and his own words as typed", () => {
    // The mechanism: Measure writes the row through translator("en"), never the sheet's t.
    expect(src).toContain("const label = measuredRowLabel(mode, r.approx);");
    // cn-v1160: the rule lives in lib/inspection/measured-label now (the + menu's Measure names a result with it);
    // the Inspector binds it to translator("en"), so the stored label is still English whatever he reads.
    expect(src).toContain('return measuredRowLabelIn(translator("en"), mode, approx);');
    expect(readFileSync(join(process.cwd(), "src/lib/inspection/measured-label.ts"), "utf8")).toContain('return mode === "area" ? (approx ? "vi_measuredAreaApprox" : "vi_measuredArea") : approx ? "vi_measuredLengthApprox" : "vi_measuredLength";');
    expect(src.split("value={measureLabelWords(m.label, t)}").length - 1).toBe(2);
    expect(src).not.toMatch(/const label = t\(/);
    // A Spanish tech's saved label equals the English literal.
    expect(measuredRowLabel("length", false)).toBe("Measured length");
    expect(measuredRowLabel("length", true)).toBe("Measured length (approx.)");
    expect(measuredRowLabel("area", false)).toBe("Measured area");
    expect(measuredRowLabel("area", true)).toBe("Measured area (approx.)");
    for (const k of ["vi_measuredLength", "vi_measuredLengthApprox", "vi_measuredArea", "vi_measuredAreaApprox"]) expect(es[k], k).not.toBe(en[k]);
    // What the box shows: the catalog's word for a stored Measure label; anything else as stored; English as stored.
    expect(measureLabelWords("Measured length", translator("es"))).toBe(es.vi_measuredLength);
    expect(measureLabelWords("Measured area (approx.)", translator("es"))).toBe(es.vi_measuredAreaApprox);
    expect(measureLabelWords("Run", translator("es"))).toBe("Run");
    expect(measureLabelWords("Largo medido pared", translator("es"))).toBe("Largo medido pared");
    expect(measureLabelWords("Measured length", translator("en"))).toBe("Measured length");
    // Rendered: the stored English row reads Largo medido to a Spanish reader and Measured length to an English one.
    const capture = { notes: "", photos: [], measures: [{ id: "m1", label: "Measured length", value: 12, unit: "ft" }] };
    expect(render("office", { initialCapture: capture, initialOpenTaskId: null })).toContain(`value="${es.vi_measuredLength}"`);
    expect(render("office", { initialCapture: capture, initialOpenTaskId: null }, "en")).toContain('value="Measured length"');
  });
});

describe("the Inspector catalog (vi_)", () => {
  /** English Title Case through the one judge (cn-v1148: significant words; tests/title-case-words). */
  const titleCase = (s: string) => titleCaseIn(s, "en");

  it("names the one screen that reads it, and nothing else", () => {
    expect(vi_).toBeTruthy();
    expect(vi_.files).toEqual(["src/app/(app)/appointments/[id]/inspector.tsx"]);
  });

  it("every vi_btn_ key is Title Case in both languages", () => {
    const doors = Object.keys(vi_.en).filter((k) => k.startsWith("vi_btn_"));
    expect(doors.length).toBeGreaterThanOrEqual(40);
    for (const k of doors) {
      expect(titleCase(vi_.en[k]), `en:${k} "${vi_.en[k]}"`).toBe(true);
      expect(esTitleCase(vi_.es[k]), `es:${k} "${vi_.es[k]}"`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
  });

  it("what reads the same in both is declared, and only that: the sensor's name, Kit, Material, the unit ft, the two badges", () => {
    expect([...vi_.sameInBoth].sort()).toEqual(["vi_badge3d", "vi_badgePdf", "vi_btn_material", "vi_ftPlaceholder", "vi_kit", "vi_lidar"].sort());
    for (const k of vi_.sameInBoth) expect(vi_.es[k]).toBe(vi_.en[k]);
    for (const k of Object.keys(vi_.en)) if (!vi_.sameInBoth.includes(k)) expect(vi_.es[k], k).not.toBe(vi_.en[k]);
  });

  it("the house words, one Spanish per English across the catalogs: Hecho, Agregar, Quitar, Guardar, Guardado, Guardando…, Fotos, Materiales, Notas, Nota, Horas, Inspección, Presupuesto, Lista de Precios, Oficina, señal, líder de cuadrilla, medidas", () => {
    expect(es.vi_btn_done).toBe(es.ag_btn_done);
    expect(es.vi_btn_done).toBe(es.su_btn_done);
    expect(es.vi_btn_add).toBe(es.jb_add);
    expect(es.vi_btn_remove).toBe(es.jb_remove);
    expect(es.vi_btn_remove).toBe(es.sh_remove);
    expect(es.vi_btn_save).toBe(es.jb_save);
    expect(es.vi_saved).toBe(es.jb_saved);
    expect(es.vi_btn_saving).toBe(es.su_btn_saving);
    expect(es.vi_photos).toBe(es.jb_tabPhotos);
    expect(es.vi_materials).toBe(es.jb_tabMaterials);
    expect(es.vi_materials).toBe(es.md_materials);
    expect(es.vi_notes).toBe(es.jb_notes);
    expect(es.vi_note).toBe(es.su_note);
    expect(es.vi_hours).toBe(es.jb_hours);
    expect(es.vi_inspection).toBe(es.jb_apptInspection);
    expect(es.vi_inspection).toBe(es.ag_btn_kindInspection);
    expect(es.vi_btn_startTheEstimate).toContain(es.nt_estimate); // Presupuesto
    expect(es.vi_btn_openTheEstimate).toContain(es.nt_estimate);
    expect(Object.values(es)).toContain("Lista de Precios"); // the office's map says it so (cn-v1139) …
    expect(es.vi_btn_kitNoLongerInThePriceList).toContain("Lista de Precios"); // … and the door says it the same way
    expect(es.vi_kitGoneTitle).toContain("lista de precios");
    expect(es.vi_crewLeadLine).toContain("líder de cuadrilla");
    expect(es.ag_srv_crewOrOffice).toContain("líder de cuadrilla");
    expect(es.vi_onlyOfficeChanges).toContain("la oficina");
    expect(es.md_office).toBe("Oficina");
    for (const k of ["vi_noSignalAddressHeld", "vi_noSignalAnswersHeld", "vi_noSignalPhotoStays", "vi_noSignalTypeAddress"]) expect(es[k], k).toMatch(/^Sin señal — /);
    expect(es.md_offline).toContain("señal");
    expect(es.vi_measurements).toBe("Medidas");
    expect(es.ag_cal_inspectionCapture).toContain("medidas");
  });

  it("the plurals are paired, the measured labels are whole, and every slotted sentence carries its slots in both languages", () => {
    for (const base of ["vi_parts", "vi_photos", "vi_measurements"]) {
      expect(en[`${base}One`]).toMatch(/^\{n\} \w+$/);
      expect(en[`${base}Many`]).toMatch(/^\{n\} \w+s$/);
      expect(es[`${base}One`]).toMatch(/^\{n\} \w+$/);
      expect(es[`${base}Many`]).toMatch(/^\{n\} \w+s$/);
    }
    expect(en.vi_btn_fillAnswersFromPlansOne).toContain("{n} Answer ");
    expect(en.vi_btn_fillAnswersFromPlansMany).toContain("{n} Answers ");
    expect(es.vi_btn_fillAnswersFromPlansOne).toContain("{n} Respuesta ");
    expect(es.vi_btn_fillAnswersFromPlansMany).toContain("{n} Respuestas ");
    expect(es.vi_measuredAreaApprox).toBe(`${es.vi_measuredArea} (aprox.)`);
    expect(es.vi_measuredLengthApprox).toBe(`${es.vi_measuredLength} (aprox.)`);
    for (const k of Object.keys(vi_.en)) {
      const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(slots(vi_.es[k]), k).toEqual(slots(vi_.en[k]));
    }
    expect(en.vi_fromKitForUnit).toContain("×{units} {unit}");
    expect(es.vi_fromKitForUnit).toContain("×{units} {unit}");
  });

  it("every English value is the literal it replaced, byte for byte", () => {
    const replaced: Record<string, string> = {
      vi_inspection: "Inspection",
      vi_where: "Where",
      vi_for: "For",
      vi_jumpTo: "Jump To",
      vi_btn_where: "Where",
      vi_btn_tasks: "Tasks",
      vi_btn_photos: "Photos",
      vi_btn_notes: "Notes",
      vi_answered: "Answered",
      vi_measurements: "Measurements",
      vi_materials: "Materials",
      vi_photos: "Photos",
      vi_photosAndDocuments: "Photos & documents",
      vi_notes: "Notes",
      vi_note: "Note",
      vi_lidar: "Lidar",
      vi_hours: "Hours",
      vi_kit: "Kit",
      vi_units: "Units",
      vi_add: "Add",
      vi_btn_measurement: "Measurement",
      vi_btn_material: "Material",
      vi_btn_note: "Note",
      vi_btn_measure: "Measure",
      vi_btn_measureArea: "Measure Area",
      vi_btn_scan3d: "3D Scan",
      vi_btn_somethingElse: "Something Else",
      vi_btn_addALineItem: "Add a Line Item…",
      vi_btn_removeWhat: "Remove {what}",
      vi_btn_removeThisTask: "Remove This Task",
      vi_btn_noKit: "No Kit",
      vi_btn_kitNoLongerInThePriceList: "Kit No Longer in the Price List",
      vi_btn_removeThisMaterial: "Remove This Material",
      vi_btn_addAMaterial: "Add a Material",
      vi_btn_take: "Take",
      vi_btn_add: "Add",
      vi_btn_removeThisPhoto: "Remove This Photo",
      vi_btn_removeThisMeasurement: "Remove This Measurement",
      vi_btn_addAMeasurement: "Add a Measurement",
      vi_btn_done: "Done",
      vi_btn_addATask: "Add a Task",
      vi_btn_addFiles: "Add Files",
      vi_btn_remove: "Remove",
      vi_btn_pickASheet: "Pick a Sheet…",
      vi_btn_useMyLocation: "Use My Location",
      vi_btn_fillAnswersFromPlansOne: "Fill {n} Answer from the Plans",
      vi_btn_fillAnswersFromPlansMany: "Fill {n} Answers from the Plans",
      vi_btn_filledFromThePlans: "Filled from the Plans",
      vi_btn_justTellNort: "Just Tell Nort",
      vi_btn_setUpMyQuestions: "Set Up My Questions",
      vi_btn_settingUp: "Setting Up…",
      vi_btn_orBuildMyOwn: "Or Build My Own",
      vi_btn_save: "Save",
      vi_btn_saving: "Saving…",
      vi_btn_openTheEstimate: "Open the Estimate",
      vi_btn_startTheEstimate: "Start the Estimate",
      vi_inYourOwnWords: "In your own words",
      vi_pieceOfWorkPlaceholder: "The piece of work, in your words",
      vi_unitsPlaceholder: "units",
      vi_partPlaceholder: "A part, in your words",
      vi_howManyPlaceholder: "how many",
      vi_whatYouMeasuredPlaceholder: "what you measured",
      vi_ftPlaceholder: "ft",
      vi_taskNotePlaceholder: "What's true about this piece — the wall, the access, the catch.",
      vi_jobAddressPlaceholder: "Job address",
      vi_measurementsProsePlaceholder: "Anything a number doesn't hold — “35' to the far corner, uphill”.",
      vi_whatYouNeedPlaceholder: "what you need",
      vi_materialsProsePlaceholder: "Or just type it, the way you'd read it out: each item, how much, and the size.",
      vi_notesPlaceholder: "Anything the questions didn't cover.",
      vi_howManyUnitsTitle: "How many units? The kit's hours and parts are per unit",
      vi_kitGoneTitle: "That kit is no longer in the price list — pick another or give the task its hours",
      vi_kitsNotReadTitle: "The kits could not be read — reload to see this task's kit; its own hours stand",
      vi_chipName: "name?",
      vi_chipHours: "hours?",
      vi_chipUnits: "units?",
      vi_chipKit: "kit?",
      vi_kitNotRead: "kit not read",
      vi_notRead: "not read",
      vi_kitGoneLower: "a kit no longer in the price list",
      vi_none: "none",
      vi_taskNoNameYet: "A task with no name yet",
      vi_hoursFromTheKit: "hours from the kit",
      vi_partsOne: "{n} part",
      vi_partsMany: "{n} parts",
      vi_photosOne: "{n} photo",
      vi_photosMany: "{n} photos",
      vi_measurementsOne: "{n} measurement",
      vi_measurementsMany: "{n} measurements",
      vi_fromKitPer: "From the kit, per {unit}",
      vi_fromKitForUnit: "From the kit, for ×{units} {unit}",
      vi_fromKitFor: "From the kit, for ×{units}",
      vi_unitLower: "unit",
      vi_yourHoursStand: "your {hours} h stand (the kit says {kit} h)",
      vi_noPhotosOnTaskYet: "No photos on this task yet.",
      vi_nothingPickedYet: "Nothing picked yet.",
      vi_officePicksAndPrices: "The office picks and prices these.",
      vi_thatsAllOfThem: "That's all of them.",
      vi_addItemsToPriceList: "Add items to your price list and they'll show up here.",
      vi_dropThePlans: "Drop the Plans",
      vi_dropPhotosPdfs3d: "Drop Photos, PDFs or 3D Files",
      vi_fileTypeNotAccepted: "{name} isn't a file type we accept.",
      vi_badge3d: "3D",
      vi_badgePdf: "PDF",
      vi_whateverYoudWant: "Whatever you’d want to look at again from the office.",
      vi_onlyOfficeChanges: "Only the office can change the inspection.",
      vi_crewLeadLine: "You’re the crew lead on this visit: fill it in here. The office prices it.",
      vi_switchSheetConfirm: "Switching to a different set of questions clears the answers you've given — they belong to the other sheet. Switch anyway?",
      vi_noAddressYet: "No address yet. The office adds it.",
      vi_preliminaryReport: "Preliminary report — from the customer's plans",
      vi_includes: "Includes:",
      vi_excludes: "Excludes:",
      vi_verifyOnSite: "Verify on site:",
      vi_moreFromThePlans: "More from the plans ({n})",
      vi_alreadyFilledFromPlans: "Already filled from the plans:",
      vi_seededUnderAnswered: "{list} — they're under {answered} below, edit anything that's off. The questions still showing here are the ones the plans couldn't answer.",
      vi_noQuestionsYetOffice: "You don’t have a set of inspection questions yet. Start with the ones for your trade — one question at a time, and only what applies to the job in front of you.",
      vi_officeNoQuestionsYet: "The office hasn’t set up inspection questions yet.",
      vi_officeNoQuestionsYetCrew: "The office hasn’t set up inspection questions yet. Notes, measurements and photos below still save.",
      vi_thatsEverything: "That’s everything this job needs.",
      vi_beforeYouPriceIt: "before you price it",
      vi_fromQuestionsChanged: "From questions you’ve since changed",
      vi_answeredThenEdited: "You answered these on site, then edited your questions. Nothing was lost — copy anything still worth keeping into the boxes above.",
      vi_stillOpen: "{n} still open",
      vi_allQuestionsAnswered: "all questions answered",
      vi_countMaterials: "{n} materials",
      vi_savingLower: "saving…",
      vi_saved: "Saved",
      vi_couldntSaveAddress: "Couldn't save the address — still trying.",
      vi_noSignalAddressHeld: "No signal — the address is held on this phone and will save when you're back in range.",
      vi_couldntSaveStillTrying: "Couldn't save — still trying.",
      vi_noSignalAnswersHeld: "No signal — your answers are held on this phone and will save when you're back in range.",
      vi_measurePictureMissing: "The measurement landed, but its picture didn't come back.",
      vi_visitDidntSaveModel: "The visit didn't save the 3D model.",
      vi_modelDidntUpload: "The 3D model didn't upload.",
      vi_modelOffVisitFileInStorage: "The 3D model is off the visit, but its file is still in storage.",
      vi_discardKeptConfirm: "Discard the kept 3D model? The room would need scanning again.",
      vi_couldntSavePhotos: "Couldn't save the photos.",
      vi_removeThisConfirm: "Remove this?",
      vi_couldntRemoveIt: "Couldn't remove it.",
      vi_noSignalPhotoStays: "No signal — the photo is still on the inspection. Try again when you're back in range.",
      vi_couldntSetThatUp: "Couldn't set that up.",
      vi_measuredLength: "Measured length",
      vi_measuredLengthApprox: "Measured length (approx.)",
      vi_measuredArea: "Measured area",
      vi_measuredAreaApprox: "Measured area (approx.)",
      vi_locationOffForNorth: "Location is off for North — turn it on in Settings.",
      vi_couldntGetFix: "Couldn't get a fix — step outside and try again, or type the address.",
      vi_onlySureWithin: "Only sure to within {m} m — step closer and tap again, or type the number.",
      vi_noStreetAddressHere: "No street address at this spot — type the number and street.",
      vi_lookupDailyLimit: "Address lookup is at its daily limit — type the address.",
      vi_lookupDown: "Address lookup is down — type the address.",
      vi_fromYourPhoneWithin: "From your phone, within {m} m.",
      vi_noSignalTypeAddress: "No signal — type the address for now.",
      // The libraries' and the drop zone's sentences (builder E): the English each library keeps inline, byte for byte.
      vi_btn_discardKept3dModel: "Discard Kept 3D Model",
      vi_keptSendAgain: "It's kept on this phone — tap 3D Scan again to send it without scanning.",
      vi_keptSaveAgain: "The model is up on the visit, so tap 3D Scan again to save it.",
      vi_keptForRemovedTask: "The kept 3D model was scanned for a task that has been removed. Tap {button}.",
      vi_keptElsewhere: "The 3D model scanned for {place} is still waiting to send. Tap 3D Scan there to send it.",
      vi_theVisit: "the visit",
      vi_modelLost: "The model didn't come over from the camera whole, so it's lost. Tap 3D Scan to scan again.",
      vi_jobFiling: "The 3D model is on the visit, but it didn't file on the job. Tell the office to file it.",
      vi_jobFilingWhy: "The 3D model is on the visit, but it didn't file on the job: {why}. Tell the office to file it.",
      vi_whyNoSignal: "no signal",
      vi_whyCantFileThere: "this login can't file there",
      vi_scanNeedsLidarIphone: "3D Scan needs the North app on an iPhone with a LiDAR sensor.",
      vi_couldntOpenScan: "Couldn't open 3D Scan. Try again.",
      vi_modelCameBackEmpty: "The model came back empty. Try again with more light and a slower walk.",
      vi_modelTooBig: "The model is too big to send ({mb} MB). Scan a smaller area.",
      vi_uploadTooBig: "{what} is too big to send ({mb} MB). {action}",
      vi_uploadNoSignal: "{what} didn't go: no signal. Try again where there's service.",
      vi_uploadFailed: "Upload failed.",
      vi_measuresFull: "{n} measurements is the most a visit holds. Take one off first.",
      vi_the3dModel: "The 3D model",
      vi_theFile: "The file",
      vi_scanSmallerArea: "Scan a smaller area.",
      vi_sendSmallerFile: "Send a smaller file.",
      vi_measureNeedsIphone: "Measure needs the North app on an iPhone.",
      vi_couldntOpenMeasure: "Couldn't open Measure. Try again, or type the measurement.",
      vi_measureNoNumber: "Measure came back without a number. Try again.",
      vi_measureSameSpot: "Measure came back with nothing — the points sat on the same spot. Try again.",
      vi_btn_addTheScopeTasks: "Add the {scope} Tasks {count}",
      vi_retiredWas: "{base} — choices you've since changed",
      vi_retiredKept: "{base} — answered before you changed this question",
      vi_dropFilesHere: "Drop Files Here",
      vi_fileTypeDoesntGoHere: "That file type doesn't go here",
      vi_btn_tapToDismiss: "Tap to Dismiss",
    };
    // The table is the catalog, whole: a key added to one and not the other is a hole.
    expect(Object.keys(replaced).sort()).toEqual(Object.keys(vi_.en).sort());
    for (const [k, literal] of Object.entries(replaced)) expect(translator("en")(k), k).toBe(literal);
    // The sentences the old sheet assembled, re-assembled through the slots, are the old sentences.
    expect(fillText(en.vi_fromKitForUnit, { units: "7", unit: "footing" })).toBe("From the kit, for ×7 footing");
    expect(fillText(en.vi_fromKitPer, { unit: en.vi_unitLower })).toBe("From the kit, per unit");
    expect(fillText(en.vi_yourHoursStand, { hours: "3", kit: "14" })).toBe("your 3 h stand (the kit says 14 h)");
    expect(fillText(en.vi_btn_fillAnswersFromPlansOne, { n: "1" })).toBe("Fill 1 Answer from the Plans");
    expect(fillText(en.vi_btn_fillAnswersFromPlansMany, { n: "2" })).toBe("Fill 2 Answers from the Plans");
    expect(fillText(en.vi_measurementsMany, { n: "1" })).toBe("1 measurements"); // the bar's old words, singular and all
    expect(fillText(en.vi_photosOne, { n: "1" })).toBe("1 photo");
    expect(fillText(en.vi_partsMany, { n: "2" })).toBe("2 parts");
    expect(fillText(en.vi_onlySureWithin, { m: "12" })).toBe("Only sure to within 12 m — step closer and tap again, or type the number.");
    expect(fillText(en.vi_fromYourPhoneWithin, { m: "9" })).toBe("From your phone, within 9 m.");
    expect(fillText(en.vi_btn_removeWhat, { what: "Remodel scope" })).toBe("Remove Remodel scope");
    expect(fillText(en.vi_moreFromThePlans, { n: "2" })).toBe("More from the plans (2)");
    expect(fillText(en.vi_fileTypeNotAccepted, { name: "plans.exe" })).toBe("plans.exe isn't a file type we accept.");
    expect(fillText(en.vi_stillOpen, { n: "3" })).toBe("3 still open");
    const [before, after] = en.vi_seededUnderAnswered.split("{answered}");
    expect(`${fillText(before, { list: "Work, Panel" })}Answered${after}`).toBe(
      "Work, Panel — they're under Answered below, edit anything that's off. The questions still showing here are the ones the plans couldn't answer.",
    );
  });
});
