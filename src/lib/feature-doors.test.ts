import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ON, FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import { DOCK, basePath } from "@/lib/dock";
import { FEATURE_ROUTES, featureForPath, requestHref, shellDoors } from "@/lib/feature-doors";

/**
 * THE SHELL'S DOORS (the switch board, 0352): the map the shell draws from, where a new request
 * lands, and which pages carry the Off line. A switch HIDES DOORS ONLY.
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;

describe("shellDoors — Crew & Payroll is quiet until a second person (rule j)", () => {
  it("an owner alone: the payroll doors go quiet even with the switch on", () => {
    expect(shellDoors(ALL_ON, 0).crew_payroll).toBe(false);
  });

  it("the first teammate brings them back; the switch itself is never touched", () => {
    expect(shellDoors(ALL_ON, 1)).toEqual(ALL_ON);
    expect(ALL_ON.crew_payroll).toBe(true);
  });

  it("a head-count that failed (null) shows the doors, exactly as before", () => {
    expect(shellDoors(ALL_ON, null)).toEqual(ALL_ON);
  });

  it("only Crew & Payroll moves: every other switch passes through as stored", () => {
    const m = off("leads", "nort");
    const d = shellDoors(m, 0);
    for (const k of FEATURE_KEYS) if (k !== "crew_payroll") expect(d[k], k).toBe(m[k]);
  });
});

describe("requestHref — where a new request's bell and push land (rule d)", () => {
  it("Leads on (or no map stored): the lead list, as today", () => {
    expect(requestHref(ALL_ON)).toBe("/leads");
    expect(requestHref(null)).toBe("/leads");
  });

  it("Leads off: My Day, where the request waits as a card with Call Back", () => {
    expect(requestHref(off("leads"))).toBe("/planner");
  });

  it("the three service-client senders all ask it, and none still hard-codes /leads", () => {
    for (const rel of [
      "src/lib/inquiries/create-triaged-inquiry.ts",
      "src/app/inquire/[org]/actions.ts",
      "src/lib/actions/public-schedule.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).toContain("requestHref(");
      expect(src, rel).not.toMatch(/url:\s*"\/leads"/);
    }
  });
});

describe("FEATURE_ROUTES — the pages that carry the Off line when opened by link", () => {
  it("a record under a switched-off feature is found by its path, detail pages included", () => {
    expect(featureForPath("/leads")).toBe("leads");
    expect(featureForPath("/quotes/abc123")).toBe("estimates");
    expect(featureForPath("/quotes/new")).toBe("estimates");
    expect(featureForPath("/purchasing/abc123")).toBe("purchase_orders");
    expect(featureForPath("/inventory")).toBe("shop_stock");
    expect(featureForPath("/payroll")).toBe("crew_payroll");
    expect(featureForPath("/safety")).toBe("safety_log");
    expect(featureForPath("/tools")).toBe("calculators");
  });

  it("segments, not string prefixes: /quotesx and /leadsy belong to nobody", () => {
    expect(featureForPath("/quotesx")).toBeNull();
    expect(featureForPath("/leadsy")).toBeNull();
  });

  it("never the Tax Report (the mileage deduction is not Sales Tax), Forms, or a job page", () => {
    expect(featureForPath("/tax-report")).toBeNull();
    expect(featureForPath("/forms/abc")).toBeNull();
    expect(featureForPath("/jobs/abc")).toBeNull();
    expect(featureForPath("/planner")).toBeNull();
  });

  it("every dock row a switch can hide has its page in the map (no hidden page without its Off line)", () => {
    for (const s of DOCK) {
      for (const c of s.children) {
        if (!c.feature || !c.href) continue;
        expect(featureForPath(basePath(c.href)), c.id).toBe(c.feature);
      }
      if (s.feature) expect(featureForPath(basePath(s.href)), s.key).toBe(s.feature);
    }
  });

  it("every entry names a real switch", () => {
    for (const r of FEATURE_ROUTES) expect(FEATURE_KEYS).toContain(r.feature);
  });
});
