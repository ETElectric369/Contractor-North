import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ONE LEAD FORM (cn-v1170). Erik, 2026-11-19: "Name / Business / Address / phone / email / Scope /
 * Notes", "what they need + kind of work = SCOPE", "Remove how long", Business as a text link under
 * Name, and a Lead Source list the company keeps. Drawn the way the modal draws it (react-dom/server),
 * in both languages, with the server actions stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/leads",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
vi.mock("./actions", () => ({ createInquiry: vi.fn(), updateInquiry: vi.fn(), deleteInquiry: vi.fn() }));
vi.mock("./lead-sources-actions", () => ({ readLeadSources: vi.fn(async () => ({ ok: true, sources: [] })) }));

import { LangProvider } from "@/components/lang-provider";
import { InquiryFields, inquiryFormValue, leadSourceOptions, townBoxesFilled, type InquiryFormValue } from "./inquiry-fields";
import { InquiryModal } from "./inquiry-modal";
import { words } from "@/lib/words/leads";
import type { Inquiry } from "@/lib/types";

const LIST = ["Web", "Signage", "Word of Mouth", "Referral"];
const draw = (v: InquiryFormValue, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(InquiryFields, { value: v, onChange: () => {}, sources: LIST, ...extra }));
const drawEs = (v: InquiryFormValue) =>
  renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: createElement(InquiryFields, { value: v, onChange: () => {}, sources: LIST }) }));
const labels = (html: string) => [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
const blank = () => inquiryFormValue();

const lead = (over: Partial<Inquiry> = {}): Inquiry =>
  ({
    id: "lead-1",
    name: "Dana Rook",
    company_name: null,
    type: "residential",
    email: null,
    phone: "(530) 555-0100",
    address: "12 Larkspur Ln",
    unit: null,
    city: "Testville",
    state: "CA",
    zip: "96161",
    message: "Panel swap",
    notes: null,
    source: "manual",
    status: "new",
    ...over,
  }) as Inquiry;

describe("the field order", () => {
  it("Name, Address, Phone, Email, Scope, Notes, Lead Source: Business and the town closed behind links", () => {
    const html = draw(blank());
    expect(labels(html)).toEqual(["Name", "Address", "Phone", "Email", "Scope", "Notes", "Lead Source"]);
    // The Business link sits under Name, before Address; the town's link under Address, before Phone.
    const at = (s: string) => html.indexOf(s);
    expect(at(">Business</button>")).toBeGreaterThan(at(">Name<"));
    expect(at(">Business</button>")).toBeLessThan(at(">Address<"));
    expect(at(">City, State, ZIP</button>")).toBeGreaterThan(at(">Address<"));
    expect(at(">City, State, ZIP</button>")).toBeLessThan(at(">Phone<"));
    expect(html).toMatch(/class="[^"]*min-h-11[^"]*"[^>]*>Business<\/button>/);
  });

  it("no Kind of Work, no How Long, no More Options", () => {
    const html = draw(blank());
    for (const gone of ["What Kind of Work", "How Long", "More Options", 'name="work_kind"', 'name="planned_minutes"', "Not Sure Yet"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("every field posts: the closed ones as hidden inputs, the rest by name", () => {
    const html = draw(blank());
    for (const n of ["company_name", "city", "state", "zip"]) expect(html).toContain(`type="hidden" name="${n}"`);
    for (const n of ["name", "address", "phone", "email", "message", "notes", "source"]) expect(html).toMatch(new RegExp(`name="${n}"`));
    // The visible boxes of the closed pairs carry no name, so nothing posts twice.
    expect(html.match(/name="company_name"/g)).toHaveLength(1);
  });

  it("Scope is the message and Notes says only the team sees it", () => {
    const html = draw(blank());
    expect(html).toMatch(/<textarea[^>]*id="message"[^>]*name="message"[^>]*placeholder="What they need and the kind of work…"/);
    expect(html).toContain('placeholder="Only your team sees these."');
  });
});

describe("the Business link", () => {
  it("closed by default; open with the box when the lead has a business", () => {
    expect(draw(blank())).not.toContain('id="company_name"');
    const html = draw({ ...blank(), company_name: "Northline Supply" });
    expect(html).not.toContain(">Business</button>");
    expect(labels(html)).toEqual(["Name", "Business", "Address", "Phone", "Email", "Scope", "Notes", "Lead Source"]);
    expect(html).toMatch(/id="company_name"[^>]*value="Northline Supply"|value="Northline Supply"[^>]*id="company_name"/);
  });
});

describe("the City / State / ZIP link", () => {
  it("a picked street shows its town on the grey line, boxes closed, and still posts it", () => {
    const v = inquiryFormValue(lead());
    expect(v.town_picked).toBe(true);
    expect(townBoxesFilled(v)).toBe(false);
    const html = draw(v);
    expect(html).toContain('<p class="mt-1 text-xs text-slate-500">Testville, CA 96161</p>');
    expect(html).not.toContain(">City<");
    expect(html).toContain('type="hidden" name="city" value="Testville"');
    expect(html).toContain('type="hidden" name="zip" value="96161"');
  });

  it("a typed town (no street) opens the boxes", () => {
    const v = inquiryFormValue(lead({ address: null }));
    expect(townBoxesFilled(v)).toBe(true);
    const html = draw(v);
    expect(labels(html)).toEqual(["Name", "Address", "City", "State", "Zip", "Phone", "Email", "Scope", "Notes", "Lead Source"]);
    expect(html).not.toContain(">City, State, ZIP</button>");
  });
});

describe("the Lead Source select", () => {
  const options = (html: string) => {
    const sel = html.match(/<select[^>]*id="source"[^>]*>([\s\S]*?)<\/select>/)![1];
    return [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  };

  it("blank first, then the company's list; nothing picked on a new lead", () => {
    const html = draw(blank());
    expect(options(html)).toEqual([["", ""], ...LIST.map((s) => [s, s])]);
    expect(html.match(/<option value="([^"]*)" selected=""/g)).toEqual(['<option value="" selected=""']);
  });

  it("'manual' reads as blank", () => {
    expect(inquiryFormValue(lead({ source: "manual" })).source).toBe("");
  });

  it("a website door is kept as its own option, worded From Your Website, and selected", () => {
    const v = inquiryFormValue(lead({ source: "public_form" }));
    expect(v.source).toBe("public_form");
    const html = draw(v);
    expect(options(html)).toContainEqual(["public_form", "From Your Website"]);
    expect(html).toMatch(/<option value="public_form" selected="">From Your Website<\/option>/);
  });

  it("a label taken off the list is kept as its own option; one on the list is not doubled", () => {
    const html = draw(inquiryFormValue(lead({ source: "Yard Sign 2025" })));
    expect(options(html)).toContainEqual(["Yard Sign 2025", "Yard Sign 2025"]);
    expect(options(draw(inquiryFormValue(lead({ source: "Referral" })))).filter(([v]) => v === "Referral")).toHaveLength(1);
  });

  it("leadSourceOptions: the pure rule", () => {
    expect(leadSourceOptions(LIST, "", "Web site")).toHaveLength(4);
    expect(leadSourceOptions(LIST, "manual", "Web site")).toHaveLength(4);
    expect(leadSourceOptions(LIST, "site_chat", "Web site")[0]).toEqual({ value: "site_chat", label: "Web site" });
    expect(leadSourceOptions([], "Referral", "Web site")).toEqual([{ value: "Referral", label: "Referral" }]);
  });

  it("while the list is read the current source still shows; a failed read is said", () => {
    const loading = renderToStaticMarkup(createElement(InquiryFields, { value: inquiryFormValue(lead({ source: "Signage" })), onChange: () => {}, sources: null }));
    expect(loading).toMatch(/<option value="Signage" selected="">Signage<\/option>/);
    const failed = draw(blank(), { sources: null, sourcesFailed: true });
    expect(failed).toContain("Your lead sources didn&#x27;t load.");
  });
});

describe("in Spanish", () => {
  it("the same order, the links in Spanish", () => {
    const html = drawEs(blank());
    expect(labels(html)).toEqual(["Nombre", "Dirección", "Teléfono", "Correo", "Alcance", "Notas", "Origen del Prospecto"]);
    expect(html).toContain(">Empresa</button>");
    expect(html).toContain(">Ciudad, Estado, Código Postal</button>");
    expect(drawEs(inquiryFormValue(lead({ source: "deck_configurator" })))).toContain(">Desde Tu Sitio Web<");
  });
});

describe("the modal's doors", () => {
  const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
  const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));

  it("trigger details is a plain secondary button saying Edit Details / Editar Detalles", () => {
    const html = en(createElement(InquiryModal, { inquiry: lead(), mode: "edit", trigger: "details" }));
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-slate-100[^"]*"[^>]*>Edit Details<\/button>/);
    expect(es(createElement(InquiryModal, { inquiry: lead(), mode: "edit", trigger: "details" }))).toContain(">Editar Detalles</button>");
  });

  it("the other triggers are as they were (an edit with no trigger now draws Edit Details: the outline Edit had no caller)", () => {
    expect(en(createElement(InquiryModal, { inquiry: lead(), mode: "edit" }))).toMatch(/>Edit Details<\/button>/);
    expect(en(createElement(InquiryModal, { inquiry: lead(), mode: "edit", trigger: "quiet" }))).toMatch(/<\/svg> Edit Lead<\/button>/);
    expect(en(createElement(InquiryModal, {}))).toMatch(/<\/svg> New Lead<\/button>/);
  });

  it("the modal reads the list when it opens, says New Lead / Edit Lead and keeps its saves", () => {
    const modal = readFileSync(join(process.cwd(), "src/app/(app)/leads/inquiry-modal.tsx"), "utf8");
    expect(modal).toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;[\s\S]*?readLeadSources\(\)/);
    expect(modal).toContain("sources={sources} sourcesFailed={sourcesFailed}");
    expect(modal).toContain('title={editing ? t("ld_btn_editLead") : t("ld_btn_newLead")}');
    expect(modal).toContain('saveLabel={editing ? t("ld_btn_saveChanges") : t("ld_btn_createLead")}');
    // The required rule is unchanged: any one of name, phone or scope.
    expect(modal).toContain("if (!form.name.trim() && !form.phone.trim() && !form.message.trim()) {");
    expect(words.en.ld_btn_editDetails).toBe("Edit Details");
    expect(words.es.ld_btn_editDetails).toBe("Editar Detalles");
  });

  it("the removed keys are gone in both languages", () => {
    for (const k of ["ld_whatKindOfWork", "ld_howLong", "ld_btn_moreOptions", "ld_companyEmail", "ld_btn_addTheTown", "ld_internalNotes", "ld_btn_halfDay4h", "ld_whatTheyNeed"]) {
      expect(words.en, k).not.toHaveProperty(k);
      expect(words.es, k).not.toHaveProperty(k);
    }
  });
});
