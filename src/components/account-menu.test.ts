import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureMap } from "@/lib/features";

/**
 * THE AVATAR MENU AND THE SWITCH BOARD (0352): the Estimate QR is the lead link handed out, so it
 * goes with Leads. Language, Settings and Sign Out never move.
 *
 * Rendered OPEN: the menu opens on a tap, which a static render can't make, so the first two
 * useState(false) calls (open, byTour) start true here. Nothing else about React is replaced.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (init: unknown) => actual.useState(init === false ? true : init) };
});
vi.mock("@/components/share-qr-button", () => ({ ShareQrButton: () => null }));
vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/(app)/settings/push-actions", () => ({
  removePushSubscription: vi.fn(),
  releaseDeviceTokenOnSignOut: vi.fn(),
  reportPushRegistrationFailure: vi.fn(),
}));
vi.mock("@/lib/native-shell", () => ({ isNativeShell: () => false }));
vi.mock("@/lib/native-push", () => ({ nativePushPermission: vi.fn(), registerForNativePush: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: unknown; href: string }) => createElement("a", { href }, children as never) }));

import { AccountMenu, bugWatchLabel } from "./account-menu";
import { ALL_ON } from "@/lib/features";

const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const render = (features?: FeatureMap, role = "owner", extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AccountMenu, { profile: { id: "u1", role, full_name: "Pat" } as never, features, ...extra }));
/** The visible words of every button in the menu, in order. */
const buttonWords = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
/** The links the menu draws, in order, as "href:words". */
const links = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => `${m[1]}:${m[2].replace(/<[^>]+>/g, "").trim()}`);

describe("AccountMenu", () => {
  it("everything on (or no map): the Estimate QR row is there, as before", () => {
    expect(render(ALL_ON)).toContain("Estimate QR");
    expect(render(undefined)).toContain("Estimate QR");
  });

  it("Leads off: no Estimate QR; Language, Settings and Sign Out stay", () => {
    const html = render({ ...ALL_ON, leads: false });
    expect(html).not.toContain("Estimate QR");
    expect(html).toContain("Language");
    expect(html).toContain("Settings");
    expect(html).toContain("Sign Out");
  });
});

/**
 * OFFICE AND TOOLS, BEHIND THE INITIALS (W1-07): one row per section the dock keeps off the bar,
 * right after Settings, landing where the dock would land THIS person.
 */
describe("the Office and Tools rows follow the role and the Calculators switch", () => {
  it("staff: Settings, then Office (Team), then Tools", () => {
    expect(links(render(ALL_ON))).toEqual(["/settings:Settings", "/team:Office", "/tools:Tools"]);
  });

  it("a tech: Office lands on Compliance (Team would send him away), or Forms with Licenses off", () => {
    expect(links(render(ALL_ON, "tech"))).toEqual(["/settings:Settings", "/compliance:Office", "/tools:Tools"]);
    expect(links(render(off("licenses"), "tech"))).toContain("/forms:Office");
  });

  it("Calculators off: no Tools row, for anyone", () => {
    for (const role of ["owner", "tech"]) expect(links(render(off("calculators"), role)).some((l) => l.startsWith("/tools"))).toBe(false);
  });
});

/**
 * HELP, WITH NORT OFF (W1-09): the rows that sit under Search Or Ask while Nort is on (Start Here,
 * Finish Setting Up, Show Me How, Take The Setup Again) sit here instead, for staff. (The static
 * render opens every useState(false), so Show Me How's lessons show folded open.)
 */
describe("the Help rows with Nort off", () => {
  const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };

  it("staff never walked through: Start Here, Show Me How with its lessons, Take The Setup Again", () => {
    const html = render(off("nort"), "owner", { onboarded: false, setup: {} });
    expect(html).toContain(">Help</div>");
    const words = buttonWords(html);
    expect(words).toContain("Start Here");
    expect(words).toContain("Show Me How");
    expect(words).toContain("Take The Setup Again");
    expect(words.some((w) => w.startsWith("Why Lines "))).toBe(true);
    // The lessons read their neutral words: nobody is speaking as Nort.
    expect(words.join(" ")).not.toMatch(/\bNort\b/);
  });

  it("walked through with setup open: Finish Setting Up · N Left instead of Start Here", () => {
    // (The service area is only asked once a city is known, so these are two open questions.)
    const words = buttonWords(render(off("nort"), "owner", { onboarded: true, setup: { ...DONE, service_area: null, labor_rate: null } }));
    expect(words).toContain("Finish Setting Up · 2 Left");
    expect(words).not.toContain("Start Here");
  });

  it("Nort on: no Help here (the rows are under Search Or Ask); a tech never gets Help", () => {
    expect(render(ALL_ON, "owner", { onboarded: false })).not.toContain(">Help</div>");
    expect(render(off("nort"), "tech", { onboarded: false })).not.toContain(">Help</div>");
  });

  it("every Help row is a 44px row that opens its screen through the setup host, audio unlocked in the tap", () => {
    const html = render(off("nort"), "owner", { onboarded: false, setup: {} });
    for (const m of html.matchAll(/<button type="button"[^>]*class="([^"]*)"/g)) expect(m[1]).toContain("min-h-[44px]");
    const src = readFileSync(join(process.cwd(), "src/components/account-menu.tsx"), "utf8");
    expect(src.match(/openSetup\((r|l)\.request\);/g)).toHaveLength(2);
  });

  it("the setup dot rides on the avatar when Help is the door that holds it", () => {
    expect(render(off("nort"), "owner", { setupDot: true })).toContain('data-x="setup-dot"');
    expect(render(off("nort"), "owner", { setupDot: false })).not.toContain('data-x="setup-dot"');
  });
});

/**
 * BUG WATCH COUNTS ITS OWN (NY-list part): the open reports after a middot, for North's own team
 * only. Nothing at zero, and nothing when the count couldn't be read — never a false zero.
 */
describe("Bug Watch · N", () => {
  it("reads the open count after a middot, nothing at zero or unknown", () => {
    expect(bugWatchLabel(31)).toBe("Bug Watch · 31");
    expect(bugWatchLabel(0)).toBe("Bug Watch");
    expect(bugWatchLabel(null)).toBe("Bug Watch");
    expect(bugWatchLabel(undefined)).toBe("Bug Watch");
  });

  it("draws it inside the /bugs link for a platform admin; nobody else sees the row", () => {
    expect(links(render(ALL_ON, "owner", { platformAdmin: true, bugCount: 31 }))).toContain("/bugs:Bug Watch · 31");
    expect(links(render(ALL_ON, "owner", { platformAdmin: true, bugCount: 0 }))).toContain("/bugs:Bug Watch");
    expect(links(render(ALL_ON, "owner", { platformAdmin: true, bugCount: null }))).toContain("/bugs:Bug Watch");
    expect(links(render(ALL_ON, "owner", { platformAdmin: false, bugCount: 31 })).some((l) => l.startsWith("/bugs"))).toBe(false);
  });

  it("a count still in flight shows no number until it lands (a promise never holds up the menu)", () => {
    expect(links(render(ALL_ON, "owner", { platformAdmin: true, bugCount: new Promise(() => {}) }))).toContain("/bugs:Bug Watch");
  });
});
