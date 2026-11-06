import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE LEADS IN SPANISH (Ventas-2, cn-v1146): the row, the New Lead fields and the convert menu, drawn
 * the way the page draws them (react-dom/server) under a Spanish LangProvider. The words come from
 * lib/words/leads; the dates follow the language (es-US); and the text the CUSTOMER receives from Text
 * It stays the tenant's English whatever the office seat reads.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/leads",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
vi.mock("./actions", () => ({
  convertInquiry: vi.fn(),
  deleteInquiry: vi.fn(),
  markInquiryContacted: vi.fn(),
  setInquiryStatus: vi.fn(),
  sizeLead: vi.fn(),
  snoozeInquiry: vi.fn(),
  suggestVisitSlots: vi.fn(),
  createInquiry: vi.fn(),
  updateInquiry: vi.fn(),
  refreshPlanBrief: vi.fn(),
  intakeFileUrl: vi.fn(),
}));
vi.mock("@/app/(app)/appointments/actions", () => ({ createInspectionNow: vi.fn(), openLeadInspection: vi.fn() }));
// The booking sheet drawn open (a closed Modal renders nothing on the server): its title, body and save.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer?: ReactNode }) =>
    createElement("section", null, createElement("h2", null, title), children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("button", null, saveLabel),
}));
// The link-ready screen is a state the sheet reaches after a server round trip; this seeds it. The
// first useState(null) ConvertMenu calls is its `link` (the others start false, "", a day, or slots).
const seed: { link: unknown } = { link: undefined };
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (seed.link !== undefined && init === null) {
        const v = seed.link;
        seed.link = undefined;
        return [v, () => {}];
      }
      return actual.useState(init);
    },
  };
});

import { LangProvider } from "@/components/lang-provider";
import { InquiryRow, LeadDetails } from "./inquiry-row";
import { InquiryFields, inquiryFormValue } from "./inquiry-fields";
import { ConvertMenu } from "./convert-menu";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Inquiry } from "@/lib/types";

const es = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LangProvider, { lang: "es", children: el }));
const en = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const lead = (over: Partial<Inquiry> = {}): Inquiry =>
  ({
    id: "lead-1",
    name: "Ana Larkspur",
    company_name: null,
    type: "residential",
    email: null,
    phone: "(530) 555-0100",
    address: "12 Snowbell Way",
    unit: null,
    city: "Testville",
    state: "CA",
    zip: "96161",
    message: "Wants a deck",
    notes: null,
    source: "manual",
    status: "new",
    next_follow_up_at: null,
    last_contacted_at: "2026-09-20T18:00:00.000Z",
    customer_id: null,
    converted_to: null,
    converted_at: null,
    created_by: null,
    created_at: "2026-09-27T16:00:00.000Z",
    updated_at: "2026-09-27T16:00:00.000Z",
    project_type: null,
    lead_bucket: null,
    estimate_total: null,
    site_inspection_required: false,
    priority: 7,
    intake: null,
    ...over,
  }) as Inquiry;

const rowProps = { customers: [], todayYmd: "2026-09-28", tz: "America/Los_Angeles" };

describe("the row in Spanish", () => {
  it("says the next step, the score and the doors in Spanish", () => {
    const html = es(createElement(InquiryRow, { inquiry: lead(), ...rowProps }));
    expect(html).toContain("Nuevo · Llámale");
    expect(html).toContain("Prioridad 7");
    expect(html).toContain("Inspección");
    expect(html).toContain("Agendar");
    expect(html).toContain("Presupuesto");
    expect(html).not.toContain("Priority 7");
    expect(html).not.toContain(">Schedule<");
  });

  it("its dates come out es-US (and English stays as it was)", () => {
    const l = lead();
    const html = es(createElement(InquiryRow, { inquiry: l, ...rowProps }));
    const esCreated = formatDateTime(l.created_at, undefined, "es");
    const enCreated = formatDateTime(l.created_at);
    expect(esCreated).not.toBe(enCreated);
    expect(decode(html)).toContain(`title="Agregado ${esCreated}"`);
    expect(decode(html)).toContain(`contactado ${formatDate(l.last_contacted_at, undefined, "es")}`);
    const english = decode(en(createElement(InquiryRow, { inquiry: l, ...rowProps })));
    expect(english).toContain(`title="Added ${enCreated}"`);
    expect(english).toContain(`contacted ${formatDate(l.last_contacted_at)}`);
  });

  it("the ⋯ panel's doors are Spanish", () => {
    const html = es(createElement(LeadDetails, { inquiry: lead(), todayYmd: "2026-09-28" }));
    for (const w of ["Seguimiento", "Marcar Como Contactado", "Marcar Como Perdido", "Guardar Como Contacto", "Eliminar Prospecto", "Editar"]) {
      expect(html, w).toContain(w);
    }
  });
});

describe("New Lead's fields in Spanish", () => {
  it("labels, durations and the closed More Options row", () => {
    const html = es(createElement(InquiryFields, { value: inquiryFormValue(), onChange: () => {} }));
    const labels = [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Nombre", "Teléfono", "Dirección", "Lo Que Necesitan", "Qué Tipo De Trabajo", "Cuánto Tiempo"]);
    expect(html).toContain("Medio Día (4h)");
    expect(html).toContain("Aún No Sé");
    expect(html).toContain("Más Opciones");
    expect(html).toContain("Empresa · Correo");
    expect(html).toContain(">Inspección<"); // the kind of work, through lib/schedule/work-shape kindLabel
  });
});

describe("the convert menu in Spanish", () => {
  it("the booking sheet speaks Spanish", () => {
    const html = es(createElement(ConvertMenu, { inquiryId: "lead-1", inquiryName: "Ana Larkspur" }));
    expect(html).toContain("Agendar Una Inspección");
    expect(html).toContain("Pone una inspección para <strong>Ana Larkspur</strong> en tu Agenda");
    expect(html).toContain("Que Ellos Elijan");
  });

  it("the link-ready screen is Spanish, but the text the CUSTOMER gets stays English", () => {
    seed.link = { token: "tok-1", phone: "5305550100" };
    const html = es(createElement(ConvertMenu, { inquiryId: "lead-1", inquiryName: "Ana Larkspur", businessPhone: "(530) 555-0199" }));
    expect(html).toContain("Envíales Estas Horas Por Mensaje");
    expect(html).toContain("Copiar Enlace");
    expect(html).toContain("Enviar Por Mensaje");
    expect(html).toContain("no desde <span class=\"font-medium\">(530) 555-0199</span>");
    const href = decode(html.match(/href="(sms:[^"]+)"/)![1]);
    const body = decodeURIComponent(href.slice(href.indexOf("body=") + 5));
    expect(body).toBe("Hi! Pick a time for your site visit and we'll lock it in: https://example.test/pick/tok-1");
  });
});
