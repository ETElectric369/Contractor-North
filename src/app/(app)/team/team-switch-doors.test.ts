import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /TEAM AND THE SWITCH BOARD (0352). The Crew Leader box and the Crew Lead badge are drawn whatever
 * the switches say: since 0356 the flag also lets its holder fill in the walk-through on a visit
 * they're on, which reads no switch, so the office must always be able to see it, grant it and take
 * it away. Daily Reports off only takes the clock-out report out of the box's line.
 * Crew & Payroll takes nothing here: the pay and charge rates price labor, and the home address and
 * commute baseline feed the Tax Report's mileage deduction, so they stay whatever the switches say.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../settings/actions", () => ({ updateMember: vi.fn(), updateMemberAuth: vi.fn() }));
// The edit's modal draws its body only while open; drawn open here so the fields can be counted.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ModalActions: () => null,
}));

import { EditMemberButton } from "../settings/edit-member-button";

const member = {
  id: "m1",
  full_name: "Sam Rivera",
  email: "sam@example.test",
  role: "tech",
  active: true,
  home_address: "12 Pine St",
  commute_baseline_miles: 10,
  crew_lead: true,
};
const r = (p: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(EditMemberButton, { member, isSelf: false, authConfigured: true, ...p }));

describe("a member's edit on /team", () => {
  it("Daily Reports on: the Crew Leader box says both the report and the walk-through, with the mileage fields", () => {
    const html = r({});
    expect(html).toContain("Crew Leader");
    expect(html).toContain("daily report at clock-out");
    expect(html).toMatch(/walk-through on visits they.{1,6}re assigned to/);
    expect(html).toContain("Daily commute baseline");
    expect(html).toContain("Home address");
  });

  it("Daily Reports off: the Crew Leader box stays (it grants the walk-through), without the clock-out report", () => {
    const html = r({ dailyReports: false });
    expect(html).toContain("Crew Leader");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/Fills in the walk-through on visits they.{1,6}re assigned to\. The office still prices it\./);
    expect(html).not.toContain("daily report at clock-out");
    expect(html).toContain("Daily commute baseline");
    expect(html).toContain("Home address");
  });

  it("the roster draws the badge whatever the switches, and hands Daily Reports to the edit for its line only", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/team/page.tsx"), "utf8");
    expect(src).toContain('const dailyReports = featureOn(sw.features, "daily_reports");');
    expect(src).toContain('{!!(m as any).crew_lead && <Badge tone="green">crew lead</Badge>}');
    expect(src).not.toContain("dailyReports && !!(m as any).crew_lead");
    expect(src).toContain("dailyReports={dailyReports}");
    expect(src).not.toContain("crewLeadDoor");
    // The rates are not a switch's door.
    expect(src).toMatch(/\{isAdmin && \(\s*<MemberRate/);
  });
});
