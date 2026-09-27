import { describe, it, expect } from "vitest";
import { DOCK, activeSection, basePath, visibleDock } from "@/lib/dock";
import { ALL_ON, FEATURE_KEYS, normalizeFeatures, type FeatureKey, type FeatureMap } from "@/lib/features";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

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

/** Drift guard #2: the time doors. Schedule (the WHEN-WILL map) lives under TODAY, right
 *  after My day — it sat as Clock's 3rd pill, a planning surface hidden behind the
 *  timeclock's impulse door (the time-section gut's "lostness cause a"). Clock keeps
 *  exactly the WHEN-DID pair. This pins placement, gating AND zero-duplication so a
 *  future wave can't quietly file the calendar behind the clock again. */
describe("DOCK time doors — Schedule between Today and Clock, Clock keeps the when-did pair", () => {
  const clock = DOCK.find((s) => s.key === "clock");

  it("Schedule is its OWN tile, directly between Today and Clock, office-only", () => {
    // Erik, verbatim: "Move: Schedule - to main dock after Today before Clock". It had been a
    // child pill under Today; the man planning a week lives there too much for one level down.
    const keys = DOCK.map((s) => s.key);
    expect(keys.indexOf("schedule")).toBe(keys.indexOf("today") + 1);
    expect(keys.indexOf("clock")).toBe(keys.indexOf("schedule") + 1);
    expect(DOCK.find((s) => s.key === "schedule")).toMatchObject({ href: "/schedule", staffOnly: true });
  });

  it("Clock holds exactly Timeclock + Timecards — no planning surface behind the clock door", () => {
    expect((clock?.children ?? []).map((c) => c.href)).toEqual(["/timeclock", "/timecards"]);
  });

  it("zero duplication: /schedule has exactly one dock home", () => {
    const homes = DOCK.flatMap((s) => s.children).filter(
      (c) => c.href && basePath(c.href) === "/schedule",
    );
    expect(homes.map((c) => c.id)).toEqual(["s-week"]);
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
 *  site-walk-through step between a lead and its estimate). Pins presence, order and the
 *  zero-duplication law so a future wave can't drop the tab or double-home /inspections. */
describe("DOCK sales — Leads · Inspections · Estimates", () => {
  const sales = DOCK.find((s) => s.key === "sales");
  const children = sales?.children ?? [];

  it("children are exactly Leads · Inspections · Estimates, in pipeline order", () => {
    expect(children.map((c) => c.href)).toEqual(["/leads", "/inspections", "/quotes"]);
    expect(children.find((c) => c.id === "sl-inspections")).toMatchObject({
      label: "Inspections",
      href: "/inspections",
    });
  });

  it("zero duplication: /inspections has exactly one dock home", () => {
    const homes = DOCK.flatMap((s) => s.children).filter(
      (c) => c.href && basePath(c.href) === "/inspections",
    );
    expect(homes.map((c) => c.id)).toEqual(["sl-inspections"]);
  });

  it("/inspections (and its completed view path) lights Sales", () => {
    expect(activeSection("/inspections")?.key).toBe("sales");
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

  it("/schedule lights its OWN tile now; the when-did pair still lights Clock", () => {
    expect(key("/schedule")).toBe("schedule");
    expect(key("/timeclock")).toBe("clock");
    expect(key("/timecards")).toBe("clock");
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
    const techSections = DOCK.filter((s) => !s.staffOnly);
    expect(activeSection("/quotes/abc123", techSections)).toBeUndefined();
    expect(activeSection("/timeclock", techSections)?.key).toBe("clock");
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
  const staff = DOCK.filter((s) => !s.techOnly);
  const tech = DOCK.filter((s) => !s.staffOnly);

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

  it("renders no page column — it has no children, and the column needs more than one", () => {
    expect(DOCK.find((s) => s.key === "you")?.children).toEqual([]);
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
  const STAFF_REDIRECTS = ["/team", "/schedule", "/leads", "/billing", "/crm", "/organize"];

  it("is Today, Clock, Jobs, Office, You and Tools", () => {
    expect(tech.map((s) => s.key)).toEqual(["today", "clock", "jobs", "office", "you", "tools"]);
  });

  it("never lands on a page that sends a tech away", () => {
    for (const s of tech) {
      expect(STAFF_REDIRECTS).not.toContain(basePath(s.href));
      for (const c of s.children) if (c.href) expect(STAFF_REDIRECTS).not.toContain(basePath(c.href));
    }
  });

  it("keeps his Office doors: Forms, Resources, the Handbook and the read-only Liabilities pages", () => {
    const office = tech.find((s) => s.key === "office")!;
    expect(office.href).toBe("/compliance");
    expect(office.children.filter((c) => c.href).map((c) => c.href)).toEqual([
      "/compliance", "/insurance", "/safety", "/audits", "/forms", "/resources", "/handbook",
    ]);
    // Staff still land on Team, as Erik set it.
    expect(visibleDock({ isStaff: true }).find((s) => s.key === "office")?.href).toBe("/team");
  });

  it("carries no bug door: Bug Watch is North's, in the avatar menu for platform admins", () => {
    const all = DOCK.flatMap((s) => [s, ...s.children]);
    expect(all.some((n) => n.href && basePath(n.href) === "/bugs")).toBe(false);
    expect(all.some((n) => n.label === "Diagnostics")).toBe(false);
  });

  it("shows a tech only My Day and Tasks under Today", () => {
    const today = DOCK.find((s) => s.key === "today")!;
    expect(today.children.filter((c) => !c.staffOnly).map((c) => c.label)).toEqual(["My Day", "Tasks"]);
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
  // command-bar.tsx): staffOnly/techOnly on tiles, staffOnly on rows. A tech's Office lands on its
  // first row he sees, not on staff-only Team (which bounced him).
  const legacy = (isStaff: boolean): Sections =>
    DOCK.filter((s) => (isStaff || !s.staffOnly) && (!isStaff || !s.techOnly)).map((s) => ({
      ...s,
      href: !isStaff && s.key === "office" ? "/compliance" : s.href,
      children: s.children.filter((c) => isStaff || !c.staffOnly),
    }));
  const off = (...keys: FeatureKey[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
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
    expect(tile(d, "sales")?.children.map((c) => c.id)).toEqual(["sl-quotes"]);
    expect(tile(d, "sales")?.href).toBe("/quotes");
  });

  it("Leads and Estimates both off: the Sales tile is gone (Contacts stays)", () => {
    const d = visibleDock({ isStaff: true, features: off("leads", "estimates") });
    expect(tile(d, "sales")).toBeUndefined();
    expect(tile(d, "contacts")).toBeDefined();
  });

  it("Estimates off alone: Sales keeps its landing page (/leads) and loses only the row", () => {
    const d = visibleDock({ isStaff: true, features: off("estimates") });
    expect(tile(d, "sales")?.href).toBe("/leads");
    expect(tile(d, "sales")?.children.map((c) => c.id)).toEqual(["sl-leads", "sl-inspections"]);
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
    // A tech loses the Handbook too (he sees it today) and keeps everything else he had.
    const tech = visibleDock({ isStaff: false, features: off("crew_payroll") });
    expect(rows(tech)).not.toContain("o-handbook");
    expect(rows(tech)).toEqual(rows(legacy(false)).filter((id) => id !== "o-handbook"));
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

  it("the tech-only You tile survives any switch (it never had rows)", () => {
    const everythingOff = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])) as FeatureMap;
    expect(tile(visibleDock({ isStaff: false, features: everythingOff }), "you")).toBeDefined();
  });

  it("a tech never gains a row from a switch (no staff-only door appears)", () => {
    const tech = new Set(rows(legacy(false)));
    for (const k of FEATURE_KEYS) for (const id of rows(visibleDock({ isStaff: false, features: off(k) }))) expect(tech.has(id), id).toBe(true);
  });
});
