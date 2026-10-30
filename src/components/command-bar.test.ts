import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/tts", () => ({ unlockAudio: vi.fn(() => calls.order.push("unlockAudio")) }));

import { commandNavItems, foldSearch, idleRows, kindWords, matchNavItems } from "./command-bar";
import { translator } from "@/lib/i18n";
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
    // The page's own words first, then the switch's, in both languages (cn-v1139).
    expect(find(staff, "/recurring")?.aliases).toEqual(["recurrentes", "recurrente", "repetir", "subscription", "repeat invoice", "auto invoice", "suscripción", "factura repetida"]);
    expect(find(staff, "/bills")?.label).toBe("Bills & POs");
  });

  it("lapsed (skeptic #43, S1): the three open doors alone — for staff and tech, whatever the switches — and the accountant's export is found by name", () => {
    for (const isStaff of [true, false]) {
      const items = commandNavItems(isStaff, ALL_ON, true, true);
      // The lapsed dock's fourth row, Download Everything (/settings?tab=getpaid, cn-v1138), carries a
      // ?query like every status row and stays out of the palette; Settings is its door here.
      expect(hrefs(items), String(isStaff)).toEqual(["/subscribe", "/settings", "/analytics/accountant"]);
      expect(items.map((i) => i.label)).toEqual(["Pick A Plan", "Settings", "Download For Your Accountant"]);
      expect(commandNavItems(isStaff, ALL_ON, true, true, "es").map((i) => i.label)).toEqual(["Elegir Un Plan", "Ajustes", "Descargar Para Tu Contador"]);
      expect(hrefs(matchNavItems(items, "accountant"))).toEqual(["/analytics/accountant"]);
      expect(hrefs(matchNavItems(items, "jobs"))).toEqual([]);
    }
    // The default is not lapsed.
    expect(hrefs(commandNavItems(true, ALL_ON, true))).toEqual(hrefs(commandNavItems(true, ALL_ON, true, false)));
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

  it("the Timeclock is still found by staff (their Clock tile went) and once for a tech, from his Clock tile", () => {
    const staff = commandNavItems(true, ALL_ON);
    const tech = commandNavItems(false, ALL_ON);
    for (const term of ["clock in", "punch", "timeclock", "clock"]) {
      expect(hrefs(matchNavItems(staff, term)), term).toContain("/timeclock");
      expect(hrefs(matchNavItems(tech, term)), term).toContain("/timeclock");
    }
    expect(staff.filter((i) => i.href === "/timeclock")).toHaveLength(1);
    expect(find(staff, "/timeclock")).toMatchObject({ label: "Time Clock", sub: "Money" });
    expect(tech.filter((i) => i.href === "/timeclock")).toHaveLength(1);
    expect(find(tech, "/timeclock")).toMatchObject({ label: "Time Clock", sub: "Clock" });
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

  it("Accounts Receivable's and Payments' words find Invoices now (W1-29); their old routes are no rows", () => {
    const staff = commandNavItems(true, ALL_ON);
    expect(hrefs(staff)).not.toContain("/billing/ar");
    expect(hrefs(staff)).not.toContain("/payments");
    for (const term of ["owed", "who owes", "aging", "paid", "received", "deposit", "collections", "accounts receivable", "payments"]) {
      expect(hrefs(matchNavItems(staff, term)), term).toContain("/billing");
    }
    expect(find(staff, "/billing")).toMatchObject({ label: "Invoices", sub: "Money" });
  });

  it("Petty Cash left the menu (W1-34): no row by default, one row with its words for a company that has petty cash", () => {
    for (const isStaff of [true, false]) expect(hrefs(commandNavItems(isStaff, ALL_ON)), String(isStaff)).not.toContain("/petty-cash");
    const withCash = commandNavItems(true, ALL_ON, true);
    expect(withCash.filter((i) => i.href === "/petty-cash")).toHaveLength(1);
    expect(find(withCash, "/petty-cash")).toMatchObject({ label: "Petty Cash", sub: "Money" });
    expect(find(withCash, "/petty-cash")?.aliases).toEqual(expect.arrayContaining(["petty cash", "cash box", "cash", "atm"]));
    for (const term of ["petty cash", "cash box", "atm"]) expect(hrefs(matchNavItems(withCash, term)), term).toContain("/petty-cash");
    // A tech never reads petty cash: no row, whatever the company has.
    expect(hrefs(commandNavItems(false, ALL_ON, true))).not.toContain("/petty-cash");
    // The layout checks for rows (this company's, staff only) and hands the answer over.
    const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain('supabase.from("petty_cash").select("id").eq("org_id", profile.org_id).limit(1)');
    expect(layout).toMatch(/<CommandBar [^\n]*hasPettyCash=\{hasPettyCash\}/);
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
 * EVERY DOCKED SCREEN IS REACHABLE BY THE WORDS A PERSON WOULD TYPE — INCLUDING THE WORD IT USED TO
 * BE CALLED. (Erik, 2026-10-01.)
 *
 * cn-v1034 renamed the dock row "Inspections" to "Walk-Throughs" and nobody touched the nickname list
 * here. So typing "inspection" found NOTHING — while the route is still /inspections, the stored
 * appointment type is still "inspection", and Nort's own description of the page still uses the word.
 * The man who had called it that for years got an empty palette. Reconcile had the gap the other way
 * round: it shipped findable only by its exact name, with none of the words its own rows are about.
 *
 * SO THE LIST IS PINNED, not just extended. Every dock row has to appear in this table and every word
 * in it has to actually land on that row: the next rename cannot orphan a word, because the renamed
 * row's old word is written down here as a requirement.
 */
const TYPED_WORDS: Record<string, readonly string[]> = {
  "/planner": ["my day"],
  "/schedule": ["schedule", "calendar", "dispatch"],
  "/timeclock": ["timeclock", "clock in", "punch"],
  "/leads": ["leads", "prospects", "inquiries", "pipeline"],
  // Both words it has worn — Inspections again since 2026-10-03, Walk-Throughs for the three days
  // from cn-v1034 (2026-09-30) to then — and the one-word spelling nobody hyphenates. Whichever one
  // a person learned, it still opens the page.
  "/inspections": ["walk-through", "walk-throughs", "walkthrough", "walk through", "inspection", "inspections", "site visit"],
  "/quotes": ["estimates", "estimate", "quote", "proposal", "bid"],
  "/crm": ["customers", "clients", "contacts"],
  "/jobs": ["jobs", "work", "projects"],
  "/billing": ["invoices", "owed", "payments", "aging"],
  "/timecards": ["timecards", "hours", "timesheet"],
  "/bills": ["bills", "accounts payable", "vendor", "expense"],
  // Its rows' own words (lib/reconcile-kinds), not only its name.
  "/reconcile": ["reconcile", "statement", "supplier statement", "spelling", "duplicate", "same ticket"],
  "/price-list": ["price list", "pricing", "rates", "catalog"],
  "/payroll": ["payroll", "wages", "paycheck"],
  "/tax-report": ["tax report", "taxes", "1099"],
  "/analytics": ["analytics", "reports", "profit"],
  "/recurring": ["recurring", "subscription"],
  "/compliance": ["compliance", "osha"],
  "/insurance": ["insurance", "workers comp"],
  "/safety": ["safety", "hazard"],
  "/audits": ["audits"],
  "/team": ["team"],
  "/employee-docs": ["employee docs"],
  "/forms": ["forms"],
  "/resources": ["resources"],
  "/handbook": ["handbook"],
  "/inventory": ["shop stock", "inventory", "stock", "parts"],
  "/activity": ["activity"],
  "/audit": ["activity audit"],
  "/tools": ["calculators", "calculator"],
  // A tech's "Your Settings" row is NOT here: its href carries a ?query, and the palette leaves query
  // rows out on purpose (a /jobs?status= row stripped of its section collides with Estimates).
  // Not dock rows: the four hand-written entries the palette adds (My Day is one row now, plan
  // take-offs live on New Estimate, and a company with cash rows gets Petty Cash).
  "/tasks": ["reminders", "tasks", "to-do"],
  "/organize": ["organize"],
  "/quotes/new": ["new estimate", "plans", "take-off"],
  "/petty-cash": ["petty cash", "cash box", "atm"],
};

describe("every dock row is findable by the words a person would type", () => {
  const staff = commandNavItems(true, ALL_ON, true);
  const tech = commandNavItems(false, ALL_ON, true);
  /** Every page the palette offers either role, by its path (a ?query dropped: /jobs?status=… rows
   *  never reach the palette, and a tech's /settings?tab=you is the /settings page). */
  const offered = [...new Set([...staff, ...tech].map((i) => i.href.split("?")[0]))].sort();

  it("the table covers exactly the pages the palette offers — a new row has to be given its words", () => {
    expect(Object.keys(TYPED_WORDS).sort()).toEqual(offered);
  });

  it("and every word in it lands on that page", () => {
    for (const [href, words] of Object.entries(TYPED_WORDS)) {
      const items = staff.some((i) => i.href.split("?")[0] === href) ? staff : tech;
      for (const word of words) {
        expect(hrefs(matchNavItems(items, word)).map((h) => h.split("?")[0]), `"${word}" should find ${href}`).toContain(href);
      }
    }
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
    // The line's words live in the shell catalog (sh_keysLine, cn-v1138); the span that holds them is the anchor.
    const at = barSrc.indexOf('{t("sh_keysLine")}');
    expect(at).toBeGreaterThan(0);
    expect(translator("en")("sh_keysLine")).toBe("↑↓ to navigate · ↵ to open · esc to close");
    const footer = barSrc.slice(at - 400, at);
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
    expect(barSrc).toContain('{nortOn ? t("sh_noMatchesNort") : t("sh_noMatches")}');
    expect(translator("en")("sh_noMatchesNort")).toBe("No matches. Press Enter to ask Nort.");
    expect(translator("en")("sh_noMatches")).toBe("No matches.");
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
    expect(barSrc).toContain('placeholder={nortOn ? t("sh_searchPlaceholderNort") : t("sh_searchPlaceholder")}');
    expect(translator("en")("sh_searchPlaceholderNort")).toBe("Search or ask Nort…");
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

/**
 * A SPANISH-SPEAKING TECH'S PALETTE (cn-v1138): the same rows, in his words — the dock's labels
 * through dockLabel, Talk To Nort, the kind chip, the lapsed rows. The English list is byte for
 * byte what it was (the default language is "en").
 */
describe("the palette in Spanish", () => {
  const labelsOf = (items: { label: string }[]) => items.map((i) => i.label);

  it("a tech's rows: Mi Día under Hoy, Reloj, Trabajos, Tú — the hrefs and aliases unchanged", () => {
    const en = commandNavItems(false, ALL_ON, false, false, "en");
    const es = commandNavItems(false, ALL_ON, false, false, "es");
    expect(hrefs(es)).toEqual(hrefs(en));
    expect(es.map((i) => i.aliases)).toEqual(en.map((i) => i.aliases));
    expect(hrefs(commandNavItems(false, ALL_ON))).toEqual(hrefs(en));
    expect(labelsOf(commandNavItems(false, ALL_ON))).toEqual(labelsOf(en));
    const byHref = (items: ReturnType<typeof commandNavItems>, href: string) => items.find((i) => i.href === href)!;
    expect(byHref(es, "/planner")).toMatchObject({ label: "Mi Día", sub: "Hoy" });
    expect(byHref(en, "/planner")).toMatchObject({ label: "My Day", sub: "Today" });
    expect(byHref(es, "/timeclock")).toMatchObject({ label: "Reloj", sub: "Reloj" });
    expect(byHref(es, "/jobs")).toMatchObject({ label: "Todos", sub: "Trabajos" });
    // A tech's Your Settings row carries ?tab=you, so it stays out of the palette as before; his Handbook is under Tú.
    expect(byHref(es, "/handbook")).toMatchObject({ label: "Manual", sub: "Tú" });
    expect(byHref(es, "/tasks")).toMatchObject({ label: "Recordatorios", sub: "Hoy" });
    // The ?status= rows stay out of the palette in every language (the collision note in the source).
    expect(hrefs(es).some((h) => h.includes("?"))).toBe(false);
    expect(labelsOf(es).some((l) => /^(My Day|Time Clock|All|Jobs|You|Your Settings|Handbook|Reminders)$/.test(l))).toBe(false);
  });

  it("before anything is typed: Hablar Con Nort, said out loud", () => {
    expect(idleRows({ isStaff: false, features: ALL_ON, setup: {}, onboarded: false, lang: "es" }).map((r) => [r.label, r.sub])).toEqual([["Hablar Con Nort", "Dilo en voz alta"]]);
    expect(idleRows({ isStaff: false, features: ALL_ON, setup: {}, onboarded: false }).map((r) => [r.label, r.sub])).toEqual([["Talk To Nort", "Say it out loud"]]);
  });

  it("the kind chip: Go to → Ir a; a kind the catalog does not name stays as typed", () => {
    const es = translator("es");
    expect(kindWords("Go to", es)).toBe("Ir a");
    expect(kindWords("Go to", translator("en"))).toBe("Go to");
    expect(kindWords("Nort", es)).toBe("Nort");
    expect(kindWords("Job", es)).toBe("Trabajo");
    expect(kindWords("Something New", es)).toBe("Something New");
  });

  it("lapsed: the three open doors in Spanish, Title Case", () => {
    const rows = labelsOf(commandNavItems(false, ALL_ON, false, true, "es"));
    expect(rows).toEqual(["Elegir Un Plan", "Ajustes", "Descargar Para Tu Contador"]);
    for (const r of rows) for (const w of r.split(" ")) expect(w).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
  });
});

/**
 * THE OFFICE'S MAP IN SPANISH (cn-v1139): every office row and its section through the dock's keys,
 * the two hand-written subs through the same keys (sh_dock_invoices, sh_dock_sales) instead of the
 * English literals they were, a Spanish alias on every row, and a search that folds accents.
 */
describe("the palette in Spanish: the office's rows (cn-v1139)", () => {
  const byHref = (items: ReturnType<typeof commandNavItems>, href: string) => items.find((i) => i.href === href)!;
  const es = commandNavItems(true, ALL_ON, true, false, "es");
  const en = commandNavItems(true, ALL_ON, true, false, "en");

  it("every office row reads the dock's Spanish under its tile's Spanish; the hrefs and aliases are the English list's", () => {
    expect(hrefs(es)).toEqual(hrefs(en));
    expect(es.map((i) => i.aliases)).toEqual(en.map((i) => i.aliases));
    expect(byHref(es, "/schedule")).toMatchObject({ label: "Agenda", sub: "Agenda" });
    expect(byHref(es, "/leads")).toMatchObject({ label: "Prospectos", sub: "Ventas" });
    expect(byHref(es, "/quotes")).toMatchObject({ label: "Presupuestos", sub: "Ventas" });
    expect(byHref(es, "/crm")).toMatchObject({ label: "Clientes", sub: "Ventas" });
    expect(byHref(es, "/billing")).toMatchObject({ label: "Facturas", sub: "Dinero" });
    expect(byHref(es, "/timecards")).toMatchObject({ label: "Tarjetas De Tiempo", sub: "Dinero" });
    expect(byHref(es, "/bills")).toMatchObject({ label: "Cuentas Y Órdenes", sub: "Dinero" });
    expect(byHref(es, "/payroll")).toMatchObject({ label: "Nómina", sub: "Dinero" });
    expect(byHref(es, "/team")).toMatchObject({ label: "Equipo", sub: "Oficina" });
    expect(byHref(es, "/inventory")).toMatchObject({ label: "Inventario", sub: "Oficina" });
    expect(byHref(es, "/tools")).toMatchObject({ label: "Calculadoras Y Herramientas", sub: "Herramientas" });
    // No English label is left on a Spanish screen.
    expect(es.map((i) => i.label).filter((l) => en.some((e) => e.label === l))).toEqual([]);
  });

  it("the two hand-written subs come through the dock's keys: New Estimate under Ventas, Petty Cash under Dinero (English byte for byte)", () => {
    expect(byHref(es, "/quotes/new")).toMatchObject({ label: "Nuevo Presupuesto", sub: "Ventas" });
    expect(byHref(es, "/petty-cash")).toMatchObject({ label: "Caja Chica", sub: "Dinero" });
    expect(byHref(en, "/quotes/new")).toMatchObject({ label: "New Estimate", sub: "Sales" });
    expect(byHref(en, "/petty-cash")).toMatchObject({ label: "Petty Cash", sub: "Money" });
    expect(barSrc).not.toContain('sub: "Money"');
    expect(barSrc).not.toContain('sub: "Sales"');
  });

  it("a row wearing its whenOff words and a tile reduced to one row read their variants: Cuentas; Clientes", () => {
    expect(byHref(commandNavItems(true, off("purchase_orders"), false, false, "es"), "/bills")).toMatchObject({ label: "Cuentas", sub: "Dinero" });
    expect(byHref(commandNavItems(true, off("leads", "estimates"), false, false, "es"), "/crm")).toMatchObject({ label: "Clientes", sub: "Clientes" });
  });

  it("a Spanish alias lands on every row, on an English screen too, and the search folds accents both ways", () => {
    const lands = (items: ReturnType<typeof commandNavItems>, term: string, href: string) =>
      expect(hrefs(matchNavItems(items, term)).map((h) => h.split("?")[0]), `"${term}" should find ${href}`).toContain(href);
    // PINNED LIKE TYPED_WORDS: every page the palette offers has its Spanish words here, and a new
    // row has to be given its own before the table balances.
    const SPANISH_WORDS: Record<string, readonly string[]> = {
      "/planner": ["mi día", "hoy"],
      "/schedule": ["agenda", "calendario"],
      "/timeclock": ["reloj", "checar"],
      "/leads": ["prospectos", "ventas"],
      "/inspections": ["inspecciones", "visita"],
      "/quotes": ["presupuestos", "cotización"],
      "/crm": ["clientes", "contactos"],
      "/jobs": ["trabajos", "proyectos"],
      "/billing": ["facturas", "dinero"],
      "/timecards": ["tarjetas de tiempo", "horas"],
      "/bills": ["cuentas", "proveedor"],
      "/reconcile": ["conciliar", "estado de cuenta"],
      "/price-list": ["lista de precios", "precios"],
      "/payroll": ["nómina", "sueldos"],
      "/tax-report": ["impuestos", "reporte de impuestos"],
      "/analytics": ["análisis", "reportes"],
      "/recurring": ["recurrentes", "repetir"],
      "/compliance": ["cumplimiento", "licencias"],
      "/insurance": ["seguros", "pólizas"],
      "/safety": ["seguridad", "incidente"],
      "/audits": ["auditorías"],
      "/team": ["equipo", "cuadrilla", "oficina"],
      "/employee-docs": ["documentos del personal", "documentos"],
      "/forms": ["formularios"],
      "/resources": ["recursos", "inspectores"],
      "/handbook": ["manual"],
      "/inventory": ["inventario", "bodega"],
      "/activity": ["actividad"],
      "/audit": ["auditoría de actividad", "historial"],
      "/tools": ["herramientas", "calculadoras"],
      "/tasks": ["recordatorios", "tareas"],
      "/organize": ["organizar", "papeles"],
      "/quotes/new": ["nuevo presupuesto", "planos"],
      "/petty-cash": ["caja chica", "efectivo"],
    };
    const offered = [...new Set([...en, ...commandNavItems(false, ALL_ON, true)].map((i) => i.href.split("?")[0]))].sort();
    expect(Object.keys(SPANISH_WORDS).sort()).toEqual(offered);
    for (const [href, terms] of Object.entries(SPANISH_WORDS)) {
      const enItems = en.some((i) => i.href.split("?")[0] === href) ? en : commandNavItems(false, ALL_ON, true, false, "en");
      const esItems = es.some((i) => i.href.split("?")[0] === href) ? es : commandNavItems(false, ALL_ON, true, false, "es");
      for (const term of terms) {
        lands(enItems, term, href);
        lands(esItems, term, href);
      }
    }
    // The accountant's door is a lapsed row (LAPSED_DOCK), found by its Spanish there.
    lands(commandNavItems(true, ALL_ON, false, true, "en"), "contador", "/analytics/accountant");
    lands(commandNavItems(true, ALL_ON, false, true, "es"), "ajustes", "/settings");
    // Without the accent, and with one the word does not carry: the same page.
    for (const [term, href] of [["nomina", "/payroll"], ["analisis", "/analytics"], ["mi dia", "/planner"], ["auditoria", "/audits"], ["Nómina", "/payroll"]] as const) {
      lands(en, term, href);
      lands(es, term, href);
    }
    expect(foldSearch("Nómina")).toBe("nomina");
    expect(foldSearch("Mi Día")).toBe("mi dia");
    expect(foldSearch("Cuentas Y Órdenes")).toBe("cuentas y ordenes");
    // A switch's Spanish words leave with it: Purchase Orders off, "orden de compra" finds nothing.
    lands(en, "orden de compra", "/bills");
    expect(hrefs(matchNavItems(commandNavItems(true, off("purchase_orders")), "orden de compra"))).not.toContain("/bills");
    lands(en, "suscripción", "/recurring");
    expect(hrefs(matchNavItems(commandNavItems(true, off("recurring_billing")), "suscripcion"))).not.toContain("/recurring");
    // A short Spanish word still never hijacks a typed name (the cn-v1128 rule holds for the new aliases).
    expect(matchNavItems(en, "Thistlewood")).toEqual([]);
    expect(matchNavItems(es, "Catbird Bayberry")).toEqual([]);
  });

  it("the help rows in Spanish, Title Case: Empieza Aquí, Muéstrame Cómo, Repetir La Configuración; Terminar La Configuración · Pendiente: 2", () => {
    const labels = (rows: ReturnType<typeof idleRows>) => rows.map((r) => r.label);
    expect(labels(idleRows({ isStaff: true, features: ALL_ON, setup: {}, onboarded: false, lang: "es" }))).toEqual([
      "Hablar Con Nort", "Empieza Aquí", "Muéstrame Cómo", "Repetir La Configuración",
    ]);
    const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };
    const rows = idleRows({ isStaff: true, features: ALL_ON, setup: { ...DONE, service_area: null, labor_rate: null }, onboarded: true, lang: "es" });
    expect(labels(rows)).toEqual(["Hablar Con Nort", "Terminar La Configuración · Pendiente: 2", "Muéstrame Cómo", "Repetir La Configuración"]);
    expect(rows[1].sub).toMatch(/^Todavía falta: /);
    expect(rows[0].sub).toBe("Dilo en voz alta");
    expect(rows[3].sub).toBe("La configuración desde el principio. Cambia lo que le dijiste a Nort.");
    // The rows still DO what they did: the same requests, inside the tap.
    expect(rows.filter((r) => r.kind === "Help" && !r.keepOpen).map((r) => r.href)).toEqual(["#finish", "#tour"]);
  });
});

/**
 * THE PALETTE'S SPANISH, END TO END (cn-v1139, E3): what a staff seat and a tech actually see under
 * es, section by section, and what typing a Spanish word — with or without its accent — brings up.
 * The SPANISH_WORDS table above stays the rule for a new row (it has to be given its words there);
 * this pins the sections' words and the search as a person meets them.
 */
describe("the palette's Spanish is proven end to end", () => {
  const SECTION_WORDS_EN = ["Today", "Schedule", "Clock", "Sales", "Jobs", "Money", "Office", "You", "Tools", "Customers"];
  const staffEs = commandNavItems(true, ALL_ON, true, false, "es");
  const staffEn = commandNavItems(true, ALL_ON, true, false, "en");
  const under = (items: ReturnType<typeof commandNavItems>, sub: string) => hrefs(items.filter((i) => i.sub === sub)).sort();

  it("a staff seat under es: the Schedule, Sales and Money sections carry Agenda, Ventas and Dinero as their sub words, and no English section word is left", () => {
    expect(under(staffEs, "Agenda")).toEqual(["/schedule"]);
    expect(under(staffEs, "Ventas")).toEqual(["/crm", "/inspections", "/leads", "/quotes", "/quotes/new"]);
    expect(under(staffEs, "Dinero")).toEqual([
      "/analytics", "/billing", "/bills", "/payroll", "/petty-cash", "/price-list", "/reconcile", "/recurring", "/tax-report", "/timecards", "/timeclock",
    ]);
    // The same rows the English seat has under Schedule, Sales and Money: only the words moved.
    expect(under(staffEs, "Agenda")).toEqual(under(staffEn, "Schedule"));
    expect(under(staffEs, "Ventas")).toEqual(under(staffEn, "Sales"));
    expect(under(staffEs, "Dinero")).toEqual(under(staffEn, "Money"));
    for (const w of SECTION_WORDS_EN) expect(staffEs.some((i) => i.sub === w), `an English section word "${w}" on a Spanish palette`).toBe(false);
    expect(staffEs.map((i) => i.label).filter((l) => staffEn.some((e) => e.label === l))).toEqual([]);
  });

  it('typing "nomina" (no accent) finds Nómina first; typing "dinero" finds the Money rows, every one of them under Dinero', () => {
    expect(matchNavItems(staffEs, "nomina")[0]).toMatchObject({ label: "Nómina", sub: "Dinero", href: "/payroll" });
    expect(matchNavItems(staffEs, "Nómina")[0]).toMatchObject({ href: "/payroll" });
    expect(matchNavItems(staffEs, "NOMINA")[0]).toMatchObject({ href: "/payroll" });
    const dinero = matchNavItems(staffEs, "dinero");
    expect(dinero.length).toBeGreaterThan(0);
    expect(dinero.map((i) => i.sub)).toEqual(dinero.map(() => "Dinero"));
    expect(hrefs(dinero)).toContain("/billing");
    // The palette shows six rows at most; each one shown is a Money row, in the Money section's own order.
    const money = under(staffEs, "Dinero");
    for (const h of hrefs(dinero)) expect(money, h).toContain(h);
    expect(hrefs(dinero)).toEqual(hrefs(staffEs.filter((i) => i.sub === "Dinero")).slice(0, dinero.length));
    // On the office's English screen the same word still lands on Invoices (the alias): a Spanish speaker is never lost there either.
    expect(hrefs(matchNavItems(staffEn, "dinero"))).toContain("/billing");
  });

  it("a tech's palette under es: Spanish rows under Spanish sections, and no English section word or label anywhere", () => {
    const techEs = commandNavItems(false, ALL_ON, true, false, "es");
    const techEn = commandNavItems(false, ALL_ON, true, false, "en");
    expect(hrefs(techEs)).toEqual(hrefs(techEn));
    expect([...new Set(techEs.map((i) => i.sub))].sort()).toEqual(["Herramientas", "Hoy", "Oficina", "Reloj", "Trabajos", "Tú"]);
    for (const i of techEs) {
      expect(SECTION_WORDS_EN, `${i.href}: the sub "${i.sub}"`).not.toContain(i.sub);
      expect(techEn.map((e) => e.label), `${i.href}: the label "${i.label}" is still English`).not.toContain(i.label);
    }
    // Typed in Spanish, found in Spanish: his clock, his jobs, his handbook.
    expect(matchNavItems(techEs, "reloj")[0]).toMatchObject({ label: "Reloj", href: "/timeclock" });
    expect(matchNavItems(techEs, "trabajos")[0]).toMatchObject({ label: "Todos", sub: "Trabajos", href: "/jobs" });
    expect(hrefs(matchNavItems(techEs, "manual"))).toContain("/handbook");
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

describe("short aliases never hijack a typed name (cn-v1128, the deep review's search-01)", () => {
  it("a customer name holding 'ar' or 'ap' ranks no page; the aliases typed alone, or as a word, still open their pages", () => {
    const staff = commandNavItems(true, ALL_ON);
    expect(matchNavItems(staff, "Larkspur")).toEqual([]);
    expect(matchNavItems(staff, "Snowbell Naples")).toEqual([]);
    expect(matchNavItems(staff, "Stockton")).toEqual([]);
    expect(hrefs(matchNavItems(staff, "bids"))).toContain("/quotes");
    expect(hrefs(matchNavItems(staff, "ar"))).toContain("/billing");
    expect(hrefs(matchNavItems(staff, "ap"))).toContain("/bills");
    expect(hrefs(matchNavItems(staff, "who owes ar"))).toContain("/billing");
  });
});
