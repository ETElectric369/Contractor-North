import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, translator } from "@/lib/i18n";
import { formatDateTime } from "@/lib/utils";
import type { Customer } from "@/lib/types";

/**
 * THE CUSTOMERS' SCREENS IN SPANISH (builder C of the Ventas-2 wave, cn-v1146, cu_): the table's
 * headers and type cell, New Customer, Edit Customer (shared: jobs/[id] and the estimate's customer
 * card draw it too), the portal link card, the inline new customer and the shared sort bar, rendered
 * inside a LangProvider with "es": Spanish words, Title Case doors, an es-US date. Without a provider
 * every piece says today's English, byte for byte. The link the card copies for the customer is not
 * a word and does not move (pinned on the source: the unit project has no clipboard).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/crm",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: () => createElement("input", { name: "address" }) }));
vi.mock("./actions", () => ({
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  emailPortalLink: vi.fn(),
  rotatePortalLink: vi.fn(),
  setPortalEnabled: vi.fn(),
  signOutPortalDevices: vi.fn(),
}));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn() }));
vi.mock("@/app/(app)/share-actions", () => ({ orgPublicBase: vi.fn(async () => "https://catbird.example") }));
vi.mock("./../portal-look-actions", () => ({ portalOfficeLookUrl: vi.fn() }));
vi.mock("@/app/(app)/portal-look-actions", () => ({ portalOfficeLookUrl: vi.fn() }));
vi.mock("@/components/portal/open-office-look", () => ({ openOfficeLook: vi.fn() }));
// The sheet drawn open, so what it says can be read (the real Modal renders nothing while closed).
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) =>
    createElement("div", { "data-modal": title }, children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("div", { "data-actions": saveLabel }),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { customerColumns, customerTypeWord } = await import("./columns");
const { NewCustomerButton } = await import("./new-customer-button");
const { EditCustomerButton } = await import("./[id]/edit-customer-button");
const { PortalLinkButton } = await import("./[id]/portal-link-button");
const { NewCustomerInline } = await import("@/components/new-customer-inline");
const { SortFilterBar } = await import("@/components/sort-filter-bar");

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
const titleCase = (s: string) => s.replace(/\{\w+\}/g, " ").split(/\s+/).filter(Boolean).every((w) => /^[¿¡]?[\p{Lu}\p{N}&\/+·(—–.]/u.test(w));

const larkspur = {
  id: "c-1",
  name: "Larkspur Thistlewood",
  company_name: null,
  email: null,
  phone: "555-0100",
  type: "contractor",
  status: "active",
  address: "12 Snowbell Way",
  city: "Bayberry",
  state: "CA",
  zip: "96161",
  notes: null,
} as unknown as Customer;

describe("the customers table in Spanish", () => {
  it("headers and the type cell read the catalog with a Spanish translator; English by default, byte for byte", () => {
    expect(customerColumns(true, "es", t).map((c) => c.header)).toEqual(["Nombre", "Contacto", "Tipo", "Ubicación", "Estado"]);
    expect(customerColumns(true).map((c) => c.header)).toEqual(["Name", "Contact", "Type", "Location", "Status"]);
    const type = customerColumns(true, "es", t)[2];
    expect(type.cell(larkspur)).toBe("contratista");
    expect(customerTypeWord("contractor")).toBe("contractor");
    expect(customerTypeWord("residential", "es", t)).toBe("residencial");
    expect(customerTypeWord("mystery", "es", t)).toBe("mystery");
  });
});

describe("New Customer in Spanish", () => {
  it("the door, the sheet's fields and its options read Spanish, every option Title Case", () => {
    const html = es(<NewCustomerButton />);
    const words = text(html);
    expect(words).toContain("Nuevo Cliente");
    expect(html).toContain('data-modal="Nuevo Cliente"');
    expect(html).toContain('data-actions="Crear Cliente"');
    for (const w of ["Nombre *", "Empresa", "Tipo", "Estado", "Correo", "Teléfono", "Dirección", "Ciudad", "Estado (EE. UU.)", "Código postal", "Notas", "Importar Un .vcf", "Autorrelleno"]) expect(words).toContain(w);
    for (const o of ["Residencial", "Comercial", "Industrial", "Contratista", "Subcontratista", "Activo", "Inactivo"]) {
      expect(html).toContain(`>${o}</option>`);
      expect(titleCase(o)).toBe(true);
    }
    expect(html).toContain('placeholder="Nombre del cliente o contacto"');
    expect(words).not.toMatch(/New Customer|Create Customer|Residential|Tip: type/);
  });

  it("without a provider it says today's English", () => {
    const words = text(en(<NewCustomerButton />));
    expect(words).toContain("New Customer");
    expect(words).toContain("Tip: type the person's name and pick them when your browser offers the card — then press AutoFill on the card itself.");
    expect(en(<NewCustomerButton />)).toContain(">Contractor</option>");
  });
});

describe("Edit Customer in Spanish (shared: the customer page, the job page, the estimate's customer card)", () => {
  const levels = [{ id: "pl-1", name: "Catbird", markup_pct: 12 }];
  it("Editar, the sheet's heading and save, the lead status option as Prospecto, the markup words", () => {
    const html = es(<EditCustomerButton customer={{ ...larkspur, status: "lead" } as Customer} pricingLevels={levels} />);
    const words = text(html);
    expect(words).toContain("Editar");
    expect(html).toContain('data-modal="Editar Cliente"');
    expect(html).toContain('data-actions="Guardar Cambios"');
    expect(html).toMatch(/<option value="lead"( selected="")?>Prospecto<\/option>/);
    expect(html).toMatch(/>— Predeterminado —<\/option>/);
    expect(words).toContain("Catbird (12% de margen)");
    expect(words).toContain("Nivel de precios");
  });

  it("an English caller's label is its own; English by default", () => {
    expect(text(en(<EditCustomerButton customer={larkspur} />))).toContain("Edit");
    expect(en(<EditCustomerButton customer={larkspur} pricingLevels={levels} />)).toContain("Catbird (12% markup)");
    expect(en(<EditCustomerButton customer={larkspur} />)).toMatch(/<option value="lead"( selected="")?>Inquiry<\/option>/);
    expect(text(es(<EditCustomerButton customer={larkspur} label={t("cu_btn_addTheirEmail")} />))).toContain("Agregar Su Correo");
  });
});

describe("the portal link card in Spanish", () => {
  const initial = { token: "tok-1", enabled: true, lastOpenedAt: "2026-11-02T18:30:00.000Z", devices: 2 };
  it("the office words, the doors Title Case, the last-opened date in es-US", () => {
    const html = es(<PortalLinkButton customerId="c-1" customerName="Larkspur" initial={initial as never} hasEmail={false} />);
    const words = text(html);
    expect(words).toContain("Su propia página — trabajos, facturas, presupuestos, contratos");
    expect(words).toContain("El enlace está activo.");
    expect(words).toContain("Sesión iniciada en 2 dispositivos ·");
    const esDate = formatDateTime(initial.lastOpenedAt, undefined, "es");
    expect(esDate).not.toBe(formatDateTime(initial.lastOpenedAt));
    expect(words).toContain(`Abierto por última vez el ${esDate}.`);
    expect(words).toContain("No hay correo registrado: no puede iniciar sesión.");
    for (const k of ["cu_btn_seeWhatTheySee", "cu_btn_copyTheLink", "cu_btn_emailItToThem", "cu_btn_newLink", "cu_btn_turnOff", "cu_btn_signOutAllDevices"]) {
      expect(words).toContain(t(k));
      expect(titleCase(t(k)), k).toBe(true);
    }
    expect(html).toContain('data-modal="¿Crear Un Enlace Nuevo Para Larkspur?"');
    expect(html).toContain('data-actions="Crear Enlace Nuevo"');
    // The customer's own page's words, quoted for the office, stay what that page says.
    expect(words).toContain("“This link was turned off.”");
  });

  it("a turned-off link, and English by default", () => {
    expect(text(es(<PortalLinkButton customerId="c-1" customerName="Larkspur" initial={{ ...initial, enabled: false } as never} hasEmail />))).toContain(
      "El enlace está desactivado. Se abre con “This link was turned off.” No se muestra nada más.",
    );
    const words = text(en(<PortalLinkButton customerId="c-1" customerName="Larkspur" initial={initial as never} hasEmail />));
    expect(words).toContain(`Link is on. Signed in on 2 devices · Last opened ${formatDateTime(initial.lastOpenedAt)}. Your own looks don't count.`);
    expect(words).toContain("See What They See");
    expect(en(<PortalLinkButton customerId="c-1" customerName="Larkspur" initial={initial as never} hasEmail />)).toContain('data-modal="Make a New Link for Larkspur?"');
  });

  it("the link itself and what is copied for the customer do not move", () => {
    const s = src("src/app/(app)/crm/[id]/portal-link-button.tsx");
    expect(s).toContain("return `${base}/portal/${token}`;");
    expect(s).toContain("navigator.clipboard?.writeText(l).then(");
    expect(s).toContain("() => say(l),");
  });
});

describe("the shared pieces read the language themselves", () => {
  it("the inline new customer: Nuevo Cliente closed; a caller's label is its own; English by default", () => {
    expect(text(es(<NewCustomerInline onCreated={() => {}} />))).toBe("Nuevo Cliente");
    expect(text(en(<NewCustomerInline onCreated={() => {}} />))).toBe("New Customer");
    expect(text(es(<NewCustomerInline onCreated={() => {}} label="New Customer 'Catbird'" />))).toBe("New Customer 'Catbird'");
  });

  it("the sort bar: Ordenar, Predeterminado, Agrupar, Ninguno; the caller's options untouched; English by default", () => {
    const bar = (
      <SortFilterBar
        sortOptions={[{ key: "name", label: "Nombre" }]}
        groupOptions={[{ key: "kind", label: "Kind" }]}
        prefs={{ sort: { key: "name", dir: "asc" }, group: null, chips: [] }}
        onChange={() => {}}
      />
    );
    const html = es(bar);
    expect(text(html)).toMatch(/^Ordenar Predeterminado Nombre Agrupar Ninguno Kind$/);
    expect(html).toContain('aria-label="Ordenar por"');
    expect(html).toContain('aria-label="Ascendente — toca para descendente"');
    expect(text(en(bar))).toBe("Sort Default Nombre Group None Kind");
  });
});

describe("the catalog", () => {
  const cu = CATALOGS.find((c) => c.prefix === "cu_")!;
  it("every cu_btn_ door is Title Case in both languages, and every key has its Spanish", () => {
    for (const k of Object.keys(cu.en)) {
      expect(cu.es[k], k).toBeTypeOf("string");
      if (k.startsWith("cu_btn_")) for (const lang of ["en", "es"] as const) expect(titleCase(cu[lang][k]), `${lang}:${k}`).toBe(true);
    }
  });

  it("the English is what each screen said before the move", () => {
    const e = dict("en");
    expect(e.cu_showingFirst).toBe("Showing the first {n} customers — search to narrow the list.");
    expect(e.cu_btn_mergeIntoKept).toBe("Merge {n} Into Kept");
    expect(e.cu_btn_backToCustomers).toBe("Back To Customers");
    expect(e.cu_btn_statusInquiry).toBe("Inquiry");
    expect(e.cu_deleteConfirm).toBe(
      "Delete {name}? Only possible when nothing important still points at them — jobs, estimates, invoices, contracts, account credits, or a link to a job as a sub/supplier all block it. Appointments, documents, work orders and inquiries survive but lose their contact.",
    );
  });

  it("the Contacts page counts its ceiling in the reader's locale", () => {
    expect(src("src/app/(app)/crm/page.tsx")).toContain("CRM_PAGE_LIMIT.toLocaleString(localeOf(lang))");
  });
});
