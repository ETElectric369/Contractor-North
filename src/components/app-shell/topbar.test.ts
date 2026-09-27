import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureMap } from "@/lib/features";

/**
 * THE TOP BAR (W1-09): Back · logo · Search Or Ask · + · Bell · Avatar — five controls, the same for
 * every role and company. Search Or Ask replaced Nort's voice button, the Search button and the
 * graduation cap; while Nort works it IS the red Stop Nort. Nort off, it reads Search. The Bell
 * stays whatever the switches say (Erik: it is the record of every push).
 *
 * The children are stand-ins: + , the Bell and the avatar each render one <button> (as the real
 * ones do), and Nort's host renders none — it has no bar button now.
 */
const est = vi.hoisted(() => ({ listening: false, streaming: false, speaking: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/estimator-store", () => ({ useEstimator: () => ({ ...est, draft: null, card: null }) }));
vi.mock("@/components/global-assistant", () => ({ GlobalAssistant: () => createElement("i", { "data-x": "nort-host" }) }));
vi.mock("@/components/app-shell/notification-bell", () => ({ NotificationBell: () => createElement("button", { "data-x": "bell" }) }));
vi.mock("@/components/global-quick-add", () => ({
  GlobalQuickAdd: ({ features, placement }: { features?: FeatureMap; placement?: string }) =>
    createElement("button", { "data-x": `quick-add ${placement} leads=${features?.leads ?? "none"}` }),
}));
vi.mock("@/components/account-menu", () => ({
  AccountMenu: ({ features, setupDot }: { features?: FeatureMap; setupDot?: boolean }) =>
    createElement("button", { "data-x": `account leads=${features?.leads ?? "none"} dot=${String(!!setupDot)}` }),
}));
vi.mock("@/components/back-link", () => ({ hasInAppHistory: () => false }));

import { Topbar } from "./topbar";
import { ALL_ON } from "@/lib/features";

const owner = { id: "u1", role: "owner", full_name: "Pat" } as never;
const tech = { id: "u2", role: "tech", full_name: "Sam" } as never;
/** Every setup answer given: no open questions. */
const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };
const allOff = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as FeatureMap;
const render = (profile: never, features?: FeatureMap, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Topbar, { profile, setup: DONE, onboarded: true, features, ...extra }));
const buttons = (html: string) => html.match(/<button\b/g)?.length ?? 0;

beforeEach(() => {
  est.listening = est.streaming = est.speaking = false;
});

describe("the top bar holds exactly five controls", () => {
  it("Back, Search Or Ask, +, the Bell and the avatar — for staff and techs, every switch on or off", () => {
    for (const p of [owner, tech]) for (const f of [ALL_ON, undefined, allOff]) expect(buttons(render(p, f))).toBe(5);
  });

  it("the Bell stays with every switch off, for staff and techs", () => {
    expect(render(owner, allOff)).toContain('data-x="bell"');
    expect(render(tech, allOff)).toContain('data-x="bell"');
  });

  it("no graduation cap and no separate Nort button: Nort's host renders no control", () => {
    const html = render(owner, ALL_ON, { onboarded: false, setup: {} });
    expect(html).not.toContain('data-tour="setup"');
    expect(html).not.toContain('data-tour="nort"');
    expect(html).not.toMatch(/Start here|Finish setup|Take the walk-through/);
    expect(html).not.toContain('aria-label="Open Nort"');
    // The panel host is mounted (the panel and the ?debrief= / ?attention= openers)...
    expect(html).toContain('data-x="nort-host"');
    // ...and the real one draws no button in the bar.
    const ga = readFileSync(join(process.cwd(), "src/components/global-assistant.tsx"), "utf8");
    expect(ga).not.toContain('aria-label="Open Nort"');
    expect(ga).not.toContain('title="Talk to Nort"');
  });

  it("the + anchor is the wrapper span around GlobalQuickAdd placement='topbar'; the ask anchor is Search Or Ask", () => {
    const html = render(owner, ALL_ON);
    expect(html).toMatch(/<span data-tour="quickadd" class="inline-flex"><button data-x="quick-add topbar/);
    expect(html).toMatch(/<button[^>]*data-tour="ask"[^>]*aria-label="Search Or Ask"/);
    expect(html).toContain('data-tour="bell"');
    expect(html).toContain('data-tour="account"');
  });

  it("hands the switches to the + menu and the avatar menu", () => {
    const html = render(owner, { ...ALL_ON, leads: false });
    expect(html).toContain('data-x="quick-add topbar leads=false"');
    expect(html).toContain('data-x="account leads=false dot=false"');
  });
});

describe("Search Or Ask", () => {
  it("with Nort on it reads Search Or Ask from md up, and is a 44px icon on a phone", () => {
    const html = render(owner, ALL_ON);
    const tag = html.match(/<button[^>]*data-tour="ask"[^>]*>/)![0];
    expect(tag).toContain("h-11 w-11");
    expect(tag).toContain("md:w-auto");
    expect(html).toContain('<span class="hidden text-sm md:inline">Search Or Ask</span>');
  });

  it("with Nort off it reads Search, and his host isn't mounted", () => {
    const html = render(owner, { ...ALL_ON, nort: false });
    expect(html).toMatch(/<button[^>]*data-tour="ask"[^>]*aria-label="Search"/);
    expect(html).toContain('<span class="hidden text-sm md:inline">Search</span>');
    expect(html).not.toContain("Search Or Ask");
    expect(html).not.toContain('data-x="nort-host"');
  });

  it("the shortcut hint is for a desktop only (a fine pointer, md up)", () => {
    expect(render(owner, ALL_ON)).toMatch(/<span class="hidden [^"]*md:pointer-fine:inline">⌘K<\/span>/);
  });

  it("while Nort listens, thinks or talks it is the red 44px Stop Nort — still one voice control, still five", () => {
    for (const k of ["listening", "streaming", "speaking"] as const) {
      est.listening = est.streaming = est.speaking = false;
      est[k] = true;
      const html = render(owner, ALL_ON);
      const tag = html.match(/<button[^>]*data-tour="ask"[^>]*>/)![0];
      expect(tag).toContain('aria-label="Stop Nort"');
      expect(tag).toContain("h-11 w-11");
      expect(tag).toContain("bg-red-600");
      expect(html).not.toContain("Search Or Ask");
      expect(buttons(html)).toBe(5);
    }
    // Stop Nort sends the one stop every voice path listens for.
    expect(readFileSync(join(process.cwd(), "src/components/app-shell/topbar.tsx"), "utf8")).toContain('new Event("cn:assistant-stop")');
  });

  it("with Nort off a busy flag changes nothing (there is no Nort to stop)", () => {
    est.listening = true;
    expect(render(owner, { ...ALL_ON, nort: false })).not.toContain("Stop Nort");
  });
});

describe("nothing silent: setup waiting on this person is a dot on the door that holds it", () => {
  const dot = 'data-x="setup-dot"';

  it("staff not yet walked through, or with setup questions open: a dot on Search Or Ask", () => {
    expect(render(owner, ALL_ON, { onboarded: false })).toContain(dot);
    expect(render(owner, ALL_ON, { setup: { ...DONE, service_area: null } })).toContain(dot);
  });

  it("nothing open: no dot (a mark, never a total)", () => {
    expect(render(owner, ALL_ON)).not.toContain(dot);
  });

  it("techs get no dot: they have no setup rows", () => {
    expect(render(tech, ALL_ON, { onboarded: false, setup: {} })).not.toContain(dot);
  });

  it("with Nort off the rows are under Help in the avatar menu, so the avatar carries the dot", () => {
    const html = render(owner, { ...ALL_ON, nort: false }, { onboarded: false });
    expect(html).not.toContain(dot);
    expect(html).toContain("dot=true");
  });
});

describe("it fits a 375px phone", () => {
  it("every control is a 44px square; the brand gives way first", () => {
    const html = render(owner, ALL_ON, { branding: { name: "A Very Long Company Name Electric And Sons", logo: null } });
    expect(html.match(/<button[^>]*aria-label="Go back"[^>]*>/)![0]).toContain("h-11 w-11");
    expect(html).toMatch(/<span class="ml-1 min-w-0 max-w-\[160px\] shrink truncate/);
    const logo = render(owner, ALL_ON, { branding: { name: "Co", logo: "/logo.png" } });
    expect(logo).toMatch(/<img [^>]*class="ml-1 h-8 w-auto min-w-0 max-w-\[160px\] shrink object-contain"/);
  });
});
