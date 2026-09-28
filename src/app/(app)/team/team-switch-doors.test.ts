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
 *
 * AND ONE DOOR TO LOCK SOMEONE OUT (W2-04): the edit has no Status select. The roster ⋯'s
 * Deactivate (Lock Out) / Reactivate (setMemberActive) stamps who and when and bans or lifts the
 * login; the edit's old select wrote profiles.active alone and did neither.
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

  it("has no Status select (W2-04): Role stands alone, and the save never sends whether they're active", () => {
    const html = r({});
    expect(html).not.toContain("m-active");
    expect(html).not.toContain(">Status<");
    expect(html).not.toContain("Inactive");
    // The Role select is still there, on its own now (no two-column grid around it).
    expect(html).toContain('id="m-role"');
    expect(html).toMatch(/<select[^>]*id="m-role"/);
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/edit-member-button.tsx"), "utf8");
    expect(src).not.toContain("setActive");
    expect(src).not.toMatch(/\bactive: isSelf \? undefined : active\b/);
    // Your own row still has no Role: nothing to lock yourself out of.
    expect(r({ isSelf: true })).not.toContain('id="m-role"');
  });

  it("updateMember never writes active: deactivating is setMemberActive's alone (it stamps who and when, and bans the login)", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/settings/actions.ts"), "utf8");
    const body = actions.slice(actions.indexOf("export async function updateMember("), actions.indexOf("export async function updateMemberAuth("));
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("clean.active");
    expect(body).not.toMatch(/active\?: boolean/);
    // The one door stays exactly as it was: the stamp and the ban.
    const door = actions.slice(actions.indexOf("export async function setMemberActive("), actions.indexOf("export async function memberFootprint("));
    expect(door).toContain("deactivated_at: active ? null : new Date().toISOString(), deactivated_by: active ? null : user.id");
    expect(door).toContain('ban_duration: active ? "none" : "876000h"');
  });

  it("the roster ⋯ is the one door: Deactivate (Lock Out) / Reactivate through setMemberActive, 44px rows and trigger", () => {
    const menu = readFileSync(join(process.cwd(), "src/app/(app)/team/team-member-menu.tsx"), "utf8");
    expect(menu).toContain("await setMemberActive(member.id, !member.active)");
    expect(menu).toContain('{member.active ? "Deactivate (Lock Out)" : "Reactivate"}');
    expect(menu).not.toContain("Deactivate (lock out)");
    // Every row 44px: the shared row (Edit & Role, Deactivate) and Remove; the ⋯ itself 44px square.
    expect(menu).toMatch(/const ROW_CLS =\s*"[^"]*\bmin-h-11\b/);
    const remove = menu.slice(menu.lastIndexOf("<button", menu.indexOf("onClick={runRemove}")), menu.indexOf("Remove\n", menu.indexOf("onClick={runRemove}")));
    expect(remove).toContain("min-h-11");
    expect(menu).toContain('className="inline-flex h-11 w-11 items-center justify-center rounded-lg border');
    expect(menu).not.toContain("h-9 w-9");
    // The own-row / owner-row hiding and the footprint-gated Remove stay.
    expect(menu).toContain("const canLifecycle = !isSelf && !isOwnerRow;");
    expect(menu).toContain("await memberFootprint(member.id)");
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
