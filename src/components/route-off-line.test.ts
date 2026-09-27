import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A PAGE OPENED BY LINK STILL OPENS (rule a): its dock row is gone, the record isn't, and the Off
 * line sits on top saying so. The owner gets Turn On; anyone else is told to ask the owner.
 */
let pathname = "/leads";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { RouteOffLine } from "./route-off-line";
import { ALL_ON, type FeatureMap } from "@/lib/features";

const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const render = (features: FeatureMap, isOwner = true) => renderToStaticMarkup(createElement(RouteOffLine, { features, isOwner }));

describe("RouteOffLine", () => {
  beforeEach(() => {
    pathname = "/leads";
  });

  it("everything on: nothing, on every page (the shell renders exactly as before)", () => {
    for (const p of ["/leads", "/quotes/abc", "/payroll", "/tools", "/planner", "/jobs/abc"]) {
      pathname = p;
      expect(render(ALL_ON), p).toBe("");
    }
  });

  it("a lead opened by link with Leads off: the Off line on top, Turn On for the owner", () => {
    pathname = "/leads";
    const html = render(off("leads"));
    expect(html).toContain("Leads &amp; Walk-Throughs");
    expect(html).toContain(">Turn On<");
  });

  it("a PO opened by link with Purchase Orders off, seen by the office: Ask The Owner, no button", () => {
    pathname = "/purchasing/abc123";
    const html = render(off("purchase_orders"), false);
    expect(html).toContain("Purchase Orders");
    expect(html).toContain("Ask The Owner");
    expect(html).not.toContain("<button");
  });

  it("a page that belongs to no switch never shows one, whatever is off", () => {
    pathname = "/tax-report";
    expect(render(off("sales_tax", "leads"))).toBe("");
    pathname = "/jobs/abc";
    expect(render(off("permits", "panel_map"))).toBe("");
  });

  it("a sub-switch under a switched-off parent says the sub-switch (Safety under Licenses)", () => {
    pathname = "/safety";
    expect(render(off("licenses"))).toContain("Safety Log");
  });
});

describe("the app shell reads the switch board ONCE and hands it down (structural)", () => {
  const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");

  it("the doors map (Crew & Payroll quiet until a second person) reaches every shell door", () => {
    expect(layout).toContain("const doors = shellDoors(features, teammates);");
    for (const mount of ["<Dock ", "<Topbar ", "<SectionSubnav ", "<CommandBar "]) {
      const line = layout.split("\n").find((l) => l.includes(mount)) ?? "";
      expect(line, mount).toContain("features={doors}");
    }
  });

  it("the Off line reads the switches themselves, never the quiet doors map (no Turn On for a switch that's on)", () => {
    expect(layout).toContain("<RouteOffLine features={features} isOwner={isOwner} />");
  });
});
