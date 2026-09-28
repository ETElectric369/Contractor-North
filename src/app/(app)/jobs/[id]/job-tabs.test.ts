import { describe, it, expect, vi } from "vitest";
import { createElement, Fragment, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB PAGE'S TABS AND THE SWITCH BOARD (0352). A switched-off feature's tab loses its chip
 * (offStrip) and still opens from a ?tab= link, with the Off line on top of exactly the content it
 * always had. With no switches stored (everything on) the strip is byte-for-byte what it was.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/jobs/j1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { arrangeJobTabs, JOB_PINNED_STAFF, JOB_PINNED_TECH, JOB_STAFF_ONLY, JOB_TAB_FEATURE, JOB_TAB_ORDER, JOB_TECH_ADDABLE } from "./job-tabs";
import { ALL_ON, FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import { MoreMenuRows, Tabs, type TabDef } from "@/components/tabs";

const body = (id: string) => createElement("p", { "data-body": id }, `${id}-BODY`);
const TABS: TabDef[] = JOB_TAB_ORDER.map((id) => ({ id, label: id, content: body(id) }));
const off = (...keys: (keyof FeatureMap)[]): FeatureMap => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) });
const html = (n: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, n));
const byId = (tabs: TabDef[]) => Object.fromEntries(tabs.map((t) => [t.id, t]));

describe("arrangeJobTabs with every feature on", () => {
  for (const staff of [true, false]) {
    it(`${staff ? "staff" : "a tech"}: nothing is off the strip, and every tab's content is untouched`, () => {
      for (const arranged of [arrangeJobTabs(TABS, staff), arrangeJobTabs(TABS, staff, { features: ALL_ON, isOwner: true })]) {
        expect(arranged.filter((t) => t.offStrip).map((t) => t.id)).toEqual([]);
        for (const t of arranged) expect(t.content).toBe(TABS.find((x) => x.id === t.id)!.content);
      }
    });
  }
});

describe("the Tasks chip (Erik, 2026-09-26: \"put it on the bottom bar next to overview\")", () => {
  const pinnedIds = (staff: boolean) =>
    arrangeJobTabs(TABS, staff)
      .filter((t) => !t.staffOnly || staff)
      .filter((t) => t.pinned && !t.offStrip)
      .map((t) => t.id);

  it("the office: Overview, Tasks, Time, Materials, Costs — Tasks right after Overview", () => {
    expect(pinnedIds(true)).toEqual(["job", "tasks", "time", "materials", "costs"]);
  });

  it("the crew: Overview, Tasks, Time, Materials, Photos — the same place, no money chip", () => {
    expect(pinnedIds(false)).toEqual(["job", "tasks", "time", "materials", "photos"]);
    for (const id of JOB_PINNED_TECH) expect(JOB_STAFF_ONLY.has(id), id).toBe(false);
  });

  it("six chips on a phone, never seven: five pinned + More for both (7 would be 43.9px at 375)", () => {
    expect(JOB_PINNED_STAFF.size).toBe(5);
    expect(JOB_PINNED_TECH.size).toBe(5);
  });

  it("the office's last pinned chip, Invoices, rides More (its Money cluster), never gone", () => {
    const inv = byId(arrangeJobTabs(TABS, true)).invoices;
    expect(inv.pinned).toBe(false);
    expect(inv.offStrip).toBe(false);
    expect(inv.group).toBe("Money");
  });

  it("Tasks is a real chip for both roles: pinned, on the strip, not staff-only, its own icon", () => {
    for (const staff of [true, false]) {
      const t = byId(arrangeJobTabs(TABS, staff)).tasks;
      expect(t.pinned).toBe(true);
      expect(t.offStrip).toBe(false);
      expect(t.staffOnly).toBe(false);
      expect(t.icon).toBeTruthy();
    }
    expect(JOB_TAB_ORDER.indexOf("tasks")).toBe(JOB_TAB_ORDER.indexOf("job") + 1);
  });
});

describe("a switched-off feature's tab", () => {
  it("every switch-owned tab is a real tab and never a pinned one", () => {
    const allOff = arrangeJobTabs(TABS, true, { features: off(...FEATURE_KEYS), isOwner: true });
    for (const id of Object.keys(JOB_TAB_FEATURE)) expect(JOB_TAB_ORDER).toContain(id);
    for (const t of allOff) if (t.pinned) expect(t.offStrip, t.id).toBe(false);
    for (const t of arrangeJobTabs(TABS, false, { features: off(...FEATURE_KEYS), isOwner: false }))
      if (t.pinned) expect(t.offStrip, t.id).toBe(false);
  });

  for (const [tab, feature] of Object.entries(JOB_TAB_FEATURE)) {
    it(`${feature} off: "${tab}" loses its chip, opens by link with the Off line over the same content`, () => {
      const t = byId(arrangeJobTabs(TABS, true, { features: off(feature), isOwner: true }))[tab];
      expect(t.offStrip).toBe(true);
      const out = html(t.content);
      expect(out).toContain(`${tab}-BODY`);
      expect(out).toContain(" · Off");
      expect(out).toMatch(/>Turn On</);
      // The Off line comes first, on top of the tab.
      expect(out.indexOf(" · Off")).toBeLessThan(out.indexOf(`${tab}-BODY`));
      // Nothing else moved.
      const rest = arrangeJobTabs(TABS, true, { features: off(feature), isOwner: true }).filter(
        (x) => x.offStrip && JOB_TAB_FEATURE[x.id] !== feature,
      );
      expect(rest).toEqual([]);
    });
  }

  it("a sub-switch's parent counts: Estimates off takes Change Orders and Work Orders too", () => {
    const t = byId(arrangeJobTabs(TABS, true, { features: off("estimates"), isOwner: true }));
    expect([t.quotes.offStrip, t["change-orders"].offStrip, t.wos.offStrip]).toEqual([true, true, true]);
  });

  it("a tech sees the Off line with no button: only the owner can turn a switch on", () => {
    const t = byId(arrangeJobTabs(TABS, false, { features: off("permits", "panel_map"), isOwner: false }));
    for (const id of ["permits", "panel"]) {
      const out = html(t[id].content);
      expect(out).toContain(" · Off · Ask The Owner");
      expect(out).not.toContain("<button");
    }
  });

  it("the money tabs stay staff-only whatever the switches say", () => {
    const t = byId(arrangeJobTabs(TABS, false, { features: off("estimates", "customer_portal"), isOwner: false }));
    for (const id of ["quotes", "change-orders", "customer", "costs", "invoices"]) expect(t[id].staffOnly, id).toBe(true);
    expect(isValidElement(t.quotes.content)).toBe(true);
  });
});

describe("More shows what the job has, plus one + Add… (W1-18)", () => {
  /** The page's tabs with `holds` set: true for the ids given, false for every other. */
  const holding = (ids: string[]) => TABS.map((t) => ({ ...t, holds: ids.includes(t.id) }));
  /** What the strip hands More: this viewer's tabs, minus pinned chips and offStrip ones (TabBar's own filter). */
  const moreItems = (arranged: TabDef[], staff: boolean) => arranged.filter((t) => (!t.staffOnly || staff) && !t.offStrip && !t.pinned);
  const rows = (items: TabDef[], view: "main" | "add" = "main") =>
    renderToStaticMarkup(createElement(MoreMenuRows, { items, view, tile: true }));
  const labels = (html: string) => Array.from(html.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)).map((m) => m[1]);

  it("no notes tab: the notes are the Overview's second box (W1-21)", () => {
    expect(JOB_TAB_ORDER).not.toContain("notes");
  });

  it("tucked is false for pinned and offStrip tabs; with no holds said, nothing is tucked", () => {
    for (const staff of [true, false]) {
      for (const t of arrangeJobTabs(holding([]), staff, { features: off("permits", "customer_portal"), isOwner: true })) {
        if (t.pinned || t.offStrip) expect(t.tucked, t.id).toBe(false);
      }
      expect(arrangeJobTabs(TABS, staff).filter((t) => t.tucked)).toEqual([]);
    }
  });

  it("a new job's office More is only + Add…, and + Add… lists every empty tab by name", () => {
    const items = moreItems(arrangeJobTabs(holding([]), true), true);
    const main = rows(items);
    expect(labels(main)).toEqual(["Add…"]);
    const add = rows(items, "add");
    expect(labels(add)[0]).toBe("More");
    expect(labels(add).slice(1).sort()).toEqual(items.map((t) => t.label).sort());
    expect(items.map((t) => t.id).sort()).toEqual(["appointments", "change-orders", "customer", "invoices", "permits", "panel", "photos", "quotes", "wos"].sort());
  });

  it("a job with invoices and photos lists exactly those two, then + Add…", () => {
    const items = moreItems(arrangeJobTabs(holding(["invoices", "photos"]), true), true);
    expect(labels(rows(items))).toEqual(["invoices", "photos", "Add…"]);
    expect(labels(rows(items, "add"))).not.toContain("invoices");
  });

  it("the crew is never offered a staff-write tab that is empty: only the Panel, which he works", () => {
    expect([...JOB_TECH_ADDABLE]).toEqual(["panel"]);
    const t = byId(arrangeJobTabs(holding([]), false));
    for (const id of ["permits", "appointments", "wos"]) {
      expect(t[id].offStrip, id).toBe(true);
      expect(t[id].tucked, id).toBe(false);
    }
    expect(t.panel.tucked).toBe(true);
    expect(labels(rows(moreItems(arrangeJobTabs(holding([]), false), false), "add"))).toEqual(["More", "panel"]);
    // A tab that holds something is his to read, empty or not for the office.
    expect(byId(arrangeJobTabs(holding(["permits"]), false)).permits.offStrip).toBe(false);
  });

  it("when the crew's More would hold nothing, there is no More chip", () => {
    nav.search = "";
    const arranged = arrangeJobTabs(holding([]), false, { features: off("panel_map"), isOwner: false }).filter((x) => !x.staffOnly);
    const html = renderToStaticMarkup(createElement(Tabs, { tabs: arranged, viewerIsStaff: false, look: "tiles" }));
    expect(html).not.toMatch(/>More</);
    expect(html).toMatch(/>job</); // the pinned chips are all there
  });

  it("a ?tab= link to a tucked tab still opens it, and More wears its name", () => {
    nav.search = "tab=quotes";
    const arranged = arrangeJobTabs(holding([]), true);
    expect(byId(arranged).quotes.tucked).toBe(true);
    const html = renderToStaticMarkup(createElement(Tabs, { tabs: arranged, viewerIsStaff: true, look: "tiles" }));
    expect(html).toContain("quotes-BODY");
    expect(html).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>)[\s\S])*>quotes</);
    nav.search = "";
  });
});
