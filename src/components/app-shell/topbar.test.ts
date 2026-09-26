import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureMap } from "@/lib/features";

/**
 * THE TOP BAR AND THE SWITCH BOARD (0352). Nort off: his button goes. The Bell STAYS whatever the
 * switches say (Erik: it is the record of every push). The + menu and the avatar menu get the map.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/global-assistant", () => ({ GlobalAssistant: () => createElement("i", { "data-x": "nort-button" }) }));
vi.mock("@/components/app-shell/notification-bell", () => ({ NotificationBell: () => createElement("i", { "data-x": "bell" }) }));
vi.mock("@/components/global-quick-add", () => ({
  GlobalQuickAdd: ({ features }: { features?: FeatureMap }) => createElement("i", { "data-x": `quick-add leads=${features?.leads ?? "none"}` }),
}));
vi.mock("@/components/account-menu", () => ({
  AccountMenu: ({ features }: { features?: FeatureMap }) => createElement("i", { "data-x": `account leads=${features?.leads ?? "none"}` }),
}));
vi.mock("@/components/setup-button", () => ({
  SetupButton: ({ nortOn }: { nortOn?: boolean }) => createElement("i", { "data-x": `setup nort=${String(nortOn)}` }),
}));
vi.mock("@/components/back-link", () => ({ hasInAppHistory: () => false }));

import { Topbar } from "./topbar";
import { ALL_ON } from "@/lib/features";

const owner = { id: "u1", role: "owner", full_name: "Pat" } as never;
const tech = { id: "u2", role: "tech", full_name: "Sam" } as never;
const render = (profile: never, features?: FeatureMap) =>
  renderToStaticMarkup(createElement(Topbar, { profile, setup: {}, features }));

describe("Topbar", () => {
  it("everything on (or no map): Nort, the + menu, search, the bell and the avatar, as before", () => {
    for (const f of [ALL_ON, undefined]) {
      const html = render(owner, f);
      expect(html).toContain('data-tour="nort"');
      expect(html).toContain('data-x="nort-button"');
      expect(html).toContain('data-x="bell"');
      expect(html).toContain('data-tour="search"');
      expect(html).toContain('data-x="setup nort=true"');
    }
  });

  it("Nort off: no Nort button (and no tour anchor pointing at nothing); the setup cap stops promising him", () => {
    const html = render(owner, { ...ALL_ON, nort: false });
    expect(html).not.toContain('data-x="nort-button"');
    expect(html).not.toContain('data-tour="nort"');
    expect(html).toContain('data-x="setup nort=false"');
  });

  it("the Bell STAYS with every switch off, for staff and techs", () => {
    const allOff = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as FeatureMap;
    expect(render(owner, allOff)).toContain('data-x="bell"');
    expect(render(tech, allOff)).toContain('data-x="bell"');
  });

  it("hands the switches to the + menu and the avatar menu", () => {
    const html = render(owner, { ...ALL_ON, leads: false });
    expect(html).toContain('data-x="quick-add leads=false"');
    expect(html).toContain('data-x="account leads=false"');
  });
});
