import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECLARES_HOME,
  DOCK,
  activeNav,
  activeRowHref,
  activeSection,
  awaitsHome,
  basePath,
  dockTiles,
  menuSections,
  navDrawnAt,
  visibleDock,
  type NavAt,
} from "@/lib/dock";
import { ALL_ON, FEATURE_KEYS, normalizeFeatures, type FeatureKey, type FeatureMap } from "@/lib/features";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

/** Everything on but these switches. */
const off = (...keys: FeatureKey[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;

/** Drift guard: the dock's Jobs sub-nav is GENERATED from the JOB_STATUSES spine. This pins
 *  coverage, order, hrefs AND labels — the original disease was a hand-written 6-entry list
 *  (missing invoiced/cancelled) with a "Completed" label drifting from canonical "complete",
 *  while the /jobs page rendered all 7. One data origin now; this test keeps it that way. */
describe("DOCK jobs section ← JOB_STATUSES", () => {
  const jobs = DOCK.find((s) => s.key === "jobs");
  const children = jobs?.children ?? [];
  const statusChildren = children.filter((c) => c.href?.startsWith("/jobs?status="));

  it("exists, All first and then the statuses (Erik, b94497dd: 'a button for the default setting at the top above To Be Scheduled')", () => {
    expect(jobs).toBeDefined();
    expect(children[0]).toMatchObject({ id: "j-all", label: "All", href: "/jobs" });
    expect(children[1]?.href).toBe(`/jobs?status=${JOB_STATUSES[0]}`);
    // All carries no switch and no role gate: it is the view the page opens on, for everyone.
    expect(children[0]?.staffOnly).toBeUndefined();
    expect(children[0]?.feature).toBeUndefined();
  });

  it("hrefs cover every job status, in lifecycle order (cancelled last)", () => {
    expect(statusChildren.map((c) => c.href)).toEqual(JOB_STATUSES.map((s) => `/jobs?status=${s}`));
  });

  it("labels derive from jobStatusLabel (no hand-written label drift)", () => {
    expect(statusChildren.map((c) => c.label.toLowerCase())).toEqual(
      JOB_STATUSES.map((s) => jobStatusLabel(s)),
    );
  });

  it("All then the statuses, and nothing after (WO/Materials/CO are hub-only — Erik: 'Across all jobs GO AWAY')", () => {
    expect(children.slice(1, 1 + JOB_STATUSES.length).map((c) => c.id)).toEqual(
      JOB_STATUSES.map((s) => `j-${s}`),
    );
    // Statuses are for everyone (techs filter their own job list) — never staff-gated.
    expect(statusChildren.every((c) => !c.staffOnly)).toBe(true);
    // After the statuses: NOTHING. Every cross-job list link is gone — those records are
    // reached through the job's own tabs. Permits left last (Erik 2026-07-20: "permits live
    // with the job like materials"); Plans & LiDAR left 2026-07-14.
    const rest = children.slice(1 + JOB_STATUSES.length);
    expect(rest).toEqual([]);
    for (const gone of ["/work-orders", "/materials", "/change-orders", "/permits"]) {
      expect(children.some((c) => c.href && basePath(c.href) === gone)).toBe(false);
    }
  });
});

/** Drift guard #2: the time doors. Schedule (the WHEN-WILL map) is its own tile right after
 *  Today — it sat as Clock's 3rd pill, a planning surface hidden behind the timeclock's impulse
 *  door (the time-section gut's "lostness cause a"). W1-08 then split the WHEN-DID pair by who
 *  uses it: the Clock tile is the crew's (staff clock in on My Day's Now card), and Timecards is
 *  the office's, under Money. This pins placement, gating AND zero-duplication. */
describe("DOCK time doors — Schedule after Today, Clock is the crew's, Timecards the office's", () => {
  const clock = DOCK.find((s) => s.key === "clock");

  it("Schedule is its OWN tile, directly after Today, office-only; Clock follows it, tech-only", () => {
    // Erik, verbatim: "Move: Schedule - to main dock after Today before Clock". It had been a
    // child pill under Today; the man planning a week lives there too much for one level down.
    const keys = DOCK.map((s) => s.key);
    expect(keys.indexOf("schedule")).toBe(keys.indexOf("today") + 1);
    expect(keys.indexOf("clock")).toBe(keys.indexOf("schedule") + 1);
    expect(DOCK.find((s) => s.key === "schedule")).toMatchObject({ href: "/schedule", staffOnly: true });
    expect(clock).toMatchObject({ href: "/timeclock", techOnly: true });
  });

  it("Clock holds exactly the Timeclock — no planning surface and no office ledger behind the clock door", () => {
    expect((clock?.children ?? []).map((c) => c.href)).toEqual(["/timeclock"]);
  });

  it("Time Clock is a Money row right after Invoices, then Timecards; office-only; nothing owns /timeclock (cn-v1128)", () => {
    const money = DOCK.find((s) => s.key === "invoices")!.children;
    const at = money.findIndex((c) => c.id === "ck-cards");
    expect(money[at]).toMatchObject({ label: "Timecards", href: "/timecards", staffOnly: true });
    expect(money[at].owns).toBeUndefined();
    expect(money[at - 1]).toMatchObject({ id: "m-clock", label: "Time Clock", href: "/timeclock", staffOnly: true });
    expect(money[at - 2]?.id).toBe("m-inv");
    expect(money[at + 1]?.id).toBe("m-bills");
  });

  /**
   * ONE INVOICES PAGE (W1-29): Accounts Receivable and Payments folded into /billing (By Customer and
   * Payments In), and their old routes redirect there, so they have no row. PETTY CASH LEFT THE MENU
   * (W1-34): a company with rows finds it in Search or Ask.
   *
   * MONEY CARRIES ONE DOT NOW, and only one (cn-v1037): Reconcile's, which is how many KINDS of
   * disagreement have anything open — a rollup bounded by the ReconcileKind union, zero drawing
   * nothing. It is the only badge under this tile, and the only one it may grow: a number on chrome
   * has to be a human decision today (lib/action-items/types.ts), which a ledger total is not.
   */
  it("Money has one row for the money coming in (Invoices), and no Accounts Receivable, Payments or Petty Cash row", () => {
    const money = DOCK.find((s) => s.key === "invoices")!.children;
    const ids = money.map((c) => c.id);
    for (const gone of ["m-ar", "m-pay", "ma-petty"]) expect(ids, gone).not.toContain(gone);
    const hrefs = money.map((c) => c.href).filter(Boolean).map((h) => basePath(h!));
    for (const gone of ["/billing/ar", "/payments", "/petty-cash"]) expect(hrefs, gone).not.toContain(gone);
    expect(money.filter((c) => c.href && basePath(c.href) === "/billing").map((c) => c.id)).toEqual(["m-inv"]);
    // The old routes still light Money (they're under /billing, or redirect there before they render).
    expect(activeSection("/billing/ar")?.key).toBe("invoices");
  });

  it("zero duplication: /schedule and /timecards each have exactly one dock home", () => {
    const homes = (path: string) =>
      DOCK.flatMap((s) => s.children).filter((c) => c.href && basePath(c.href) === path).map((c) => c.id);
    expect(homes("/schedule")).toEqual(["s-week"]);
    expect(homes("/timecards")).toEqual(["ck-cards"]);
  });

  /**
   * RECONCILE IS A SIBLING OF BILLS, NEVER A TILE (cn-v1037).
   *
   * The two-records-that-should-agree work was a collapsed fold at the bottom of /bills. It is
   * occasional office work — nobody taps it in a truck — so it belongs one row below the page it
   * came off, inside Money, and nowhere near the main dock. Staff only, because techs never see
   * prices, and with no feature switch: this is not a paid tier and KISS says no new switch.
   */
  it("Reconcile is one row under Money, straight after Bills, staff-only, with no switch", () => {
    const money = DOCK.find((s) => s.key === "invoices")!.children;
    const at = money.findIndex((c) => c.id === "m-recon");
    expect(money[at]).toMatchObject({ label: "Reconcile", href: "/reconcile", staffOnly: true });
    expect(money[at]?.feature).toBeUndefined();
    expect(money[at - 1]?.id).toBe("m-bills");
    // No top-level tile of its own, and exactly one dock home.
    expect(DOCK.map((s) => s.key)).not.toContain("reconcile");
    const homes = DOCK.flatMap((s) => s.children).filter((c) => c.href && basePath(c.href) === "/reconcile");
    expect(homes.map((c) => c.id)).toEqual(["m-recon"]);
  });

  it("a tech never sees the Reconcile row, whatever the switches say", () => {
    for (const section of visibleDock({ isStaff: false, features: null })) {
      expect(section.children.map((c) => c.id)).not.toContain("m-recon");
    }
    const staffMoney = visibleDock({ isStaff: true, features: null }).find((s) => s.key === "invoices");
    expect(staffMoney?.children.map((c) => c.id)).toContain("m-recon");
  });
});

/** Drift guard #2b: the settings-restructure truth. Team is its own Office page now (its
 *  lifecycle verbs lifted out of Settings), and Settings is GONE from the Office list —
 *  it lives behind the avatar (the one predictable door, zero-duplication law). Settings
 *  is now its OWN territory, owned by NO dock section: its own side-tab (settings-subnav)
 *  drives its clusters, so the Office list no longer clutters the settings page (cn-v331).
 *  This pins that a future wave can't re-add a Settings link to Office, re-own /settings
 *  through Office, or drop Team's home. */
describe("DOCK office — Team present, Settings link absent (settings doctrine)", () => {
  const office = DOCK.find((s) => s.key === "office");
  const children = office?.children ?? [];

  it("Team is an Office child, office-only, pointing at /team", () => {
    const team = children.find((c) => c.id === "o-team");
    expect(team).toMatchObject({ label: "Team", href: "/team", staffOnly: true });
  });

  it("no Settings LINK in the Office list (it lives behind the avatar)", () => {
    expect(children.some((c) => c.href && basePath(c.href) === "/settings")).toBe(false);
  });

  it("Office does NOT own /settings — Settings is its own territory (its own side-tab drives it)", () => {
    expect(children.some((c) => c.owns?.some((p) => basePath(p) === "/settings"))).toBe(false);
    // FOR STAFF, who reach Settings behind the avatar. A TECH now has a "You" tile pointing at the
    // one cluster that is his (cn-v694), so the audience has to be named — the doctrine did not
    // change, it just stopped being universal.
    expect(activeSection("/settings", DOCK.filter((x) => !x.techOnly))).toBeUndefined();
  });

  it("zero duplication: /team has exactly one dock home", () => {
    const homes = DOCK.flatMap((s) => s.children).filter(
      (c) => c.href && basePath(c.href) === "/team",
    );
    expect(homes.map((c) => c.id)).toEqual(["o-team"]);
  });
});

/** Drift guard #2c: the Sales pipeline order — Leads · Inspections · Estimates (Erik
 *  2026-07-14: appointments and inspections are ONE platform; the Inspections tab is the
 *  site-visit step between a lead and its estimate), then Customers, the Contacts tile
 *  folded in (W1-07). Pins presence, order and the zero-duplication law. */
describe("DOCK sales — Leads · Inspections · Estimates · Customers", () => {
  const sales = DOCK.find((s) => s.key === "sales");
  const children = sales?.children ?? [];

  it("children are exactly Leads · Inspections · Estimates · Customers, in pipeline order", () => {
    expect(children.map((c) => c.href)).toEqual(["/leads", "/inspections", "/quotes", "/crm"]);
    // One word for the site visit (lib/statuses): the row reads Inspections; the route and the id stay.
    expect(children.find((c) => c.id === "sl-inspections")).toMatchObject({
      label: "Inspections",
      href: "/inspections",
    });
    // Customers carries no switch: Sales never disappears with Leads and Estimates off.
    expect(children.find((c) => c.id === "sl-customers")).toMatchObject({ label: "Customers", href: "/crm" });
    expect(children.find((c) => c.id === "sl-customers")?.feature).toBeUndefined();
  });

  it("the Contacts tile is gone: /crm and /inspections each have exactly one dock home", () => {
    expect(DOCK.some((s) => s.key === "contacts")).toBe(false);
    const homes = (path: string) =>
      DOCK.flatMap((s) => s.children).filter((c) => c.href && basePath(c.href) === path).map((c) => c.id);
    expect(homes("/inspections")).toEqual(["sl-inspections"]);
    expect(homes("/crm")).toEqual(["sl-customers"]);
  });

  it("/inspections and a customer's page (/crm/abc) light Sales", () => {
    expect(activeSection("/inspections")?.key).toBe("sales");
    expect(activeSection("/crm")?.key).toBe("sales");
    expect(activeSection("/crm/abc", visibleDock({ isStaff: true }))?.key).toBe("sales");
  });
});

/** Drift guard #3: activeSection is THE one matcher behind the desktop rail, the phone
 *  bottom tiles and the SectionSubnav strip. The original disease was three drifting
 *  copies, none of which prefix-matched child routes — /quotes/abc lit "Today" on desktop
 *  (via a `?? sections[0]` fallback), zero tiles on mobile, and the strip vanished. One
 *  case per [id] route family pins every detail page to its owning section. */
describe("activeSection — child detail routes light the right section", () => {
  const key = (pathname: string) => activeSection(pathname)?.key;

  it("landing pages map to their own sections", () => {
    expect(key("/planner")).toBe("today");
    expect(key("/jobs")).toBe("jobs");
    expect(key("/billing")).toBe("invoices");
    expect(key("/compliance")).toBe("office");
  });

  it("/schedule lights its OWN tile; /timecards lights Money", () => {
    expect(key("/schedule")).toBe("schedule");
    expect(key("/timecards")).toBe("invoices");
  });

  it("/timeclock lights Money for staff and Clock for a tech — the role filter runs first", () => {
    // Staff reach the Timeclock from the Now card's link; Timecards (staff-only) owns the route
    // for them. A tech never sees that row, so his Clock tile claims it.
    expect(activeSection("/timeclock", visibleDock({ isStaff: true }))?.key).toBe("invoices");
    expect(activeSection("/timeclock", visibleDock({ isStaff: false }))?.key).toBe("clock");
  });

  it("My Day alone owns Today: /tasks, a task category and /organize light it", () => {
    for (const isStaff of [true, false]) {
      const s = visibleDock({ isStaff });
      for (const path of ["/planner", "/tasks", "/tasks/site-prep", "/organize"]) expect(activeSection(path, s)?.key, path).toBe("today");
    }
  });

  it("estimate details belong to Sales (section href is /leads — the old matchers missed)", () => {
    expect(key("/quotes/abc123")).toBe("sales");
    expect(key("/quotes/new")).toBe("sales");
  });

  it("job details belong to Jobs; hub-only records (WO/Materials) light nothing — reached via the job, never lie", () => {
    expect(key("/jobs/abc123")).toBe("jobs");
    // Work orders / materials left the nav (hub-only, Erik 2026-07). Their detail pages are
    // reached through a job's tabs and carry their own backlinks — no dock section owns them.
    expect(key("/work-orders/abc123")).toBeUndefined();
    expect(key("/materials/abc123")).toBeUndefined();
  });

  it("purchasing (PO details) belongs to Money via the Bills & POs owns-alias", () => {
    expect(key("/purchasing")).toBe("invoices");
    expect(key("/purchasing/abc123")).toBe("invoices");
  });

  it("invoice details belong to Money, form details to Office, task categories to Today", () => {
    expect(key("/billing/abc123")).toBe("invoices");
    expect(key("/forms/abc123")).toBe("office");
    expect(key("/tasks/site-prep")).toBe("today");
  });

  it("the team roster lights Office; settings lights NOTHING for staff (its own territory)", () => {
    expect(key("/team")).toBe("office");
    // Staff only: no dock section owns Settings, the avatar menu is its door. A tech's "You" tile
    // deliberately does own it — see the You-tile block below.
    expect(activeSection("/settings", DOCK.filter((x) => !x.techOnly))).toBeUndefined();
  });

  it("unmapped routes match NOTHING — light nothing, never lie", () => {
    expect(activeSection("/definitely-not-a-route")).toBeUndefined();
    // Prefix means path segments, not string prefixes: /billings is not /billing.
    expect(activeSection("/billings")).toBeUndefined();
  });

  it("respects a role-filtered section list (a tech on a staff route lights nothing)", () => {
    const techSections = visibleDock({ isStaff: false });
    expect(activeSection("/quotes/abc123", techSections)).toBeUndefined();
    expect(activeSection("/crm/abc123", techSections)).toBeUndefined();
    expect(activeSection("/timeclock", techSections)?.key).toBe("clock");
  });
});

/**
 * WHICH ROW LIGHTS (lib/dock activeRowHref) — the one rule behind the lg page column, the pill
 * strip and the sheet. The third step is new with the tech's You rows: his bare /settings is the
 * Your Settings row (/settings?tab=you), and nothing else on that page could claim it.
 */
describe("activeRowHref — one lit row, or none", () => {
  const rows = (key: string, isStaff: boolean) => visibleDock({ isStaff }).find((s) => s.key === key)!.children;

  it("the exact location wins (a Jobs status row)", () => {
    expect(activeRowHref(rows("jobs", true), "/jobs", "/jobs?status=in_progress")).toBe("/jobs?status=in_progress");
  });

  it("then the query-less row on this page (Invoices on /billing?page=2)", () => {
    expect(activeRowHref(rows("invoices", true), "/billing", "/billing?page=2")).toBe("/billing");
  });

  it("a tech's bare /settings lights Your Settings; /handbook lights Handbook", () => {
    expect(activeRowHref(rows("you", false), "/settings", "/settings")).toBe("/settings?tab=you");
    expect(activeRowHref(rows("you", false), "/settings", "/settings?tab=you")).toBe("/settings?tab=you");
    expect(activeRowHref(rows("you", false), "/handbook", "/handbook")).toBe("/handbook");
  });

  // Bare /jobs used to light nothing: seven rows sat on that one pathname and none of them WAS it.
  // The All row is it (b94497dd), so the page a person opens on now says which row it is.
  it("bare /jobs lights All — the row that IS the unfiltered page", () => {
    expect(activeRowHref(rows("jobs", true), "/jobs", "/jobs")).toBe("/jobs");
  });

  // Erik, 2026-09-30: "time clock point to money with timecards on the subnav"; 2026-10-26: "Time Clock
  // in Money beside Timecards" — the page has its own row now (cn-v1128), so it lights that row.
  it("the office standing on the TIME CLOCK lights Money's own Time Clock row (cn-v1128)", () => {
    expect(activeRowHref(rows("invoices", true), "/timeclock", "/timeclock")).toBe("/timeclock");
    // A detail route under it too (a split's own page), and the query-carrying case.
    expect(activeRowHref(rows("invoices", true), "/timeclock/abc", "/timeclock/abc")).toBe("/timeclock");
    expect(activeRowHref(rows("invoices", true), "/timeclock", "/timeclock?day=2026-09-30")).toBe("/timeclock");
    // Timecards itself still wins by its own href, not by owning anything.
    expect(activeRowHref(rows("invoices", true), "/timecards", "/timecards")).toBe("/timecards");
  });

  it("a tech's /timeclock still lights his own Clock row, not an owning one", () => {
    expect(activeRowHref(rows("clock", false), "/timeclock", "/timeclock")).toBe("/timeclock");
  });

  it("a route nothing owns still lights nothing rather than guess", () => {
    expect(activeRowHref(rows("invoices", true), "/work-orders/abc", "/work-orders/abc")).toBeUndefined();
  });
});

describe("the section nav must be REACHABLE at every width (cn-v660 regression)", () => {
  /**
   * Erik, on a ~900px window: "the subnav is gone."
   *
   * SectionSubnav swaps its pill strip for the left-edge SHEET once a section has more than four
   * pages. That handle is `left: 0`, which is right on a phone (the dock is a bottom bar) and
   * wrong between 640 and 1024 on a mouse, where the dock is an 84px vertical rail sitting on top
   * of it. Before cn-v660 those sections had the dock's inside-left column at that width so the
   * handle was never needed there; hiding the column below lg exposed it.
   *
   * This asserts the SET that takes the sheet path, so the next section that crosses four pages is
   * a deliberate decision rather than a silent disappearance.
   */
  const sheetSections = DOCK.filter((s) => s.children.filter((c) => c.href).length > 4).map((s) => s.key);

  it("names exactly which sections depend on the left-edge handle", () => {
    expect(sheetSections.sort()).toEqual(["invoices", "jobs", "office"]);
  });

  it("and every one of them has enough pages that a pill strip could not hold them", () => {
    for (const key of sheetSections) {
      const n = DOCK.find((s) => s.key === key)!.children.filter((c) => c.href).length;
      expect(n, `${key} has ${n} pages`).toBeGreaterThan(4);
    }
  });
});

/**
 * THE TECH-ONLY "You" TILE. Erik: "i like that tech have a you settings and since its all already
 * moved to the dock how about make it on the dock for them only." Staff reach Settings through the
 * avatar menu (cn-v326) and have no use for a second door; a tech has no business in the other
 * nine groups but every right to his own name, photo, language and notifications.
 */
describe("the You tile is a tech's door and nobody else's", () => {
  const staff = visibleDock({ isStaff: true });
  const tech = visibleDock({ isStaff: false });
  const you = (features?: FeatureMap) => visibleDock({ isStaff: false, features }).find((s) => s.key === "you");

  it("techs get it, staff never see it", () => {
    expect(tech.some((s) => s.key === "you")).toBe(true);
    expect(staff.some((s) => s.key === "you")).toBe(false);
  });

  it("lights on /settings for a tech — its href carries a ?query, a pathname never does", () => {
    expect(activeSection("/settings", tech)?.key).toBe("you");
  });

  it("does NOT hijack /settings for staff, who reach it outside the dock", () => {
    expect(activeSection("/settings", staff)?.key).toBeUndefined();
  });

  it("holds Your Settings and the Handbook (W1-08), so /handbook lights You for him", () => {
    expect(you()?.children.map((c) => `${c.label}=${c.href}`)).toEqual(["Your Settings=/settings?tab=you", "Handbook=/handbook"]);
    expect(activeSection("/handbook", tech)?.key).toBe("you");
    // The office's /handbook is its Office row.
    expect(activeSection("/handbook", staff)?.key).toBe("office");
  });

  it("Crew & Payroll off takes the Handbook away; the tile stays with Your Settings", () => {
    expect(you(off("crew_payroll"))?.children.map((c) => c.id)).toEqual(["y-settings"]);
  });

  it("with EVERY switch off, You is still there (Your Settings never has a switch)", () => {
    const everythingOff = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])) as FeatureMap;
    expect(you(everythingOff)?.children.map((c) => c.id)).toEqual(["y-settings"]);
    expect(you(everythingOff)?.href).toBe("/settings?tab=you");
  });
});

/**
 * FIVE TILES FOR STAFF, FOUR FOR A TECH (W1-07/W1-08). Office and Tools are still sections —
 * visibleDock returns them, so the active match, the strip and sheet, the lg column and search
 * keep working on /team, /forms, /inventory and /tools — but they are rows behind the initials,
 * never tiles. A sixth tile shrank every tile under the 44px tap size.
 */
describe("the tiles on the bar, and the sections behind the initials", () => {
  const keys = (s: { key: string }[]) => s.map((x) => x.key);

  it("staff: Today, Schedule, Sales, Jobs, Money; Office and Tools in the menu, never tiles", () => {
    const staff = visibleDock({ isStaff: true });
    expect(keys(dockTiles(staff))).toEqual(["today", "schedule", "sales", "jobs", "invoices"]);
    expect(keys(menuSections(staff))).toEqual(["office", "tools"]);
    for (const k of ["office", "tools"]) expect(DOCK.find((s) => s.key === k)?.inMenu, k).toBe(true);
  });

  it("a tech: Today, Clock, Jobs, You; Office and Tools in the menu", () => {
    const tech = visibleDock({ isStaff: false });
    expect(keys(dockTiles(tech))).toEqual(["today", "clock", "jobs", "you"]);
    expect(keys(menuSections(tech))).toEqual(["office", "tools"]);
  });

  it("Calculators off: no Tools anywhere (menu or tile), for everyone", () => {
    for (const isStaff of [true, false]) expect(keys(visibleDock({ isStaff, features: off("calculators") }))).not.toContain("tools");
  });

  it("an Office page still has its section: /team, /forms and /inventory light Office; /tools lights Tools", () => {
    const staff = visibleDock({ isStaff: true });
    expect(activeSection("/team", staff)?.key).toBe("office");
    expect(activeSection("/forms/abc", staff)?.key).toBe("office");
    expect(activeSection("/inventory", staff)?.key).toBe("office");
    expect(activeSection("/tools", staff)?.key).toBe("tools");
  });

  it("Leads and Estimates both off: the Sales tile reads Customers and lands on /crm", () => {
    const sales = visibleDock({ isStaff: true, features: off("leads", "estimates") }).find((s) => s.key === "sales")!;
    expect(sales).toMatchObject({ label: "Customers", href: "/crm" });
    expect(sales.short).toBeUndefined();
    expect(sales.children.map((c) => c.id)).toEqual(["sl-customers"]);
    // Either one on, it is still Sales.
    for (const f of [off("leads"), off("estimates"), ALL_ON]) {
      expect(visibleDock({ isStaff: true, features: f }).find((s) => s.key === "sales")?.label).toBe("Sales");
    }
  });

  it("the badge sums don't move: only /planner (Today) and /leads (Sales) carry counts", () => {
    const staff = dockTiles(visibleDock({ isStaff: true }));
    const counted = staff.filter((s) => s.children.some((c) => c.href === "/planner" || c.href === "/leads")).map((s) => s.key);
    expect(counted).toEqual(["today", "sales"]);
  });
});

/**
 * NO TECH TILE BOUNCES (Wave 0). The Office tile landed a tech on /team, which sends him straight
 * back to My Day, and Organize's Take Photo / File It all save through requireStaff. A door that
 * can't work for this person doesn't render. Office stays on his dock (he fills Forms and reads the
 * Handbook, Resources, Compliance and Safety there); it lands him on its first row he can open.
 */
describe("a tech's dock has no dead doors", () => {
  const tech = visibleDock({ isStaff: false });
  const STAFF_REDIRECTS = ["/team", "/schedule", "/leads", "/billing", "/crm", "/organize", "/timecards"];

  it("is Today, Clock, Jobs, Office, You and Tools (Office and Tools behind his initials)", () => {
    expect(tech.map((s) => s.key)).toEqual(["today", "clock", "jobs", "office", "you", "tools"]);
  });

  it("never lands on a page that sends a tech away", () => {
    for (const s of tech) {
      expect(STAFF_REDIRECTS).not.toContain(basePath(s.href));
      for (const c of s.children) if (c.href) expect(STAFF_REDIRECTS).not.toContain(basePath(c.href));
    }
  });

  it("keeps his Office doors: Forms, Resources and the read-only Liabilities pages (the Handbook moved to You)", () => {
    const office = tech.find((s) => s.key === "office")!;
    expect(office.href).toBe("/compliance");
    expect(office.children.filter((c) => c.href).map((c) => c.href)).toEqual([
      "/compliance", "/insurance", "/safety", "/audits", "/forms", "/resources",
    ]);
    // Staff still land on Team, as Erik set it, and keep their Handbook row there.
    const staffOffice = visibleDock({ isStaff: true }).find((s) => s.key === "office")!;
    expect(staffOffice.href).toBe("/team");
    expect(staffOffice.children.map((c) => c.id)).toContain("o-handbook");
  });

  it("sees the Handbook exactly once, under You", () => {
    const homes = tech.flatMap((s) => s.children.filter((c) => c.href === "/handbook").map(() => s.key));
    expect(homes).toEqual(["you"]);
  });

  it("carries no bug door: Bug Watch is North's, in the avatar menu for platform admins", () => {
    const all = DOCK.flatMap((s) => [s, ...s.children]);
    expect(all.some((n) => n.href && basePath(n.href) === "/bugs")).toBe(false);
    expect(all.some((n) => n.label === "Diagnostics")).toBe(false);
  });

  it("Today is My Day alone for staff and techs (Reminders and Organize are found by name)", () => {
    for (const isStaff of [true, false]) {
      const today = visibleDock({ isStaff }).find((s) => s.key === "today")!;
      expect(today.children.map((c) => c.label)).toEqual(["My Day"]);
    }
  });
});

/**
 * THE SWITCH BOARD ON THE DOCK (0352). visibleDock is the one filter the rail, the phone bar, the
 * section strip and the command bar all draw from. A switch HIDES DOORS ONLY: every page stays
 * reachable by link (the layout's RouteOffLine says it's off), so these tests pin the doors.
 */
describe("visibleDock — role and switches, one filter", () => {
  type Sections = ReturnType<typeof visibleDock>;
  const ids = (sections: Sections) =>
    sections.map((s) => `${s.key}>${s.href}:${s.children.map((c) => `${c.id}=${c.label}`).join(",")}`);
  // The role filter every renderer carried before the switches (dock.tsx, section-subnav.tsx,
  // command-bar.tsx): staffOnly/techOnly on tiles and rows. A tech's Office lands on its first
  // row he sees, not on staff-only Team (which bounced him).
  const legacy = (isStaff: boolean): Sections =>
    DOCK.filter((s) => (isStaff || !s.staffOnly) && (!isStaff || !s.techOnly)).map((s) => ({
      ...s,
      href: !isStaff && s.key === "office" ? "/compliance" : s.href,
      children: s.children.filter((c) => (isStaff ? !c.techOnly : !c.staffOnly)),
    }));
  const rows = (s: Sections) => s.flatMap((x) => x.children.map((c) => c.id));
  const tile = (s: Sections, key: string) => s.find((x) => x.key === key);

  it("no switches stored (everything on) is exactly the old role-filtered dock, staff and tech", () => {
    for (const isStaff of [true, false]) {
      expect(ids(visibleDock({ isStaff, features: ALL_ON }))).toEqual(ids(legacy(isStaff)));
      expect(ids(visibleDock({ isStaff }))).toEqual(ids(legacy(isStaff)));
      expect(ids(visibleDock({ isStaff, features: normalizeFeatures(undefined) }))).toEqual(ids(legacy(isStaff)));
    }
  });

  it("Leads off: Leads and Inspections go, and Sales lands on Estimates", () => {
    const d = visibleDock({ isStaff: true, features: off("leads") });
    expect(tile(d, "sales")?.children.map((c) => c.id)).toEqual(["sl-quotes", "sl-customers"]);
    expect(tile(d, "sales")?.href).toBe("/quotes");
  });

  it("Leads and Estimates both off: Sales stays as Customers, landing on /crm", () => {
    const d = visibleDock({ isStaff: true, features: off("leads", "estimates") });
    expect(tile(d, "sales")).toMatchObject({ label: "Customers", href: "/crm" });
    expect(tile(d, "sales")?.children.map((c) => c.id)).toEqual(["sl-customers"]);
  });

  it("Estimates off alone: Sales keeps its landing page (/leads) and loses only the row", () => {
    const d = visibleDock({ isStaff: true, features: off("estimates") });
    expect(tile(d, "sales")?.href).toBe("/leads");
    expect(tile(d, "sales")?.children.map((c) => c.id)).toEqual(["sl-leads", "sl-inspections", "sl-customers"]);
  });

  it("Purchase Orders off: the row reads Bills and still owns /purchasing (a PO link lights Money)", () => {
    const d = visibleDock({ isStaff: true, features: off("purchase_orders") });
    const bills = tile(d, "invoices")?.children.find((c) => c.id === "m-bills");
    expect(bills).toMatchObject({ label: "Bills", href: "/bills", owns: ["/purchasing"] });
    expect(activeSection("/purchasing/abc", d)?.key).toBe("invoices");
    // On, it reads as it always did.
    expect(tile(visibleDock({ isStaff: true }), "invoices")?.children.find((c) => c.id === "m-bills")?.label).toBe("Bills & POs");
  });

  it("Shop Stock off: the row AND its Stock heading go", () => {
    const d = visibleDock({ isStaff: true, features: off("shop_stock") });
    expect(rows(d)).not.toContain("ma-stock");
    expect(rows(d)).not.toContain("o-stock-h");
  });

  it("Crew & Payroll off: Payroll, Employee Docs and the Handbook go; Team never does", () => {
    const d = visibleDock({ isStaff: true, features: off("crew_payroll") });
    for (const id of ["ma-payroll", "o-docs", "o-handbook"]) expect(rows(d)).not.toContain(id);
    expect(rows(d)).toContain("o-team");
    // A tech loses his Handbook (under You) too, and keeps everything else he had.
    const tech = visibleDock({ isStaff: false, features: off("crew_payroll") });
    expect(rows(tech)).not.toContain("y-handbook");
    expect(rows(tech)).toEqual(rows(legacy(false)).filter((id) => id !== "y-handbook"));
  });

  it("Recurring Billing off: the Recurring row stays (repeat jobs and expenses live there); the Tax Report stays whatever Sales Tax says", () => {
    const d = visibleDock({ isStaff: true, features: off("recurring_billing", "sales_tax") });
    expect(rows(d)).toContain("ma-recur");
    expect(rows(d)).toContain("ma-tax");
  });

  it("Licenses off: the whole Liabilities group (heading included) goes; Safety Log alone takes only Safety", () => {
    const d = visibleDock({ isStaff: false, features: off("licenses") });
    for (const id of ["o-liab-h", "o-comply", "o-insurance", "o-safety", "o-audits"]) expect(rows(d)).not.toContain(id);
    // A tech's Office then lands on the first row left: Forms.
    expect(tile(d, "office")?.href).toBe("/forms");
    const s = visibleDock({ isStaff: false, features: off("safety_log") });
    expect(rows(s)).not.toContain("o-safety");
    expect(rows(s)).toEqual(expect.arrayContaining(["o-liab-h", "o-comply", "o-insurance", "o-audits"]));
    // Forms is not a Safety Log door: it also holds the inspection sheet and the intake form.
    expect(rows(s)).toContain("o-forms");
  });

  it("Calculators off: the Tools tile goes, for everyone", () => {
    for (const isStaff of [true, false]) expect(tile(visibleDock({ isStaff, features: off("calculators") }), "tools")).toBeUndefined();
  });

  it("the tech-only You tile survives any switch (Your Settings carries none)", () => {
    const everythingOff = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])) as FeatureMap;
    expect(tile(visibleDock({ isStaff: false, features: everythingOff }), "you")).toBeDefined();
  });

  it("a staff member never gains a tech's row, and a tech never a staff row", () => {
    for (const k of FEATURE_KEYS) {
      for (const c of visibleDock({ isStaff: true, features: off(k) }).flatMap((s) => s.children)) expect(c.techOnly, c.id).toBeFalsy();
      for (const c of visibleDock({ isStaff: false, features: off(k) }).flatMap((s) => s.children)) expect(c.staffOnly, c.id).toBeFalsy();
    }
  });

  it("a tech never gains a row from a switch (no staff-only door appears)", () => {
    const tech = new Set(rows(legacy(false)));
    for (const k of FEATURE_KEYS) for (const id of rows(visibleDock({ isStaff: false, features: off(k) }))) expect(tech.has(id), id).toBe(true);
  });
});

describe("the Jobs status rows are Title Case (cn-v1128, Erik's law for every clickable)", () => {
  it("To Be Scheduled, In Progress, On Hold — never a sentence-case row", () => {
    const jobs = DOCK.find((s) => s.children.some((c) => c.href === "/jobs"))!;
    const rows = jobs.children.filter((c) => c.href?.startsWith("/jobs?status="));
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(r.label, r.label).toMatch(/^([A-Z][a-z]*)( [A-Z][a-z]*)*$/);
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(["To Be Scheduled", "In Progress", "On Hold"]));
  });
});

/**
 * A PAGE DECLARES ITS HOME (activeNav): the matcher's one new rule.
 *
 * Erik, 2026-11-10: "the sub-nav disappears when an inspection is clicked." /appointments/<id> is a
 * real page no cluster owns by its URL (the Schedule tile's note had the whole family down as a
 * redirect), and the URL cannot say whether the visit is an inspection (Sales › Inspections) or a
 * booking on the Schedule. The page has read the row, so it names the dock row it lives under
 * (components/nav-home), and the one matcher uses that ONLY when the pathname matches no cluster.
 */
describe("activeNav — the pathname first, then the home the page declared, else nothing", () => {
  const staff = visibleDock({ isStaff: true });
  const tech = visibleDock({ isStaff: false });
  const at = (pathname: string, home?: string | null, current = pathname): NavAt => ({ pathname, current, home });
  const lit = (a: NavAt, sections = staff) => {
    const { section, rowHref } = activeNav(a, sections);
    return `${section?.key ?? "-"}>${rowHref ?? "-"}`;
  };

  it("a visit's own page matches no cluster by its URL (the mechanism of the report)", () => {
    for (const sections of [staff, tech, DOCK]) expect(activeSection("/appointments/abc123", sections)).toBeUndefined();
    expect(lit(at("/appointments/abc123"))).toBe("->-");
  });

  it("an unmatched pathname with a declared home lights that cluster and that row", () => {
    expect(lit(at("/appointments/abc123", "sl-inspections"))).toBe("sales>/inspections");
    expect(lit(at("/appointments/abc123", "s-week"))).toBe("schedule>/schedule");
    // Sales' sub-nav is its four rows with Inspections lit; the Schedule has one row, so no sub-nav.
    const sales = activeNav(at("/appointments/abc123", "sl-inspections"), staff).section!;
    expect(sales.children.filter((c) => c.href).map((c) => c.id)).toEqual(["sl-leads", "sl-inspections", "sl-quotes", "sl-customers"]);
    expect(activeNav(at("/appointments/abc123", "s-week"), staff).section!.children.filter((c) => c.href)).toHaveLength(1);
    // A tech's visit lives on My Day.
    expect(lit(at("/appointments/abc123", "t-day"), tech)).toBe("today>/planner");
  });

  it("a pathname that matches a cluster IGNORES the declared home", () => {
    for (const home of ["sl-inspections", "s-week", "t-day", "m-inv", "no-such-row"]) {
      expect(lit(at("/billing/abc123", home)), home).toBe("invoices>-");
      expect(lit(at("/billing", home)), home).toBe("invoices>/billing");
      expect(lit(at("/jobs", home, "/jobs?status=in_progress")), home).toBe("jobs>/jobs?status=in_progress");
      expect(lit(at("/inspections", home)), home).toBe("sales>/inspections");
    }
    // The estimate a visit opens keeps Sales by its own URL, whatever is or is not declared.
    for (const home of [undefined, null, "s-week"]) {
      expect(activeNav(at("/quotes/new", home, "/quotes/new?capture=abc123"), staff).section?.key).toBe("sales");
      expect(activeNav(at("/quotes/abc123", home), staff).section?.key).toBe("sales");
    }
  });

  it("no declared home, no sub-nav: every route answers exactly as activeSection and activeRowHref did", () => {
    const routes = [
      ...DOCK.flatMap((s) => s.children).flatMap((c) => (c.href ? [c.href] : [])),
      "/quotes/abc123", "/quotes/new?capture=abc123", "/jobs/abc123", "/billing/abc123", "/billing/ar", "/crm/abc123",
      "/purchasing/abc123", "/forms/abc123", "/tasks/site-prep", "/timeclock/abc123", "/settings", "/settings?tab=you",
      "/work-orders/abc123", "/materials/abc123", "/appointments/abc123", "/definitely-not-a-route",
    ];
    for (const sections of [staff, tech, visibleDock({ isStaff: true, features: off("leads", "estimates") })]) {
      for (const current of routes) {
        const pathname = basePath(current);
        const section = activeSection(pathname, sections);
        const before = { section, rowHref: section ? activeRowHref(section.children, pathname, current) : undefined };
        for (const home of [undefined, null]) expect(activeNav({ pathname, current, home }, sections), current).toEqual(before);
        // And on a route a cluster owns, a declared home changes nothing either.
        if (section) expect(activeNav({ pathname, current, home: "sl-inspections" }, sections), current).toEqual(before);
      }
    }
  });

  it("a home this person's dock does not draw lights nothing, as its own page does", () => {
    // A tech has no Sales and no Schedule.
    expect(lit(at("/appointments/abc123", "sl-inspections"), tech)).toBe("->-");
    expect(lit(at("/appointments/abc123", "s-week"), tech)).toBe("->-");
    // Leads off puts the Inspections row away, and /inspections itself lights nothing then.
    const leadsOff = visibleDock({ isStaff: true, features: off("leads") });
    expect(lit(at("/appointments/abc123", "sl-inspections"), leadsOff)).toBe("->-");
    expect(activeSection("/inspections", leadsOff)).toBeUndefined();
    // A lapsed company's dock is the Plan tile alone.
    expect(lit(at("/appointments/abc123", "sl-inspections"), visibleDock({ isStaff: true, lapsed: true }))).toBe("->-");
    // A heading is not a page, and an id nothing has is not a home.
    expect(lit(at("/appointments/abc123", "m-billing-h"))).toBe("->-");
    expect(lit(at("/appointments/abc123", "no-such-row"))).toBe("->-");
  });

  it("the rail and the strip read ONE location and ONE matcher, never the router on their own", () => {
    for (const file of ["src/components/app-shell/dock.tsx", "src/components/section-subnav.tsx"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, file).toContain("const at = useNavAt(sections);");
      expect(src, file).toMatch(/= activeNav\(at, sections\);/);
      expect(src, file).not.toContain('from "next/navigation"');
      expect(src, file).not.toMatch(/import \{[^}]*\b(activeSection|activeRowHref)\b[^}]*\} from "@\/lib\/dock"/);
    }
  });
});

/**
 * NOTHING IN THE NAV MOVES WHILE A DECLARING PAGE IS ON ITS WAY (awaitsHome, navDrawnAt).
 *
 * The declaration arrives WITH the page. Between the tap and the page there is the loading
 * spinner, already on the new URL, with nobody yet to say where it lives: without the hold, opening
 * an inspection from its own list would still blink the sub-nav out and back. So for a route whose
 * page declares, the nav stays on the last location that had settled until the page speaks.
 */
describe("awaitsHome and navDrawnAt — the last settled location holds until the page says where it lives", () => {
  const staff = visibleDock({ isStaff: true });
  const tech = visibleDock({ isStaff: false });
  const at = (pathname: string, home?: string | null, current = pathname): NavAt => ({ pathname, current, home });
  const shown = (a: NavAt, sections = staff) => {
    const { section, rowHref } = activeNav(a, sections);
    return `${section?.key ?? "-"}>${rowHref ?? "-"}`;
  };
  const spinner = at("/appointments/abc123");
  const inspection = at("/appointments/abc123", "sl-inspections");

  it("waits only on a route whose page declares, only until it has, and never where a cluster owns the URL", () => {
    expect(awaitsHome(spinner, staff)).toBe(true);
    expect(awaitsHome(at("/appointments/abc123", null), staff)).toBe(true);
    expect(awaitsHome(inspection, staff)).toBe(false);
    // A home this person's dock does not draw is still an answer: the wait is over.
    expect(awaitsHome(inspection, tech)).toBe(false);
    for (const p of ["/inspections", "/quotes/abc123", "/jobs/abc123", "/work-orders/abc123", "/settings", "/appointments", "/appointments-old/abc123"]) {
      expect(awaitsHome(at(p), staff), p).toBe(false);
    }
  });

  it("opening an inspection from its list: Sales › Inspections through the spinner, and the page says the same", () => {
    const list = at("/inspections");
    expect(shown(navDrawnAt(list, null, staff))).toBe("sales>/inspections");
    expect(navDrawnAt(spinner, list, staff)).toBe(list);
    expect(shown(navDrawnAt(spinner, list, staff))).toBe("sales>/inspections");
    expect(navDrawnAt(inspection, list, staff)).toBe(inspection);
    expect(shown(navDrawnAt(inspection, list, staff))).toBe("sales>/inspections");
  });

  it("from My Day or the Schedule the lit tile stays lit until the page speaks, then the visit's own lights", () => {
    for (const from of [at("/planner"), at("/schedule", null, "/schedule?view=day&date=2026-11-12")]) {
      const held = navDrawnAt(spinner, from, staff);
      expect(held).toBe(from);
      expect(shown(navDrawnAt(inspection, from, staff))).toBe("sales>/inspections");
      expect(shown(navDrawnAt(at("/appointments/abc123", "s-week"), from, staff))).toBe("schedule>/schedule");
    }
    expect(shown(navDrawnAt(spinner, at("/planner"), staff))).toBe("today>/planner");
  });

  it("the whole location is held, so a rule that reads the pathname answers as it did (no Jobs strip on a job's page)", () => {
    const job = at("/jobs/abc123");
    expect(navDrawnAt(spinner, job, staff)).toBe(job);
    expect(navDrawnAt(spinner, job, staff).pathname.startsWith("/jobs/")).toBe(true);
    const strip = readFileSync(join(process.cwd(), "src/components/section-subnav.tsx"), "utf8");
    expect(strip).toContain('if (group.key === "jobs" && at.pathname.startsWith("/jobs/")) return null;');
  });

  it("a hard load straight onto a visit: nothing settled, so nothing lit until the page speaks", () => {
    expect(navDrawnAt(spinner, null, staff)).toBe(spinner);
    expect(shown(navDrawnAt(spinner, null, staff))).toBe("->-");
  });

  it("lets go at once on a page that declares nothing, and from one visit to the next holds the last one's", () => {
    const workOrder = at("/work-orders/abc123");
    expect(navDrawnAt(workOrder, inspection, staff)).toBe(workOrder);
    expect(shown(navDrawnAt(workOrder, inspection, staff))).toBe("->-");
    const next = at("/appointments/def456");
    expect(navDrawnAt(next, inspection, staff)).toBe(inspection);
  });

  it("the hook settles a location only in an effect, only while it is not itself waiting, and draws navDrawnAt", () => {
    const hook = readFileSync(join(process.cwd(), "src/components/app-shell/use-nav-at.ts"), "utf8");
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*if \(!waiting\) settled = now;\s*\}\);/);
    expect(hook).toContain("return navDrawnAt(now, settled, sections);");
    // A declaration counts only on the pathname it was made on: the next page never wears the last one's.
    expect(hook).toContain("home: declared && declared.pathname === pathname ? declared.id : null,");
  });

  it("every route family that declares has a page that does, first thing it draws, on a prefix no cluster owns", () => {
    expect(DECLARES_HOME).toEqual(["/appointments"]);
    for (const base of DECLARES_HOME) {
      for (const sections of [DOCK, staff, tech]) expect(activeSection(`${base}/abc123`, sections), base).toBeUndefined();
      const file = join(process.cwd(), `src/app/(app)${base}/[id]/page.tsx`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8"), file).toMatch(/<div className="mx-auto max-w-2xl">\s*<NavHome id=\{home\.nav\} \/>/);
    }
  });
});
