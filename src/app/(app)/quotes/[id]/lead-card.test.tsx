import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ESTIMATE'S LEAD CARD SAYS THE ADDRESS AND OPENS THE LEAD (cn-v1157).
 *
 * The owner, 2026-11-10, after an estimate printed a lead's half-typed address: "because it was a lead
 * i had to find the lead on the leads page to update the address there since it wasnt accessible from
 * anywhere else". An estimate with no job prints its lead's address as the job site, and the estimate's
 * own page neither showed that address nor offered a way to it. The card shows it now and opens the
 * lead's ONE form in place — the same editor the Leads page opens, a second door to it.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quotes/q-36",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
// The sheet drawn open, footer and all, so the test can read what the form would offer.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer?: ReactNode }) =>
    createElement("section", { "data-modal": "" }, createElement("h2", null, title), children, footer),
  ModalActions: ({ saveLabel, extra }: { saveLabel?: string; extra?: ReactNode }) =>
    createElement("footer", null, extra, createElement("button", null, saveLabel)),
}));
vi.mock("../actions", () => ({ setQuoteCustomer: vi.fn() }));
vi.mock("../../crm/actions", () => ({ createCustomer: vi.fn(), updateCustomer: vi.fn() }));
vi.mock("../../crm/[id]/edit-customer-button", () => ({ EditCustomerButton: () => createElement("button", null, "EDIT-CUSTOMER") }));
vi.mock("../../leads/actions", () => ({ createInquiry: vi.fn(), updateInquiry: vi.fn(), deleteInquiry: vi.fn() }));

import { CustomerSelect } from "./customer-select";
import { InquiryModal } from "../../leads/inquiry-modal";
import { LangProvider } from "@/components/lang-provider";
import type { Customer, Inquiry } from "@/lib/types";

const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const en = (el: ReturnType<typeof createElement>) => decode(renderToStaticMarkup(el));
const es = (el: ReturnType<typeof createElement>) => decode(renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el })));

const leadRow = (over: Partial<Inquiry> = {}): Inquiry =>
  ({
    id: "lead-1",
    name: "Dana Rook",
    company_name: null,
    type: "residential",
    email: null,
    phone: "(530) 555-0100",
    address: "16 Larkspur Circle",
    unit: null,
    city: "Testville",
    state: "CA",
    zip: "96161",
    message: "Panel upgrade",
    notes: "Gate code on file",
    source: "manual",
    status: "quoted",
    next_follow_up_at: null,
    last_contacted_at: null,
    customer_id: null,
    converted_to: "quote",
    converted_at: "2026-11-10T22:15:00.000Z",
    created_by: null,
    created_at: "2026-10-15T16:00:00.000Z",
    updated_at: "2026-11-10T22:15:00.000Z",
    project_type: null,
    lead_bucket: null,
    estimate_total: null,
    site_inspection_required: false,
    priority: 0,
    intake: null,
    ...over,
  }) as Inquiry;

const leadOf = (row: Inquiry | null) => ({ id: "lead-1", name: "Dana Rook", phone: "(530) 555-0100", row });
const card = (props: Record<string, unknown>) => createElement(CustomerSelect, { quoteId: "q-36", customer: null, customers: [], ...props } as never);

describe("an estimate made out to a lead", () => {
  it("says the lead's address — the job site it prints until there is a job", () => {
    const html = en(card({ lead: leadOf(leadRow()) }));
    expect(html).toContain("Lead — not a customer yet");
    expect(html).toContain("16 Larkspur Circle, Testville, CA 96161");
    // The way to the lead's own row stays.
    expect(html).toContain('href="/leads?focus=lead-1"');
  });

  it("opens the lead's own form right there: Edit Lead, 44px, beside Attach Customer", () => {
    const html = en(card({ lead: leadOf(leadRow()) }));
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*><svg[^>]*>.*?<\/svg> Edit Lead<\/button>/);
    expect(html).toContain("Attach Customer");
    // It is the lead's form (its title and its save), holding the lead's own values.
    expect(html).toMatch(/<h2>Edit Lead<\/h2>/);
    expect(html).toContain("Save Changes");
    expect(html).toContain('value="16 Larkspur Circle"');
  });

  it("never offers Delete Lead beside an estimate", () => {
    expect(en(card({ lead: leadOf(leadRow()) }))).not.toContain("Delete Lead");
  });

  it("a lead with no address says so: the estimate would print no job site", () => {
    const html = en(card({ lead: leadOf(leadRow({ address: null, city: null, state: null, zip: null })) }));
    expect(html).toContain("No address on this lead yet.");
    expect(html).toContain("Edit Lead");
  });

  it("a street typed with no town shows as typed (the hole is visible, not hidden)", () => {
    const html = en(card({ lead: leadOf(leadRow({ address: "16 larkspur circle Testville", city: null, state: null, zip: null })) }));
    expect(html).toContain("16 larkspur circle Testville");
    expect(html).not.toContain("No address on this lead yet.");
  });

  it("a unit rides on the line", () => {
    expect(en(card({ lead: leadOf(leadRow({ unit: "11" })) }))).toContain("16 Larkspur Circle, Unit 11, Testville, CA 96161");
  });

  it("handed no whole row, it draws neither: the form must never open on half a lead", () => {
    const html = en(card({ lead: { id: "lead-1", name: "Dana Rook", phone: "(530) 555-0100" } }));
    expect(html).toContain("Dana Rook");
    expect(html).not.toContain("Edit Lead");
    expect(html).not.toContain("No address on this lead yet.");
  });

  it("in Spanish", () => {
    const html = es(card({ lead: leadOf(leadRow({ address: null, city: null, state: null, zip: null })) }));
    expect(html).toContain("Editar Prospecto");
    expect(html).toContain("Este prospecto aún no tiene dirección.");
    expect(html).not.toContain("Edit Lead");
  });
});

describe("an estimate with a customer that started from a lead", () => {
  const customer = { id: "cust-1", name: "Dana Rook", company_name: null, email: null, phone: null } as unknown as Customer;

  it("keeps the lead reachable: its address still prints as the job site while there is no job", () => {
    const html = en(card({ customer, lead: leadOf(leadRow()) }));
    expect(html).toContain("Started from the lead Dana Rook.");
    expect(html).toContain("Edit Lead");
    expect(html).toContain("EDIT-CUSTOMER");
    // One Edit Lead door on the card, not two.
    expect(html.match(/> Edit Lead<\/button>/g)?.length).toBe(1);
    expect(html).not.toContain("Delete Lead");
  });

  it("no lead, no door", () => {
    const html = en(card({ customer }));
    expect(html).not.toContain("Edit Lead");
  });
});

describe("the lead's form on its own page is what it was", () => {
  it("the outline Edit button, with Delete Lead in the sheet", () => {
    const html = en(createElement(InquiryModal, { inquiry: leadRow(), mode: "edit" }));
    expect(html).toMatch(/<button[^>]*><svg[^>]*>.*?<\/svg> Edit<\/button>/);
    expect(html).toContain("Delete Lead");
  });
});

describe("opened clean, the form starts from the lead as it is now", () => {
  const modal = readFileSync(join(__dirname, "../../leads/inquiry-modal.tsx"), "utf8");
  const open = modal.slice(modal.indexOf("function openModal()"), modal.indexOf("// Confirmed close"));

  it("re-seeds from the current row before the sheet opens, and only when nothing typed would be lost", () => {
    // The card keeps the form mounted for as long as the estimate is open, and its save writes every
    // field it holds: a lead corrected elsewhere must not be written back whole from the old copy.
    expect(open).toContain("if (editing && !dirty) {");
    expect(open).toContain("const fresh = inquiryFormValue(inquiry);");
    expect(open).toMatch(/if \(snap !== initialSnap\.current\) \{\s*initialSnap\.current = snap;\s*setForm\(fresh\);\s*setFormKey\(\(k\) => k \+ 1\);/);
    // Before the sheet opens: the fields are re-seeded, the sheet is never remounted.
    expect(open.indexOf("setForm(fresh)")).toBeLessThan(open.indexOf("setOpen(true)"));
    expect(modal).not.toMatch(/<Modal[^>]*\skey=/);
  });
});

describe("the whole lead rides to the card", () => {
  const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("the estimate page reads the lead's WHOLE row — the form's save writes every field it holds", () => {
    expect(page).toContain('inquiry:inquiry_id(*)');
    expect(page).not.toContain("inquiry:inquiry_id(id, name");
    expect(page).toContain("row: q.inquiry");
  });

  it("every field the lead's save writes is one the form was handed", () => {
    // leads/actions inquiryFields: what updateInquiry overwrites. A new one must reach the form too.
    const actions = readFileSync(join(__dirname, "../../leads/actions.ts"), "utf8");
    const fields = actions.slice(actions.indexOf("function inquiryFields("), actions.indexOf("export async function createInquiry("));
    const written = [...fields.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
    expect(written.sort()).toEqual(
      ["address", "city", "company_name", "email", "message", "notes", "phone", "planned_minutes", "state", "work_kind", "zip"].sort(),
    );
    const row = leadRow() as unknown as Record<string, unknown>;
    // Every one of them is a column of the row the card hands over (work_kind and planned_minutes are
    // real columns lib/types does not list; `*` carries them).
    for (const col of written.filter((c) => c !== "work_kind" && c !== "planned_minutes")) expect(row).toHaveProperty(col);
  });
});
