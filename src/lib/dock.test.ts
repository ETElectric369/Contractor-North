import { describe, it, expect } from "vitest";
import { DOCK, activeSection, basePath } from "@/lib/dock";
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
    // After the statuses: exactly Permits + Plans & LiDAR, staff-only, no header, and NO
    // resurrected cross-job list links (those records are reached through the job's tabs).
    const rest = children.slice(JOB_STATUSES.length);
    // Plans & LiDAR left too (Erik 2026-07-14: plans live with the estimator's Upload Plans;
    // LiDAR ships with the native app) — Permits is the one surviving cross-job link.
    expect(rest.map((c) => c.id)).toEqual(["j-permits"]);
    expect(rest.every((c) => c.staffOnly && !c.header)).toBe(true);
    for (const gone of ["/work-orders", "/materials", "/change-orders"]) {
      expect(children.some((c) => c.href && basePath(c.href) === gone)).toBe(false);
    }
  });
});

/** Drift guard #2: the time doors. Schedule (the WHEN-WILL map) lives under TODAY, right
 *  after My day — it sat as Clock's 3rd pill, a planning surface hidden behind the
 *  timeclock's impulse door (the time-section gut's "lostness cause a"). Clock keeps
 *  exactly the WHEN-DID pair. This pins placement, gating AND zero-duplication so a
 *  future wave can't quietly file the calendar behind the clock again. */
describe("DOCK time doors — Schedule under Today, Clock keeps the when-did pair", () => {
  const today = DOCK.find((s) => s.key === "today");
  const clock = DOCK.find((s) => s.key === "clock");

  it("Schedule sits directly after 'My day' in Today, office-only (/schedule redirects techs)", () => {
    const ids = (today?.children ?? []).map((c) => c.id);
    expect(ids.indexOf("t-sched")).toBe(ids.indexOf("t-day") + 1);
    expect(today?.children.find((c) => c.id === "t-sched")).toMatchObject({
      href: "/schedule",
      staffOnly: true,
    });
  });

  it("Clock holds exactly Timeclock + Timecards — no planning surface behind the clock door", () => {
    expect((clock?.children ?? []).map((c) => c.href)).toEqual(["/timeclock", "/timecards"]);
  });

  it("zero duplication: /schedule has exactly one dock home", () => {
    const homes = DOCK.flatMap((s) => s.children).filter(
      (c) => c.href && basePath(c.href) === "/schedule",
    );
    expect(homes.map((c) => c.id)).toEqual(["t-sched"]);
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
    expect(activeSection("/settings")).toBeUndefined();
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

  it("/schedule lights Today (the dock move); the when-did pair still lights Clock", () => {
    expect(key("/schedule")).toBe("today");
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

  it("the team roster lights Office; settings lights NOTHING (its own territory)", () => {
    expect(key("/team")).toBe("office");
    expect(key("/settings")).toBeUndefined(); // owned by no dock section — its own side-tab drives it
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
