import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureMap } from "@/lib/features";

/**
 * THE TOP BAR (W1-09, and Nort's button back, 2026-09-27): Back · logo · Search Or Ask · Nort · + ·
 * Bell · Avatar. Search Or Ask replaced the Search button and the graduation cap; Nort off, it reads
 * Search. NORT'S BUTTON is one tap (Erik: "theres not Nort button anymore" — he is an intercom, used
 * hands-busy in the truck): it runs talkToNort(), the same call Search Or Ask's Talk To Nort row
 * makes, and while Nort works it IS the red Stop Nort. Nort off, it isn't drawn. The Bell stays
 * whatever the switches say (Erik: it is the record of every push).
 *
 * The children are stand-ins: + , the Bell and the avatar each render one <button> (as the real
 * ones do), and Nort's host renders none — its panel floats, it has no bar button of its own.
 */
const est = vi.hoisted(() => ({ listening: false, streaming: false, speaking: false }));
// useState/useEffect as a server render runs them (the first value; effects never run), so the bar
// can also be CALLED as a function and its element tree read — how a tap is tested without a DOM.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useEffect: () => {},
}));
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
import { idleRows } from "@/components/command-bar";
import { NORT_TALK_EVENT, talkToNort } from "@/lib/onboarding/help-rows";

const owner = { id: "u1", role: "owner", full_name: "Pat" } as never;
const tech = { id: "u2", role: "tech", full_name: "Sam" } as never;
/** Every setup answer given: no open questions. */
const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };
const allOff = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as FeatureMap;
const props = (profile: never, features?: FeatureMap, extra: Record<string, unknown> = {}) =>
  ({ profile, setup: DONE, onboarded: true, features, ...extra }) as Parameters<typeof Topbar>[0];
const render = (profile: never, features?: FeatureMap, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Topbar, props(profile, features, extra)));
const buttons = (html: string) => html.match(/<button\b/g)?.length ?? 0;
const nortTag = (html: string) => html.match(/<button[^>]*data-tour="nort"[^>]*>/)?.[0] ?? null;
const src = readFileSync(join(process.cwd(), "src/components/app-shell/topbar.tsx"), "utf8");

/** The element in the tree the bar returns whose aria-label is `label` (the tap is its onClick). */
function byLabel(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = byLabel(n, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const p = node.props as { "aria-label"?: string; children?: ReactNode };
  if (p["aria-label"] === label) return node as ReactElement<{ onClick: () => void }>;
  return byLabel(p.children, label);
}

beforeEach(() => {
  est.listening = est.streaming = est.speaking = false;
});

describe("the top bar's controls", () => {
  it("Nort on: Back, Search Or Ask, Nort, +, the Bell and the avatar — six, for staff and techs", () => {
    for (const p of [owner, tech]) for (const f of [ALL_ON, undefined]) expect(buttons(render(p, f))).toBe(6);
  });

  it("Nort off: no Nort button — Back, Search, +, the Bell and the avatar", () => {
    for (const p of [owner, tech]) for (const f of [allOff, { ...ALL_ON, nort: false }]) {
      const html = render(p, f);
      expect(buttons(html)).toBe(5);
      expect(nortTag(html)).toBeNull();
      expect(html).not.toMatch(/Talk To Nort|Stop Nort/);
    }
  });

  it("the Bell stays with every switch off, for staff and techs", () => {
    expect(render(owner, allOff)).toContain('data-x="bell"');
    expect(render(tech, allOff)).toContain('data-x="bell"');
  });

  it("no graduation cap: its rows live under Search Or Ask; Nort's host draws no control of its own", () => {
    const html = render(owner, ALL_ON, { onboarded: false, setup: {} });
    expect(html).not.toContain('data-tour="setup"');
    expect(html).not.toMatch(/Start here|Finish setup|Take the walk-through/);
    // The panel host is mounted (the panel and the ?debrief= / ?attention= openers)...
    expect(html).toContain('data-x="nort-host"');
    // ...and the real one draws no button in the bar: the Nort button is the bar's own.
    const ga = readFileSync(join(process.cwd(), "src/components/global-assistant.tsx"), "utf8");
    expect(ga).not.toContain("<button\n          onClick={launch}");
    expect(ga).not.toContain('aria-label="Open Nort"');
  });

  it("in order: Search Or Ask, then Nort right after it, then +, the Bell and the avatar", () => {
    const html = render(owner, ALL_ON);
    const at = (s: string) => html.indexOf(s);
    expect(at('data-tour="ask"')).toBeGreaterThan(-1);
    expect(at('data-tour="ask"')).toBeLessThan(at('data-tour="nort"'));
    expect(at('data-tour="nort"')).toBeLessThan(at('data-tour="quickadd"'));
    expect(at('data-tour="quickadd"')).toBeLessThan(at('data-tour="bell"'));
    expect(at('data-tour="bell"')).toBeLessThan(at('data-tour="account"'));
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

  it("stays Search Or Ask while Nort works (the Nort button is the one that turns into Stop Nort)", () => {
    est.listening = true;
    expect(render(owner, ALL_ON)).toMatch(/<button[^>]*data-tour="ask"[^>]*aria-label="Search Or Ask"/);
  });

  it("opens the command bar", () => {
    const html = render(owner, ALL_ON);
    expect(html).toContain('aria-label="Search Or Ask"');
    expect(src).toContain('onClick={() => window.dispatchEvent(new Event("cn:command"))}');
  });
});

describe("Nort's button: one tap", () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });

  it("is a 44px round Talk To Nort, with Nort's mark", () => {
    const tag = nortTag(render(owner, ALL_ON))!;
    expect(tag).toContain('aria-label="Talk To Nort"');
    expect(tag).toContain('title="Talk To Nort"');
    expect(tag).toContain("h-11 w-11");
    expect(tag).toContain("rounded-full bg-brand");
    // Nort's mark from before the Search Or Ask change (lucide AudioLines).
    expect(src).toMatch(/aria-label="Talk To Nort"[\s\S]{0,300}<AudioLines /);
  });

  it("calls the SAME start as Search Or Ask's Talk To Nort row: talkToNort, which fires cn:nort-talk inside the tap", () => {
    const tree = Topbar(props(owner, ALL_ON));
    const btn = byLabel(tree, "Talk To Nort")!;
    expect(btn).not.toBeNull();
    // One function, not a copy of it: the bar's button and the menu row share the start path.
    const row = idleRows({ isStaff: true, features: ALL_ON, setup: DONE, onboarded: true })[0];
    expect(row.label).toBe("Talk To Nort");
    expect(btn.props.onClick).toBe(talkToNort);
    expect(row.run).toBe(talkToNort);
    // And the tap reaches GlobalAssistant's listener before it returns (the mic starts in-gesture).
    const win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    const heard: string[] = [];
    win.addEventListener(NORT_TALK_EVENT, () => heard.push("talk"));
    btn.props.onClick();
    expect(heard).toEqual(["talk"]);
  });

  it("nothing asynchronous between the tap and the start (iOS needs the mic started inside the gesture)", () => {
    // The button hands the click straight to talkToNort (no wrapper that could defer it)...
    expect(src).toContain("onClick={talkToNort}");
    // ...and talkToNort is one synchronous dispatch.
    const rows = readFileSync(join(process.cwd(), "src/lib/onboarding/help-rows.ts"), "utf8");
    const body = rows.slice(rows.indexOf("export function talkToNort(): void {"));
    expect(body.slice(0, body.indexOf("\n}"))).not.toMatch(/setTimeout|requestAnimationFrame|\.then\(|queueMicrotask|await |async /);
  });

  it("while Nort listens, thinks or talks it is the red 44px Stop Nort — one Stop on the bar, still six controls", () => {
    for (const k of ["listening", "streaming", "speaking"] as const) {
      est.listening = est.streaming = est.speaking = false;
      est[k] = true;
      const html = render(owner, ALL_ON);
      const tag = nortTag(html)!;
      expect(tag).toContain('aria-label="Stop Nort"');
      expect(tag).toContain("h-11 w-11");
      expect(tag).toContain("bg-red-600");
      expect(html.match(/Stop Nort/g)?.length).toBe(2); // its aria-label and title: one button
      expect(html).not.toContain('aria-label="Talk To Nort"');
      expect(buttons(html)).toBe(6);
    }
  });

  it("Stop Nort sends the one stop every voice path listens for", () => {
    est.speaking = true;
    const win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    const heard: string[] = [];
    win.addEventListener("cn:assistant-stop", () => heard.push("stop"));
    byLabel(Topbar(props(owner, ALL_ON)), "Stop Nort")!.props.onClick();
    expect(heard).toEqual(["stop"]);
  });

  it("with Nort off a busy flag changes nothing (there is no Nort to stop)", () => {
    est.listening = true;
    const html = render(owner, { ...ALL_ON, nort: false });
    expect(html).not.toContain("Stop Nort");
    expect(nortTag(html)).toBeNull();
    expect(byLabel(Topbar(props(owner, { ...ALL_ON, nort: false })), "Stop Nort")).toBeNull();
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

describe("it fits a 375px phone (and a 402px one)", () => {
  /** Tailwind's spacing scale: one step is 4px. */
  const px = (cls: string, util: string) => Number(cls.match(new RegExp(`(?:^|\\s)${util}-(\\d+)(?:\\s|$)`))![1]) * 4;

  it("every control is a 44px square; the brand gives way first", () => {
    const html = render(owner, ALL_ON, { branding: { name: "A Very Long Company Name Electric And Sons", logo: null } });
    expect(html.match(/<button[^>]*aria-label="Go back"[^>]*>/)![0]).toContain("h-11 w-11");
    expect(html).toMatch(/<span class="ml-1 min-w-0 max-w-\[160px\] shrink truncate/);
    const logo = render(owner, ALL_ON, { branding: { name: "Co", logo: "/logo.png" } });
    expect(logo).toMatch(/<img [^>]*class="ml-1 h-8 w-auto min-w-0 max-w-\[160px\] shrink object-contain"/);
  });

  it("the fixed controls, the gaps and the padding add up to no more than 375px, logo or not", () => {
    for (const branding of [undefined, { name: "Co", logo: "/logo.png" }, { name: "A Very Long Company Name Electric And Sons", logo: null }]) {
      const html = render(owner, ALL_ON, { branding });
      const header = html.match(/<header class="([^"]*)"/)![1];
      // The controls' row: the one element that holds Search Or Ask, and it never shrinks.
      const rowCls = html.match(/<div class="([^"]*)"><i data-x="nort-host"/)![1];
      expect(rowCls).toContain("shrink-0");
      // Every tap target in the row is 44px: the bar's own buttons say so here, and the +, the Bell
      // and the avatar (stand-ins in this file) say so in their own sources.
      const row = html.slice(html.indexOf(rowCls));
      const own = row.match(/<button[^>]*data-tour="(ask|nort)"[^>]*>/g)!;
      expect(own).toHaveLength(2);
      for (const b of own) expect(b).toContain("h-11 w-11");
      for (const [file, re] of [
        ["src/components/global-quick-add.tsx", /className="btn-gloss inline-flex h-11 w-11 /],
        ["src/components/app-shell/notification-bell.tsx", /className="relative flex h-11 w-11 /],
        ["src/components/account-menu.tsx", /className="relative flex h-11 w-11 /],
      ] as const) expect(readFileSync(join(process.cwd(), file), "utf8")).toMatch(re);
      const controls = buttons(row); // Search Or Ask, Nort, +, Bell, avatar
      expect(controls).toBe(5);
      // The header's own children: Back, the brand (when there is one), the spacer, the row.
      const headerKids = 3 + (branding ? 1 : 0);
      const brandMin = branding ? 4 : 0; // ml-1; min-w-0 lets the logo or name shrink to nothing
      const total =
        2 * px(header, "px") + // side padding
        44 + // Back
        brandMin +
        (headerKids - 1) * px(header, "gap") +
        controls * 44 +
        (controls - 1) * px(rowCls, "gap"); // gap-2 below 640px (sm:gap-3 only from 640 up)
      expect(total).toBeLessThanOrEqual(375);
      expect(total).toBeLessThanOrEqual(402);
    }
  });
});
