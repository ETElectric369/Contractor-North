import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/quick-capture", () => ({ QuickCaptureSheet: () => null }));

import { quickAddActions } from "./global-quick-add";
import { ALL_ON, type FeatureMap } from "@/lib/features";

/** THE + MENU AND THE SWITCH BOARD (0352): a switched-off feature's "New …" verb isn't offered. */
const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const labels = (isStaff: boolean, f?: FeatureMap) => quickAddActions(isStaff, f).map((a) => a.label);

describe("quickAddActions", () => {
  it("everything on (or no map): exactly the verbs as before", () => {
    const before = ["New Task", "New Lead", "New Customer", "New Job", "New Appointment", "New Estimate", "New Invoice"];
    expect(labels(true, ALL_ON)).toEqual(before);
    expect(labels(true)).toEqual(before);
    // A tech's + is New Task only: a job is made by the office (New Job is staff-only, Wave 0).
    expect(labels(false)).toEqual(["New Task"]);
  });

  it("Leads off: no New Lead; Estimates off: no New Estimate; the rest stay", () => {
    expect(labels(true, off("leads"))).toEqual(["New Task", "New Customer", "New Job", "New Appointment", "New Estimate", "New Invoice"]);
    expect(labels(true, off("estimates"))).toEqual(["New Task", "New Lead", "New Customer", "New Job", "New Appointment", "New Invoice"]);
  });

  it("a tech gains nothing from a switch", () => {
    expect(labels(false, off("leads", "estimates"))).toEqual(["New Task"]);
  });
});
