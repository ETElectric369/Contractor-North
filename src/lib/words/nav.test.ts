import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { words as nav } from "./nav";
import { SETTINGS_CLUSTER_KEYS, ROLE_KEYS } from "@/lib/settings-words";
import { VENDOR_MEANS } from "@/lib/vendor-words";

/**
 * THE OFFICE'S MAP CATALOG (nv_, cn-v1139): every page title has its line, the + menu's verbs are
 * the rows' keys, the Settings clusters and the roles are the maps' keys, and the English of every
 * title and line is BYTE FOR BYTE the literal its page carries — or, once a builder has wired the
 * page, the page reads that key. The files list is narrow on purpose: never an office page.
 */
const ROOT = process.cwd();
const src = (f: string) => readFileSync(join(ROOT, "src/app/(app)", f), "utf8");
const keys = Object.keys(nav.en);
const slugOf = (k: string, prefix: string) => k.slice(prefix.length);

/** Each page's file, by its slug. */
const PAGE_FILES: Record<string, string> = {
  leads: "leads/page.tsx",
  crm: "crm/page.tsx",
  inspections: "inspections/page.tsx",
  billing: "billing/page.tsx",
  bills: "bills/page.tsx",
  reconcile: "reconcile/page.tsx",
  priceList: "price-list/page.tsx",
  pay: "payroll/page.tsx",
  taxReport: "tax-report/page.tsx",
  analytics: "analytics/page.tsx",
  recurring: "recurring/page.tsx",
  timecards: "timecards/page.tsx",
  compliance: "compliance/page.tsx",
  insurance: "insurance/page.tsx",
  safety: "safety/page.tsx",
  audits: "audits/page.tsx",
  team: "team/page.tsx",
  employeeDocs: "employee-docs/page.tsx",
  forms: "forms/page.tsx",
  resources: "resources/page.tsx",
  handbook: "handbook/page.tsx",
  inventory: "inventory/page.tsx",
  activity: "activity/page.tsx",
  audit: "audit/page.tsx",
  tools: "tools/page.tsx",
  settings: "settings/page.tsx",
  accountant: "analytics/accountant/page.tsx",
  organize: "organize/page.tsx",
  pettyCash: "petty-cash/page.tsx",
  quotesNew: "quotes/new/page.tsx",
  quotes: "quotes/page.tsx",
  estimates: "quotes/page.tsx",
};

/** The page carries the literal, or reads the key: either way the words on screen are the catalog's English. */
const carries = (source: string, literal: string, key: string) => source.includes(literal) || source.includes(`t("${key}")`);

describe("the nav catalog", () => {
  it("is nv_, and names only the + menu, the Settings side-tab and the PageHeader component — never an office page", () => {
    expect(nav.prefix).toBe("nv_");
    expect([...nav.files].sort()).toEqual(["src/app/(app)/settings/settings-subnav.tsx", "src/components/global-quick-add.tsx", "src/components/page-header.tsx"]);
    for (const f of nav.files) expect(f).not.toMatch(/\/page\.tsx$/);
    expect(nav.sameInBoth).toEqual([]);
  });

  it("every nv_page_ key has its nv_desc_ line, and every line (bar the two slots' partners) its page", () => {
    const pages = keys.filter((k) => k.startsWith("nv_page_")).map((k) => slugOf(k, "nv_page_"));
    const descs = keys.filter((k) => k.startsWith("nv_desc_")).map((k) => slugOf(k, "nv_desc_"));
    expect(pages.length).toBeGreaterThanOrEqual(32);
    for (const s of pages) expect(descs, `nv_desc_${s}`).toContain(s);
    // A line with no page of its own: the vendors tail of the price list's line, its "what a vendor is" tail, and the handbook's stand-in company.
    for (const s of descs) if (!["priceListVendors", "priceListVendorsMeans", "handbookCompany"].includes(s)) expect(pages, `nv_page_${s}`).toContain(s);
    expect(Object.keys(PAGE_FILES).sort()).toEqual(pages.sort());
  });

  it("the English of every title and line is the page's own literal, byte for byte (or the page reads the key)", () => {
    for (const [slug, file] of Object.entries(PAGE_FILES)) {
      const source = src(file);
      const title = nav.en[`nv_page_${slug}`];
      const titleOk =
        slug === "quotes" || slug === "estimates"
          ? source.includes('filter === "quote" ? "Quotes" : "Estimates"') || source.includes(`t("nv_page_${slug}")`)
          : carries(source, `title="${title}"`, `nv_page_${slug}`);
      expect(titleOk, `${file} should carry title "${title}" or t("nv_page_${slug}")`).toBe(true);
      const desc = nav.en[`nv_desc_${slug}`];
      const descOk =
        slug === "priceList"
          ? carries(source, `"${desc}"`, "nv_desc_priceList")
          : slug === "handbook"
            ? carries(source, "Policies and expectations at ${", "nv_desc_handbook")
            : slug === "estimates"
              ? carries(source, `description="${desc}"`, "nv_desc_quotes") || source.includes('t("nv_desc_estimates")')
              : carries(source, `description="${desc}"`, `nv_desc_${slug}`);
      expect(descOk, `${file} should carry description "${desc}" or t("nv_desc_${slug}")`).toBe(true);
    }
    // The price list's vendors tail and the handbook's stand-in.
    expect(carries(src("price-list/page.tsx"), "Click any item to give it vendors, each with its own cost and sell.", "nv_desc_priceListVendors")).toBe(true);
    // What a vendor is: the catalog's English is byte for byte lib/vendor-words' VENDOR_MEANS (every vendor box's help), and the page reads the key, not the constant.
    expect(nav.en.nv_desc_priceListVendorsMeans).toBe(VENDOR_MEANS);
    expect(src("price-list/page.tsx")).toContain('t("nv_desc_priceListVendorsMeans")');
    expect(src("price-list/page.tsx")).not.toContain("${VENDOR_MEANS}");
    expect(src("price-list/page.tsx")).not.toContain("import { VENDOR_MEANS");
    expect(carries(src("handbook/page.tsx"), '"the company"', "nv_desc_handbookCompany")).toBe(true);
    // The schedule's two headings.
    expect(carries(src("schedule/crew-board.tsx"), "Everyone&apos;s Day", "nv_sched_everyonesDay")).toBe(true);
    expect(nav.en.nv_sched_everyonesDay).toBe("Everyone's Day");
    expect(carries(src("schedule/page.tsx"), "Waiting For A Day", "nv_sched_waitingForADay")).toBe(true);
    // The Calendar back-link beside both headings.
    expect(nav.en.nv_sched_calendar).toBe("Calendar");
    expect(nav.es.nv_sched_calendar).toBe("Calendario");
    for (const f of ["schedule/crew-board.tsx", "schedule/page.tsx"]) {
      expect(src(f)).toContain('<ChevronLeft className="h-4 w-4 shrink-0" /> {t("nv_sched_calendar")}');
      expect(src(f)).not.toContain("> Calendar\n");
    }
  });

  it("the + menu's six verbs are the rows' keys, in the rows' order", () => {
    const source = readFileSync(join(ROOT, "src/components/global-quick-add.tsx"), "utf8");
    const rowKeys = [...source.matchAll(/\{ key: "(nv_add_\w+)", href:/g)].map((m) => m[1]);
    expect(rowKeys).toEqual(["nv_add_newLead", "nv_add_newJob", "nv_add_newAppointment", "nv_add_newInspection", "nv_add_newEstimate", "nv_add_newInvoice"]);
    for (const k of rowKeys) expect(nav.en[k], k).toMatch(/^New /);
    expect(keys.filter((k) => k.startsWith("nv_add_")).sort()).toEqual([...rowKeys, "nv_add_noSignal", "nv_add_stillSendingMany", "nv_add_stillSendingOne"].sort());
    for (const k of ["nv_add_noSignal", "nv_add_stillSendingOne", "nv_add_stillSendingMany"]) for (const lang of ["en", "es"] as const) expect(nav[lang][k]).toContain("{label}");
    expect(nav.en.nv_add_stillSendingMany).toContain("{n}");
    expect(nav.es.nv_add_stillSendingMany).toContain("{n}");
  });

  it("the Settings clusters' keys are the map's (You reads the shell's sh_you), and the four roles are nv_role_", () => {
    const setKeys = keys.filter((k) => k.startsWith("nv_set_")).sort();
    expect(setKeys).toEqual(Object.values(SETTINGS_CLUSTER_KEYS).filter((k) => k.startsWith("nv_")).sort());
    expect(SETTINGS_CLUSTER_KEYS.you).toBe("sh_you");
    expect(keys.filter((k) => k.startsWith("nv_role_")).sort()).toEqual(Object.values(ROLE_KEYS).sort());
    expect(Object.keys(ROLE_KEYS).sort()).toEqual(["admin", "office", "owner", "tech"]);
  });

  it("every key is one of the families the catalog documents", () => {
    for (const k of keys) expect(k, k).toMatch(/^nv_(page|desc|sched|add|set|role)_/);
  });
});
