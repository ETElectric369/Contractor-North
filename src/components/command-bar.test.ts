import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { commandNavItems } from "./command-bar";
import { ALL_ON, type FeatureMap } from "@/lib/features";

/**
 * THE COMMAND BAR AND THE SWITCH BOARD (0352). Its "go to" list is built from the same dock filter
 * (lib/dock visibleDock), and a word that belongs to a switch leaves with it.
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const hrefs = (items: ReturnType<typeof commandNavItems>) => items.map((i) => i.href);
const find = (items: ReturnType<typeof commandNavItems>, href: string) => items.find((i) => i.href === href);

describe("commandNavItems", () => {
  it("everything on: the same pages and words as before, staff and tech", () => {
    const staff = commandNavItems(true, ALL_ON);
    expect(hrefs(staff)).toEqual(hrefs(commandNavItems(true)));
    expect(hrefs(staff)).toEqual(expect.arrayContaining(["/leads", "/quotes", "/quotes/new", "/payroll", "/inventory", "/tools"]));
    expect(find(staff, "/bills")?.aliases).toEqual(expect.arrayContaining(["purchase order", "po", "vendor"]));
    expect(find(staff, "/price-list")?.aliases).toEqual(expect.arrayContaining(["kit", "kits", "pricing"]));
    expect(find(staff, "/recurring")?.aliases).toEqual(["subscription", "repeat invoice", "auto invoice"]);
    expect(find(staff, "/bills")?.label).toBe("Bills & POs");
  });

  it("Recurring Billing off: Recurring stays (repeat jobs and expenses), only the invoice words go", () => {
    const rec = find(commandNavItems(true, off("recurring_billing")), "/recurring");
    expect(rec).toBeDefined();
    expect(rec?.aliases ?? []).not.toContain("repeat invoice");
  });

  it("a tech is never offered a staff page, switches or not", () => {
    for (const f of [ALL_ON, off("leads"), off("calculators")]) {
      const tech = commandNavItems(false, f);
      expect(tech.some((i) => i.staffOnly)).toBe(false);
      expect(hrefs(tech)).not.toContain("/payroll");
      expect(hrefs(tech)).not.toContain("/quotes/new");
    }
  });

  it("Leads off: /leads and /inspections (and their words) go", () => {
    const items = commandNavItems(true, off("leads"));
    expect(hrefs(items)).not.toContain("/leads");
    expect(hrefs(items)).not.toContain("/inspections");
    expect(items.some((i) => i.aliases?.includes("prospects"))).toBe(false);
  });

  it("Estimates off: Estimates and New Estimate (with its plan/take-off words) go", () => {
    const items = commandNavItems(true, off("estimates"));
    expect(hrefs(items)).not.toContain("/quotes");
    expect(hrefs(items)).not.toContain("/quotes/new");
    expect(items.some((i) => i.aliases?.includes("blueprint"))).toBe(false);
  });

  it("Purchase Orders off: Bills stays, reads Bills, and 'purchase order' / 'po' no longer find it", () => {
    const bills = find(commandNavItems(true, off("purchase_orders")), "/bills");
    expect(bills?.label).toBe("Bills");
    expect(bills?.aliases).not.toContain("po");
    expect(bills?.aliases).not.toContain("purchase order");
    expect(bills?.aliases).toContain("vendor");
  });

  it("Kits off: Price List stays; 'kit' and 'kits' no longer find it", () => {
    const pl = find(commandNavItems(true, off("kits")), "/price-list");
    expect(pl).toBeDefined();
    expect(pl?.aliases).not.toContain("kit");
    expect(pl?.aliases).not.toContain("kits");
    // A sub-switch is off while its parent is: Estimates off takes the kit words too.
    expect(find(commandNavItems(true, off("estimates")), "/price-list")?.aliases).not.toContain("kits");
  });

  it("Reminders and Organize are found by name now Today is My Day alone: a tech gets Reminders, not Organize", () => {
    const staff = commandNavItems(true, ALL_ON);
    const tech = commandNavItems(false, ALL_ON);
    expect(find(staff, "/tasks")).toMatchObject({ label: "Reminders", sub: "Today" });
    expect(find(staff, "/organize")).toMatchObject({ label: "Organize", sub: "Today" });
    expect(find(tech, "/tasks")).toMatchObject({ label: "Reminders", sub: "Today" });
    expect(find(tech, "/organize")).toBeUndefined();
    // The old word still finds the Reminders page.
    expect(find(tech, "/tasks")?.aliases).toContain("tasks");
  });

  it("each page is offered once: /handbook once for a tech (under You) and once for staff (Office)", () => {
    for (const isStaff of [true, false]) {
      const items = commandNavItems(isStaff, ALL_ON);
      expect(items.filter((i) => i.href === "/handbook"), String(isStaff)).toHaveLength(1);
      expect(items.filter((i) => i.href === "/crm"), String(isStaff)).toHaveLength(isStaff ? 1 : 0);
    }
    expect(find(commandNavItems(false, ALL_ON), "/handbook")?.sub).toBe("You");
    expect(find(commandNavItems(true, ALL_ON), "/crm")).toMatchObject({ label: "Customers", sub: "Sales" });
    // Office and Tools live behind the initials, but search still finds their pages.
    expect(hrefs(commandNavItems(true, ALL_ON))).toEqual(expect.arrayContaining(["/team", "/inventory", "/tools"]));
  });

  it("Shop Stock, Crew & Payroll, Licenses, Calculators off: their pages go", () => {
    const items = commandNavItems(true, off("shop_stock", "crew_payroll", "licenses", "calculators"));
    for (const h of ["/inventory", "/payroll", "/employee-docs", "/handbook", "/compliance", "/insurance", "/safety", "/audits", "/tools"])
      expect(hrefs(items), h).not.toContain(h);
    // Never a Sales Tax door: the Tax Report carries the mileage deduction.
    expect(hrefs(commandNavItems(true, off("sales_tax")))).toContain("/tax-report");
  });
});
