import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_ON, FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import { DOCK, basePath } from "@/lib/dock";
import { FEATURE_ROUTES, countTeammates, featureForPath, requestHref, shellDoors } from "@/lib/feature-doors";

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

describe("countTeammates — the one head-count behind the quiet rule", () => {
  const client = (res: { count: number | null; error: unknown }) => {
    const filters: [string, unknown][] = [];
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      neq: (c: string, v: unknown) => (filters.push([`not ${c}`, v]), b),
      then: (ok: any, err?: any) => Promise.resolve(res).then(ok, err),
    };
    return { sb: { from: () => b } as any, filters };
  };

  it("anyone but the owner is a teammate himself: no read", async () => {
    const { sb, filters } = client({ count: 0, error: null });
    expect(await countTeammates(sb, { role: "admin", org_id: "org-1" })).toBe(1);
    expect(filters).toEqual([]);
  });

  it("the owner: active members of HIS company who aren't the owner", async () => {
    const { sb, filters } = client({ count: 2, error: null });
    expect(await countTeammates(sb, { role: "owner", org_id: "org-1" })).toBe(2);
    expect(filters).toEqual([["org_id", "org-1"], ["active", true], ["not role", "owner"]]);
  });

  it("a failed read, or no company, is null (the doors show, as today)", async () => {
    expect(await countTeammates(client({ count: null, error: { message: "x" } }).sb, { role: "owner", org_id: "org-1" })).toBeNull();
    expect(await countTeammates(client({ count: 0, error: null }).sb, { role: "owner", org_id: null })).toBeNull();
  });

  it("the layout and /timecards count with it, so their payroll doors agree; nothing else draws those doors", () => {
    for (const rel of ["src/app/(app)/layout.tsx", "src/app/(app)/timecards/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).toContain("countTeammates(supabase, ");
    }
    const cards = readFileSync(join(process.cwd(), "src/app/(app)/timecards/page.tsx"), "utf8");
    expect(cards).toContain('featureOn(payDoors, "crew_payroll")');
    // /timeclock counts nobody: it has no door row left to quiet (W2-01).
    const clock = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/page.tsx"), "utf8");
    expect(clock).not.toContain("countTeammates");
    // And no other page counts: the layout (the dock) and /timecards (its Pay row) only.
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.") && readFileSync(join(process.cwd(), rel), "utf8").includes("countTeammates(")) callers.push(rel);
      }
    };
    walk("src/app");
    expect(callers.sort()).toEqual(["src/app/(app)/layout.tsx", "src/app/(app)/timecards/page.tsx"]);
  });

  it("/timeclock is a clock: no Add Entry and no door to Timecards, Pay or Everyone's Day creeps back (W2-01)", () => {
    const clock = readFileSync(join(process.cwd(), "src/app/(app)/timeclock/page.tsx"), "utf8");
    for (const door of ["AddEntryButton", "AddTimeEntry", 'href="/timecards"', 'href="/payroll"', "view=crew"]) expect(clock, door).not.toContain(door);
  });

  it("every door that left /timeclock has its home: Money › Timecards, Money › Payroll, and Everyone's Day on the schedule", () => {
    const rows = DOCK.flatMap((s) => s.children);
    // Timecards (Add Time Entry is on it) also owns /timeclock, so staff on the clock light Money.
    expect(rows.find((c) => c.id === "ck-cards")).toMatchObject({ href: "/timecards", owns: ["/timeclock"] });
    // Payroll, behind the same Crew & Payroll switch the Pay card had.
    expect(rows.find((c) => c.id === "ma-payroll")).toMatchObject({ href: "/payroll", feature: "crew_payroll" });
    // Everyone's Day: the schedule header's icon, behind the Crew Board switch the card had.
    const cal = readFileSync(join(process.cwd(), "src/app/(app)/calendar/calendar-view.tsx"), "utf8");
    const at = cal.indexOf('href="/schedule?view=crew"');
    expect(at).toBeGreaterThan(0);
    expect(cal.slice(Math.max(0, at - 300), at)).toMatch(/\{crewBoard && \(/);
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

  it("never the Tax Report (the mileage deduction is not Sales Tax), Forms, Recurring, or a job page", () => {
    expect(featureForPath("/tax-report")).toBeNull();
    expect(featureForPath("/forms/abc")).toBeNull();
    // Recurring Billing takes only repeat invoices; the page is repeat jobs' and expenses' only door.
    expect(featureForPath("/recurring")).toBeNull();
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

  it("the doors that moved this wave keep their Off line when a link opens them (W1-07/W1-08)", () => {
    // Tools lives behind the initials now, only with Calculators on; a bookmark still opens it.
    expect(DOCK.find((s) => s.key === "tools")).toMatchObject({ inMenu: true, feature: "calculators" });
    expect(featureForPath("/tools")).toBe("calculators");
    // A tech's Handbook row moved under You: it is still Crew & Payroll's page.
    expect(DOCK.find((s) => s.key === "you")?.children.find((c) => c.href === "/handbook")?.feature).toBe("crew_payroll");
    expect(featureForPath("/handbook")).toBe("crew_payroll");
    // Customers (Sales) and Timecards (Money) belong to no switch, so they never carry an Off line.
    expect(featureForPath("/crm")).toBeNull();
    expect(featureForPath("/crm/abc")).toBeNull();
    expect(featureForPath("/timecards")).toBeNull();
  });
});
