import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * NORTH'S OWN ROW (cn-v1136): the Bug Watch switch (the blocker page and the Monday digest) is for a
 * platform admin only — whatever their company role, and whatever the company's switches — and no
 * company member ever sees it.
 */
describe("pushTriggersFor: the Bug Watch row", () => {
  const BUG_WATCH = "bug_watch:Bug Watch: Blockers And The Monday Digest";
  const platform = (role: string | null, f?: FeatureMap) => pushTriggersFor(role, f, true).map((t) => `${t.key}:${t.label}`);

  it("is not there for an owner, a tech, or an unknown role", () => {
    expect(rows("owner")).not.toContain(BUG_WATCH);
    expect(rows("tech")).not.toContain(BUG_WATCH);
    expect(rows(null)).not.toContain(BUG_WATCH);
    expect(pushTriggersFor("owner", ALL_ON, false).map((t) => t.key)).not.toContain("bug_watch");
  });

  it("is there for a platform admin, whatever their company role, and before the role is known", () => {
    expect(platform("owner")).toContain(BUG_WATCH);
    expect(platform("tech")).toContain(BUG_WATCH);
    expect(platform(null)).toContain(BUG_WATCH);
  });

  it("no company switch turns it off, and it adds nothing else to the list", () => {
    for (const k of Object.keys(ALL_ON) as (keyof FeatureMap)[]) expect(platform("owner", off(k))).toContain(BUG_WATCH);
    expect(platform("owner").filter((r) => r !== BUG_WATCH)).toEqual(rows("owner"));
    expect(platform("tech").filter((r) => r !== BUG_WATCH)).toEqual(rows("tech"));
  });

  it("says what it covers, in Title Case, defaulting on", () => {
    const row = pushTriggersFor("owner", ALL_ON, true).find((t) => t.key === "bug_watch")!;
    expect(row.help).toBe("North's own team only: a page the moment something platform-wide breaks, and the Monday morning digest.");
    expect(row.audience).toBe("platform");
    for (const word of row.label.split(/[\s:]+/).filter(Boolean)) expect(word[0]).toBe(word[0].toUpperCase());
  });
});

/**
 * THE PAGE ANSWERS THE PLATFORM QUESTION ITSELF (skeptic #42, S8): PushSettings used to get `role` but
 * not `platformAdmin`, so the effect fired myNotificationRole() — a profiles read and an RPC — on every
 * settings visit for every company member. Now the server page computes isPlatformAdmin with the
 * client it already has and passes the boolean; with both props in hand the effect asks nothing.
 */
describe("the settings page passes platformAdmin, and the switches never ask when it is a boolean", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/settings/page.tsx"), "utf8");
  const settings = readFileSync(join(process.cwd(), "src/app/(app)/settings/push-settings.tsx"), "utf8");

  it("the page computes it with its own client and hands it over beside the role", () => {
    expect(page).toContain('import { isPlatformAdmin } from "@/lib/platform-admin";');
    expect(page).toContain("const platformAdmin = await isPlatformAdmin(supabase);");
    const mount = page.slice(page.indexOf("<PushSettings"), page.indexOf("/>", page.indexOf("<PushSettings")));
    expect(mount).toContain("role={(profile as any)?.role ?? null}");
    expect(mount).toContain("platformAdmin={platformAdmin}");
  });

  it("the effect returns before the action when the role is known and platformAdmin is a boolean", () => {
    const effect = settings.slice(settings.indexOf("useEffect(() => {"), settings.indexOf("myNotificationRole().then("));
    expect(effect).toContain('if (initialRole && typeof initialPlatformAdmin === "boolean") return;');
    expect(settings).toContain('if (typeof initialPlatformAdmin !== "boolean") setPlatformAdmin(r.platformAdmin === true);');
    expect(settings).not.toContain("initialPlatformAdmin !== undefined");
  });
});
