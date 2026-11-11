import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ESTIMATE'S LEAD CARD OPENS THE LEAD (cn-v1157).
 *
 * The owner, 2026-11-10, after an estimate printed a lead's half-typed address: "because it was a lead
 * i had to find the lead on the leads page to update the address there since it wasnt accessible from
 * anywhere else". An estimate with no job prints its lead's address as the job site, and the estimate's
 * own page neither showed that address nor offered a way to it. The card opens the lead's ONE form in
 * place — the same editor the Leads page opens, a second door to it.
 *
 * RE-PINNED ON PURPOSE (cn-v1158): cn-v1157 also drew the lead's address on this card, and this file
 * pinned it there. The estimate now has a Job Site line directly under the card (job-site-line) that
 * says the address the paper prints WHOEVER it comes from (the estimate itself, its job, its lead,
 * its customer), so the card stopped saying it: one place for one fact, or the two could disagree
 * the day an estimate is given a site of its own. The address assertions that stood here (the
 * one-line address, a unit on it, a street with no town, "No address on this lead yet.") moved to
 * job-site-line.test.tsx, restated against the line; what is pinned here now is that the card does
 * NOT draw an address, and that every door it had is exactly where it was.
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
  it("names the lead and keeps the way to its row; the address is the Job Site line's to say, not the card's", () => {
    const html = en(card({ lead: leadOf(leadRow()) }));
    expect(html).toContain("Lead — not a customer yet");
    expect(html).toContain("Dana Rook");
    // The way to the lead's own row stays.
    expect(html).toContain('href="/leads?focus=lead-1"');
    // Re-pinned in cn-v1158 (see the header): the card draws no address line and no pin beside one.
    // (The street still stands inside the lead's own FORM, as a box to correct it in: next test.)
    expect(html).not.toContain("16 Larkspur Circle, Testville, CA 96161");
    expect(html).not.toContain("lucide-map-pin");
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

  it("a lead with no address: the card says nothing about it (the Job Site line says there is no job site), and Edit Lead is still the way to add one", () => {
    const html = en(card({ lead: leadOf(leadRow({ address: null, city: null, state: null, zip: null })) }));
    // Re-pinned in cn-v1158: this sentence was the card's; it was retired with the card's address line.
    expect(html).not.toContain("No address on this lead yet.");
    expect(html).not.toContain("amber-700");
    expect(html).toContain("Edit Lead");
  });

  it("whatever the lead's address looks like (a unit, a street with no town), the card is the same card", () => {
    // These two cases pinned the card's address line in cn-v1157 ("a unit rides on the line", "a street
    // typed with no town shows as typed"). Both are the Job Site line's cases now (job-site-line.test);
    // here they prove the card no longer varies with the address at all, outside the lead's own form.
    const outsideTheForm = (html: string) => html.slice(0, html.indexOf("<section data-modal")) + html.slice(html.indexOf("</section>") + "</section>".length);
    const plain = outsideTheForm(en(card({ lead: leadOf(leadRow()) })));
    expect(plain).toContain("Edit Lead");
    expect(outsideTheForm(en(card({ lead: leadOf(leadRow({ unit: "11" })) })))).toBe(plain);
    expect(outsideTheForm(en(card({ lead: leadOf(leadRow({ address: "16 larkspur circle Testville", city: null, state: null, zip: null })) })))).toBe(plain);
    expect(outsideTheForm(en(card({ lead: leadOf(leadRow({ address: null, city: null, state: null, zip: null })) })))).toBe(plain);
  });

  it("handed no whole row, it draws no door: the form must never open on half a lead", () => {
    const html = en(card({ lead: { id: "lead-1", name: "Dana Rook", phone: "(530) 555-0100" } }));
    expect(html).toContain("Dana Rook");
    expect(html).not.toContain("Edit Lead");
  });

  it("in Spanish", () => {
    const html = es(card({ lead: leadOf(leadRow({ address: null, city: null, state: null, zip: null })) }));
    expect(html).toContain("Editar Prospecto");
    expect(html).not.toContain("Edit Lead");
    // Re-pinned in cn-v1158: the Spanish of the retired sentence went with the English.
    expect(html).not.toContain("Este prospecto aún no tiene dirección.");
  });
});

describe("one place for one fact (cn-v1158): the lead's address is the Job Site line's", () => {
  const select = readFileSync(join(__dirname, "customer-select.tsx"), "utf8");

  it("the card reads no address: no formatter, no pin, and the retired key is in neither language", async () => {
    expect(select).not.toContain("formatFullAddress");
    expect(select).not.toContain("MapPin");
    expect(select).not.toContain("qt_leadNoAddress");
    expect(select).not.toMatch(/leadRow\.(address|unit|city|state|zip)/);
    const { words: qt } = await import("@/lib/words/quotes");
    expect(qt.en).not.toHaveProperty("qt_leadNoAddress");
    expect(qt.es).not.toHaveProperty("qt_leadNoAddress");
  });

  it("the card's doors are exactly what they were: Edit Lead beside Attach Customer, and beside the started-from line", () => {
    expect(select).toContain('{!customer && leadRow && <InquiryModal inquiry={leadRow} mode="edit" trigger="quiet" noDelete />}');
    expect(select).toContain('{leadRow && <InquiryModal inquiry={leadRow} mode="edit" trigger="quiet" noDelete />}');
    expect(select.split("<InquiryModal").length - 1).toBe(2);
  });

  it("the Job Site line stands directly under the card and says the lead's address (its own test drives it)", () => {
    const editor = readFileSync(join(__dirname, "../estimate-editor.tsx"), "utf8");
    const at = editor.indexOf("<CustomerSelect quoteId={savedId}");
    expect(at).toBeGreaterThan(-1);
    const after = editor.slice(at, editor.indexOf("</Card>", at));
    expect(after).toContain("<JobSiteLine quoteId={savedId} {...savedPage.site} />");
    const line = readFileSync(join(__dirname, "job-site-line.tsx"), "utf8");
    expect(line).toContain('lead: "qt_siteFromTheLead",');
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
