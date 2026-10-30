import { describe, it, expect } from "vitest";
import { words as nav } from "@/lib/words/nav";
import { words as shell } from "@/lib/words/shell";

/**
 * ONE SPANISH WORD PER ENGLISH WORD, ACROSS THE MAP (cn-v1139). A page's title and the dock row
 * that opens it are the same English ("Invoices", "Price List", "Shop Stock"), so they must be the
 * same Spanish: a person who tapped Facturas lands on a page headed Facturas, never Facturación.
 * The rule is checked over the whole shell (sh_: the dock's tiles, rows and variants, Search Or
 * Ask's own rows, the account menu) against every nv_ title, verb, cluster and role — case-folded,
 * because four page titles are not Title Case in English today ("Tax report" is the dock's "Tax
 * Report"). A nv_desc_ is a sentence and is not compared.
 */
const fold = (s: string) => s.trim().toLowerCase();

describe("a nav title's Spanish is its dock row's Spanish", () => {
  const shellByEnglish = new Map<string, { key: string; es: string }[]>();
  for (const [k, en] of Object.entries(shell.en)) {
    const list = shellByEnglish.get(fold(en)) ?? [];
    list.push({ key: k, es: shell.es[k] });
    shellByEnglish.set(fold(en), list);
  }

  const navKeys = Object.keys(nav.en).filter((k) => !k.startsWith("nv_desc_"));

  it("every nv_ word whose English is a sh_ word's English carries that word's Spanish", () => {
    const mismatches: string[] = [];
    let matched = 0;
    for (const k of navKeys) {
      const twins = shellByEnglish.get(fold(nav.en[k]));
      if (!twins) continue;
      matched++;
      for (const twin of twins) {
        if (fold(twin.es) !== fold(nav.es[k])) mismatches.push(`${k} "${nav.en[k]}" → "${nav.es[k]}" but ${twin.key} → "${twin.es}"`);
      }
    }
    // The pairs the rule is for: at least the dock's own pages.
    expect(matched).toBeGreaterThanOrEqual(24);
    expect(mismatches, "a page title and its dock row must read the same Spanish").toEqual([]);
  });

  it("the pairs a person walks through every day", () => {
    const pairs: [string, string][] = [
      ["nv_page_billing", "sh_dock_m-inv"],
      ["nv_page_priceList", "sh_dock_m-price"],
      ["nv_page_inventory", "sh_dock_ma-stock"],
      ["nv_page_timecards", "sh_dock_ck-cards"],
      ["nv_page_crm", "sh_dock_sl-customers"],
      ["nv_page_leads", "sh_dock_sl-leads"],
      ["nv_page_estimates", "sh_dock_sl-quotes"],
      ["nv_page_reconcile", "sh_dock_m-recon"],
      ["nv_page_taxReport", "sh_dock_ma-tax"],
      ["nv_page_audit", "sh_dock_o-audit"],
      ["nv_page_bills", "sh_dock_m-bills_off"],
      ["nv_page_settings", "sh_dock_settings"],
      ["nv_page_quotesNew", "sh_newEstimate"],
      ["nv_page_pettyCash", "sh_pettyCash"],
      ["nv_set_money", "sh_dock_invoices"],
      ["nv_role_office", "sh_dock_office"],
    ];
    for (const [n, s] of pairs) {
      expect(fold(nav.en[n]), `${n} / ${s} English`).toBe(fold(shell.en[s]));
      expect(nav.es[n], `${n} / ${s} Spanish`).toBe(shell.es[s]);
    }
  });

  it("a page title not on the dock still follows the glossary: Manual Del Empleado for the Handbook page, Documentos Del Empleado for Employee Docs (Employee = Empleado, one word)", () => {
    expect(nav.es.nv_page_handbook).toBe("Manual Del Empleado");
    expect(shell.es["sh_dock_o-handbook"]).toBe("Manual");
    expect(nav.es.nv_page_employeeDocs).toBe("Documentos Del Empleado");
    expect(shell.es["sh_dock_o-docs"]).toBe("Documentos Del Empleado");
    expect(nav.es.nv_page_safety).toBe("Seguridad / OSHA");
    expect(shell.es["sh_dock_o-safety"]).toBe("Seguridad");
  });
});
