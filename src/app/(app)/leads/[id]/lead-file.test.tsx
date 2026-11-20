import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE LEAD'S FILE (cn-v1170, /leads/<id>), drawn the way the page draws it (react-dom/server) in both
 * languages, one stage at a time: open (the doors and the clock), standing (the visit named, no
 * Schedule), Not Sold (Reopen), and a lead with a customer (the hand-over link). Plus the visit state
 * table, Start an Estimate's switch, and the pin that no money column is read or drawn.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/leads/lead-1",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/components/use-org-public-base", () => ({ useOrgPublicBase: () => "https://example.test" }));
vi.mock("@/lib/use-draft", () => ({ useDraft: () => ({ restored: false, clear: () => {} }) }));
vi.mock("../actions", () => ({
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
vi.mock("../lead-sources-actions", () => ({ readLeadSources: vi.fn() }));
vi.mock("@/app/(app)/appointments/actions", () => ({ createInspectionNow: vi.fn(), openLeadInspection: vi.fn() }));

import { LeadFile, visitStateKey, visitWhen, type LeadFileProps } from "./lead-file";
import { FileEstimates } from "./file-estimates";
import { startLeadEstimate } from "./file-doors";
import { LEAD_FILE_COLUMNS, FILE_VISIT_COLUMNS, FILE_ESTIMATE_COLUMNS, FILE_JOB_COLUMNS, type FileLead, type FileVisit } from "./file-reads";
import { LangProvider } from "@/components/lang-provider";
import { translator, type Lang } from "@/lib/i18n";
import type { LeadStage } from "@/lib/leads/new-intake";

const TZ = "America/Los_Angeles";
const lead = (over: Partial<FileLead> = {}): FileLead =>
  ({
    id: "lead-1",
    name: "Sam Tillery",
    company_name: "Tillery Builders",
    type: "residential",
    email: "sam@example.test",
    phone: "(530) 555-0100",
    address: "12 Larkspur Ln",
    unit: null,
    city: "Testville",
    state: "CA",
    zip: "96161",
    message: "A new deck off the back.\nStairs to the yard.",
    notes: "Gate code 1234",
    source: "Referral",
    status: "new",
    last_contacted_at: null,
    customer_id: null,
    converted_to: null,
    converted_at: null,
    created_by: null,
    created_at: "2026-11-18T17:00:00Z",
    updated_at: "2026-11-18T17:00:00Z",
    priority: 0,
    intake: null,
    referrer: { full_name: "Dana Rook" },
    ...over,
  }) as FileLead;

const visit = (over: Partial<FileVisit> = {}): FileVisit => ({
  id: "v1",
  type: "inspection",
  status: "scheduled",
  outcome: null,
  starts_at: "2026-11-21T17:00:00Z",
  title: "Inspection: Sam Tillery",
  ...over,
});

function draw(stage: LeadStage, lang: Lang, over: Partial<LeadFileProps> = {}) {
  const props: LeadFileProps = {
    lead: lead(),
    stage,
    visits: [],
    estimates: [],
    jobs: [],
    customerName: null,
    tz: TZ,
    businessPhone: null,
    nowMs: Date.parse("2026-11-19T17:00:00Z"),
    lang,
    t: translator(lang),
    referralsOn: true,
    estimatesOn: true,
    openSchedule: false,
    ...over,
  };
  return renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(LeadFile, props) }));
}

describe("open: on the Leads list, with its doors and the running clock", () => {
  it("in English", () => {
    const html = draw("open", "en");
    expect(html).toContain("On the Leads List");
    expect(html).toMatch(/ Schedule<\/button>/);
    expect(html).toContain("Not Sold");
    expect(html).toContain("Edit Details");
    expect(html).toContain('aria-label="Waiting 1d 0h since it came in"');
    expect(html).toContain("Start an Estimate");
    expect(html).toContain("Save as Contact");
    // The contact lines, the row's format, and the Scope whole with its line break kept.
    expect(html).toContain('href="tel:(530) 555-0100"');
    expect(html).toContain('href="mailto:sam@example.test"');
    expect(html).toContain("12 Larkspur Ln, Testville");
    expect(html).toContain("Referred by Dana Rook");
    expect(html).toContain("A new deck off the back.\nStairs to the yard.");
    expect(html).toContain("Gate code 1234");
    expect(html).toContain('href="/leads"');
  });
  it("in Spanish", () => {
    const html = draw("open", "es");
    expect(html).toContain("En la Lista de Prospectos");
    expect(html).toContain("Agendar");
    expect(html).toContain("No Vendido");
    expect(html).toContain("Editar Detalles");
    expect(html).toContain("Esperando 1 d 0 h desde que llegó");
    expect(html).toContain("Empezar un Presupuesto");
    expect(html).toContain("Volver a Prospectos");
  });
  it("Track Referrals off: no Referred by", () => {
    expect(draw("open", "en", { referralsOn: false })).not.toContain("Referred by");
  });
  it("visits unread: said, and the lead keeps its doors", () => {
    const html = draw("open", "en", { visits: null });
    expect(html).toContain("Couldn&#x27;t check this lead&#x27;s visits");
    expect(html).toContain("Couldn&#x27;t load its inspections");
    expect(html).not.toContain("No inspection yet.");
  });
});

describe("standing: its visit is named, and there is no Schedule and no clock", () => {
  for (const lang of ["en", "es"] as const) {
    it(lang, () => {
      const html = draw("standing", lang, { visits: [visit()] });
      expect(html).toContain('href="/appointments/v1"');
      expect(html).toContain(lang === "en" ? "Inspection on the Books · Nov 21" : "Inspección Agendada · 21 nov");
      expect(html).not.toContain(lang === "en" ? "Schedule<" : "Agendar<");
      expect(html).not.toContain(lang === "en" ? "since it came in" : "desde que llegó");
      expect(html).toContain(lang === "en" ? "Start an Estimate" : "Empezar un Presupuesto");
    });
  }
  it("a visit waiting on their pick says so in the badge", () => {
    expect(draw("standing", "en", { visits: [visit({ status: "proposed" })] })).toContain("Inspection on the Books · Waiting on Their Pick");
  });
});

describe("a pick-a-time request nobody answered (cn-v1170)", () => {
  const ranOut = visit({ status: "proposed", starts_at: "2026-11-18T17:00:00Z" });
  it("once the first time offered goes by with no pick, the file says the times were sent, by its doors", () => {
    expect(draw("open", "en", { visits: [ranOut] })).toContain("The times were sent and no pick has come back.");
    expect(draw("open", "es", { visits: [ranOut] })).toContain("Se enviaron los horarios y no ha elegido ninguno.");
  });
  it("not while the first time is still ahead, and not while another visit stands", () => {
    expect(draw("standing", "en", { visits: [visit({ status: "proposed" })] })).not.toContain("no pick has come back");
    expect(draw("standing", "en", { visits: [ranOut, visit({ id: "v2" })] })).not.toContain("no pick has come back");
  });
});

describe("the bucket and the customer's own visit request (kept from the old row)", () => {
  it("the bucket's letter and words, the blurb on hover", () => {
    const html = draw("open", "en", { lead: lead({ lead_bucket: "B" }) });
    expect(html).toMatch(/<span[^>]*title="No plans, but a sketch and\/or real dimensions\."[^>]*>.*?B · Measure &amp; quote<\/span>/);
  });
  it("Needs a Visit while nothing stands, in both languages; not once a visit stands", () => {
    expect(draw("open", "en", { lead: lead({ site_inspection_required: true }) })).toContain("Needs a Visit");
    expect(draw("open", "es", { lead: lead({ site_inspection_required: true }) })).toContain("Necesita una Visita");
    expect(draw("standing", "en", { lead: lead({ site_inspection_required: true }), visits: [visit()] })).not.toContain("Needs a Visit");
    expect(draw("open", "en")).not.toContain("Needs a Visit");
  });
  it("the file reads both columns", () => {
    expect(LEAD_FILE_COLUMNS).toContain("lead_bucket");
    expect(LEAD_FILE_COLUMNS).toContain("site_inspection_required");
  });
});

describe("Not Sold: kept on file, with Reopen", () => {
  for (const lang of ["en", "es"] as const) {
    it(lang, () => {
      const html = draw("notSold", lang, { lead: lead({ status: "lost" }) });
      expect(html).toContain(lang === "en" ? "Reopen" : "Reabrir");
      expect(html).toContain(lang === "en" ? "Not Sold" : "No Vendido");
      expect(html).not.toContain(lang === "en" ? "Save as Contact" : "Guardar como Contacto");
      expect(html).not.toContain(lang === "en" ? "Start an Estimate" : "Empezar un Presupuesto");
    });
  }
});

describe("converted or with a customer: the file hands over to the customer's page", () => {
  for (const lang of ["en", "es"] as const) {
    it(lang, () => {
      const html = draw("converted", lang, {
        lead: lead({ customer_id: "c1", converted_at: "2026-11-19T17:00:00Z", converted_to: "quote" }),
        customerName: "Sam Tillery",
        estimates: [{ id: "q1", quote_number: "E-001", title: "Larkspur deck", status: "draft", created_at: "2026-11-19T17:00:00Z" }],
        jobs: [{ id: "j1", job_number: "J-001", name: "Larkspur deck", status: "to_be_scheduled" }],
      });
      expect(html).toContain('href="/crm/c1"');
      expect(html).toContain(lang === "en" ? "Open Customer File · Sam Tillery" : "Abrir Ficha de Cliente · Sam Tillery");
      expect(html).toContain(lang === "en" ? "Became an Estimate" : "Se Convirtió en Presupuesto");
      expect(html).toContain('href="/quotes/q1"');
      expect(html).toContain('href="/jobs/j1"');
      expect(html).not.toContain(lang === "en" ? "Save as Contact" : "Guardar como Contacto");
      expect(html).not.toContain(lang === "en" ? "Start an Estimate" : "Empezar un Presupuesto");
    });
  }
  it("an open lead that already has a customer hands over too, and its name unread still links", () => {
    const html = draw("open", "en", { lead: lead({ customer_id: "c1" }), customerName: null });
    expect(html).toContain('href="/crm/c1"');
    expect(html).toContain("Open the Customer&#x27;s File");
    expect(html).not.toContain("Save as Contact");
  });
  it("no jobs: no Jobs card; a failed jobs read is said", () => {
    expect(draw("open", "en")).not.toContain(">Jobs<");
    expect(draw("open", "en", { jobs: null })).toContain("Couldn&#x27;t load its jobs");
  });
});

describe("a visit's state words", () => {
  const cases: [Partial<FileVisit>, string, string, string][] = [
    [{ status: "scheduled" }, "ld_btn_fileVisitBooked", "Booked", "Agendada"],
    [{ status: "proposed" }, "ld_btn_fileVisitBooked", "Booked", "Agendada"],
    [{ status: "completed" }, "ld_btn_fileVisitDone", "Done", "Hecha"],
    [{ status: "completed", outcome: "won" }, "ld_btn_fileVisitWon", "Won", "Ganada"],
    [{ status: "completed", outcome: "lost" }, "ld_btn_fileVisitNotSold", "Not Sold", "No Vendida"],
    [{ status: "completed", outcome: "no_bid" }, "ld_btn_fileVisitNotSold", "Not Sold", "No Vendida"],
  ];
  it.each(cases)("%o reads %s", (over, key, en, es) => {
    expect(visitStateKey({ status: null, outcome: null, ...over })).toBe(key);
    expect(translator("en")(key)).toBe(en);
    expect(translator("es")(key)).toBe(es);
  });
  it("a state it was not taught reads as its stored word", () => {
    expect(visitStateKey({ status: "mystery", outcome: null })).toBeNull();
    expect(draw("open", "en", { visits: [visit({ status: "mystery" })] })).toContain("mystery");
  });
  it("when: a day, waiting on their pick, or waiting for a day", () => {
    const t = translator("en");
    expect(visitWhen({ status: "proposed", starts_at: "2026-11-21T17:00:00Z" }, TZ, "en", t)).toBe("Waiting on Their Pick");
    expect(visitWhen({ status: "scheduled", starts_at: null }, TZ, "en", t)).toBe("Waiting for a Day");
    expect(visitWhen({ status: "scheduled", starts_at: null }, TZ, "es", translator("es"))).toBe("Esperando un Día");
    expect(visitWhen({ status: "scheduled", starts_at: "2026-11-21T17:00:00Z" }, TZ, "en", t)).toContain("Nov 21");
  });
});

describe("Start an Estimate: the Estimates switch, and only while the lead is in play", () => {
  const t = translator("en");
  const r = (stage: LeadStage, estimatesOn: boolean) =>
    renderToStaticMarkup(createElement(FileEstimates, { leadId: "lead-1", estimates: [], stage, estimatesOn, lang: "en", t }));
  it("on: open and standing; never Not Sold or converted", () => {
    expect(r("open", true)).toContain("Start an Estimate");
    expect(r("standing", true)).toContain("Start an Estimate");
    expect(r("notSold", true)).not.toContain("Start an Estimate");
    expect(r("converted", true)).not.toContain("Start an Estimate");
  });
  it("off: no door, whatever the stage", () => {
    for (const s of ["open", "standing"] as const) expect(r(s, false)).not.toContain("Start an Estimate");
  });
  it("follows the redirect convertInquiry answers; a refusal is said", async () => {
    const open = vi.fn();
    const toast = vi.fn();
    await startLeadEstimate({ id: "lead-1" }, { convert: async () => ({ ok: true, redirect: "/quotes/q9/edit" }), open, toast });
    expect(open).toHaveBeenCalledWith("/quotes/q9/edit");
    await startLeadEstimate({ id: "lead-1" }, { convert: async () => ({ ok: false, error: "Estimates are off." }), open, toast });
    expect(toast).toHaveBeenCalledWith("Estimates are off.", "error");
  });
  it("estimates unread: said, never 'no estimate'", () => {
    const html = renderToStaticMarkup(createElement(FileEstimates, { leadId: "lead-1", estimates: null, stage: "open", estimatesOn: true, lang: "en", t }));
    expect(html).toContain("Couldn&#x27;t load its estimates");
    expect(html).not.toContain("No estimate yet.");
  });
});

describe("no money on the lead's file", () => {
  const MONEY = /total|amount|price|subtotal|cost|rate|deposit|balance/i;
  it("the selects name no money column", () => {
    for (const cols of [LEAD_FILE_COLUMNS, FILE_VISIT_COLUMNS, FILE_ESTIMATE_COLUMNS, FILE_JOB_COLUMNS]) expect(cols).not.toMatch(MONEY);
    expect(LEAD_FILE_COLUMNS).not.toContain("*");
  });
  it("the estimates list draws none, even when a row carries one", () => {
    const estimates = [{ id: "q1", quote_number: "E-001", title: "Larkspur deck", status: "sent", created_at: "2026-11-19T17:00:00Z", total: 12345.67 }];
    const html = renderToStaticMarkup(createElement(FileEstimates, { leadId: "lead-1", estimates, stage: "open", estimatesOn: true, lang: "en", t: translator("en") }));
    expect(html).toContain("E-001");
    expect(html).not.toMatch(/12,?345|\$/);
  });
  it("the file's sources read no money field", () => {
    for (const f of ["lead-file.tsx", "file-estimates.tsx", "page.tsx"]) {
      const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/[id]", f), "utf8");
      expect(src, f).not.toMatch(/\.(total|estimate_total|amount|subtotal)\b|formatCurrency/);
    }
  });
});
