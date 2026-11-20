import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Customer } from "@/lib/types";

/**
 * ONE PERSON BLOCK, ONE CUSTOMER FORM, ONE ASK (cn-v1171). Erik, 2026-11-19: "the lead manual entry
 * form might be one of a few, can we check on the one thing many doors for that one". The lead form's
 * person block (components/person-fields) is drawn by the lead form and by New Customer and Edit
 * Customer (components/customer-fields); and when createCustomer finds the person already in the book,
 * every screen that calls it asks with one component (components/duplicate-customer-ask). Static
 * renders in both languages, with the sheets drawn open; source pins for what a static render cannot
 * reach (the ask's two answers and the kept fields).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/crm",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer: vi.fn(), updateCustomer: vi.fn() }));
vi.mock("@/app/(app)/leads/actions", () => ({ createInquiry: vi.fn(), updateInquiry: vi.fn(), deleteInquiry: vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: string; children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": title }, children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("div", { "data-actions": saveLabel }),
}));

const { LangProvider } = await import("@/components/lang-provider");
const { NewCustomerButton } = await import("@/app/(app)/crm/new-customer-button");
const { EditCustomerButton } = await import("@/app/(app)/crm/[id]/edit-customer-button");
const { InquiryFields, inquiryFormValue } = await import("@/app/(app)/leads/inquiry-fields");
const { DuplicateCustomerAsk } = await import("./duplicate-customer-ask");
const { personValue } = await import("./person-fields");
const { addedOnce } = await import("./new-customer-inline");
const { CATALOGS } = await import("@/lib/i18n");
const { esTitleCase, titleCaseIn } = await import("../../tests/title-case-words");

const es = (el: ReactElement) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const en = (el: ReactElement) => renderToStaticMarkup(el);
const labels = (html: string) => [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const larkspur = {
  id: "c-1",
  name: "Casey Loam",
  company_name: "Northline Supply",
  email: "casey@example.test",
  phone: "(530) 555-0100",
  type: "commercial",
  status: "lead",
  address: null,
  city: "Bayberry",
  state: "CA",
  zip: "96161",
  notes: "Side gate",
  pricing_level_id: "pl-1",
} as unknown as Customer;

describe("the one person block, drawn by both forms", () => {
  it("New Customer: the lead form's order, then Notes, Type, Status; Business and the town behind their links", () => {
    const html = en(createElement(NewCustomerButton));
    expect(labels(html)).toEqual(["Name", "Address", "Phone", "Email", "Notes", "Type", "Status"]);
    expect(html).toContain(">Business</button>");
    expect(html).toContain(">City, State, ZIP</button>");
    for (const n of ["company_name", "city", "state", "zip"]) expect(html).toContain(`type="hidden" name="${n}"`);
    for (const n of ["name", "address", "phone", "email", "notes", "type", "status"]) expect(html).toMatch(new RegExp(`name="${n}"`));
    // A bare phone is a valid customer on the server, so the box no longer insists on a name.
    expect(html).not.toMatch(/id="name"[^>]*required/);
    expect(html).toContain('placeholder="Customer or contact name"');
    expect(html).not.toContain('value="lead"');
    expect(html).not.toContain("pricing_level_id");
  });

  it("the lead form draws the same block (same order, same links), then its own Scope, Notes, Lead Source", () => {
    const html = en(createElement(InquiryFields, { value: inquiryFormValue(), onChange: () => {}, sources: [] }));
    expect(labels(html)).toEqual(["Name", "Address", "Phone", "Email", "Scope", "Notes", "Lead Source"]);
    for (const f of ["src/app/(app)/leads/inquiry-fields.tsx", "src/components/customer-fields.tsx"]) expect(src(f)).toContain("<PersonFields ");
    expect(src("src/app/(app)/leads/inquiry-fields.tsx")).not.toContain("AddressAutocomplete");
    for (const f of ["src/app/(app)/crm/new-customer-button.tsx", "src/app/(app)/crm/[id]/edit-customer-button.tsx"]) {
      expect(src(f)).toContain("<CustomerFields ");
      expect(src(f)).not.toMatch(/AddressAutocomplete|PhoneInput|StateSelect/);
    }
  });

  it("Edit Customer: Business open with a value, a typed town open, Lead as the badge says it, the Pricing Level", () => {
    const levels = [{ id: "pl-1", name: "Catbird", markup_pct: 12 }];
    const html = en(createElement(EditCustomerButton, { customer: larkspur, pricingLevels: levels }));
    expect(labels(html)).toEqual(["Name", "Business", "Address", "City", "State", "Zip", "Phone", "Email", "Notes", "Type", "Status", "Pricing level"]);
    expect(html).toMatch(/<option value="lead" selected="">Lead<\/option>/);
    expect(html).toMatch(/<option value="pl-1" selected="">Catbird \(12% markup\)<\/option>/);
    expect(html).toContain(">Side gate</textarea>");
  });

  it("Edit Customer with no levels drawn posts no level at all, so the one on file is left alone (skeptic #74)", () => {
    // A hidden copy of the level as loaded would undo a change made since; updateCustomer writes the
    // column only when the field is posted (create-customer-asks.test pins the server half).
    const html = en(createElement(EditCustomerButton, { customer: larkspur }));
    expect(html).not.toContain('name="pricing_level_id"');
    expect(en(createElement(NewCustomerButton))).not.toContain('name="pricing_level_id"');
    // The customer page's own Edit draws the select, which posts the level, the Default choice included.
    const drawn = en(createElement(EditCustomerButton, { customer: larkspur, pricingLevels: [{ id: "pl-1", name: "Catbird", markup_pct: 12 }] }));
    expect(drawn).toMatch(/<select[^>]*name="pricing_level_id"/);
    expect(drawn).toContain('<option value="">');
  });

  it("in Spanish: the block's words, the status Prospecto", () => {
    const html = es(createElement(EditCustomerButton, { customer: { ...larkspur, company_name: null } as Customer }));
    expect(labels(html)).toEqual(["Nombre", "Dirección", "Ciudad", "Estado (EE. UU.)", "Código postal", "Teléfono", "Correo", "Notas", "Tipo", "Estado"]);
    expect(html).toContain(">Empresa</button>");
    expect(html).toMatch(/<option value="lead" selected="">Prospecto<\/option>/);
    expect(labels(es(createElement(NewCustomerButton)))).toEqual(["Nombre", "Dirección", "Teléfono", "Correo", "Notas", "Tipo", "Estado"]);
  });

  it("personValue: a stored street with its town reads as picked", () => {
    expect(personValue({ address: "4 Catbird Ct", city: "Bayberry" }).town_picked).toBe(true);
    expect(personValue({ city: "Bayberry" }).town_picked).toBe(false);
    expect(personValue(null)).toEqual({ name: "", company_name: "", email: "", phone: "", address: "", city: "", state: "", zip: "", town_picked: false });
  });
});

describe("the one ask", () => {
  const match = { id: "cust-sam", name: "Sam Tillery", reason: "phone" as const };
  it("the New Customer form: the server's sentence, Open Their File to the customer, Add Anyway", () => {
    const html = en(createElement(DuplicateCustomerAsk, { match, sentence: "Sam Tillery is already a customer (same phone).", onAddAnyway: () => {} }));
    expect(html).toContain("Sam Tillery is already a customer (same phone).");
    expect(html).toMatch(/<a [^>]*href="\/crm\/cust-sam"[^>]*>Open Their File<\/a>/);
    expect(html).toContain(">Add Anyway</button>");
    expect(html).not.toContain("Use This Customer");
  });

  it("a quick picker: Use This Customer and Add Anyway, no link; Spanish", () => {
    const html = en(createElement(DuplicateCustomerAsk, { match, sentence: "x", onAddAnyway: () => {}, onUse: () => {} }));
    expect(html).toContain(">Use This Customer</button>");
    expect(html).not.toContain("href=");
    const s = es(createElement(DuplicateCustomerAsk, { match, sentence: "Sam Tillery ya es cliente (mismo teléfono).", onAddAnyway: () => {}, onUse: () => {} }));
    expect(s).toContain(">Usar Este Cliente</button>");
    expect(s).toContain(">Agregar de Todos Modos</button>");
    expect(es(createElement(DuplicateCustomerAsk, { match, sentence: "x", onAddAnyway: () => {} }))).toContain(">Abrir Su Ficha</a>");
  });

  it("its doors are Title Case in both languages", () => {
    const cu = CATALOGS.find((c) => c.prefix === "cu_")!;
    for (const k of ["cu_btn_openTheirFile", "cu_btn_useThisCustomer", "cu_btn_addAnyway", "cu_btn_statusLead"]) {
      expect(titleCaseIn(cu.en[k], "en"), k).toBe(true);
      expect(esTitleCase(cu.es[k]), k).toBe(true);
    }
    expect(cu.en).not.toHaveProperty("cu_btn_statusInquiry");
    expect(cu.en).not.toHaveProperty("cu_optional");
  });
});

describe("the ask's answers, where a static render cannot reach (source pins)", () => {
  it("New Customer: the fields stay on screen under the ask, Add Anyway posts the same form again, the sheet is never remounted", () => {
    const f = src("src/app/(app)/crm/new-customer-button.tsx");
    expect(f).toContain("if (!res.ok && res.duplicate) {");
    expect(f).toMatch(/\{dup && <DuplicateCustomerAsk [^>]*onAddAnyway=\{submitAnyway\}[^>]*\/>\}\s*<CustomerFields key=\{formKey\}/);
    expect(f).toMatch(/function submitAnyway\(\) \{\s*addAnyway\.current = true;\s*formRef\.current\?\.requestSubmit\(\);/);
    expect(f).toContain('if (addAnyway.current) formData.set("allow_duplicate", "1");');
    expect(f).not.toMatch(/<Modal[^>]*\bkey=/);
    expect(f).not.toMatch(/<form[^>]*\bkey=/);
  });

  it("the quick pickers hand the customer on file to the same callback a new one goes to", () => {
    const inline = src("src/components/new-customer-inline.tsx");
    expect(inline).toMatch(/onUse=\{takeExisting\} onAddAnyway=\{\(\) => save\(true\)\}/);
    expect(inline).toMatch(/function takeExisting[\s\S]*?await done\(\{ id: c\.id, name: c\.name \|\| name\.trim\(\) \|\| phone\.trim\(\) \}\)/);
    expect(inline).toMatch(/async function done[\s\S]*?await onCreated\(c\);/);
    const pick = src("src/app/(app)/quotes/[id]/customer-select.tsx");
    expect(pick).toMatch(/onUse=\{attachExisting\}\s+onAddAnyway=\{\(\) => createAndAttach\(true\)\}/);
    expect(pick).toMatch(/function attachExisting[\s\S]*?await attachMade\(c\.id\);/);
    expect(pick).toMatch(/await attachMade\(made\.id\);/);
    for (const f of [inline, pick]) expect(f).toContain('fd.set("allow_duplicate", "1")');
  });

  it("an existing customer is selected, never added to a picker's list twice (cn-v1171, skeptic #74)", () => {
    const shown = [{ id: "cust-sam", name: "Sam Tillery" }];
    const added = [{ id: "cust-dana", name: "Dana Rook" }];
    expect(addedOnce(added, shown, { id: "cust-sam", name: "Sam Tillery" })).toEqual(added);
    expect(addedOnce(added, shown, { id: "cust-dana", name: "Dana Rook" })).toEqual(added);
    expect(addedOnce(added, shown, { id: "cust-new", name: "Theo Vance" })).toEqual([{ id: "cust-new", name: "Theo Vance" }, ...added]);
    // Every picker that draws the inline door adds through it.
    for (const f of [
      "src/app/(app)/jobs/[id]/job-contacts.tsx",
      "src/app/(app)/recurring/recurring-button.tsx",
      "src/app/(app)/billing/new-invoice-button.tsx",
      "src/app/(app)/billing/[id]/invoice-detail.tsx",
      "src/app/(app)/quotes/estimate-editor.tsx",
    ]) {
      const s = src(f);
      expect(s, f).toContain("addedOnce(");
      expect(s, f).not.toMatch(/setAdded(?:Customers)?\(\(p(?:rev)?\) => \[/);
    }
  });

  it("the estimate's picker: an address typed and Use This Customer says the typed address was not saved; typing in it clears the ask", () => {
    const match = { id: "cust-sam", name: "Sam Tillery", reason: "name" as const };
    const html = en(createElement(DuplicateCustomerAsk, { match, sentence: "x", onAddAnyway: () => {}, onUse: () => {}, note: "The address you typed was not saved: this customer keeps the address on file. Edit the customer to change it." }));
    expect(html).toContain("The address you typed was not saved: this customer keeps the address on file. Edit the customer to change it.");
    expect(en(createElement(DuplicateCustomerAsk, { match, sentence: "x", onAddAnyway: () => {}, onUse: () => {} }))).not.toContain("address on file");
    const cu = CATALOGS.find((c) => c.prefix === "qt_")!;
    // The sentence is about the customer's record, never about what prints: an estimate with a Job Site
    // address of its own prints that one (cn-v1158), so "the one that prints" was not always true.
    expect(cu.en.qt_addressOnFilePrints).toBe("The address you typed was not saved: this customer keeps the address on file. Edit the customer to change it.");
    expect(cu.es.qt_addressOnFilePrints).toBe("La dirección que escribiste no se guardó: este cliente conserva la que ya tiene. Edita el cliente para cambiarla.");
    const pick = src("src/app/(app)/quotes/[id]/customer-select.tsx");
    expect(pick).toContain('note={newAddr.trim() ? t("qt_addressOnFilePrints") : null}');
    expect(pick).toContain("onChange={(e) => (setNewAddr(e.target.value), setDup(null))}");
  });

  it("Open Their File leaves the open Modal the way a sheet's link does, so Back is one tap", () => {
    expect(src("src/components/duplicate-customer-ask.tsx")).toMatch(/<SheetLink\s+href=\{`\/crm\/\$\{match\.id\}`\}/);
  });
});
