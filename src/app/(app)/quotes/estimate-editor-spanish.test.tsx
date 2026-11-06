import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translator } from "@/lib/i18n";
import { catalog, savedProps, text, CLIENT_ID } from "./editor-test-mocks";

/**
 * THE ONE ESTIMATE EDITOR IN SPANISH (the estimates-in-Spanish wave, cn-v1145, qe_). The editor rendered
 * inside a LangProvider with "es": its doors read the catalog's Title Case Spanish, its sentences theirs,
 * a {link} sentence keeps its link in the middle, and no English door is left on it. With no provider —
 * every other suite's render — it is English, and the "en" provider draws the same bytes. The store's own
 * words (use-quote-writes) follow the translator it is handed (SessionInit.say), English when none is.
 */
const { LangProvider } = await import("@/components/lang-provider");
const { EstimateEditor } = await import("./estimate-editor");
const { createQuoteSession, COULD_NOT_REACH } = await import("./use-quote-writes");
const { words: qe } = await import("@/lib/words/quotes-editor");

const Editor = EstimateEditor as never;
const unsavedEl = () =>
  createElement(Editor, { mode: "unsaved", seed: { clientId: CLIENT_ID, customers: [], leads: [], items: [], quoteExpiryDays: 30 }, catalog: catalog() } as never) as ReactElement;
const savedEl = (q: Record<string, unknown>, extra: Record<string, unknown>) =>
  createElement(Editor, { mode: "saved", saved: savedProps(q, [], extra), catalog: catalog() } as never) as ReactElement;
const inLang = (lang: "en" | "es", el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang } as never, el));
const es = translator("es");

describe("the editor in Spanish", () => {
  it("a new estimate: the sidebar, the estimator, the lines and the totals read the catalog's Spanish; its doors are Title Case", () => {
    const html = inLang("es", unsavedEl());
    const words = text(html);
    expect(words).toContain("Redactar con el Estimador");
    expect(words).toContain("Generar Partidas"); // qe_btn_generateLineItems
    expect(words).toContain("Agregar una Tarea"); // qe_btn_addATask
    expect(words).toContain("Agregar una Línea"); // qe_btn_addALine
    expect(words).toContain("Cotización (Precio Fijo)");
    expect(words).toContain("¿Para quién es?");
    expect(words).toContain("Válido hasta");
    expect(words).toContain("Se guarda solo en cuanto le pones algo.");
    expect(html).toContain('placeholder="Cant."');
    for (const english of ["Generate Line Items", "Add a Task", "Add a Line", "Draft with Estimator", "Saves itself the moment"]) expect(words).not.toContain(english);
  });

  it("a saved estimate: the revision chain says its sentence around the link, the created line its date", () => {
    const superseded = text(inLang("es", savedEl({ status: "superseded" }, { supersededBy: { id: "q2", quote_number: "E-002" } })));
    expect(superseded).toContain("Reemplazado por E-002 — ese presupuesto es ahora el precio de este trabajo.");
    const revision = text(inLang("es", savedEl({ status: "draft" }, { revises: { id: "q0", quote_number: "E-000", status: "sent" } })));
    expect(revision).toContain("Es la revisión de E-000 — aceptar este lo reemplaza.");
    expect(revision).toContain("Creado el");
  });

  it("English is the default and the 'en' provider draws the same bytes; the sentences around a link read as they did", () => {
    const bare = renderToStaticMarkup(unsavedEl());
    expect(inLang("en", unsavedEl())).toBe(bare);
    expect(text(bare)).toContain("Saves itself the moment you put something on it.");
    const superseded = text(renderToStaticMarkup(savedEl({ status: "superseded" }, { supersededBy: { id: "q2", quote_number: "E-002" } })));
    expect(superseded).toContain("Superseded by E-002 — that estimate is the price for this work now.");
    expect(text(renderToStaticMarkup(savedEl({ status: "draft" }, { revises: { id: "q0", quote_number: "E-000", status: "sent" } })))).toContain("Revises E-000 — accepting this one supersedes it.");
  });

  it("the store's own words follow the translator it is handed, and stay the catalog's English without one", async () => {
    const header = { customerId: "", leadId: "", jobId: null, captureId: null, docType: "estimate" as const, estimateFormat: null, title: "", description: "", notes: "", taxRate: 0, validUntil: "" };
    const actions = {
      saveQuote: vi.fn(async () => {
        throw new Error("offline");
      }),
      appendQuoteLines: vi.fn(),
      updateQuoteItem: vi.fn(),
      deleteQuoteItem: vi.fn(),
      updateQuoteMeta: vi.fn(),
      setQuoteCustomer: vi.fn(),
      setQuoteType: vi.fn(),
      readQuoteLineIds: vi.fn(),
    } as never;
    const line = { description: "Snowbell trench", quantity: 1, unit: "ea", unit_price: 290 };
    const spanish = createQuoteSession({ mode: { kind: "unsaved", clientId: CLIENT_ID }, header, items: [line], actions, say: es });
    await spanish.mount();
    expect(spanish.get().refusals["first-save"]).toBe("No se pudo conectar con el servidor — toca Reintentar");
    const english = createQuoteSession({ mode: { kind: "unsaved", clientId: CLIENT_ID }, header, items: [line], actions });
    await english.mount();
    expect(english.get().refusals["first-save"]).toBe(COULD_NOT_REACH);
    expect(COULD_NOT_REACH).toBe(qe.en.qe_couldNotReach);
  });

  it("the doors' Spanish is Title Case and the house's words (Presupuesto, Lista de Precios, Orden De Trabajo, Lista De Materiales)", () => {
    expect(es("qe_btn_addToEstimate")).toBe("Agregar {n} al Presupuesto");
    expect(es("qe_btn_applyToBook")).toBe("Aplicar {n} a la Lista de Precios");
    expect(es("qe_btn_createWorkOrder")).toBe("Crear Orden de Trabajo");
    expect(es("qe_btn_createMaterialList")).toBe("Crear Lista de Materiales");
  });
});
