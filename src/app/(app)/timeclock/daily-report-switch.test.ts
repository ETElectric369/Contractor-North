import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DAILY REPORTS OFF (0352) at the one door that files a report: nothing is written, and no bell
 * entry or push reaches the office (whose push toggle hides with the switch, so it couldn't mute
 * them). Said in plain words. On, or no switches stored, the filing goes ahead as today.
 */
let settings: unknown = {};
const writes: string[] = [];
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "lead-1" } } }) },
  from: (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      lt: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      upsert: () => (writes.push(`${table}:upsert`), b),
      insert: () => (writes.push(`${table}:insert`), b),
      maybeSingle: async () =>
        table === "profiles"
          ? { data: { org_id: "org-1", full_name: "Lead" }, error: null }
          : table === "organizations"
            ? { data: { settings }, error: null }
            : { data: null, error: null },
      single: async () => ({ data: { id: "r1" }, error: null }),
      then: (ok: any, err?: any) => Promise.resolve({ data: [], error: null }).then(ok, err),
    };
    return b;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client, createServiceClient: () => client }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const createNotifications = vi.fn(async () => undefined);
const sendPushToProfiles = vi.fn(async () => undefined);
vi.mock("@/lib/notifications", () => ({
  createNotifications: (...a: unknown[]) => (createNotifications as any)(...a),
  notifyPeople: async () => ({ bell: true, pushed: [] }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: (...a: unknown[]) => (sendPushToProfiles as any)(...a),
  orgStaffIds: async () => ["owner-1"],
}));

const { fileDailyReport } = await import("./actions");

beforeEach(() => {
  settings = {};
  writes.length = 0;
  createNotifications.mockClear();
  sendPushToProfiles.mockClear();
});

describe("fileDailyReport and the Daily Reports switch", () => {
  it("off: refused in words, nothing written, no bell and no push", async () => {
    settings = { features: { daily_reports: false } };
    const r = await fileDailyReport({ did_today: "Pulled wire on the second floor", materials_tomorrow: "" });
    expect(r).toEqual({ ok: false, error: "Daily Reports is off. The owner can turn it on in Settings, Features." });
    expect(writes).toEqual([]);
    expect(createNotifications).not.toHaveBeenCalled();
    expect(sendPushToProfiles).not.toHaveBeenCalled();
  });

  it("Crew & Payroll off takes its sub-switch with it", async () => {
    settings = { features: { crew_payroll: false, daily_reports: true } };
    const r = await fileDailyReport({ did_today: "Trim out", materials_tomorrow: "" });
    expect(r.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it("no switches stored: the report is filed as today", async () => {
    await fileDailyReport({ did_today: "Pulled wire on the second floor", materials_tomorrow: "" });
    expect(writes).toContain("daily_reports:upsert");
  });
});
