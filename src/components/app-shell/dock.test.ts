import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureMap } from "@/lib/features";

const nav = vi.hoisted(() => ({ pathname: "/planner", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: unknown; href: string } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { Dock, isThenable, plainBadges } from "./dock";
import { ALL_ON } from "@/lib/features";

/**
 * THE cn-v930 CRASH, pinned. The app shell hands <Dock> its badge counts as a value that may
 * still be in flight. What actually arrives from the server is a React RSC THENABLE — `.then()`
 * registers the callback and returns UNDEFINED — so `value.then(...).catch(...)` threw
 * "undefined is not an object (evaluating '…​.catch')" and took the whole page's error boundary
 * with it on /jobs/<id>. Both helpers exist so the hook can never call `.then` on the wrong
 * thing, or hand the renderer something that isn't a count map.
 */
describe("isThenable — what Promise.resolve can safely adopt", () => {
  it("accepts a real promise", () => {
    expect(isThenable(Promise.resolve({}))).toBe(true);
  });

  it("accepts a bare thenable whose then() returns undefined (React's RSC shape)", () => {
    expect(isThenable({ then: () => undefined })).toBe(true);
  });

  it("rejects the values that used to crash it", () => {
    expect(isThenable(undefined)).toBe(false);
    expect(isThenable(null)).toBe(false);
    expect(isThenable({ "/planner": 3 })).toBe(false);
    expect(isThenable("pending")).toBe(false);
  });
});

describe("plainBadges — the renderer only ever sees a count map", () => {
  it("passes a real map through", () => {
    expect(plainBadges({ "/planner": 3 })).toEqual({ "/planner": 3 });
  });

  it("turns anything else into an empty map rather than throwing", () => {
    expect(plainBadges(undefined)).toEqual({});
    expect(plainBadges(null)).toEqual({});
    expect(plainBadges(7)).toEqual({});
    expect(plainBadges([1, 2])).toEqual({});
  });
});

/**
 * THE BAR, DRAWN (W1-07/W1-08): five tiles for staff (Today, Schedule, Sales, Jobs, Money), four
 * for a tech (Today, Clock, Jobs, You), every one a 44px target. Office and Tools are rows behind
 * the initials, never tiles, but their pages keep their section: on /team the page column still
 * lists Office's pages.
 */
const render = (role: string, features?: FeatureMap) => renderToStaticMarkup(createElement(Dock, { role, features }));
/** Every tile's anchor, in order, as the phone bar draws them (the rail draws the same list). */
const tiles = (html: string) => [...new Set([...html.matchAll(/data-tour="dock-([a-z]+)"/g)].map((m) => m[1]))];

describe("the dock's tiles", () => {
  beforeEach(() => {
    nav.pathname = "/planner";
    nav.search = "";
  });

  it("staff: Today, Schedule, Sales, Jobs, Money — never Office or Tools", () => {
    expect(tiles(render("owner"))).toEqual(["today", "schedule", "sales", "jobs", "invoices"]);
    expect(tiles(render("office", ALL_ON))).toEqual(["today", "schedule", "sales", "jobs", "invoices"]);
  });

  it("a tech: Today, Clock, Jobs, You", () => {
    expect(tiles(render("tech"))).toEqual(["today", "clock", "jobs", "you"]);
  });

  it("every tile, rail and bar, is a 44px target; the bar's icon is 20px and its label 11px", () => {
    const html = render("owner");
    const tags = [...html.matchAll(/<a [^>]*data-tour="dock-[a-z]+"[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBe(10); // five on the rail, five on the phone bar
    for (const t of tags) expect(t).toContain("min-h-[44px]");
    expect(html).toContain("text-[11px] font-medium");
    expect(html).toContain("relative z-10 h-5 w-5 shrink-0");
  });

  it("with Leads and Estimates off the Sales tile says Customers and lands on /crm", () => {
    const html = render("owner", { ...ALL_ON, leads: false, estimates: false });
    expect(html).toMatch(/<a href="\/crm"[^>]*data-tour="dock-sales"[^>]*aria-label="Customers"/);
  });

  it("on /team no tile lights, but the page column still lists Office's pages, Team lit", () => {
    nav.pathname = "/team";
    const html = render("owner");
    const tileTags = [...html.matchAll(/<a [^>]*data-tour="dock-[a-z]+"[^>]*>/g)].map((m) => m[0]);
    for (const t of tileTags) expect(t).not.toContain("seaglass-active");
    expect(html).toContain(">Office</div>");
    expect(html).toMatch(/<a href="\/team" class="[^"]*seaglass-active"/);
  });
});
