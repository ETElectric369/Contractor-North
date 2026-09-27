import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn(() => calls.order.push("unlockAudio")) }));

import { commandNavItems, idleRows } from "./command-bar";
import { ALL_ON, type FeatureMap } from "@/lib/features";
import { isApplePlatform, modKeyLabel } from "@/lib/mod-key";
import { NORT_TALK_EVENT, SETUP_EVENT } from "@/lib/onboarding/help-rows";

const barSrc = readFileSync(join(process.cwd(), "src/components/command-bar.tsx"), "utf8");

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

/**
 * THE KEYBOARD LINE (W1-12): "↑↓ to navigate · ↵ to open · esc to close" names keys a phone
 * doesn't have, so the footer shows only with a mouse or a trackpad (Tailwind's pointer-fine
 * variant, never a width breakpoint: an iPad and a laptop can be the same width), and its chip
 * names this computer's shortcut.
 */
describe("the command bar's footer", () => {
  it("is hidden until a fine pointer (mouse or trackpad) is there", () => {
    const footer = barSrc.slice(barSrc.indexOf("↑↓ to navigate") - 400, barSrc.indexOf("↑↓ to navigate"));
    const cls = footer.slice(footer.lastIndexOf('className="') + 11, footer.lastIndexOf('">'));
    expect(cls.startsWith("hidden pointer-fine:flex")).toBe(true);
    expect(cls).not.toMatch(/\b(sm|md|lg|xl):flex\b/);
  });

  it("names ⌘K on Apple devices and Ctrl K elsewhere", () => {
    expect(barSrc).toContain("{modKeyLabel(isApplePlatform())}");
    expect(modKeyLabel(isApplePlatform({ platform: "MacIntel" }))).toBe("⌘K");
    expect(modKeyLabel(isApplePlatform({ userAgentData: { platform: "macOS" } }))).toBe("⌘K");
    expect(modKeyLabel(isApplePlatform({ platform: "iPad" }))).toBe("⌘K");
    expect(modKeyLabel(isApplePlatform({ platform: "Win32" }))).toBe("Ctrl K");
    expect(modKeyLabel(isApplePlatform({ userAgentData: { platform: "Linux" }, platform: "Linux x86_64" }))).toBe("Ctrl K");
    expect(modKeyLabel(isApplePlatform({ platform: "", userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" }))).toBe("Ctrl K");
  });

  it("keeps ⌘K where nothing can be read (the server, an empty navigator): what it said before", () => {
    expect(isApplePlatform({})).toBe(true);
  });

  it("keeps its keys and its empty line", () => {
    expect(barSrc).toContain('e.key === "ArrowDown"');
    expect(barSrc).toContain('e.key === "Enter"');
    expect(barSrc).toContain('e.key === "Escape"');
    expect(barSrc).toContain('"No matches. Press Enter to ask Nort."');
  });
});

/**
 * SEARCH OR ASK, NOTHING TYPED (W1-09): Talk To Nort first (Nort on), then — for staff — the rows
 * the graduation cap held. Nort off, none of them: the setup rows sit under Help in the avatar menu.
 */
describe("Search Or Ask's rows before anything is typed", () => {
  const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };
  const labels = (rows: ReturnType<typeof idleRows>) => rows.map((r) => r.label);

  it("Nort on, staff never walked through: Talk To Nort, Start Here, Show Me How, Take The Setup Again", () => {
    expect(labels(idleRows({ isStaff: true, features: ALL_ON, setup: {}, onboarded: false }))).toEqual([
      "Talk To Nort", "Start Here", "Show Me How", "Take The Setup Again",
    ]);
  });

  it("walked through, two setup questions still open: Finish Setting Up · 2 Left", () => {
    const rows = idleRows({ isStaff: true, features: ALL_ON, setup: { ...DONE, service_area: null, labor_rate: null }, onboarded: true });
    expect(labels(rows)).toEqual(["Talk To Nort", "Finish Setting Up · 2 Left", "Show Me How", "Take The Setup Again"]);
  });

  it("walked through, nothing open: no Start Here and no Finish row", () => {
    expect(labels(idleRows({ isStaff: true, features: ALL_ON, setup: DONE, onboarded: true }))).toEqual([
      "Talk To Nort", "Show Me How", "Take The Setup Again",
    ]);
  });

  it("a tech: Talk To Nort only — no setup rows", () => {
    expect(labels(idleRows({ isStaff: false, features: ALL_ON, setup: {}, onboarded: false }))).toEqual(["Talk To Nort"]);
  });

  it("Nort off: nothing here (Search only; the setup rows live under Help, behind the initials)", () => {
    expect(idleRows({ isStaff: true, features: off("nort"), setup: {}, onboarded: false })).toEqual([]);
    expect(barSrc).toContain('placeholder={nortOn ? "Search or ask Nort…"');
  });

  it("Show Me How folds its lessons open under it, and lists only lessons whose switch is on", () => {
    const open = labels(idleRows({ isStaff: true, features: ALL_ON, setup: DONE, onboarded: true, lessonsOpen: true }));
    expect(open).toEqual(["Talk To Nort", "Show Me How", "Why Lines", "Getting Around", "How a Job Runs", "Take The Setup Again"]);
    const noSales = labels(idleRows({ isStaff: true, features: off("leads", "estimates"), setup: DONE, onboarded: true, lessonsOpen: true }));
    expect(noSales).not.toContain("Why Lines");
    // Its own row keeps the sheet open (it only folds) and says which way it's folded.
    const show = idleRows({ isStaff: true, features: ALL_ON, setup: DONE, onboarded: true }).find((r) => r.label === "Show Me How")!;
    expect(show).toMatchObject({ keepOpen: true, expanded: false });
  });
});

describe("a doing row runs inside the tap that picked it", () => {
  let target: EventTarget;
  beforeEach(() => {
    target = new EventTarget();
    vi.stubGlobal("window", target);
    calls.order = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Talk To Nort dispatches cn:nort-talk SYNCHRONOUSLY: the listener has run before run() returns", () => {
    let heard = false;
    target.addEventListener(NORT_TALK_EVENT, () => (heard = true));
    const talk = idleRows({ isStaff: false, features: ALL_ON, onboarded: true })[0];
    expect(talk.label).toBe("Talk To Nort");
    talk.run!();
    // No await between: if dispatching were deferred (a timer, a promise), this would still be false,
    // and on an iPhone the mic would start outside the gesture and never open.
    expect(heard).toBe(true);
  });

  it("the palette's go() runs a doing row first, before closing the sheet or anything asynchronous", () => {
    const go = barSrc.slice(barSrc.indexOf("function go(item: Item)"), barSrc.indexOf("if (!open) return null;"));
    const runAt = go.indexOf("item.run();");
    expect(runAt).toBeGreaterThan(-1);
    expect(runAt).toBeLessThan(go.indexOf("setOpen(false)"));
    expect(go.slice(0, runAt)).not.toMatch(/await|setTimeout|then\(/);
    // A row's click and Enter both go through go().
    expect(barSrc).toContain("onClick={() => go(it)}");
    expect(barSrc).toContain("if (it) go(it);");
  });

  it("every help row unlocks audio INSIDE the tap, then asks the setup host (cn:setup)", () => {
    const heard: string[] = [];
    target.addEventListener(SETUP_EVENT, (e) => {
      calls.order.push("dispatch");
      heard.push((e as CustomEvent<string>).detail);
    });
    const rows = idleRows({ isStaff: true, features: ALL_ON, setup: {}, onboarded: false, lessonsOpen: true }).filter((r) => r.kind === "Help" && !r.keepOpen);
    for (const r of rows) r.run!();
    expect(heard).toEqual(["tour", "lesson:why-lines", "lesson:getting-around", "lesson:how-a-job-runs", "tour"]);
    // Unlock, dispatch — per row, in that order, every time.
    expect(calls.order).toEqual(rows.flatMap(() => ["unlockAudio", "dispatch"]));
  });

  it("with Nort off Start Here and Take The Setup Again open the questions (no tour: the tour is Nort talking)", async () => {
    const { helpRows } = await import("@/lib/onboarding/help-rows");
    const rows = helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: false, features: off("nort") });
    expect(rows.flatMap((r) => ("request" in r ? [`${r.label}=${r.request}`] : [r.label]))).toEqual([
      "Start Here=questions", "Show Me How", "Take The Setup Again=questions",
    ]);
  });
});
