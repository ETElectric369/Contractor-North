import { describe, it, expect, vi } from "vitest";
import { createElement, Fragment, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE JOB PAGE'S TABS AND THE SWITCH BOARD (0352). A switched-off feature's tab loses its chip
 * (offStrip) and still opens from a ?tab= link, with the Off line on top of exactly the content it
 * always had. With no switches stored (everything on) the strip is byte-for-byte what it was.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { arrangeJobTabs, JOB_TAB_FEATURE, JOB_TAB_ORDER } from "./job-tabs";
import { ALL_ON, FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import type { TabDef } from "@/components/tabs";

const body = (id: string) => createElement("p", { "data-body": id }, `${id}-BODY`);
const TABS: TabDef[] = JOB_TAB_ORDER.map((id) => ({ id, label: id, content: body(id) }));
const off = (...keys: (keyof FeatureMap)[]): FeatureMap => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) });
const html = (n: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, n));
const byId = (tabs: TabDef[]) => Object.fromEntries(tabs.map((t) => [t.id, t]));

describe("arrangeJobTabs with every feature on", () => {
  for (const staff of [true, false]) {
    it(`${staff ? "staff" : "a tech"}: only Tasks is off the strip, and every tab's content is untouched`, () => {
      for (const arranged of [arrangeJobTabs(TABS, staff), arrangeJobTabs(TABS, staff, { features: ALL_ON, isOwner: true })]) {
        expect(arranged.filter((t) => t.offStrip).map((t) => t.id)).toEqual(["tasks"]);
        for (const t of arranged) expect(t.content).toBe(TABS.find((x) => x.id === t.id)!.content);
      }
    });
  }
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
        (x) => x.offStrip && x.id !== "tasks" && JOB_TAB_FEATURE[x.id] !== feature,
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
