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
  setInquiryStatus: vi.fn(),
  reopenLead: vi.fn(),
  suggestVisitSlots: vi.fn(),
  createInquiry: vi.fn(),
  updateInquiry: vi.fn(),
  refreshPlanBrief: vi.fn(),
  intakeFileUrl: vi.fn(),
}));
vi.mock("@/app/(app)/appointments/actions", () => ({ createInspectionNow: vi.fn(), openLeadInspection: vi.fn() }));
vi.mock("./lead-sources-actions", () => ({ readLeadSources: vi.fn() }));
// The booking sheet drawn open (a closed Modal renders nothing on the server): its title, body and save.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ title, children, footer }: { title: ReactNode; children: ReactNode; footer?: ReactNode }) =>
    createElement("section", null, createElement("h2", null, title), children, footer),
  ModalActions: ({ saveLabel }: { saveLabel?: string }) => createElement("button", null, saveLabel),
}));
// The link-ready screen is a state the sheet reaches after a server round trip; this seeds it. The
// first useState(null) LeadScheduleSheet calls is its `link` (the others start "", a day, or slots).
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
import { InquiryRow } from "./inquiry-row";
import { InquiryFields, inquiryFormValue } from "./inquiry-fields";
import { LeadScheduleSheet } from "./convert-menu";
import { NotSoldFold } from "./not-sold-fold";
import { translator } from "@/lib/i18n";
import { formatDateTime } from "@/lib/utils";
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

// The server's now, 3 days and 4 hours after the lead came in (the running clock's first draw).
const rowProps = { todayYmd: "2026-09-28", tz: "America/Los_Angeles", nowMs: Date.parse("2026-09-27T16:00:00.000Z") + (3 * 24 + 4) * 3_600_000 };

describe("the row in Spanish (cn-v1170)", () => {
  it("says the score, the source, the clock and the doors in Spanish", () => {
    const html = es(createElement(InquiryRow, { inquiry: lead({ source: "intake" as Inquiry["source"] }), ...rowProps }));
    expect(html).toContain("Prioridad 7");
    expect(html).toContain("Desde Tu Sitio Web");
    expect(html).toMatch(/aria-label="Esperando 3 d 4 h desde que llegó"[^>]*>3 d 4 h</);
    for (const w of ["Agendar</button>", "No Vendido", "Editar Detalles"]) expect(html, w).toContain(w);
    expect(html).not.toContain("Priority 7");
    expect(html).not.toContain(">Schedule<");
    expect(html).not.toContain("Nuevo · Llámale");
  });

  it("its dates come out es-US (and English stays as it was)", () => {
    const l = lead();
    const html = es(createElement(InquiryRow, { inquiry: l, ...rowProps }));
    const esCreated = formatDateTime(l.created_at, undefined, "es");
    const enCreated = formatDateTime(l.created_at);
    expect(esCreated).not.toBe(enCreated);
    expect(decode(html)).toContain(`title="Agregado ${esCreated}"`);
    const english = decode(en(createElement(InquiryRow, { inquiry: l, ...rowProps })));
    expect(english).toContain(`title="Added ${enCreated}"`);
    expect(english).toContain(">3d 4h<");
  });

  it("the Not Sold fold is Spanish: its count, each lead's Reopen, the cut and a failed read", () => {
    const t = translator("es");
    const html = es(createElement(NotSoldFold, { leads: [{ id: "l2", name: "Dana Rook", company_name: null, message: "Deck stairs" }], cut: true, failed: false, t }));
    expect(html).toContain("No Vendidos (1)");
    expect(html).toContain('href="/leads/l2"');
    expect(html).toContain("Reabrir");
    expect(html).toContain("Se muestran los 50 más recientes.");
    const failed = es(createElement(NotSoldFold, { leads: [], cut: false, failed: true, t }));
    expect(failed).toContain("No se pudieron cargar los prospectos no vendidos.");
    // None on file and nothing failed: no fold at all.
    expect(es(createElement(NotSoldFold, { leads: [], cut: false, failed: false, t }))).toBe("");
  });
});

describe("New Lead's fields in Spanish", () => {
  it("labels in the one form's order, Business a box, the town's link, and no Kind or How Long (cn-v1170, cn-v1185)", () => {
    const html = es(createElement(InquiryFields, { value: inquiryFormValue(), onChange: () => {} }));
    const labels = [...html.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Nombre", "Empresa", "Dirección", "Teléfono", "Correo", "Alcance", "Notas", "Origen del Prospecto"]);
    expect(html).not.toContain(">Empresa</button>");
    expect(html).toContain(">Ciudad, Estado, Código Postal</button>");
    expect(html).not.toContain("Cuánto Tiempo");
    expect(html).not.toContain("Más Opciones");
  });
});

describe("the Schedule sheet in Spanish", () => {
  const sheet = { inquiryId: "lead-1", inquiryName: "Ana Larkspur", open: true, onClose: () => {} };

  it("the booking sheet speaks Spanish, with its three ways", () => {
    const html = es(createElement(LeadScheduleSheet, sheet));
    expect(html).toContain("Agendar una Inspección");
    expect(html).toContain("Pone una inspección para <strong>Ana Larkspur</strong> en tu Agenda");
    for (const w of ["Fijar Fecha", "Que Ellos Elijan", "Empezar Ahora"]) expect(html, w).toContain(w);
  });

  // cn-v1180 (C3): Book It sits INSIDE the Schedule sheet (Agendar), so in Spanish it is its own word.
  it("Book It is Fijar Fecha, never a second Agendar inside the Agendar sheet; English is unchanged", () => {
    const html = es(createElement(LeadScheduleSheet, sheet));
    expect(html).not.toMatch(/>Agendar</);
    expect(translator("es")("ld_btn_bookIt")).toBe("Fijar Fecha");
    expect(translator("es")("ld_btn_schedule")).toBe("Agendar");
    expect(translator("en")("ld_btn_bookIt")).toBe("Book It");
  });

  it("the link-ready screen is Spanish, but the text the CUSTOMER gets stays English", () => {
    seed.link = { token: "tok-1", phone: "5305550100" };
    const html = es(createElement(LeadScheduleSheet, { ...sheet, businessPhone: "(530) 555-0199" }));
    expect(html).toContain("Envíales Estas Horas por Mensaje");
    expect(html).toContain("Copiar Enlace");
    expect(html).toContain("Enviar por Mensaje");
    expect(html).toContain("no desde <span class=\"font-medium\">(530) 555-0199</span>");
    const href = decode(html.match(/href="(sms:[^"]+)"/)![1]);
    const body = decodeURIComponent(href.slice(href.indexOf("body=") + 5));
    expect(body).toBe("Hi! Pick a time for your site visit and we'll lock it in: https://example.test/pick/tok-1");
  });
});
