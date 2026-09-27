import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

import { AccountMenu } from "./account-menu";
import { ALL_ON } from "@/lib/features";

const off = (...keys: (keyof FeatureMap)[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;
const render = (features?: FeatureMap, role = "owner") =>
  renderToStaticMarkup(createElement(AccountMenu, { profile: { id: "u1", role, full_name: "Pat" } as never, features }));
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
