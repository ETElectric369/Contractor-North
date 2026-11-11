import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visitHome } from "@/lib/appointments/visit-home";
import { APPOINTMENT_TYPES, ESTIMATE_VISIT_TYPES } from "@/lib/statuses";
import { DOCK, activeNav, basePath, visibleDock } from "@/lib/dock";

/**
 * WHERE A VISIT LIVES (lib/appointments/visit-home): the one rule behind two things Erik reported
 * together on 2026-11-10 — "i deleted a couple inspections and instead of going back to the
 * inspection page it goes to" the app's 404, "and the sub-nav disappears when an inspection is
 * clicked". The visit's page lights the dock row the rule names, and a visit deleted or cancelled
 * from its own page lands on that row's page.
 */
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("visitHome — the visit's type decides, nothing else", () => {
  it("an inspection, a final inspection or a quote visit lives on Sales › Inspections, whatever its day", () => {
    expect([...ESTIMATE_VISIT_TYPES]).toEqual(["inspection", "final_inspection", "quote"]);
    for (const type of ESTIMATE_VISIT_TYPES) {
      for (const day of [undefined, null, "", "2026-11-12"]) {
        expect(visitHome(type, { day }), `${type} ${day}`).toEqual({ nav: "sl-inspections", href: "/inspections" });
      }
    }
  });

  it("every other booking lives on the Schedule: on its own day when it has one, else the Schedule itself", () => {
    const others = APPOINTMENT_TYPES.filter((t) => !(ESTIMATE_VISIT_TYPES as readonly string[]).includes(t));
    expect(others).toEqual(["service_call", "job", "call", "meeting", "appointment", "other"]);
    for (const type of [...others, null, undefined, "", "a-kind-from-next-year"]) {
      expect(visitHome(type, { day: "2026-11-12" }), String(type)).toEqual({ nav: "s-week", href: "/schedule?view=day&date=2026-11-12" });
      expect(visitHome(type), String(type)).toEqual({ nav: "s-week", href: "/schedule" });
    }
    // A visit waiting for a day has none; a day that is not a day is never put in an address.
    for (const day of [null, "", "tomorrow", "2026-11-12T08:00:00Z", "2026-11-12&x=1"]) {
      expect(visitHome("job", { day }).href, String(day)).toBe("/schedule");
    }
  });

  it("a tech has neither door: his visits are on My Day, whatever the kind", () => {
    for (const type of [...APPOINTMENT_TYPES, null]) {
      expect(visitHome(type, { day: "2026-11-12", staff: false }), String(type)).toEqual({ nav: "t-day", href: "/planner" });
    }
    // Staff is the default: the doors that delete or cancel a visit are the office's.
    expect(visitHome("inspection")).toEqual(visitHome("inspection", { staff: true }));
  });

  it("the Inspections list holds exactly the kinds the rule sends there", () => {
    expect(src("src/app/(app)/inspections/page.tsx")).toContain('.in("type", [...ESTIMATE_VISIT_TYPES])');
  });
});

describe("the two readers agree: the row the page lights is the row of the page it lands on", () => {
  const rows = DOCK.flatMap((s) => s.children);
  const cases = [
    { type: "inspection", staff: true, day: "2026-11-12" },
    { type: "quote", staff: true, day: null },
    { type: "job", staff: true, day: "2026-11-12" },
    { type: "other", staff: true, day: null },
    { type: "inspection", staff: false, day: "2026-11-12" },
  ];

  it("every nav id is a real dock row, and the landing address is that row's own page", () => {
    for (const c of cases) {
      const home = visitHome(c.type, { day: c.day, staff: c.staff });
      const row = rows.find((r) => r.id === home.nav);
      expect(row?.href, home.nav).toBeTruthy();
      expect(basePath(home.href), home.nav).toBe(row!.href);
    }
  });

  it("on the visit's page (by declaration) and on the page it lands on (by URL) the same cluster and row are lit", () => {
    for (const c of cases) {
      const sections = visibleDock({ isStaff: c.staff });
      const home = visitHome(c.type, { day: c.day, staff: c.staff });
      const onThePage = activeNav({ pathname: "/appointments/abc123", current: "/appointments/abc123", home: home.nav }, sections);
      const whereItLands = activeNav({ pathname: basePath(home.href), current: home.href }, sections);
      expect(onThePage.section?.key, home.nav).toBeTruthy();
      expect(onThePage.section?.key, home.nav).toBe(whereItLands.section?.key);
      expect(onThePage.rowHref, home.nav).toBe(whereItLands.rowHref);
    }
  });

  it("the visit's page reads the rule once, off the row it already holds, and hands it to both", () => {
    const page = src("src/app/(app)/appointments/[id]/page.tsx");
    expect(page).toContain("const home = visitHome(a.type, { day: dayStr, staff: viewerIsStaff });");
    expect(page).toContain("<NavHome id={home.nav} />");
    expect(page).toContain("afterDeleteHref={home.href}");
    expect(page).toContain("<WontHappenRow id={a.id} deletes={wontHappenDeletes} afterHref={home.href} />");
  });
});
