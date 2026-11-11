import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const nav = vi.hoisted(() => ({
  pathname: "/appointments/abc123",
  search: "",
  declared: null as null | { id: string; pathname: string },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: unknown; href: string } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));
// What the page on screen has declared. The real reader answers null in a static render (the server
// and the first paint never see a declaration: nav-home.test.tsx), so the store's answer is handed in
// here and everything downstream of it is the real thing: useNavAt, activeNav, the rail and the strip.
vi.mock("@/components/nav-home", () => ({ useDeclaredNavHome: () => nav.declared }));

import { Dock } from "./dock";
import { SectionSubnav } from "@/components/section-subnav";
import { LangProvider } from "@/components/lang-provider";
import { ALL_ON } from "@/lib/features";
import type { Lang } from "@/lib/i18n";

/**
 * THE SHELL ON A VISIT'S PAGE (Erik, 2026-11-10: "the sub-nav disappears when an inspection is
 * clicked"). /appointments/<id> matches no cluster by its URL, so the rail lit nothing, the page
 * column was gone on the desktop and the strip was gone on the phone. The page now declares the dock
 * row it lives under (components/nav-home) and both renderers draw from it: an inspection's page
 * wears Sales with Inspections lit, any other booking's lights the Schedule, and a page that says
 * nothing is drawn exactly as it was.
 */
const visit = "/appointments/abc123";
const dock = (role = "owner", lang: Lang = "en") =>
  renderToStaticMarkup(
    <LangProvider lang={lang}>
      <Dock role={role} />
    </LangProvider>,
  );
const strip = (isStaff = true, lang: Lang = "en") =>
  renderToStaticMarkup(
    <LangProvider lang={lang}>
      <SectionSubnav isStaff={isStaff} />
    </LangProvider>,
  );
/** The tiles that wear the lit look, by key (the rail and the phone bar draw the same list). */
const litTiles = (html: string) => [
  ...new Set([...html.matchAll(/<a [^>]*data-tour="dock-([a-z]+)"[^>]*>/g)].filter((m) => m[0].includes("seaglass-active")).map((m) => m[1])),
];
/** Every other link that wears the lit look: the page column's row, the strip's chip. */
const litRows = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)"[^>]*class="[^"]*seaglass-active[^"]*"[^>]*>/g)].filter((m) => !m[0].includes("data-tour=")).map((m) => m[1]);
const chips = (html: string) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  nav.pathname = visit;
  nav.search = "";
  nav.declared = null;
});

describe("an inspection's page: Sales, with Inspections lit", () => {
  beforeEach(() => {
    nav.declared = { id: "sl-inspections", pathname: visit };
  });

  it("the rail and the phone bar light Sales, and the desktop's page column lists Sales with Inspections lit", () => {
    const html = dock();
    expect(litTiles(html)).toEqual(["sales"]);
    expect(html).toContain(">Sales</div>");
    for (const row of ["Leads", "Inspections", "Estimates", "Customers"]) expect(html, row).toContain(`>${row}</span>`);
    expect(litRows(html)).toEqual(["/inspections"]);
  });

  it("the phone's strip is the four Sales chips, Inspections the lit one", () => {
    const html = strip();
    expect(chips(html)).toEqual(["/leads", "/inspections", "/quotes", "/crm"]);
    expect(litRows(html)).toEqual(["/inspections"]);
    expect(html).toContain("app-subnav");
  });

  it("in Spanish: Ventas, with Inspecciones lit (the dock's own words)", () => {
    const html = dock("owner", "es");
    expect(litTiles(html)).toEqual(["sales"]);
    expect(html).toContain(">Ventas</div>");
    expect(html).toMatch(/<a href="\/inspections" class="[^"]*seaglass-active[^"]*">[\s\S]*?>Inspecciones<\/span>/);
    const chipsEs = strip(true, "es");
    expect(chipsEs).toMatch(/<a href="\/inspections" class="[^"]*seaglass-active[^"]*">[\s\S]*?>Inspecciones<\/span>/);
    for (const en of [">Inspections<", ">Leads<", ">Estimates<", ">Customers<"]) expect(chipsEs).not.toContain(en);
  });

  it("with Leads switched off the Inspections row is put away, and so is its light (as on /inspections itself)", () => {
    const leadsOff = { ...ALL_ON, leads: false };
    const html = renderToStaticMarkup(createElement(Dock, { role: "owner", features: leadsOff }));
    expect(litTiles(html)).toEqual([]);
    expect(renderToStaticMarkup(createElement(SectionSubnav, { isStaff: true, features: leadsOff }))).toBe("");
  });
});

describe("any other booking's page: the Schedule", () => {
  it("lights the Schedule tile; one row, so no page column and no strip", () => {
    nav.declared = { id: "s-week", pathname: visit };
    const html = dock();
    expect(litTiles(html)).toEqual(["schedule"]);
    expect(html).not.toContain(">Schedule</div>");
    expect(litRows(html)).toEqual([]);
    expect(strip()).toBe("");
  });

  it("a tech's visit lights Today (his visits are on My Day); he has no Sales and no Schedule to light", () => {
    nav.declared = { id: "t-day", pathname: visit };
    expect(litTiles(dock("tech"))).toEqual(["today"]);
    expect(strip(false)).toBe("");
    nav.declared = { id: "sl-inspections", pathname: visit };
    expect(litTiles(dock("tech"))).toEqual([]);
  });
});

describe("nothing else changes", () => {
  it("a page that declares nothing is drawn exactly as a route nothing owns always was", () => {
    const bare = dock();
    expect(litTiles(bare)).toEqual([]);
    expect(strip()).toBe("");
    nav.pathname = "/work-orders/abc123";
    expect(dock()).toBe(bare);
  });

  it("a declaration made on ANOTHER pathname is never worn: the next page does not flash the last one's sub-nav", () => {
    nav.declared = { id: "sl-inspections", pathname: "/appointments/def456" };
    expect(litTiles(dock())).toEqual([]);
    expect(strip()).toBe("");
    nav.pathname = "/work-orders/abc123";
    nav.declared = { id: "sl-inspections", pathname: visit };
    expect(litTiles(dock())).toEqual([]);
    expect(strip()).toBe("");
  });

  it("a route a cluster owns ignores a declaration, even one made on that very pathname", () => {
    nav.pathname = "/billing";
    const plain = dock();
    nav.declared = { id: "sl-inspections", pathname: "/billing" };
    expect(dock()).toBe(plain);
    expect(litTiles(plain)).toEqual(["invoices"]);
    expect(litRows(plain)).toEqual(["/billing"]);
  });

  it("the estimate a visit opens keeps Sales by its own URL", () => {
    for (const [pathname, search] of [["/quotes/new", "capture=abc123"], ["/quotes/abc123", ""]]) {
      nav.pathname = pathname;
      nav.search = search;
      expect(litTiles(dock()), pathname).toEqual(["sales"]);
      expect(chips(strip()), pathname).toEqual(["/leads", "/inspections", "/quotes", "/crm"]);
    }
  });
});
