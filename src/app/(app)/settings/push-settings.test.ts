import { describe, it, expect, vi } from "vitest";

vi.mock("./push-actions", () => ({
  savePushSubscription: vi.fn(),
  removePushSubscription: vi.fn(),
  savePushPrefs: vi.fn(),
  saveDeviceToken: vi.fn(),
  removeDeviceToken: vi.fn(),
  myNotificationRole: vi.fn(),
}));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false }));
vi.mock("@/lib/native-push", () => ({ registerForNativePush: vi.fn(), nativePushPermission: vi.fn() }));

import { pushTriggersFor } from "./push-settings";
import { ALL_ON, type FeatureMap } from "@/lib/features";

/**
 * THE ALERT SWITCHES AND THE SWITCH BOARD (0352). An alert only a switched-off feature sends isn't
 * offered (a switch that can never fire is a dead door); an alert that keeps coming with its
 * feature off stays, in plain words, so it can still be muted.
 */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const rows = (role: string | null, f?: FeatureMap) => pushTriggersFor(role, f).map((t) => `${t.key}:${t.label}`);

describe("pushTriggersFor", () => {
  it("everything on (or no map): the same switches, in the same words, as before", () => {
    expect(rows("owner", ALL_ON)).toEqual(rows("owner"));
    expect(rows("owner")).toContain("inquiry:New inquiries / leads");
    expect(rows("owner")).toContain("daily_report:Daily reports from crew leads");
    expect(rows("owner")).toContain("quote_accepted:Quotes accepted by a customer");
  });

  it("Leads off: the request alert stays (requests still arrive) and says so plainly", () => {
    expect(rows("owner", off("leads"))).toContain("inquiry:New requests from customers");
  });

  it("Daily Reports off (or Crew & Payroll off): no daily report alert", () => {
    expect(rows("owner", off("daily_reports")).some((r) => r.startsWith("daily_report:"))).toBe(false);
    expect(rows("owner", off("crew_payroll")).some((r) => r.startsWith("daily_report:"))).toBe(false);
  });

  it("Estimates off: 'Quotes accepted' stays (a sent estimate can still be accepted)", () => {
    expect(rows("owner", off("estimates"))).toContain("quote_accepted:Quotes accepted by a customer");
  });

  it("a tech never gains a staff alert from a switch", () => {
    const tech = rows("tech");
    for (const k of Object.keys(ALL_ON) as (keyof FeatureMap)[]) for (const r of rows("tech", off(k))) expect(tech, r).toContain(r);
  });
});
