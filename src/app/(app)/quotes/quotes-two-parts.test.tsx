import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleCaseIn } from "../../../../tests/title-case-words";

/**
 * THE ESTIMATES PAGE IN TWO PARTS (cn-v1172). Erik, 2026-11-19: "lets break the Estimate page into 2
 * parts consisting of completed inspections in its own new list called Inspections To Estimate, and
 * the other section below is all Estimates like they are now".
 *
 * The page is rendered against a stand-in database (made-up people and streets), in English and in
 * Spanish, beside the Inspections page reading the SAME rows, so an inspected visit is proven to be on
 * exactly one of the two pages in each state of the Estimates switch. The list below is drawn as a
 * marker carrying the estimates' ids in the order handed to it; the row's ⋯ as a marker of its moves.
 */

const state = vi.hoisted(() => ({
  visits: [] as Record<string, unknown>[],
  quotes: [] as Record<string, unknown>[],
  language: undefined as string | undefined,
  role: "owner",
  features: undefined as Record<string, boolean> | undefined,
  failTable: null as string | null,
  tables: [] as string[],
}));

function fakeClient() {
  const settings = () => ({ timezone: "America/Los_Angeles", ...(state.features ? { features: state.features } : {}) });
  const answer = (table: string): unknown[] => {
    if (table === "appointments") return state.visits;
    if (table === "quotes") return state.quotes;
    if (table === "profiles")
      return [{ id: "user-1", role: state.role, active: true, language: state.language, full_name: "The Office", org_id: "org-1", organizations: { settings: settings() } }];
    if (table === "organizations") return [{ settings: settings() }];
    return [];
  };
  const chain = (table: string) => {
    state.tables.push(table);
    let range: [number, number] | null = null;
    const failed = () => state.failTable === table;
    const rows = () => (range ? answer(table).slice(range[0], range[1] + 1) : answer(table));
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: any, err: any) => Promise.resolve(failed() ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(ok, err);
          if (prop === "maybeSingle" || prop === "single") return async () => (failed() ? { data: null, error: { message: "boom" } } : { data: answer(table)[0] ?? null, error: null });
          if (prop === "range") return (a: number, b: number) => ((range = [a, b]), q);
          return () => q;
        },
      },
    );
    return q;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) }, from: (table: string) => chain(table) };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient(), createServiceClient: () => fakeClient() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/quotes",
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("./quotes-list", () => ({
  QuotesList: ({ quotes }: { quotes: { id: string }[] }) => createElement("div", { "data-all-estimates": quotes.map((q) => q.id).join(",") }),
}));
vi.mock("../inspections/inspection-row-menu", () => ({
  InspectionRowMenu: ({ row }: { row: { doors: string[] } }) => createElement("span", { "data-menu": row.doors.join(",") }),
}));

const at = (day: string) => `${day}T18:00:00Z`;
const visit = (id: string, over: Record<string, unknown>) => ({
  id,
  type: "inspection",
  title: "Inspection",
  status: "scheduled",
  starts_at: at("2026-11-03"),
  ends_at: null,
  created_at: at("2026-10-20"),
  location: null,
  capture: null,
  inquiry_id: null,
  job_id: null,
  customer_id: null,
  outcome: null,
  customers: null,
  inquiries: null,
  ...over,
});
// Inspected, nothing written from them (the older first). The first was booked from a lead.
const WU_OLD = visit("wu-1", { status: "completed", starts_at: at("2026-11-03"), customers: { name: "Sam Tillery" }, location: "12 Larkspur Ln", inquiry_id: "inq-1" });
const WU_NEW = visit("wu-2", { status: "completed", title: "Attic fan", starts_at: at("2026-11-08") });
// Priced already: its lead has an estimate, so it is on neither list.
const PRICED = visit("wu-3", { status: "completed", inquiry_id: "inq-9", customers: { name: "Dana Rook" } });
// Ahead: on the Inspections list only.
const AHEAD = visit("cu-1", { starts_at: at("2026-11-12"), customers: { name: "Theo Vance" }, location: "4 Bayberry Rd" });
const QUOTES = [
  { id: "q-sent", status: "sent", inquiry_id: null, job_id: null, created_at: at("2026-11-09") },
  { id: "q-draft", status: "draft", inquiry_id: null, job_id: null, created_at: at("2026-11-01") },
  { id: "q-lead", status: "sent", inquiry_id: "inq-9", job_id: null, created_at: at("2026-11-02") },
];

const decode = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const field = (html: string, name: string) => {
  const m = new RegExp(`data-${name}=""[^>]*>([\\s\\S]*?)</(?:span|a)>`).exec(html);
  return m ? decode(m[1]) : null;
};
const hrefOf = (tag: string) => (/href="([^"]*)"/.exec(tag)?.[1] ?? "").replace(/&amp;/g, "&");
const rowsOf = (html: string) =>
  [...html.matchAll(/<li data-row="([^"]+)" data-state="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => {
    const body = m[3];
    const whoLink = /<a [^>]*data-who=""[^>]*>/.exec(body)?.[0];
    const primary = /(<a [^>]*data-primary=""[^>]*>)([\s\S]*?)<\/a>/.exec(body);
    return {
      id: m[1],
      state: m[2],
      who: field(body, "who"),
      whoHref: whoLink ? hrefOf(whoLink) : null,
      edge: field(body, "edge"),
      what: field(body, "what"),
      word: field(body, "state-word"),
      primary: primary ? [decode(primary[2]), hrefOf(primary[1])] : null,
      menu: /data-menu="([^"]*)"/.exec(body)?.[1] ?? null,
    };
  });
const sectionOf = (html: string) => /<section data-section="to-estimate"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? null;
const headingsOf = (html: string) => [...html.matchAll(/<h2 [^>]*>([\s\S]*?)<\/h2>/g)].map((m) => decode(m[1]));
const listOf = (html: string) => /data-all-estimates="([^"]*)"/.exec(html)?.[1] ?? null;

let QuotesPage: (p: { searchParams: Promise<{ type?: string; status?: string }> }) => Promise<unknown>;
let InspectionsPage: (p: { searchParams: Promise<{ view?: string }> }) => Promise<unknown>;
let LangProvider: any;
beforeAll(async () => {
  // Today is 10 Nov 2026 in the company's timezone.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  QuotesPage = (await import("./page")).default as any;
  InspectionsPage = (await import("../inspections/page")).default as any;
  LangProvider = (await import("@/components/lang-provider")).LangProvider;
}, 30_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.visits = structuredClone([WU_NEW, WU_OLD, PRICED, AHEAD]);
  state.quotes = structuredClone(QUOTES);
  state.language = undefined;
  state.role = "owner";
  state.features = undefined;
  state.failTable = null;
  state.tables = [];
});
const wrap = (page: unknown) => renderToStaticMarkup(createElement(LangProvider, { lang: state.language === "es" ? "es" : "en" }, page as React.ReactElement));
const quotesPage = async (q: { type?: string; status?: string } = {}) => wrap(await QuotesPage({ searchParams: Promise.resolve(q) }));
const inspectionsPage = async () => wrap(await InspectionsPage({ searchParams: Promise.resolve({}) }));

describe("the office's Estimates page: Inspections to Estimate on top, All Estimates below", () => {
  it("English: the heading, the inspected rows in the Inspections list's own card, then All Estimates over the list, drafts first", async () => {
    const html = await quotesPage();
    expect(headingsOf(html)).toEqual(["Inspections to Estimate", "All Estimates"]);
    const section = sectionOf(html)!;
    expect(rowsOf(section)).toEqual([
      {
        id: "wu-1",
        state: "write_up",
        who: "Sam Tillery",
        whoHref: "/leads/inq-1",
        edge: "7d ago",
        what: "12 Larkspur Ln · no field notes",
        word: "Needs an Estimate",
        primary: ["Create Estimate", "/quotes/new?capture=wu-1&inquiry=inq-1"],
        menu: "open,lost",
      },
      {
        id: "wu-2",
        state: "write_up",
        who: "Attic fan",
        whoHref: null,
        edge: "2d ago",
        what: "No field notes",
        word: "Needs an Estimate",
        primary: ["Create Estimate", "/quotes/new?capture=wu-2"],
        menu: "open,lost",
      },
    ]);
    // The same card the Inspections list draws.
    expect(section).toContain('<ul class="space-y-3">');
    expect(section).toMatch(/<li data-row="wu-1" data-state="write_up" class="flex flex-col gap-1\.5 rounded-xl border-2 border-slate-200 bg-white px-4 py-3 shadow-sm">/);
    // The section, then the heading, then the list: in that order.
    expect(html.indexOf("data-section")).toBeLessThan(html.indexOf("All Estimates"));
    expect(html.indexOf("All Estimates")).toBeLessThan(html.indexOf("data-all-estimates"));
    expect(listOf(html)).toBe("q-draft,q-sent,q-lead");
    // No amber, no price in the section.
    expect(section).not.toMatch(/amber-|\$/);
  });

  it("Spanish", async () => {
    state.language = "es";
    const html = await quotesPage();
    expect(headingsOf(html)).toEqual(["Inspecciones por Presupuestar", "Todos los Presupuestos"]);
    const rows = rowsOf(sectionOf(html)!);
    expect(rows.map((r) => [r.what, r.word, r.primary?.[0]])).toEqual([
      ["12 Larkspur Ln · sin notas de campo", "Falta el Presupuesto", "Crear Presupuesto"],
      ["Sin notas de campo", "Falta el Presupuesto", "Crear Presupuesto"],
    ]);
    for (const r of rows) expect(r.edge ?? "").not.toMatch(/ago|Yesterday|Today/);
  });

  it("nobody waiting: one quiet slate line, in both languages, and the list below as always", async () => {
    state.visits = structuredClone([PRICED, AHEAD]);
    let html = await quotesPage();
    expect(rowsOf(sectionOf(html)!)).toEqual([]);
    expect(sectionOf(html)).toMatch(/<p data-to-estimate-empty="" class="px-1 text-sm text-slate-500">No inspections are waiting on an estimate\.<\/p>/);
    expect(listOf(html)).toBe("q-draft,q-sent,q-lead");
    state.language = "es";
    html = await quotesPage();
    expect(decode(sectionOf(html)!)).toContain("No hay inspecciones esperando un presupuesto.");
  });

  for (const table of ["appointments", "invoices"]) {
    it(`a failed read (${table}) is said in the section, never drawn as none`, async () => {
      state.failTable = table;
      const html = await quotesPage();
      const section = decode(sectionOf(html)!);
      expect(section).toContain("The inspections waiting on an estimate couldn't load. Reload to try again.");
      expect(section).not.toContain("No inspections are waiting");
      expect(rowsOf(sectionOf(html)!)).toEqual([]);
      // The list below still draws.
      expect(listOf(html)).toBe("q-draft,q-sent,q-lead");
    });
  }

  it("the failed line in Spanish", async () => {
    state.failTable = "appointments";
    state.language = "es";
    expect(decode(sectionOf(await quotesPage())!)).toContain("No se pudieron cargar las inspecciones que esperan un presupuesto.");
  });
});

describe("when the section is not drawn, and nothing is read for it", () => {
  it("a tech: no section, no heading, and the visits are never read", async () => {
    state.role = "tech";
    const html = await quotesPage();
    expect(sectionOf(html)).toBeNull();
    expect(headingsOf(html)).toEqual([]);
    expect(state.tables).not.toContain("appointments");
    expect(state.tables).not.toContain("invoices");
  });

  it("a filter chosen (?status= or ?type=): the list alone", async () => {
    for (const q of [{ status: "sent" }, { type: "quote" }, { type: "estimate" }]) {
      state.tables = [];
      const html = await quotesPage(q);
      expect(sectionOf(html), JSON.stringify(q)).toBeNull();
      expect(headingsOf(html)).toEqual([]);
      expect(state.tables).not.toContain("appointments");
    }
  });

  it("Estimates off: no section and no read", async () => {
    state.features = { estimates: false };
    const html = await quotesPage();
    expect(sectionOf(html)).toBeNull();
    expect(state.tables).not.toContain("appointments");
  });
});

describe("an inspected visit is on exactly one page, in each state of the switch", () => {
  const idsOn = (html: string) => rowsOf(html).map((r) => r.id);

  it("Estimates on: the Estimates page's top list, not the Inspections list", async () => {
    const onQuotes = idsOn(sectionOf(await quotesPage())!);
    const onInspections = idsOn(await inspectionsPage());
    expect(onQuotes).toEqual(["wu-1", "wu-2"]);
    expect(onInspections).toEqual(["cu-1"]);
    for (const id of ["wu-1", "wu-2", "cu-1"]) expect([onQuotes.includes(id), onInspections.includes(id)].filter(Boolean)).toHaveLength(1);
    // The priced one is on neither.
    expect([...onQuotes, ...onInspections]).not.toContain("wu-3");
  });

  it("Estimates off: the Inspections list, and the Estimates page draws no section", async () => {
    state.features = { estimates: false };
    expect(sectionOf(await quotesPage())).toBeNull();
    expect(idsOn(await inspectionsPage())).toEqual(["cu-1", "wu-1", "wu-2"]);
  });
});

describe("source pins and words", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/page.tsx"), "utf8");

  it("the page reads through the one reader and builds its rows with the Inspections page's builder", () => {
    expect(src).toContain("readInspectionBuckets(supabase, { now })");
    // cn-v1175 (R5): each row is handed its offer (a job made for its customer record after it), if any.
    expect(src).toContain("inspectionsToEstimate(read.buckets).map((a) => rowOf(a, \"write_up\", read.offers.get(a.id) ?? null))");
    expect(src).toContain("isStaff && estimatesOn && !filter && !statusFilter ? readInspectionBuckets");
    // The comment says drafts first, as the sort does.
    expect(src).toContain("DRAFTS FIRST");
  });

  it("the headings are Title Case in both languages", async () => {
    const { translator } = await import("@/lib/i18n");
    for (const lang of ["en", "es"] as const) {
      const t = translator(lang);
      for (const k of ["qt_toEstimateHeading", "qt_allEstimatesHeading"]) expect(titleCaseIn(t(k), lang), `${lang} ${k}`).toBe(true);
    }
  });
});
