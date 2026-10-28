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

  /** A SPANISH-SPEAKING TECH (cn-v1138): the same switches, the same keys, his words. */
  it("Spanish: the same keys in the same order, every label in Spanish but Apple's, the hours filled in", () => {
    const en = pushTriggersFor("tech", ALL_ON, false, "en");
    const es = pushTriggersFor("tech", ALL_ON, false, "es");
    expect(es.map((t) => t.key)).toEqual(en.map((t) => t.key));
    expect(es.map((t) => t.audience)).toEqual(en.map((t) => t.audience));
    expect(pushTriggersFor("tech", ALL_ON).map((t) => t.label)).toEqual(en.map((t) => t.label));
    const by = (list: typeof en, key: string) => list.find((t) => t.key === key)!;
    expect(by(es, "assigned").label).toBe("Trabajos y citas asignados a mí");
    expect(by(es, "clock_out").label).toBe("Recordatorios para marcar salida");
    expect(by(en, "clock_out").help).toContain("has run 12 hours");
    expect(by(es, "clock_out").help).toContain("12 horas");
    expect(by(es, "clock_out").help).not.toContain("{hours}");
    for (const t of es) if (t.key !== "tap_to_pay") expect(t.label, t.key).not.toBe(by(en, t.key).label);
    // Apple's words, the same in both (a staff row: the owner's list has it).
    expect(by(pushTriggersFor("owner", ALL_ON, false, "es"), "tap_to_pay").label).toBe("Tap to Pay on iPhone");
  });

  it("Spanish, the office and the owner: Leads off swaps the inquiry words; the long-shift row carries the hours; the Title Case rows stay Title Case", () => {
    const es = (role: string, f?: FeatureMap, platform = false) => pushTriggersFor(role, f, platform, "es");
    expect(es("owner", off("leads")).find((t) => t.key === "inquiry")!.label).toBe("Nuevas solicitudes de clientes");
    expect(es("owner").find((t) => t.key === "inquiry")!.label).toBe("Nuevas consultas / prospectos");
    expect(es("owner").find((t) => t.key === "long_shift")!.label).toBe("Un reloj de la cuadrilla con 12 horas");
    const titleCase = (s: string) => s.split(/[\s:]+/).filter(Boolean).every((w) => /^[\p{Lu}\p{N}]/u.test(w));
    for (const key of ["booked", "billing", "bug_watch"]) {
      const row = es("owner", ALL_ON, true).find((t) => t.key === key)!;
      expect(titleCase(row.label), row.label).toBe(true);
      expect(titleCase(pushTriggersFor("owner", ALL_ON, true).find((t) => t.key === key)!.label)).toBe(true);
    }
    expect(es("owner", ALL_ON, true).find((t) => t.key === "bug_watch")!.label).toBe("Bug Watch: Bloqueos Y El Resumen Del Lunes");
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
 * BILLING AND YOUR PLAN (cn-v1137): the trial's last days, a declined card, the day a plan ends — the
 * senders (lib/billing-notices, the Stripe webhook) address the owner and admins only, so only they
 * see the switch; the office and the crew, who can neither pick a plan nor update the card, never see
 * a switch for a buzz they cannot receive (KEEP THIS HONEST).
 */
describe("pushTriggersFor: the Billing And Your Plan row", () => {
  const BILLING = "billing:Billing And Your Plan";

  it("is there for an owner and an admin", () => {
    expect(rows("owner")).toContain(BILLING);
    expect(rows("admin")).toContain(BILLING);
  });

  it("is not there for the office, a tech, an unknown role, or a platform admin who is only office", () => {
    expect(rows("office")).not.toContain(BILLING);
    expect(rows("tech")).not.toContain(BILLING);
    expect(rows(null)).not.toContain(BILLING);
    expect(pushTriggersFor("office", ALL_ON, true).map((t) => t.key)).not.toContain("billing");
  });

  it("no company switch turns it off, and it is the only difference between an owner's list and the office's", () => {
    for (const k of Object.keys(ALL_ON) as (keyof FeatureMap)[]) expect(rows("owner", off(k))).toContain(BILLING);
    expect(rows("owner").filter((r) => r !== BILLING)).toEqual(rows("office"));
    expect(rows("admin").filter((r) => r !== BILLING)).toEqual(rows("office"));
  });

  it("says what it covers, in Title Case, to admins", () => {
    const row = pushTriggersFor("owner", ALL_ON).find((t) => t.key === "billing")!;
    expect(row.label).toBe("Billing And Your Plan");
    expect(row.help).toBe("Your trial's last days, a declined card, and when a plan ends. Owners and admins only.");
    expect(row.audience).toBe("admins");
    expect(row.soon).toBeUndefined();
    for (const word of row.label.split(/[\s:]+/).filter(Boolean)) expect(word[0]).toBe(word[0].toUpperCase());
  });
});

/**
 * THE DEFAULTS HAND COPY MIRRORS lib/push.ts: that file is server-only, so the client screen keeps
 * its own copy of what each kind defaults to, and a kind added to one and not the other would draw
 * a switch that reads the wrong way (or none).
 */
describe("the DEFAULTS hand copy mirrors lib/push.ts", () => {
  const defaultsIn = (file: string) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    const block = src.match(/const DEFAULTS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? "";
    return Object.fromEntries([...block.matchAll(/^\s*(\w+):\s*(true|false),/gm)].map((m) => [m[1], m[2] === "true"]));
  };

  it("the same kinds, each with the same default, in both files", () => {
    const screen = defaultsIn("src/app/(app)/settings/push-settings.tsx");
    const server = defaultsIn("src/lib/push.ts");
    expect(Object.keys(screen).length).toBeGreaterThanOrEqual(11);
    expect(screen).toEqual(server);
    expect(screen.billing).toBe(true);
    expect(screen.bug_watch).toBe(true);
    expect(screen.day_ahead).toBe(false);
  });

  it("every switch on the screen has a default, and every default is a switch (no kind without a row, no row without a kind)", () => {
    const screen = defaultsIn("src/app/(app)/settings/push-settings.tsx");
    const keys = new Set<string>();
    for (const role of ["owner", "tech"]) for (const t of pushTriggersFor(role, ALL_ON, true)) keys.add(t.key);
    expect([...keys].sort()).toEqual(Object.keys(screen).sort());
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
