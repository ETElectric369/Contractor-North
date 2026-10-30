import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PageHeader } from "@/components/page-header";
import { LangProvider } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { VENDOR_MEANS } from "@/lib/vendor-words";
import { CrewBoard, type Lane } from "./schedule/crew-board";

/**
 * THE MAP IN SPANISH, SALES + MONEY + THE SCHEDULE'S HEADINGS (cn-v1139, E1). Every PageHeader on
 * the office's Sales and Money pages reads its title and its one line through t(nv_page_<slug>) /
 * t(nv_desc_<slug>) with the signed-in person's language (lib/current-lang: the (app) layout's
 * cached profile read, never a second profiles query — currentLangFor(user?.id) on a page whose
 * own role check already resolved the session, the no-id door currentLang() on the few that never
 * ask who is signed in), and the schedule's headings read nv_sched_. The English literals below are the words each screen carried BEFORE the catalog, kept
 * here on purpose as an oracle the catalog cannot move: the en render must be byte for byte the
 * old header, and the es render must show the Spanish title. (billing/invoices-page.test.ts renders
 * the whole /billing page with a profile that says es; bills-page-doors renders /bills in English.)
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/schedule",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./timeclock/crew-actions", () => ({ setCrewDayAssignment: vi.fn(), setCrewOffRange: vi.fn(), clearCrewOffRange: vi.fn() }));

const read = (f: string) => readFileSync(join(process.cwd(), "src/app/(app)", f), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const en = translator("en");
const es = translator("es");
const header = (t: (k: string) => string, slug: string) => renderToStaticMarkup(createElement(PageHeader, { title: t(`nv_page_${slug}`), description: t(`nv_desc_${slug}`) }));
const literal = (title: string, description: string) => renderToStaticMarkup(createElement(PageHeader, { title, description }));

/** `noId`: the page never resolves a session of its own, so it reads the no-id door currentLang(). */
type Page = { file: string; slug: string; title: string; desc: string; es: string; noId?: true };
const PAGES: Page[] = [
  { file: "leads/page.tsx", slug: "leads", title: "Leads", desc: "New requests to follow up and convert — nothing converts automatically.", es: "Prospectos", noId: true },
  { file: "crm/page.tsx", slug: "crm", title: "Customers", desc: "Everyone you work for, linked to their jobs, estimates and invoices.", es: "Clientes", noId: true },
  {
    file: "inspections/page.tsx",
    slug: "inspections",
    title: "Inspections",
    desc: "Site visits before you price the work — fill in the inspection, then write it up into an estimate.",
    es: "Inspecciones",
  },
  {
    file: "quotes/new/page.tsx",
    slug: "quotesNew",
    title: "New Estimate",
    desc: "Build line items by hand, or let the estimator draft them from a scope of work or an uploaded plan.",
    es: "Nuevo Presupuesto", noId: true,
  },
  { file: "billing/page.tsx", slug: "billing", title: "Invoices", desc: "Who owes you, what's late, and what came in.", es: "Facturas", noId: true },
  { file: "bills/page.tsx", slug: "bills", title: "Bills", desc: "Drop a receipt or bill anywhere on this page.", es: "Cuentas" },
  { file: "reconcile/page.tsx", slug: "reconcile", title: "Reconcile", desc: "Two records that should agree, and do not.", es: "Conciliar" },
  { file: "payroll/page.tsx", slug: "pay", title: "Pay", desc: "What you owe each person, and what you have paid them.", es: "Nómina" },
  { file: "tax-report/page.tsx", slug: "taxReport", title: "Tax report", desc: "Sales tax collected by rate / jurisdiction — for filing & remittance.", es: "Reporte De Impuestos", noId: true },
  { file: "analytics/page.tsx", slug: "analytics", title: "Analytics", desc: "How the business is actually doing — money in, money owed, win rate, job profit.", es: "Análisis" },
  {
    file: "analytics/accountant/page.tsx",
    slug: "accountant",
    title: "For Your Accountant",
    desc: "One spreadsheet for a month, a quarter or a year: what came in, what went out, who was paid, what's still open and what's in stock.",
    es: "Para Tu Contador",
  },
  { file: "recurring/page.tsx", slug: "recurring", title: "Recurring", desc: "Jobs, invoices, and expenses that repeat. Each one is made on its day, automatically.", es: "Recurrentes", noId: true },
  { file: "timecards/page.tsx", slug: "timecards", title: "Timecards", desc: "Review your crew's hours by week.", es: "Tarjetas De Tiempo" },
  { file: "organize/page.tsx", slug: "organize", title: "Organize My…", desc: "Papers you snapped wait here until you file them.", es: "Organizar Mis…", noId: true },
  {
    file: "petty-cash/page.tsx",
    slug: "pettyCash",
    title: "Petty Cash",
    desc: "Cash you took out, and older cash entries. A new cash purchase goes in through Snap Or Note or Add By Hand.",
    es: "Caja Chica", noId: true,
  },
];

describe("every Sales and Money page reads its title and line through the map", () => {
  for (const p of PAGES) {
    it(`${p.file}: t("nv_page_${p.slug}") / t("nv_desc_${p.slug}") from ${p.noId ? "the no-id door currentLang()" : "currentLangFor(user?.id)"}, never the literal`, () => {
      const src = read(p.file);
      expect(src).toContain('import { translator } from "@/lib/i18n";');
      if (p.noId) {
        // No id in scope: the no-id door, one getUser then the cached row (billing resolves its user only inside a later Promise.all).
        expect(src).toContain('import { currentLang } from "@/lib/current-lang";');
        expect(src).toContain("const t = translator(await currentLang());");
        expect(src).not.toContain("currentLangFor(");
        if (p.slug !== "billing") expect(src).not.toContain("auth.getUser()");
      } else {
        // The page's own session read hands its id over: one cached profile row, no second getUser.
        expect(src).toContain('import { currentLangFor } from "@/lib/current-lang";');
        expect(src).toMatch(/const t = translator\(await currentLangFor\((user\?\.id|userId)\)\);/);
        expect(src).not.toContain("currentLang()");
        expect(src.search(/auth\.getUser\(\)|await requireStaff\(\)/)).toBeLessThan(src.indexOf("await currentLangFor("));
      }
      expect(src).toContain(`title={t("nv_page_${p.slug}")}`);
      expect(src).toContain(`description={t("nv_desc_${p.slug}")}`);
      expect(src).not.toContain(`title="${p.title}"`);
      expect(src).not.toContain(`description="${p.desc}"`);
      // ONE profile read per request: the language comes from lib/current-lang's cached row, never a second query for it.
      expect(src).not.toMatch(/select\("[^"]*\blanguage\b[^"]*"\)/);
    });
  }

  it("Pay's two headers (the failed-read screen and the ledger) both read the one key", () => {
    expect(read("payroll/page.tsx").split('<PageHeader title={t("nv_page_pay")} description={t("nv_desc_pay")} />').length - 1).toBe(2);
  });

  it("renders: es shows the Spanish title; en is byte for byte the header the page carried before", () => {
    for (const p of PAGES) {
      const esText = text(header(es, p.slug));
      expect(esText, p.slug).toContain(p.es);
      expect(esText, p.slug).not.toContain(p.title);
      expect(header(en, p.slug), p.slug).toBe(literal(p.title, p.desc));
    }
  });
});

describe("Estimates / Quotes: the one computed heading and its line", () => {
  it("the page picks nv_page_quotes with ?type=quote and nv_page_estimates otherwise, and the matching line", () => {
    const src = read("quotes/page.tsx");
    expect(src).toContain("const t = translator(await currentLangFor(user?.id));");
    expect(src).not.toContain("currentLang()");
    expect(src).toContain('const heading = filter === "quote" ? t("nv_page_quotes") : t("nv_page_estimates");');
    expect(src).toContain('<PageHeader title={heading} description={filter === "quote" ? t("nv_desc_quotes") : t("nv_desc_estimates")}>');
    expect(src).not.toContain('"Quotes" : "Estimates"');
    expect(src).not.toContain('description="Estimates are time-&-materials');
  });

  it("renders Presupuestos / Cotizaciones in es; en byte for byte under both headings", () => {
    expect(text(header(es, "estimates"))).toContain("Presupuestos");
    expect(text(header(es, "quotes"))).toContain("Cotizaciones");
    const line = "Estimates are time-&-materials by default — switch any one to a fixed-price quote.";
    expect(header(en, "estimates")).toBe(literal("Estimates", line));
    expect(header(en, "quotes")).toBe(literal("Quotes", line));
  });
});

describe("Price List: the two-part line", () => {
  it("the page joins nv_desc_priceList, the vendors tail and the what-a-vendor-is tail with single spaces, as the literal did", () => {
    const src = read("price-list/page.tsx");
    // No id in scope on this page: the no-id door.
    expect(src).toContain("const t = translator(await currentLang());");
    expect(src).not.toContain("auth.getUser()");
    expect(src).toContain('title={t("nv_page_priceList")}');
    expect(src).toContain('t("nv_desc_priceList") +');
    expect(src).toContain('(optionsAvailable ? ` ${t("nv_desc_priceListVendors")} ${t("nv_desc_priceListVendorsMeans")}` : "")');
    expect(src).not.toContain("${VENDOR_MEANS}");
    expect(src).not.toContain("import { VENDOR_MEANS");
    expect(src).not.toContain('title="Price List"');
  });

  it("the Vendors-on branch, rendered: en is byte for byte the header the page carried; es carries no English", () => {
    const vendorsOn = (t: (k: string) => string) => t("nv_desc_priceList") + ` ${t("nv_desc_priceListVendors")} ${t("nv_desc_priceListVendorsMeans")}`;
    const old =
      "Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier's list via CSV. Click any item to give it vendors, each with its own cost and sell. A vendor is anyone you buy from or hire: a supplier, a sub, or a brand.";
    expect(renderToStaticMarkup(createElement(PageHeader, { title: en("nv_page_priceList"), description: vendorsOn(en) }))).toBe(literal("Price List", old));
    const esHtml = text(renderToStaticMarkup(createElement(PageHeader, { title: es("nv_page_priceList"), description: vendorsOn(es) })));
    expect(esHtml).toContain("Lista De Precios");
    expect(esHtml).toContain("una casa de materiales, un subcontratista o una marca.");
    expect(esHtml).not.toMatch(/\b(vendor|supplier|brand|Price List|markup)\b/);
  });

  it("en: the joined line is byte for byte the old literal (its tail IS VENDOR_MEANS); es: Lista De Precios, all three parts Spanish", () => {
    expect(en("nv_desc_priceListVendorsMeans")).toBe(VENDOR_MEANS);
    const joined = (t: (k: string) => string) => t("nv_desc_priceList") + ` ${t("nv_desc_priceListVendors")} ${t("nv_desc_priceListVendorsMeans")}`;
    expect(joined(en)).toBe(
      "Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier's list via CSV. Click any item to give it vendors, each with its own cost and sell. " +
        VENDOR_MEANS,
    );
    expect(text(header(es, "priceList"))).toContain("Lista De Precios");
    expect(joined(es)).toContain("Tu catálogo con precios");
    expect(joined(es)).toContain("Toca cualquier artículo");
    // The Spanish line no longer ends in English: the what-a-vendor-is tail is the catalog's.
    expect(joined(es)).toMatch(/ Un proveedor es cualquiera a quien le compras o contratas: una casa de materiales, un subcontratista o una marca\.$/);
    expect(joined(es)).not.toContain(VENDOR_MEANS);
    expect(joined(es)).not.toMatch(/\b(vendor|supplier|brand)\b/);
    expect(header(en, "priceList")).toBe(
      literal("Price List", "Your priced catalog and reusable kits — cost, markup and sell, ready for estimates. Import a supplier's list via CSV."),
    );
  });
});

describe("the schedule's two headings", () => {
  it("Waiting For A Day reads nv_sched_waitingForADay beside its count, from currentLangFor(user?.id)", () => {
    const src = read("schedule/page.tsx");
    expect(src).toContain('import { currentLangFor } from "@/lib/current-lang";');
    expect(src).toContain("const t = translator(await currentLangFor(user?.id));");
    expect(src).not.toContain("currentLang()");
    expect(src).toContain('{t("nv_sched_waitingForADay")} <span className="font-normal text-slate-400">({waiting.length}{railCapped ? "+" : ""})</span>');
    expect(src).not.toContain("Waiting For A Day <span");
    expect(en("nv_sched_waitingForADay")).toBe("Waiting For A Day");
    expect(es("nv_sched_waitingForADay")).toBe("Esperando Un Día");
  });

  it("Everyone's Day: the crew board (a client component) reads useLang(); es draws El Día De Todos, en Everyone's Day as before", () => {
    const unassigned: Lane = { id: "__unassigned__", name: "Unassigned", jobs: [], appts: [], decision: null, scheduledJobId: null, scheduledLabel: null };
    const board = (lang: "en" | "es") =>
      renderToStaticMarkup(
        // Children go in createElement's third argument (react/no-children-prop); the props cast the way row-more-sheet.test.ts does.
        createElement(
          LangProvider,
          { lang } as Parameters<typeof LangProvider>[0],
          createElement(CrewBoard, {
            day: "2026-10-29",
            dayLabel: "Thu, Oct 29",
            isToday: true,
            prevHref: "/schedule?view=crew&date=2026-10-28",
            nextHref: "/schedule?view=crew&date=2026-10-30",
            todayHref: "/schedule?view=crew",
            lanes: [],
            unassigned,
            canEdit: false,
            jobOptions: [],
            offToday: [],
          }),
        ),
      );
    expect(board("en")).toContain('<h1 class="text-lg font-bold tracking-tight text-slate-900">Everyone&#x27;s Day</h1>');
    expect(board("es")).toContain('<h1 class="text-lg font-bold tracking-tight text-slate-900">El Día De Todos</h1>');
    // The Calendar back-link beside it (nv_sched_calendar): en byte for byte the "</svg> Calendar</a>" the board drew before the key.
    expect(board("en")).toContain('<path d="m15 18-6-6 6-6"></path></svg> Calendar</a><h1 class="text-lg font-bold tracking-tight text-slate-900">Everyone&#x27;s Day</h1>');
    expect(board("es")).toContain('</svg> Calendario</a><h1 class="text-lg font-bold tracking-tight text-slate-900">El Día De Todos</h1>');
    expect(board("es")).not.toContain("> Calendar<");
    const src = read("schedule/crew-board.tsx");
    expect(src).toContain('import { useLang } from "@/components/lang-provider";');
    expect(src).toContain("const t = translator(useLang());");
    expect(src).toContain('{t("nv_sched_everyonesDay")}</h1>');
    expect(src).not.toContain("Everyone&apos;s Day");
  });
});
