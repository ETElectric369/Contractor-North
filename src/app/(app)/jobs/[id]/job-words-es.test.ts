import { describe, it, expect, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fillNodes } from "@/components/fill-nodes";

/**
 * THE JOB PAGE AS A SPANISH-SPEAKING TECH SEES IT (cn-v1138). Every component on the job page reads
 * its words through the jb_ catalog (src/lib/words/jobs.ts) and the person's language from
 * LangProvider: wrapped in lang="es" the doors read in Spanish, and with no provider (an English
 * profile, a public page, every older test) the English is byte for byte what it was. Each case
 * renders the real component once each way.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/app/(app)/jobs/actions", () => ({
  deleteDocument: vi.fn(),
  updateDocument: vi.fn(),
  linkReceiptToBill: vi.fn(),
  updateJobDescription: vi.fn(),
  updateJobNotes: vi.fn(),
  setJobStatus: vi.fn(),
  finishJob: vi.fn(),
  finishJobPreview: vi.fn(),
  deleteJob: vi.fn(),
}));
vi.mock("@/app/(app)/schedule/actions", () => ({
  changeJobCrew: vi.fn(),
  setJobHold: vi.fn(),
  snoozeJobHold: vi.fn(),
  setJobScheduleRanges: vi.fn(),
  setJobTimes: vi.fn(),
}));
vi.mock("@/app/(app)/tasks/actions", () => ({ createTask: vi.fn(), toggleTask: vi.fn(), deleteTask: vi.fn(), updateTask: vi.fn(), setTaskDonePhoto: vi.fn() }));
vi.mock("@/app/(app)/timeclock/actions", () => ({ clockIn: vi.fn(), switchJob: vi.fn(), clockOutCurrent: vi.fn(), createManualEntry: vi.fn() }));
vi.mock("@/app/(app)/jobs/portal-share-actions", () => ({ reshowPhoto: vi.fn(), setPhotoShared: vi.fn() }));
vi.mock("@/app/(app)/jobs/[id]/job-contacts-actions", () => ({ linkJobContact: vi.fn(), unlinkJobContact: vi.fn() }));
vi.mock("@/app/(app)/jobs/[id]/upload-job-photos", () => ({ uploadJobPhotos: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ captureReceipt: vi.fn(), prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));
// The dock's office-only children are theirs to test; the dock's own captions are what this reads.
vi.mock("@/app/(app)/jobs/[id]/job-manage-menu", () => ({ JobManageMenu: () => null, MANAGE_ROW_CLS: "row" }));
vi.mock("@/app/(app)/jobs/[id]/job-edit-button", () => ({ JobEditButton: () => null }));

import { LangProvider } from "@/components/lang-provider";
import { dict } from "@/lib/i18n";
import { arrangeJobTabs, JOB_TAB_ORDER } from "./job-tabs";
import { JobActionDock } from "./job-action-dock";
import { JobStatusControl, heldWords, statusWords } from "./job-status-control";
import { JobTimeButton } from "./job-time-button";
import { JobTaskList } from "./job-task-list";
import { JobPhotos } from "./job-photos";
import { JobPhotoQuick } from "./job-photo-quick";
import { PhotoTaskSheet } from "./photo-task-sheet";
import { JobDocuments } from "./job-documents";
import { JobCrewCard, JobCrewChips } from "./job-crew-card";
import { JobTextBox } from "./job-description";
import { JobContacts } from "./job-contacts";
import { FinishJobButton } from "./finish-job-button";
import { JobScheduleControl } from "./job-schedule-control";
import { readJobBlock } from "@/lib/schedule/job-block";
import type { TabDef } from "@/components/tabs";

const en = dict("en");
const es = dict("es");

/** The component as an English profile sees it (no provider), and as a Spanish one does. */
const both = <P extends object>(C: ComponentType<P>, props: P) => ({
  en: renderToStaticMarkup(createElement(C, props)),
  es: renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(C, props) })),
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the tabs", () => {
  const TABS: TabDef[] = JOB_TAB_ORDER.map((id) => ({ id, label: id, content: createElement("p", null, id) }));
  it("a Spanish profile's More menu groups read Documentos · Obra · Dinero; an English one's read Docs · Work · Money, as before", () => {
    const groups = (lang?: string) => new Set(arrangeJobTabs(TABS, true, undefined, lang).map((t) => (t as { group?: string }).group).filter(Boolean));
    expect([...groups("es")]).toEqual(expect.arrayContaining(["Documentos", "Obra", "Dinero"]));
    expect([...groups("en")]).toEqual(expect.arrayContaining(["Docs", "Work", "Money"]));
    expect(arrangeJobTabs(TABS, true)).toEqual(arrangeJobTabs(TABS, true, undefined, "en"));
    expect(es.jb_groupDocs).toBe("Documentos");
    expect(en.jb_groupDocs).toBe("Docs");
  });
});

describe("the dock", () => {
  const props = {
    job: { id: "j1", job_number: "J-047", status: "in_progress" },
    viewerIsStaff: false,
    tz: "America/Los_Angeles",
    openEntry: null,
    techs: [],
    defaultProfileId: "p1",
    jobAddress: "12 Larkspur Ln",
    customerPhone: "5305550100",
    hasQuote: false,
    defaultSendInvoice: false,
    isDrawBilled: false,
    customers: [],
    templates: [],
  };
  it("a Spanish tech's dock reads Marcar Entrada · Foto · Llamar · Navegar; an English one's reads Clock In · Photo · Call · Navigate", () => {
    const esHtml = renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(JobActionDock, { ...props, lang: "es" } as never) }));
    const enHtml = renderToStaticMarkup(createElement(JobActionDock, props as never));
    for (const w of ["Marcar Entrada", "Foto", "Llamar", "Navegar"]) expect(text(esHtml)).toContain(w);
    for (const w of ["Clock In", "Photo", "Call", "Navigate"]) expect(text(enHtml)).toContain(w);
    expect(text(enHtml)).not.toContain("Llamar");
    expect(esHtml).toContain(`title="${es.jb_callCustomer}"`);
    expect(enHtml).toContain('title="Call customer"');
  });
});

describe("the status pill", () => {
  it("a Spanish tech reads En Curso, and a held job reads En Pausa · la razón · vuelve el día; English stays In Progress / On Hold", () => {
    const r = both(JobStatusControl, { id: "j1", status: "in_progress", todayStr: "2026-09-27", viewerIsStaff: false });
    expect(text(r.es)).toContain("En Curso");
    expect(text(r.en)).toContain("In Progress");
    expect(text(r.en)).not.toContain("En Curso");
    const held = both(JobStatusControl, { id: "j1", status: "on_hold", holdReason: "esperando el permiso", holdUntil: "2026-10-03", todayStr: "2026-09-27", viewerIsStaff: false });
    expect(text(held.es)).toContain("En Pausa");
    expect(text(held.en)).toContain("On Hold");
    const tEs = (k: string) => es[k] ?? k;
    expect(statusWords(tEs, "on_hold")).toBe("En Pausa");
    expect(statusWords(tEs, "complete")).toBe(es.jb_statusComplete);
    expect(heldWords("x", null, "2026-09-27", tEs)).toBe(`x · ${es.jb_noDaySet}`);
    expect(heldWords("x", null, "2026-09-27")).toBe("x · no day set");
  });
});

describe("the clock button", () => {
  const props = { jobId: "j1", jobNumber: "J-047", isStaff: false, tz: "America/Los_Angeles", openEntry: null, techs: [], defaultProfileId: "p1" };
  it("the sheet's lead keeps its bold word in both languages (cn-v1138, fillNodes: HEAD had <span>yourself</span>)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-time-button.tsx"), "utf8");
    expect(src).toContain('fillNodes(t("jb_clockYourselfIn"), { job: jobNumber, em: <span className="font-medium">{t("jb_yourselfWord")}</span> })');
    const bold = (lang: "en" | "es") =>
      renderToStaticMarkup(createElement("p", null, fillNodes(dict(lang).jb_clockYourselfIn, { job: "J-047", em: createElement("span", { className: "font-medium" }, dict(lang).jb_yourselfWord) })));
    expect(bold("en")).toBe('<p>Clock <span class="font-medium">yourself</span> in to J-047 — you stay right here on the job.</p>');
    expect(bold("es")).toBe('<p>Marca <span class="font-medium">tu propia entrada</span> en J-047 — te quedas aquí mismo en el trabajo.</p>');
  });
  it("off the clock it reads Marcar Entrada for a Spanish tech and Clock In for an English one", () => {
    const r = both(JobTimeButton, props);
    expect(text(r.es)).toContain("Marcar Entrada");
    expect(r.es).toContain(`aria-label="${es.jb_clockInAria}"`);
    expect(r.es).toContain(`title="${es.jb_time}"`);
    expect(text(r.en)).toContain("Clock In");
    expect(r.en).toContain('aria-label="Clock in to this job"');
    expect(r.en).toContain('title="Time"');
    expect(text(r.en)).not.toContain("Marcar");
  });
  it("on another job it reads Cambiar (Switch), with the aria in the same language", () => {
    const open = { id: "e1", job_id: "j2", job_code: null, jobLabel: "J-040", clock_in: "2026-09-27T15:00:00Z", shift_start: null };
    const r = both(JobTimeButton, { ...props, openEntry: open as never });
    expect(text(r.es)).toContain("Cambiar");
    expect(r.es).toContain(`aria-label="${es.jb_switchAria}"`);
    expect(text(r.en)).toContain("Switch");
    expect(r.en).toContain('aria-label="Switch your open shift to this job"');
  });
});

describe("the task list", () => {
  const base = { jobId: "j1", orgId: "o1", tasks: [], viewerId: "u1", viewerIsStaff: false, tz: "America/Los_Angeles", nowIso: "2026-09-26T19:00:00Z", stamps: true, doneOpen: false };
  it("the Add line reads Agregar Una Tarea… / Agregar for a Spanish tech, Add A Task… / Add for an English one", () => {
    const r = both(JobTaskList, base as never);
    expect(r.es).toContain(`placeholder="${es.jb_addATaskPh}"`);
    expect(text(r.es)).toContain("Agregar");
    expect(r.en).toContain('placeholder="Add A Task…"');
    expect(text(r.en)).toContain("Add");
    expect(text(r.en)).not.toContain("Agregar");
  });
});

describe("the photos tab", () => {
  const props = { orgId: "o1", jobId: "j1", docs: [], viewerId: "u1", viewerIsStaff: false };
  it("empty, it says Aún no hay fotos and offers Tomar Foto; English says No photos yet and Take Photo", () => {
    const r = both(JobPhotos, props);
    expect(text(r.es)).toContain("Aún no hay fotos");
    expect(text(r.es)).toContain("Tomar Foto");
    expect(text(r.en)).toContain("No photos yet");
    expect(text(r.en)).toContain("Take Photo");
    expect(text(r.en)).not.toContain("Tomar");
  });
  it("the dock's Photo slot reads Foto / Photo", () => {
    const r = both(JobPhotoQuick, { orgId: "o1", jobId: "j1" });
    expect(text(r.es)).toContain("Foto");
    expect(text(r.en)).toContain("Photo");
    expect(text(r.en)).not.toContain("Foto");
  });
  it("Make It A Task's sheet saves with Agregar Tarea and asks Qué hay que hacer; English Add Task", () => {
    const r = both(PhotoTaskSheet, { jobId: "j1", photoPath: "o1/j1/p.jpg", previewUrl: null, onClose: () => {} });
    expect(text(r.es)).toContain(es.jb_addTask);
    expect(text(r.es)).toContain(es.jb_whatNeedsDoing);
    expect(text(r.en)).toContain("Add Task");
    expect(text(r.en)).toContain("What needs doing");
    expect(text(r.en)).not.toContain("Agregar");
  });
});

describe("the papers", () => {
  it("empty, the receipts fold says Aún no hay recibos; English No receipts yet", () => {
    const r = both(JobDocuments, { orgId: "o1", jobId: "j1", docs: [] });
    expect(text(r.es)).toContain("Aún no hay recibos");
    expect(text(r.en)).toContain("No receipts yet. Use Snap The Bill above.");
    expect(text(r.en)).not.toContain("recibos");
  });
});

describe("the crew card", () => {
  const team = [{ id: "p1", full_name: "Brian Cole" }];
  it("a tech with no crew reads Aún no hay nadie en este trabajo; the office's + Add reads Agregar; English unchanged", () => {
    const r = both(JobCrewCard, { jobId: "j1", crew: [], viewerIsStaff: false, team });
    expect(text(r.es)).toContain(es.jb_noOneOnJob);
    expect(text(r.en)).toContain("No one is on this job yet.");
    const office = both(JobCrewCard, { jobId: "j1", crew: [], viewerIsStaff: true, team });
    expect(text(office.es)).toContain("Agregar");
    expect(text(office.en)).toContain("Add");
    expect(text(office.en)).not.toContain("Agregar");
    const chips = both(JobCrewChips, { jobId: "j1", crew: [], team, viewerIsStaff: false } as never);
    expect(text(chips.es)).toContain("Nadie");
    expect(text(chips.en)).toContain("Nobody");
  });
});

describe("the description and the notes", () => {
  it("Descripción / Notas for a Spanish reader, Description / Notes for an English one", () => {
    const d = both(JobTextBox, { jobId: "j1", field: "description", value: "Swap the 100A panel" });
    expect(text(d.es)).toContain("Descripción");
    expect(d.en).toContain(">Description<");
    expect(text(d.en)).toContain("It prints on the customer's invoice.");
    expect(text(d.en)).not.toContain("Descripción");
    const n = both(JobTextBox, { jobId: "j1", field: "notes", value: null });
    expect(text(n.es)).toContain("Notas");
    expect(text(n.es)).toContain(es.jb_addANote);
    expect(text(n.en)).toContain("Add A Note");
  });
});

describe("the contacts card", () => {
  it("reads Subcontratistas y contactos · Agregar in Spanish, Subs & contacts · Add in English", () => {
    const r = both(JobContacts, { jobId: "j1", contacts: [], options: [] });
    expect(text(r.es)).toContain(es.jb_subsContacts);
    expect(text(r.es)).toContain(es.jb_noSubsYet);
    expect(text(r.en)).toContain("Subs & contacts");
    expect(text(r.en)).toContain("No subs or extra contacts on this job yet.");
    expect(text(r.en)).not.toContain("Agregar");
  });
});

describe("Finish Job", () => {
  it("the door reads Terminar El Trabajo in Spanish and Finish Job in English", () => {
    const r = both(FinishJobButton, { jobId: "j1", hasQuote: true });
    expect(text(r.es)).toContain("Terminar El Trabajo");
    expect(text(r.en)).toContain("Finish Job");
    expect(text(r.en)).not.toContain("Terminar");
  });
});

describe("the Scheduled box", () => {
  it("Agregar Rango De Fechas in Spanish; Add Date Range in English", () => {
    const WORK_DAY = { start: "09:00", end: "17:00" };
    const block = readJobBlock({ scheduledStart: null, scheduledEnd: null, plannedMinutes: null, tz: "America/Los_Angeles", workDay: WORK_DAY });
    const r = both(JobScheduleControl, { id: "j1", segments: [], block, workDay: WORK_DAY } as never);
    expect(text(r.es)).toContain("Agregar Rango De Fechas");
    expect(text(r.en)).toContain("Add Date Range");
    expect(text(r.en)).not.toContain("Agregar");
  });
});

describe("the catalog's own shape", () => {
  it("every jb_ door the tests above read has a Spanish value that differs from the English", () => {
    for (const k of ["jb_clockIn", "jb_switch", "jb_photo", "jb_call", "jb_navigate", "jb_add", "jb_finishJob", "jb_addDateRange", "jb_description", "jb_notes", "jb_tabTasks", "jb_tabTime", "jb_tabPhotos", "jb_tabMaterials"]) {
      expect(en[k], k).toBeTruthy();
      expect(es[k], k).toBeTruthy();
      expect(es[k], k).not.toBe(en[k]);
    }
    expect(es.jb_tabTasks).toBe("Tareas");
    expect(es.jb_tabTime).toBe("Tiempo");
    expect(es.jb_tabMaterials).toBe("Materiales");
    expect(es.jb_tabPhotos).toBe("Fotos");
    expect(es.jb_clockIn).toBe("Marcar Entrada");
    expect(es.jb_finishJob).toBe("Terminar El Trabajo");
  });
});
