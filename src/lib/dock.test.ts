import { describe, it, expect } from "vitest";
import { DOCK, activeRowHref, activeSection, basePath, dockTiles, menuSections, visibleDock } from "@/lib/dock";
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

  it("exists, statuses first — the 'All Jobs' firehose is gone (Erik 2026-07: brain clutter)", () => {
    expect(jobs).toBeDefined();
    expect(children[0]?.href).toBe(`/jobs?status=${JOB_STATUSES[0]}`);
    expect(children.some((c) => c.href === "/jobs")).toBe(false);
  });

  it("hrefs cover every job status, in lifecycle order (cancelled last)", () => {
    expect(statusChildren.map((c) => c.href)).toEqual(JOB_STATUSES.map((s) => `/jobs?status=${s}`));
  });

  it("labels derive from jobStatusLabel (no hand-written label drift)", () => {
    expect(statusChildren.map((c) => c.label.toLowerCase())).toEqual(
      JOB_STATUSES.map((s) => jobStatusLabel(s)),
    );
  });

  it("statuses lead; only Permits + Plans follow (WO/Materials/CO are hub-only — Erik: 'Across all jobs GO AWAY')", () => {
    expect(children.slice(0, JOB_STATUSES.length).map((c) => c.id)).toEqual(
      JOB_STATUSES.map((s) => `j-${s}`),
    );
    // Statuses are for everyone (techs filter their own job list) — never staff-gated.
    expect(statusChildren.every((c) => !c.staffOnly)).toBe(true);
    // After the statuses: NOTHING. Every cross-job list link is gone — those records are
    // reached through the job's own tabs. Permits left last (Erik 2026-07-20: "permits live
    // with the job like materials"); Plans & LiDAR left 2026-07-14.
    const rest = children.slice(JOB_STATUSES.length);
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

  it("Timecards lives under Money, right after Invoices, office-only, and owns /timeclock", () => {
    const money = DOCK.find((s) => s.key === "invoices")!.children;
    const at = money.findIndex((c) => c.id === "ck-cards");
    expect(money[at]).toMatchObject({ label: "Timecards", href: "/timecards", staffOnly: true, owns: ["/timeclock"] });
    expect(money[at - 1]?.id).toBe("m-inv");
    expect(money[at + 1]?.id).toBe("m-bills");
  });

  /**
   * ONE INVOICES PAGE (W1-29): Accounts Receivable and Payments folded into /billing (By Customer and
   * Payments In), and their old routes redirect there, so they have no row. PETTY CASH LEFT THE MENU
   * (W1-34): a company with rows finds it in Search Or Ask. No new badge: the Money tile carries none.
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

/** Drift guard #2c: the Sales pipeline order — Leads · Walk-Throughs · Estimates (Erik
 *  2026-07-14: appointments and walk-throughs are ONE platform; the Walk-Throughs tab is the
 *  site-visit step between a lead and its estimate), then Customers, the Contacts tile
 *  folded in (W1-07). Pins presence, order and the zero-duplication law. */
describe("DOCK sales — Leads · Walk-Throughs · Estimates · Customers", () => {
  const sales = DOCK.find((s) => s.key === "sales");
  const children = sales?.children ?? [];

  it("children are exactly Leads · Walk-Throughs · Estimates · Customers, in pipeline order", () => {
    expect(children.map((c) => c.href)).toEqual(["/leads", "/inspections", "/quotes", "/crm"]);
    // One word for the site visit (W2-10): the row reads Walk-Throughs; the route and the id stay.
    expect(children.find((c) => c.id === "sl-inspections")).toMatchObject({
      label: "Walk-Throughs",
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

  it("two rows on one page light nothing rather than guess (bare /jobs)", () => {
    expect(activeRowHref(rows("jobs", true), "/jobs", "/jobs")).toBeUndefined();
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

  it("Leads off: Leads and Walk-Throughs go, and Sales lands on Estimates", () => {
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
    // Forms is not a Safety Log door: it also holds the walk-through sheet and the intake form.
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
