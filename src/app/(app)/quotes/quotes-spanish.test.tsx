import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict, translator } from "@/lib/i18n";
import { laborRateFromWords } from "@/lib/pricing/labor-rate";

/**
 * THE ESTIMATES' SCREENS IN SPANISH (builder B of the estimates-in-Spanish wave, cn-v1145, qt_ and qb_):
 * the estimate's own cards (the circuit schedule, the customer pick, the paper format) and the shared
 * Email / Text chips, rendered inside a LangProvider with "es", read the catalog's Spanish and no
 * English door is left. Rendered with no provider they say what they always said, byte for byte — the
 * English is the default — and the table at the bottom pins a sample of keys to the literal each one
 * replaced. Every name here is invented.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/quotes/actions", () => ({
  generateCircuitSchedule: vi.fn(),
  saveCircuitSchedule: vi.fn(),
  setQuoteCustomer: vi.fn(),
  emailQuote: vi.fn(),
  textQuote: vi.fn(),
}));
vi.mock("@/app/(app)/billing/actions", () => ({ emailInvoice: vi.fn(), textInvoice: vi.fn() }));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn() }));
vi.mock("@/app/(app)/crm/[id]/edit-customer-button", () => ({ EditCustomerButton: () => null }));

const { LangProvider } = await import("@/components/lang-provider");
const { CircuitScheduleCard } = await import("./[id]/circuit-schedule-card");
const { CustomerSelect } = await import("./[id]/customer-select");
const { PaperFormatSwitch } = await import("./paper-format-switch");
const { EmailButton } = await import("@/components/email-button");

const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const en = (el: ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const card = () => createElement(CircuitScheduleCard, { quoteId: "q-1", initial: [], panelJob: { id: "j-1", label: "J-012 Larkspur" } });
const nobody = () => createElement(CustomerSelect, { quoteId: "q-1", customer: null, lead: null, customers: [] });
const paper = () => createElement(PaperFormatSwitch, { value: null, companyDefault: "detailed", onChange: () => {} });

describe("the estimate's cards follow the signed-in person's language", () => {
  it("the circuit schedule card: its title, its doors and the empty line in Spanish", () => {
    const t = text(es(card()));
    expect(t).toContain("Tabla de Circuitos");
    expect(t).toContain("· se imprime como segunda página");
    expect(t).toContain("Generar desde las Partidas");
    expect(t).toContain("Agregar Circuito");
    expect(t).toContain("Abrir el Panel de J-012 Larkspur");
    expect(t).toContain("Esta Es la Propuesta.");
    expect(t).not.toMatch(/Circuit Schedule|Add Circuit|Generate from Line Items|No circuit schedule yet/);
  });

  it("the customer card with nobody attached, and the paper-format switch, in Spanish", () => {
    const c = text(es(nobody()));
    expect(c).toContain("Preparado para");
    expect(c).toContain("Nadie adjunto todavía — se imprime sin nombre hasta que elijas a alguien.");
    expect(c).toContain("Adjuntar Cliente");
    const p = text(es(paper()));
    expect(p).toContain("Mano de Obra y Piezas en el Papel");
    expect(p).toContain("Predeterminado de la Empresa · Activado");
    expect(p).toContain("Mostrar");
    expect(p).toContain("Ocultar");
    expect(p).not.toContain("Labor and Parts on the Paper");
  });

  it("the Email / Text chips on an invoice and on a quote, in Spanish (drawn on billing too)", () => {
    const inv = text(es(createElement(EmailButton, { id: "inv-1", kind: "invoice", customerName: "Snowbell", amount: 150, textReady: true })));
    expect(inv).toContain("Enviar Factura");
    expect(inv).toContain("Mensaje");
    const q = text(es(createElement(EmailButton, { id: "q-1", kind: "quote", textReady: true })));
    expect(q).toContain("Correo");
    expect(q).not.toMatch(/\bEmail\b|\bText\b/);
  });

  it("with no provider every piece says what it always said, byte for byte", () => {
    const c = text(en(card()));
    expect(c).toContain("Circuit Schedule · prints as a second page");
    expect(c).toContain("Generate from Line Items");
    expect(c).toContain("This Is the Proposal. The Job Keeps Its Own List On the Panel Tab.");
    expect(c).toContain("Open J-012 Larkspur's Panel");
    expect(c).toContain("No circuit schedule yet. Tap Generate from Line Items to read the breakers and wire in the line items, or Add Circuit to type rows by hand.");
    expect(c).toContain("Add Circuit");
    const n = text(en(nobody()));
    expect(n).toContain("Prepared for Nobody attached yet — it prints without a name until you pick someone.");
    expect(n).toContain("Attach Customer");
    const p = text(en(paper()));
    expect(p).toContain("Labor and Parts on the Paper");
    expect(p).toContain("Company Default · On");
    expect(p).toContain("Prints each task's hours at the rate and its parts beneath it, on the paper and the customer's link. The company default is set in Document Studio.");
    const q = text(en(createElement(EmailButton, { id: "q-1", kind: "quote", textReady: true })));
    expect(q).toBe("Email Text");
  });
});

describe("the keys say the literal each one replaced", () => {
  const EN = dict("en");
  it("a sample of qt_ and qb_ keys, each the English its screen showed before the catalog", () => {
    const table: Record<string, string> = {
      qt_btn_newEstimate: "New Estimate",
      qt_noEstimatesYet: "No estimates yet",
      qt_pinnedOnAJob: "{which} is on a job — keeping that one is usually right.",
      qt_kitTickLines: "Tick the lines this estimate needs. Qty and price edits apply to THIS estimate only — the kit itself is unchanged.",
      qt_kitEnterMeasurements: "Enter the job’s measurements and the quantities fill in.",
      qt_priceListDidntLoad: "Price list didn't load",
      qt_typeSetAlreadySent: "Already sent, so the type is set - the copy the customer has states the pricing basis. Duplicate it to start a new one.",
      qt_didntSaveTryAgain: "That didn't save — try again.",
      qt_copiedPasteIt: "Copied — paste it into a text or email.",
      qt_confirmEmailInvoiceAmount: "Send this {money} invoice to {who} by email? This marks it Sent.",
      qt_btn_startAnInspection: "Start an Inspection",
      qb_noPriceBookYet: "No price book yet. Upload or build one under Money → Price List and these will autocomplete.",
      qb_hoursStand: "· your hours stand; the kit’s parts follow the units",
      qb_btn_saveTheKit: "Save the Kit",
      qb_priceSetByHand: "Price set by hand — the breakdown stays off the paper",
    };
    for (const [k, v] of Object.entries(table)) expect(EN[k], k).toBe(v);
    // Save the Kit's Spanish is the button qs_lib_kitNotKept names.
    expect(dict("es").qb_btn_saveTheKit).toBe("Guardar el Kit");
    expect(dict("es").qs_lib_kitNotKept).toContain("Guardar el Kit");
  });

  it("where a rate came from: English inline as always; Spanish when the caller hands its language", () => {
    expect(laborRateFromWords("person", "Larkspur")).toBe("Larkspur's rate");
    expect(laborRateFromWords("default")).toBe("company default");
    expect(laborRateFromWords("person", "Larkspur", "es", translator("es"))).toBe("la tarifa de Larkspur");
    expect(laborRateFromWords("level", null, "es", translator("es"))).toBe("el nivel del cliente");
    expect(laborRateFromWords("none", null, "es")).toBe("no rate set"); // no translator handed: English, never a raw key
  });
});
